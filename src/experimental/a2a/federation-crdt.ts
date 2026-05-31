/**
 * P7 — Operational CRDT merge for A2A agent cards (vector + LWW + skill union).
 */

import type { A2AAgentCard, A2ASkill } from "./agent-card.js";
import { appendSkillDepPruneStrategyAudit } from "./federation-skill-deps-audit.js";
import {
  FEDERATION_SKILL_DEPS_KEY,
  FEDERATION_SKILL_DEPS_PRUNE_STRATEGY_KEY,
  reconcileSkillDepPruneStrategyCrdt,
  rollbackSkillDepPruneStrategyCrdt,
  mergeSkillDepsMap,
  type SkillDepPruneStrategy,
} from "./federation-skill-deps.js";
import {
  bumpCardVector,
  getCardVector,
  mergeVectors,
  pickVectorWinner,
  vectorDominates,
  type FederationVector,
} from "./federation-vector.js";

const TOMBSTONE_KEY = "federationTombstone";
const DELETED_AT_KEY = "federationDeletedAt";
const SKILL_TOMBSTONES_KEY = "federationSkillTombstones";
const VECTOR_KEY = "federationVector";

/** Scalar/card fields merged with LWW when using crdt-merge. */
export const FEDERATION_CRDT_CARD_FIELDS = [
  "name",
  "description",
  "role",
  "protocolVersion",
  "endpoint",
] as const;

export function isCardTombstoned(card: A2AAgentCard): boolean {
  return card.metadata?.[TOMBSTONE_KEY] === true;
}

export function filterActiveAgentCards(cards: A2AAgentCard[]): A2AAgentCard[] {
  return cards.filter((c) => !isCardTombstoned(c));
}

export function getSkillTombstoneMap(card: A2AAgentCard): Record<string, string> {
  const raw = card.metadata?.[SKILL_TOMBSTONES_KEY];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, string>;
  }
  return {};
}

export function isSkillTombstoned(card: A2AAgentCard, skillId: string): boolean {
  return skillId in getSkillTombstoneMap(card);
}

/** Skills not marked deleted in card metadata. */
export function getActiveSkills(card: A2AAgentCard): A2ASkill[] {
  const tombs = getSkillTombstoneMap(card);
  return card.skills.filter((s) => !(s.id in tombs));
}

/** Card with skill-level tombstones applied for registry/discovery. */
export function cardWithActiveSkills(card: A2AAgentCard): A2AAgentCard {
  const active = getActiveSkills(card);
  if (active.length === card.skills.length) return card;
  return { ...card, skills: active };
}

/** Tombstone one skill on an agent card (CRDT partial delete). */
export function tombstoneSkillOnCard(
  card: A2AAgentCard,
  skillId: string,
  nodeId: string,
): A2AAgentCard {
  const tombs = {
    ...getSkillTombstoneMap(card),
    [skillId]: new Date().toISOString(),
  };
  const skills = card.skills.filter((s) => s.id !== skillId);
  return bumpCardVector(
    {
      ...card,
      skills,
      metadata: { ...card.metadata, [SKILL_TOMBSTONES_KEY]: tombs },
    },
    nodeId,
  );
}

function mergeSkillTombstoneMaps(
  cardA: A2AAgentCard,
  cardB: A2AAgentCard,
): Record<string, string> {
  const a = getSkillTombstoneMap(cardA);
  const b = getSkillTombstoneMap(cardB);
  const out = { ...a };
  for (const [id, ts] of Object.entries(b)) {
    if (!(id in out)) {
      out[id] = ts;
      continue;
    }
    const pickB = Date.parse(ts) >= Date.parse(out[id]!);
    out[id] = pickB ? ts : out[id]!;
  }
  return out;
}

/** Build a tombstone card for CRDT deletion propagation. */
export function createAgentCardTombstone(
  agentId: A2AAgentCard["agentId"],
  nodeId: string,
  existing?: A2AAgentCard,
): A2AAgentCard {
  const base: A2AAgentCard = existing ?? {
    agentId,
    name: agentId,
    description: "removed",
    role: "worker",
    capabilities: ["implement"],
    skills: [],
    protocolVersion: "0.1",
  };
  return bumpCardVector(
    {
      ...base,
      metadata: {
        ...base.metadata,
        [TOMBSTONE_KEY]: true,
        [DELETED_AT_KEY]: new Date().toISOString(),
      },
    },
    nodeId,
  );
}

function mergeAuthCrdt(
  a: A2AAgentCard["auth"],
  b: A2AAgentCard["auth"],
  cardA: A2AAgentCard,
  cardB: A2AAgentCard,
): A2AAgentCard["auth"] {
  if (!a) return b;
  if (!b) return a;
  const pickA = cardTimestamp(cardA) >= cardTimestamp(cardB);
  const chosen = pickA ? a : b;
  const other = pickA ? b : a;
  return {
    type: lwwPick(a.type, b.type, cardA, cardB),
    config: { ...(other.config ?? {}), ...(chosen.config ?? {}) },
  };
}

function cardTimestamp(card: A2AAgentCard): number {
  const raw = card.metadata?.federationUpdatedAt ?? card.metadata?.updatedAt;
  if (typeof raw === "string") {
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return t;
  }
  if (typeof raw === "number") return raw;
  return 0;
}

function lwwPick<T>(a: T, b: T, cardA: A2AAgentCard, cardB: A2AAgentCard): T {
  return cardTimestamp(cardA) >= cardTimestamp(cardB) ? a : b;
}

function mergeSkillsCrdt(a: A2ASkill[], b: A2ASkill[]): A2ASkill[] {
  const byId = new Map<string, A2ASkill>();
  for (const s of [...a, ...b]) {
    const prev = byId.get(s.id);
    if (!prev) {
      byId.set(s.id, s);
      continue;
    }
    byId.set(s.id, {
      ...prev,
      ...s,
      tags: [...new Set([...(prev.tags ?? []), ...(s.tags ?? [])])],
    });
  }
  return [...byId.values()];
}

function mergeSkillsWithTombstones(cardA: A2AAgentCard, cardB: A2AAgentCard): A2ASkill[] {
  const tombMap = mergeSkillTombstoneMaps(cardA, cardB);
  const merged = mergeSkillsCrdt(cardA.skills, cardB.skills);
  return merged.filter((s) => !(s.id in tombMap));
}

function mergeMetadataCrdt(
  cardA: A2AAgentCard,
  cardB: A2AAgentCard,
  vector: FederationVector,
): Record<string, unknown> {
  const a = cardA.metadata ?? {};
  const b = cardB.metadata ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: Record<string, unknown> = {
    [VECTOR_KEY]: vector,
    federationUpdatedAt: new Date(Math.max(cardTimestamp(cardA), cardTimestamp(cardB))).toISOString(),
  };

  const tombA = a[TOMBSTONE_KEY] === true;
  const tombB = b[TOMBSTONE_KEY] === true;
  if (tombA || tombB) {
    const va = getCardVector(cardA);
    const vb = getCardVector(cardB);
    const tombWinner =
      tombA && tombB
        ? vectorDominates(va, vb)
          ? cardA
          : vectorDominates(vb, va)
            ? cardB
            : cardTimestamp(cardA) >= cardTimestamp(cardB)
              ? cardA
              : cardB
        : tombA
          ? cardA
          : cardB;
    out[TOMBSTONE_KEY] = true;
    out[DELETED_AT_KEY] =
      tombWinner.metadata?.[DELETED_AT_KEY] ?? new Date().toISOString();
  }

  const skillTombs = mergeSkillTombstoneMaps(cardA, cardB);
  if (Object.keys(skillTombs).length > 0) {
    out[SKILL_TOMBSTONES_KEY] = skillTombs;
  }

  const depsMerged = mergeSkillDepsMap(
    (a[FEDERATION_SKILL_DEPS_KEY] as Record<string, string[]>) ?? {},
    (b[FEDERATION_SKILL_DEPS_KEY] as Record<string, string[]>) ?? {},
  );
  if (Object.keys(depsMerged).length > 0) {
    out[FEDERATION_SKILL_DEPS_KEY] = depsMerged;
  }

  const priorStratA = a[FEDERATION_SKILL_DEPS_PRUNE_STRATEGY_KEY] as
    | SkillDepPruneStrategy
    | undefined;
  const priorStratB = b[FEDERATION_SKILL_DEPS_PRUNE_STRATEGY_KEY] as
    | SkillDepPruneStrategy
    | undefined;
  const stratMerged = reconcileSkillDepPruneStrategyCrdt(priorStratA, priorStratB, {
    a: cardA,
    b: cardB,
  });
  if (
    priorStratA &&
    priorStratB &&
    priorStratA !== priorStratB &&
    stratMerged
  ) {
    appendSkillDepPruneStrategyAudit({
      agentId: cardA.agentId,
      priorA: priorStratA,
      priorB: priorStratB,
      merged: stratMerged,
      rollbackTarget: rollbackSkillDepPruneStrategyCrdt(priorStratA, priorStratB, {
        a: cardA,
        b: cardB,
      })!,
    });
  }
  if (stratMerged) {
    out[FEDERATION_SKILL_DEPS_PRUNE_STRATEGY_KEY] = stratMerged;
  }

  for (const key of keys) {
    if (
      key === VECTOR_KEY ||
      key === TOMBSTONE_KEY ||
      key === DELETED_AT_KEY ||
      key === SKILL_TOMBSTONES_KEY ||
      key === FEDERATION_SKILL_DEPS_KEY ||
      key === FEDERATION_SKILL_DEPS_PRUNE_STRATEGY_KEY
    ) {
      continue;
    }
    const av = a[key];
    const bv = b[key];
    if (av === undefined) out[key] = bv;
    else if (bv === undefined) out[key] = av;
    else out[key] = cardTimestamp(cardA) >= cardTimestamp(cardB) ? av : bv;
  }
  return out;
}

/** Field-wise merge of two cards (assumes same agentId). */
export function mergeAgentCardCrdt(a: A2AAgentCard, b: A2AAgentCard): A2AAgentCard {
  if (a.agentId !== b.agentId) {
    return pickVectorWinner(a, b);
  }

  if (isCardTombstoned(a) && isCardTombstoned(b)) {
    return pickVectorWinner(a, b);
  }

  const vector = mergeVectors(getCardVector(a), getCardVector(b));

  return {
    agentId: a.agentId,
    name: lwwPick(a.name, b.name, a, b),
    description: lwwPick(a.description, b.description, a, b),
    role: lwwPick(a.role, b.role, a, b),
    capabilities: [
      ...new Set([...a.capabilities, ...b.capabilities]),
    ] as A2AAgentCard["capabilities"],
    skills: mergeSkillsWithTombstones(a, b),
    protocolVersion: lwwPick(a.protocolVersion, b.protocolVersion, a, b),
    endpoint: cardTimestamp(a) >= cardTimestamp(b) ? a.endpoint : b.endpoint,
    auth: mergeAuthCrdt(a.auth, b.auth, a, b),
    metadata: mergeMetadataCrdt(a, b, vector),
  };
}

export type FederationCrdtMergeResult = {
  merged: A2AAgentCard[];
  conflicts: number;
  added: number;
  tombstones: number;
};

/** Merge incoming directory into local using CRDT operator per agentId. */
export function mergeCardsCrdt(
  local: A2AAgentCard[],
  incoming: A2AAgentCard[],
): FederationCrdtMergeResult {
  const byId = new Map(local.map((c) => [c.agentId, c]));
  let conflicts = 0;
  let added = 0;
  let tombstones = 0;

  for (const card of incoming) {
    const existing = byId.get(card.agentId);
    if (!existing) {
      byId.set(card.agentId, card);
      added++;
      if (isCardTombstoned(card)) tombstones++;
      continue;
    }
    conflicts++;
    const merged = mergeAgentCardCrdt(existing, card);
    byId.set(card.agentId, merged);
    if (isCardTombstoned(merged)) tombstones++;
  }

  return { merged: [...byId.values()], conflicts, added, tombstones };
}
