/**
 * Experiment Judge (autoresearch-inspired keep/discard logic).
 *
 * Given a baseline trace and a candidate trace, decides whether to
 * keep or discard the candidate based on configurable criteria.
 */

import type { PipelineTrace } from "../observability/trace.js";
import { computeTokenEconomics } from "../observability/trace.js";

// --- Verdict ---

export type ExperimentVerdict = "keep" | "discard" | "regression";

/** Phase 8.3.7 — multidimensional scores (0–1, higher is better). */
export interface JudgeDimensionScores {
  correctness: number;
  tokenEfficiency: number;
  latency: number;
  overall: number;
}

export interface JudgeResult {
  verdict: ExperimentVerdict;
  reasons: string[];
  /** Token comparison ratio (candidate / baseline). < 1 means savings. */
  tokenRatio: number;
  /** Duration comparison ratio. */
  durationRatio: number;
  scores: JudgeDimensionScores;
}

export function computeJudgeScores(
  baseline: PipelineTrace,
  candidate: PipelineTrace,
  tokenRatio: number,
  durationRatio: number,
): JudgeDimensionScores {
  const correctness =
    candidate.finalStatus === "approved"
      ? 1
      : baseline.finalStatus === "approved"
        ? 0
        : 0.3;
  const tokenEfficiency = Math.min(1, 1 / Math.max(tokenRatio, 0.01));
  const latency = Math.min(1, 1 / Math.max(durationRatio, 0.01));
  const overall =
    correctness * 0.5 + tokenEfficiency * 0.25 + latency * 0.25;
  return { correctness, tokenEfficiency, latency, overall };
}

function withScores(
  base: Omit<JudgeResult, "scores">,
  baseline: PipelineTrace,
  candidate: PipelineTrace,
): JudgeResult {
  return {
    ...base,
    scores: computeJudgeScores(baseline, candidate, base.tokenRatio, base.durationRatio),
  };
}

// --- Criteria ---

export interface JudgeCriteria {
  /**
   * Maximum token ratio allowed (candidate / baseline).
   * Default 1.5 — candidate can use up to 50% more tokens and still be kept.
   */
  maxTokenRatio?: number;
  /**
   * Maximum duration ratio allowed.
   * Default 2.0 — candidate can take up to 2x longer.
   */
  maxDurationRatio?: number;
  /**
   * If true, only approved traces can be kept.
   * Default true.
   */
  requireApproved?: boolean;
}

const DEFAULT_CRITERIA: Required<JudgeCriteria> = {
  maxTokenRatio: 1.5,
  maxDurationRatio: 2.0,
  requireApproved: true,
};

// --- Judge ---

/**
 * Judge whether a candidate trace should be kept or discarded
 * compared to a baseline trace.
 *
 * Logic (inspired by autoresearch's val_bpb threshold):
 * 1. If candidate failed and requireApproved → discard
 * 2. If candidate approved and baseline failed → keep (improvement)
 * 3. Compare token usage and duration against thresholds
 * 4. If approved with fewer tokens → keep
 * 5. If approved with more tokens but within budget → regression (keep with warning)
 * 6. If over budget → discard
 */
export function judgeExperiment(
  baseline: PipelineTrace,
  candidate: PipelineTrace,
  criteria: JudgeCriteria = {},
): JudgeResult {
  const c = { ...DEFAULT_CRITERIA, ...criteria };
  const reasons: string[] = [];

  const baseEcon = computeTokenEconomics([baseline]);
  const candEcon = computeTokenEconomics([candidate]);

  const tokenRatio = baseEcon.totalTokens > 0
    ? candEcon.totalTokens / baseEcon.totalTokens
    : 1;
  const durationRatio = baseline.totalDurationMs > 0
    ? candidate.totalDurationMs / baseline.totalDurationMs
    : 1;

  // Rule 1: candidate must be approved if required
  if (c.requireApproved && candidate.finalStatus !== "approved") {
    reasons.push(`Candidate status "${candidate.finalStatus}" — not approved`);
    return withScores({ verdict: "discard", reasons, tokenRatio, durationRatio }, baseline, candidate);
  }

  // Rule 2: candidate approved, baseline failed → clear improvement
  if (candidate.finalStatus === "approved" && baseline.finalStatus !== "approved") {
    reasons.push("Candidate approved where baseline failed — clear improvement");
    return withScores({ verdict: "keep", reasons, tokenRatio, durationRatio }, baseline, candidate);
  }

  // Rule 3: token budget check
  if (tokenRatio > c.maxTokenRatio) {
    reasons.push(
      `Token ratio ${tokenRatio.toFixed(2)}x exceeds max ${c.maxTokenRatio}x ` +
      `(${candEcon.totalTokens} vs ${baseEcon.totalTokens})`
    );
    return withScores({ verdict: "discard", reasons, tokenRatio, durationRatio }, baseline, candidate);
  }

  // Rule 4: duration budget check
  if (durationRatio > c.maxDurationRatio) {
    reasons.push(
      `Duration ratio ${durationRatio.toFixed(2)}x exceeds max ${c.maxDurationRatio}x`
    );
    return withScores({ verdict: "discard", reasons, tokenRatio, durationRatio }, baseline, candidate);
  }

  // Rule 5: approved with fewer tokens → keep
  if (tokenRatio <= 1.0) {
    const saved = ((1 - tokenRatio) * 100).toFixed(1);
    reasons.push(`${saved}% token savings (${candEcon.totalTokens} vs ${baseEcon.totalTokens})`);
    return withScores({ verdict: "keep", reasons, tokenRatio, durationRatio }, baseline, candidate);
  }

  // Rule 6: approved but more tokens (within budget) → regression
  const increase = ((tokenRatio - 1) * 100).toFixed(1);
  reasons.push(
    `${increase}% token increase — within budget but regressed ` +
    `(${candEcon.totalTokens} vs ${baseEcon.totalTokens})`
  );
  return withScores({ verdict: "regression", reasons, tokenRatio, durationRatio }, baseline, candidate);
}

/**
 * Batch judge: compare multiple candidates against a single baseline.
 * Returns results sorted by token efficiency (best first).
 */
export function judgeExperimentBatch(
  baseline: PipelineTrace,
  candidates: PipelineTrace[],
  criteria: JudgeCriteria = {},
): Array<{ trace: PipelineTrace; result: JudgeResult }> {
  return candidates
    .map((trace) => ({ trace, result: judgeExperiment(baseline, trace, criteria) }))
    .sort((a, b) => a.result.tokenRatio - b.result.tokenRatio);
}
