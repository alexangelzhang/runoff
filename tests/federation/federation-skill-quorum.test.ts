import assert from "node:assert/strict";
import test from "node:test";
import type { A2AAgentCard } from "../../src/experimental/a2a/agent-card.ts";
import {
  applySkillQuorumToDirectory,
  countSkillPeerVotes,
} from "../../src/experimental/a2a/federation-skill-quorum.ts";

function card(id: string, skills: string[]): A2AAgentCard {
  return {
    agentId: id,
    name: id,
    description: "d",
    role: "worker",
    capabilities: ["implement"],
    skills: skills.map((sid) => ({ id: sid, name: sid, description: "d" })),
    protocolVersion: "0.1",
  };
}

test("countSkillPeerVotes counts per peer directory", () => {
  const peerDirs = [
    [card("a", ["s1", "s2"])],
    [card("a", ["s1", "s3"])],
  ];
  const votes = countSkillPeerVotes("a", peerDirs);
  assert.equal(votes.get("s1"), 2);
  assert.equal(votes.get("s2"), 1);
});

test("applySkillQuorumToDirectory drops skills below quorum", () => {
  const peerDirs = [
    [card("a", ["s1", "s2"])],
    [card("a", ["s1"])],
  ];
  const merged = [card("a", ["s1", "s2", "s3"])];
  const { cards, skillsDropped, quorumMin } = applySkillQuorumToDirectory(merged, peerDirs, 2);
  assert.equal(quorumMin, 2);
  assert.ok(skillsDropped >= 1);
  assert.equal(cards[0]!.skills.map((s) => s.id).join(","), "s1");
});
