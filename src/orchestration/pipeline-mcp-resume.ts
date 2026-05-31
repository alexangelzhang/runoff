/**
 * Checkpoint/resume phase for MCP pipeline runs.
 */

import type { PipelineConfig } from "../core/config.js";
import type { PipelineResult } from "../core/pipeline-run-types.js";
import {
  assertResumeCompatible,
  loadCheckpoint,
  type PipelineState,
  type StepResult,
} from "../core/state.js";
import type { Candidate } from "../core/candidate.js";
import { emptyCandidate } from "../core/candidate.js";
import type { StepTrace } from "../observability/trace.js";
import type { ControlPlane } from "./control-plane.js";
import { resumePlanAfterApproval } from "./plan-control.js";
import { resumeRunAfterApproval } from "./run-control.js";
import { emitDeferredApprovalResolved } from "./approval-audit.js";
import {
  cloneRaceCandidates,
  getLatestCandidate,
  getResumeStartRound,
} from "./pipeline-mcp-checkpoint.js";
import type { ResumeRequest } from "../core/state.js";

export type LoadedPipelineResumeState = {
  resumedState: PipelineState | null;
  traceId: string;
  stepResults: Record<string, StepResult>;
  candidate: Candidate;
  lastReviewFeedback: string;
  approved: boolean;
  startRound: number;
  stepTraces: StepTrace[];
  globalKnowledge: Record<string, string>;
  pendingRaceTraceId: string | undefined;
  raceCandidates: PipelineState["raceCandidates"];
  skipPlanApproval: boolean;
  /** Set when approval resume fails and the run should return immediately. */
  earlyResult?: PipelineResult;
};

export async function loadPipelineResumeState(args: {
  originalSessionId?: string;
  initialTraceId: string;
  approvalDecision?: "approve" | "reject";
  approvalReason?: string;
  resumeRequest: ResumeRequest;
  controlPlane: ControlPlane;
  runtimeConfig: PipelineConfig;
  startTime: number;
}): Promise<LoadedPipelineResumeState> {
  const {
    originalSessionId,
    initialTraceId,
    approvalDecision,
    approvalReason,
    resumeRequest,
    controlPlane,
    runtimeConfig,
    startTime,
  } = args;

  let traceId = initialTraceId;
  let stepResults: Record<string, StepResult> = {};
  let candidate = emptyCandidate();
  let lastReviewFeedback = "";
  let approved = false;
  let startRound = 1;
  let stepTraces: StepTrace[] = [];
  let globalKnowledge: Record<string, string> = {};
  let pendingRaceTraceId: string | undefined;
  let raceCandidates: PipelineState["raceCandidates"];
  let resumedState: PipelineState | null = null;
  let skipPlanApproval = false;
  let earlyResult: PipelineResult | undefined;

  if (!originalSessionId) {
    return {
      resumedState,
      traceId,
      stepResults,
      candidate,
      lastReviewFeedback,
      approved,
      startRound,
      stepTraces,
      globalKnowledge,
      pendingRaceTraceId,
      raceCandidates,
      skipPlanApproval,
    };
  }

  const checkpoint = await loadCheckpoint(originalSessionId);
  if (!checkpoint) {
    return {
      resumedState,
      traceId,
      stepResults,
      candidate,
      lastReviewFeedback,
      approved,
      startRound,
      stepTraces,
      globalKnowledge,
      pendingRaceTraceId,
      raceCandidates,
      skipPlanApproval,
    };
  }

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
      earlyResult = {
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
    } else {
      resumedState = { ...checkpoint, status: "running" };
      if (checkpoint.status === "awaiting_plan_approval") {
        skipPlanApproval = true;
      }
    }
  }

  if (!earlyResult && resumedState) {
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
    raceCandidates = cloneRaceCandidates(resumedState.raceCandidates);
    if (resumedState.dynamicPipeline) {
      Object.assign(runtimeConfig.pipeline, resumedState.dynamicPipeline);
    }
  }

  return {
    resumedState,
    traceId,
    stepResults,
    candidate,
    lastReviewFeedback,
    approved,
    startRound,
    stepTraces,
    globalKnowledge,
    pendingRaceTraceId,
    raceCandidates,
    skipPlanApproval,
    earlyResult,
  };
}
