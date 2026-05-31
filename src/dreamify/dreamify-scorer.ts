/**
 * M3 — Score Dreamify retrieval params against experiment history + eval report.
 */

import { loadTraceById } from "../observability/trace.js";
import { queryExperiments } from "../observability/experiment-log.js";
import { buildExperimentEvalReport } from "../observability/observability-dataset.js";
import type { AgentMemory } from "../orchestration/memory.js";
import type { DreamifyRetrievalParams } from "./dreamify-params.js";
import { countAssociativePatterns, matchPatternEntriesWithParams } from "./dreamify-match.js";

export interface DreamifyScoreBreakdown {
  score: number;
  approvedHitRate: number;
  failedMissRate: number;
  tokenEfficiency: number;
  evalBonus: number;
  samples: number;
}

const TOKEN_TARGET = 4000;

export function scoreDreamifyParams(
  experimentId: string,
  params: DreamifyRetrievalParams,
  memory: AgentMemory,
  scope: Partial<{ project: string }> = { project: "default" },
): DreamifyScoreBreakdown {
  const entries = queryExperiments({ experimentId });
  const report = buildExperimentEvalReport(experimentId);

  let approvedHits = 0;
  let approvedTotal = 0;
  let failedMiss = 0;
  let failedTotal = 0;
  let tokenSum = 0;
  let tokenCount = 0;

  for (const e of entries) {
    const trace = loadTraceById(e.traceId);
    if (!trace) continue;
    const matches = matchPatternEntriesWithParams(memory, scope, trace.prompt, params).length;
    const assoc = countAssociativePatterns(memory, scope, trace.prompt, params);

    if (e.status === "approved") {
      approvedTotal++;
      if (matches > 0 || assoc > 0) approvedHits++;
      tokenSum += e.totalTokens;
      tokenCount++;
    } else if (e.status === "failed" || e.status === "max_rounds") {
      failedTotal++;
      if (matches === 0) failedMiss++;
    }
  }

  const samples = entries.length;
  const approvedHitRate = approvedTotal > 0 ? approvedHits / approvedTotal : 0;
  const failedMissRate = failedTotal > 0 ? failedMiss / failedTotal : 0;
  const avgTokens = tokenCount > 0 ? tokenSum / tokenCount : TOKEN_TARGET;
  const tokenEfficiency = Math.max(0, Math.min(1, 1 - avgTokens / TOKEN_TARGET));

  let evalBonus = 0;
  if (report.winnerVariant) {
    const winnerRuns = entries.filter((x) => x.variant === report.winnerVariant);
    let winnerHits = 0;
    for (const e of winnerRuns) {
      const trace = loadTraceById(e.traceId);
      if (!trace) continue;
      if (matchPatternEntriesWithParams(memory, scope, trace.prompt, params).length > 0) {
        winnerHits++;
      }
    }
    evalBonus = winnerRuns.length > 0 ? winnerHits / winnerRuns.length : 0;
  }

  const score =
    approvedHitRate * 0.45 +
    failedMissRate * 0.15 +
    tokenEfficiency * 0.15 +
    evalBonus * 0.25 -
    Math.max(0, params.patternLimit - 3) * 0.02;

  return {
    score,
    approvedHitRate,
    failedMissRate,
    tokenEfficiency,
    evalBonus,
    samples,
  };
}
