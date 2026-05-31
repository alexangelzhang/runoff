/**
 * P6 — Deterministic federation leader election (operational MVP).
 *
 * Leader = lexicographically smallest node id among self + reachable peers.
 * Pull sync on all nodes; push to peers only when local node is leader.
 */

import { logger } from "../../core/logger.js";
import { probeFederationPeers } from "./federation-ha.js";
import {
  federationLeasePath,
  releaseFederationLease,
  tryAcquireFederationLease,
} from "./federation-lease.js";
import {
  broadcastLeaseWitnessToPeers,
  confirmLeaseWriteQuorum,
  recordLeaseWriteWitness,
} from "./federation-lease-quorum.js";

export function nodeIdFromPeerUrl(peerUrl: string): string {
  try {
    const u = new URL(peerUrl);
    return u.hostname || peerUrl;
  } catch {
    return peerUrl.replace(/[^a-zA-Z0-9._-]/g, "_");
  }
}

/** Pick stable leader from cluster member ids. */
export function electFederationLeaderNodeId(clusterNodeIds: string[]): string {
  const unique = [...new Set(clusterNodeIds.filter(Boolean))].sort();
  return unique[0] ?? "local";
}

export type FederationLeaderRole = {
  leaderNodeId: string;
  isLeader: boolean;
  clusterNodeIds: string[];
  reachableNodeIds: string[];
};

/**
 * Resolve whether the local node should push federation updates.
 * Reachable peers are probed via GET /a2a/federation/directory.
 */
export async function resolveFederationLeaderRole(options: {
  nodeId: string;
  peerUrls: string[];
  bearerToken?: string;
  /** P7: file lease instead of lexicographic min (when true). */
  leaderLease?: boolean;
  leaseMs?: number;
  storePath?: string;
  /** P11: peer URLs to confirm lease write quorum. */
  leaseWitnessUrls?: string[];
  leaseQuorumMin?: number;
  /** P12: POST witness receipt to peers after local write. */
  leaseWitnessBroadcast?: boolean;
}): Promise<FederationLeaderRole> {
  const peerIds = options.peerUrls.map(nodeIdFromPeerUrl);
  const clusterNodeIds = [options.nodeId, ...peerIds];

  const probes = options.peerUrls.length
    ? await probeFederationPeers(options.peerUrls, options.bearerToken)
    : {};

  const reachableNodeIds = [
    options.nodeId,
    ...options.peerUrls.filter((url) => probes[url]).map(nodeIdFromPeerUrl),
  ];

  if (options.leaderLease) {
    const leasePath = federationLeasePath(options.storePath);
    const { acquired, lease } = tryAcquireFederationLease({
      nodeId: options.nodeId,
      leaseMs: options.leaseMs,
      leasePath,
    });
    let isLeader = acquired;
    if (acquired) {
      const entry = {
        witnessNodeId: options.nodeId,
        holderNodeId: lease.holderNodeId,
        term: lease.term,
        at: new Date().toISOString(),
      };
      recordLeaseWriteWitness({
        witnessNodeId: options.nodeId,
        lease,
        storePath: options.storePath,
      });
      if (
        options.leaseWitnessBroadcast !== false &&
        options.leaseWitnessUrls?.length
      ) {
        await broadcastLeaseWitnessToPeers({
          entry,
          peerUrls: options.leaseWitnessUrls,
          bearerToken: options.bearerToken,
        });
      }
      const quorumMin = options.leaseQuorumMin ?? 1;
      if (quorumMin > 1 && options.leaseWitnessUrls?.length) {
        const quorum = await confirmLeaseWriteQuorum({
          holderNodeId: lease.holderNodeId,
          peerUrls: options.leaseWitnessUrls,
          quorumMin,
          bearerToken: options.bearerToken,
          storePath: options.storePath,
        });
        if (!quorum.confirmed) {
          releaseFederationLease(options.nodeId, { leasePath });
          isLeader = false;
          logger.warn("federation", `lease quorum not met: votes=${quorum.votes} need=${quorum.quorumMin}`);
        }
      }
    }
    return {
      leaderNodeId: lease.holderNodeId,
      isLeader,
      clusterNodeIds,
      reachableNodeIds,
    };
  }

  const leaderPool = reachableNodeIds.length > 0 ? reachableNodeIds : clusterNodeIds;
  const leaderNodeId = electFederationLeaderNodeId(leaderPool);

  return {
    leaderNodeId,
    isLeader: leaderNodeId === options.nodeId,
    clusterNodeIds,
    reachableNodeIds,
  };
}
