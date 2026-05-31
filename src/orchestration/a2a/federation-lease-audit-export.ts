/**
 * P16 — Detached signed manifest for lease audit export.
 */

import { createHmac } from "node:crypto";
import type { LeaseAuditChain, LeaseAuditEvent } from "./federation-lease-audit.js";
import {
  computeLeaseAuditHeadHash,
  signLeaseAuditHead,
  verifyLeaseAuditChain,
  verifyLeaseAuditSeal,
} from "./federation-lease-audit.js";
import type { LeaseAuditKeyRing } from "./federation-lease-audit-keys.js";

export type LeaseAuditExportManifest = {
  version: 1;
  exportedAt: string;
  eventCount: number;
  headHash: string;
  chainValid: boolean;
  seal?: LeaseAuditChain["seal"];
  keyRing?: Pick<LeaseAuditKeyRing, "activeKeyId" | "retired">;
};

export type LeaseAuditSignedBundle = {
  version: 1;
  manifest: LeaseAuditExportManifest;
  events: LeaseAuditEvent[];
  manifestSignature?: string;
  manifestKeyId?: string;
};

export function buildLeaseAuditExportManifest(
  chain: LeaseAuditChain,
  options: { keyRing?: LeaseAuditKeyRing } = {},
): LeaseAuditExportManifest {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    eventCount: chain.events.length,
    headHash: computeLeaseAuditHeadHash(chain),
    chainValid: verifyLeaseAuditChain(chain),
    seal: chain.seal,
    keyRing: options.keyRing
      ? { activeKeyId: options.keyRing.activeKeyId, retired: options.keyRing.retired }
      : undefined,
  };
}

export function signLeaseAuditManifest(
  manifest: LeaseAuditExportManifest,
  secret: string,
): string {
  return createHmac("sha256", secret).update(JSON.stringify(manifest)).digest("hex");
}

export function verifyLeaseAuditManifestSignature(
  bundle: LeaseAuditSignedBundle,
  secret: string,
): boolean {
  if (!bundle.manifestSignature) return false;
  const expected = signLeaseAuditManifest(bundle.manifest, secret);
  return bundle.manifestSignature === expected;
}

/** JSON bundle: manifest + events + detached manifest HMAC. */
export function exportLeaseAuditSignedBundle(
  chain: LeaseAuditChain,
  options: {
    keyRing?: LeaseAuditKeyRing;
    secret?: string;
    keyId?: string;
  } = {},
): LeaseAuditSignedBundle {
  const manifest = buildLeaseAuditExportManifest(chain, { keyRing: options.keyRing });
  const bundle: LeaseAuditSignedBundle = {
    version: 1,
    manifest,
    events: chain.events,
  };
  if (options.secret) {
    bundle.manifestSignature = signLeaseAuditManifest(manifest, options.secret);
    bundle.manifestKeyId = options.keyId ?? options.keyRing?.activeKeyId ?? "default";
  }
  return bundle;
}

export function serializeLeaseAuditSignedBundle(bundle: LeaseAuditSignedBundle): string {
  return JSON.stringify(bundle, null, 2);
}

export type LeaseAuditBundleVerifyResult = {
  ok: boolean;
  errors: string[];
};

/** P17: offline verification of exported signed bundle. */
export function verifyLeaseAuditSignedBundle(
  bundle: LeaseAuditSignedBundle,
  options: { secrets?: Record<string, string> } = {},
): LeaseAuditBundleVerifyResult {
  const errors: string[] = [];
  if (bundle.version !== 1) errors.push("bundle.version must be 1");
  if (!bundle.manifest || bundle.manifest.version !== 1) {
    errors.push("manifest.version must be 1");
  }

  const chain: LeaseAuditChain = {
    version: 1,
    updatedAt: bundle.manifest?.exportedAt ?? new Date(0).toISOString(),
    events: bundle.events ?? [],
    seal: bundle.manifest?.seal,
  };

  if (!verifyLeaseAuditChain(chain)) errors.push("event hash chain invalid");
  const head = computeLeaseAuditHeadHash(chain);
  if (bundle.manifest?.headHash && bundle.manifest.headHash !== head) {
    errors.push("manifest.headHash mismatch");
  }

  if (bundle.manifestSignature) {
    const secrets = options.secrets ?? {};
    const kid = bundle.manifestKeyId ?? "default";
    const secret = secrets[kid];
    if (!secret) {
      errors.push(`no secret for manifestKeyId=${kid}`);
    } else if (!verifyLeaseAuditManifestSignature(bundle, secret)) {
      errors.push("manifestSignature invalid");
    }
  }

  if (bundle.manifest?.seal && options.secrets && Object.keys(options.secrets).length > 0) {
    if (!verifyLeaseAuditSeal(chain, options.secrets)) {
      errors.push("chain.seal invalid");
    }
  }

  return { ok: errors.length === 0, errors };
}
