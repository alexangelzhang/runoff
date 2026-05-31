/**
 * B8 — Agent instance that runs full pipeline step semantics (not bare provider.execute).
 */

import type { PipelineConfig } from "../core/config.js";
import type { AgentCapability, AgentConfig, AgentInstance, AgentResult, AgentTask } from "./agent.js";
import { AgentState } from "./agent-state.js";
import type { AgentId, AgentRole } from "./multi-agent-types.js";
import { executePipelineStep, type SchedulerContext, type StepOutcome } from "./step-execution.js";
import { stepOutcomeToAgentResult } from "./workflow-bridge.js";
import type { LLMProvider } from "../providers/types.js";

export class PipelineStepAgent implements AgentInstance {
  readonly id: AgentId;
  readonly role: AgentRole;
  readonly capabilities: readonly AgentCapability[];
  readonly state: AgentState;
  readonly stepName: string;
  lastOutcome?: StepOutcome;

  get provider(): LLMProvider {
    throw new Error("PipelineStepAgent uses executePipelineStep, not bare provider");
  }

  constructor(
    private readonly agentConfig: AgentConfig,
    private readonly config: PipelineConfig,
  ) {
    this.id = agentConfig.id;
    this.role = agentConfig.role;
    this.capabilities = Object.freeze([...agentConfig.capabilities]);
    this.state = new AgentState(agentConfig.id);
    this.stepName = String(agentConfig.id);
  }

  async executeWithContext(ctx: SchedulerContext): Promise<StepOutcome> {
    const outcome = await executePipelineStep(this.config, this.stepName, ctx);
    this.lastOutcome = outcome;
    this.state.recordExecution({
      stepName: this.stepName,
      round: ctx.round,
      durationMs: outcome.durationMs,
      success: !outcome.response.failed,
      timestamp: Date.now(),
    });
    return outcome;
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const ctx: SchedulerContext = {
      prompt: task.prompt,
      language: task.language,
      context: task.context,
      workDir: task.workDir,
      sessionId: task.sessionId,
      round: task.round,
      globalKnowledge: task.sharedKnowledge ?? {},
      candidate: { code: "", isAgent: false },
      signal: task.signal,
      reviewStepName: this.config.retry?.reviewStep ?? "review",
      lastReviewFeedback: task.reviewFeedback,
    };
    const outcome = await this.executeWithContext(ctx);
    return stepOutcomeToAgentResult(outcome);
  }

  dispose(): void {
    /* stateless aside from AgentState */
  }
}
