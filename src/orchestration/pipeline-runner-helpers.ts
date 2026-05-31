/**
 * Helpers for pipeline-runner DAG loop (step outcomes, stage resolution).
 */
import type { PipelineConfig } from "../core/config.js";
import { getDagStages } from "../core/config.js";
import type { StepResult } from "../core/state.js";
import type { StepOutcome } from "./step-execution.js";
import type { AgentResult } from "./agent.js";
import { agentId } from "./multi-agent-types.js";
import {
  agentGraphToStages,
  type AgentGraph,
} from "./agent-graph.js";
import type { ExecutionPlan } from "./orchestrator.js";
import { executionPlanToStages } from "./plan-scheduler.js";

export function failedStepOutcome(stepName: string, round: number, error: string): StepOutcome {
  return {
    stepName,
    usedProvider: "governance",
    upgraded: false,
    durationMs: 0,
    trace: { name: stepName, provider: "governance", durationMs: 0, round, error },
    response: {
      kind: "text",
      model: "governance",
      content: "",
      code: "",
      explanation: "",
      failed: true,
      error,
    },
  };
}

export function outcomeToAgentResult(outcome: StepOutcome): AgentResult {
  return {
    agentId: agentId(outcome.stepName),
    stepName: outcome.stepName,
    response: outcome.response,
    durationMs: outcome.durationMs,
  };
}

export function isStepCompletedForRound(
  stepResults: Record<string, StepResult>,
  stepName: string,
  round: number,
): boolean {
  const result = stepResults[stepName];
  if (!result || result.round !== round) return false;
  return result.status === "success" || result.status === "skipped";
}

export function resolvePipelineStages(
  runtimeConfig: PipelineConfig,
  executionPlan?: ExecutionPlan,
  agentGraph?: AgentGraph,
): string[][] {
  if (agentGraph) return agentGraphToStages(agentGraph);
  if (executionPlan) return executionPlanToStages(executionPlan);
  return getDagStages(runtimeConfig);
}
