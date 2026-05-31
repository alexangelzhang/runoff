/**
 * Backlog B3 — Drive DAG waves from Orchestrator ExecutionPlan (not getDagStages cache).
 */

import type { ExecutionPlan } from "./orchestrator.js";

/** Convert orchestrator plan steps to pipeline-runner stage waves. */
export function executionPlanToStages(plan: ExecutionPlan): string[][] {
  return plan.steps.map((step) => (typeof step === "string" ? [step] : [...step]));
}

/** Flat ordered step names from a plan. */
export function flattenExecutionPlan(plan: ExecutionPlan): string[] {
  const out: string[] = [];
  for (const step of plan.steps) {
    if (typeof step === "string") out.push(step);
    else out.push(...step);
  }
  return out;
}

/** Append a dynamically injected step to the active plan. */
export function appendStepToExecutionPlan(plan: ExecutionPlan, stepName: string): void {
  plan.steps.push(stepName);
}
