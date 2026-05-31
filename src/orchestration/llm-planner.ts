/**
 * Phase 8 — External planner LLM for LLMOrchestrator.
 * Optional provider returns JSON execution plan; falls back to policy on parse failure.
 */

import type { PipelineConfig } from "../core/config.js";
import { createProvider } from "../core/config.js";
import type { LLMProvider } from "../providers/types.js";
import { isTextResponse } from "../providers/types.js";
export interface PlannerContext {
  runId: string;
  steps: string[];
  results: Map<string, { stepName: string }>;
  round: number;
  sharedKnowledge: Record<string, string>;
  signal?: AbortSignal;
}

export interface PlannerExecutionPlan {
  steps: Array<string | string[]>;
  maxRounds?: number;
}

export interface PlannerPlanJson {
  steps: Array<string | string[]>;
  maxRounds?: number;
}

export function buildPlannerPrompt(
  context: PlannerContext,
  availableSteps: string[],
): string {
  const knowledge = Object.entries(context.sharedKnowledge)
    .map(([k, v]) => `${k}: ${v.slice(0, 200)}`)
    .join("\n");

  return [
    "You are a pipeline orchestration planner.",
    "Return ONLY valid JSON (no markdown):",
    '{"steps":["stepA","stepB"] or [["parallelA","parallelB"],"stepC"],"maxRounds":4}',
    `Available steps: ${availableSteps.join(", ")}`,
    `Current round: ${context.round}`,
    `Completed: ${[...context.results.keys()].join(", ") || "none"}`,
    knowledge ? `Shared knowledge:\n${knowledge}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function parsePlannerPlanJson(text: string): PlannerPlanJson | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  try {
    const raw = JSON.parse(trimmed.slice(start, end + 1)) as {
      steps?: unknown;
      maxRounds?: unknown;
    };
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) return null;

    const steps: Array<string | string[]> = [];
    for (const s of raw.steps) {
      if (typeof s === "string") {
        steps.push(s);
      } else if (Array.isArray(s) && s.every((x) => typeof x === "string")) {
        steps.push(s as string[]);
      } else {
        return null;
      }
    }

    const maxRounds =
      typeof raw.maxRounds === "number" && raw.maxRounds > 0
        ? Math.floor(raw.maxRounds)
        : undefined;

    return { steps, maxRounds };
  } catch {
    return null;
  }
}

export function plannerJsonToExecutionPlan(json: PlannerPlanJson): PlannerExecutionPlan {
  return {
    steps: json.steps,
    maxRounds: json.maxRounds,
  };
}

export function resolvePlannerProvider(
  config: PipelineConfig,
  plannerProviderName: string,
): LLMProvider | null {
  const pc = config.providers[plannerProviderName];
  if (!pc) return null;
  return createProvider(plannerProviderName, pc);
}

/**
 * Request an execution plan from the configured planner provider.
 * Returns null when provider missing, execution fails, or JSON invalid.
 */
export async function requestLlmExecutionPlan(
  config: PipelineConfig,
  plannerProviderName: string,
  context: PlannerContext,
  availableSteps: string[],
): Promise<PlannerExecutionPlan | null> {
  const provider = resolvePlannerProvider(config, plannerProviderName);
  if (!provider) return null;

  const prompt = buildPlannerPrompt(context, availableSteps);
  const response = await provider.execute({
    prompt,
    stepName: "orchestrator-plan",
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
