import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { A2AAgentCard } from "../src/orchestration/a2a/agent-card.ts";
import { deleteFederatedAgentSkill } from "../src/orchestration/a2a/federation-delete.ts";
import { loadFederatedAgentCards } from "../src/orchestration/a2a/federated-registry-store.ts";
import {
  getActiveSkills,
  isSkillTombstoned,
  mergeAgentCardCrdt,
  tombstoneSkillOnCard,
} from "../src/orchestration/a2a/federation-crdt.ts";
import { persistFederatedAgentCards } from "../src/orchestration/a2a/federated-registry-store.ts";

function card(id: string): A2AAgentCard {
  return {
    agentId: id,
    name: id,
    description: "d",
    role: "worker",
    capabilities: ["implement"],
    skills: [
      { id: "s1", name: "one", description: "d" },
      { id: "s2", name: "two", description: "d" },
    ],
    protocolVersion: "0.1",
  };
}

test("tombstoneSkillOnCard removes skill and records tombstone map", () => {
  const updated = tombstoneSkillOnCard(card("a"), "s1", "node-a");
  assert.equal(isSkillTombstoned(updated, "s1"), true);
  assert.equal(getActiveSkills(updated).length, 1);
  assert.equal(getActiveSkills(updated)[0]!.id, "s2");
});

test("mergeAgentCardCrdt propagates skill tombstones", () => {
  const local = tombstoneSkillOnCard(card("a"), "s1", "node-a");
  const remote = card("a");
  const merged = mergeAgentCardCrdt(local, remote);
  assert.equal(isSkillTombstoned(merged, "s1"), true);
  assert.equal(getActiveSkills(merged).length, 1);
});

test("deleteFederatedAgentSkill persists skill tombstone", () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-skill-"));
  const storePath = join(dir, "agents.json");
  try {
    persistFederatedAgentCards([card("a")], storePath, "node-a");
    assert.equal(
      deleteFederatedAgentSkill("a", "s1", { nodeId: "node-a", storePath, enabled: true }),
      true,
    );
    const stored = loadFederatedAgentCards(storePath)[0]!;
    assert.equal(isSkillTombstoned(stored, "s1"), true);
    assert.equal(getActiveSkills(stored).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
