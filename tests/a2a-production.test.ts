import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { buildAgentCardRegistry } from "../src/orchestration/a2a/config-bridge.ts";
import {
  fetchRemoteAgentCards,
  mergeRemoteDiscoveryIntoRegistry,
} from "../src/orchestration/a2a/external-registry.ts";
import { HttpA2ATransport } from "../src/orchestration/a2a/http-transport.ts";
import { loadServerTlsOptions } from "../src/orchestration/a2a/tls-config.ts";
import { agentId } from "../src/orchestration/multi-agent-types.ts";
import type { PipelineConfig } from "../src/core/config.ts";

const config: PipelineConfig = {
  providers: { mock: { type: "mock" } },
  pipeline: { stepA: ["mock"] },
  agents: {
    local: { role: "worker", provider: "mock" },
    remote: { role: "reviewer", provider: "mock" },
  },
};

test("loadServerTlsOptions returns null without cert paths", () => {
  assert.equal(loadServerTlsOptions(undefined), null);
});

test("mergeRemoteDiscoveryIntoRegistry imports remote agents", async () => {
  const remoteRegistry = buildAgentCardRegistry({
    ...config,
    agents: { remoteOnly: { role: "reviewer", provider: "mock" } },
  });
  const remoteTransport = new HttpA2ATransport({ registry: remoteRegistry, federationPersist: false });
  const { url } = await remoteTransport.start();

  const localRegistry = buildAgentCardRegistry({
    ...config,
    agents: { localOnly: { role: "worker", provider: "mock" } },
  });
  const { merged, errors } = await mergeRemoteDiscoveryIntoRegistry(
    localRegistry,
    [`${url}/a2a/agents`],
  );
  await remoteTransport.stop();

  assert.equal(errors.length, 0);
  assert.equal(merged, 1);
  assert.equal(localRegistry.size, 2);
  assert.ok(localRegistry.get(agentId("remoteOnly")));
});

test("HttpA2ATransport GET /a2a/agents merges remoteDiscoveryUrls", async () => {
  const remoteRegistry = buildAgentCardRegistry({
    ...config,
    agents: { peer: { role: "worker", provider: "mock" } },
  });
  const remote = new HttpA2ATransport({ registry: remoteRegistry, federationPersist: false });
  const { url: remoteUrl } = await remote.start();

  const localRegistry = buildAgentCardRegistry({
    ...config,
    agents: { home: { role: "worker", provider: "mock" } },
  });
  const local = new HttpA2ATransport({
    registry: localRegistry,
    remoteDiscoveryUrls: [`${remoteUrl}/a2a/agents`],
    federationPersist: false,
    remoteDiscoveryTtlMs: 60_000,
  });
  const { url: localUrl } = await local.start();

  const res = await fetch(`${localUrl}/a2a/agents`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { agents: Array<{ name: string }> };
  const names = body.agents.map((a) => a.name).sort();
  assert.deepEqual(names, ["home", "peer"]);

  await local.stop();
  await remote.stop();
});

test("fetchRemoteAgentCards reads standalone discovery server", async () => {
  const payload = {
    agents: [
      {
        agentId: "agent:ext",
        name: "ext",
        description: "external",
        role: "worker",
        capabilities: ["implement"],
        skills: [],
        protocolVersion: "0.1",
      },
    ],
  };

  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const cards = await fetchRemoteAgentCards(`http://127.0.0.1:${addr.port}/discovery`);
  server.close();

  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.name, "ext");
});
