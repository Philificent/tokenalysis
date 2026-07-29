import { Hono } from 'hono';
import type { Database as DB } from 'better-sqlite3';
import { latestSnapshotFetchedAt } from '../db.js';

const TOKEN_SUMS = `
  COUNT(*) AS requests,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(cost_input), 0) AS cost_input,
  COALESCE(SUM(cost_output), 0) AS cost_output,
  COALESCE(SUM(cost_cache_write), 0) AS cost_cache_write,
  COALESCE(SUM(cost_cache_read), 0) AS cost_cache_read,
  COALESCE(SUM(cost_total), 0) AS cost_total,
  SUM(CASE WHEN cost_total IS NULL AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL) THEN 1 ELSE 0 END) AS unpriced_requests
`;

/** Start-of-period boundaries in local time, as epoch ms. */
export function periodStarts(now: Date = new Date()): { today: number; week: number; month: number } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayOfWeek = (now.getDay() + 6) % 7; // Monday = 0
  const week = today - dayOfWeek * 24 * 60 * 60 * 1000;
  const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return { today, week, month };
}

export function statsRoutes(db: DB): Hono {
  const app = new Hono();

  app.get('/summary', (c) => {
    const { today, week, month } = periodStarts();
    const query = db.prepare(`SELECT ${TOKEN_SUMS} FROM requests WHERE ts >= ?`);
    const all = db.prepare(`SELECT ${TOKEN_SUMS} FROM requests`).get();
    return c.json({
      today: query.get(today),
      week: query.get(week),
      month: query.get(month),
      all_time: all,
      pricing_snapshot_at: latestSnapshotFetchedAt(db),
    });
  });

  app.get('/timeseries', (c) => {
    const days = Math.min(Number(c.req.query('days')) || 30, 365);
    const groupBy = c.req.query('group') === 'model' ? 'model' : 'class';
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    if (groupBy === 'model') {
      const rows = db
        .prepare(
          `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day,
                  COALESCE(model, '(unknown)') AS model,
                  COALESCE(SUM(cost_total), 0) AS cost_total,
                  COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0)
                    + COALESCE(SUM(cache_creation_tokens), 0) + COALESCE(SUM(cache_read_tokens), 0) AS tokens
           FROM requests WHERE ts >= ?
           GROUP BY day, model ORDER BY day`
        )
        .all(since);
      return c.json({ group: 'model', rows });
    }
    const rows = db
      .prepare(
        `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day,
                COALESCE(SUM(cost_input), 0) AS cost_input,
                COALESCE(SUM(cost_output), 0) AS cost_output,
                COALESCE(SUM(cost_cache_write), 0) AS cost_cache_write,
                COALESCE(SUM(cost_cache_read), 0) AS cost_cache_read,
                COALESCE(SUM(cost_total), 0) AS cost_total
         FROM requests WHERE ts >= ?
         GROUP BY day ORDER BY day`
      )
      .all(since);
    return c.json({ group: 'class', rows });
  });

  app.get('/by-model', (c) => {
    const rows = db
      .prepare(
        `SELECT COALESCE(model, '(unknown)') AS model, provider, ${TOKEN_SUMS},
                CASE WHEN COALESCE(SUM(cache_read_tokens), 0) + COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(cache_creation_tokens), 0) > 0
                     THEN CAST(COALESCE(SUM(cache_read_tokens), 0) AS REAL)
                          / (COALESCE(SUM(cache_read_tokens), 0) + COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(cache_creation_tokens), 0))
                     ELSE NULL END AS cache_hit_ratio
         FROM requests GROUP BY model, provider ORDER BY cost_total DESC`
      )
      .all();
    return c.json({ rows });
  });

  app.get('/by-tool', (c) => {
    const rows = db
      .prepare(
        `SELECT tc.tool_name, tc.is_mcp, tc.mcp_server,
                SUM(tc.call_count) AS calls,
                COUNT(DISTINCT tc.request_id) AS requests,
                COALESCE(SUM(r.cost_total), 0) AS involved_cost
         FROM tool_calls tc
         JOIN (SELECT id, cost_total FROM requests) r ON r.id = tc.request_id
         GROUP BY tc.tool_name, tc.is_mcp, tc.mcp_server
         ORDER BY calls DESC`
      )
      .all();
    const offered = db
      .prepare(
        `SELECT tool_name, COUNT(DISTINCT request_id) AS offered_in_requests
         FROM tools_offered GROUP BY tool_name`
      )
      .all();
    return c.json({ rows, offered });
  });

  app.get('/by-tool-model', (c) => {
    const tool = c.req.query('tool');
    if (!tool) return c.json({ error: 'tool query param required' }, 400);
    const rows = db
      .prepare(
        `SELECT COALESCE(r.model, '(unknown)') AS model,
                SUM(tc.call_count) AS calls,
                COUNT(DISTINCT tc.request_id) AS requests,
                COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
                COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
                COALESCE(SUM(r.cache_creation_tokens), 0) AS cache_creation_tokens,
                COALESCE(SUM(r.cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(r.cost_total), 0) AS cost_total
         FROM tool_calls tc
         JOIN requests r ON r.id = tc.request_id
         WHERE tc.tool_name = ?
         GROUP BY r.model
         ORDER BY cost_total DESC`
      )
      .all(tool);
    return c.json({ rows });
  });

  app.get('/by-client', (c) => {
    const rows = db
      .prepare(
        `SELECT COALESCE(client, '(unknown)') AS client, ${TOKEN_SUMS}
         FROM requests GROUP BY client ORDER BY cost_total DESC`
      )
      .all();
    return c.json({ rows });
  });

  app.get('/recent', (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 1000);
    const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
    const rows = db
      .prepare(
        `SELECT id, ts, provider, model, client, status, latency_ms, stream,
                input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
                cost_total, parse_error
         FROM requests ORDER BY ts DESC LIMIT ? OFFSET ?`
      )
      .all(limit, offset);
    const total = (db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n;
    return c.json({ rows, total });
  });

  app.get('/request/:id', (c) => {
    const id = Number(c.req.param('id'));
    const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
    if (!request) return c.json({ error: 'not found' }, 404);
    const toolCalls = db.prepare('SELECT tool_name, is_mcp, mcp_server, call_count FROM tool_calls WHERE request_id = ?').all(id);
    const toolsOffered = db.prepare('SELECT tool_name FROM tools_offered WHERE request_id = ?').all(id);
    return c.json({ request, tool_calls: toolCalls, tools_offered: toolsOffered });
  });

  app.get('/warnings', (c) => {
    const rows = db
      .prepare("SELECT ts, level, message FROM app_log WHERE level IN ('warn', 'error') ORDER BY ts DESC LIMIT 20")
      .all();
    return c.json({ rows });
  });

  return app;
}
