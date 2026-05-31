/**
 * Run lifecycle helpers — approval pause / resume (Gate 2.4).
 */

import type { ApprovalResponse } from "./approval.js";
import type { RunState, RunStore } from "./run-store.js";

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
  },
): RunState {
  const existing = store.load(input.runId);
  const now = Date.now();
  const run: RunState = {
    runId: input.runId,
    sessionId: input.sessionId,
    round: input.round,
    status: mapPipelineStatusToRunStatus(input.pipelineStatus),
    messageCursor: existing?.messageCursor ?? 0,
    resumeToken: input.resumeToken ?? input.sessionId,
    pendingApproval: existing?.pendingApproval,
    agentStates: existing?.agentStates,
    metadata: existing?.metadata,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  store.save(run);
  return run;
}
