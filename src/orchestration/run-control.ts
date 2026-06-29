/**
 * Run lifecycle helpers — approval pause / resume (Gate 2.4).
 */

import type { ApprovalResponse } from "./approval.js";
import type { RunState, RunStore } from "./run-store.js";
import type { ResumeReusePlanReport } from "../core/state.js";

export interface RunResumePlannerSummary {
  round: number;
  rerun: number;
  skipped: number;
  rerunSteps: Array<{
    stepName: string;
    reason: string;
    downstreamOf?: string;
  }>;
  skippedHidden: number;
}

export function summarizeResumeReusePlanForRun(
  report: ResumeReusePlanReport | undefined,
): RunResumePlannerSummary | undefined {
  if (!report) return undefined;
  const rerunEntries = report.entries.filter((entry) => entry.decision === "rerun");
  return {
    round: report.round,
    rerun: report.summary.rerun,
    skipped: report.summary.skipped,
    rerunSteps: rerunEntries.map((entry) => ({
      stepName: entry.stepName,
      reason: entry.reason,
      downstreamOf: entry.downstreamOf,
    })),
    skippedHidden: report.summary.skipped,
  };
}

export function pauseRunForApproval(
  store: RunStore,
  run: RunState,
  pending: NonNullable<RunState["pendingApproval"]>,
): void {
  store.save({
    ...run,
    status: "awaiting_approval",
    pendingApproval: pending,
  });
}

/**
 * Resume a run after human approval. Returns updated state or undefined if not awaiting.
 */
export function resumeRunAfterApproval(
  store: RunStore,
  runId: string,
  response: ApprovalResponse,
): RunState | undefined {
  const run = store.load(runId);
  if (!run || run.status !== "awaiting_approval") return undefined;

  if (response.decision === "reject") {
    store.save({
      ...run,
      status: "failed",
      pendingApproval: undefined,
      metadata: {
        ...run.metadata,
        pipelineStatus: "failed",
        approvalRejected: response.reason,
      },
    });
  } else {
    store.save({
      ...run,
      status: "running",
      pendingApproval: undefined,
      metadata: {
        ...run.metadata,
        pipelineStatus: "running",
        approvalModifications: response.decision === "modify" ? response.modifications : undefined,
      },
    });
  }

  return store.load(runId);
}

export function mapPipelineStatusToRunStatus(
  pipelineStatus: string,
): RunState["status"] {
  switch (pipelineStatus) {
    case "approved":
      return "completed";
    case "failed":
    case "aborted":
      return "failed";
    case "max_rounds":
      return "paused";
    case "needs_clarification":
      return "paused";
    case "awaiting_judge":
    case "awaiting_approval":
    case "awaiting_plan_approval":
      return "paused";
    default:
      return "running";
  }
}

export function syncRunStoreFromPipeline(
  store: RunStore,
  input: {
    runId: string;
    sessionId: string;
    round: number;
    pipelineStatus: string;
    resumeToken?: string;
    resumeReusePlan?: ResumeReusePlanReport;
  },
): RunState {
  const existing = store.load(input.runId);
  const now = Date.now();
  const resumePlanner = summarizeResumeReusePlanForRun(input.resumeReusePlan);
  const run: RunState = {
    runId: input.runId,
    sessionId: input.sessionId,
    round: input.round,
    status: mapPipelineStatusToRunStatus(input.pipelineStatus),
    messageCursor: existing?.messageCursor ?? 0,
    resumeToken: input.resumeToken ?? input.sessionId,
    pendingApproval: existing?.pendingApproval,
    agentStates: existing?.agentStates,
    metadata: {
      ...existing?.metadata,
      pipelineStatus: input.pipelineStatus,
      ...(resumePlanner ? { resumePlanner } : {}),
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  store.save(run);
  return run;
}
