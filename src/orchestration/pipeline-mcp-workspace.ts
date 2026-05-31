/**
 * Workspace lifecycle for MCP pipeline runs.
 */

import { resolveRepoRoot, SessionWorkspace } from "../runtime/workspace.js";
import type { PipelineState, PipelineStatus } from "../core/state.js";
import type { MutablePipelineRunState } from "./pipeline-runner.js";
import { shouldFinalizeAgentWorkspace } from "./workspace-policy.js";
import { applyWorkspaceFromArtifacts, collectRunArtifacts } from "./artifact-workspace.js";
import type { StepResult } from "../core/state.js";
import type { PipelineConfig } from "../core/config.js";
import type { PipelineCostAccumulator } from "../routing/pricing.js";
import type { PipelineTrace } from "../observability/trace.js";
import { recordTrace } from "../observability/trace.js";
import type { PipelineHooks } from "../pipeline/pipeline-hooks.js";

export async function openPipelineSessionWorkspace(args: {
  shouldUseGlobalSessionWorkspace: boolean;
  workDir?: string;
  resumedState: PipelineState | null;
  traceId: string;
}): Promise<{ workspace: SessionWorkspace | null; effectiveWorkDir?: string }> {
  const { shouldUseGlobalSessionWorkspace, workDir, resumedState, traceId } = args;
  if (!shouldUseGlobalSessionWorkspace || !workDir) {
    return { workspace: null, effectiveWorkDir: workDir };
  }

  let workspace: SessionWorkspace;
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
  const effectiveWorkDir = await workspace.resolveWorkDir(workDir);
  return { workspace, effectiveWorkDir };
}

export type WorkspaceApplyFailure = {
  finalStatus: "failed";
  workspace: SessionWorkspace;
  errorMessage: string;
};

export type WorkspaceApplyResult =
  | WorkspaceApplyFailure
  | { finalStatus: PipelineStatus; workspace: SessionWorkspace | null };

export async function applyApprovedPipelineWorkspace(args: {
  workspace: SessionWorkspace;
  finalStatus: PipelineStatus;
  runState: MutablePipelineRunState;
}): Promise<WorkspaceApplyResult> {
  const { workspace, finalStatus, runState } = args;
  if (!shouldFinalizeAgentWorkspace(finalStatus)) {
    return { finalStatus, workspace };
  }

  const finalizeWorkspace = workspace;
  try {
    await applyWorkspaceFromArtifacts(
      finalizeWorkspace,
      collectRunArtifacts({ sharedContext: runState.sharedContext, stepResults: runState.stepResults }),
    );
    await finalizeWorkspace.destroy();
    return { finalStatus, workspace: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await finalizeWorkspace.releaseLock();
    } catch {
      // best-effort unlock for recovery
    }
    return { finalStatus: "failed", workspace: finalizeWorkspace, errorMessage: message };
  }
}

export async function recordWorkspaceApplyFailure(args: {
  traceId: string;
  sessionId: string;
  prompt: string;
  verifyResults?: string;
  stepTraces: PipelineTrace["steps"];
  completedRounds: number;
  startTime: number;
  costTracker: PipelineCostAccumulator;
  runtimeConfig: PipelineConfig;
  globalKnowledge: Record<string, string>;
  eventLog?: import("./event-log.js").EventLog;
  controlPlaneMode: "memory" | "file";
  hooks: PipelineHooks;
}): Promise<void> {
  const {
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
    eventLog,
    controlPlaneMode,
    hooks,
  } = args;

  const errorTrace: PipelineTrace = {
    id: traceId,
    sessionId,
    prompt,
    promptLength: prompt.length,
    mode: "pipeline",
    steps: stepTraces,
    totalRounds: completedRounds,
    finalStatus: "failed",
    totalDurationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
    hasVerifyResults: !!verifyResults,
    totalUsage: { promptTokens: costTracker.getSummary().totalTokens, completionTokens: 0 },
    lifecycle: "final",
  };
  recordTrace(errorTrace);
  await hooks.onPipelineFailed({
    trace: errorTrace,
    costTracker,
    config: runtimeConfig,
    eventLog: controlPlaneMode === "file" ? eventLog : undefined,
    runId: traceId,
    globalKnowledge,
  });
}

export async function releasePausedPipelineWorkspace(
  workspace: SessionWorkspace,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  try {
    await workspace.releaseLock();
  } catch {
    // best-effort unlock for checkpoint resume / judge follow-up
  }
}

export async function cleanupPipelineWorkspaceInFinally(args: {
  workspace: SessionWorkspace | null;
  signal?: AbortSignal;
  lastFinalStatus: PipelineStatus;
  runState: MutablePipelineRunState;
  stepResults: Record<string, StepResult>;
}): Promise<void> {
  const { workspace, signal, lastFinalStatus, runState, stepResults } = args;
  if (!workspace) return;

  if (signal?.aborted) {
    try {
      await workspace.destroy();
    } catch {
      /* best-effort */
    }
    return;
  }

  if (shouldFinalizeAgentWorkspace(lastFinalStatus)) {
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
