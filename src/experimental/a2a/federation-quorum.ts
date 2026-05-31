/**
 * P5 — Quorum filter for multi-peer federation directory merge.
 */

import type { A2AAgentCard } from "./agent-card.js";

/** Effective quorum (1 … peerCount). Default 1 = no quorum gate. */
export function resolveFederationQuorumMin(peerCount: number, configured?: number): number {
  if (peerCount <= 0) return 1;
  const min = configured ?? 1;
  if (!Number.isFinite(min) || min < 1) return 1;
  return Math.min(Math.floor(min), peerCount);
}

/**
 * Keep cards whose agentId appears in at least `quorumMin` distinct peer directories.
 * When quorumMin <= 1, returns the union (last peer wins per id).
 */
export function filterCardsByPeerQuorum(
  peerDirectories: A2AAgentCard[][],
  quorumMin: number,
): A2AAgentCard[] {
  if (peerDirectories.length === 0) return [];
  if (quorumMin <= 1) {
    const byId = new Map<string, A2AAgentCard>();
    for (const dir of peerDirectories) {
      for (const card of dir) byId.set(card.agentId, card);
    }
    return [...byId.values()];
  }

  const counts = new Map<string, number>();
  const latest = new Map<string, A2AAgentCard>();

  for (const dir of peerDirectories) {
    const seenInPeer = new Set<string>();
    for (const card of dir) {
      if (seenInPeer.has(card.agentId)) continue;
      seenInPeer.add(card.agentId);
      counts.set(card.agentId, (counts.get(card.agentId) ?? 0) + 1);
      latest.set(card.agentId, card);
    }
  }

  const out: A2AAgentCard[] = [];
  for (const [id, count] of counts) {
    if (count >= quorumMin) {
      const card = latest.get(id);
      if (card) out.push(card);
    }
  }
  return out;
}
