import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { A2AAgentCard } from "../../src/experimental/a2a/agent-card.ts";
import {
  compactFederationTombstones,
  deleteFederatedAgentCard,
  gcFederationTombstones,
} from "../../src/experimental/a2a/federation-delete.ts";
import { loadFederatedAgentCards } from "../../src/experimental/a2a/federated-registry-store.ts";
import { isCardTombstoned } from "../../src/experimental/a2a/federation-crdt.ts";

function card(id: string): A2AAgentCard {
  return {
    agentId: id,
    name: id,
    description: "d",
    role: "worker",
    capabilities: ["implement"],
    skills: [],
    protocolVersion: "0.1",
  };
}

test("deleteFederatedAgentCard writes tombstone", () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-del-"));
  const storePath = join(dir, "agents.json");
  try {
    assert.equal(
      deleteFederatedAgentCard("gone", { nodeId: "node-a", storePath, enabled: true }),
      true,
    );
    const agents = loadFederatedAgentCards(storePath);
    assert.equal(agents.length, 1);
    assert.equal(isCardTombstoned(agents[0]!), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gcFederationTombstones removes expired tombstones", () => {
  const old: A2AAgentCard = {
    ...card("old"),
    metadata: {
      federationTombstone: true,
      federationDeletedAt: "2020-01-01T00:00:00.000Z",
    },
  };
  const fresh: A2AAgentCard = {
    ...card("fresh"),
    metadata: {
      federationTombstone: true,
      federationDeletedAt: new Date().toISOString(),
    },
  };
  const { agents, removed } = gcFederationTombstones([old, fresh, card("live")], {
    retentionMs: 86_400_000,
    nowMs: Date.now(),
  });
  assert.equal(removed, 1);
  assert.equal(agents.length, 2);
  assert.ok(agents.some((c) => c.agentId === "fresh"));
  assert.ok(agents.some((c) => c.agentId === "live"));
});

test("compactFederationTombstones persists GC", () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-gc-"));
  const storePath = join(dir, "agents.json");
  try {
    deleteFederatedAgentCard("gone", { nodeId: "n1", storePath, enabled: true });
    const agents = loadFederatedAgentCards(storePath);
    agents[0]!.metadata = {
      ...agents[0]!.metadata,
      federationDeletedAt: "2020-01-01T00:00:00.000Z",
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      storePath,
      JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), agents }),
    );
    const gc = compactFederationTombstones({
      storePath,
      enabled: true,
      retentionMs: 86_400_000,
    });
    assert.equal(gc.agentTombstonesRemoved, 1);
    assert.equal(loadFederatedAgentCards(storePath).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
