import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { federationLeasePath, readFederationLease } from "../src/orchestration/a2a/federation-lease.ts";
import { startFederationLeaseHeartbeat } from "../src/orchestration/a2a/federation-lease-heartbeat.ts";

test("startFederationLeaseHeartbeat renews lease on interval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-hb-"));
  const agentsPath = join(dir, "agents.json");
  const leasePath = federationLeasePath(agentsPath);
  const handle = startFederationLeaseHeartbeat({
    nodeId: "hb-node",
    leaseMs: 60_000,
    intervalMs: 50,
    storePath: agentsPath,
  });
  try {
    await new Promise((r) => setTimeout(r, 120));
    const lease = readFederationLease(leasePath);
    assert.equal(lease?.holderNodeId, "hb-node");
    assert.ok((lease?.term ?? 0) >= 2);
  } finally {
    handle.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
