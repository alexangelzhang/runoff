import assert from "node:assert/strict";
import test from "node:test";
import type { A2AAgentCard } from "../src/orchestration/a2a/agent-card.js";
import {
  getCardVector,
  pickVectorWinner,
  stampFederationCards,
  vectorDominates,
} from "../src/orchestration/a2a/federation-vector.js";
import { persistFederatedAgentCards, loadFederatedAgentCards } from "../src/orchestration/a2a/federated-registry-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function card(id: string, vector?: Record<string, number>): A2AAgentCard {
  return {
    agentId: id,
    name: id,
    description: "test",
    role: "worker",
    capabilities: ["implement"],
    skills: [],
    protocolVersion: "0.1",
    metadata: vector ? { federationVector: vector } : {},
  };
}

test("vectorDominates and pickVectorWinner", () => {
  const a = card("a", { nodeA: 2, nodeB: 2 });
  const b = card("b", { nodeA: 1, nodeB: 1 });
  assert.equal(vectorDominates(getCardVector(a), getCardVector(b)), true);
  const winner = pickVectorWinner(a, b);
  assert.equal(winner.agentId, "a");
});

test("stampFederationCards bumps local node clock", () => {
  const [stamped] = stampFederationCards([card("x")], "node-1");
  const v = getCardVector(stamped);
  assert.equal(v["node-1"], 1);
});

test("persistFederatedAgentCards stamps when nodeId set", () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-vec-"));
  const path = join(dir, "agents.json");
  try {
    persistFederatedAgentCards([card("remote")], path, "peer-a");
    assert.equal(getCardVector(loadFederatedAgentCards(path)[0])["peer-a"], 1);
    persistFederatedAgentCards(loadFederatedAgentCards(path), path, "peer-a");
    assert.equal(getCardVector(loadFederatedAgentCards(path)[0])["peer-a"], 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
