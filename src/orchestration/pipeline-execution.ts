/**
 * Pipeline execution entry — orchestrator plan gate + AgentRegistry-wrapped DAG loop.
 */

import type { PipelineConfig } from "../core/config.js";
import { CostGovernor, CostTracker } from "../routing/pricing.js";
import type { PipelineStatus } from "../core/state.js";
import { compileAgentGraphFromPipeline } from "./agent-graph.js";
import { createOrchestrator } from "./orchestrator.js";
import { createAgentStepRunner } from "./step-runner.js";
import type { ExecutionPlan, OrchestrationContext, Orchestrator } from "./orchestrator.js";
import { AgentRegistry } from "./registry.js";
import type { RunStore } from "./run-store.js";
import {
  runPipelineDAGLoop,
  type PipelineDAGLoopOptions,
} from "./pipeline-runner.js";
import { agentId } from "./multi-agent-types.js";
import {
  enforcePlanApproval,
  isPlanApproved,
  PipelineAwaitingPlanApprovalError,
  requirePlanApproval,
} from "./plan-control.js";
import { resolveReviewStepName } from "./runtime-pipeline.js";
import type { EventLog } from "./event-log.js";
import { OrchestrationEventEmitter } from "./events.js";
import { disposeRegistryTracked, emitRegistryRegistered } from "./agent-lifecycle.js";
import { buildAgentToolRegistry, type AgentToolRegistry } from "./agent-tools.js";
import { normalizeAgentConfig } from "./compat.js";
import { logger } from "../core/logger.js";

export function createPipelineCostTracker(config: PipelineConfig): CostTracker | CostGovernor {
  const budget = config.runtime?.costBudgetUSD;
  if (typeof budget === "number" && budget > 0) {
    return new CostGovernor(budget);
  }
  return new CostTracker();
}

export type PipelineExecutionOptions = PipelineDAGLoopOptions & {
  runtimeConfig: PipelineConfig;
  runStore?: RunStore;
  eventLog?: EventLog;
  /** Skip plan gate when resuming after plan was approved. */
  skipPlanApproval?: boolean;
  /** Populated when `orchestration.useAgentTools` is true. */
  agentTools?: AgentToolRegistry;
};

export type PlanGateResult = {
  finalStatus: PipelineStatus;
  completedRounds: number;
  endRound: number;
  pendingExecutionPlan?: ExecutionPlan;
};

function buildOrchestrationContext(opts: PipelineExecutionOptions): OrchestrationContext {
  const steps = Object.keys(opts.runtimeConfig.pipeline);
  const assignments = new Map<string, ReturnType<typeof agentId>>();
  for (const step of steps) {
    assignments.set(step, agentId(step));
  }
  return {
    runId: opts.traceId,
    sessionId: opts.pipelineSessionId,
    steps,
    assignments,
    results: new Map(),
    round: opts.startRound,
    sharedKnowledge: { ...opts.state.globalKnowledge },
    signal: opts.signal,
    agentGraph: compileAgentGraphFromPipeline(opts.runtimeConfig.pipeline),
  };
}

function bootstrapRegistry(config: PipelineConfig, reviewStepName: string): AgentRegistry {
  return AgentRegistry.fromPipelineSteps(config, reviewStepName);
}

export type ExecutionResolvedPlan = {
  plan: ExecutionPlan;
  orchestrator: Orchestrator;
  context: OrchestrationContext;
};

export type ResolvedPlan = PlanGateResult | ExecutionResolvedPlan;

function isExecutionResolvedPlan(resolved: ResolvedPlan): resolved is ExecutionResolvedPlan {
  return "orchestrator" in resolved;
}

async function createAndGatePlan(opts: PipelineExecutionOptions): Promise<ResolvedPlan> {
  const reviewStepName = opts.reviewStepName ?? resolveReviewStepName(opts.runtimeConfig);
  const orchestrator = createOrchestrator(opts.runtimeConfig);
  const context = buildOrchestrationContext(opts);
  const plan = await orchestrator.plan(context);

  if (opts.eventLog) {
    try {
      const emitter = new OrchestrationEventEmitter(opts.eventLog, opts.traceId);
      emitter.planCreated(agentId("orchestrator"), plan.steps);
    } catch {
      // non-critical
    }
  }

  const resolved = { plan, orchestrator, context };

  if (!requirePlanApproval(opts.runtimeConfig) || opts.skipPlanApproval) {
    return resolved;
  }

  const store = opts.runStore;
  if (!store) {
    return resolved;
  }

  const run = store.load(opts.traceId);
  if (isPlanApproved(run)) {
    return resolved;
  }

  try {
    await enforcePlanApproval({
      config: opts.runtimeConfig,
      runStore: store,
      runId: opts.traceId,
      plan,
      eventLog: opts.eventLog,
    });
    return resolved;
  } catch (err: unknown) {
    if (err instanceof PipelineAwaitingPlanApprovalError) {
      return {
        finalStatus: "awaiting_plan_approval",
        completedRounds: 0,
        endRound: opts.startRound,
        pendingExecutionPlan: err.plan,
      };
    }
    throw err;
  }
}

export async function runPipelineOrchestratorLoop(
  opts: PipelineExecutionOptions,
): Promise<{ finalStatus: PipelineStatus; completedRounds: number; endRound: number }> {
  const reviewStepName = opts.reviewStepName ?? resolveReviewStepName(opts.runtimeConfig);
  const registry = bootstrapRegistry(opts.runtimeConfig, reviewStepName);
  if (opts.eventLog) {
    emitRegistryRegistered(registry, opts.eventLog, opts.traceId);
  }
  const stepRunner = opts.stepRunner ?? createAgentStepRunner(registry, opts.runtimeConfig);
  try {
    return await runPipelineDAGLoop({
      ...opts,
      agentRegistry: registry,
      stepRunner,
    });
  } finally {
    if (opts.eventLog) {
      disposeRegistryTracked(registry, opts.eventLog, opts.traceId);
    } else {
      registry.disposeAll();
    }
  }
}

export async function runPipelineExecution(
  opts: PipelineExecutionOptions,
): Promise<{ finalStatus: PipelineStatus; completedRounds: number; endRound: number; pendingExecutionPlan?: ExecutionPlan }> {
  const resolved = await createAndGatePlan(opts);
  if (!isExecutionResolvedPlan(resolved)) {
    return resolved;
  }

  const { plan, orchestrator, context } = resolved;
  const registry = bootstrapRegistry(opts.runtimeConfig, opts.reviewStepName ?? resolveReviewStepName(opts.runtimeConfig));
  const stepRunner = opts.stepRunner ?? createAgentStepRunner(registry, opts.runtimeConfig);
  const loopOpts: PipelineExecutionOptions = {
    ...opts,
    agentRegistry: registry,
    executionPlan: plan,
    agentGraph: context.agentGraph,
    orchestrator,
    orchestrationContext: context,
    stepRunner,
    eventLog: opts.eventLog,
  };
  if (opts.runtimeConfig.orchestration?.useAgentTools) {
    const normalized = normalizeAgentConfig(opts.runtimeConfig);
    loopOpts.agentTools = buildAgentToolRegistry(registry, normalized.agents);
    logger.info(
      "orchestrator",
      `Agent-as-tool registry ready (${loopOpts.agentTools.size} tools)`,
    );
  }
  if (opts.eventLog) {
    emitRegistryRegistered(registry, opts.eventLog, opts.traceId);
  }
  try {
    return await runPipelineDAGLoop(loopOpts);
  } finally {
    if (opts.eventLog) {
      disposeRegistryTracked(registry, opts.eventLog, opts.traceId);
    } else {
      registry.disposeAll();
    }
  }
}
