/**
 * Workflow agents ↔ scheduler bridge (Phase 7.3).
 */

import type { SchedulerContext, StepOutcome } from "./step-execution.js";
import type { StepRunner } from "./step-runner.js";
import type { AgentInstance, AgentResult, AgentTask, AgentCapability } from "./agent.js";
import { AgentState } from "./agent-state.js";
import type { AgentId, AgentRole } from "./multi-agent-types.js";
import { agentId } from "./multi-agent-types.js";
import type { AgentRegistry } from "./registry.js";
import { ParallelAgent } from "./workflow-agents.js";
import { roleForStep } from "./execution-governance.js";
import type { LLMProvider } from "../providers/types.js";

/** Wrap step-runner execution as an AgentInstance (ADK pattern). */
export class SchedulerStepAgent implements AgentInstance {
  readonly id: AgentId;
  readonly role: AgentRole;
  readonly capabilities: readonly AgentCapability[];
  readonly state: AgentState;
  lastOutcome?: StepOutcome;

  get provider(): LLMProvider {
    throw new Error("SchedulerStepAgent delegates to StepRunner");
  }

  constructor(
    id: AgentId,
    role: AgentRole,
    capabilities: readonly AgentCapability[],
    private readonly stepRunner: StepRunner,
    private readonly stepName: string,
    private readonly buildContext: (task: AgentTask) => SchedulerContext,
  ) {
    this.id = id;
    this.role = role;
    this.capabilities = capabilities;
    this.state = new AgentState(id);
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    this.lastOutcome = await this.stepRunner.executeStep(this.stepName, this.buildContext(task));
    return stepOutcomeToAgentResult(this.lastOutcome);
  }

  dispose(): void {
    /* stateless wrapper */
  }
}

export function stepOutcomeToAgentResult(outcome: StepOutcome): AgentResult {
  return {
    agentId: agentId(outcome.stepName),
    stepName: outcome.stepName,
    response: outcome.response,
    durationMs: outcome.durationMs,
  };
}

export function useWorkflowAgents(config: { orchestration?: { mode?: string } }): boolean {
  return config.orchestration?.mode === "workflow";
}

/**
 * Execute a parallel DAG stage via ParallelAgent over scheduler-backed step agents.
 */
export async function executeWorkflowParallelStage(input: {
  registry: AgentRegistry;
  stepRunner: StepRunner;
  stepNames: string[];
  reviewStepName: string;
  buildContext: (stepName: string, task: AgentTask) => SchedulerContext;
  baseTask: AgentTask;
}): Promise<StepOutcome[]> {
  const runStep = (stepName: string, ctx: SchedulerContext) =>
    input.stepRunner.executeStep(stepName, ctx);

  if (input.stepNames.length === 1) {
    const stepName = input.stepNames[0]!;
    return [await runStep(stepName, input.buildContext(stepName, input.baseTask))];
  }

  const children: SchedulerStepAgent[] = [];
  for (const stepName of input.stepNames) {
    const regAgent = input.registry.get(agentId(stepName));
    const role = roleForStep(stepName, input.reviewStepName);
    const capabilities = regAgent?.capabilities ?? (role === "reviewer" ? ["review", "verify"] : ["implement"]);
    children.push(
      new SchedulerStepAgent(
        agentId(stepName),
        role,
        capabilities,
        input.stepRunner,
        stepName,
        (task) => input.buildContext(stepName, task),
      ),
    );
  }

  const parallel = new ParallelAgent(agentId("orchestrator"), children, "all");
  await parallel.executeAll({
    ...input.baseTask,
    stepName: `stage/${input.stepNames.join("+")}`,
  });

  return children
    .map((c) => c.lastOutcome)
    .filter((o): o is StepOutcome => o !== undefined);
}
