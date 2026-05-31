/**
 * Phase 7.9 — Wire pipeline config agents to A2A Agent Card registry.
 */

import type { PipelineConfig } from "../../core/config.js";
import { agentId } from "../../orchestration/multi-agent-types.js";
import type { AgentCapability } from "../../orchestration/agent.js";
import {
  AgentCardRegistry,
  type A2AAgentCard,
  type A2ASkill,
} from "./agent-card.js";
import type { InMemoryA2ATransport } from "./transport.js";
import { HttpA2ATransport, type HttpA2ATransportOptions } from "./http-transport.js";

const CAP_MAP: Record<string, AgentCapability> = {
  execute: "implement",
  implement: "implement",
  review: "review",
  plan: "plan",
  refactor: "refactor",
  verify: "verify",
};

function capabilitiesFromStrings(raw?: string[]): AgentCapability[] {
  if (!raw?.length) return ["implement"];
  const out: AgentCapability[] = [];
  for (const c of raw) {
    const mapped = CAP_MAP[c] ?? (c as AgentCapability);
    if (
      ["plan", "implement", "refactor", "review", "verify"].includes(mapped) &&
      !out.includes(mapped)
    ) {
      out.push(mapped);
    }
  }
  return out.length ? out : ["implement"];
}

function skillsFromAgent(name: string, entry: { capabilities?: string[] }): A2ASkill[] {
  const caps = entry.capabilities ?? ["execute"];
  return caps.map((cap) => ({
    id: `${name}-${cap}`,
    name: `${name}: ${cap}`,
    description: `Agent ${name} capability: ${cap}`,
    tags: [cap],
  }));
}

/** Build A2A agent cards from `config.agents` or pipeline step names. */
export function buildAgentCardRegistry(config: PipelineConfig): AgentCardRegistry {
  const registry = new AgentCardRegistry();

  if (config.agents) {
    for (const [name, entry] of Object.entries(config.agents)) {
      const card: A2AAgentCard = {
        agentId: agentId(name),
        name,
        description: `Pipeline agent (${entry.role})`,
        role: entry.role,
        capabilities: capabilitiesFromStrings(entry.capabilities),
        skills: skillsFromAgent(name, entry),
        protocolVersion: "0.1",
        metadata: { provider: entry.provider },
      };
      registry.register(card);
    }
    return registry;
  }

  for (const stepName of Object.keys(config.pipeline)) {
    const card: A2AAgentCard = {
      agentId: agentId(stepName),
      name: stepName,
      description: `Pipeline step agent`,
      role: /review|audit/i.test(stepName) ? "reviewer" : "worker",
      capabilities: ["implement"],
      skills: [
        {
          id: `${stepName}-implement`,
          name: `${stepName} implement`,
          description: `Run pipeline step ${stepName}`,
          tags: ["implement"],
        },
      ],
      protocolVersion: "0.1",
    };
    registry.register(card);
  }

  return registry;
}

/** Build HTTP A2A transport options from pipeline config `orchestration.a2a`. */
export function httpA2ATransportOptionsFromConfig(
  config: PipelineConfig,
  registry?: AgentCardRegistry,
): HttpA2ATransportOptions {
  const a2a = config.orchestration?.a2a;
  return {
    registry,
    remoteDiscoveryUrls: a2a?.discoveryUrls,
    auth: a2a?.bearerTokens?.length ? { bearerTokens: a2a.bearerTokens } : undefined,
    clientToken: a2a?.clientToken,
    tls: a2a?.tls,
    clientTls: a2a?.clientTls,
    federationPersist: a2a?.federationPersist === true,
    federationPath: a2a?.federationPath,
    federationSyncUrls: a2a?.federationSyncUrls,
    federationConflictStrategy: a2a?.federationConflictStrategy,
    federationNodeId: a2a?.federationNodeId,
    federationQuorumMin: a2a?.federationQuorumMin,
    federationLeaderElection: a2a?.federationLeaderElection,
    federationLeaderLease: a2a?.federationLeaderLease,
    federationLeaseMs: a2a?.federationLeaseMs,
    federationLeaseHeartbeat: a2a?.federationLeaseHeartbeat,
    federationLeaseHeartbeatMs: a2a?.federationLeaseHeartbeatMs,
    federationLeaseWitnessUrls: a2a?.federationLeaseWitnessUrls,
    federationSplitBrainAlert: a2a?.federationSplitBrainAlert,
    federationLeaseArbitration: a2a?.federationLeaseArbitration,
    federationLeaseAutoDowngrade: a2a?.federationLeaseAutoDowngrade,
    federationLeaseQuorumMin: a2a?.federationLeaseQuorumMin,
    federationTombstoneRetentionMs: a2a?.federationTombstoneRetentionMs,
    federationSkillTombstoneRetentionMs: a2a?.federationSkillTombstoneRetentionMs,
    federationLeaseWitnessBroadcast: a2a?.federationLeaseWitnessBroadcast,
    federationSkillQuorumMin: a2a?.federationSkillQuorumMin,
    federationSkillDepsBlockSync: a2a?.federationSkillDepsBlockSync,
    federationSkillDepsPruneSync: a2a?.federationSkillDepsPruneSync,
    federationSkillDepsPruneStrategy: a2a?.federationSkillDepsPruneStrategy,
    federationLeaseAuditSecret: a2a?.federationLeaseAuditSecret,
    federationLeaseAuditNodeId: a2a?.federationLeaseAuditNodeId,
    federationLeaseAuditKeyId: a2a?.federationLeaseAuditKeyId,
    federationLeaseAuditKeyRing: a2a?.federationLeaseAuditKeyRing,
    federationBackupPath: a2a?.federationBackupPath,
    federationSyncRetries: a2a?.federationSyncRetries,
  };
}

export function createHttpA2ATransportFromConfig(
  config: PipelineConfig,
  registry?: AgentCardRegistry,
): HttpA2ATransport {
  const reg = registry ?? buildAgentCardRegistry(config);
  return new HttpA2ATransport(httpA2ATransportOptionsFromConfig(config, reg));
}

/** Register in-memory transport handlers that echo task receipt (local stub). */
export function wireA2ATransportFromRegistry(
  registry: AgentCardRegistry,
  transport: InMemoryA2ATransport,
): void {
  for (const card of registry.getAll()) {
    transport.onMessage(card.agentId, async (msg) => {
      return { acknowledged: true, method: msg.method, from: msg.from };
    });
  }
}
