import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  federationLeasePath,
  isFederationLeaseValid,
  readFederationLease,
  renewFederationLease,
  tryAcquireFederationLease,
} from "../../src/experimental/a2a/federation-lease.ts";

test("tryAcquireFederationLease acquire and renew", () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-lease-"));
  const agentsPath = join(dir, "agents.json");
  const leasePath = federationLeasePath(agentsPath);
  try {
    const first = tryAcquireFederationLease({ nodeId: "node-a", leaseMs: 60_000, leasePath });
    assert.equal(first.acquired, true);
    assert.equal(first.lease.holderNodeId, "node-a");

    const second = tryAcquireFederationLease({ nodeId: "node-b", leaseMs: 60_000, leasePath });
    assert.equal(second.acquired, false);

    assert.equal(renewFederationLease("node-a", { leasePath, leaseMs: 60_000 }), true);
    const renewed = readFederationLease(leasePath);
    assert.ok(renewed && renewed.term >= 2);
    assert.equal(isFederationLeaseValid(renewed!), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
