/**
 * Final trace recording and hook invocation for MCP pipeline runs.
 */

import type { PipelineConfig } from "../core/config.js";
import type { PipelineResult } from "../core/pipeline-run-types.js";
import type { PipelineStatus, ResumeReusePlanReport, ScopePreflightReport } from "../core/state.js";
import type { StepResult } from "../core/state.js";
import type { PipelineCostAccumulator } from "../routing/pricing.js";
import { enrichTraceWithEventLog } from "./replay.js";
import { recordTrace, type PipelineTrace, type StepTrace } from "../observability/trace.js";
import type { EventLog } from "./event-log.js";
import type { PipelineHooks, PipelineEndContext } from "../pipeline/pipeline-hooks.js";
import { buildPipelineObservation } from "./observation.js";

export async function finalizePipelineRunResult(args: {
  traceId: string;
  sessionId: string;
  prompt: string;
  verifyResults?: string;
  stepTraces: StepTrace[];
  completedRounds: number;
  finalStatus: PipelineStatus;
  startTime: number;
  costTracker: PipelineCostAccumulator;
  stepResults: Record<string, StepResult>;
  globalKnowledge: Record<string, string>;
  scopePreflight?: ScopePreflightReport;
  resumeReusePlan?: ResumeReusePlanReport;
  runtimeConfig: PipelineConfig;
  controlPlaneMode: "memory" | "file";
  eventLog?: EventLog;
  hooks: PipelineHooks;
}): Promise<PipelineResult> {
  const {
    traceId,
    sessionId,
    prompt,
    verifyResults,
    stepTraces,
    completedRounds,
    finalStatus,
    startTime,
    costTracker,
    stepResults,
    globalKnowledge,
    scopePreflight,
    resumeReusePlan,
    runtimeConfig,
    controlPlaneMode,
    eventLog,
    hooks,
  } = args;

  const summary = costTracker.getSummary();
  const totalDurationMs = Date.now() - startTime;
  const finalResult: PipelineResult = {
    status: finalStatus,
    rounds: completedRounds,
    totalDurationMs,
    totalCostUSD: summary.totalCostUSD,
    checkpointFile: sessionId,
    traceId,
    stepResults,
    usage: { promptTokens: summary.totalTokens, completionTokens: 0 },
    costBreakdown: {},
    scopePreflight,
    resumeReusePlan,
    error: undefined,
  };
  finalResult.observation = buildPipelineObservation({
    status: finalResult.status,
    traceId: finalResult.traceId,
    checkpointFile: finalResult.checkpointFile,
    stepResults: finalResult.stepResults,
    rounds: finalResult.rounds,
    totalDurationMs: finalResult.totalDurationMs,
    error: finalResult.error,
    scopePreflight,
    resumeReusePlan,
  });

  let finalTrace: PipelineTrace = {
    id: traceId,
    sessionId,
    prompt,
    promptLength: prompt.length,
    mode: "pipeline",
    steps: stepTraces,
    totalRounds: completedRounds,
    finalStatus,
    totalDurationMs,
    timestamp: new Date().toISOString(),
    hasVerifyResults: !!verifyResults,
    totalUsage: { promptTokens: summary.totalTokens, completionTokens: 0 },
    lifecycle: "final",
    globalKnowledge: Object.keys(globalKnowledge).length > 0 ? globalKnowledge : undefined,
    observation: finalResult.observation,
    scopePreflight,
    resumeReusePlan,
  };
  if (controlPlaneMode === "file" && eventLog) {
    finalTrace = enrichTraceWithEventLog(finalTrace, eventLog, traceId);
  }
  recordTrace(finalTrace);

  const endCtx: PipelineEndContext = {
    trace: finalTrace,
    costTracker,
    config: runtimeConfig,
    eventLog: controlPlaneMode === "file" ? eventLog : undefined,
    runId: traceId,
    globalKnowledge,
  };
  if (finalStatus === "failed" || finalStatus === "aborted") {
    await hooks.onPipelineFailed(endCtx);
  } else {
    await hooks.onPipelineEnd(endCtx);
  }
  if (endCtx.warnings?.length) {
    finalResult.warnings = endCtx.warnings;
  }
  if (scopePreflight?.warnings.length) {
    finalResult.warnings = [
      ...(finalResult.warnings ?? []),
      ...scopePreflight.warnings.map((warning) => `scopePreflight: ${warning}`),
    ];
  }

  return finalResult;
}
