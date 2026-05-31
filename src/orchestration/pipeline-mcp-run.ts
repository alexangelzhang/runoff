/**
 * MCP pipeline run session — checkpoint/resume, workspace, hooks, execution loop.
 * Keeps `src/tools/run-pipeline.ts` thin (tool registration + global timeout only).
 */

import { randomUUID } from "node:crypto";
import { resolveRepoRoot, SessionWorkspace } from "../runtime/workspace.js";
import { loadConfig, calculateConfigHash } from "../core/config.js";
import { forkPipelineForRun, resolveReviewStepName } from "./runtime-pipeline.js";
import { createControlPlane } from "./control-plane.js";
import { createPipelineCostTracker, runPipelineExecution } from "./pipeline-execution.js";
import { createExecutionGovernance } from "./execution-governance.js";
import { resumePlanAfterApproval } from "./plan-control.js";
import { resumeRunAfterApproval, syncRunStoreFromPipeline } from "./run-control.js";
import { enrichTraceWithEventLog } from "./replay.js";
import { emitDeferredApprovalResolved } from "./approval-audit.js";
import { shouldFinalizeAgentWorkspace } from "./workspace-policy.js";
import { applyWorkspaceFromArtifacts, collectRunArtifacts } from "./artifact-workspace.js";
import type { MutablePipelineRunState } from "./pipeline-runner.js";
import {
  saveCheckpoint,
  loadCheckpoint,
  assertResumeCompatible,
  buildResumeMetadata,
  type StepResult,
  type PipelineStatus,
  type PipelineState,
} from "../core/state.js";
import type { PipelineResult, PipelineParams } from "../tools/helpers.js";
import { pipelineUsesGlobalSessionWorkspace } from "../runtime/pipeline-workdir.js";
import {
  recordTrace,
  persistRunningPipelineTrace,
  type PipelineTrace,
  type StepTrace,
} from "../observability/trace.js";
import {
  PipelineHooks,
  composeEffectivePipelineContext,
} from "../pipeline/pipeline-hooks.js";
import { emptyCandidate, getCandidateContent, type Candidate } from "../core/candidate.js";

export type PipelineRunParams = PipelineParams & { signal?: AbortSignal };

function getLatestCandidate(stepResults: Record<string, StepResult>): Candidate {
  const latest = Object.values(stepResults)
    .filter((step) => step.candidateSnapshot)
    .sort((left, right) => (left.round ?? 0) - (right.round ?? 0))
    .pop();
  return latest?.candidateSnapshot ? ({ ...latest.candidateSnapshot } as Candidate) : emptyCandidate();
}

function getResumeStartRound(state: PipelineState): number {
  return state.status === "max_rounds" ? state.round + 1 : state.round;
}

function cloneRaceCandidates(state: PipelineState): PipelineState["raceCandidates"] {
  return state.raceCandidates?.map((candidate) => ({ ...candidate }));
}

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

  let stepResults: Record<string, StepResult> = {};
  let candidate: Candidate = emptyCandidate();
  let lastReviewFeedback = "";
  let approved = false;
  let startRound = 1;
  let stepTraces: StepTrace[] = [];
  let globalKnowledge: Record<string, string> = {};
  let pendingRaceTraceId: string | undefined;
  let raceCandidates: PipelineState["raceCandidates"];
  let resumedState: PipelineState | null = null;
  let skipPlanApproval = false;

  if (originalSessionId) {
    const checkpoint = await loadCheckpoint(originalSessionId);
    if (checkpoint) {
      resumedState = checkpoint;
      if (checkpoint.status === "awaiting_plan_approval" || checkpoint.status === "awaiting_approval") {
        if (!approvalDecision) {
          throw new Error(
            `Checkpoint ${originalSessionId} is awaiting ${checkpoint.status}; pass approvalDecision ("approve" | "reject") to resume`,
          );
        }
        const response =
          approvalDecision === "approve"
            ? ({ decision: "approve" as const })
            : ({ decision: "reject" as const, reason: approvalReason ?? "rejected by operator" });
        const pendingRun = controlPlane.runStore.load(checkpoint.traceId);
        if (pendingRun?.pendingApproval) {
          emitDeferredApprovalResolved(controlPlane.eventLog, checkpoint.traceId, {
            requestId:
              pendingRun.pendingApproval.requestId ??
              `resume-${pendingRun.pendingApproval.requestedAt}`,
            agentId: pendingRun.pendingApproval.agentId,
            action: pendingRun.pendingApproval.action,
            phase:
              pendingRun.pendingApproval.phase ??
              (checkpoint.status === "awaiting_plan_approval" ? "plan" : "action"),
            response,
            respondedBy: "operator",
          });
        }
        const updated =
          checkpoint.status === "awaiting_plan_approval"
            ? resumePlanAfterApproval(controlPlane.runStore, checkpoint.traceId, response)
            : resumeRunAfterApproval(controlPlane.runStore, checkpoint.traceId, response);
        if (!updated || updated.status === "failed") {
          return {
            status: "failed",
            rounds: checkpoint.round,
            totalDurationMs: Date.now() - startTime,
            totalCostUSD: 0,
            checkpointFile: originalSessionId,
            traceId: checkpoint.traceId,
            stepResults: checkpoint.stepResults,
            usage: { promptTokens: 0, completionTokens: 0 },
            costBreakdown: {},
            error: response.decision === "reject" ? response.reason : "Approval resume failed",
          };
        }
        resumedState = { ...checkpoint, status: "running" };
        if (checkpoint.status === "awaiting_plan_approval") {
          skipPlanApproval = true;
        }
      }
      assertResumeCompatible(resumedState, resumeRequest);
      traceId = resumedState.traceId;
      stepResults = resumedState.stepResults;
      candidate = getLatestCandidate(resumedState.stepResults);
      lastReviewFeedback = resumedState.lastReviewFeedback;
      approved = resumedState.approved;
      startRound = getResumeStartRound(resumedState);
      stepTraces = resumedState.stepTraces || [];
      globalKnowledge = resumedState.globalKnowledge || {};
      pendingRaceTraceId = resumedState.pendingRaceTraceId;
      raceCandidates = cloneRaceCandidates(resumedState);
      if (resumedState.dynamicPipeline) {
        Object.assign(runtimeConfig.pipeline, resumedState.dynamicPipeline);
      }
    }
  }

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

  try {
    if (shouldUseGlobalSessionWorkspace) {
      if (resumedState?.workspacePath) {
        workspace = await SessionWorkspace.resume(
          resumedState.workspacePath,
          resumedState.workspaceRepoRoot!,
          resumedState.workspaceBaseRef!,
          traceId,
        );
      } else {
        const repoRoot = (await resolveRepoRoot(workDir)) ?? workDir;
        workspace = await SessionWorkspace.create({ repoRoot, sessionId: traceId });
      }
      effectiveWorkDir = await workspace.resolveWorkDir(workDir);
    }

    const checkpointSnapshot = (currentRound: number, status: PipelineStatus = "running"): PipelineState => ({
      sessionId,
      prompt,
      round: currentRound,
      maxRounds,
      lastCode: getCandidateContent(runState.candidate),
      lastReviewFeedback: runState.lastReviewFeedback,
      approved: runState.approved,
      stepResults: runState.stepResults,
      stepTraces: runState.stepTraces,
      globalKnowledge: runState.globalKnowledge,
      traceId,
      timestamp: new Date().toISOString(),
      status,
      resume: resumeMetadata,
      dynamicPipeline: runtimeConfig.pipeline,
      pendingRaceTraceId: runState.pendingRaceTraceId,
      raceCandidates: runState.raceCandidates?.map((candidateInfo) => ({ ...candidateInfo })),
      ...(workspace
        ? {
            workspacePath: workspace.worktreePath,
            workspaceRepoRoot: workspace.repoRoot,
            workspaceBaseRef: workspace.baseRef,
          }
        : {}),
    });

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

    if (workspace && shouldFinalizeAgentWorkspace(finalStatus)) {
      const finalizeWorkspace = workspace;
      try {
        await applyWorkspaceFromArtifacts(
          finalizeWorkspace,
          collectRunArtifacts({ sharedContext: runState.sharedContext, stepResults: runState.stepResults }),
        );
        await finalizeWorkspace.destroy();
        workspace = null;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        finalStatus = "failed";
        lastFinalStatus = finalStatus;
        try {
          await finalizeWorkspace.releaseLock();
        } catch {
          // best-effort unlock for recovery
        }
        await saveCheckpoint(sessionId, checkpointSnapshot(Math.min(endRound, maxRounds), finalStatus));
        const errorTrace: PipelineTrace = {
          id: traceId,
          prompt,
          promptLength: prompt.length,
          mode: "pipeline",
          steps: stepTraces,
          totalRounds: completedRounds,
          finalStatus,
          totalDurationMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          hasVerifyResults: !!verifyResults,
          totalUsage: { promptTokens: costTracker.getSummary().totalTokens, completionTokens: 0 },
          lifecycle: "final",
        };
        recordTrace(errorTrace);
        hooks.onPipelineFailed({
          trace: errorTrace,
          costTracker,
          config: runtimeConfig,
          eventLog: controlPlane.mode === "file" ? controlPlane.eventLog : undefined,
          runId: traceId,
        });
        throw new Error(`Failed to apply approved workspace to source repo: ${message}`);
      }
    } else if (workspace && !signal?.aborted) {
      try {
        await workspace.releaseLock();
      } catch {
        // best-effort unlock for checkpoint resume / judge follow-up
      }
    }

    const summary = costTracker.getSummary();
    const finalResult: PipelineResult = {
      status: finalStatus,
      rounds: completedRounds,
      totalDurationMs: Date.now() - startTime,
      totalCostUSD: summary.totalCostUSD,
      checkpointFile: sessionId,
      traceId,
      stepResults,
      usage: { promptTokens: summary.totalTokens, completionTokens: 0 },
      costBreakdown: {},
      error: undefined,
    };

    let finalTrace: PipelineTrace = {
      id: traceId,
      prompt,
      promptLength: prompt.length,
      mode: "pipeline",
      steps: stepTraces,
      totalRounds: completedRounds,
      finalStatus,
      totalDurationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      hasVerifyResults: !!verifyResults,
      totalUsage: { promptTokens: summary.totalTokens, completionTokens: 0 },
      lifecycle: "final",
    };
    if (controlPlane.mode === "file") {
      finalTrace = enrichTraceWithEventLog(finalTrace, controlPlane.eventLog, traceId);
    }
    recordTrace(finalTrace);
    if (finalStatus === "failed" || finalStatus === "aborted") {
      hooks.onPipelineFailed({
        trace: finalTrace,
        costTracker,
        config: runtimeConfig,
        eventLog: controlPlane.mode === "file" ? controlPlane.eventLog : undefined,
        runId: traceId,
      });
    } else {
      hooks.onPipelineEnd({
        trace: finalTrace,
        costTracker,
        config: runtimeConfig,
        eventLog: controlPlane.mode === "file" ? controlPlane.eventLog : undefined,
        runId: traceId,
      });
    }

    await saveCheckpoint(sessionId, checkpointSnapshot(Math.min(endRound, maxRounds), finalStatus));
    return finalResult;
  } finally {
    if (workspace) {
      if (signal?.aborted) {
        try {
          await workspace.destroy();
        } catch {
          /* best-effort */
        }
      } else if (shouldFinalizeAgentWorkspace(lastFinalStatus)) {
        try {
          await applyWorkspaceFromArtifacts(
            workspace,
            collectRunArtifacts({ sharedContext: runState.sharedContext, stepResults }),
          );
          await workspace.destroy();
        } catch {
          /* best-effort apply */
        }
      }
    }
  }
}
