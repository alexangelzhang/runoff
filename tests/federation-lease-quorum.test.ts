import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { FederationLease } from "../src/orchestration/a2a/federation-lease.ts";
import {
  confirmLeaseWriteQuorum,
  readLeaseWriteWitnessLog,
  recordLeaseWriteWitness,
} from "../src/orchestration/a2a/federation-lease-quorum.ts";

const lease: FederationLease = {
  version: 1,
  holderNodeId: "node-a",
  acquiredAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  term: 3,
};

test("recordLeaseWriteWitness appends to log file", () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-lq-"));
  const storePath = join(dir, "agents.json");
  try {
    recordLeaseWriteWitness({ witnessNodeId: "node-a", lease, storePath });
    const log = readLeaseWriteWitnessLog(storePath);
    assert.equal(log.entries.length, 1);
    assert.equal(log.entries[0]!.holderNodeId, "node-a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confirmLeaseWriteQuorum with no peers needs quorum 1", async () => {
  const result = await confirmLeaseWriteQuorum({
    holderNodeId: "node-a",
    peerUrls: [],
    quorumMin: 1,
  });
  assert.equal(result.confirmed, true);
  assert.equal(result.votes, 1);
});
