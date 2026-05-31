/**
 * Agent-as-Tool Adapter (Wave 7.3).
 *
 * Allows an orchestrator to invoke a specialist agent as a "tool call",
 * keeping control with the orchestrator (vs handoff which transfers control).
 *
 * Reference: OpenAI agent-as-tools pattern.
 */

import type { AgentConfigEntry } from "../core/config.js";
import type { AgentId } from "./multi-agent-types.js";
import { agentId } from "./multi-agent-types.js";
import type { AgentInstance, AgentTask, AgentResult } from "./agent.js";
import type { AgentRegistry } from "./registry.js";

// --- Agent Tool Definition ---

export interface AgentToolDefinition {
  /** Tool name (used in LLM tool_use calls). */
  name: string;
  /** Human-readable description for the LLM. */
  description: string;
  /** The agent that backs this tool. */
  agentId: AgentId;
}

// --- Agent Tool Registry ---

/**
 * Maps tool names to agent instances, enabling the orchestrator
 * to call agents as if they were tools.
 */
export class AgentToolRegistry {
  private tools = new Map<string, { definition: AgentToolDefinition; agent: AgentInstance }>();

  /** Register an agent as a callable tool. */
  register(definition: AgentToolDefinition, agent: AgentInstance): void {
    this.tools.set(definition.name, { definition, agent });
  }

  /** Unregister a tool by name. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** Get all tool definitions (for passing to LLM as available tools). */
  getToolDefinitions(): AgentToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  /** Invoke a tool by name. Returns the agent's result. */
  async invoke(toolName: string, task: AgentTask): Promise<AgentResult> {
    const entry = this.tools.get(toolName);
    if (!entry) {
      throw new Error(`Agent tool not found: ${toolName}`);
    }
    return entry.agent.execute(task);
  }

  /** Check if a tool exists. */
  has(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  /** Get the agent backing a tool. */
  getAgent(toolName: string): AgentInstance | undefined {
    return this.tools.get(toolName)?.agent;
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size;
  }

  /** Clear all tools. */
  clear(): void {
    this.tools.clear();
  }
}

/** Build tool registry from run-time agent registry (Phase 7.3 main-path wiring). */
export function buildAgentToolRegistry(
  registry: AgentRegistry,
  agents: Record<string, AgentConfigEntry>,
): AgentToolRegistry {
  const tools = new AgentToolRegistry();
  for (const [stepName, entry] of Object.entries(agents)) {
    if (entry.role === "orchestrator") continue;
    const id = agentId(stepName);
    const agent = registry.get(id);
    if (!agent) continue;
    const caps = entry.capabilities?.length ? entry.capabilities.join(", ") : entry.role;
    tools.register(
      {
        name: stepName,
        description: `${entry.role} agent (${caps})`,
        agentId: id,
      },
      agent,
    );
  }
  return tools;
}
