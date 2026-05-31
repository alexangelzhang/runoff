import assert from "node:assert/strict";
import test from "node:test";
import type { A2AAgentCard } from "../../src/experimental/a2a/agent-card.ts";
import { gcSkillTombstonesOnAgents } from "../../src/experimental/a2a/federation-delete.ts";

function card(): A2AAgentCard {
  return {
    agentId: "a",
    name: "a",
    description: "d",
    role: "worker",
    capabilities: ["implement"],
    skills: [{ id: "s1", name: "one", description: "d" }],
    protocolVersion: "0.1",
    metadata: {
      federationSkillTombstones: {
        old: "2020-01-01T00:00:00.000Z",
        fresh: new Date().toISOString(),
      },
    },
  };
}

test("gcSkillTombstonesOnAgents removes expired skill tombstone keys", () => {
  const { agents, removed } = gcSkillTombstonesOnAgents([card()], {
    retentionMs: 86_400_000,
    nowMs: Date.now(),
  });
  assert.equal(removed, 1);
  const tombs = agents[0]!.metadata?.federationSkillTombstones as Record<string, string>;
  assert.ok(tombs.fresh);
  assert.equal(tombs.old, undefined);
});
