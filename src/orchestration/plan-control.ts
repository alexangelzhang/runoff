/**
 * Plan-level human approval (Phase 7.8 Phase A) — pause after orchestrator.plan(), before execution.
 */

import type { PipelineConfig } from "../core/config.js";
import type { ExecutionPlan } from "./orchestrator.js";
import type { RunStore, RunState } from "./run-store.js";
import type { ApprovalResponse } from "./approval.js";
import { ApprovalDeferredError, createApprovalGate } from "./approval-adapters.js";
import { ApprovalManager } from "./approval.js";
import { agentId } from "./multi-agent-types.js";
import { pauseRunForApproval } from "./run-control.js";
import type { EventLog } from "./event-log.js";
import { createApprovalAuditSink } from "./approval-audit.js";

export class PipelineAwaitingPlanApprovalError extends Error {
  readonly runId: string;
  readonly plan: ExecutionPlan;

  constructor(runId: string, plan: ExecutionPlan) {
    super(`Pipeline paused for plan approval (${formatPlanSummary(plan)})`);
    this.name = "PipelineAwaitingPlanApprovalError";
    this.runId = runId;
    this.plan = plan;
  }
}

export function formatPlanSummary(plan: ExecutionPlan): string {
  const flat = plan.steps.flatMap((s) => (Array.isArray(s) ? s : [s]));
  return flat.join(" → ");
}

export function requirePlanApproval(config: PipelineConfig): boolean {
  return config.runtime?.governance?.enabled === true && config.runtime.governance.requirePlanApproval === true;
}

export function isPlanApproved(run: RunState | undefined): boolean {
  return run?.metadata?.planApproved === true;
}

export function pauseRunForPlanApproval(
  store: RunStore,
  run: RunState,
  plan: ExecutionPlan,
): void {
  store.save({
    ...run,
    status: "awaiting_approval",
    metadata: {
      ...run.metadata,
      executionPlan: plan,
      approvalPhase: "plan",
    },
    pendingApproval: {
      agentId: agentId("orchestrator"),
      action: "execute_plan",
      description: `Approve execution plan: ${formatPlanSummary(plan)}`,
      requestedAt: Date.now(),
      phase: "plan",
    },
  });
}

export function resumePlanAfterApproval(
  store: RunStore,
  runId: string,
  response: ApprovalResponse,
): RunState | undefined {
  const run = store.load(runId);
  if (!run || run.metadata?.approvalPhase !== "plan") return undefined;

  if (response.decision === "reject") {
    store.save({
      ...run,
      status: "failed",
      pendingApproval: undefined,
      metadata: { ...run.metadata, planRejected: response.reason, approvalPhase: undefined },
    });
  } else {
    store.save({
      ...run,
      status: "running",
      pendingApproval: undefined,
      metadata: {
        ...run.metadata,
        planApproved: true,
        approvalPhase: undefined,
        planModifications: response.decision === "modify" ? response.modifications : undefined,
      },
    });
  }
  return store.load(runId);
}

/**
 * Gate execution until the plan is approved (or auto-approved in approvalMode=auto).
 */
export async function enforcePlanApproval(input: {
  config: PipelineConfig;
  runStore: RunStore;
  runId: string;
  plan: ExecutionPlan;
  eventLog?: EventLog;
}): Promise<void> {
  const run = input.runStore.load(input.runId);
  if (!run) {
    throw new Error(`Run not found for plan approval: ${input.runId}`);
  }
  if (isPlanApproved(run)) return;

  const gate = createApprovalGate(input.config.runtime);
  const audit =
    input.eventLog && input.runId ? createApprovalAuditSink(input.eventLog, input.runId) : undefined;
  const manager = new ApprovalManager(gate, {
    onRequested: audit ? (req) => audit.emitRequested(req, "plan") : undefined,
    onRecord: audit ? (record) => audit.emitResolved(record, "plan") : undefined,
  });
  const approvalMode = input.config.runtime?.governance?.approvalMode ?? "auto";

  try {
    const response = await manager.requestApproval(
      {
        agentId: agentId("orchestrator"),
        action: "execute_plan",
        risk: "medium",
        metadata: { plan: input.plan },
      },
      `Approve pipeline plan: ${formatPlanSummary(input.plan)}`,
      input.plan,
    );
    if (response.decision === "reject") {
      throw new Error(response.reason ?? "Plan rejected by operator");
    }
    input.runStore.save({
      ...run,
      metadata: { ...run.metadata, planApproved: true, executionPlan: input.plan },
    });
  } catch (err: unknown) {
    if (!(err instanceof ApprovalDeferredError)) throw err;
    if (approvalMode !== "defer") throw err;
    const paused = input.runStore.load(input.runId);
    if (paused) {
      input.runStore.save({
        ...paused,
        status: "awaiting_approval",
        metadata: {
          ...paused.metadata,
          executionPlan: input.plan,
          approvalPhase: "plan",
        },
        pendingApproval: {
          agentId: agentId("orchestrator"),
          action: "execute_plan",
          description: `Approve execution plan: ${formatPlanSummary(input.plan)}`,
          requestedAt: err.request.requestedAt,
          requestId: err.request.id,
          phase: "plan",
        },
      });
    } else {
      pauseRunForPlanApproval(input.runStore, run, input.plan);
    }
    throw new PipelineAwaitingPlanApprovalError(input.runId, input.plan);
  }
}
