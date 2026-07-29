import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Config } from './config.js';
import { openDb } from './db.js';
import type { Database as DB } from 'better-sqlite3';
import { proxyRequest } from './proxy/forward.js';
import { anthropicSpec } from './proxy/anthropic.js';
import { openrouterSpec } from './proxy/openrouter.js';
import { statsRoutes } from './api/stats.js';
import { startPricingScheduler } from './pricing/refresh.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Build the Hono app; exported for integration tests. */
export function createApp(config: Config, db: DB): Hono {
  const app = new Hono();

  const anthropic = anthropicSpec(config.anthropicUpstream);
  const openrouter = openrouterSpec(config.openrouterUpstream, config.injectOpenRouterUsage);

  app.all('/anthropic/*', (c) => proxyRequest(c, anthropic, db));
  app.all('/openrouter/*', (c) => proxyRequest(c, openrouter, db));

  app.route('/api/stats', statsRoutes(db));
  app.get('/api/health', (c) => c.json({ ok: true }));

  // Dashboard: static files from public/ (dist/ layout puts public/ one level up).
  const publicRoot = path.relative(process.cwd(), path.join(__dirname, '..', 'public'));
  app.use('/*', serveStatic({ root: publicRoot }));
  app.get('/', serveStatic({ root: publicRoot, path: 'index.html' }));

  return app;
}

function main(): void {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const app = createApp(config, db);

  if (config.pricingRefreshEnabled) {
    startPricingScheduler(db);
  }

  // Loopback only by default: never expose the proxy or dashboard on the
  // network unless HOST is deliberately overridden (Docker sets HOST=0.0.0.0
  // inside the container and publishes the port back to the host's loopback).
  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    const shown = info.address === '0.0.0.0' || info.address === '::' ? 'localhost' : info.address;
    console.log(`Tokenalysis listening on http://${shown}:${info.port}`);
    console.log(`  dashboard  http://${shown}:${info.port}/`);
    console.log(`  anthropic  http://${shown}:${info.port}/anthropic`);
    console.log(`  openrouter http://${shown}:${info.port}/openrouter/api/v1`);
  });
}

// Only start the server when run directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
