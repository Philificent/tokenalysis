import type { ProviderSpec } from './forward.js';
import { extractOpenRouterJson, extractOpenRouterStream } from '../usage/extract.js';

/** OpenRouter Chat Completions: /openrouter/* -> openrouter.ai/*. */
export function openrouterSpec(upstreamBase: string, injectUsage: boolean): ProviderSpec {
  return {
    name: 'openrouter',
    upstreamBase,
    mountPrefix: '/openrouter',
    isCompletionPath: (path) => /^\/api\/v1\/(chat\/)?completions\/?$/.test(path),
    mutateRequestBody: (body) => {
      if (!injectUsage) return null;
      const usage = body.usage;
      if (usage && typeof usage === 'object' && (usage as Record<string, unknown>).include === true) {
        return null; // already requested
      }
      return { ...body, usage: { ...(typeof usage === 'object' && usage !== null ? usage : {}), include: true } };
    },
    extractJson: extractOpenRouterJson,
    extractStream: extractOpenRouterStream,
  };
}
