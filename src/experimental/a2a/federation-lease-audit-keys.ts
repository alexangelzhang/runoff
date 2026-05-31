/**
 * P15 — Lease audit HMAC key rotation (key id ring, no secrets on disk).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getA2AFederationDir } from "../../core/paths.js";
import {
  appendLeaseAuditEvent,
  sealLeaseAuditChain,
  type LeaseAuditSeal,
} from "./federation-lease-audit.js";

export type LeaseAuditKeyRing = {
  version: 1;
  activeKeyId: string;
  updatedAt: string;
  retired: Array<{ keyId: string; retiredAt: string }>;
};

let signingKeyRing: Record<string, string> = {};
let signingActiveKeyId = "default";
let signingNodeId = "local";

export function configureLeaseAuditKeyRing(
  options: { keys: Record<string, string>; activeKeyId: string; nodeId: string } | null,
): void {
  if (!options) {
    signingKeyRing = {};
    signingActiveKeyId = "default";
    signingNodeId = "local";
    return;
  }
  signingKeyRing = { ...options.keys };
  signingActiveKeyId = options.activeKeyId;
  signingNodeId = options.nodeId;
}

export function getLeaseAuditSigningKeyRing(): Record<string, string> {
  return signingKeyRing;
}

export function federationLeaseAuditKeyRingPath(storePath?: string): string {
  const base = storePath
    ? storePath.endsWith(".json")
      ? dirname(storePath)
      : storePath
    : getA2AFederationDir();
  return join(base, "lease-audit-keyring.json");
}

export function readLeaseAuditKeyRing(storePath?: string): LeaseAuditKeyRing {
  const path = federationLeaseAuditKeyRingPath(storePath);
  if (!existsSync(path)) {
    return {
      version: 1,
      activeKeyId: signingActiveKeyId,
      updatedAt: new Date(0).toISOString(),
      retired: [],
    };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as LeaseAuditKeyRing;
    if (raw.version !== 1 || typeof raw.activeKeyId !== "string") {
      return {
        version: 1,
        activeKeyId: signingActiveKeyId,
        updatedAt: new Date(0).toISOString(),
        retired: [],
      };
    }
    return raw;
  } catch {
    return {
      version: 1,
      activeKeyId: signingActiveKeyId,
      updatedAt: new Date(0).toISOString(),
      retired: [],
    };
  }
}

export function buildLeaseAuditKeyRingBody(ring: LeaseAuditKeyRing): LeaseAuditKeyRing {
  return ring;
}

/** Rotate active audit signing key and re-seal chain head. */
export function rotateLeaseAuditSigningKey(options: {
  nodeId: string;
  keyId: string;
  secret: string;
  storePath?: string;
}): { keyRing: LeaseAuditKeyRing; seal: LeaseAuditSeal | null } {
  const path = federationLeaseAuditKeyRingPath(options.storePath);
  const ring = readLeaseAuditKeyRing(options.storePath);
  const now = new Date().toISOString();

  if (ring.activeKeyId && ring.activeKeyId !== options.keyId) {
    const already = ring.retired.some((r) => r.keyId === ring.activeKeyId);
    if (!already) {
      ring.retired.push({ keyId: ring.activeKeyId, retiredAt: now });
    }
  }

  ring.activeKeyId = options.keyId;
  ring.updatedAt = now;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ring, null, 2), "utf-8");

  signingKeyRing = { ...signingKeyRing, [options.keyId]: options.secret };
  signingActiveKeyId = options.keyId;
  signingNodeId = options.nodeId;

  appendLeaseAuditEvent({
    type: "key_rotate",
    nodeId: options.nodeId,
    detail: `kid=${options.keyId}`,
    storePath: options.storePath,
    auditSecret: options.secret,
    auditNodeId: options.nodeId,
    auditKeyId: options.keyId,
  });

  const seal = sealLeaseAuditChain({
    nodeId: options.nodeId,
    secret: options.secret,
    storePath: options.storePath,
    keyId: options.keyId,
  });

  return { keyRing: ring, seal };
}

export function parseLeaseAuditRotateBody(body: unknown): { keyId: string; secret: string } | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  if (typeof raw.keyId !== "string" || typeof raw.secret !== "string") return null;
  if (!raw.keyId.trim() || !raw.secret.trim()) return null;
  return { keyId: raw.keyId.trim(), secret: raw.secret };
}
