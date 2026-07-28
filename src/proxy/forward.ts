import type { Context } from 'hono';
import type { Database as DB } from 'better-sqlite3';
import { tapSseStream } from './sse.js';
import {
  buildUsageRecord,
  extractToolsOffered,
  type ExtractedUsage,
} from '../usage/extract.js';
import { computeCosts } from '../usage/cost.js';
import { findPrice, insertUsageRecord, latestSnapshotId, logApp } from '../db.js';

/** Hop-by-hop headers that must not be forwarded in either direction. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

/** Response headers invalidated by fetch's transparent decompression. */
const RESPONSE_STRIP = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

export interface ProviderSpec {
  name: 'anthropic' | 'openrouter';
  upstreamBase: string;
  /** Path prefix mounted on the proxy, e.g. '/anthropic'. */
  mountPrefix: string;
  /** Returns true when the upstream path is a completion endpoint worth recording. */
  isCompletionPath(path: string): boolean;
  /** Optionally rewrite the parsed JSON request body (e.g. inject usage flag). Returns null for "unchanged". */
  mutateRequestBody(body: Record<string, unknown>): Record<string, unknown> | null;
  extractJson(body: unknown): ExtractedUsage;
  extractStream(events: unknown[]): ExtractedUsage;
}

function forwardHeaders(req: Request): Headers {
  const out = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase()) && key.toLowerCase() !== 'x-tokenalysis-client') {
      out.set(key, value);
    }
  });
  return out;
}

function responseHeaders(upstream: Response): Headers {
  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!RESPONSE_STRIP.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}

function clientId(req: Request): string | null {
  return req.headers.get('x-tokenalysis-client') ?? req.headers.get('user-agent');
}

interface RequestMeta {
  model: string | null;
  toolsOffered: string[];
  stream: boolean;
}

function parseRequestMeta(body: Record<string, unknown> | null): RequestMeta {
  if (!body) return { model: null, toolsOffered: [], stream: false };
  return {
    model: typeof body.model === 'string' ? body.model : null,
    toolsOffered: extractToolsOffered(body),
    stream: body.stream === true,
  };
}

function record(
  db: DB,
  spec: ProviderSpec,
  extracted: ExtractedUsage,
  meta: RequestMeta,
  client: string | null,
  status: number,
  latencyMs: number,
  stream: boolean
): void {
  try {
    const usage = buildUsageRecord({
      extracted,
      provider: spec.name,
      requestModel: meta.model,
      client,
      status,
      latencyMs,
      stream,
      toolsOffered: meta.toolsOffered,
    });
    const snapshotId = latestSnapshotId(db);
    const price = snapshotId !== null && usage.model ? findPrice(db, snapshotId, usage.model) : null;
    const costs = computeCosts(usage, price, snapshotId);
    insertUsageRecord(db, usage, costs);
  } catch (err) {
    // Recording must never break the proxied response.
    try {
      logApp(db, 'error', `record failed (${spec.name}): ${(err as Error).message}`);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Proxy a request to the provider upstream, tapping completion responses for
 * usage recording. Bytes reach the client unmodified (except for opt-in
 * request-body usage injection on OpenRouter).
 */
export async function proxyRequest(c: Context, spec: ProviderSpec, db: DB): Promise<Response> {
  const req = c.req.raw;
  const url = new URL(req.url);
  const upstreamPath = url.pathname.slice(spec.mountPrefix.length) || '/';
  const upstreamUrl = spec.upstreamBase.replace(/\/$/, '') + upstreamPath + url.search;

  const headers = forwardHeaders(req);
  const isCompletion = spec.isCompletionPath(upstreamPath) && req.method === 'POST';

  let bodyToSend: BodyInit | null = null;
  let parsedBody: Record<string, unknown> | null = null;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const raw = await req.arrayBuffer();
    bodyToSend = raw;
    if (isCompletion) {
      try {
        parsedBody = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
        const mutated = spec.mutateRequestBody(parsedBody);
        if (mutated) {
          parsedBody = mutated;
          bodyToSend = JSON.stringify(mutated);
          headers.set('content-type', 'application/json');
        }
      } catch {
        parsedBody = null; // non-JSON body; forward as-is
      }
    }
  }

  const started = Date.now();
  const upstream = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: bodyToSend,
    redirect: 'manual',
  });

  const outHeaders = responseHeaders(upstream);

  // Non-completion traffic (model lists, count_tokens, etc.): pure passthrough.
  if (!isCompletion) {
    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  }

  const meta = parseRequestMeta(parsedBody);
  const client = clientId(req);
  const contentType = upstream.headers.get('content-type') ?? '';
  const isSse = contentType.includes('text/event-stream');

  if (isSse && upstream.body) {
    const { clientStream, events } = tapSseStream(upstream.body);
    void events.then((parsed) => {
      const latencyMs = Date.now() - started;
      let extracted: ExtractedUsage;
      try {
        extracted = spec.extractStream(parsed);
      } catch {
        extracted = spec.extractStream([]);
        extracted.parseError = true;
      }
      if (parsed.length === 0 && upstream.status < 400) extracted.parseError = true;
      record(db, spec, extracted, meta, client, upstream.status, latencyMs, true);
    });
    return new Response(clientStream, { status: upstream.status, headers: outHeaders });
  }

  // Non-streaming: buffer, record, replay to client byte-identically.
  const bodyBytes = await upstream.arrayBuffer();
  const latencyMs = Date.now() - started;
  let extracted: ExtractedUsage;
  try {
    extracted = spec.extractJson(JSON.parse(new TextDecoder().decode(bodyBytes)));
  } catch {
    extracted = spec.extractJson(null);
    extracted.parseError = true;
  }
  // Error responses legitimately lack usage; don't flag them as parse errors.
  if (upstream.status >= 400) extracted.parseError = false;
  record(db, spec, extracted, meta, client, upstream.status, latencyMs, meta.stream);
  return new Response(bodyBytes, { status: upstream.status, headers: outHeaders });
}
