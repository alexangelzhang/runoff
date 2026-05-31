/**
 * A2A Agent Card (Wave 7.9).
 *
 * Declares an agent's capabilities for external discovery.
 * Reference: Google Agent2Agent Protocol — Agent Card.
 *
 * An Agent Card is the "business card" of an agent: it tells other
 * agents what this agent can do, how to reach it, and what formats
 * it accepts/produces.
 */

import type { AgentId, AgentRole } from "../../orchestration/multi-agent-types.js";
import type { AgentCapability } from "../../orchestration/agent.js";

// --- Skill Declaration ---

export interface A2ASkill {
  /** Unique skill identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** What this skill does. */
  description: string;
  /** MIME types this skill accepts as input. */
  inputModes?: string[];
  /** MIME types this skill produces as output. */
  outputModes?: string[];
  /** Tags for discovery/filtering. */
  tags?: string[];
}

// --- Agent Card ---

export interface A2AAgentCard {
  /** Agent identifier. */
  agentId: AgentId;
  /** Human-readable name. */
  name: string;
  /** What this agent does. */
  description: string;
  /** Agent role in the system. */
  role: AgentRole;
  /** Internal capabilities. */
  capabilities: AgentCapability[];
  /** Skills exposed via A2A protocol. */
  skills: A2ASkill[];
  /** Protocol version. */
  protocolVersion: string;
  /** Endpoint URL for A2A communication. */
  endpoint?: string;
  /** Authentication requirements. */
  auth?: {
    type: "none" | "bearer" | "api-key" | "oauth2";
    config?: Record<string, string>;
  };
  /** Metadata for discovery. */
  metadata?: Record<string, unknown>;
}

// --- Agent Card Registry ---

/**
 * Registry for discovering agents by their capabilities.
 * In a real deployment, this would be backed by a service directory.
 */
export class AgentCardRegistry {
  private cards = new Map<string, A2AAgentCard>();

  /** Register an agent card. */
  register(card: A2AAgentCard): void {
    this.cards.set(card.agentId, card);
  }

  /** Unregister an agent card. */
  unregister(agentId: AgentId): boolean {
    return this.cards.delete(agentId);
  }

  /** Get a card by agent ID. */
  get(agentId: AgentId): A2AAgentCard | undefined {
    return this.cards.get(agentId);
  }

  /** Find agents that have a specific skill (by skill id or tag). */
  findBySkill(skillIdOrTag: string): A2AAgentCard[] {
    return [...this.cards.values()].filter((card) =>
      card.skills.some(
        (s) => s.id === skillIdOrTag || s.tags?.includes(skillIdOrTag)
      )
    );
  }

  /** Find agents by role. */
  findByRole(role: AgentRole): A2AAgentCard[] {
    return [...this.cards.values()].filter((c) => c.role === role);
  }

  /** Get all registered cards. */
  getAll(): A2AAgentCard[] {
    return [...this.cards.values()];
  }

  /** Number of registered cards. */
  get size(): number {
    return this.cards.size;
  }

  /** Clear all cards. */
  clear(): void {
    this.cards.clear();
  }
}
