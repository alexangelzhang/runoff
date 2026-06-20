/**
 * B8 — Orchestrator-layer step execution entry via AgentRegistry / PipelineStepAgent.
 */

import type { PipelineConfig } from "../core/config.js";
import { agentId } from "./multi-agent-types.js";
import type { AgentRegistry } from "./registry.js";
import { PipelineStepAgent } from "./pipeline-step-agent.js";
import {
  executePipelineStep,
  type SchedulerContext,
  type StepOutcome,
} from "./step-execution.js";

export interface StepRunner {
  executeStep(stepName: string, ctx: SchedulerContext): Promise<StepOutcome>;
}

/** Runs steps via registered PipelineStepAgent instances (full routing/race semantics). */
export class AgentStepRunner implements StepRunner {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly config: PipelineConfig,
  ) {}

  async executeStep(stepName: string, ctx: SchedulerContext): Promise<StepOutcome> {
    const agent = this.registry.get(agentId(stepName));
    if (agent instanceof PipelineStepAgent) {
      return agent.executeWithContext(ctx);
    }
    return executePipelineStep(this.config, stepName, ctx);
  }
}

/** Direct step execution without registry (tests, runoff_run_step-style callers). */
export function createConfigStepRunner(config: PipelineConfig): StepRunner {
  return {
    executeStep: (stepName, ctx) => executePipelineStep(config, stepName, ctx),
  };
}

export function createAgentStepRunner(
  registry: AgentRegistry,
  config: PipelineConfig,
): StepRunner {
  return new AgentStepRunner(registry, config);
}

export function resolveStepRunner(opts: {
  runtimeConfig: PipelineConfig;
  stepRunner?: StepRunner;
  agentRegistry?: AgentRegistry;
}): StepRunner {
  if (opts.stepRunner) return opts.stepRunner;
  if (opts.agentRegistry) {
    return createAgentStepRunner(opts.agentRegistry, opts.runtimeConfig);
  }
  throw new Error("Pipeline DAG loop requires stepRunner or agentRegistry");
}
