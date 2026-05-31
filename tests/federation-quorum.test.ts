import assert from "node:assert/strict";
import test from "node:test";
import type { A2AAgentCard } from "../src/orchestration/a2a/agent-card.ts";
import {
  filterCardsByPeerQuorum,
  resolveFederationQuorumMin,
} from "../src/orchestration/a2a/federation-quorum.ts";

function card(id: string): A2AAgentCard {
  return {
    agentId: id,
    name: id,
    description: "",
    role: "worker",
    capabilities: ["implement"],
    skills: [],
    protocolVersion: "0.1",
  };
}

test("resolveFederationQuorumMin caps at peer count", () => {
  assert.equal(resolveFederationQuorumMin(3, 5), 3);
  assert.equal(resolveFederationQuorumMin(3, 2), 2);
});

test("filterCardsByPeerQuorum requires majority", () => {
  const peerA = [card("shared"), card("only-a")];
  const peerB = [card("shared"), card("only-b")];
  const peerC = [card("shared")];
  const out = filterCardsByPeerQuorum([peerA, peerB, peerC], 2);
  assert.deepEqual(out.map((c) => c.agentId).sort(), ["shared"]);
});

test("filterCardsByPeerQuorum quorum 1 is union", () => {
  const out = filterCardsByPeerQuorum([[card("a")], [card("b")]], 1);
  assert.equal(out.length, 2);
});
