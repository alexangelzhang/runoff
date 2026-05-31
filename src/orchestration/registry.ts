/**
 * Agent Registry (Wave 7.1).
 *
 * Central registry for agent instances within a pipeline run.
 * Handles registration, lookup by id/role/capability, and lifecycle (dispose all).
 */

import type { PipelineConfig } from "../core/config.js";
import type { AgentId, AgentRole } from "./multi-agent-types.js";
import type { AgentInstance, AgentCapability, AgentConfig } from "./agent.js";
import type { LLMProvider } from "../providers/types.js";
import { AgentState } from "./agent-state.js";
import { agentId } from "./multi-agent-types.js";
import { PipelineStepAgent } from "./pipeline-step-agent.js";

// --- Default Agent Implementation ---

class DefaultAgent implements AgentInstance {
  readonly id: AgentId;
  readonly role: AgentRole;
  readonly capabilities: readonly AgentCapability[];
  readonly provider: LLMProvider;
  readonly state: AgentState;
  private disposed = false;

  constructor(config: AgentConfig, provider: LLMProvider) {
    this.id = config.id;
    this.role = config.role;
    this.capabilities = Object.freeze([...config.capabilities]);
    this.provider = provider;
    this.state = new AgentState(config.id);
  }

  async execute(task: import("./agent.js").AgentTask): Promise<import("./agent.js").AgentResult> {
    if (this.disposed) throw new Error(`Agent ${this.id} has been disposed`);

    const start = Date.now();
    const response = await this.provider.execute({
      prompt: task.prompt,
      language: task.language,
      context: task.context,
      workDir: task.workDir,
      sessionId: task.sessionId,
      stepName: task.stepName,
      round: task.round,
      signal: task.signal,
    });

    const durationMs = Date.now() - start;

    this.state.recordExecution({
      stepName: task.stepName,
      round: task.round,
      durationMs,
      success: !response.failed,
      timestamp: Date.now(),
    });

    if (response.insights) {
      this.state.mergeKnowledge(response.insights);
    }

    return {
      agentId: this.id,
      stepName: task.stepName,
      response,
      durationMs,
      insights: response.insights,
    };
  }

  dispose(): void {
    this.disposed = true;
  }
}

// --- Registry ---

export class AgentRegistry {
  private agents = new Map<string, AgentInstance>();

  /** Register a new agent from config + provider. Returns the created instance. */
  register(config: AgentConfig, provider: LLMProvider): AgentInstance {
    if (this.agents.has(config.id)) {
      throw new Error(`Agent already registered: ${config.id}`);
    }
    const agent = new DefaultAgent(config, provider);
    this.agents.set(config.id, agent);
    return agent;
  }

  /** Register a pre-built agent instance. */
  registerInstance(agent: AgentInstance): void {
    if (this.agents.has(agent.id)) {
      throw new Error(`Agent already registered: ${agent.id}`);
    }
    this.agents.set(agent.id, agent);
  }

  get(id: AgentId): AgentInstance | undefined {
    return this.agents.get(id);
  }

  getOrThrow(id: AgentId): AgentInstance {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Agent not found: ${id}`);
    return agent;
  }

  /** Find all agents with a given role. */
  findByRole(role: AgentRole): AgentInstance[] {
    return [...this.agents.values()].filter((a) => a.role === role);
  }

  /** Find all agents that have a specific capability. */
  findByCapability(cap: AgentCapability): AgentInstance[] {
    return [...this.agents.values()].filter((a) => a.capabilities.includes(cap));
  }

  /** All registered agent ids. */
  ids(): AgentId[] {
    return [...this.agents.keys()] as AgentId[];
  }

  /** Number of registered agents. */
  get size(): number {
    return this.agents.size;
  }

  /** Dispose all agents and clear the registry. */
  disposeAll(): void {
    for (const agent of this.agents.values()) {
      agent.dispose();
    }
    this.agents.clear();
  }

  /**
   * Convenience: create agents from a config map + provider factory.
   * Used to bootstrap a registry from pipeline.config.json `agents` section (Wave 7.5).
   * For now, also supports bootstrapping from legacy `pipeline` config via adapter.
   */
  static fromConfigs(
    configs: AgentConfig[],
    providerFactory: (providerName: string) => LLMProvider
  ): AgentRegistry {
    const registry = new AgentRegistry();
    for (const config of configs) {
      const provider = providerFactory(config.providerName);
      registry.register(config, provider);
    }
    return registry;
  }

  /** Bootstrap agents with full pipeline step execution (B8). */
  static fromPipelineSteps(
    config: PipelineConfig,
    reviewStepName = "review",
  ): AgentRegistry {
    const registry = new AgentRegistry();
    const configs = AgentRegistry.legacyStepsToAgentConfigs(config.pipeline, reviewStepName);
    for (const agentConfig of configs) {
      registry.registerInstance(new PipelineStepAgent(agentConfig, config));
    }
    return registry;
  }

  /**
   * Adapter: convert legacy pipeline step names into AgentConfig[].
   * Each step becomes a worker agent; the review step becomes a reviewer.
   */
  static legacyStepsToAgentConfigs(
    pipeline: Record<string, [string | string[], ...string[]]>,
    reviewStepName = "review"
  ): AgentConfig[] {
    return Object.entries(pipeline).map(([stepName, tuple]) => {
      const providerRaw = tuple[0];
      const providerName = Array.isArray(providerRaw) ? providerRaw[0] : providerRaw;
      const role: AgentRole = stepName === reviewStepName ? "reviewer" : "worker";
      const capabilities: AgentCapability[] =
        role === "reviewer" ? ["review", "verify"] : ["implement"];

      return {
        id: agentId(stepName),
        role,
        providerName,
        capabilities,
      };
    });
  }
}
