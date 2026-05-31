/**
 * P9 — Remote lease witness + split-brain detection.
 */

import type { FederationLease } from "./federation-lease.js";
import {
  federationLeasePath,
  isFederationLeaseValid,
  readFederationLease,
} from "./federation-lease.js";

export type FederationLeaseSnapshot = {
  version: 1;
  lease: FederationLease | null;
};

export type LeaseWitness = {
  peerUrl: string;
  lease: FederationLease | null;
  valid: boolean;
};

export type SplitBrainReport = {
  detected: boolean;
  localHolder?: string;
  witnesses: LeaseWitness[];
  conflictingHolders: string[];
};

export function buildFederationLeaseBody(lease: FederationLease | null): FederationLeaseSnapshot {
  return { version: 1, lease };
}

export function parseFederationLeaseBody(body: unknown): FederationLease | null {
  if (!body || typeof body !== "object") return null;
  const lease = (body as FederationLeaseSnapshot).lease;
  if (!lease || typeof lease !== "object") return null;
  if (lease.version !== 1 || typeof lease.holderNodeId !== "string") return null;
  return lease;
}

export async function fetchPeerFederationLease(
  baseUrl: string,
  headers: Record<string, string> = {},
  retries = 1,
): Promise<FederationLease | null> {
  const url = baseUrl.replace(/\/$/, "") + "/a2a/federation/lease";
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) return null;
      return parseFederationLeaseBody(await res.json());
    } catch {
      if (attempt === retries) return null;
    }
  }
  return null;
}

/** Fetch lease witnesses from peer base URLs. */
export async function witnessFederationLeasesFromPeers(options: {
  peerUrls: string[];
  bearerToken?: string;
  retries?: number;
  nowMs?: number;
}): Promise<LeaseWitness[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.bearerToken) headers.Authorization = `Bearer ${options.bearerToken}`;
  const now = options.nowMs ?? Date.now();
  const retries = options.retries ?? 1;
  const out: LeaseWitness[] = [];

  for (const peerUrl of options.peerUrls) {
    const lease = await fetchPeerFederationLease(peerUrl, headers, retries);
    out.push({
      peerUrl,
      lease,
      valid: !!lease && isFederationLeaseValid(lease, now),
    });
  }
  return out;
}

/** True when multiple distinct valid lease holders are observed. */
export function detectFederationSplitBrain(
  localLease: FederationLease | null,
  witnesses: LeaseWitness[],
  nowMs = Date.now(),
): SplitBrainReport {
  const holders = new Set<string>();
  if (localLease && isFederationLeaseValid(localLease, nowMs)) {
    holders.add(localLease.holderNodeId);
  }
  for (const w of witnesses) {
    if (w.valid && w.lease) holders.add(w.lease.holderNodeId);
  }
  const conflictingHolders = [...holders];
  return {
    detected: conflictingHolders.length > 1,
    localHolder: localLease?.holderNodeId,
    witnesses,
    conflictingHolders,
  };
}

/** Read local lease file and compare with peer witnesses. */
export async function checkFederationSplitBrain(options: {
  peerUrls: string[];
  storePath?: string;
  bearerToken?: string;
  retries?: number;
  nowMs?: number;
}): Promise<SplitBrainReport> {
  const localLease = readFederationLease(federationLeasePath(options.storePath));
  const witnesses = await witnessFederationLeasesFromPeers({
    peerUrls: options.peerUrls,
    bearerToken: options.bearerToken,
    retries: options.retries,
    nowMs: options.nowMs,
  });
  return detectFederationSplitBrain(localLease, witnesses, options.nowMs);
}
