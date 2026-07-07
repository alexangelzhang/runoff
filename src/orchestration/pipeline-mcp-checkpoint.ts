/**
 * Checkpoint / resume helpers for MCP pipeline runs.
 */

import type { PipelineConfig } from "../core/config.js";
import { getCandidateContent, emptyCandidate, type Candidate } from "../core/candidate.js";
import type {
  StepResult,
  PipelineState,
  PipelineStatus,
  ResumeReusePlanReport,
  ScopePreflightReport,
} from "../core/state.js";
import type { StepTrace } from "../observability/trace.js";
import type { SessionWorkspace } from "../runtime/workspace.js";
import type { ResumeMetadata } from "../core/state.js";

export function getLatestCandidate(stepResults: Record<string, StepResult>): Candidate {
  const latest = Object.values(stepResults)
    .filter((step) => step.candidateSnapshot)
    .sort((left, right) => (left.round ?? 0) - (right.round ?? 0))
    .pop();
  return latest?.candidateSnapshot ? ({ ...latest.candidateSnapshot } as Candidate) : emptyCandidate();
}

export function getResumeStartRound(state: PipelineState): number {
  return state.status === "max_rounds" ? state.round + 1 : state.round;
}

export function cloneRaceCandidates(
  raceCandidates: PipelineState["raceCandidates"],
): PipelineState["raceCandidates"] {
  return raceCandidates?.map((candidate) => ({ ...candidate }));
}

export function buildPipelineCheckpointState(args: {
  sessionId: string;
  prompt: string;
  currentRound: number;
  maxRounds: number;
  status?: PipelineStatus;
  resumeMetadata: ResumeMetadata;
  traceId: string;
  candidate: Candidate;
  lastReviewFeedback: string;
  approved: boolean;
  stepResults: Record<string, StepResult>;
  stepTraces: StepTrace[];
  globalKnowledge: Record<string, string>;
  runtimePipeline: PipelineConfig["pipeline"];
  pendingRaceTraceId?: string;
  raceCandidates?: PipelineState["raceCandidates"];
  workspace?: SessionWorkspace | null;
  scopePreflight?: ScopePreflightReport;
  resumeReusePlan?: ResumeReusePlanReport;
  completionContract?: import("../core/state.js").CompletionContract;
  pendingExecutionPlan?: PipelineState["pendingExecutionPlan"];
}): PipelineState {
  const {
    sessionId,
    prompt,
    currentRound,
    maxRounds,
    status = "running",
    resumeMetadata,
    traceId,
    candidate,
    lastReviewFeedback,
    approved,
    stepResults,
    stepTraces,
    globalKnowledge,
    runtimePipeline,
    pendingRaceTraceId,
    raceCandidates,
    workspace,
    scopePreflight,
    resumeReusePlan,
    pendingExecutionPlan,
    completionContract,
  } = args;

  return {
    sessionId,
    prompt,
    round: currentRound,
    maxRounds,
    lastCode: getCandidateContent(candidate),
    lastReviewFeedback,
    approved,
    stepResults,
    stepTraces,
    globalKnowledge,
    traceId,
    timestamp: new Date().toISOString(),
    status,
    resume: resumeMetadata,
    dynamicPipeline: runtimePipeline,
    pendingRaceTraceId,
    raceCandidates: raceCandidates?.map((candidateInfo) => ({ ...candidateInfo })),
    scopePreflight,
    resumeReusePlan,
    ...(completionContract ? { completionContract } : {}),
    ...(pendingExecutionPlan ? { pendingExecutionPlan } : {}),
    ...(workspace
      ? {
          workspacePath: workspace.worktreePath,
          workspaceRepoRoot: workspace.repoRoot,
          workspaceBaseRef: workspace.baseRef,
        }
      : {}),
  };
}
