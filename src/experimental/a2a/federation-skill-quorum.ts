/**
 * P12 — Skill-level quorum filter for federation directory merge.
 */

import type { A2AAgentCard, A2ASkill } from "./agent-card.js";
import { getActiveSkills, getSkillTombstoneMap } from "./federation-crdt.js";
import { resolveFederationQuorumMin } from "./federation-quorum.js";

/** Count how many peer directories list each skill id for an agent. */
export function countSkillPeerVotes(
  agentId: string,
  peerDirectories: A2AAgentCard[][],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const dir of peerDirectories) {
    const card = dir.find((c) => c.agentId === agentId);
    if (!card) continue;
    const seen = new Set<string>();
    for (const skill of getActiveSkills(card)) {
      if (seen.has(skill.id)) continue;
      seen.add(skill.id);
      counts.set(skill.id, (counts.get(skill.id) ?? 0) + 1);
    }
  }
  return counts;
}

/** Keep only skills seen on >= quorumMin peer directories. */
export function filterSkillsByPeerQuorum(
  card: A2AAgentCard,
  peerDirectories: A2AAgentCard[][],
  quorumMin: number,
): A2AAgentCard {
  if (quorumMin <= 1) return card;
  const votes = countSkillPeerVotes(card.agentId, peerDirectories);
  const skills = card.skills.filter((s) => (votes.get(s.id) ?? 0) >= quorumMin);
  const tombs = getSkillTombstoneMap(card);
  const filteredTombs: Record<string, string> = {};
  for (const [id, ts] of Object.entries(tombs)) {
    if ((votes.get(id) ?? 0) >= quorumMin) filteredTombs[id] = ts;
  }
  const metadata = { ...card.metadata };
  if (Object.keys(filteredTombs).length === 0) {
    delete metadata.federationSkillTombstones;
  } else {
    metadata.federationSkillTombstones = filteredTombs;
  }
  return { ...card, skills, metadata };
}

/** Apply skill quorum to all cards in a merged directory. */
export function applySkillQuorumToDirectory(
  cards: A2AAgentCard[],
  peerDirectories: A2AAgentCard[][],
  configuredQuorum?: number,
): { cards: A2AAgentCard[]; quorumMin: number; skillsDropped: number } {
  const quorumMin = resolveFederationQuorumMin(peerDirectories.length, configuredQuorum);
  if (quorumMin <= 1 || peerDirectories.length === 0) {
    return { cards, quorumMin, skillsDropped: 0 };
  }

  let skillsDropped = 0;
  const out = cards.map((card) => {
    const before = card.skills.length;
    const filtered = filterSkillsByPeerQuorum(card, peerDirectories, quorumMin);
    skillsDropped += Math.max(0, before - filtered.skills.length);
    return filtered;
  });
  return { cards: out, quorumMin, skillsDropped };
}

/** Merge skill lists from quorum-qualified peers only (union of quorum-passing skills). */
export function mergeSkillsWithQuorum(
  local: A2ASkill[],
  peerDirectories: A2AAgentCard[][],
  agentId: string,
  quorumMin: number,
): A2ASkill[] {
  if (quorumMin <= 1) return local;
  const votes = countSkillPeerVotes(agentId, peerDirectories);
  const byId = new Map<string, A2ASkill>();
  for (const skill of local) {
    if ((votes.get(skill.id) ?? 0) >= quorumMin) byId.set(skill.id, skill);
  }
  for (const dir of peerDirectories) {
    const card = dir.find((c) => c.agentId === agentId);
    if (!card) continue;
    for (const skill of getActiveSkills(card)) {
      if ((votes.get(skill.id) ?? 0) >= quorumMin) {
        byId.set(skill.id, skill);
      }
    }
  }
  return [...byId.values()];
}
