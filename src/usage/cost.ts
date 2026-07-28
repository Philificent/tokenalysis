import type { PriceRow, UsageRecord } from '../db.js';

export interface ComputedCosts {
  costInput: number | null;
  costOutput: number | null;
  costCacheWrite: number | null;
  costCacheRead: number | null;
  costTotal: number | null;
  priceSnapshotId: number | null;
}

const MTOK = 1_000_000;

function classCost(tokens: number | null, perMtok: number | null): number | null {
  if (tokens === null || perMtok === null) return null;
  return (tokens / MTOK) * perMtok;
}

/**
 * Compute per-class costs for a usage record from a price snapshot row.
 * Provider-reported cost (OpenRouter usage.cost) wins for cost_total when present.
 * Unknown model / missing prices => nulls (surfaced on dashboard as "unpriced").
 */
export function computeCosts(
  record: Pick<
    UsageRecord,
    'inputTokens' | 'outputTokens' | 'cacheCreationTokens' | 'cacheReadTokens' | 'providerCost'
  >,
  price: PriceRow | null,
  snapshotId: number | null
): ComputedCosts {
  const costInput = price ? classCost(record.inputTokens, price.inputPerMtok) : null;
  const costOutput = price ? classCost(record.outputTokens, price.outputPerMtok) : null;
  const costCacheWrite = price ? classCost(record.cacheCreationTokens, price.cacheWritePerMtok) : null;
  const costCacheRead = price ? classCost(record.cacheReadTokens, price.cacheReadPerMtok) : null;

  let costTotal: number | null;
  if (record.providerCost !== null) {
    costTotal = record.providerCost;
  } else {
    const parts = [costInput, costOutput, costCacheWrite, costCacheRead].filter(
      (v): v is number => v !== null
    );
    costTotal = parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : null;
  }

  return {
    costInput,
    costOutput,
    costCacheWrite,
    costCacheRead,
    costTotal,
    priceSnapshotId: snapshotId,
  };
}
