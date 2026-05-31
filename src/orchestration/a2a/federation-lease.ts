/**
 * P7 — File-backed federation leader lease (renewal + expiry).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getA2AFederationDir } from "../../core/paths.js";
import { appendLeaseAuditEvent } from "./federation-lease-audit.js";

export type FederationLease = {
  version: 1;
  holderNodeId: string;
  acquiredAt: string;
  expiresAt: string;
  term: number;
};

/** @param storePath — federation `agents.json` path or directory */
export function federationLeasePath(storePath?: string): string {
  const base = storePath
    ? storePath.endsWith(".json")
      ? dirname(storePath)
      : storePath
    : getA2AFederationDir();
  return join(base, "leader-lease.json");
}

export function readFederationLease(leasePath?: string): FederationLease | null {
  const path = leasePath ?? federationLeasePath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as FederationLease;
    if (raw.version !== 1 || typeof raw.holderNodeId !== "string") return null;
    return raw;
  } catch {
    return null;
  }
}

export function isFederationLeaseValid(lease: FederationLease, nowMs = Date.now()): boolean {
  const exp = Date.parse(lease.expiresAt);
  return !Number.isNaN(exp) && exp > nowMs;
}

function writeLease(path: string, lease: FederationLease): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(lease, null, 2), "utf-8");
}

/** Try to acquire or renew lease for nodeId. Returns true when holder is nodeId after call. */
export function tryAcquireFederationLease(options: {
  nodeId: string;
  leaseMs?: number;
  leasePath?: string;
  nowMs?: number;
}): { acquired: boolean; lease: FederationLease } {
  const path = options.leasePath ?? federationLeasePath();
  const now = options.nowMs ?? Date.now();
  const leaseMs = options.leaseMs ?? 30_000;
  const existing = readFederationLease(path);

  if (existing && isFederationLeaseValid(existing, now)) {
    if (existing.holderNodeId === options.nodeId) {
      const renewed: FederationLease = {
        ...existing,
        expiresAt: new Date(now + leaseMs).toISOString(),
        term: existing.term + 1,
      };
      writeLease(path, renewed);
      appendLeaseAuditEvent({
        type: "renew",
        nodeId: options.nodeId,
        holderNodeId: renewed.holderNodeId,
        term: renewed.term,
        storePath: options.leasePath,
      });
      return { acquired: true, lease: renewed };
    }
    return { acquired: false, lease: existing };
  }

  const lease: FederationLease = {
    version: 1,
    holderNodeId: options.nodeId,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + leaseMs).toISOString(),
    term: (existing?.term ?? 0) + 1,
  };
  writeLease(path, lease);
  appendLeaseAuditEvent({
    type: "acquire",
    nodeId: options.nodeId,
    holderNodeId: lease.holderNodeId,
    term: lease.term,
    storePath: options.leasePath,
  });
  return { acquired: true, lease };
}

/** Renew only when nodeId is current holder. */
export function renewFederationLease(
  nodeId: string,
  options: { leaseMs?: number; leasePath?: string; nowMs?: number } = {},
): boolean {
  const path = options.leasePath ?? federationLeasePath();
  const existing = readFederationLease(path);
  const now = options.nowMs ?? Date.now();
  if (!existing || !isFederationLeaseValid(existing, now) || existing.holderNodeId !== nodeId) {
    return false;
  }
  const leaseMs = options.leaseMs ?? 30_000;
  const renewed: FederationLease = {
    ...existing,
    expiresAt: new Date(now + leaseMs).toISOString(),
    term: existing.term + 1,
  };
  writeLease(path, renewed);
  appendLeaseAuditEvent({
    type: "renew",
    nodeId,
    holderNodeId: renewed.holderNodeId,
    term: renewed.term,
    storePath: options.leasePath,
  });
  return true;
}

/** P10: Expire lease so another node can acquire (auto-downgrade). */
export function releaseFederationLease(
  nodeId: string,
  options: { leasePath?: string; nowMs?: number } = {},
): boolean {
  const path = options.leasePath ?? federationLeasePath();
  const existing = readFederationLease(path);
  if (!existing || existing.holderNodeId !== nodeId) return false;
  const now = options.nowMs ?? Date.now();
  writeLease(path, {
    ...existing,
    expiresAt: new Date(now - 1000).toISOString(),
  });
  appendLeaseAuditEvent({
    type: "release",
    nodeId,
    holderNodeId: existing.holderNodeId,
    term: existing.term,
    storePath: options.leasePath,
  });
  return true;
}
