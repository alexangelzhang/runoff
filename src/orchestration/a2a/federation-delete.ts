/**
 * P9 — Explicit federated agent delete (tombstone) + tombstone GC.
 */

import type { A2AAgentCard } from "./agent-card.js";
import {
  createAgentCardTombstone,
  getSkillTombstoneMap,
  isCardTombstoned,
  isSkillTombstoned,
  mergeCardsCrdt,
  tombstoneSkillOnCard,
} from "./federation-crdt.js";
import {
  isFederationPersistEnabled,
  loadFederatedAgentCards,
  persistFederatedAgentCards,
} from "./federated-registry-store.js";
import { resolveFederationNodeId } from "./federation-vector.js";

const DEFAULT_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SKILL_TOMBSTONE_RETENTION_MS = DEFAULT_TOMBSTONE_RETENTION_MS;

export type FederationDeleteOptions = {
  storePath?: string;
  enabled?: boolean;
  nodeId: string;
};

/** Tombstone an agent in the federation store (CRDT delete propagation). */
export function deleteFederatedAgentCard(
  agentId: string,
  options: FederationDeleteOptions,
): boolean {
  if (!isFederationPersistEnabled(options.enabled)) return false;
  const nodeId = resolveFederationNodeId(options.nodeId);
  const local = loadFederatedAgentCards(options.storePath);
  const existing = local.find((c) => c.agentId === agentId);
  const tomb = createAgentCardTombstone(agentId, nodeId, existing);
  const { merged } = mergeCardsCrdt(local, [tomb]);
  persistFederatedAgentCards(merged, options.storePath, nodeId);
  return true;
}

/** Tombstone a single skill on a federated agent (partial CRDT delete). */
export function deleteFederatedAgentSkill(
  agentId: string,
  skillId: string,
  options: FederationDeleteOptions,
): boolean {
  if (!isFederationPersistEnabled(options.enabled)) return false;
  const nodeId = resolveFederationNodeId(options.nodeId);
  const local = loadFederatedAgentCards(options.storePath);
  const existing = local.find((c) => c.agentId === agentId);
  if (!existing) return false;
  if (isSkillTombstoned(existing, skillId)) return true;
  const updated = tombstoneSkillOnCard(existing, skillId, nodeId);
  const { merged } = mergeCardsCrdt(local, [updated]);
  persistFederatedAgentCards(merged, options.storePath, nodeId);
  return true;
}

export type FederationTombstoneGcOptions = {
  retentionMs?: number;
  nowMs?: number;
};

/** Drop expired tombstones from an agent list. retentionMs <= 0 disables GC. */
export function gcFederationTombstones(
  agents: A2AAgentCard[],
  options: FederationTombstoneGcOptions = {},
): { agents: A2AAgentCard[]; removed: number } {
  const retentionMs = options.retentionMs ?? DEFAULT_TOMBSTONE_RETENTION_MS;
  if (retentionMs <= 0) return { agents, removed: 0 };

  const now = options.nowMs ?? Date.now();
  let removed = 0;
  const kept = agents.filter((card) => {
    if (!isCardTombstoned(card)) return true;
    const raw = card.metadata?.federationDeletedAt;
    const deletedAt = typeof raw === "string" ? Date.parse(raw) : 0;
    if (Number.isNaN(deletedAt) || now - deletedAt < retentionMs) return true;
    removed++;
    return false;
  });
  return { agents: kept, removed };
}

/** P11: Drop expired skill tombstone entries from card metadata. */
export function gcSkillTombstonesOnAgents(
  agents: A2AAgentCard[],
  options: FederationTombstoneGcOptions = {},
): { agents: A2AAgentCard[]; removed: number } {
  const retentionMs = options.retentionMs ?? DEFAULT_SKILL_TOMBSTONE_RETENTION_MS;
  if (retentionMs <= 0) return { agents, removed: 0 };

  const now = options.nowMs ?? Date.now();
  let removed = 0;
  const kept = agents.map((card) => {
    if (isCardTombstoned(card)) return card;
    const tombs = getSkillTombstoneMap(card);
    if (Object.keys(tombs).length === 0) return card;

    const nextTombs: Record<string, string> = {};
    let cardRemoved = 0;
    for (const [skillId, deletedAt] of Object.entries(tombs)) {
      const t = Date.parse(deletedAt);
      if (Number.isNaN(t) || now - t < retentionMs) {
        nextTombs[skillId] = deletedAt;
      } else {
        cardRemoved++;
      }
    }
    if (cardRemoved === 0) return card;
    removed += cardRemoved;
    const metadata = { ...card.metadata };
    if (Object.keys(nextTombs).length === 0) {
      delete metadata.federationSkillTombstones;
    } else {
      metadata.federationSkillTombstones = nextTombs;
    }
    return { ...card, metadata };
  });
  return { agents: kept, removed };
}

export type FederationCompactResult = {
  agentTombstonesRemoved: number;
  skillTombstonesRemoved: number;
};

/** Load federation store, GC agent + skill tombstones, persist when any removed. */
export function compactFederationTombstones(options: {
  storePath?: string;
  enabled?: boolean;
  nodeId?: string;
  retentionMs?: number;
  skillRetentionMs?: number;
  nowMs?: number;
}): FederationCompactResult {
  const empty = { agentTombstonesRemoved: 0, skillTombstonesRemoved: 0 };
  if (!isFederationPersistEnabled(options.enabled)) return empty;

  const local = loadFederatedAgentCards(options.storePath);
  const agentGc = gcFederationTombstones(local, {
    retentionMs: options.retentionMs,
    nowMs: options.nowMs,
  });
  const skillGc = gcSkillTombstonesOnAgents(agentGc.agents, {
    retentionMs: options.skillRetentionMs ?? options.retentionMs,
    nowMs: options.nowMs,
  });

  const totalRemoved = agentGc.removed + skillGc.removed;
  if (totalRemoved > 0) {
    persistFederatedAgentCards(skillGc.agents, options.storePath, options.nodeId);
  }
  return {
    agentTombstonesRemoved: agentGc.removed,
    skillTombstonesRemoved: skillGc.removed,
  };
}
