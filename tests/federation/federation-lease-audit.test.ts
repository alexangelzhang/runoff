import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  appendLeaseAuditEvent,
  readLeaseAuditChain,
  sealLeaseAuditChain,
  exportLeaseAuditChain,
  verifyLeaseAuditChain,
  verifyLeaseAuditSeal,
} from "../../src/experimental/a2a/federation-lease-audit.ts";
import { recordLeaseWriteWitness } from "../../src/experimental/a2a/federation-lease-quorum.ts";
import type { FederationLease } from "../../src/experimental/a2a/federation-lease.ts";

const lease: FederationLease = {
  version: 1,
  holderNodeId: "node-a",
  acquiredAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  term: 1,
};

test("appendLeaseAuditEvent builds verifiable hash chain", () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-audit-"));
  const storePath = join(dir, "agents.json");
  try {
    appendLeaseAuditEvent({ type: "acquire", nodeId: "node-a", holderNodeId: "node-a", term: 1, storePath });
    appendLeaseAuditEvent({ type: "witness", nodeId: "node-b", holderNodeId: "node-a", term: 1, storePath });
    const chain = readLeaseAuditChain(storePath);
    assert.equal(chain.events.length, 2);
    assert.equal(chain.events[0]!.prevHash, "");
    assert.equal(chain.events[1]!.prevHash, chain.events[0]!.hash);
    assert.equal(verifyLeaseAuditChain(chain), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sealLeaseAuditChain and verifyLeaseAuditSeal", () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-audit-seal-"));
  const storePath = join(dir, "agents.json");
  try {
    appendLeaseAuditEvent({ type: "acquire", nodeId: "n1", holderNodeId: "n1", term: 1, storePath });
    const seal = sealLeaseAuditChain({ nodeId: "n1", secret: "test-secret", storePath });
    assert.ok(seal);
    const chain = readLeaseAuditChain(storePath);
    assert.equal(verifyLeaseAuditSeal(chain, "test-secret"), true);
    assert.equal(verifyLeaseAuditSeal(chain, "wrong"), false);
    const ndjson = exportLeaseAuditChain(chain, "ndjson");
    assert.match(ndjson, /"type":"acquire"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordLeaseWriteWitness appends audit witness event", () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-audit-w-"));
  const storePath = join(dir, "agents.json");
  try {
    recordLeaseWriteWitness({ witnessNodeId: "node-a", lease, storePath });
    const chain = readLeaseAuditChain(storePath);
    assert.equal(chain.events.length, 1);
    assert.equal(chain.events[0]!.type, "witness");
    assert.equal(verifyLeaseAuditChain(chain), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
