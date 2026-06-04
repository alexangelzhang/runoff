/**
 * MCP pipeline run session — checkpoint/resume, workspace, hooks, execution loop.
 * Keeps `src/tools/run-pipeline.ts` thin (tool registration + global timeout only).
 */

import { randomUUID } from "node:crypto";
import { loadConfig, calculateConfigHash } from "../core/config.js";
import { forkPipelineForRun, resolveReviewStepName } from "./runtime-pipeline.js";
import { createControlPlane } from "./control-plane.js";
import { createPipelineCostTracker, runPipelineExecution } from "./pipeline-execution.js";
import { createExecutionGovernance } from "./execution-governance.js";
import { syncRunStoreFromPipeline } from "./run-control.js";
import type { MutablePipelineRunState } from "./pipeline-runner.js";
import { saveCheckpoint, buildResumeMetadata, type PipelineStatus } from "../core/state.js";
import type { PipelineResult, PipelineParams } from "../core/pipeline-run-types.js";
import { pipelineUsesGlobalSessionWorkspace } from "../runtime/pipeline-workdir.js";
import { persistRunningPipelineTrace } from "../observability/trace.js";
import { PipelineHooks } from "../pipeline/pipeline-hooks.js";
import { composeEffectivePipelineContext } from "../pipeline/pipeline-context.js";
import { buildPipelineCheckpointState } from "./pipeline-mcp-checkpoint.js";
import { loadPipelineResumeState } from "./pipeline-mcp-resume.js";
import { finalizePipelineRunResult } from "./pipeline-mcp-finalize.js";
import {
  applyApprovedPipelineWorkspace,
  cleanupPipelineWorkspaceInFinally,
  openPipelineSessionWorkspace,
  recordWorkspaceApplyFailure,
  releasePausedPipelineWorkspace,
} from "./pipeline-mcp-workspace.js";
import type { SessionWorkspace } from "../runtime/workspace.js";
import { PatternCache } from "./pattern-cache.js";
import { getPipelineMemory } from "../memory/pipeline-memory.js";
import type { HistoricalPattern } from "../core/pipeline-run-types.js";

export type PipelineRunParams = PipelineParams & { signal?: AbortSignal };

export async function executePipelineRun(args: PipelineRunParams): Promise<PipelineResult> {
  const baseConfig = loadConfig();
  const currentConfigHash = calculateConfigHash(baseConfig);
  const runtimeConfig = forkPipelineForRun(baseConfig);

  const {
    prompt,
    language,
    context,
    workDir,
    acceptanceCriteria,
    verifyResults,
    sessionId: originalSessionId,
    maxRounds: requestedMaxRounds,
    setPipelineTraceId,
    signal,
    approvalDecision,
    approvalReason,
  } = args;

  const sessionId = originalSessionId ?? (randomUUID() as string);
  let traceId = randomUUID() as string;
  const startTime = Date.now();

  const maxRounds = requestedMaxRounds ?? runtimeConfig.retry?.maxRounds ?? 1;
  const reviewStepName = resolveReviewStepName(runtimeConfig);

  const costTracker = createPipelineCostTracker(runtimeConfig);
  const controlPlane = createControlPlane(runtimeConfig);

  const resumeRequest = {
    mode: "pipeline" as const,
    prompt,
    language,
    context,
    workDir,
    acceptanceCriteria,
    verifyResults,
    configHash: currentConfigHash,
  };
  const resumeMetadata = buildResumeMetadata(resumeRequest);

  const resumeState = await loadPipelineResumeState({
    originalSessionId,
    initialTraceId: traceId,
    approvalDecision,
    approvalReason,
    resumeRequest,
    controlPlane,
    runtimeConfig,
    startTime,
  });
  if (resumeState.earlyResult) {
    return resumeState.earlyResult;
  }

  traceId = resumeState.traceId;
  let stepResults = resumeState.stepResults;
  let candidate = resumeState.candidate;
  let lastReviewFeedback = resumeState.lastReviewFeedback;
  let approved = resumeState.approved;
  let startRound = resumeState.startRound;
  let stepTraces = resumeState.stepTraces;
  let globalKnowledge = resumeState.globalKnowledge;
  let pendingRaceTraceId = resumeState.pendingRaceTraceId;
  let raceCandidates = resumeState.raceCandidates;
  const skipPlanApproval = resumeState.skipPlanApproval;
  const resumedState = resumeState.resumedState;

  if (setPipelineTraceId) setPipelineTraceId(traceId);

  const governance = createExecutionGovernance(runtimeConfig, {
    runStore: controlPlane.runStore,
    runId: traceId,
    eventLog: controlPlane.eventLog,
  });
  const hooks = new PipelineHooks(runtimeConfig, traceId, sessionId, controlPlane.eventLog);
  const { patternContext } = await hooks.onPipelineStart({
    prompt,
    config: runtimeConfig,
    traceId,
    sessionId,
  });
  const effectiveContext = composeEffectivePipelineContext(context, patternContext);

  syncRunStoreFromPipeline(controlPlane.runStore, {
    runId: traceId,
    sessionId,
    round: startRound,
    pipelineStatus: "running",
    resumeToken: sessionId,
  });

  let workspace: SessionWorkspace | null = null;
  let effectiveWorkDir = workDir;
  let lastFinalStatus: PipelineStatus = "running";
  const shouldUseGlobalSessionWorkspace = !!workDir && pipelineUsesGlobalSessionWorkspace(runtimeConfig);

  const runState: MutablePipelineRunState = {
    stepResults,
    stepTraces,
    globalKnowledge,
    candidate,
    approved,
    lastReviewFeedback,
    pendingRaceTraceId,
    raceCandidates,
  };

  const checkpointSnapshot = (currentRound: number, status: PipelineStatus = "running") =>
    buildPipelineCheckpointState({
      sessionId,
      prompt,
      currentRound,
      maxRounds,
      status,
      resumeMetadata,
      traceId,
      candidate: runState.candidate,
      lastReviewFeedback: runState.lastReviewFeedback,
      approved: runState.approved,
      stepResults: runState.stepResults,
      stepTraces: runState.stepTraces,
      globalKnowledge: runState.globalKnowledge,
      runtimePipeline: runtimeConfig.pipeline,
      pendingRaceTraceId: runState.pendingRaceTraceId,
      raceCandidates: runState.raceCandidates,
      workspace,
    });

  try {
    const opened = await openPipelineSessionWorkspace({
      shouldUseGlobalSessionWorkspace,
      workDir,
      resumedState,
      traceId,
    });
    workspace = opened.workspace;
    effectiveWorkDir = opened.effectiveWorkDir ?? workDir;

    const loopResult = await runPipelineExecution({
      runtimeConfig,
      costTracker,
      governance,
      runStore: controlPlane.runStore,
      eventLog: controlPlane.eventLog,
      skipPlanApproval,
      state: runState,
      pipelineSessionId: sessionId,
      startRound,
      maxRounds,
      reviewStepName,
      traceId,
      prompt,
      language,
      context: effectiveContext,
      workDir,
      effectiveWorkDir,
      acceptanceCriteria,
      verifyResults,
      signal,
      onStepComplete: (ctx) => hooks.onStepComplete(ctx),
      onRoundComplete: async (currentRound) => {
        syncRunStoreFromPipeline(controlPlane.runStore, {
          runId: traceId,
          sessionId,
          round: currentRound,
          pipelineStatus: "running",
          resumeToken: sessionId,
        });
        await saveCheckpoint(sessionId, checkpointSnapshot(currentRound));
        const snap = costTracker.getSummary();
        persistRunningPipelineTrace({
          id: traceId,
          sessionId,
          prompt,
          promptLength: prompt.length,
          mode: "pipeline",
          steps: [...runState.stepTraces],
          totalRounds: currentRound,
          finalStatus: "running",
          totalDurationMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          hasVerifyResults: !!verifyResults,
          totalUsage: { promptTokens: snap.totalTokens, completionTokens: 0 },
        });
      },
    });

    let finalStatus = loopResult.finalStatus;
    lastFinalStatus = finalStatus;
    const completedRounds = loopResult.completedRounds;
    const endRound = loopResult.endRound;

    if (finalStatus === "awaiting_plan_approval" && loopResult.pendingExecutionPlan) {
      await saveCheckpoint(sessionId, {
        ...checkpointSnapshot(startRound, "awaiting_plan_approval"),
        pendingExecutionPlan: loopResult.pendingExecutionPlan,
      });
      syncRunStoreFromPipeline(controlPlane.runStore, {
        runId: traceId,
        sessionId,
        round: startRound,
        pipelineStatus: "awaiting_plan_approval",
        resumeToken: sessionId,
      });
      return {
        status: "awaiting_plan_approval",
        rounds: 0,
        totalDurationMs: Date.now() - startTime,
        totalCostUSD: costTracker.getSummary().totalCostUSD,
        checkpointFile: sessionId,
        traceId,
        stepResults: runState.stepResults,
        usage: { promptTokens: 0, completionTokens: 0 },
        costBreakdown: {},
      };
    }

    syncRunStoreFromPipeline(controlPlane.runStore, {
      runId: traceId,
      sessionId,
      round: Math.min(loopResult.endRound, maxRounds),
      pipelineStatus: finalStatus,
      resumeToken: sessionId,
    });

    stepResults = runState.stepResults;
    stepTraces = runState.stepTraces;
    globalKnowledge = runState.globalKnowledge;
    candidate = runState.candidate;
    approved = runState.approved;
    lastReviewFeedback = runState.lastReviewFeedback;
    pendingRaceTraceId = runState.pendingRaceTraceId;
    raceCandidates = runState.raceCandidates;

    if (workspace) {
      const applyResult = await applyApprovedPipelineWorkspace({
        workspace,
        finalStatus,
        runState,
      });
      finalStatus = applyResult.finalStatus;
      lastFinalStatus = finalStatus;
      workspace = applyResult.workspace;

      if ("errorMessage" in applyResult) {
        await saveCheckpoint(sessionId, checkpointSnapshot(Math.min(endRound, maxRounds), finalStatus));
        await recordWorkspaceApplyFailure({
          traceId,
          sessionId,
          prompt,
          verifyResults,
          stepTraces,
          completedRounds,
          startTime,
          costTracker,
          runtimeConfig,
          globalKnowledge,
          eventLog: controlPlane.eventLog,
          controlPlaneMode: controlPlane.mode,
          hooks,
        });
        throw new Error(`Failed to apply approved workspace to source repo: ${applyResult.errorMessage}`);
      }

      if (workspace) {
        await releasePausedPipelineWorkspace(workspace, signal);
      }
    }

    const finalResult = await finalizePipelineRunResult({
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
      runtimeConfig,
      controlPlaneMode: controlPlane.mode,
      eventLog: controlPlane.eventLog,
      hooks,
    });

    await saveCheckpoint(sessionId, checkpointSnapshot(Math.min(endRound, maxRounds), finalStatus));

    // P0: surface evidence-grounded historical patterns at judge-pause time
    if (finalStatus === "awaiting_judge") {
      try {
        const memory = getPipelineMemory();
        const cache = new PatternCache(memory);
        const entries = await cache.matchPatternEntriesAsync(prompt, 5);
        if (entries.length > 0) {
          const patterns: HistoricalPattern[] = entries
            .flatMap((e) => {
              const meta = e.metadata as Record<string, unknown> | undefined;
              const evidenceTraceId = typeof meta?.evidenceTraceId === "string" ? meta.evidenceTraceId : "";
              if (!evidenceTraceId) return [];
              const hp: HistoricalPattern = {
                summary: e.content.slice(0, 200),
                evidenceTraceId,
              };
              if (typeof meta?.winnerProvider === "string") {
                hp.winnerProvider = meta.winnerProvider;
              }
              return [hp];
            });
          if (patterns.length > 0) {
            finalResult.historicalPatterns = patterns;
          }
        }
      } catch {
        // Non-fatal — never delay or block judge response
      }
    }

    return finalResult;
  } finally {
    await cleanupPipelineWorkspaceInFinally({
      workspace,
      signal,
      lastFinalStatus,
      runState,
      stepResults,
    });
  }
}
