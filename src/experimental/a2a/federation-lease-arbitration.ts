/**
 * P10 — Lease arbitration on split-brain + auto-downgrade (relinquish non-winner).
 */

import type { FederationLease } from "./federation-lease.js";
import {
  federationLeasePath,
  isFederationLeaseValid,
  readFederationLease,
  releaseFederationLease,
} from "./federation-lease.js";
import { appendLeaseAuditEvent } from "./federation-lease-audit.js";
import {
  detectFederationSplitBrain,
  type LeaseWitness,
  type SplitBrainReport,
  witnessFederationLeasesFromPeers,
} from "./federation-lease-witness.js";

export type FederationLeaseArbitration = {
  winner: FederationLease | null;
  winnerHolder: string | null;
  /** Highest term among candidates. */
  term: number;
  reason: "no-valid-leases" | "highest-term" | "single-holder";
};

/** Pick canonical lease: highest term, tie-break lexicographic holderNodeId. */
export function arbitrateFederationLease(
  localLease: FederationLease | null,
  witnesses: LeaseWitness[],
  nowMs = Date.now(),
): FederationLeaseArbitration {
  const candidates: FederationLease[] = [];
  if (localLease && isFederationLeaseValid(localLease, nowMs)) {
    candidates.push(localLease);
  }
  for (const w of witnesses) {
    if (w.valid && w.lease) candidates.push(w.lease);
  }
  if (candidates.length === 0) {
    return { winner: null, winnerHolder: null, term: 0, reason: "no-valid-leases" };
  }
  if (candidates.length === 1) {
    const w = candidates[0]!;
    return {
      winner: w,
      winnerHolder: w.holderNodeId,
      term: w.term,
      reason: "single-holder",
    };
  }
  candidates.sort((a, b) => {
    if (b.term !== a.term) return b.term - a.term;
    return a.holderNodeId.localeCompare(b.holderNodeId);
  });
  const winner = candidates[0]!;
  return {
    winner,
    winnerHolder: winner.holderNodeId,
    term: winner.term,
    reason: "highest-term",
  };
}

export function arbitrateFromSplitBrainReport(
  report: SplitBrainReport,
  localLease: FederationLease | null,
  nowMs = Date.now(),
): FederationLeaseArbitration {
  return arbitrateFederationLease(localLease, report.witnesses, nowMs);
}

/** True when local node should relinquish leadership after split-brain arbitration. */
export function shouldAutoDowngradeLease(
  localNodeId: string,
  splitBrain: SplitBrainReport,
  arbitration: FederationLeaseArbitration,
): boolean {
  if (!splitBrain.detected || !arbitration.winnerHolder) return false;
  return arbitration.winnerHolder !== localNodeId;
}

export type LeaseDowngradeResult = {
  downgraded: boolean;
  reason?: string;
};

/** Expire local lease when local lost arbitration. */
export function applyLeaseAutoDowngrade(options: {
  localNodeId: string;
  splitBrain: SplitBrainReport;
  arbitration: FederationLeaseArbitration;
  storePath?: string;
  nowMs?: number;
}): LeaseDowngradeResult {
  if (!shouldAutoDowngradeLease(options.localNodeId, options.splitBrain, options.arbitration)) {
    return { downgraded: false };
  }
  appendLeaseAuditEvent({
    type: "downgrade",
    nodeId: options.localNodeId,
    holderNodeId: options.arbitration.winnerHolder ?? undefined,
    detail: options.splitBrain.detected ? "split-brain" : undefined,
    storePath: options.storePath,
  });
  const released = releaseFederationLease(options.localNodeId, {
    leasePath: federationLeasePath(options.storePath),
    nowMs: options.nowMs,
  });
  return {
    downgraded: released,
    reason: released
      ? `relinquished lease; canonical holder=${options.arbitration.winnerHolder}`
      : "not local lease holder",
  };
}

/** Witness + split-brain + optional arbitration/downgrade. */
export async function resolveFederationLeaseConflict(options: {
  localNodeId: string;
  peerUrls: string[];
  storePath?: string;
  bearerToken?: string;
  retries?: number;
  nowMs?: number;
  arbitrate?: boolean;
  autoDowngrade?: boolean;
}): Promise<{
  splitBrain: SplitBrainReport;
  arbitration?: FederationLeaseArbitration;
  downgrade?: LeaseDowngradeResult;
}> {
  const localLease = readFederationLease(federationLeasePath(options.storePath));
  const witnesses = await witnessFederationLeasesFromPeers({
    peerUrls: options.peerUrls,
    bearerToken: options.bearerToken,
    retries: options.retries,
    nowMs: options.nowMs,
  });
  const report = detectFederationSplitBrain(localLease, witnesses, options.nowMs);

  let arbitration: FederationLeaseArbitration | undefined;
  if (options.arbitrate !== false) {
    arbitration = arbitrateFromSplitBrainReport(report, localLease, options.nowMs);
  }

  let downgrade: LeaseDowngradeResult | undefined;
  if (
    report.detected &&
    arbitration &&
    options.autoDowngrade !== false &&
    options.localNodeId
  ) {
    downgrade = applyLeaseAutoDowngrade({
      localNodeId: options.localNodeId,
      splitBrain: report,
      arbitration,
      storePath: options.storePath,
      nowMs: options.nowMs,
    });
  }

  return { splitBrain: report, arbitration, downgrade };
}
