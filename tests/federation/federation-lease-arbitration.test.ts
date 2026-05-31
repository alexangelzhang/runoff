import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { FederationLease } from "../../src/experimental/a2a/federation-lease.ts";
import {
  applyLeaseAutoDowngrade,
  arbitrateFederationLease,
  shouldAutoDowngradeLease,
} from "../../src/experimental/a2a/federation-lease-arbitration.ts";
import {
  federationLeasePath,
  tryAcquireFederationLease,
} from "../../src/experimental/a2a/federation-lease.ts";
import type { LeaseWitness } from "../../src/experimental/a2a/federation-lease-witness.ts";

const lease = (holder: string, term: number): FederationLease => ({
  version: 1,
  holderNodeId: holder,
  acquiredAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  term,
});

test("arbitrateFederationLease picks highest term", () => {
  const witnesses: LeaseWitness[] = [
    { peerUrl: "http://b", lease: lease("node-b", 5), valid: true },
  ];
  const result = arbitrateFederationLease(lease("node-a", 2), witnesses);
  assert.equal(result.winnerHolder, "node-b");
  assert.equal(result.reason, "highest-term");
});

test("shouldAutoDowngradeLease when local is not winner", () => {
  const witnesses: LeaseWitness[] = [
    { peerUrl: "http://b", lease: lease("node-b", 5), valid: true },
  ];
  const arb = arbitrateFederationLease(lease("node-a", 2), witnesses);
  const report = {
    detected: true,
    localHolder: "node-a",
    witnesses,
    conflictingHolders: ["node-a", "node-b"],
  };
  assert.equal(shouldAutoDowngradeLease("node-a", report, arb), true);
  assert.equal(shouldAutoDowngradeLease("node-b", report, arb), false);
});

test("applyLeaseAutoDowngrade releases local lease", () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-arb-"));
  const agentsPath = join(dir, "agents.json");
  const leasePath = federationLeasePath(agentsPath);
  try {
    tryAcquireFederationLease({ nodeId: "node-a", leaseMs: 60_000, leasePath });
    const witnesses: LeaseWitness[] = [
      { peerUrl: "http://b", lease: lease("node-b", 99), valid: true },
    ];
    const arb = arbitrateFederationLease(lease("node-a", 1), witnesses);
    const report = {
      detected: true,
      localHolder: "node-a",
      witnesses,
      conflictingHolders: ["node-a", "node-b"],
    };
    const down = applyLeaseAutoDowngrade({
      localNodeId: "node-a",
      splitBrain: report,
      arbitration: arb,
      storePath: agentsPath,
    });
    assert.equal(down.downgraded, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
