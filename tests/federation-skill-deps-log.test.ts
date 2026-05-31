import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { skillDepRef, setSkillDepsOnCard } from "../src/orchestration/a2a/federation-skill-deps.ts";
import type { A2AAgentCard } from "../src/orchestration/a2a/agent-card.ts";
import {
  appendSkillDepsPruneLog,
  readSkillDepsPruneLog,
} from "../src/orchestration/a2a/federation-skill-deps-log.ts";
import { mergeRemoteCardsIntoFederationStore } from "../src/orchestration/a2a/federation-sync.ts";
import { persistFederatedAgentCards } from "../src/orchestration/a2a/federated-registry-store.ts";

function card(agentId: string, skills: string[]): A2AAgentCard {
  return {
    agentId,
    name: agentId,
    description: "",
    role: "worker",
    capabilities: ["text"],
    skills: skills.map((id) => ({ id, name: id })),
    protocolVersion: "0.3",
    endpoint: `http://${agentId}`,
    metadata: { federationUpdatedAt: "2026-01-01T00:00:00.000Z" },
  };
}

test("appendSkillDepsPruneLog writes receipt", () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-prune-log-"));
  const storePath = join(dir, "agents.json");
  try {
    const receipt = appendSkillDepsPruneLog({
      source: "sync",
      pruned: [{ dependent: "a:s1", removedDep: "b:s2" }],
      storePath,
    });
    assert.ok(receipt);
    assert.match(receipt!.receiptId, /^sdp-sync-/);
    const log = readSkillDepsPruneLog(storePath);
    assert.equal(log.entries.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeRemoteCardsIntoFederationStore appends prune log on cyclic merge", () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-prune-merge-"));
  const storePath = join(dir, "agents.json");
  try {
    persistFederatedAgentCards([card("agent-a", ["s1"])], storePath);
    const b = setSkillDepsOnCard(card("agent-b", ["s2"]), "s2", [skillDepRef("agent-a", "s1")]);
    const a2 = setSkillDepsOnCard(card("agent-a", ["s1"]), "s1", [skillDepRef("agent-b", "s2")]);
    mergeRemoteCardsIntoFederationStore([b, a2], { storePath });
    const log = readSkillDepsPruneLog(storePath);
    assert.equal(log.entries.length, 1);
    assert.equal(log.entries[0]!.source, "merge");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
