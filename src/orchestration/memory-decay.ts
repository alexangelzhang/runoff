/**
 * Memory relevance decay (ROADMAP 8.1.1, Zep-style temporal scoring).
 * decayedRelevance = relevance * exp(-λ * ageMs)
 */

/** Default half-life: 7 days (ms). */
export const DEFAULT_MEMORY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** λ such that relevance halves after `halfLifeMs`. */
export function memoryDecayLambda(halfLifeMs: number = DEFAULT_MEMORY_HALF_LIFE_MS): number {
  if (halfLifeMs <= 0) throw new Error("halfLifeMs must be positive");
  return Math.LN2 / halfLifeMs;
}

export function decayedRelevance(
  relevance: number,
  ageMs: number,
  lambdaPerMs: number = memoryDecayLambda(),
): number {
  const clamped = Math.max(0, Math.min(1, relevance));
  return clamped * Math.exp(-lambdaPerMs * Math.max(0, ageMs));
}
