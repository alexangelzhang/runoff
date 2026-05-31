/**
 * P8 — Background federation leader lease renewal.
 */

import {
  federationLeasePath,
  readFederationLease,
  renewFederationLease,
  tryAcquireFederationLease,
} from "./federation-lease.js";
import { recordLeaseWriteWitness } from "./federation-lease-quorum.js";

export type FederationLeaseHeartbeatHandle = {
  stop: () => void;
};

/** Periodically renew (or re-acquire) the leader lease file. */
export function startFederationLeaseHeartbeat(options: {
  nodeId: string;
  leaseMs?: number;
  intervalMs?: number;
  storePath?: string;
}): FederationLeaseHeartbeatHandle {
  const leasePath = federationLeasePath(options.storePath);
  const leaseMs = options.leaseMs ?? 30_000;
  const intervalMs = options.intervalMs ?? Math.max(5_000, Math.floor(leaseMs / 3));

  const tick = (): void => {
    const renewed = renewFederationLease(options.nodeId, { leaseMs, leasePath });
    if (!renewed) {
      tryAcquireFederationLease({ nodeId: options.nodeId, leaseMs, leasePath });
    }
    const lease = readFederationLease(leasePath);
    if (lease && lease.holderNodeId === options.nodeId) {
      recordLeaseWriteWitness({
        witnessNodeId: options.nodeId,
        lease,
        storePath: options.storePath,
      });
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  return {
    stop: () => clearInterval(timer),
  };
}
