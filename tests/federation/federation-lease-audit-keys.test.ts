import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  appendLeaseAuditEvent,
  readLeaseAuditChain,
  verifyLeaseAuditSeal,
} from "../../src/experimental/a2a/federation-lease-audit.ts";
import {
  readLeaseAuditKeyRing,
  rotateLeaseAuditSigningKey,
} from "../../src/experimental/a2a/federation-lease-audit-keys.ts";

test("rotateLeaseAuditSigningKey retires prior kid and verifies with key ring", () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-audit-rot-"));
  const storePath = join(dir, "agents.json");
  try {
    rotateLeaseAuditSigningKey({
      nodeId: "n1",
      keyId: "v1",
      secret: "secret-v1",
      storePath,
    });
    appendLeaseAuditEvent({
      type: "acquire",
      nodeId: "n1",
      holderNodeId: "n1",
      term: 2,
      storePath,
      auditSecret: "secret-v1",
      auditNodeId: "n1",
      auditKeyId: "v1",
    });
    const rotated = rotateLeaseAuditSigningKey({
      nodeId: "n1",
      keyId: "v2",
      secret: "secret-v2",
      storePath,
    });
    assert.equal(rotated.keyRing.activeKeyId, "v2");
    assert.ok(rotated.keyRing.retired.some((r) => r.keyId === "v1"));
    const ring = readLeaseAuditKeyRing(storePath);
    assert.equal(ring.activeKeyId, "v2");
    const chain = readLeaseAuditChain(storePath);
    assert.equal(verifyLeaseAuditSeal(chain, { v2: "secret-v2" }), true);
    assert.equal(verifyLeaseAuditSeal(chain, { v1: "secret-v1" }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
