/**
 * A2A / federation config types (core layer — no orchestration imports).
 */

export const FEDERATION_CONFLICT_STRATEGIES = [
  "local-wins",
  "newest-wins",
  "remote-wins",
  "vector-wins",
  "crdt-merge",
] as const;

export type FederationConflictStrategy = (typeof FEDERATION_CONFLICT_STRATEGIES)[number];

export const SKILL_DEP_PRUNE_STRATEGIES = ["last-edge", "oldest-dep", "min-edge"] as const;

export type SkillDepPruneStrategy = (typeof SKILL_DEP_PRUNE_STRATEGIES)[number];

export interface A2AServerTlsConfig {
  certPath: string;
  keyPath: string;
  /** CA for validating client certs when requestClientCert is true. */
  caPath?: string;
  requestClientCert?: boolean;
}

export interface A2AClientTlsConfig {
  certPath?: string;
  keyPath?: string;
  caPath?: string;
  rejectUnauthorized?: boolean;
}

/** Phase 7.9: A2A HTTP / federation options under `orchestration.a2a`. */
export type A2AConfig = {
  discoveryUrls?: string[];
  bearerTokens?: string[];
  clientToken?: string;
  tls?: A2AServerTlsConfig;
  clientTls?: A2AClientTlsConfig;
  federationPersist?: boolean;
  federationPath?: string;
  federationSyncUrls?: string[];
  federationConflictStrategy?: FederationConflictStrategy;
  federationNodeId?: string;
  federationQuorumMin?: number;
  federationLeaderElection?: boolean;
  federationLeaderLease?: boolean;
  federationLeaseMs?: number;
  federationLeaseHeartbeat?: boolean;
  federationLeaseHeartbeatMs?: number;
  federationLeaseWitnessUrls?: string[];
  federationSplitBrainAlert?: boolean;
  federationLeaseArbitration?: boolean;
  federationLeaseAutoDowngrade?: boolean;
  federationLeaseQuorumMin?: number;
  federationLeaseWitnessBroadcast?: boolean;
  federationSkillQuorumMin?: number;
  federationSkillDepsBlockSync?: boolean;
  federationSkillDepsPruneSync?: boolean;
  federationSkillDepsPruneStrategy?: SkillDepPruneStrategy;
  federationLeaseAuditSecret?: string;
  federationLeaseAuditNodeId?: string;
  federationLeaseAuditKeyId?: string;
  federationLeaseAuditKeyRing?: Record<string, string>;
  federationBackupPath?: string;
  federationSyncRetries?: number;
  federationTombstoneRetentionMs?: number;
  federationSkillTombstoneRetentionMs?: number;
};
