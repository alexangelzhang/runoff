import type { AgentConfigEntry, PipelineConfig } from "../core/config.js";
import { normalizeAgentConfig } from "./compat.js";

function clonePipeline(
  pipeline: PipelineConfig["pipeline"],
): PipelineConfig["pipeline"] {
  const next: PipelineConfig["pipeline"] = {};
  for (const [stepName, tuple] of Object.entries(pipeline)) {
    const [provider, ...deps] = tuple;
    next[stepName] = [Array.isArray(provider) ? [...provider] : provider, ...deps];
  }
  return next;
}

function applyAgentProviders(
  pipeline: PipelineConfig["pipeline"],
  agents: Record<string, AgentConfigEntry>,
): PipelineConfig["pipeline"] {
  const next = clonePipeline(pipeline);
  for (const [stepName, tuple] of Object.entries(next)) {
    const [provider, ...deps] = tuple;
    const override = agents[stepName]?.provider;
    next[stepName] = [override ?? provider, ...deps];
  }
  return next;
}

function buildSequentialPipelineFromAgents(
  agents: Record<string, AgentConfigEntry>,
  maxHandoffs?: number,
): PipelineConfig["pipeline"] {
  const stepNames = Object.keys(agents);
  const requiredHandoffs = Math.max(0, stepNames.length - 1);
  if (typeof maxHandoffs === "number" && requiredHandoffs > maxHandoffs) {
    throw new Error(
      `orchestration.maxHandoffs=${maxHandoffs} is too small for ${stepNames.length} configured agents`,
    );
  }

  const pipeline: PipelineConfig["pipeline"] = {};
  stepNames.forEach((stepName, index) => {
    const deps = index === 0 ? [] : [stepNames[index - 1]];
    pipeline[stepName] = [agents[stepName].provider, ...deps];
  });
  return pipeline;
}

export function resolveReviewStepName(config: PipelineConfig): string {
  const explicitReviewer = Object.entries(config.agents ?? {}).find(([, agent]) => agent.role === "reviewer")?.[0];
  return config.retry?.reviewStep ?? explicitReviewer ?? "review";
}

/**
 * Snapshot the pipeline graph for a single run without mutating the cached config from {@link loadConfig}.
 * Dynamic steps and resume merge only touch this copy.
 */
export {
  createPipelineCostTracker,
  runPipelineExecution,
} from "./pipeline-execution.js";
export { createControlPlane, resolveControlPlaneMode } from "./control-plane.js";
export { pauseRunForApproval, resumeRunAfterApproval, syncRunStoreFromPipeline } from "./run-control.js";
export { createExecutionGovernance, defaultGovernanceRules } from "./execution-governance.js";
export { createApprovalGate } from "./approval-adapters.js";
export { enforcePlanApproval, requirePlanApproval, resumePlanAfterApproval } from "./plan-control.js";
export { replayRunFromEventLog, enrichTraceWithEventLog, extractApprovalsFromEventLog } from "./replay.js";
export { evaluatePipelineTrace, compareRegression } from "./harness.js";
export {
  emitRegistryRegistered,
  disposeRegistryTracked,
  summarizeLifecycle,
  lifecycleBalanced,
} from "./agent-lifecycle.js";
export { artifactsFromStepResponse } from "./artifact-bridge.js";
export { SharedContext } from "./shared-context.js";
export {
  resolveMergeStrategy,
  mergeParallelStageBranches,
  candidateFromArtifacts,
} from "./context-integration.js";
export { WorkspaceOwnershipRegistry } from "./ownership.js";
export type { WorkspaceLease, LeaseMode } from "./ownership.js";
export {
  applyWorkspaceFromArtifacts,
  capturePatchArtifactFromWorkspace,
  collectRunArtifacts,
  recordWorkspacePatchInSharedContext,
} from "./artifact-workspace.js";
export type { WorkspaceApplyMethod, WorkspaceApplyResult } from "./artifact-workspace.js";
export type { TraceEvalResult, RegressionTolerance } from "./harness.js";
export {
  createOrchestrator,
  buildExecutionPlanFromPipeline,
  DAGOrchestrator,
  WorkflowOrchestrator,
} from "./orchestrator.js";
export { executeWorkflowParallelStage, useWorkflowAgents } from "./workflow-bridge.js";

export function forkPipelineForRun(base: PipelineConfig): PipelineConfig {
  const normalized = normalizeAgentConfig(base);
  let pipeline = base.agents
    ? applyAgentProviders(base.pipeline, normalized.agents)
    : clonePipeline(base.pipeline);

  if (normalized.orchestration.mode !== "dag") {
    pipeline = buildSequentialPipelineFromAgents(
      normalized.agents,
      normalized.orchestration.maxHandoffs,
    );
  }

  return {
    ...base,
    pipeline,
    agents: normalized.agents,
    orchestration: normalized.orchestration,
  };
}
