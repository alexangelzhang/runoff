/**
 * B5 — Multi-node federation sync, conflict resolution, and directory helpers.
 */

import type { A2AAgentCard } from "./agent-card.js";
import {
  appendToFederationStore,
  loadFederatedAgentCards,
  persistFederatedAgentCards,
} from "./federated-registry-store.js";
import { backupFederationStore } from "./federation-ha.js";
import { filterCardsByPeerQuorum, resolveFederationQuorumMin } from "./federation-quorum.js";
import { applySkillQuorumToDirectory } from "./federation-skill-quorum.js";
import {
  compactFederationTombstones,
  type FederationCompactResult,
} from "./federation-delete.js";
import {
  applyLeaseAutoDowngrade,
  arbitrateFromSplitBrainReport,
  type FederationLeaseArbitration,
  type LeaseDowngradeResult,
} from "./federation-lease-arbitration.js";
import {
  checkFederationSplitBrain,
  type SplitBrainReport,
} from "./federation-lease-witness.js";
import { federationLeasePath, readFederationLease } from "./federation-lease.js";
import { resolveFederationLeaderRole } from "./federation-leader.js";
import { mergeCardsCrdt } from "./federation-crdt.js";
import {
  reconcileFederationSkillDependencies,
  type SkillDepPruneStrategy,
} from "./federation-skill-deps.js";
import {
  appendSkillDepsPruneLog,
  type SkillDepsPruneReceipt,
} from "./federation-skill-deps-log.js";
import { pickVectorWinner } from "./federation-vector.js";

export type FederationConflictStrategy =
  | "local-wins"
  | "newest-wins"
  | "remote-wins"
  | "vector-wins"
  | "crdt-merge";

export type FederationMergeResult = {
  merged: A2AAgentCard[];
  conflicts: number;
  added: number;
};

function cardUpdatedAt(card: A2AAgentCard): number {
  const raw = card.metadata?.updatedAt ?? card.metadata?.federationUpdatedAt;
  if (typeof raw === "string") {
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return t;
  }
  if (typeof raw === "number") return raw;
  return 0;
}

/** Merge local + incoming agent cards with an explicit conflict policy. */
export function mergeCardsWithConflictStrategy(
  local: A2AAgentCard[],
  incoming: A2AAgentCard[],
  strategy: FederationConflictStrategy = "local-wins",
): FederationMergeResult {
  const byId = new Map(local.map((c) => [c.agentId, c]));
  let conflicts = 0;
  let added = 0;

  for (const card of incoming) {
    const existing = byId.get(card.agentId);
    if (!existing) {
      byId.set(card.agentId, card);
      added++;
      continue;
    }
    conflicts++;
    if (strategy === "local-wins") continue;
    if (strategy === "remote-wins") {
      byId.set(card.agentId, card);
      continue;
    }
    if (strategy === "vector-wins") {
      byId.set(card.agentId, pickVectorWinner(existing, card));
      continue;
    }
    if (strategy === "crdt-merge") {
      byId.set(card.agentId, mergeCardsCrdt([existing], [card]).merged[0]!);
      continue;
    }
    if (cardUpdatedAt(card) >= cardUpdatedAt(existing)) {
      byId.set(card.agentId, card);
    }
  }

  return { merged: [...byId.values()], conflicts, added };
}

export type FederationDirectorySnapshot = {
  version: 1;
  updatedAt: string;
  agents: A2AAgentCard[];
};

export function buildFederationDirectoryBody(agents: A2AAgentCard[]): FederationDirectorySnapshot {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    agents,
  };
}

export function parseFederationDirectoryBody(body: unknown): A2AAgentCard[] {
  if (!body || typeof body !== "object") return [];
  const agents = (body as FederationDirectorySnapshot).agents;
  return Array.isArray(agents) ? agents : [];
}

async function fetchPeerDirectory(
  base: string,
  headers: Record<string, string>,
  retries: number,
): Promise<A2AAgentCard[]> {
  const url = base.replace(/\/$/, "") + "/a2a/federation/directory";
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      return parseFederationDirectoryBody(await res.json());
    } catch {
      if (attempt === retries) return [];
    }
  }
  return [];
}

/** Pull peer federation directories and merge into the local store. */
export async function syncFederationFromPeers(options: {
  peerUrls: string[];
  storePath?: string;
  enabled?: boolean;
  conflictStrategy?: FederationConflictStrategy;
  bearerToken?: string;
  /** P3: per-peer retry count (default 2). */
  retries?: number;
  backupPath?: string;
  /** P4: vector-clock stamp on local persist. */
  nodeId?: string;
  /** P5: require agentId on >= N peer directories before merge (default 1). */
  quorumMin?: number;
  /** P6: leader pushes directory to peers after pull merge. */
  leaderElection?: boolean;
  /** P7: file lease for leader (overrides lexicographic election when set). */
  leaderLease?: boolean;
  leaseMs?: number;
  /** P9: peer URLs to witness leader lease (split-brain check). */
  leaseWitnessUrls?: string[];
  /** P9: log/return when multiple valid lease holders (default true when witnesses set). */
  splitBrainAlert?: boolean;
  /** P10: pick canonical lease on split-brain (default true when witnesses set). */
  leaseArbitration?: boolean;
  /** P10: relinquish local lease when not arbitration winner (default true). */
  leaseAutoDowngrade?: boolean;
  /** P11: min votes to confirm lease write (default 1). */
  leaseQuorumMin?: number;
  /** P12: POST witness receipt to peers (default true when witness URLs set). */
  leaseWitnessBroadcast?: boolean;
  /** P9: tombstone retention ms for GC (default 7d; 0 = off). */
  tombstoneRetentionMs?: number;
  /** P11: skill tombstone retention (defaults to tombstoneRetentionMs). */
  skillTombstoneRetentionMs?: number;
  /** P12: min peers that must list a skill before merge (default 1). */
  skillQuorumMin?: number;
  /** P14: block persist when skill dependency graph has a cycle (default true). */
  skillDepsBlockSync?: boolean;
  /** P15: prune cyclic skill deps instead of blocking (default true; runs before block). */
  skillDepsPruneSync?: boolean;
  /** P16: prune strategy when breaking cycles (default last-edge). */
  skillDepsPruneStrategy?: SkillDepPruneStrategy;
}): Promise<{
  pulled: number;
  conflicts: number;
  quorumMin: number;
  isLeader?: boolean;
  leaderNodeId?: string;
  splitBrain?: SplitBrainReport;
  leaseArbitration?: FederationLeaseArbitration;
  leaseDowngrade?: LeaseDowngradeResult;
  tombstonesGc?: FederationCompactResult;
  skillQuorumMin?: number;
  skillsDropped?: number;
  skillDepsBlocked?: boolean;
  skillDepsCycle?: string[];
  skillDepsPruned?: number;
  skillDepsPruneReceipt?: SkillDepsPruneReceipt;
}> {
  if (!options.peerUrls.length) return { pulled: 0, conflicts: 0, quorumMin: 1 };

  const local = loadFederatedAgentCards(options.storePath);
  let merged = local;
  let totalConflicts = 0;
  let totalPulled = 0;
  const retries = options.retries ?? 2;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.bearerToken) headers.Authorization = `Bearer ${options.bearerToken}`;

  const peerDirs: A2AAgentCard[][] = [];
  for (const base of options.peerUrls) {
    const remote = await fetchPeerDirectory(base, headers, retries);
    if (remote.length) peerDirs.push(remote);
  }

  const quorumMin = resolveFederationQuorumMin(peerDirs.length, options.quorumMin);
  const strategy = options.conflictStrategy ?? "newest-wins";

  if (quorumMin > 1 && peerDirs.length > 0) {
    const incoming = filterCardsByPeerQuorum(peerDirs, quorumMin);
    const result = mergeCardsWithConflictStrategy(merged, incoming, strategy);
    merged = result.merged;
    totalConflicts += result.conflicts;
    totalPulled += result.added;
  } else {
    for (const remote of peerDirs) {
      const result = mergeCardsWithConflictStrategy(merged, remote, strategy);
      merged = result.merged;
      totalConflicts += result.conflicts;
      totalPulled += result.added;
    }
  }

  let skillsDropped = 0;
  let skillQuorumMinApplied = 1;
  if (options.skillQuorumMin !== undefined && options.skillQuorumMin > 1 && peerDirs.length > 0) {
    const skillQ = applySkillQuorumToDirectory(merged, peerDirs, options.skillQuorumMin);
    merged = skillQ.cards;
    skillsDropped = skillQ.skillsDropped;
    skillQuorumMinApplied = skillQ.quorumMin;
  }

  let skillDepsBlocked = false;
  let skillDepsCycle: string[] | undefined;
  let skillDepsPruned = 0;
  let skillDepsPruneReceipt: SkillDepsPruneReceipt | undefined;
  const depReconcile = reconcileFederationSkillDependencies(merged, {
    prune: options.skillDepsPruneSync !== false,
    block: options.skillDepsBlockSync !== false,
    pruneStrategy: options.skillDepsPruneStrategy,
  });
  if (depReconcile.pruned.length > 0) {
    merged = depReconcile.cards;
    skillDepsPruned = depReconcile.pruned.length;
    skillDepsPruneReceipt =
      appendSkillDepsPruneLog({
        source: "sync",
        pruned: depReconcile.pruned,
        strategy: options.skillDepsPruneStrategy,
        storePath: options.storePath,
      }) ?? undefined;
    console.warn(
      `[federation] pruned ${skillDepsPruned} cyclic skill dep(s) receipt=${skillDepsPruneReceipt?.receiptId ?? "n/a"}`,
    );
  } else if (depReconcile.blocked) {
    skillDepsBlocked = true;
    skillDepsCycle = depReconcile.cycle;
    merged = local;
    console.warn(
      `[federation] skill dep cycle blocked sync: ${depReconcile.cycle?.join(" -> ")}`,
    );
  }

  if (
    (totalPulled > 0 || totalConflicts > 0 || skillsDropped > 0 || skillDepsPruned > 0) &&
    !skillDepsBlocked
  ) {
    persistFederatedAgentCards(merged, options.storePath, options.nodeId);
    if (options.backupPath) {
      backupFederationStore(options.storePath, options.backupPath);
    }
  }

  let splitBrain: SplitBrainReport | undefined;
  let leaseArbitration: FederationLeaseArbitration | undefined;
  let leaseDowngrade: LeaseDowngradeResult | undefined;
  if (options.leaseWitnessUrls?.length) {
    splitBrain = await checkFederationSplitBrain({
      peerUrls: options.leaseWitnessUrls,
      storePath: options.storePath,
      bearerToken: options.bearerToken,
      retries: options.retries,
    });
    if (
      splitBrain.detected &&
      options.splitBrainAlert !== false
    ) {
      console.warn(
        `[federation] split-brain detected: holders=${splitBrain.conflictingHolders.join(",")}`,
      );
    }
    if (options.leaseArbitration !== false) {
      const localLease = readFederationLease(federationLeasePath(options.storePath));
      leaseArbitration = arbitrateFromSplitBrainReport(splitBrain, localLease);
    }
  }

  let isLeader: boolean | undefined;
  let leaderNodeId: string | undefined;
  if ((options.leaderElection || options.leaderLease) && options.nodeId) {
    const role = await resolveFederationLeaderRole({
      nodeId: options.nodeId,
      peerUrls: options.peerUrls,
      bearerToken: options.bearerToken,
      leaderLease: options.leaderLease,
      leaseMs: options.leaseMs,
      storePath: options.storePath,
      leaseWitnessUrls: options.leaseWitnessUrls,
      leaseQuorumMin: options.leaseQuorumMin,
      leaseWitnessUrls: options.leaseWitnessUrls,
      leaseWitnessBroadcast: options.leaseWitnessBroadcast,
    });
    isLeader = role.isLeader;
    leaderNodeId = role.leaderNodeId;

    if (
      splitBrain?.detected &&
      leaseArbitration &&
      options.leaseAutoDowngrade !== false
    ) {
      leaseDowngrade = applyLeaseAutoDowngrade({
        localNodeId: options.nodeId,
        splitBrain,
        arbitration: leaseArbitration,
        storePath: options.storePath,
      });
      if (leaseDowngrade.downgraded) {
        isLeader = false;
        leaderNodeId = leaseArbitration.winnerHolder ?? leaderNodeId;
        console.warn(`[federation] lease auto-downgrade: ${leaseDowngrade.reason}`);
      }
    }

    if (isLeader) {
      await pushFederationToPeers({
        peerUrls: options.peerUrls,
        storePath: options.storePath,
        bearerToken: options.bearerToken,
      });
    }
  }

  let tombstonesGc: FederationCompactResult | undefined;
  if (options.tombstoneRetentionMs !== 0) {
    tombstonesGc = compactFederationTombstones({
      storePath: options.storePath,
      enabled: options.enabled,
      nodeId: options.nodeId,
      retentionMs: options.tombstoneRetentionMs,
      skillRetentionMs: options.skillTombstoneRetentionMs,
    });
  }

  return {
    pulled: totalPulled,
    conflicts: totalConflicts,
    quorumMin,
    isLeader,
    leaderNodeId,
    splitBrain,
    leaseArbitration,
    leaseDowngrade,
    tombstonesGc,
    skillQuorumMin: skillQuorumMinApplied,
    skillsDropped,
    skillDepsBlocked,
    skillDepsCycle,
    skillDepsPruned,
    skillDepsPruneReceipt,
  };
}

/** Publish local federation file to peers (best-effort POST). */
export async function pushFederationToPeers(options: {
  peerUrls: string[];
  storePath?: string;
  bearerToken?: string;
}): Promise<{ pushed: number }> {
  const agents = loadFederatedAgentCards(options.storePath);
  if (!agents.length || !options.peerUrls.length) return { pushed: 0 };

  const body = JSON.stringify(buildFederationDirectoryBody(agents));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (options.bearerToken) headers.Authorization = `Bearer ${options.bearerToken}`;

  let pushed = 0;
  for (const base of options.peerUrls) {
    const url = base.replace(/\/$/, "") + "/a2a/federation/directory";
    try {
      const res = await fetch(url, { method: "POST", headers, body });
      if (res.ok) pushed++;
    } catch {
      // ignore
    }
  }
  return { pushed };
}

/** Merge remote discovery cards into store using conflict strategy (B5). */
export function mergeRemoteCardsIntoFederationStore(
  newCards: A2AAgentCard[],
  options: {
    storePath?: string;
    enabled?: boolean;
    conflictStrategy?: FederationConflictStrategy;
    nodeId?: string;
    skillDepsBlockSync?: boolean;
    skillDepsPruneSync?: boolean;
    skillDepsPruneStrategy?: SkillDepPruneStrategy;
  } = {},
): number {
  if (newCards.length === 0) return 0;
  const local = loadFederatedAgentCards(options.storePath);
  const { merged, added, conflicts } = mergeCardsWithConflictStrategy(
    local,
    newCards,
    options.conflictStrategy ?? "newest-wins",
  );
  const depReconcile = reconcileFederationSkillDependencies(merged, {
    prune: options.skillDepsPruneSync !== false,
    block: options.skillDepsBlockSync !== false,
    pruneStrategy: options.skillDepsPruneStrategy,
  });
  if (depReconcile.blocked) {
    console.warn(
      `[federation] skill dep cycle blocked merge: ${depReconcile.cycle?.join(" -> ")}`,
    );
    return 0;
  }
  const toPersist = depReconcile.cards;
  if (depReconcile.pruned.length > 0) {
    const receipt = appendSkillDepsPruneLog({
      source: "merge",
      pruned: depReconcile.pruned,
      strategy: options.skillDepsPruneStrategy,
      storePath: options.storePath,
    });
    console.warn(
      `[federation] pruned ${depReconcile.pruned.length} cyclic skill dep(s) on merge receipt=${receipt?.receiptId ?? "n/a"}`,
    );
  }
  if (added > 0 || conflicts > 0 || depReconcile.pruned.length > 0) {
    persistFederatedAgentCards(toPersist, options.storePath, options.nodeId);
  }
  return added + conflicts;
}
