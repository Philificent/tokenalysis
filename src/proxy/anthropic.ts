import type { ProviderSpec } from './forward.js';
import { extractAnthropicJson, extractAnthropicStream } from '../usage/extract.js';

/** Anthropic Messages API: /anthropic/* -> api.anthropic.com/*. */
export function anthropicSpec(upstreamBase: string): ProviderSpec {
  return {
    name: 'anthropic',
    upstreamBase,
    mountPrefix: '/anthropic',
    isCompletionPath: (path) => /^\/v1\/messages\/?$/.test(path),
    mutateRequestBody: () => null, // never touch Anthropic request bodies
    extractJson: extractAnthropicJson,
    extractStream: extractAnthropicStream,
  };
}
