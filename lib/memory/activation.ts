/**
 * Activation score: combines relevance (cue match), recency, frequency.
 * activation_baseline = recency + frequency (no query), used for "top by rank" query.
 */

const LN_101 = Math.log(101)

export function daysSince(date: Date | null): number {
  if (!date) return 365
  return (Date.now() - date.getTime()) / (24 * 60 * 60 * 1000)
}

/** Recency score: 1 / (1 + days). Higher when more recent. */
export function recencyScore(date: Date | null): number {
  return 1 / (1 + daysSince(date))
}

/** Frequency score: ln(1 + recallCount) / ln(101), capped in [0, 1]. */
export function frequencyScore(recallCount: number): number {
  return Math.min(1, Math.log(1 + Math.max(0, recallCount)) / LN_101)
}

/**
 * Baseline stored on the row (no query). Updated on upsert and on markRecalled.
 * Uses lastRecalledAt or updatedAt for recency.
 */
export function computeActivationBaseline(
  lastRecalledAt: Date | null,
  updatedAt: Date,
  recallCount: number
): number {
  const ref = lastRecalledAt ?? updatedAt
  const rec = recencyScore(ref)
  const freq = frequencyScore(recallCount)
  return 0.5 * rec + 0.5 * freq
}

/**
 * Full activation for re-rank: 0.6 * relevance + 0.2 * recency + 0.2 * frequency.
 */
export function activationScore(
  relevance: number,
  lastRecalledAt: Date | null,
  updatedAt: Date,
  recallCount: number
): number {
  const rec = recencyScore(lastRecalledAt ?? updatedAt)
  const freq = frequencyScore(recallCount)
  return 0.6 * relevance + 0.2 * rec + 0.2 * freq
}
