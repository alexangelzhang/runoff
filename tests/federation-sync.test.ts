import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { A2AAgentCard } from "../src/orchestration/a2a/agent-card.ts";
import { agentId } from "../src/orchestration/multi-agent-types.ts";
import {
  buildFederationDirectoryBody,
  mergeCardsWithConflictStrategy,
  mergeRemoteCardsIntoFederationStore,
} from "../src/orchestration/a2a/federation-sync.ts";
import { loadFederatedAgentCards } from "../src/orchestration/a2a/federated-registry-store.ts";
import { getCardVector } from "../src/orchestration/a2a/federation-vector.ts";
import { HttpA2ATransport } from "../src/orchestration/a2a/http-transport.ts";
import { buildAgentCardRegistry } from "../src/orchestration/a2a/config-bridge.ts";

let storeDir: string;

test.beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), "fed-sync-"));
});

test.afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true });
});

const localCard: A2AAgentCard = {
  agentId: agentId("local"),
  name: "local",
  description: "local agent",
  role: "worker",
  capabilities: ["implement"],
  skills: [],
  protocolVersion: "0.1",
  metadata: { updatedAt: "2026-01-01T00:00:00.000Z" },
};

const remoteCard: A2AAgentCard = {
  ...localCard,
  agentId: agentId("local"),
  name: "remote-renamed",
  metadata: { updatedAt: "2026-06-01T00:00:00.000Z" },
};

test("mergeCardsWithConflictStrategy local-wins keeps local", () => {
  const { merged, conflicts } = mergeCardsWithConflictStrategy(
    [localCard],
    [remoteCard],
    "local-wins",
  );
  assert.equal(conflicts, 1);
  assert.equal(merged[0]!.name, "local");
});

test("mergeCardsWithConflictStrategy crdt-merge combines vectors", () => {
  const older = { ...localCard, name: "old", metadata: { federationVector: { nodeA: 1 } } };
  const newer = {
    ...localCard,
    name: "new",
    metadata: { federationVector: { nodeA: 3 }, federationUpdatedAt: "2026-08-01T00:00:00.000Z" },
  };
  const { merged } = mergeCardsWithConflictStrategy([older], [newer], "crdt-merge");
  assert.equal(merged[0]!.name, "new");
});

test("mergeCardsWithConflictStrategy vector-wins uses vector clock", () => {
  const older = {
    ...localCard,
    metadata: { federationVector: { nodeA: 1 } },
  };
  const newer = {
    ...remoteCard,
    metadata: { federationVector: { nodeA: 2 } },
  };
  const { merged } = mergeCardsWithConflictStrategy([older], [newer], "vector-wins");
  assert.equal(getCardVector(merged[0]!)["nodeA"], 2);
});

test("mergeCardsWithConflictStrategy newest-wins picks remote", () => {
  const { merged } = mergeCardsWithConflictStrategy([localCard], [remoteCard], "newest-wins");
  assert.equal(merged[0]!.name, "remote-renamed");
});

test("GET /a2a/federation/directory requires bearer when tokens configured", async () => {
  const registry = buildAgentCardRegistry({
    providers: { mock: { type: "mock" } },
    pipeline: { s: ["mock"] },
    agents: { home: { role: "worker", provider: "mock" } },
  });
  const transport = new HttpA2ATransport({
    registry,
    auth: { bearerTokens: ["secret"] },
  });
  const { url } = await transport.start();
  const denied = await fetch(`${url}/a2a/federation/directory`);
  assert.equal(denied.status, 401);
  const ok = await fetch(`${url}/a2a/federation/directory`, {
    headers: { Authorization: "Bearer secret" },
  });
  assert.equal(ok.status, 200);
  await transport.stop();
});

test("GET /a2a/federation/directory returns persisted agents", async () => {
  const path = join(storeDir, "agents.json");
  mergeRemoteCardsIntoFederationStore([localCard], {
    storePath: path,
    enabled: true,
    conflictStrategy: "newest-wins",
  });

  const registry = buildAgentCardRegistry({
    providers: { mock: { type: "mock" } },
    pipeline: { s: ["mock"] },
    agents: { home: { role: "worker", provider: "mock" } },
  });
  const transport = new HttpA2ATransport({
    registry,
    federationPersist: true,
    federationPath: path,
  });
  const { url } = await transport.start();

  const res = await fetch(`${url}/a2a/federation/directory`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as ReturnType<typeof buildFederationDirectoryBody>;
  assert.ok(body.agents.some((a) => a.name === "local"));
  await transport.stop();
});

test("POST /a2a/federation/directory merges with conflict strategy", async () => {
  const path = join(storeDir, "agents.json");
  const registry = buildAgentCardRegistry({
    providers: { mock: { type: "mock" } },
    pipeline: { s: ["mock"] },
    agents: { home: { role: "worker", provider: "mock" } },
  });
  mergeRemoteCardsIntoFederationStore([localCard], {
    storePath: path,
    enabled: true,
  });

  const transport = new HttpA2ATransport({
    registry,
    federationPersist: true,
    federationPath: path,
    federationConflictStrategy: "remote-wins",
  });
  const { url } = await transport.start();

  const post = await fetch(`${url}/a2a/federation/directory`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildFederationDirectoryBody([remoteCard])),
  });
  assert.equal(post.status, 200);

  const stored = loadFederatedAgentCards(path);
  assert.equal(stored[0]!.name, "remote-renamed");
  await transport.stop();
});
