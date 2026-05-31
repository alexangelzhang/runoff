import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  parseLeaseWitnessPostBody,
  recordRemoteLeaseWitness,
} from "../../src/experimental/a2a/federation-lease-quorum.ts";
import { readLeaseWriteWitnessLog } from "../../src/experimental/a2a/federation-lease-quorum.ts";

test("parseLeaseWitnessPostBody and recordRemoteLeaseWitness", () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-wpost-"));
  const storePath = join(dir, "agents.json");
  try {
    const entry = parseLeaseWitnessPostBody({
      entry: {
        witnessNodeId: "node-b",
        holderNodeId: "node-a",
        term: 4,
        at: "2026-06-01T00:00:00.000Z",
      },
    });
    assert.ok(entry);
    const receipt = recordRemoteLeaseWitness(entry!, storePath);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.holderNodeId, "node-a");
    const log = readLeaseWriteWitnessLog(storePath);
    assert.equal(log.entries.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
