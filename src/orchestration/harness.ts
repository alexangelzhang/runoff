/**
 * Eval hooks — score pipeline traces for regression / benchmark (Phase 7.6).
 */

import type { PipelineStatus } from "../core/state.js";
import type { PipelineTrace } from "../observability/trace.js";

export interface TraceEvalResult {
  traceId: string;
  finalStatus: PipelineStatus;
  success: boolean;
  durationMs: number;
  roundCount: number;
  stepCount: number;
  approvalCount: number;
  handoffCount: number;
}

export interface RegressionTolerance {
  /** Allowed increase in duration vs baseline (ms). */
  maxDurationDeltaMs?: number;
}

export function evaluatePipelineTrace(trace: PipelineTrace): TraceEvalResult {
  const success = trace.finalStatus === "approved";
  return {
    traceId: trace.id,
    finalStatus: trace.finalStatus,
    success,
    durationMs: trace.totalDurationMs,
    roundCount: trace.totalRounds,
    stepCount: trace.steps.length,
    approvalCount: trace.approvals?.length ?? 0,
    handoffCount: trace.handoffs?.length ?? 0,
  };
}

export function compareRegression(
  actual: TraceEvalResult,
  baseline: TraceEvalResult,
  tolerance: RegressionTolerance = {},
): { pass: boolean; message?: string } {
  if (actual.success !== baseline.success) {
    return {
      pass: false,
      message: `success mismatch: actual=${actual.success} baseline=${baseline.success}`,
    };
  }
  if (actual.finalStatus !== baseline.finalStatus) {
    return {
      pass: false,
      message: `status mismatch: actual=${actual.finalStatus} baseline=${baseline.finalStatus}`,
    };
  }
  const maxDelta = tolerance.maxDurationDeltaMs ?? 60_000;
  const delta = actual.durationMs - baseline.durationMs;
  if (delta > maxDelta) {
    return {
      pass: false,
      message: `duration regression: +${delta}ms (max +${maxDelta}ms)`,
    };
  }
  return { pass: true };
}
