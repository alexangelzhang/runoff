import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { appendLeaseAuditEvent, readLeaseAuditChain } from "../src/orchestration/a2a/federation-lease-audit.ts";
import {
  exportLeaseAuditSignedBundle,
  signLeaseAuditManifest,
  verifyLeaseAuditManifestSignature,
  verifyLeaseAuditSignedBundle,
} from "../src/orchestration/a2a/federation-lease-audit-export.ts";

test("exportLeaseAuditSignedBundle includes detached manifest signature", () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-audit-bundle-"));
  const storePath = join(dir, "agents.json");
  try {
    appendLeaseAuditEvent({
      type: "acquire",
      nodeId: "n1",
      holderNodeId: "n1",
      term: 1,
      storePath,
    });
    const chain = readLeaseAuditChain(storePath);
    const bundle = exportLeaseAuditSignedBundle(chain, {
      secret: "manifest-secret",
      keyId: "k1",
    });
    assert.equal(bundle.manifest.eventCount, 1);
    assert.ok(bundle.manifestSignature);
    assert.equal(bundle.manifestKeyId, "k1");
    assert.equal(
      bundle.manifestSignature,
      signLeaseAuditManifest(bundle.manifest, "manifest-secret"),
    );
    assert.equal(verifyLeaseAuditManifestSignature(bundle, "manifest-secret"), true);
    const verified = verifyLeaseAuditSignedBundle(bundle, { secrets: { k1: "manifest-secret" } });
    assert.equal(verified.ok, true, verified.errors.join("; "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
