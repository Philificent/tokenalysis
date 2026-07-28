import type { ToolCall, UsageRecord } from '../db.js';

/** Parsed usage counters accumulated from a response (stream or JSON). */
export interface ExtractedUsage {
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  providerCost: number | null;
  toolCalls: ToolCall[];
  parseError: boolean;
}

const MCP_NAME_RE = /^mcp__(.+?)__(.+)$/;

/** Split Claude Code's mcp__<server>__<tool> convention into server + tool. */
export function parseToolName(name: string): { isMcp: boolean; mcpServer: string | null } {
  const m = MCP_NAME_RE.exec(name);
  if (m) return { isMcp: true, mcpServer: m[1] };
  return { isMcp: false, mcpServer: null };
}

/** Aggregate a list of raw tool-use names into ToolCall rows with counts. */
export function aggregateToolCalls(names: string[]): ToolCall[] {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts.entries()].map(([toolName, callCount]) => {
    const { isMcp, mcpServer } = parseToolName(toolName);
    return { toolName, isMcp, mcpServer, callCount };
  });
}

/** Tools offered in the request body (Anthropic and OpenAI-style both use `tools`). */
export function extractToolsOffered(requestBody: unknown): string[] {
  if (!requestBody || typeof requestBody !== 'object') return [];
  const tools = (requestBody as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const t of tools) {
    if (t && typeof t === 'object') {
      const obj = t as Record<string, unknown>;
      // Anthropic: { name }, OpenAI: { function: { name } }
      if (typeof obj.name === 'string') names.push(obj.name);
      else if (obj.function && typeof obj.function === 'object') {
        const fn = obj.function as Record<string, unknown>;
        if (typeof fn.name === 'string') names.push(fn.name);
      }
    }
  }
  return names;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Extract usage from a non-streaming Anthropic Messages API response body. */
export function extractAnthropicJson(body: unknown): ExtractedUsage {
  const out = emptyUsage();
  try {
    if (!body || typeof body !== 'object') return { ...out, parseError: true };
    const obj = body as Record<string, unknown>;
    out.model = typeof obj.model === 'string' ? obj.model : null;
    const usage = obj.usage as Record<string, unknown> | undefined;
    if (usage) {
      out.inputTokens = num(usage.input_tokens);
      out.outputTokens = num(usage.output_tokens);
      out.cacheCreationTokens = num(usage.cache_creation_input_tokens);
      out.cacheReadTokens = num(usage.cache_read_input_tokens);
    }
    const toolNames: string[] = [];
    if (Array.isArray(obj.content)) {
      for (const block of obj.content) {
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (b.type === 'tool_use' && typeof b.name === 'string') toolNames.push(b.name);
        }
      }
    }
    out.toolCalls = aggregateToolCalls(toolNames);
    return out;
  } catch {
    return { ...out, parseError: true };
  }
}

/** Accumulate usage from parsed Anthropic SSE event JSON payloads. */
export function extractAnthropicStream(events: unknown[]): ExtractedUsage {
  const out = emptyUsage();
  const toolNames: string[] = [];
  try {
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      const e = ev as Record<string, unknown>;
      if (e.type === 'message_start' && e.message && typeof e.message === 'object') {
        const msg = e.message as Record<string, unknown>;
        if (typeof msg.model === 'string') out.model = msg.model;
        const usage = msg.usage as Record<string, unknown> | undefined;
        if (usage) {
          out.inputTokens = num(usage.input_tokens);
          out.outputTokens = num(usage.output_tokens) ?? out.outputTokens;
          out.cacheCreationTokens = num(usage.cache_creation_input_tokens);
          out.cacheReadTokens = num(usage.cache_read_input_tokens);
        }
      } else if (e.type === 'message_delta') {
        const usage = e.usage as Record<string, unknown> | undefined;
        if (usage) {
          // message_delta usage carries cumulative final counts
          const outTok = num(usage.output_tokens);
          if (outTok !== null) out.outputTokens = outTok;
          const inTok = num(usage.input_tokens);
          if (inTok !== null) out.inputTokens = inTok;
          const ccTok = num(usage.cache_creation_input_tokens);
          if (ccTok !== null) out.cacheCreationTokens = ccTok;
          const crTok = num(usage.cache_read_input_tokens);
          if (crTok !== null) out.cacheReadTokens = crTok;
        }
      } else if (e.type === 'content_block_start' && e.content_block && typeof e.content_block === 'object') {
        const cb = e.content_block as Record<string, unknown>;
        if (cb.type === 'tool_use' && typeof cb.name === 'string') toolNames.push(cb.name);
      }
    }
    out.toolCalls = aggregateToolCalls(toolNames);
    return out;
  } catch {
    return { ...out, parseError: true };
  }
}

/** Extract usage from a non-streaming OpenRouter (Chat Completions) response body. */
export function extractOpenRouterJson(body: unknown): ExtractedUsage {
  const out = emptyUsage();
  try {
    if (!body || typeof body !== 'object') return { ...out, parseError: true };
    const obj = body as Record<string, unknown>;
    out.model = typeof obj.model === 'string' ? obj.model : null;
    applyOpenRouterUsage(out, obj.usage);
    const toolNames: string[] = [];
    if (Array.isArray(obj.choices)) {
      for (const choice of obj.choices) {
        if (!choice || typeof choice !== 'object') continue;
        const msg = (choice as Record<string, unknown>).message as Record<string, unknown> | undefined;
        collectOpenAiToolCalls(msg?.tool_calls, toolNames);
      }
    }
    out.toolCalls = aggregateToolCalls(toolNames);
    return out;
  } catch {
    return { ...out, parseError: true };
  }
}

/** Accumulate usage from parsed OpenRouter SSE chunk JSON payloads. */
export function extractOpenRouterStream(chunks: unknown[]): ExtractedUsage {
  const out = emptyUsage();
  const toolNames: string[] = [];
  try {
    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== 'object') continue;
      const c = chunk as Record<string, unknown>;
      if (typeof c.model === 'string') out.model = c.model;
      // usage arrives on the final chunk when usage:{include:true}
      applyOpenRouterUsage(out, c.usage);
      if (Array.isArray(c.choices)) {
        for (const choice of c.choices) {
          if (!choice || typeof choice !== 'object') continue;
          const delta = (choice as Record<string, unknown>).delta as Record<string, unknown> | undefined;
          // Only count tool calls that carry a name (first delta of each call)
          collectOpenAiToolCalls(delta?.tool_calls, toolNames);
        }
      }
    }
    out.toolCalls = aggregateToolCalls(toolNames);
    return out;
  } catch {
    return { ...out, parseError: true };
  }
}

function applyOpenRouterUsage(out: ExtractedUsage, usageRaw: unknown): void {
  if (!usageRaw || typeof usageRaw !== 'object') return;
  const usage = usageRaw as Record<string, unknown>;
  out.inputTokens = num(usage.prompt_tokens) ?? out.inputTokens;
  out.outputTokens = num(usage.completion_tokens) ?? out.outputTokens;
  out.providerCost = num(usage.cost) ?? out.providerCost;
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  if (details) {
    const cached = num(details.cached_tokens);
    if (cached !== null) out.cacheReadTokens = cached;
    const cacheWrite = num(details.cache_write_tokens);
    if (cacheWrite !== null) out.cacheCreationTokens = cacheWrite;
  }
}

function collectOpenAiToolCalls(toolCallsRaw: unknown, into: string[]): void {
  if (!Array.isArray(toolCallsRaw)) return;
  for (const tc of toolCallsRaw) {
    if (!tc || typeof tc !== 'object') continue;
    const fn = (tc as Record<string, unknown>).function as Record<string, unknown> | undefined;
    if (fn && typeof fn.name === 'string' && fn.name.length > 0) into.push(fn.name);
  }
}

function emptyUsage(): ExtractedUsage {
  return {
    model: null,
    inputTokens: null,
    outputTokens: null,
    cacheCreationTokens: null,
    cacheReadTokens: null,
    providerCost: null,
    toolCalls: [],
    parseError: false,
  };
}

/** Build the final UsageRecord from extraction output + request metadata. */
export function buildUsageRecord(params: {
  extracted: ExtractedUsage;
  provider: 'anthropic' | 'openrouter';
  requestModel: string | null;
  client: string | null;
  status: number;
  latencyMs: number;
  stream: boolean;
  toolsOffered: string[];
}): UsageRecord {
  const { extracted } = params;
  return {
    ts: Date.now(),
    provider: params.provider,
    model: extracted.model ?? params.requestModel,
    client: params.client,
    status: params.status,
    latencyMs: params.latencyMs,
    stream: params.stream,
    inputTokens: extracted.inputTokens,
    outputTokens: extracted.outputTokens,
    cacheCreationTokens: extracted.cacheCreationTokens,
    cacheReadTokens: extracted.cacheReadTokens,
    providerCost: extracted.providerCost,
    toolCalls: extracted.toolCalls,
    toolsOffered: params.toolsOffered,
    parseError: extracted.parseError,
  };
}
