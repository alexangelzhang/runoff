import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import type { A2AAgentCard } from "../../src/experimental/a2a/agent-card.ts";
import { mergeAgentCardCrdt } from "../../src/experimental/a2a/federation-crdt.ts";
import {
  applySkillDepPruneStrategyRollbackForAgent,
  configureSkillDepPruneStrategyAuditStore,
} from "../../src/experimental/a2a/federation-skill-deps-audit.ts";
import { readLeaseAuditChain } from "../../src/experimental/a2a/federation-lease-audit.ts";
import { bumpCardVector } from "../../src/experimental/a2a/federation-vector.ts";
import {
  buildSkillDependencyGraph,
  detectSkillDependencyCycle,
  FEDERATION_SKILL_DEPS_KEY,
  getSkillDepsMap,
  setSkillDepsOnCard,
  skillDepRef,
  validateFederationSkillDependencies,
  pruneSkillDependencyCycles,
  reconcileFederationSkillDependencies,
  pickSkillDepPruneEdge,
  setAgentSkillDepPruneStrategy,
  mergeSkillDepPruneStrategyCrdt,
  rollbackSkillDepPruneStrategyCrdt,
  reconcileSkillDepPruneStrategyCrdt,
  configureSkillDepPruneStrategyRollback,
  isSkillDepPruneStrategyRollbackEnabled,
  FEDERATION_SKILL_DEPS_PRUNE_STRATEGY_KEY,
} from "../../src/experimental/a2a/federation-skill-deps.ts";
import {
  loadFederatedAgentCards,
  persistFederatedAgentCards,
} from "../../src/experimental/a2a/federated-registry-store.ts";
import { mergeRemoteCardsIntoFederationStore } from "../../src/experimental/a2a/federation-sync.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testHome: string;
before(() => {
  testHome = mkdtempSync(join(tmpdir(), "runoff-home-"));
  process.env.RUNOFF_HOME = testHome;
});
after(() => {
  delete process.env.RUNOFF_HOME;
  rmSync(testHome, { recursive: true, force: true });
});

function card(agentId: string, skills: string[], deps?: Record<string, string[]>): A2AAgentCard {
  return {
    agentId,
    name: agentId,
    description: "",
    role: "worker",
    capabilities: ["text"],
    skills: skills.map((id) => ({ id, name: id })),
    protocolVersion: "0.3",
    endpoint: `http://${agentId}`,
    metadata: deps ? { [FEDERATION_SKILL_DEPS_KEY]: deps, federationUpdatedAt: "2026-01-01T00:00:00.000Z" } : { federationUpdatedAt: "2026-01-01T00:00:00.000Z" },
  };
}

test("buildSkillDependencyGraph links cross-agent refs", () => {
  const a = setSkillDepsOnCard(card("agent-a", ["s1"]), "s1", [skillDepRef("agent-b", "s2")]);
  const b = card("agent-b", ["s2"]);
  const graph = buildSkillDependencyGraph([a, b]);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0]!.from, skillDepRef("agent-b", "s2"));
  assert.equal(graph.edges[0]!.to, skillDepRef("agent-a", "s1"));
});

test("detectSkillDependencyCycle finds cycle", () => {
  const a = setSkillDepsOnCard(card("agent-a", ["s1"]), "s1", [skillDepRef("agent-b", "s2")]);
  const b = setSkillDepsOnCard(card("agent-b", ["s2"]), "s2", [skillDepRef("agent-a", "s1")]);
  const graph = buildSkillDependencyGraph([a, b]);
  const cycle = detectSkillDependencyCycle(graph);
  assert.ok(cycle && cycle.length >= 2);
});

test("validateFederationSkillDependencies rejects cycle", () => {
  const a = setSkillDepsOnCard(card("agent-a", ["s1"]), "s1", [skillDepRef("agent-b", "s2")]);
  const b = setSkillDepsOnCard(card("agent-b", ["s2"]), "s2", [skillDepRef("agent-a", "s1")]);
  const v = validateFederationSkillDependencies([a, b]);
  assert.equal(v.valid, false);
  assert.ok(v.cycle?.length);
});

test("pruneSkillDependencyCycles removes one edge per cycle", () => {
  const a = setSkillDepsOnCard(card("agent-a", ["s1"]), "s1", [skillDepRef("agent-b", "s2")]);
  const b = setSkillDepsOnCard(card("agent-b", ["s2"]), "s2", [skillDepRef("agent-a", "s1")]);
  const result = pruneSkillDependencyCycles([a, b]);
  assert.equal(result.pruned.length, 1);
  assert.equal(validateFederationSkillDependencies(result.cards).valid, true);
});

test("mergeRemoteCardsIntoFederationStore prunes cyclic skill deps by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-deps-prune-"));
  const storePath = join(dir, "agents.json");
  try {
    persistFederatedAgentCards([card("agent-a", ["s1"])], storePath);
    const b = setSkillDepsOnCard(card("agent-b", ["s2"]), "s2", [skillDepRef("agent-a", "s1")]);
    const a2 = setSkillDepsOnCard(card("agent-a", ["s1"]), "s1", [skillDepRef("agent-b", "s2")]);
    const n = mergeRemoteCardsIntoFederationStore([b, a2], { storePath });
    assert.ok(n > 0);
    const loaded = loadFederatedAgentCards(storePath);
    assert.equal(validateFederationSkillDependencies(loaded).valid, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeRemoteCardsIntoFederationStore blocks when prune disabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-deps-block-"));
  const storePath = join(dir, "agents.json");
  try {
    persistFederatedAgentCards([card("agent-a", ["s1"])], storePath);
    const b = setSkillDepsOnCard(card("agent-b", ["s2"]), "s2", [skillDepRef("agent-a", "s1")]);
    const a2 = setSkillDepsOnCard(card("agent-a", ["s1"]), "s1", [skillDepRef("agent-b", "s2")]);
    const n = mergeRemoteCardsIntoFederationStore([b, a2], {
      storePath,
      skillDepsPruneSync: false,
      skillDepsBlockSync: true,
    });
    assert.equal(n, 0);
    const loaded = loadFederatedAgentCards(storePath);
    const mergedA = loaded.find((c) => c.agentId === "agent-a");
    assert.ok(mergedA);
    assert.equal((getSkillDepsMap(mergedA).s1 ?? []).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pickSkillDepPruneEdge oldest-dep prefers older source card", () => {
  const old = setSkillDepsOnCard(
    { ...card("agent-old", ["s-old"]), metadata: { federationUpdatedAt: "2020-01-01T00:00:00.000Z" } },
    "s-old",
    [],
  );
  const young = setSkillDepsOnCard(
    { ...card("agent-young", ["s-young"]), metadata: { federationUpdatedAt: "2026-01-01T00:00:00.000Z" } },
    "s-young",
    [skillDepRef("agent-old", "s-old")],
  );
  const mid = setSkillDepsOnCard(card("agent-mid", ["s-mid"]), "s-mid", [
    skillDepRef("agent-young", "s-young"),
  ]);
  const a = setSkillDepsOnCard(card("agent-a", ["s-a"]), "s-a", [skillDepRef("agent-mid", "s-mid")]);
  const cycle = [
    skillDepRef("agent-old", "s-old"),
    skillDepRef("agent-young", "s-young"),
    skillDepRef("agent-mid", "s-mid"),
    skillDepRef("agent-a", "s-a"),
    skillDepRef("agent-old", "s-old"),
  ];
  const pick = pickSkillDepPruneEdge(cycle, [old, young, mid, a], "oldest-dep");
  assert.equal(pick.removedDep, skillDepRef("agent-old", "s-old"));
});

test("reconcileFederationSkillDependencies prefers prune over block", () => {
  const a = setSkillDepsOnCard(card("agent-a", ["s1"]), "s1", [skillDepRef("agent-b", "s2")]);
  const b = setSkillDepsOnCard(card("agent-b", ["s2"]), "s2", [skillDepRef("agent-a", "s1")]);
  const r = reconcileFederationSkillDependencies([a, b], { prune: true, block: true });
  assert.equal(r.blocked, false);
  assert.equal(r.pruned.length, 1);
  assert.equal(validateFederationSkillDependencies(r.cards).valid, true);
});

test("pickSkillDepPruneEdge uses per-agent strategy override", () => {
  const old = setSkillDepsOnCard(
    { ...card("agent-old", ["s-old"]), metadata: { federationUpdatedAt: "2020-01-01T00:00:00.000Z" } },
    "s-old",
    [],
  );
  const young = setAgentSkillDepPruneStrategy(
    setSkillDepsOnCard(
      { ...card("agent-young", ["s-young"]), metadata: { federationUpdatedAt: "2026-01-01T00:00:00.000Z" } },
      "s-young",
      [skillDepRef("agent-old", "s-old")],
    ),
    "oldest-dep",
  );
  const cycle = [
    skillDepRef("agent-old", "s-old"),
    skillDepRef("agent-young", "s-young"),
    skillDepRef("agent-old", "s-old"),
  ];
  const pick = pickSkillDepPruneEdge(cycle, [old, young], "last-edge");
  assert.equal(pick.removedDep, skillDepRef("agent-old", "s-old"));
});

test("mergeSkillDepPruneStrategyCrdt picks min-edge on conflict", () => {
  assert.equal(mergeSkillDepPruneStrategyCrdt("last-edge", "min-edge"), "min-edge");
  assert.equal(mergeSkillDepPruneStrategyCrdt("oldest-dep", "last-edge"), "oldest-dep");
});

test("mergeAgentCardCrdt merges prune strategy to most conservative", () => {
  const a = setAgentSkillDepPruneStrategy(card("agent-a", ["s1"]), "last-edge");
  const b = setAgentSkillDepPruneStrategy(card("agent-a", ["s1"]), "min-edge");
  const merged = mergeAgentCardCrdt(a, b);
  assert.equal(merged.metadata?.[FEDERATION_SKILL_DEPS_PRUNE_STRATEGY_KEY], "min-edge");
});

test("mergeSkillDepPruneStrategyCrdt vector tie-break when rank ties", () => {
  let a = setAgentSkillDepPruneStrategy(card("agent-a", ["s1"]), "last-edge");
  let b = setAgentSkillDepPruneStrategy(card("agent-a", ["s1"]), "last-edge");
  a = bumpCardVector(a, "node-a");
  b = bumpCardVector(b, "node-b");
  a = {
    ...a,
    metadata: { ...a.metadata, federationVector: { "node-a": 5, "node-b": 2 } },
  };
  b = {
    ...b,
    metadata: { ...b.metadata, federationVector: { "node-b": 1, "node-a": 1 } },
  };
  const merged = mergeSkillDepPruneStrategyCrdt("last-edge", "last-edge", { a, b });
  assert.equal(merged, "last-edge");
  const mergedCard = mergeAgentCardCrdt(a, b);
  assert.equal(mergedCard.metadata?.[FEDERATION_SKILL_DEPS_PRUNE_STRATEGY_KEY], "last-edge");
});

test("rollbackSkillDepPruneStrategyCrdt keeps older replica strategy", () => {
  const older = setAgentSkillDepPruneStrategy(
    { ...card("agent-a", ["s1"]), metadata: { federationUpdatedAt: "2020-01-01T00:00:00.000Z" } },
    "last-edge",
  );
  const newer = setAgentSkillDepPruneStrategy(
    { ...card("agent-a", ["s1"]), metadata: { federationUpdatedAt: "2026-06-01T00:00:00.000Z" } },
    "min-edge",
  );
  const rolled = rollbackSkillDepPruneStrategyCrdt("last-edge", "min-edge", {
    a: older,
    b: newer,
  });
  assert.equal(rolled, "last-edge");
});

test("reconcileSkillDepPruneStrategyCrdt uses rollback mode when configured", () => {
  configureSkillDepPruneStrategyRollback(true);
  try {
    const older = { ...card("agent-a", ["s1"]), metadata: { federationUpdatedAt: "2020-01-01T00:00:00.000Z" } };
    const newer = { ...card("agent-a", ["s1"]), metadata: { federationUpdatedAt: "2026-06-01T00:00:00.000Z" } };
    const out = reconcileSkillDepPruneStrategyCrdt("min-edge", "last-edge", { a: older, b: newer });
    assert.equal(out, "min-edge");
  } finally {
    configureSkillDepPruneStrategyRollback(false);
  }
});

test("applySkillDepPruneStrategyRollbackForAgent keeps rollback mode on failure", () => {
  configureSkillDepPruneStrategyRollback(true);
  try {
    const applied = applySkillDepPruneStrategyRollbackForAgent({
      agentId: "ghost",
      storePath: "/nonexistent/agents.json",
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.reason, "no rollback audit");
    assert.equal(applied.reasonCode, "no_rollback_audit");
    assert.equal(isSkillDepPruneStrategyRollbackEnabled(), true);
  } finally {
    configureSkillDepPruneStrategyRollback(false);
  }
});

test("applySkillDepPruneStrategyRollbackForAgent keeps rollback mode when agent missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-strat-rollback-miss-"));
  const storePath = join(dir, "agents.json");
  try {
    configureSkillDepPruneStrategyAuditStore(storePath);
    configureSkillDepPruneStrategyRollback(true);
    const older = setAgentSkillDepPruneStrategy(
      { ...card("agent-a", ["s1"]), metadata: { federationUpdatedAt: "2020-01-01T00:00:00.000Z" } },
      "last-edge",
    );
    const newer = setAgentSkillDepPruneStrategy(
      { ...card("agent-a", ["s1"]), metadata: { federationUpdatedAt: "2026-06-01T00:00:00.000Z" } },
      "min-edge",
    );
    mergeAgentCardCrdt(older, newer);
    persistFederatedAgentCards([card("agent-b", ["s1"])], storePath);
    const applied = applySkillDepPruneStrategyRollbackForAgent({
      agentId: "agent-a",
      storePath,
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.reason, "agent not found");
    assert.equal(applied.reasonCode, "agent_not_found");
    assert.equal(isSkillDepPruneStrategyRollbackEnabled(), true);
  } finally {
    configureSkillDepPruneStrategyRollback(false);
    configureSkillDepPruneStrategyAuditStore(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applySkillDepPruneStrategyRollbackForAgent disables rollback mode on success", () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-strat-rollback-off-"));
  const storePath = join(dir, "agents.json");
  try {
    configureSkillDepPruneStrategyAuditStore(storePath);
    configureSkillDepPruneStrategyRollback(true);
    const older = setAgentSkillDepPruneStrategy(
      { ...card("agent-a", ["s1"]), metadata: { federationUpdatedAt: "2020-01-01T00:00:00.000Z" } },
      "last-edge",
    );
    const newer = setAgentSkillDepPruneStrategy(
      { ...card("agent-a", ["s1"]), metadata: { federationUpdatedAt: "2026-06-01T00:00:00.000Z" } },
      "min-edge",
    );
    const merged = mergeAgentCardCrdt(older, newer);
    persistFederatedAgentCards([merged], storePath);
    const applied = applySkillDepPruneStrategyRollbackForAgent({
      agentId: "agent-a",
      storePath,
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.strategy, "last-edge");
    assert.equal(applied.reasonCode, "applied");
    assert.equal(isSkillDepPruneStrategyRollbackEnabled(), false);
    const chain = readLeaseAuditChain(storePath);
    const rollbackEv = chain.events.find((e) => e.type === "skill_prune_strategy_rollback");
    assert.ok(rollbackEv);
    const detail = JSON.parse(rollbackEv!.detail ?? "{}") as {
      ok: boolean;
      reasonCode: string;
      strategy?: string;
    };
    assert.equal(detail.ok, true);
    assert.equal(detail.reasonCode, "applied");
    assert.equal(detail.strategy, "last-edge");
  } finally {
    configureSkillDepPruneStrategyRollback(false);
    configureSkillDepPruneStrategyAuditStore(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applySkillDepPruneStrategyRollbackForAgent audits failure reasonCode", () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-strat-rollback-audit-fail-"));
  const storePath = join(dir, "agents.json");
  try {
    configureSkillDepPruneStrategyAuditStore(storePath);
    const applied = applySkillDepPruneStrategyRollbackForAgent({
      agentId: "missing",
      storePath,
    });
    assert.equal(applied.reasonCode, "no_rollback_audit");
    const chain = readLeaseAuditChain(storePath);
    const ev = chain.events.find((e) => e.type === "skill_prune_strategy_rollback");
    assert.ok(ev);
    const detail = JSON.parse(ev!.detail ?? "{}") as { ok: boolean; reasonCode: string };
    assert.equal(detail.ok, false);
    assert.equal(detail.reasonCode, "no_rollback_audit");
  } finally {
    configureSkillDepPruneStrategyAuditStore(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeAgentCardCrdt appends skill_prune_strategy audit on conflict", () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-strat-audit-"));
  const storePath = join(dir, "agents.json");
  try {
    configureSkillDepPruneStrategyAuditStore(storePath);
    const a = setAgentSkillDepPruneStrategy(card("agent-a", ["s1"]), "last-edge");
    const b = setAgentSkillDepPruneStrategy(card("agent-a", ["s1"]), "min-edge");
    mergeAgentCardCrdt(a, b);
    const chain = readLeaseAuditChain(storePath);
    const ev = chain.events.find((e) => e.type === "skill_prune_strategy");
    assert.ok(ev);
    assert.equal(ev!.nodeId, "agent-a");
    const detail = JSON.parse(ev!.detail ?? "{}") as {
      merged: string;
      rollbackTarget: string;
    };
    assert.equal(detail.merged, "min-edge");
    assert.equal(detail.rollbackTarget, "last-edge");
  } finally {
    configureSkillDepPruneStrategyAuditStore(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeAgentCardCrdt unions skill deps", () => {
  const a = setSkillDepsOnCard(card("agent-a", ["s1"]), "s1", [skillDepRef("agent-b", "s2")]);
  const b = card("agent-a", ["s1"], { s1: [skillDepRef("agent-c", "s3")] });
  const merged = mergeAgentCardCrdt(a, b);
  const deps = merged.metadata?.[FEDERATION_SKILL_DEPS_KEY] as Record<string, string[]>;
  assert.deepEqual(new Set(deps.s1), new Set([skillDepRef("agent-b", "s2"), skillDepRef("agent-c", "s3")]));
});
