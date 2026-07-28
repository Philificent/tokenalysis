import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';

export interface UsageRecord {
  ts: number; // epoch ms
  provider: 'anthropic' | 'openrouter';
  model: string | null;
  client: string | null;
  status: number;
  latencyMs: number;
  stream: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  /** Provider-reported total cost (OpenRouter usage.cost), in USD. */
  providerCost: number | null;
  toolCalls: ToolCall[];
  toolsOffered: string[];
  parseError: boolean;
}

export interface ToolCall {
  toolName: string;
  isMcp: boolean;
  mcpServer: string | null;
  callCount: number;
}

export interface PriceRow {
  model: string;
  /** USD per million tokens; null = unknown for that class. */
  inputPerMtok: number | null;
  outputPerMtok: number | null;
  cacheReadPerMtok: number | null;
  cacheWritePerMtok: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  client TEXT,
  status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  stream INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cache_read_tokens INTEGER,
  cost_input REAL,
  cost_output REAL,
  cost_cache_write REAL,
  cost_cache_read REAL,
  cost_total REAL,
  price_snapshot_id INTEGER,
  parse_error INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);

CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  tool_name TEXT NOT NULL,
  is_mcp INTEGER NOT NULL DEFAULT 0,
  mcp_server TEXT,
  call_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_request ON tool_calls(request_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(tool_name);

CREATE TABLE IF NOT EXISTS tools_offered (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  tool_name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tools_offered_request ON tools_offered(request_id);

CREATE TABLE IF NOT EXISTS price_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at INTEGER NOT NULL,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES price_snapshots(id),
  model TEXT NOT NULL,
  input_per_mtok REAL,
  output_per_mtok REAL,
  cache_read_per_mtok REAL,
  cache_write_per_mtok REAL
);
CREATE INDEX IF NOT EXISTS idx_prices_snapshot_model ON prices(snapshot_id, model);

CREATE TABLE IF NOT EXISTS app_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
`;

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

export function logApp(db: DB, level: 'info' | 'warn' | 'error', message: string): void {
  db.prepare('INSERT INTO app_log (ts, level, message) VALUES (?, ?, ?)').run(Date.now(), level, message);
}

export function latestSnapshotId(db: DB): number | null {
  const row = db.prepare('SELECT id FROM price_snapshots ORDER BY fetched_at DESC LIMIT 1').get() as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

export function latestSnapshotFetchedAt(db: DB): number | null {
  const row = db.prepare('SELECT fetched_at FROM price_snapshots ORDER BY fetched_at DESC LIMIT 1').get() as
    | { fetched_at: number }
    | undefined;
  return row?.fetched_at ?? null;
}

/** Look up a model's prices in a snapshot, tolerating provider-prefixed ids. */
export function findPrice(db: DB, snapshotId: number, model: string): PriceRow | null {
  const exact = db
    .prepare('SELECT model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok FROM prices WHERE snapshot_id = ? AND model = ?')
    .get(snapshotId, model) as Record<string, unknown> | undefined;
  const row =
    exact ??
    (db
      .prepare(
        "SELECT model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok FROM prices WHERE snapshot_id = ? AND (model LIKE '%/' || ? OR ? LIKE '%/' || model) LIMIT 1"
      )
      .get(snapshotId, model, model) as Record<string, unknown> | undefined);
  if (!row) return null;
  return {
    model: row.model as string,
    inputPerMtok: row.input_per_mtok as number | null,
    outputPerMtok: row.output_per_mtok as number | null,
    cacheReadPerMtok: row.cache_read_per_mtok as number | null,
    cacheWritePerMtok: row.cache_write_per_mtok as number | null,
  };
}

export interface InsertedRequest {
  id: number;
}

export function insertUsageRecord(
  db: DB,
  record: UsageRecord,
  costs: {
    costInput: number | null;
    costOutput: number | null;
    costCacheWrite: number | null;
    costCacheRead: number | null;
    costTotal: number | null;
    priceSnapshotId: number | null;
  }
): InsertedRequest {
  const insertRequest = db.prepare(`
    INSERT INTO requests (
      ts, provider, model, client, status, latency_ms, stream,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      cost_input, cost_output, cost_cache_write, cost_cache_read, cost_total,
      price_snapshot_id, parse_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTool = db.prepare(
    'INSERT INTO tool_calls (request_id, tool_name, is_mcp, mcp_server, call_count) VALUES (?, ?, ?, ?, ?)'
  );
  const insertOffered = db.prepare('INSERT INTO tools_offered (request_id, tool_name) VALUES (?, ?)');

  const run = db.transaction((): InsertedRequest => {
    const result = insertRequest.run(
      record.ts,
      record.provider,
      record.model,
      record.client,
      record.status,
      record.latencyMs,
      record.stream ? 1 : 0,
      record.inputTokens,
      record.outputTokens,
      record.cacheCreationTokens,
      record.cacheReadTokens,
      costs.costInput,
      costs.costOutput,
      costs.costCacheWrite,
      costs.costCacheRead,
      costs.costTotal,
      costs.priceSnapshotId,
      record.parseError ? 1 : 0
    );
    const requestId = Number(result.lastInsertRowid);
    for (const tc of record.toolCalls) {
      insertTool.run(requestId, tc.toolName, tc.isMcp ? 1 : 0, tc.mcpServer, tc.callCount);
    }
    for (const name of record.toolsOffered) {
      insertOffered.run(requestId, name);
    }
    return { id: requestId };
  });
  return run();
}
