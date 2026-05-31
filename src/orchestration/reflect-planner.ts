/**
 * DeerFlow-style reflect → re-plan (narrow MVP).
 * Invoked only on review revision or step failure — not every step.
 */

import type { PipelineConfig } from "../core/config.js";
import { createProvider } from "../core/config.js";
import type { LLMProvider } from "../providers/types.js";
import { isTextResponse } from "../providers/types.js";
import {
  parsePlannerPlanJson,
  plannerJsonToExecutionPlan,
  type PlannerContext,
  type PlannerExecutionPlan,
} from "./llm-planner.js";

export type ReflectTrigger = "review_revision" | "step_failure";

export type ReflectReplanDetails = {
  focusStep?: string;
  errorMessage?: string;
  reviewFeedback?: string;
};

export interface ReflectContext extends PlannerContext {
  trigger: ReflectTrigger;
  /** Step that failed or review step that rejected. */
  focusStep?: string;
  errorMessage?: string;
  reviewFeedback?: string;
}

export function buildReflectPrompt(
  context: ReflectContext,
  availableSteps: string[],
): string {
  const knowledge = Object.entries(context.sharedKnowledge)
    .map(([k, v]) => `${k}: ${v.slice(0, 200)}`)
    .join("\n");

  return [
    "You are a pipeline orchestration reflector.",
    "The previous execution wave did not succeed. Propose a revised step order using ONLY listed steps.",
    'Return ONLY valid JSON: {"steps":["stepA","stepB"] or [["parallelA","parallelB"],"stepC"],"maxRounds":4}',
    `Trigger: ${context.trigger}`,
    context.focusStep ? `Focus step: ${context.focusStep}` : "",
    context.errorMessage ? `Error: ${context.errorMessage.slice(0, 500)}` : "",
    context.reviewFeedback
      ? `Review feedback: ${context.reviewFeedback.slice(0, 500)}`
      : "",
    `Available steps: ${availableSteps.join(", ")}`,
    `Current round: ${context.round}`,
    `Completed: ${[...context.results.keys()].join(", ") || "none"}`,
    knowledge ? `Shared knowledge:\n${knowledge}` : "",
    context.trigger === "review_revision"
      ? "Prefer re-running implement/code steps before review."
      : "Prefer retrying the failed step after any prerequisite steps.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function resolveReflectProvider(
  config: PipelineConfig,
  providerName: string,
): LLMProvider | null {
  const pc = config.providers[providerName];
  if (!pc) return null;
  return createProvider(providerName, pc);
}

export function resolveReflectProviderName(config: PipelineConfig): string | undefined {
  const reflect = config.orchestration?.reflect;
  if (!reflect?.enabled) return undefined;
  return reflect.provider ?? config.orchestration?.plannerProvider;
}

/**
 * Request a revised execution plan from the reflect provider.
 * Returns null when provider missing, execution fails, or JSON invalid.
 */
export async function requestReflectExecutionPlan(
  config: PipelineConfig,
  providerName: string,
  context: ReflectContext,
  availableSteps: string[],
): Promise<PlannerExecutionPlan | null> {
  const provider = resolveReflectProvider(config, providerName);
  if (!provider) return null;

  const prompt = buildReflectPrompt(context, availableSteps);
  const response = await provider.execute({
    prompt,
    stepName: "orchestrator-reflect",
    round: context.round,
    signal: context.signal,
  });

  if (response.failed) return null;

  const text = isTextResponse(response)
    ? response.content
    : response.summary ?? "";

  const parsed = parsePlannerPlanJson(text);
  if (!parsed) return null;

  const allowed = new Set(availableSteps);
  for (const step of parsed.steps) {
    const names = Array.isArray(step) ? step : [step];
    if (!names.every((n) => allowed.has(n))) return null;
  }

  return plannerJsonToExecutionPlan(parsed);
}
