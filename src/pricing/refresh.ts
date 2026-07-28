import type { Database as DB } from 'better-sqlite3';
import { latestSnapshotFetchedAt, logApp, type PriceRow } from '../db.js';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const LITELLM_PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PER_TOKEN_TO_PER_MTOK = 1_000_000;

function toNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Normalize OpenRouter /api/v1/models payload (per-token USD strings) to per-Mtok rows. */
export function normalizeOpenRouterModels(payload: unknown): PriceRow[] {
  const rows: PriceRow[] = [];
  if (!payload || typeof payload !== 'object') return rows;
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) return rows;
  for (const m of data) {
    if (!m || typeof m !== 'object') continue;
    const model = m as Record<string, unknown>;
    const id = typeof model.id === 'string' ? model.id : null;
    const pricing = model.pricing as Record<string, unknown> | undefined;
    if (!id || !pricing) continue;
    const input = toNum(pricing.prompt);
    const output = toNum(pricing.completion);
    const cacheRead = toNum(pricing.input_cache_read);
    const cacheWrite = toNum(pricing.input_cache_write);
    rows.push({
      model: id,
      inputPerMtok: input !== null ? input * PER_TOKEN_TO_PER_MTOK : null,
      outputPerMtok: output !== null ? output * PER_TOKEN_TO_PER_MTOK : null,
      cacheReadPerMtok: cacheRead !== null ? cacheRead * PER_TOKEN_TO_PER_MTOK : null,
      cacheWritePerMtok: cacheWrite !== null ? cacheWrite * PER_TOKEN_TO_PER_MTOK : null,
    });
  }
  return rows;
}

/** Normalize LiteLLM's model_prices_and_context_window.json (per-token USD numbers) to per-Mtok rows. */
export function normalizeLiteLlmPrices(payload: unknown): PriceRow[] {
  const rows: PriceRow[] = [];
  if (!payload || typeof payload !== 'object') return rows;
  for (const [model, raw] of Object.entries(payload as Record<string, unknown>)) {
    if (model === 'sample_spec' || !raw || typeof raw !== 'object') continue;
    const spec = raw as Record<string, unknown>;
    const input = toNum(spec.input_cost_per_token);
    const output = toNum(spec.output_cost_per_token);
    const cacheRead = toNum(spec.cache_read_input_token_cost);
    const cacheWrite = toNum(spec.cache_creation_input_token_cost);
    if (input === null && output === null) continue;
    rows.push({
      model,
      inputPerMtok: input !== null ? input * PER_TOKEN_TO_PER_MTOK : null,
      outputPerMtok: output !== null ? output * PER_TOKEN_TO_PER_MTOK : null,
      cacheReadPerMtok: cacheRead !== null ? cacheRead * PER_TOKEN_TO_PER_MTOK : null,
      cacheWritePerMtok: cacheWrite !== null ? cacheWrite * PER_TOKEN_TO_PER_MTOK : null,
    });
  }
  return rows;
}

/** Insert a dated snapshot with all rows; existing snapshots are kept (immutable history). */
export function storeSnapshot(db: DB, rows: PriceRow[], source: string): number {
  const insertSnapshot = db.prepare('INSERT INTO price_snapshots (fetched_at, source) VALUES (?, ?)');
  const insertPrice = db.prepare(
    'INSERT INTO prices (snapshot_id, model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const run = db.transaction((): number => {
    const snapshotId = Number(insertSnapshot.run(Date.now(), source).lastInsertRowid);
    for (const r of rows) {
      insertPrice.run(snapshotId, r.model, r.inputPerMtok, r.outputPerMtok, r.cacheReadPerMtok, r.cacheWritePerMtok);
    }
    return snapshotId;
  });
  return run();
}

/**
 * Fetch both pricing sources and store a combined snapshot.
 * LiteLLM rows are inserted after OpenRouter rows; findPrice's exact-match
 * preference means direct-API model names (e.g. "claude-sonnet-4-20250514")
 * resolve via LiteLLM while "anthropic/..." ids resolve via OpenRouter.
 * On total failure the previous snapshot stays live.
 */
export async function refreshPricing(db: DB): Promise<{ ok: boolean; models: number }> {
  const rows: PriceRow[] = [];
  const sources: string[] = [];

  try {
    const res = await fetch(OPENROUTER_MODELS_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rows.push(...normalizeOpenRouterModels(await res.json()));
    sources.push('openrouter');
  } catch (err) {
    logApp(db, 'warn', `pricing: openrouter fetch failed: ${(err as Error).message}`);
  }

  try {
    const res = await fetch(LITELLM_PRICES_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rows.push(...normalizeLiteLlmPrices(await res.json()));
    sources.push('litellm');
  } catch (err) {
    logApp(db, 'warn', `pricing: litellm fetch failed: ${(err as Error).message}`);
  }

  if (rows.length === 0) {
    logApp(db, 'error', 'pricing: refresh failed entirely; keeping previous snapshot');
    return { ok: false, models: 0 };
  }

  storeSnapshot(db, rows, sources.join('+'));
  logApp(db, 'info', `pricing: snapshot stored (${rows.length} models from ${sources.join('+')})`);
  return { ok: true, models: rows.length };
}

/**
 * Weekly scheduler: refresh now if the latest snapshot is missing or stale,
 * then check hourly (cheap) whether the 7-day mark has passed.
 */
export function startPricingScheduler(db: DB): NodeJS.Timeout {
  const maybeRefresh = async (): Promise<void> => {
    const fetchedAt = latestSnapshotFetchedAt(db);
    if (fetchedAt === null || Date.now() - fetchedAt >= WEEK_MS) {
      await refreshPricing(db);
    }
  };
  void maybeRefresh();
  const timer = setInterval(() => void maybeRefresh(), 60 * 60 * 1000);
  timer.unref();
  return timer;
}
