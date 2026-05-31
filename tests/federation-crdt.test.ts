import assert from "node:assert/strict";
import test from "node:test";
import type { A2AAgentCard } from "../src/orchestration/a2a/agent-card.ts";
import {
  createAgentCardTombstone,
  filterActiveAgentCards,
  mergeAgentCardCrdt,
  mergeCardsCrdt,
} from "../src/orchestration/a2a/federation-crdt.ts";

function card(id: string, name: string, vector: Record<string, number>): A2AAgentCard {
  return {
    agentId: id,
    name,
    description: "d",
    role: "worker",
    capabilities: ["implement"],
    skills: [{ id: "s1", name: "s", description: "d" }],
    protocolVersion: "0.1",
    metadata: { federationVector: vector, federationUpdatedAt: "2026-01-01T00:00:00.000Z" },
  };
}

test("mergeAgentCardCrdt merges vectors and picks newer name", () => {
  const a = card("x", "old", { nodeA: 1 });
  const b = {
    ...card("x", "new", { nodeA: 2 }),
    metadata: { federationVector: { nodeA: 2 }, federationUpdatedAt: "2026-06-01T00:00:00.000Z" },
  };
  const m = mergeAgentCardCrdt(a, b);
  assert.equal(m.name, "new");
  assert.equal((m.metadata?.federationVector as Record<string, number>).nodeA, 2);
});

test("createAgentCardTombstone and filterActiveAgentCards", () => {
  const tomb = createAgentCardTombstone("gone", "node-a", card("gone", "x", {}));
  assert.equal(tomb.metadata?.federationTombstone, true);
  const active = filterActiveAgentCards([tomb, card("ok", "y", {})]);
  assert.equal(active.length, 1);
  assert.equal(active[0]!.agentId, "ok");
});

test("mergeCardsCrdt propagates tombstones", () => {
  const tomb = createAgentCardTombstone("gone", "node-b", card("gone", "old", { n: 1 }));
  const { merged, tombstones } = mergeCardsCrdt([card("gone", "old", { n: 1 })], [tomb]);
  assert.equal(tombstones, 1);
  assert.equal(merged[0]!.metadata?.federationTombstone, true);
});

test("mergeCardsCrdt merges directories", () => {
  const local = [card("a", "local", { n: 1 })];
  const incoming = [
    {
      ...card("a", "remote", { n: 2 }),
      metadata: { federationVector: { n: 2 }, federationUpdatedAt: "2026-07-01T00:00:00.000Z" },
    },
    card("b", "b", { n: 1 }),
  ];
  const { merged, added, conflicts } = mergeCardsCrdt(local, incoming);
  assert.equal(added, 1);
  assert.equal(conflicts, 1);
  assert.equal(merged.length, 2);
});
