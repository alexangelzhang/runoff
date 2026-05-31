import type { FederationConflictStrategy } from "../../core/a2a-config-types.js";
import type { SkillDepPruneStrategy } from "../../core/a2a-config-types.js";
import type { A2AClientTlsConfig, A2AServerTlsConfig } from "../../core/a2a-config-types.js";
import type { AgentCardRegistry } from "./agent-card.js";

export interface A2AHttpAuthConfig {
  /** When non-empty, POST /a2a/send requires matching Bearer token. */
  bearerTokens?: string[];
}

export interface HttpA2ATransportOptions {
  host?: string;
  port?: number;
  auth?: A2AHttpAuthConfig;
  registry?: AgentCardRegistry;
  remoteDiscoveryUrls?: string[];
  clientToken?: string;
  tls?: A2AServerTlsConfig;
  clientTls?: A2AClientTlsConfig;
  remoteDiscoveryTtlMs?: number;
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
  federationTombstoneRetentionMs?: number;
  federationSkillTombstoneRetentionMs?: number;
  federationBackupPath?: string;
  federationSyncRetries?: number;
}
