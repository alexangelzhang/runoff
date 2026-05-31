/**
 * Orchestrator Interface + DAG Orchestrator (Wave 7.3).
 *
 * Replaces hardcoded DAG traversal with a programmable orchestrator.
 * OODA loop: observe → orient → decide → act.
 *
 * DAGOrchestrator is the default, backward-compatible implementation
 * that behaves equivalently to the current run-pipeline.ts for loop.
 */

import type { PipelineConfig } from "../core/config.js";
import { parseVerdict } from "../core/verdict.js";
import { isTextResponse } from "../providers/types.js";
import {
  classifyOrchestratorFailure,
  describeRetryStrategy,
  type FailureReason,
} from "../routing/retry-strategy.js";
import {
  agentGraphToExecutionPlan,
  applyExecutionPlanToAgentGraph,
  compileAgentGraphFromPipeline,
  type AgentGraph,
} from "./agent-graph.js";
import { requestLlmExecutionPlan, type PlannerContext } from "./llm-planner.js";
import {
  requestReflectExecutionPlan,
  resolveReflectProviderName,
  type ReflectTrigger,
} from "./reflect-planner.js";
import type { ReflectReplanDetails } from "./reflect-planner.js";
import type { AgentId } from "./multi-agent-types.js";
import { agentId } from "./multi-agent-types.js";
import type { AgentTask, AgentResult } from "./agent.js";

// --- Orchestration Context ---

export interface OrchestrationContext {
  runId: string;
  sessionId: string;
  /** Ordered list of step names from the pipeline config. */
  steps: string[];
  /** Map of step name → assigned agent id. */
  assignments: Map<string, AgentId>;
  /** Results collected so far (step name → result). */
  results: Map<string, AgentResult>;
  /** Current round number. */
  round: number;
  /** Shared knowledge accumulated across agents. */
  sharedKnowledge: Record<string, string>;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** B7: compiled runtime topology (waves drive staging when set). */
  agentGraph?: AgentGraph;
}

// --- Execution Plan ---

export interface ExecutionPlan {
  /** Steps to execute, in order. Nested arrays = parallel. */
  steps: Array<string | string[]>;
  /** Optional: max rounds before forced termination. */
  maxRounds?: number;
}

// --- Next Action (after step completes) ---

export type NextAction =
  | { type: "continue"; nextSteps: string[] }
  | { type: "delegate"; agentId: AgentId; task: AgentTask }
  | { type: "handoff"; from: AgentId; to: AgentId; reason?: string }
  | { type: "retry"; stepName: string; withAgent: AgentId }
  | { type: "done"; success: boolean; reason?: string };

// --- Recovery Action (after step fails) ---

export type RecoveryAction =
  | { type: "retry"; stepName: string; withAgent?: AgentId; maxRetries?: number }
  | { type: "skip"; stepName: string; reason: string }
  | { type: "abort"; reason: string }
  | { type: "fallback"; stepName: string; fallbackAgent: AgentId };

// --- Step Error ---

export interface StepError {
  stepName: string;
  agentId: AgentId;
  error: Error;
  attempt: number;
}

// --- Orchestrator Interface ---

export interface Orchestrator {
  /** Create an execution plan from the context. */
  plan(context: OrchestrationContext): Promise<ExecutionPlan>;
  /** Decide what to do after a step completes successfully. */
  onStepComplete(context: OrchestrationContext, result: AgentResult): Promise<NextAction>;
  /** Decide how to recover from a step failure. */
  onStepFailed(context: OrchestrationContext, error: StepError): Promise<RecoveryAction>;
}

// --- DAG Orchestrator (default, backward-compatible) ---

/**
 * Executes steps in the order defined by the pipeline config.
 * Equivalent to the current run-pipeline.ts for loop.
 * No LLM overhead — pure deterministic traversal.
 */
/** Build plan steps from pipeline DAG stages (nested array = parallel wave). */
export function buildExecutionPlanFromPipeline(
  pipeline: PipelineConfig["pipeline"],
  maxRounds?: number,
): ExecutionPlan {
  return agentGraphToExecutionPlan(compileAgentGraphFromPipeline(pipeline), maxRounds);
}

export function createOrchestrator(config: PipelineConfig): Orchestrator {
  const mode = config.orchestration?.mode ?? "dag";
  const maxRetries = config.retry?.maxRounds ?? 1;
  if (mode === "llm-driven") return new LLMOrchestrator(config, maxRetries);
  if (mode === "workflow") return new WorkflowOrchestrator(config.pipeline, maxRetries);
  return new DAGOrchestrator(config.pipeline, maxRetries);
}

export class DAGOrchestrator implements Orchestrator {
  private readonly pipeline?: PipelineConfig["pipeline"];
  private maxRetries: number;

  constructor(pipelineOrMaxRetries?: PipelineConfig["pipeline"] | number, maxRetries = 1) {
    if (typeof pipelineOrMaxRetries === "number") {
      this.maxRetries = pipelineOrMaxRetries;
    } else {
      this.pipeline = pipelineOrMaxRetries;
      this.maxRetries = maxRetries;
    }
  }

  async plan(context: OrchestrationContext): Promise<ExecutionPlan> {
    if (this.pipeline) {
      const graph =
        context.agentGraph ?? compileAgentGraphFromPipeline(this.pipeline);
      context.agentGraph = graph;
      return agentGraphToExecutionPlan(graph, context.steps.length * 2);
    }
    return {
      steps: context.steps,
      maxRounds: context.steps.length * 2,
    };
  }

  async onStepComplete(context: OrchestrationContext, result: AgentResult): Promise<NextAction> {
    const completedSteps = [...context.results.keys(), result.stepName];
    const remaining = context.steps.filter((s) => !completedSteps.includes(s));

    if (remaining.length === 0) {
      return { type: "done", success: true, reason: "All steps completed" };
    }

    return { type: "continue", nextSteps: [remaining[0]] };
  }

  async onStepFailed(context: OrchestrationContext, error: StepError): Promise<RecoveryAction> {
    if (error.attempt < this.maxRetries) {
      return { type: "retry", stepName: error.stepName };
    }
    return { type: "abort", reason: `Step ${error.stepName} failed after ${error.attempt} attempts: ${error.error.message}` };
  }
}

/** Workflow mode: DAG staging + ADK-style Parallel/Sequential agents at runtime. */
export class WorkflowOrchestrator extends DAGOrchestrator {
  constructor(pipeline: PipelineConfig["pipeline"], maxRetries = 1) {
    super(pipeline, maxRetries);
  }
}

function reviewStepFromConfig(config: PipelineConfig): string {
  return config.retry?.reviewStep ?? "review";
}

function isReviewStep(stepName: string, reviewStep: string): boolean {
  return stepName === reviewStep || /review|audit|verdict/i.test(stepName);
}

function isImplementStep(stepName: string, reviewStep: string): boolean {
  return stepName !== reviewStep && !/review|audit|verdict/i.test(stepName);
}

/**
 * Policy-driven orchestrator for `orchestration.mode: "llm-driven"`.
 * Uses optional `orchestration.plannerProvider` on round 1; otherwise verdict + failure policy.
 */
export class LLMOrchestrator implements Orchestrator {
  private readonly pipeline: PipelineConfig["pipeline"] | undefined;
  private readonly config: PipelineConfig;
  private maxRetries: number;

  constructor(config: PipelineConfig, maxRetries = 1) {
    this.config = config;
    this.pipeline = config.pipeline;
    this.maxRetries = maxRetries;
  }

  async plan(context: OrchestrationContext): Promise<ExecutionPlan> {
    const plannerName = this.config.orchestration?.plannerProvider;
    if (plannerName && context.round === 1) {
      const plannerCtx: PlannerContext = {
        runId: context.runId,
        steps: context.steps,
        results: context.results,
        round: context.round,
        sharedKnowledge: context.sharedKnowledge,
        signal: context.signal,
      };
      const llmPlan = await requestLlmExecutionPlan(
        this.config,
        plannerName,
        plannerCtx,
        context.steps,
      );
      if (llmPlan) {
        if (context.agentGraph) {
          applyExecutionPlanToAgentGraph(context.agentGraph, llmPlan);
        }
        return llmPlan;
      }
    }

    if (this.pipeline) {
      const graph =
        context.agentGraph ?? compileAgentGraphFromPipeline(this.pipeline);
      context.agentGraph = graph;
      let plan = agentGraphToExecutionPlan(
        graph,
        Math.max(context.steps.length * 2, 1),
      );
      if (context.round > 1) {
        plan = this.prioritizeRevisionPlan(plan, context);
        applyExecutionPlanToAgentGraph(graph, plan);
      }
      return plan;
    }
    return { steps: context.steps, maxRounds: context.steps.length * 2 };
  }

  private prioritizeRevisionPlan(
    plan: ExecutionPlan,
    context: OrchestrationContext,
  ): ExecutionPlan {
    const reviewStep = reviewStepFromConfig(this.config);
    const hasReviewFeedback = Object.values(context.sharedKnowledge).some((v) =>
      /revision|feedback|needs.?fix|reject/i.test(v),
    );
    if (!hasReviewFeedback) return plan;

    const flat = plan.steps.flatMap((s) => (Array.isArray(s) ? s : [s]));
    const implement = flat.filter((s) => isImplementStep(s, reviewStep));
    const review = flat.filter((s) => isReviewStep(s, reviewStep));
    const other = flat.filter((s) => !implement.includes(s) && !review.includes(s));
    if (implement.length === 0 || review.length === 0) return plan;

    return { ...plan, steps: [...other, ...implement, ...review] };
  }

  async onStepComplete(context: OrchestrationContext, result: AgentResult): Promise<NextAction> {
    const reviewStep = reviewStepFromConfig(this.config);
    const text = isTextResponse(result.response)
      ? result.response.content || ""
      : result.response.summary || "";
    const verdict = parseVerdict(text);

    if (
      isReviewStep(result.stepName, reviewStep) &&
      verdict.format === "structured" &&
      !verdict.approved
    ) {
      const implementStep = context.steps.find((s) => isImplementStep(s, reviewStep));
      if (implementStep) {
        return { type: "continue", nextSteps: [implementStep] };
      }
    }

    const completedSteps = [...context.results.keys(), result.stepName];
    const remaining = context.steps.filter((s) => !completedSteps.includes(s));

    if (remaining.length === 0) {
      return { type: "done", success: true, reason: "All steps completed" };
    }

    return { type: "continue", nextSteps: [remaining[0]!] };
  }

  async onStepFailed(context: OrchestrationContext, error: StepError): Promise<RecoveryAction> {
    const reason = classifyOrchestratorFailure(error.error);
    if (error.attempt >= this.maxRetries) {
      return {
        type: "abort",
        reason: `LLM orchestrator: ${error.stepName} failed (${describeRetryStrategy(reason)}): ${error.error.message}`,
      };
    }
    return this.recoveryForReason(reason, error.stepName, context);
  }

  private recoveryForReason(
    reason: FailureReason,
    stepName: string,
    context: OrchestrationContext,
  ): RecoveryAction {
    const assignment = context.assignments.get(stepName) ?? agentId(stepName);
    switch (reason) {
      case "timeout":
        return { type: "fallback", stepName, fallbackAgent: assignment };
      case "quality":
      case "provider_error":
      default:
        return { type: "retry", stepName, withAgent: assignment, maxRetries: this.maxRetries };
    }
  }

  /**
   * Reflect → re-plan (DeerFlow narrow MVP). Only when `orchestration.reflect.enabled`.
   * Falls back to rule-based revision ordering when LLM reflect fails.
   */
  async reflectAndReplan(
    context: OrchestrationContext,
    trigger: ReflectTrigger,
    details: ReflectReplanDetails = {},
  ): Promise<ExecutionPlan | null> {
    const reflectCfg = this.config.orchestration?.reflect;
    if (reflectCfg?.enabled !== true) return null;

    const providerName = resolveReflectProviderName(this.config);
    const graph =
      context.agentGraph ??
      (this.pipeline ? compileAgentGraphFromPipeline(this.pipeline) : undefined);
    if (!graph) return null;
    context.agentGraph = graph;

    let plan: ExecutionPlan | null = null;
    if (providerName) {
      const reflectCtx = {
        runId: context.runId,
        steps: context.steps,
        results: context.results,
        round: context.round,
        sharedKnowledge: context.sharedKnowledge,
        signal: context.signal,
        trigger,
        focusStep: details.focusStep,
        errorMessage: details.errorMessage,
        reviewFeedback: details.reviewFeedback,
      };
      const llmPlan = await requestReflectExecutionPlan(
        this.config,
        providerName,
        reflectCtx,
        context.steps,
      );
      if (llmPlan) plan = llmPlan;
    }

    if (!plan) {
      plan = agentGraphToExecutionPlan(graph, Math.max(context.steps.length * 2, 1));
      if (trigger === "review_revision") {
        plan = this.prioritizeRevisionPlan(plan, context);
      } else if (details.focusStep) {
        const flat = plan.steps.flatMap((s) => (Array.isArray(s) ? s : [s]));
        const focus = details.focusStep;
        if (flat.includes(focus)) {
          const rest = flat.filter((s) => s !== focus);
          plan = { ...plan, steps: [...rest, focus] };
        }
      }
    }

    applyExecutionPlanToAgentGraph(graph, plan);
    return plan;
  }
}
