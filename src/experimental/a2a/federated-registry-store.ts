/**
 * Phase 7.9 — Persist federated A2A agent cards across restarts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getA2AFederationDir } from "../../core/paths.js";
import type { A2AAgentCard, AgentCardRegistry } from "./agent-card.js";
import { cardWithActiveSkills, filterActiveAgentCards } from "./federation-crdt.js";
import { resolveFederationNodeId, stampFederationCards } from "./federation-vector.js";

export type FederationStoreOptions = {
  storePath?: string;
  enabled?: boolean;
  /** P4: bump vector clock on persist when set (or env RUNOFF_FEDERATION_NODE_ID). */
  nodeId?: string;
};

export interface FederatedRegistrySnapshot {
  version: 1;
  updatedAt: string;
  agents: A2AAgentCard[];
}

function federationFilePath(customPath?: string): string {
  return customPath ?? join(getA2AFederationDir(), "agents.json");
}

export function isFederationPersistEnabled(flag?: boolean): boolean {
  if (flag === false) return false;
  if (flag === true) return true;
  if (process.env.LLM_A2A_FEDERATION_PERSIST === "0") return false;
  if (process.env.LLM_A2A_FEDERATION_PERSIST === "1") return true;
  return false;
}

export function loadFederatedAgentCards(storePath?: string): A2AAgentCard[] {
  const path = federationFilePath(storePath);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as FederatedRegistrySnapshot;
    if (!Array.isArray(raw.agents)) return [];
    return raw.agents;
  } catch {
    return [];
  }
}

function agentsForPersist(agents: A2AAgentCard[], nodeId?: string): A2AAgentCard[] {
  if (!nodeId) return agents;
  return stampFederationCards(agents, resolveFederationNodeId(nodeId));
}

export function persistFederatedAgentCards(
  agents: A2AAgentCard[],
  storePath?: string,
  nodeId?: string,
): void {
  const path = federationFilePath(storePath);
  mkdirSync(dirname(path), { recursive: true });
  const byId = new Map<string, A2AAgentCard>();
  for (const card of agentsForPersist(agents, nodeId)) byId.set(card.agentId, card);
  const snapshot: FederatedRegistrySnapshot = {
    version: 1,
    updatedAt: new Date().toISOString(),
    agents: [...byId.values()],
  };
  writeFileSync(path, JSON.stringify(snapshot, null, 2), "utf-8");
}

/**
 * Merge cards into registry; local registry entries win on id conflict.
 * Returns count of newly added ids.
 */
export function mergeCardsIntoRegistry(
  registry: AgentCardRegistry,
  cards: A2AAgentCard[],
  source: "federation" | "remote" = "federation",
): number {
  let added = 0;
  for (const card of filterActiveAgentCards(cards)) {
    if (registry.get(card.agentId)) continue;
    const active = cardWithActiveSkills(card);
    registry.register({
      ...active,
      metadata: { ...active.metadata, federationSource: source },
    });
    added++;
  }
  return added;
}

/** Load disk federation + merge; returns cards loaded from disk. */
export function hydrateRegistryFromFederation(
  registry: AgentCardRegistry,
  options: { storePath?: string; enabled?: boolean } = {},
): A2AAgentCard[] {
  if (!isFederationPersistEnabled(options.enabled)) return [];
  const stored = loadFederatedAgentCards(options.storePath);
  mergeCardsIntoRegistry(registry, stored, "federation");
  return stored;
}

/** Append remote/local discovered cards to federation file (dedupe by agentId). */
export function appendToFederationStore(
  newCards: A2AAgentCard[],
  options: FederationStoreOptions = {},
): number {
  if (!isFederationPersistEnabled(options.enabled) || newCards.length === 0) return 0;
  const existing = loadFederatedAgentCards(options.storePath);
  const byId = new Map(existing.map((c) => [c.agentId, c]));
  let added = 0;
  for (const card of newCards) {
    if (byId.has(card.agentId)) continue;
    byId.set(card.agentId, {
      ...card,
      metadata: { ...card.metadata, federationSource: "remote" },
    });
    added++;
  }
  if (added > 0) {
    persistFederatedAgentCards([...byId.values()], options.storePath, options.nodeId);
  }
  return added;
}
