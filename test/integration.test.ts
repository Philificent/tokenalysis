import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { openDb } from '../src/db.js';
import { storeSnapshot } from '../src/pricing/refresh.js';
import type { Database as DB } from 'better-sqlite3';
import type { Hono } from 'hono';

const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-20250514","usage":{"input_tokens":25,"cache_creation_input_tokens":1024,"cache_read_input_tokens":40000,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu1","name":"mcp__github__list_prs"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":77}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

const OPENROUTER_JSON = {
  id: 'gen-1',
  model: 'anthropic/claude-sonnet-4',
  choices: [{ message: { role: 'assistant', content: 'hello' } }],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 40,
    cost: 0.00099,
    prompt_tokens_details: { cached_tokens: 60 },
  },
};

let upstream: http.Server;
let upstreamUrl: string;
let db: DB;
let app: Hono;
let lastOpenRouterBody: unknown = null;

async function waitForRequestRow(count: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const row = db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number };
    if (row.n >= count) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${count} request rows`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url === '/v1/messages') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // Write in multiple chunks to exercise streaming
        const half = Math.floor(ANTHROPIC_SSE.length / 2);
        res.write(ANTHROPIC_SSE.slice(0, half));
        setTimeout(() => {
          res.write(ANTHROPIC_SSE.slice(half));
          res.end();
        }, 20);
      } else if (req.url === '/api/v1/chat/completions') {
        lastOpenRouterBody = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(OPENROUTER_JSON));
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not found"}');
      }
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  db = openDb(':memory:');
  // Seed a pricing snapshot so costs are computed at insert time.
  storeSnapshot(
    db,
    [
      {
        model: 'claude-sonnet-4-20250514',
        inputPerMtok: 3,
        outputPerMtok: 15,
        cacheReadPerMtok: 0.3,
        cacheWritePerMtok: 3.75,
      },
    ],
    'test'
  );

  app = createApp(
    {
      port: 0,
      host: '127.0.0.1',
      dbPath: ':memory:',
      injectOpenRouterUsage: true,
      anthropicUpstream: upstreamUrl,
      openrouterUpstream: upstreamUrl,
      pricingRefreshEnabled: false,
    },
    db
  );
});

afterAll(() => {
  upstream.close();
  db.close();
});

describe('proxy integration', () => {
  it('streams Anthropic SSE byte-identically and records tokens, costs, and MCP tools', async () => {
    const res = await app.request('http://localhost/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tokenalysis-client': 'integration-test',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        stream: true,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'mcp__github__list_prs', input_schema: {} }],
      }),
    });
    expect(res.status).toBe(200);
    const clientText = await res.text();
    expect(clientText).toBe(ANTHROPIC_SSE); // byte-identical passthrough

    await waitForRequestRow(1);
    const row = db.prepare("SELECT * FROM requests WHERE provider = 'anthropic'").get() as Record<string, unknown>;
    expect(row.model).toBe('claude-sonnet-4-20250514');
    expect(row.client).toBe('integration-test');
    expect(row.stream).toBe(1);
    expect(row.input_tokens).toBe(25);
    expect(row.output_tokens).toBe(77); // message_delta final count
    expect(row.cache_creation_tokens).toBe(1024);
    expect(row.cache_read_tokens).toBe(40000);
    expect(row.parse_error).toBe(0);
    // costs: 25/1M*3 + 77/1M*15 + 1024/1M*3.75 + 40000/1M*0.3
    expect(row.cost_total as number).toBeCloseTo(
      (25 / 1e6) * 3 + (77 / 1e6) * 15 + (1024 / 1e6) * 3.75 + (40000 / 1e6) * 0.3,
      12
    );

    const tools = db.prepare('SELECT * FROM tool_calls WHERE request_id = ?').all(row.id) as Record<string, unknown>[];
    expect(tools).toHaveLength(1);
    expect(tools[0].tool_name).toBe('mcp__github__list_prs');
    expect(tools[0].is_mcp).toBe(1);
    expect(tools[0].mcp_server).toBe('github');

    const offered = db.prepare('SELECT tool_name FROM tools_offered WHERE request_id = ?').all(row.id);
    expect(offered).toEqual([{ tool_name: 'mcp__github__list_prs' }]);
  });

  it('proxies OpenRouter JSON, injects usage flag, and prefers provider-reported cost', async () => {
    const res = await app.request('http://localhost/openrouter/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'sdk-test/1.0' },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OPENROUTER_JSON); // body unchanged for client

    // usage: {include: true} must be injected into the upstream request
    expect((lastOpenRouterBody as { usage: { include: boolean } }).usage.include).toBe(true);

    await waitForRequestRow(2);
    const row = db.prepare("SELECT * FROM requests WHERE provider = 'openrouter'").get() as Record<string, unknown>;
    expect(row.model).toBe('anthropic/claude-sonnet-4');
    expect(row.client).toBe('sdk-test/1.0'); // user-agent fallback
    expect(row.input_tokens).toBe(100);
    expect(row.output_tokens).toBe(40);
    expect(row.cache_read_tokens).toBe(60);
    expect(row.cost_total).toBe(0.00099); // provider-reported wins
  });

  it('stats API reflects recorded data', async () => {
    const res = await app.request('http://localhost/api/stats/summary');
    expect(res.status).toBe(200);
    const summary = (await res.json()) as { all_time: { requests: number; cache_read_tokens: number } };
    expect(summary.all_time.requests).toBe(2);
    expect(summary.all_time.cache_read_tokens).toBe(40060);

    const byTool = (await (await app.request('http://localhost/api/stats/by-tool')).json()) as {
      rows: { tool_name: string; mcp_server: string }[];
    };
    expect(byTool.rows[0].tool_name).toBe('mcp__github__list_prs');
    expect(byTool.rows[0].mcp_server).toBe('github');
  });

  it('passes through non-completion endpoints without recording', async () => {
    const res = await app.request('http://localhost/anthropic/v1/models', { method: 'GET' });
    expect(res.status).toBe(404); // mock upstream 404s unknown paths, passed through
    const count = (db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n;
    expect(count).toBe(2); // unchanged
  });

  it('scopes aggregates and recent requests to the from/to window', async () => {
    const now = Date.now();
    const inWindow = `from=${now - 60 * 60 * 1000}`;
    const longGone = `from=${now - 40 * 24 * 60 * 60 * 1000}&to=${now - 30 * 24 * 60 * 60 * 1000}`;

    const recent = (await (await app.request(`http://localhost/api/stats/recent?${inWindow}`)).json()) as {
      rows: unknown[];
      total: number;
    };
    expect(recent.total).toBe(2);
    expect(recent.rows).toHaveLength(2);

    // a window that predates every row must come back empty, totals included
    const empty = (await (await app.request(`http://localhost/api/stats/recent?${longGone}`)).json()) as {
      rows: unknown[];
      total: number;
    };
    expect(empty.total).toBe(0);
    expect(empty.rows).toHaveLength(0);

    for (const path of ['by-model', 'by-client', 'by-tool']) {
      const scoped = (await (await app.request(`http://localhost/api/stats/${path}?${inWindow}`)).json()) as {
        rows: unknown[];
      };
      expect(scoped.rows.length, path).toBeGreaterThan(0);
      const outside = (await (await app.request(`http://localhost/api/stats/${path}?${longGone}`)).json()) as {
        rows: unknown[];
      };
      expect(outside.rows, path).toHaveLength(0);
    }

    const byToolModel = (await (
      await app.request(`http://localhost/api/stats/by-tool-model?tool=mcp__github__list_prs&${longGone}`)
    ).json()) as { rows: unknown[] };
    expect(byToolModel.rows).toHaveLength(0);

    // the headline cards keep reporting their own fixed periods
    const summary = (await (await app.request(`http://localhost/api/stats/summary?${longGone}`)).json()) as {
      all_time: { requests: number };
    };
    expect(summary.all_time.requests).toBe(2);
  });

  it('buckets the timeseries hourly on request and daily otherwise', async () => {
    const from = `from=${Date.now() - 60 * 60 * 1000}`;
    const hourly = (await (await app.request(`http://localhost/api/stats/timeseries?${from}&bucket=hour`)).json()) as {
      bucket: string;
      rows: { day: string }[];
    };
    expect(hourly.bucket).toBe('hour');
    expect(hourly.rows.length).toBeGreaterThan(0);
    expect(hourly.rows[0].day).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:00$/);

    const daily = (await (await app.request(`http://localhost/api/stats/timeseries?${from}`)).json()) as {
      bucket: string;
      rows: { day: string }[];
    };
    expect(daily.bucket).toBe('day');
    expect(daily.rows[0].day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
