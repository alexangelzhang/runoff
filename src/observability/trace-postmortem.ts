/**
 * Trace postmortem — human-readable failure analysis for MCP/CLI/UI.
 */

import type { PipelineTrace, StepTrace } from "./trace.js";
import { listTraces, queryTraces, type TraceQuery } from "./trace.js";
import {
  bucketTracesByTime,
  detectTraceDrift,
  type DriftAlert,
} from "../orchestration/trace-drift.js";
import { listTraceScores, type TraceScore } from "./trace-scores.js";

export type TracePostmortem = {
  traceId: string;
  sessionId?: string;
  finalStatus: string;
  headline: string;
  failedSteps: Array<{
    name: string;
    provider: string;
    round: number;
    error?: string;
    errorDetail?: StepTrace["errorDetail"];
    observationSummary?: string;
  }>;
  observationSummary?: string;
  lastSuccessfulStep?: string;
  costSummary?: PipelineTrace["costSummary"];
  experiment?: PipelineTrace["experiment"];
  humanScores: TraceScore[];
  driftAlerts: DriftAlert[];
  hints: string[];
};

function failedStepRows(steps: StepTrace[]): TracePostmortem["failedSteps"] {
  return steps
    .filter((s) => s.error || s.errorDetail || s.verdict === "needs_revision")
    .map((s) => ({
      name: s.name,
      provider: s.provider,
      round: s.round,
      error: s.error,
      errorDetail: s.errorDetail,
      observationSummary: s.observation?.summary,
    }));
}

function buildHeadline(trace: PipelineTrace): string {
  const failed = failedStepRows(trace.steps);
  if (trace.finalStatus === "approved") {
    return `Run approved in ${trace.totalRounds} round(s), ${trace.totalDurationMs}ms`;
  }
  if (failed.length > 0) {
    const last = failed[failed.length - 1]!;
    return `Run ${trace.finalStatus}: step "${last.name}" (${last.provider}) — ${last.error ?? last.errorDetail?.message ?? "needs revision"}`;
  }
  return `Run ended with status ${trace.finalStatus} (${trace.totalDurationMs}ms)`;
}

function buildHints(trace: PipelineTrace): string[] {
  const hints: string[] = [];
  if (trace.finalStatus === "max_rounds") {
    hints.push("Increase retry.maxRounds or narrow acceptance criteria.");
  }
  if (trace.finalStatus === "failed" && trace.steps.some((s) => s.fallback)) {
    hints.push("A fallback provider was used — check primary provider health.");
  }
  if (trace.hasVerifyResults && trace.finalStatus !== "approved") {
    hints.push("Verify step produced results but pipeline did not approve — review verdict parsing.");
  }
  const raceConflicts = trace.steps.flatMap((s) => s.raceMergeConflicts ?? []);
  if (raceConflicts.length > 0) {
    hints.push(`Race merge conflicts: ${raceConflicts.slice(0, 3).join(", ")}${raceConflicts.length > 3 ? "…" : ""}`);
  }
  return hints;
}

function driftForContext(trace: PipelineTrace): DriftAlert[] {
  const query: TraceQuery = { limit: 50 };
  if (trace.experiment?.experimentId) {
    const related = listTraces().filter(
      (t) => t.experiment?.experimentId === trace.experiment!.experimentId,
    );
    if (related.length >= 4) {
      const buckets = bucketTracesByTime(related, 86_400_000);
      return detectTraceDrift(buckets);
    }
  }
  const recent = queryTraces(query);
  if (recent.length < 4) return [];
  const buckets = bucketTracesByTime(recent, 86_400_000);
  return detectTraceDrift(buckets);
}

/** Build a structured postmortem for one trace. */
export function buildTracePostmortem(trace: PipelineTrace): TracePostmortem {
  const failed = failedStepRows(trace.steps);
  const okSteps = trace.steps.filter((s) => !s.error && !s.errorDetail);
  return {
    traceId: trace.id,
    sessionId: trace.sessionId,
    finalStatus: trace.finalStatus,
    headline: buildHeadline(trace),
    failedSteps: failed,
    observationSummary: trace.observation?.summary,
    lastSuccessfulStep: okSteps.length ? okSteps[okSteps.length - 1]!.name : undefined,
    costSummary: trace.costSummary,
    experiment: trace.experiment,
    humanScores: listTraceScores(trace.id),
    driftAlerts: driftForContext(trace),
    hints: buildHints(trace),
  };
}

/** One-line summary for eval reports and tables. */
export function postmortemOneLiner(trace: PipelineTrace): string {
  return buildTracePostmortem(trace).headline;
}
