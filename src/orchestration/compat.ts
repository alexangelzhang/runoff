/**
 * Legacy config compatibility layer (Wave 7.5).
 *
 * Converts old-style `pipeline` config (step → [provider, ...deps]) into
 * the new `agents` + `orchestration` format, so existing configs keep working.
 */

import type { AgentRole } from "./multi-agent-types.js";
import type { AgentCapability } from "./agent.js";
import type {
  PipelineConfig,
  AgentConfigEntry,
  OrchestrationConfig,
} from "../core/config.js";
import { agentId } from "./multi-agent-types.js";

export interface NormalizedAgentConfig {
  agents: Record<string, AgentConfigEntry>;
  orchestration: OrchestrationConfig;
}

/**
 * If the config already has `agents`, return as-is.
 * Otherwise, derive agents from the legacy `pipeline` section.
 */
export function normalizeAgentConfig(config: PipelineConfig): NormalizedAgentConfig {
  if (config.agents && Object.keys(config.agents).length > 0) {
    return {
      agents: config.agents,
      orchestration: config.orchestration ?? defaultOrchestration(),
    };
  }

  // Legacy conversion: each pipeline step becomes an agent
  const agents: Record<string, AgentConfigEntry> = {};
  const reviewStepName = config.retry?.reviewStep ?? "review";

  for (const [stepName, tuple] of Object.entries(config.pipeline)) {
    const providerRaw = tuple[0];
    const providerName = Array.isArray(providerRaw) ? providerRaw[0] : providerRaw;
    const role: AgentRole = stepName === reviewStepName ? "reviewer" : "worker";
    const capabilities: AgentCapability[] =
      role === "reviewer" ? ["review", "verify"] : ["implement"];

    // Validate the step name is a valid agent id
    agentId(stepName);

    agents[stepName] = {
      role,
      provider: providerName,
      capabilities,
    };
  }

  return {
    agents,
    orchestration: defaultOrchestration(),
  };
}

function defaultOrchestration(): OrchestrationConfig {
  return {
    mode: "dag",
    maxHandoffs: 10,
    conflictResolution: "pick-winner",
  };
}
