/**
 * P11 — Lease write quorum witnesses (peer attestation + local witness log).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getA2AFederationDir } from "../../core/paths.js";
import type { FederationLease } from "./federation-lease.js";
import { isFederationLeaseValid } from "./federation-lease.js";
import { fetchPeerFederationLease } from "./federation-lease-witness.js";
import { resolveFederationQuorumMin } from "./federation-quorum.js";
import { appendLeaseAuditEvent } from "./federation-lease-audit.js";

export type LeaseWriteWitnessEntry = {
  witnessNodeId: string;
  holderNodeId: string;
  term: number;
  at: string;
};

export type LeaseWriteWitnessLog = {
  version: 1;
  updatedAt: string;
  entries: LeaseWriteWitnessEntry[];
};

export type LeaseWitnessReceipt = {
  ok: true;
  receiptId: string;
  recordedAt: string;
  witnessNodeId: string;
  holderNodeId: string;
  term: number;
};

export function federationLeaseWitnessLogPath(storePath?: string): string {
  const base = storePath
    ? storePath.endsWith(".json")
      ? dirname(storePath)
      : storePath
    : getA2AFederationDir();
  return join(base, "lease-quorum-witnesses.json");
}

export function readLeaseWriteWitnessLog(storePath?: string): LeaseWriteWitnessLog {
  const path = federationLeaseWitnessLogPath(storePath);
  if (!existsSync(path)) {
    return { version: 1, updatedAt: new Date(0).toISOString(), entries: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as LeaseWriteWitnessLog;
    if (raw.version !== 1 || !Array.isArray(raw.entries)) {
      return { version: 1, updatedAt: new Date(0).toISOString(), entries: [] };
    }
    return raw;
  } catch {
    return { version: 1, updatedAt: new Date(0).toISOString(), entries: [] };
  }
}

/** Record local attestation after a successful lease write/renew. */
export function recordLeaseWriteWitness(options: {
  witnessNodeId: string;
  lease: FederationLease;
  storePath?: string;
  maxEntries?: number;
}): LeaseWitnessReceipt {
  const path = federationLeaseWitnessLogPath(options.storePath);
  const log = readLeaseWriteWitnessLog(options.storePath);
  const entry: LeaseWriteWitnessEntry = {
    witnessNodeId: options.witnessNodeId,
    holderNodeId: options.lease.holderNodeId,
    term: options.lease.term,
    at: new Date().toISOString(),
  };
  log.entries.push(entry);
  const max = options.maxEntries ?? 200;
  if (log.entries.length > max) {
    log.entries = log.entries.slice(-max);
  }
  log.updatedAt = new Date().toISOString();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(log, null, 2), "utf-8");
  appendLeaseAuditEvent({
    type: "witness",
    nodeId: options.witnessNodeId,
    holderNodeId: entry.holderNodeId,
    term: entry.term,
    detail: "local-write",
    storePath: options.storePath,
  });
  return {
    ok: true,
    receiptId: `lw-${entry.witnessNodeId}-${entry.term}-${Date.now()}`,
    recordedAt: log.updatedAt,
    witnessNodeId: entry.witnessNodeId,
    holderNodeId: entry.holderNodeId,
    term: entry.term,
  };
}

export function buildLeaseWitnessLogBody(log: LeaseWriteWitnessLog): LeaseWriteWitnessLog {
  return log;
}

/** Append a remote witness entry (POST /lease/witness). */
export function recordRemoteLeaseWitness(
  entry: LeaseWriteWitnessEntry,
  storePath?: string,
): LeaseWitnessReceipt {
  const log = readLeaseWriteWitnessLog(storePath);
  log.entries.push(entry);
  const max = 200;
  if (log.entries.length > max) log.entries = log.entries.slice(-max);
  log.updatedAt = new Date().toISOString();
  const path = federationLeaseWitnessLogPath(storePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(log, null, 2), "utf-8");
  appendLeaseAuditEvent({
    type: "witness",
    nodeId: entry.witnessNodeId,
    holderNodeId: entry.holderNodeId,
    term: entry.term,
    detail: "remote-post",
    storePath,
  });
  return {
    ok: true,
    receiptId: `lw-${entry.witnessNodeId}-${entry.term}-${Date.now()}`,
    recordedAt: new Date().toISOString(),
    witnessNodeId: entry.witnessNodeId,
    holderNodeId: entry.holderNodeId,
    term: entry.term,
  };
}

export function parseLeaseWitnessPostBody(body: unknown): LeaseWriteWitnessEntry | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Partial<LeaseWriteWitnessEntry> & { entry?: Partial<LeaseWriteWitnessEntry> };
  const e = raw.entry ?? raw;
  if (typeof e.witnessNodeId !== "string" || typeof e.holderNodeId !== "string") return null;
  if (typeof e.term !== "number") return null;
  return {
    witnessNodeId: e.witnessNodeId,
    holderNodeId: e.holderNodeId,
    term: e.term,
    at: typeof e.at === "string" ? e.at : new Date().toISOString(),
  };
}

export async function postLeaseWitnessReceiptToPeer(
  peerUrl: string,
  entry: LeaseWriteWitnessEntry,
  bearerToken?: string,
): Promise<LeaseWitnessReceipt | null> {
  const url = peerUrl.replace(/\/$/, "") + "/a2a/federation/lease/witness";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ entry }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as LeaseWitnessReceipt;
    return body?.ok ? body : null;
  } catch {
    return null;
  }
}

/** Broadcast local witness entry to peers (best-effort POST receipt). */
export async function broadcastLeaseWitnessToPeers(options: {
  entry: LeaseWriteWitnessEntry;
  peerUrls: string[];
  bearerToken?: string;
}): Promise<{ sent: number; receipts: LeaseWitnessReceipt[] }> {
  const receipts: LeaseWitnessReceipt[] = [];
  for (const peerUrl of options.peerUrls) {
    const receipt = await postLeaseWitnessReceiptToPeer(
      peerUrl,
      options.entry,
      options.bearerToken,
    );
    if (receipt) receipts.push(receipt);
  }
  return { sent: receipts.length, receipts };
}

export function parseLeaseWitnessLogBody(body: unknown): LeaseWriteWitnessLog {
  if (!body || typeof body !== "object") {
    return { version: 1, updatedAt: new Date(0).toISOString(), entries: [] };
  }
  const raw = body as LeaseWriteWitnessLog;
  if (raw.version !== 1 || !Array.isArray(raw.entries)) {
    return { version: 1, updatedAt: new Date(0).toISOString(), entries: [] };
  }
  return raw;
}

/** Count peer attestations that agree on the current valid lease holder. */
export async function countLeaseWriteQuorumVotes(options: {
  holderNodeId: string;
  peerUrls: string[];
  bearerToken?: string;
  retries?: number;
  nowMs?: number;
  storePath?: string;
}): Promise<{ peerVotes: number; logEntries: number; totalVotes: number }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.bearerToken) headers.Authorization = `Bearer ${options.bearerToken}`;
  const now = options.nowMs ?? Date.now();
  let peerVotes = 0;

  for (const peerUrl of options.peerUrls) {
    const lease = await fetchPeerFederationLease(peerUrl, headers, options.retries ?? 1);
    if (lease && isFederationLeaseValid(lease, now) && lease.holderNodeId === options.holderNodeId) {
      peerVotes++;
    }
  }

  const log = readLeaseWriteWitnessLog(options.storePath);
  const logEntries = log.entries.filter((e) => e.holderNodeId === options.holderNodeId).length;

  return { peerVotes, logEntries, totalVotes: peerVotes + 1 };
}

/** Confirm lease write has quorum (local holder + peer agreement). */
export async function confirmLeaseWriteQuorum(options: {
  holderNodeId: string;
  peerUrls: string[];
  quorumMin?: number;
  bearerToken?: string;
  retries?: number;
  nowMs?: number;
  storePath?: string;
}): Promise<{ confirmed: boolean; votes: number; quorumMin: number }> {
  const quorumMin = resolveFederationQuorumMin(options.peerUrls.length + 1, options.quorumMin);
  const { totalVotes } = await countLeaseWriteQuorumVotes({
    holderNodeId: options.holderNodeId,
    peerUrls: options.peerUrls,
    bearerToken: options.bearerToken,
    retries: options.retries,
    nowMs: options.nowMs,
    storePath: options.storePath,
  });
  const confirmed = totalVotes >= quorumMin;
  appendLeaseAuditEvent({
    type: confirmed ? "quorum_ok" : "quorum_fail",
    nodeId: options.holderNodeId,
    holderNodeId: options.holderNodeId,
    detail: `votes=${totalVotes} need=${quorumMin}`,
    storePath: options.storePath,
  });
  return {
    confirmed,
    votes: totalVotes,
    quorumMin,
  };
}
