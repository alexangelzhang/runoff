/**
 * P13 — Cross-agent skill dependency graph (CRDT metadata).
 */

import type { A2AAgentCard } from "./agent-card.js";
import { getActiveSkills } from "./federation-crdt.js";
import { getCardVector, vectorDominates } from "./federation-vector.js";

export const FEDERATION_SKILL_DEPS_KEY = "federationSkillDeps";

/** P18: per-agent prune strategy override (card metadata, CRDT-merged). */
export const FEDERATION_SKILL_DEPS_PRUNE_STRATEGY_KEY = "federationSkillDepsPruneStrategy";

/** Reference format: `agentId:skillId`. */
export type SkillDepRef = string;

export type SkillDependencyEdge = {
  from: SkillDepRef;
  to: SkillDepRef;
};

export type SkillDependencyGraph = {
  nodes: SkillDepRef[];
  edges: SkillDependencyEdge[];
};

export function parseSkillDepRef(ref: string): { agentId: string; skillId: string } | null {
  const idx = ref.indexOf(":");
  if (idx < 1) return null;
  const agentId = ref.slice(0, idx);
  const skillId = ref.slice(idx + 1);
  if (!agentId || !skillId) return null;
  return { agentId, skillId };
}

export function skillDepRef(agentId: string, skillId: string): SkillDepRef {
  return `${agentId}:${skillId}`;
}

export function getSkillDepsMap(card: A2AAgentCard): Record<string, SkillDepRef[]> {
  const raw = card.metadata?.[FEDERATION_SKILL_DEPS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, SkillDepRef[]> = {};
  for (const [skillId, refs] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(refs)) {
      out[skillId] = refs.filter((r): r is string => typeof r === "string");
    }
  }
  return out;
}

/** Build directed graph: edge dep -> dependent skill. */
export function buildSkillDependencyGraph(cards: A2AAgentCard[]): SkillDependencyGraph {
  const nodeSet = new Set<SkillDepRef>();
  const edges: SkillDependencyEdge[] = [];

  for (const card of cards) {
    const depsMap = getSkillDepsMap(card);
    for (const skill of getActiveSkills(card)) {
      const to = skillDepRef(card.agentId, skill.id);
      nodeSet.add(to);
      const refs = depsMap[skill.id] ?? [];
      for (const ref of refs) {
        if (!parseSkillDepRef(ref)) continue;
        nodeSet.add(ref);
        edges.push({ from: ref, to });
      }
    }
  }

  return { nodes: [...nodeSet], edges };
}

/** Detect cycle in skill dependency graph; returns cycle path or null. */
export function detectSkillDependencyCycle(graph: SkillDependencyGraph): SkillDepRef[] | null {
  const adj = new Map<SkillDepRef, SkillDepRef[]>();
  for (const n of graph.nodes) adj.set(n, []);
  for (const e of graph.edges) {
    const list = adj.get(e.from) ?? [];
    list.push(e.to);
    adj.set(e.from, list);
  }

  const state = new Map<SkillDepRef, 0 | 1 | 2>();
  let cycle: SkillDepRef[] | null = null;
  const stack: SkillDepRef[] = [];

  function dfs(u: SkillDepRef): void {
    if (cycle) return;
    state.set(u, 1);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      const st = state.get(v) ?? 0;
      if (st === 1) {
        const start = stack.indexOf(v);
        cycle = [...stack.slice(start), v];
        return;
      }
      if (st === 0) dfs(v);
    }
    stack.pop();
    state.set(u, 2);
  }

  for (const n of graph.nodes) {
    if ((state.get(n) ?? 0) === 0) dfs(n);
    if (cycle) break;
  }
  return cycle;
}

/** Merge skill dep maps (union per skill id). */
export function mergeSkillDepsMap(
  a: Record<string, SkillDepRef[]>,
  b: Record<string, SkillDepRef[]>,
): Record<string, SkillDepRef[]> {
  const out = { ...a };
  for (const [skillId, refs] of Object.entries(b)) {
    out[skillId] = [...new Set([...(out[skillId] ?? []), ...refs])];
  }
  return out;
}

export function mergeSkillDepsOnCard(cardA: A2AAgentCard, cardB: A2AAgentCard): A2AAgentCard {
  const merged = mergeSkillDepsMap(getSkillDepsMap(cardA), getSkillDepsMap(cardB));
  if (Object.keys(merged).length === 0) return cardA;
  return {
    ...cardA,
    metadata: { ...cardA.metadata, [FEDERATION_SKILL_DEPS_KEY]: merged },
  };
}

/** Set cross-agent deps for one skill on a card. */
export function setSkillDepsOnCard(
  card: A2AAgentCard,
  skillId: string,
  deps: SkillDepRef[],
): A2AAgentCard {
  const map = getSkillDepsMap(card);
  map[skillId] = [...new Set(deps)];
  return {
    ...card,
    metadata: { ...card.metadata, [FEDERATION_SKILL_DEPS_KEY]: map },
  };
}

/** P14: validate merged federation directory has no skill dependency cycle. */
export function validateFederationSkillDependencies(cards: A2AAgentCard[]): {
  valid: boolean;
  cycle?: SkillDepRef[];
} {
  const graph = buildSkillDependencyGraph(cards);
  const cycle = detectSkillDependencyCycle(graph);
  return cycle ? { valid: false, cycle } : { valid: true };
}

export type SkillDepPruneEntry = {
  dependent: SkillDepRef;
  removedDep: SkillDepRef;
};

/** P16: how to pick which edge to remove per cycle. */
export type SkillDepPruneStrategy = "last-edge" | "oldest-dep" | "min-edge";

const PRUNE_STRATEGIES: SkillDepPruneStrategy[] = ["last-edge", "oldest-dep", "min-edge"];

/** P19: lower rank = more conservative; conflicts resolve to min-edge. */
const PRUNE_STRATEGY_RANK: Record<SkillDepPruneStrategy, number> = {
  "min-edge": 0,
  "oldest-dep": 1,
  "last-edge": 2,
};

function cardTimestampForPruneMerge(card: A2AAgentCard): number {
  const raw = card.metadata?.federationUpdatedAt ?? card.metadata?.updatedAt;
  const t = typeof raw === "string" ? Date.parse(raw) : 0;
  return Number.isNaN(t) ? 0 : t;
}

let skillDepPruneStrategyRollback = false;

/** P22: when true, merge uses LWW rollback instead of conservative merge. */
export function configureSkillDepPruneStrategyRollback(enabled: boolean): void {
  skillDepPruneStrategyRollback = enabled;
}

export function isSkillDepPruneStrategyRollbackEnabled(): boolean {
  return skillDepPruneStrategyRollback;
}

/** P22: LWW undo — keep older replica's strategy on conflict. */
export function rollbackSkillDepPruneStrategyCrdt(
  priorA?: SkillDepPruneStrategy,
  priorB?: SkillDepPruneStrategy,
  cards?: { a: A2AAgentCard; b: A2AAgentCard },
): SkillDepPruneStrategy | undefined {
  if (!priorA) return priorB;
  if (!priorB) return priorA;
  if (!cards) return priorA;
  return cardTimestampForPruneMerge(cards.a) <= cardTimestampForPruneMerge(cards.b)
    ? priorA
    : priorB;
}

/** P19/P20: CRDT merge for prune strategy (conservative rank, then vector tie-break). */
export function mergeSkillDepPruneStrategyCrdt(
  a?: SkillDepPruneStrategy,
  b?: SkillDepPruneStrategy,
  cards?: { a: A2AAgentCard; b: A2AAgentCard },
): SkillDepPruneStrategy | undefined {
  if (!a) return b;
  if (!b) return a;
  const rankA = PRUNE_STRATEGY_RANK[a];
  const rankB = PRUNE_STRATEGY_RANK[b];
  if (rankA < rankB) return a;
  if (rankB < rankA) return b;
  if (cards) {
    const va = getCardVector(cards.a);
    const vb = getCardVector(cards.b);
    if (vectorDominates(va, vb)) return a;
    if (vectorDominates(vb, va)) return b;
    return cardTimestampForPruneMerge(cards.a) >= cardTimestampForPruneMerge(cards.b) ? a : b;
  }
  return a;
}

/** P22: merge or LWW rollback per process configuration. */
export function reconcileSkillDepPruneStrategyCrdt(
  priorA: SkillDepPruneStrategy | undefined,
  priorB: SkillDepPruneStrategy | undefined,
  cards?: { a: A2AAgentCard; b: A2AAgentCard },
): SkillDepPruneStrategy | undefined {
  if (skillDepPruneStrategyRollback) {
    return rollbackSkillDepPruneStrategyCrdt(priorA, priorB, cards);
  }
  return mergeSkillDepPruneStrategyCrdt(priorA, priorB, cards);
}

export function getAgentSkillDepPruneStrategy(
  cards: A2AAgentCard[],
  agentId: string,
): SkillDepPruneStrategy | undefined {
  const card = cards.find((c) => c.agentId === agentId);
  const raw = card?.metadata?.[FEDERATION_SKILL_DEPS_PRUNE_STRATEGY_KEY];
  return PRUNE_STRATEGIES.includes(raw as SkillDepPruneStrategy)
    ? (raw as SkillDepPruneStrategy)
    : undefined;
}

/** P18: agent metadata overrides global federation prune strategy. */
export function resolveSkillDepPruneStrategy(
  cards: A2AAgentCard[],
  dependent: SkillDepRef,
  global: SkillDepPruneStrategy = "last-edge",
): SkillDepPruneStrategy {
  const parsed = parseSkillDepRef(dependent);
  if (!parsed) return global;
  return getAgentSkillDepPruneStrategy(cards, parsed.agentId) ?? global;
}

export function setAgentSkillDepPruneStrategy(
  card: A2AAgentCard,
  strategy: SkillDepPruneStrategy,
): A2AAgentCard {
  return {
    ...card,
    metadata: { ...card.metadata, [FEDERATION_SKILL_DEPS_PRUNE_STRATEGY_KEY]: strategy },
  };
}

function skillCardTimestamp(card: A2AAgentCard): number {
  const raw = card.metadata?.federationUpdatedAt ?? card.metadata?.updatedAt;
  const t = typeof raw === "string" ? Date.parse(raw) : 0;
  return Number.isNaN(t) ? 0 : t;
}

function cycleEdges(cycle: SkillDepRef[]): Array<{ dependent: SkillDepRef; removedDep: SkillDepRef }> {
  const edges: Array<{ dependent: SkillDepRef; removedDep: SkillDepRef }> = [];
  for (let i = 1; i < cycle.length; i++) {
    edges.push({ dependent: cycle[i]!, removedDep: cycle[i - 1]! });
  }
  return edges;
}

function pickSkillDepPruneEdgeWithStrategy(
  edges: Array<{ dependent: SkillDepRef; removedDep: SkillDepRef }>,
  cards: A2AAgentCard[],
  strategy: SkillDepPruneStrategy,
): { dependent: SkillDepRef; removedDep: SkillDepRef } {
  if (strategy === "last-edge") {
    return edges[edges.length - 1]!;
  }
  if (strategy === "oldest-dep") {
    let pick = edges[0]!;
    let oldestTs = Infinity;
    for (const e of edges) {
      const parsed = parseSkillDepRef(e.removedDep);
      if (!parsed) continue;
      const card = cards.find((c) => c.agentId === parsed.agentId);
      const ts = card ? skillCardTimestamp(card) : Infinity;
      if (ts < oldestTs) {
        oldestTs = ts;
        pick = e;
      }
    }
    return pick;
  }
  let pick = edges[0]!;
  let minCount = Infinity;
  for (const e of edges) {
    const parsed = parseSkillDepRef(e.dependent);
    if (!parsed) continue;
    const card = cards.find((c) => c.agentId === parsed.agentId);
    const count = card ? (getSkillDepsMap(card)[parsed.skillId]?.length ?? 0) : 0;
    if (count < minCount) {
      minCount = count;
      pick = e;
    }
  }
  return pick;
}

/** P16/P18: pick edge to prune from a cycle path (per-agent strategy when unambiguous). */
export function pickSkillDepPruneEdge(
  cycle: SkillDepRef[],
  cards: A2AAgentCard[],
  globalStrategy: SkillDepPruneStrategy = "last-edge",
): { dependent: SkillDepRef; removedDep: SkillDepRef } {
  const edges = cycleEdges(cycle);
  if (!edges.length) {
    return {
      dependent: cycle[cycle.length - 1]!,
      removedDep: cycle[cycle.length - 2]!,
    };
  }
  const overrideEdges = edges.filter((e) => {
    const parsed = parseSkillDepRef(e.dependent);
    return parsed ? getAgentSkillDepPruneStrategy(cards, parsed.agentId) !== undefined : false;
  });
  const strategy =
    overrideEdges.length === 1
      ? resolveSkillDepPruneStrategy(cards, overrideEdges[0]!.dependent, globalStrategy)
      : globalStrategy;
  const pool = overrideEdges.length === 1 ? overrideEdges : edges;
  return pickSkillDepPruneEdgeWithStrategy(pool, cards, strategy);
}

/** P15: remove cyclic skill deps (one edge per cycle) instead of blocking whole merge. */
export function pruneSkillDependencyCycles(
  cards: A2AAgentCard[],
  strategy: SkillDepPruneStrategy = "last-edge",
): {
  cards: A2AAgentCard[];
  pruned: SkillDepPruneEntry[];
} {
  let current = cards;
  const pruned: SkillDepPruneEntry[] = [];

  for (let guard = 0; guard < 64; guard++) {
    const check = validateFederationSkillDependencies(current);
    if (check.valid || !check.cycle?.length) break;

    const { dependent, removedDep } = pickSkillDepPruneEdge(check.cycle, current, strategy);
    const parsed = parseSkillDepRef(dependent);
    if (!parsed) break;

    current = current.map((card) => {
      if (card.agentId !== parsed.agentId) return card;
      const map = { ...getSkillDepsMap(card) };
      const refs = map[parsed.skillId];
      if (!refs?.includes(removedDep)) return card;
      map[parsed.skillId] = refs.filter((r) => r !== removedDep);
      pruned.push({ dependent, removedDep });
      return {
        ...card,
        metadata: { ...card.metadata, [FEDERATION_SKILL_DEPS_KEY]: map },
      };
    });
  }

  return { cards: current, pruned };
}

/** Prune when invalid; otherwise return input unchanged. */
export function reconcileFederationSkillDependencies(
  cards: A2AAgentCard[],
  options: {
    prune?: boolean;
    block?: boolean;
    pruneStrategy?: SkillDepPruneStrategy;
  } = {},
): {
  cards: A2AAgentCard[];
  blocked: boolean;
  cycle?: SkillDepRef[];
  pruned: SkillDepPruneEntry[];
} {
  const check = validateFederationSkillDependencies(cards);
  if (check.valid) return { cards, blocked: false, pruned: [] };

  if (options.prune !== false) {
    const result = pruneSkillDependencyCycles(cards, options.pruneStrategy ?? "last-edge");
    return { cards: result.cards, blocked: false, pruned: result.pruned };
  }
  if (options.block !== false) {
    return { cards, blocked: true, cycle: check.cycle, pruned: [] };
  }
  return { cards, blocked: false, cycle: check.cycle, pruned: [] };
}
