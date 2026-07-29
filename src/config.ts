export interface Config {
  port: number;
  /** Bind address. Loopback by default; Docker sets 0.0.0.0 inside the container. */
  host: string;
  dbPath: string;
  injectOpenRouterUsage: boolean;
  /** Upstream base URLs; overridable for tests. */
  anthropicUpstream: string;
  openrouterUpstream: string;
  /** Disable the weekly pricing scheduler (used in tests). */
  pricingRefreshEnabled: boolean;
}

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT) || 4141,
    host: env.HOST || '127.0.0.1',
    dbPath: env.DB_PATH || './tokenalysis.db',
    injectOpenRouterUsage: envBool(env.INJECT_OPENROUTER_USAGE, true),
    anthropicUpstream: env.ANTHROPIC_UPSTREAM || 'https://api.anthropic.com',
    openrouterUpstream: env.OPENROUTER_UPSTREAM || 'https://openrouter.ai',
    pricingRefreshEnabled: envBool(env.PRICING_REFRESH_ENABLED, true),
  };
}
