/**
 * Reflect → re-plan wiring (DeerFlow narrow MVP).
 */

import type { PipelineConfig } from "../core/config.js";
import type { EventLog } from "./event-log.js";
import { OrchestrationEventEmitter } from "./events.js";
import {
  applyExecutionPlanToAgentGraph,
  syncExecutionPlanFromAgentGraph,
  type AgentGraph,
} from "./agent-graph.js";
import { agentId } from "./multi-agent-types.js";
import type { ExecutionPlan, OrchestrationContext, Orchestrator } from "./orchestrator.js";
import { LLMOrchestrator } from "./orchestrator.js";
import type { ReflectReplanDetails, ReflectTrigger } from "./reflect-planner.js";

export type { ReflectReplanDetails, ReflectTrigger } from "./reflect-planner.js";

export function isReflectEnabled(config: PipelineConfig): boolean {
  return (
    config.orchestration?.mode === "llm-driven" &&
    config.orchestration?.reflect?.enabled === true
  );
}

export function shouldReflectOnTrigger(
  config: PipelineConfig,
  trigger: ReflectTrigger,
): boolean {
  if (!isReflectEnabled(config)) return false;
  const r = config.orchestration!.reflect!;
  if (trigger === "review_revision") return r.onReviewRevision !== false;
  if (trigger === "step_failure") return r.onStepFailure !== false;
  return false;
}

export function orchestratorSupportsReflect(
  orchestrator: Orchestrator,
): orchestrator is LLMOrchestrator {
  return orchestrator instanceof LLMOrchestrator;
}

/** Apply reflect re-plan to runtime graph + execution plan; emit plan_revision when event log present. */
export async function applyReflectReplan(args: {
  config: PipelineConfig;
  orchestrator: Orchestrator;
  context: OrchestrationContext;
  executionPlan: ExecutionPlan;
  agentGraph: AgentGraph;
  trigger: ReflectTrigger;
  details?: ReflectReplanDetails;
  eventLog?: EventLog;
  traceId?: string;
}): Promise<boolean> {
  if (!shouldReflectOnTrigger(args.config, args.trigger)) return false;
  if (!orchestratorSupportsReflect(args.orchestrator)) return false;

  const revised = await args.orchestrator.reflectAndReplan(
    args.context,
    args.trigger,
    args.details ?? {},
  );
  if (!revised) return false;

  applyExecutionPlanToAgentGraph(args.agentGraph, revised);
  syncExecutionPlanFromAgentGraph(args.executionPlan, args.agentGraph);

  if (args.eventLog && args.traceId) {
    try {
      const emitter = new OrchestrationEventEmitter(args.eventLog, args.traceId);
      emitter.planRevision(agentId("orchestrator"), revised.steps, args.trigger);
    } catch {
      // non-critical
    }
  }

  return true;
}
