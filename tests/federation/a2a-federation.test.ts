import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildAgentCardRegistry } from "../../src/experimental/a2a/config-bridge.ts";
import {
  appendToFederationStore,
  hydrateRegistryFromFederation,
  loadFederatedAgentCards,
  persistFederatedAgentCards,
} from "../../src/experimental/a2a/federated-registry-store.ts";
import { HttpA2ATransport } from "../../src/experimental/a2a/http-transport.ts";
import type { A2AAgentCard } from "../../src/experimental/a2a/agent-card.ts";
import { agentId } from "../../src/orchestration/multi-agent-types.ts";

let storeDir: string;

test.beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), "a2a-fed-"));
});

test.afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true });
});

const remoteCard: A2AAgentCard = {
  agentId: agentId("fed-peer"),
  name: "fed-peer",
  description: "federated peer",
  role: "worker",
  capabilities: ["implement"],
  skills: [],
  protocolVersion: "0.1",
};

test("persistFederatedAgentCards round-trip", () => {
  const path = join(storeDir, "agents.json");
  persistFederatedAgentCards([remoteCard], path);
  const loaded = loadFederatedAgentCards(path);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.name, "fed-peer");
});

test("appendToFederationStore dedupes by agentId", () => {
  const path = join(storeDir, "agents.json");
  assert.equal(appendToFederationStore([remoteCard], { storePath: path, enabled: true }), 1);
  assert.equal(appendToFederationStore([remoteCard], { storePath: path, enabled: true }), 0);
  assert.equal(loadFederatedAgentCards(path).length, 1);
});

test("HttpA2ATransport persists remote discovery to federation store", async () => {
  const path = join(storeDir, "agents.json");
  const remoteRegistry = buildAgentCardRegistry({
    providers: { mock: { type: "mock" } },
    pipeline: { x: ["mock"] },
    agents: { fedPeer: { role: "worker", provider: "mock" } },
  });
  const remote = new HttpA2ATransport({ registry: remoteRegistry });
  const { url: remoteUrl } = await remote.start();

  const localRegistry = buildAgentCardRegistry({
    providers: { mock: { type: "mock" } },
    pipeline: { y: ["mock"] },
    agents: { home: { role: "worker", provider: "mock" } },
  });
  const local = new HttpA2ATransport({
    registry: localRegistry,
    remoteDiscoveryUrls: [`${remoteUrl}/a2a/agents`],
    federationPersist: true,
    federationPath: path,
  });
  const { url: localUrl } = await local.start();

  await fetch(`${localUrl}/a2a/agents`);
  await local.stop();
  await remote.stop();

  const stored = loadFederatedAgentCards(path);
  assert.ok(stored.some((c) => c.name === "fedPeer"));
  assert.ok(readFileSync(path, "utf-8").includes("fedPeer"));
});

test("hydrateRegistryFromFederation loads disk into registry", () => {
  const path = join(storeDir, "agents.json");
  persistFederatedAgentCards([remoteCard], path);
  const registry = buildAgentCardRegistry({
    providers: { mock: { type: "mock" } },
    pipeline: { s: ["mock"] },
    agents: { local: { role: "worker", provider: "mock" } },
  });
  hydrateRegistryFromFederation(registry, { storePath: path, enabled: true });
  assert.equal(registry.size, 2);
  assert.ok(registry.get(agentId("fed-peer")));
});
