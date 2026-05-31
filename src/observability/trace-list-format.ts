/**
 * Trace list response shapes for MCP query and future CLI/UI consumers.
 */

import type { PipelineTrace } from "./trace.js";
import { aggregateTraceStats, type TraceQuery } from "./trace.js";

export function traceSummaryRow(t: PipelineTrace) {
  return {
    id: t.id,
    sessionId: t.sessionId,
    mode: t.mode,
    finalStatus: t.finalStatus,
    totalRounds: t.totalRounds,
    totalDurationMs: t.totalDurationMs,
    timestamp: t.timestamp,
    promptLength: t.promptLength,
    stepCount: t.steps.length,
    candidateCount: t.candidates?.length,
    totalUsage: t.totalUsage,
    experimentId: t.experiment?.experimentId,
    variant: t.experiment?.variant,
  };
}

export function buildTraceListPayload(
  traces: PipelineTrace[],
  fmt: "summary" | "full",
  opts: { legacy?: boolean; detail?: boolean; stats?: ReturnType<typeof aggregateTraceStats> },
): Record<string, unknown> {
  if (opts.legacy) {
    const legacyTraces = fmt === "full" || opts.detail ? traces : traces.map(traceSummaryRow);
    return { traces: legacyTraces, count: traces.length, ...(opts.stats ? { stats: opts.stats } : {}) };
  }
  const payload =
    fmt === "full" || opts.detail
      ? { format: "full", traces, count: traces.length }
      : { format: "summary", traces: traces.map(traceSummaryRow), count: traces.length };
  return { ...payload, ...(opts.stats ? { stats: opts.stats } : {}) };
}

export type { TraceQuery };
