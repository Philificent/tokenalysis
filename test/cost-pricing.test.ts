import { describe, expect, it } from 'vitest';
import { computeCosts } from '../src/usage/cost.js';
import { normalizeLiteLlmPrices, normalizeOpenRouterModels } from '../src/pricing/refresh.js';
import type { PriceRow } from '../src/db.js';

const SONNET_PRICE: PriceRow = {
  model: 'claude-sonnet-4-20250514',
  inputPerMtok: 3,
  outputPerMtok: 15,
  cacheReadPerMtok: 0.3,
  cacheWritePerMtok: 3.75,
};

describe('computeCosts', () => {
  it('computes each token class from per-Mtok prices', () => {
    const costs = computeCosts(
      {
        inputTokens: 1_000_000,
        outputTokens: 200_000,
        cacheCreationTokens: 400_000,
        cacheReadTokens: 10_000_000,
        providerCost: null,
      },
      SONNET_PRICE,
      7
    );
    expect(costs.costInput).toBeCloseTo(3, 10);
    expect(costs.costOutput).toBeCloseTo(3, 10); // 0.2 * 15
    expect(costs.costCacheWrite).toBeCloseTo(1.5, 10); // 0.4 * 3.75
    expect(costs.costCacheRead).toBeCloseTo(3, 10); // 10 * 0.3
    expect(costs.costTotal).toBeCloseTo(10.5, 10);
    expect(costs.priceSnapshotId).toBe(7);
  });

  it('provider-reported cost wins for total but classes stay computed', () => {
    const costs = computeCosts(
      { inputTokens: 100, outputTokens: 100, cacheCreationTokens: null, cacheReadTokens: null, providerCost: 0.5 },
      SONNET_PRICE,
      1
    );
    expect(costs.costTotal).toBe(0.5);
    expect(costs.costInput).toBeCloseTo(0.0003, 10);
  });

  it('unknown model yields null costs', () => {
    const costs = computeCosts(
      { inputTokens: 100, outputTokens: 100, cacheCreationTokens: 5, cacheReadTokens: 5, providerCost: null },
      null,
      null
    );
    expect(costs.costInput).toBeNull();
    expect(costs.costTotal).toBeNull();
  });

  it('null token counts yield null class costs without breaking total', () => {
    const costs = computeCosts(
      { inputTokens: 1_000_000, outputTokens: null, cacheCreationTokens: null, cacheReadTokens: null, providerCost: null },
      SONNET_PRICE,
      1
    );
    expect(costs.costInput).toBeCloseTo(3, 10);
    expect(costs.costOutput).toBeNull();
    expect(costs.costTotal).toBeCloseTo(3, 10);
  });
});

describe('normalizeOpenRouterModels', () => {
  it('converts per-token string prices to per-Mtok', () => {
    const payload = {
      data: [
        {
          id: 'anthropic/claude-sonnet-4',
          pricing: {
            prompt: '0.000003',
            completion: '0.000015',
            input_cache_read: '0.0000003',
            input_cache_write: '0.00000375',
          },
        },
        { id: 'no-pricing-model' },
        { pricing: { prompt: '0.000001' } }, // missing id -> skipped
      ],
    };
    const rows = normalizeOpenRouterModels(payload);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      model: 'anthropic/claude-sonnet-4',
      inputPerMtok: 3,
      outputPerMtok: 15,
      cacheReadPerMtok: 0.3,
      cacheWritePerMtok: 3.75,
    });
  });

  it('handles junk payloads', () => {
    expect(normalizeOpenRouterModels(null)).toEqual([]);
    expect(normalizeOpenRouterModels({})).toEqual([]);
    expect(normalizeOpenRouterModels({ data: 'x' })).toEqual([]);
  });
});

describe('normalizeLiteLlmPrices', () => {
  it('converts per-token numeric prices including cache classes', () => {
    const payload = {
      sample_spec: { input_cost_per_token: 0, note: 'ignored' },
      'claude-sonnet-4-20250514': {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        cache_creation_input_token_cost: 0.00000375,
        cache_read_input_token_cost: 0.0000003,
      },
      'some-free-model': { mode: 'chat' }, // no prices -> skipped
    };
    const rows = normalizeLiteLlmPrices(payload);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      model: 'claude-sonnet-4-20250514',
      inputPerMtok: 3,
      outputPerMtok: 15,
      cacheReadPerMtok: 0.3,
      cacheWritePerMtok: 3.75,
    });
  });
});
