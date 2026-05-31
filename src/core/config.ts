import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LLMProvider, ProviderMode } from "../providers/types.js";
import { OpenAIProvider } from "../providers/openai.js";
import { CLIProvider } from "../providers/cli.js";
import { MockProvider } from "../providers/mock.js";
import { computePipelineStages } from "../orchestration/dag.js";

export type ProviderConfig = {
  type: "openai" | "anthropic" | "builtin" | "cli" | "mock";
  model?: string;
  apiKey?: string;
  command?: string;
  args?: string[];
  timeoutMs?: number;
  mode?: ProviderMode;
  /** Phase 5.3: declarative tier (overrides name heuristics in router). */
  tier?: "lite" | "full";
  /** Optional cost hint (USD per 1M tokens) for economics routing. */
  costPerToken?: number;
  /** Optional latency hint (ms) for tie-breaking. */
  avgLatencyMs?: number;
};

/** Agent config entry in the new `agents` section (Wave 7.5). */
export type AgentConfigEntry = {
  role: "orchestrator" | "worker" | "reviewer";
  provider: string;
  capabilities?: string[];
  maxRounds?: number;
};

/** Orchestration config (Wave 7.5). */
export type OrchestrationConfig = {
  mode: "dag" | "llm-driven" | "workflow";
  maxHandoffs?: number;
  conflictResolution?: "auto-merge" | "llm-merge" | "pick-winner";
  /** Phase 5.4: max USD spend for one parallel race step (falls back to runtime.costBudgetUSD). */
  raceBudgetUSD?: number;
  /** Phase 5.4: abort losing racers after the first viable winner (default true). */
  raceEarlyTermination?: boolean;
  /** Phase 7.3: expose agents as orchestrator-callable tools (registry built at run start). */
  useAgentTools?: boolean;
  /** Phase 8: provider name for external LLM planner (llm-driven mode). */
  plannerProvider?: string;
  /** Phase 9+: DeerFlow-style reflect → re-plan (llm-driven only). */
  reflect?: {
    enabled?: boolean;
    provider?: string;
    onReviewRevision?: boolean;
    onStepFailure?: boolean;
  };
  /** Phase 8.1.2: auto-compact persistent memory after successful pipeline. */
  memoryAutoCompact?: boolean;
  /** M1: on pipeline start, use retrieveMerged for pattern semantic match (layered backends only). */
  memoryHybridRetrieve?: boolean;
  /** M1: max ms to wait for hybrid retrieve before local-only fallback (default 800). */
  memoryHybridRetrieveTimeoutMs?: number;
  /** M2: offline Dream worker (track A/B/C). */
  dream?: {
    enabled?: boolean;
    llmEnabled?: boolean;
    batchLimit?: number;
    sinceLastRun?: boolean;
    project?: string;
    provider?: string;
  };
  /** M3: Dreamify retrieval tuning (experiment-driven grid search). */
  dreamify?: {
    experimentId?: string;
    project?: string;
    multiStrategy?: boolean;
    exportOnDreamRun?: boolean;
  };
  /** P3: local file memory (default) or HTTP mirror (Mem0/Zep-style). */
  memoryBackend?: {
    type: "local" | "http" | "mem0" | "zep";
    baseUrl?: string;
    apiKey?: string;
    userId?: string;
    sessionId?: string;
    timeoutMs?: number;
    variant?: "platform" | "oss";
    transport?: "rest" | "sdk" | "auto";
  };
  /** Phase 7.9: A2A HTTP mTLS + external agent discovery. See A2AConfig for field groups. */
  a2a?: A2AConfig;
};

/** Governance / policy / guardrails / approval (Phase 2 + 7.7/7.8). */
export type GovernanceConfig = {
  enabled?: boolean;
  defaultPolicy?: "allow" | "deny" | "require-approval";
  rules?: Array<{
    name: string;
    role?: "orchestrator" | "worker" | "reviewer";
    action?: string;
    pathPrefix?: string;
    decision: "allow" | "deny" | "require-approval";
  }>;
  maxPromptChars?: number;
  maxStepExecutionsPerStep?: number;
  tripwireOnFailedResponse?: boolean;
  /** Block secrets in input/output (default true when `enabled`). */
  detectSecrets?: boolean;
  /** Block PII patterns in input/output (default true when `enabled`). */
  detectPii?: boolean;
  /** Block prompt-injection phrases in input (default true when `enabled`). */
  detectPromptInjection?: boolean;
  /** Block path traversal / sensitive paths in input (default true when `enabled`). */
  detectForbiddenPaths?: boolean;
  /** Reject successful empty model output (default true when `enabled`). */
  rejectEmptyOutput?: boolean;
  /** Max chars in model output per step (default 2_000_000 when `enabled`). */
  maxOutputChars?: number;
  approvalMode?: "auto" | "defer" | "callback";
  approvalRiskThreshold?: "low" | "medium" | "high";
  /** Phase 7.8 A: pause after orchestrator.plan() until operator approves. */
  requirePlanApproval?: boolean;
};

/** Runtime switches (Phase 1 wiring + Phase 8 cost). */
export type PipelineRuntimeConfig = {
  /** Pipeline-wide USD budget; exceeding aborts the run (CostGovernor). */
  costBudgetUSD?: number;
  /** `file` persists RunStore/EventLog/MessageBus under ~/.llm-pipeline/control-plane. */
  controlPlane?: "memory" | "file";
  governance?: GovernanceConfig;
  /** Phase 8.2.2: enable semantic prompt similarity cache in llm_run_step. */
  semanticCache?: boolean;
  /** Phase 8.2.2: Jaccard threshold for semantic cache hits (default 0.95). */
  semanticCacheMinSimilarity?: number;
  /** Phase 8.3.10: export pipeline trace spans on pipeline end. */
  otelExport?: boolean;
  /** `memory` (default) or `otlp` (HTTP POST /v1/traces). OTLP when endpoint set. */
  otelExporter?: "memory" | "otlp";
  /** OTLP collector URL (e.g. http://localhost:4318 or full /v1/traces). Env: OTEL_EXPORTER_OTLP_ENDPOINT. */
  otelEndpoint?: string;
  otelServiceName?: string;
  otelHeaders?: Record<string, string>;
  /** Phase 8.3.11: persist structured prompts per step (default on; `LLM_PROMPT_VERSIONS=0` disables). */
  promptVersionStore?: boolean;
};

export type PipelineConfig = {
  providers: Record<string, ProviderConfig>;
  /**
   * Each step is defined as [providerName | [provider1, provider2], ...dependsOn]
   * (Wave 6: Race mode support)
   */
  pipeline: Record<string, [string | string[], ...string[]]>;
  routing?: Array<{
    complexity?: "low" | "medium" | "high";
    pattern?: string;
    provider: string;
  }>;
  retry?: {
    maxRounds: number;
    reviewStep?: string;
  };
  /** Wave 7.5: Explicit agent declarations. When omitted, agents are derived from `pipeline`. */
  agents?: Record<string, AgentConfigEntry>;
  /** Wave 7.5: Orchestration mode and conflict resolution. */
  orchestration?: OrchestrationConfig;
  /** Phase 1/8: runtime switches (cost budget, observability, A2A). */
  runtime?: PipelineRuntimeConfig;
};

let _cachedConfig: PipelineConfig | null = null;

/** No-op kept for callers after dynamic DAG inject; {@link getDagStages} always recomputes. */
export function clearDagStagesCache(): void {}

/** Clears memoized config from {@link loadConfig} (for tests and hot-reload tooling). */
export function clearConfigCache(): void {
  _cachedConfig = null;
  clearDagStagesCache();
}

// ---------------------------------------------------------------------------
// Private sub-validators — each owns one top-level config section.
// ---------------------------------------------------------------------------

function validateProviders(providers: Record<string, unknown>): void {
  for (const [name, raw] of Object.entries(providers)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Provider "${name}" must be an object`);
    }
    const pc = raw as Record<string, unknown>;
    if (pc.tier !== undefined && pc.tier !== "lite" && pc.tier !== "full") {
      throw new Error(`Provider "${name}" tier must be "lite" or "full"`);
    }
    if (pc.costPerToken !== undefined && (typeof pc.costPerToken !== "number" || pc.costPerToken < 0)) {
      throw new Error(`Provider "${name}" costPerToken must be a non-negative number`);
    }
    if (pc.avgLatencyMs !== undefined && (typeof pc.avgLatencyMs !== "number" || pc.avgLatencyMs < 0)) {
      throw new Error(`Provider "${name}" avgLatencyMs must be a non-negative number`);
    }
  }
}

function validatePipelineSteps(
  pipeline: Record<string, unknown>,
  providers: Record<string, unknown>,
): void {
  const allSteps = Object.keys(pipeline);
  for (const [stepName, stepConfig] of Object.entries(pipeline)) {
    if (!Array.isArray(stepConfig)) {
      throw new Error(`Step "${stepName}" must use the tuple DSL [provider, ...dependsOn], not an object.`);
    }
    if (stepConfig.length === 0) {
      throw new Error(`Step "${stepName}" must be an array with [provider, ...dependsOn]`);
    }
    const [pRaw, ...deps] = stepConfig;
    for (const pName of (Array.isArray(pRaw) ? pRaw : [pRaw])) {
      if (typeof pName !== "string") {
        throw new Error(`Step "${stepName}" provider entry must be a string or array of strings`);
      }
      if (!providers[pName] && pName !== "builtin") {
        throw new Error(`Step "${stepName}" references unknown provider "${pName}"`);
      }
    }
    for (const dep of deps) {
      if (typeof dep !== "string") throw new Error(`Step "${stepName}" dependsOn entries must be strings`);
      if (dep === stepName) throw new Error(`Step "${stepName}" cannot depend on itself`);
      if (!allSteps.includes(dep)) throw new Error(`Step "${stepName}" dependsOn references unknown step "${dep}"`);
    }
  }
  computePipelineStages(pipeline as PipelineConfig["pipeline"]);
}

function validateAgents(agents: Record<string, unknown>, providers: Record<string, unknown>): void {
  const validRoles = ["orchestrator", "worker", "reviewer"];
  for (const [agentName, agentRaw] of Object.entries(agents)) {
    if (!agentRaw || typeof agentRaw !== "object" || Array.isArray(agentRaw)) {
      throw new Error(`Agent "${agentName}" must be an object`);
    }
    const agent = agentRaw as Record<string, unknown>;
    if (typeof agent.role !== "string" || !validRoles.includes(agent.role)) {
      throw new Error(`Agent "${agentName}" role must be one of: ${validRoles.join(", ")}`);
    }
    if (typeof agent.provider !== "string") throw new Error(`Agent "${agentName}" must have a string provider`);
    if (!providers[agent.provider] && agent.provider !== "builtin") {
      throw new Error(`Agent "${agentName}" references unknown provider "${agent.provider}"`);
    }
    if (agent.capabilities !== undefined) {
      if (!Array.isArray(agent.capabilities) || !agent.capabilities.every((c: unknown) => typeof c === "string")) {
        throw new Error(`Agent "${agentName}" capabilities must be an array of strings`);
      }
    }
  }
}

function validateOrchestration(orch: Record<string, unknown>): void {
  const validModes = ["dag", "llm-driven", "workflow"];
  if (typeof orch.mode !== "string" || !validModes.includes(orch.mode)) {
    throw new Error(`orchestration.mode must be one of: ${validModes.join(", ")}`);
  }
  if (orch.maxHandoffs !== undefined && (typeof orch.maxHandoffs !== "number" || orch.maxHandoffs < 0)) {
    throw new Error("orchestration.maxHandoffs must be a non-negative number");
  }
  const validCR = ["auto-merge", "llm-merge", "pick-winner"];
  if (orch.conflictResolution !== undefined && (typeof orch.conflictResolution !== "string" || !validCR.includes(orch.conflictResolution))) {
    throw new Error(`orchestration.conflictResolution must be one of: ${validCR.join(", ")}`);
  }
  if (orch.raceBudgetUSD !== undefined && (typeof orch.raceBudgetUSD !== "number" || orch.raceBudgetUSD <= 0)) {
    throw new Error("orchestration.raceBudgetUSD must be a positive number");
  }
  if (orch.raceEarlyTermination !== undefined && typeof orch.raceEarlyTermination !== "boolean") {
    throw new Error("orchestration.raceEarlyTermination must be a boolean");
  }
  if (orch.useAgentTools !== undefined && typeof orch.useAgentTools !== "boolean") {
    throw new Error("orchestration.useAgentTools must be a boolean");
  }
  if (orch.reflect !== undefined) {
    const r = orch.reflect as Record<string, unknown>;
    if (typeof r !== "object" || r === null || Array.isArray(r)) throw new Error("orchestration.reflect must be an object");
    for (const f of ["enabled", "onReviewRevision", "onStepFailure"] as const) {
      if (r[f] !== undefined && typeof r[f] !== "boolean") throw new Error(`orchestration.reflect.${f} must be a boolean`);
    }
    if (r.provider !== undefined && typeof r.provider !== "string") throw new Error("orchestration.reflect.provider must be a string");
    if (r.enabled === true && orch.mode !== "llm-driven") throw new Error("orchestration.reflect.enabled requires orchestration.mode llm-driven");
  }
  if (orch.memoryHybridRetrieve !== undefined && typeof orch.memoryHybridRetrieve !== "boolean") {
    throw new Error("orchestration.memoryHybridRetrieve must be a boolean");
  }
  if (orch.memoryHybridRetrieveTimeoutMs !== undefined && (typeof orch.memoryHybridRetrieveTimeoutMs !== "number" || orch.memoryHybridRetrieveTimeoutMs < 0)) {
    throw new Error("orchestration.memoryHybridRetrieveTimeoutMs must be a non-negative number");
  }
  if (orch.dream !== undefined) {
    const d = orch.dream as Record<string, unknown>;
    if (typeof d !== "object" || d === null || Array.isArray(d)) throw new Error("orchestration.dream must be an object");
    for (const f of ["enabled", "llmEnabled", "sinceLastRun"] as const) {
      if (d[f] !== undefined && typeof d[f] !== "boolean") throw new Error(`orchestration.dream.${f} must be a boolean`);
    }
    if (d.batchLimit !== undefined && (typeof d.batchLimit !== "number" || d.batchLimit < 1)) throw new Error("orchestration.dream.batchLimit must be a positive number");
    if (d.project !== undefined && typeof d.project !== "string") throw new Error("orchestration.dream.project must be a string");
    if (d.provider !== undefined && typeof d.provider !== "string") throw new Error("orchestration.dream.provider must be a string");
  }
  if (orch.dreamify !== undefined) {
    const df = orch.dreamify as Record<string, unknown>;
    if (typeof df !== "object" || df === null || Array.isArray(df)) throw new Error("orchestration.dreamify must be an object");
    for (const f of ["multiStrategy", "exportOnDreamRun"] as const) {
      if (df[f] !== undefined && typeof df[f] !== "boolean") throw new Error(`orchestration.dreamify.${f} must be a boolean`);
    }
    if (df.experimentId !== undefined && typeof df.experimentId !== "string") throw new Error("orchestration.dreamify.experimentId must be a string");
    if (df.project !== undefined && typeof df.project !== "string") throw new Error("orchestration.dreamify.project must be a string");
  }
  if (orch.memoryBackend !== undefined) {
    const m = orch.memoryBackend as Record<string, unknown>;
    if (typeof m !== "object" || m === null || Array.isArray(m)) throw new Error("orchestration.memoryBackend must be an object");
    const validMb = ["local", "http", "mem0", "zep"];
    if (typeof m.type !== "string" || !validMb.includes(m.type)) throw new Error(`orchestration.memoryBackend.type must be one of: ${validMb.join(", ")}`);
    if (m.baseUrl !== undefined && typeof m.baseUrl !== "string") throw new Error("orchestration.memoryBackend.baseUrl must be a string");
    if (m.variant !== undefined && m.variant !== "platform" && m.variant !== "oss") throw new Error('orchestration.memoryBackend.variant must be "platform" or "oss"');
    if (m.sessionId !== undefined && typeof m.sessionId !== "string") throw new Error("orchestration.memoryBackend.sessionId must be a string");
    const validTransport = ["rest", "sdk", "auto"];
    if (m.transport !== undefined && (typeof m.transport !== "string" || !validTransport.includes(m.transport))) {
      throw new Error(`orchestration.memoryBackend.transport must be one of: ${validTransport.join(", ")}`);
    }
  }
  const a2a = orch.a2a as Record<string, unknown> | undefined;
  if (a2a !== undefined) {
    if (typeof a2a !== "object" || a2a === null || Array.isArray(a2a)) throw new Error("orchestration.a2a must be an object");
    const validFed = ["local-wins", "newest-wins", "remote-wins", "vector-wins", "crdt-merge"];
    if (a2a.federationConflictStrategy !== undefined && (typeof a2a.federationConflictStrategy !== "string" || !validFed.includes(a2a.federationConflictStrategy))) {
      throw new Error(`orchestration.a2a.federationConflictStrategy must be one of: ${validFed.join(", ")}`);
    }
    for (const f of ["federationNodeId", "federationBackupPath", "federationLeaseAuditSecret", "federationLeaseAuditNodeId", "federationLeaseAuditKeyId"] as const) {
      if (a2a[f] !== undefined && typeof a2a[f] !== "string") throw new Error(`orchestration.a2a.${f} must be a string`);
    }
    for (const f of ["federationPersist", "federationLeaderElection", "federationLeaderLease", "federationLeaseHeartbeat", "federationSplitBrainAlert", "federationLeaseArbitration", "federationLeaseAutoDowngrade", "federationLeaseWitnessBroadcast", "federationSkillDepsBlockSync", "federationSkillDepsPruneSync"] as const) {
      if (a2a[f] !== undefined && typeof a2a[f] !== "boolean") throw new Error(`orchestration.a2a.${f} must be a boolean`);
    }
    for (const [f, min] of [["federationQuorumMin", 1], ["federationLeaseQuorumMin", 1], ["federationSkillQuorumMin", 1]] as const) {
      if (a2a[f] !== undefined && (typeof a2a[f] !== "number" || (a2a[f] as number) < min)) {
        throw new Error(`orchestration.a2a.${f} must be a positive number`);
      }
    }
    if (a2a.federationLeaseMs !== undefined && (typeof a2a.federationLeaseMs !== "number" || a2a.federationLeaseMs < 1000)) throw new Error("orchestration.a2a.federationLeaseMs must be >= 1000");
    if (a2a.federationLeaseHeartbeatMs !== undefined && (typeof a2a.federationLeaseHeartbeatMs !== "number" || a2a.federationLeaseHeartbeatMs < 1000)) throw new Error("orchestration.a2a.federationLeaseHeartbeatMs must be >= 1000");
    for (const f of ["federationTombstoneRetentionMs", "federationSkillTombstoneRetentionMs"] as const) {
      if (a2a[f] !== undefined && (typeof a2a[f] !== "number" || (a2a[f] as number) < 0)) throw new Error(`orchestration.a2a.${f} must be >= 0`);
    }
    if (a2a.federationLeaseWitnessUrls !== undefined && (!Array.isArray(a2a.federationLeaseWitnessUrls) || !a2a.federationLeaseWitnessUrls.every((u) => typeof u === "string"))) {
      throw new Error("orchestration.a2a.federationLeaseWitnessUrls must be a string array");
    }
    if (a2a.federationSkillDepsPruneStrategy !== undefined) {
      const s = a2a.federationSkillDepsPruneStrategy;
      if (s !== "last-edge" && s !== "oldest-dep" && s !== "min-edge") throw new Error("orchestration.a2a.federationSkillDepsPruneStrategy must be last-edge, oldest-dep, or min-edge");
    }
    if (a2a.federationLeaseAuditKeyRing !== undefined) {
      const ring = a2a.federationLeaseAuditKeyRing;
      if (typeof ring !== "object" || ring === null || Array.isArray(ring) || !Object.values(ring).every((v) => typeof v === "string")) {
        throw new Error("orchestration.a2a.federationLeaseAuditKeyRing must be a string record");
      }
    }
  }
}

function validateRuntime(runtime: Record<string, unknown>): void {
  if (runtime.costBudgetUSD !== undefined && (typeof runtime.costBudgetUSD !== "number" || runtime.costBudgetUSD <= 0)) {
    throw new Error("runtime.costBudgetUSD must be a positive number");
  }
  if (runtime.controlPlane !== undefined && runtime.controlPlane !== "memory" && runtime.controlPlane !== "file") {
    throw new Error('runtime.controlPlane must be "memory" or "file"');
  }
  if (runtime.governance !== undefined) {
    const g = runtime.governance as Record<string, unknown>;
    if (typeof g !== "object" || g === null || Array.isArray(g)) throw new Error("runtime.governance must be an object");
    if (g.enabled !== undefined && typeof g.enabled !== "boolean") throw new Error("runtime.governance.enabled must be a boolean");
    if (g.maxPromptChars !== undefined && (typeof g.maxPromptChars !== "number" || g.maxPromptChars < 1)) throw new Error("runtime.governance.maxPromptChars must be a positive number");
    if (g.maxStepExecutionsPerStep !== undefined && (typeof g.maxStepExecutionsPerStep !== "number" || g.maxStepExecutionsPerStep < 1)) throw new Error("runtime.governance.maxStepExecutionsPerStep must be a positive number");
    if (g.approvalMode !== undefined && g.approvalMode !== "auto" && g.approvalMode !== "defer" && g.approvalMode !== "callback") {
      throw new Error('runtime.governance.approvalMode must be "auto", "defer", or "callback"');
    }
    if (g.requirePlanApproval !== undefined && typeof g.requirePlanApproval !== "boolean") throw new Error("runtime.governance.requirePlanApproval must be a boolean");
    for (const flag of ["detectSecrets", "detectPii", "detectPromptInjection", "detectForbiddenPaths", "rejectEmptyOutput", "tripwireOnFailedResponse"] as const) {
      if (g[flag] !== undefined && typeof g[flag] !== "boolean") throw new Error(`runtime.governance.${flag} must be a boolean`);
    }
    if (g.maxOutputChars !== undefined && (typeof g.maxOutputChars !== "number" || g.maxOutputChars < 1)) throw new Error("runtime.governance.maxOutputChars must be a positive number");
    if (g.rules !== undefined) {
      if (!Array.isArray(g.rules)) throw new Error("runtime.governance.rules must be an array");
      const decisions = ["allow", "deny", "require-approval"];
      for (let i = 0; i < g.rules.length; i++) {
        const rule = g.rules[i] as Record<string, unknown>;
        if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error(`runtime.governance.rules[${i}] must be an object`);
        if (typeof rule.name !== "string" || !rule.name.trim()) throw new Error(`runtime.governance.rules[${i}].name must be a non-empty string`);
        if (!decisions.includes(rule.decision as string)) throw new Error(`runtime.governance.rules[${i}].decision must be one of: ${decisions.join(", ")}`);
      }
    }
  }
}

/**
 * Deep validation for pipeline configuration.
 * (Wave 5: Strict Schema & DAG integrity)
 */
export function validateConfig(config: unknown): config is PipelineConfig {
  if (!config || typeof config !== "object" || config === null) throw new Error("Config must be an object");
  const c = config as Record<string, unknown>;
  if (!c.providers || typeof c.providers !== "object" || Array.isArray(c.providers)) throw new Error("Missing providers object");
  if (!c.pipeline || typeof c.pipeline !== "object" || Array.isArray(c.pipeline)) throw new Error("Missing pipeline object");

  const providers = c.providers as Record<string, unknown>;
  validateProviders(providers);
  validatePipelineSteps(c.pipeline as Record<string, unknown>, providers);
  if (c.agents !== undefined) {
    if (typeof c.agents !== "object" || c.agents === null || Array.isArray(c.agents)) throw new Error("agents must be an object");
    validateAgents(c.agents as Record<string, unknown>, providers);
  }
  if (c.orchestration !== undefined) {
    if (typeof c.orchestration !== "object" || c.orchestration === null || Array.isArray(c.orchestration)) throw new Error("orchestration must be an object");
    validateOrchestration(c.orchestration as Record<string, unknown>);
  }
  if (c.runtime !== undefined) {
    if (typeof c.runtime !== "object" || c.runtime === null || Array.isArray(c.runtime)) throw new Error("runtime must be an object");
    validateRuntime(c.runtime as Record<string, unknown>);
  }
  return true;
}

export function loadConfigFromPath(configPath: string): PipelineConfig {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  validateConfig(config);
  return config;
}

export function loadConfig(): PipelineConfig {
  if (_cachedConfig) return _cachedConfig;
  _cachedConfig = loadConfigFromPath(join(process.cwd(), "pipeline.config.json"));
  return _cachedConfig;
}

export type StepProvider = {
  providerName: string;
  provider: LLMProvider | LLMProvider[] | null;
};

export function createProvider(name: string, config: ProviderConfig): LLMProvider | null {
  switch (config.type) {
    case "builtin":
      return null;
    case "mock":
      return new MockProvider(name);
    case "openai":
      return new OpenAIProvider(config.model);
    case "cli":
      return new CLIProvider(
        name,
        config.command ?? "",
        config.args ?? [],
        getConfiguredProviderMode(config),
        { timeoutMs: config.timeoutMs },
      );
    case "anthropic":
      throw new Error("Anthropic provider is not implemented");
    default: {
      throw new Error(`Unknown provider type: ${(config as ProviderConfig).type}`);
    }
  }
}

export function getConfiguredProviderMode(config: ProviderConfig): ProviderMode {
  if (config.mode) return config.mode;
  if (config.type === "openai") return "text";
  if (config.type === "mock") return "text";
  return "agent-write";
}

export function getStepProviderMode(stepName: string, config: PipelineConfig): ProviderMode | null {
  const stepConfig = config.pipeline[stepName];
  if (!stepConfig) return null;
  const providerName = stepConfig[0];
  if (Array.isArray(providerName)) {
    // For race mode, use first provider for mode detection (assume they are compatible)
    const p1 = providerName[0];
    const pc = config.providers[p1];
    return pc ? getConfiguredProviderMode(pc) : null;
  }
  const providerConfig = providerName ? config.providers[providerName] : undefined;
  if (!providerConfig || providerConfig.type === "builtin") return null;
  return getConfiguredProviderMode(providerConfig);
}

export function getProviderForStep(stepName: string, config: PipelineConfig): StepProvider | null {
  const pRaw = config.pipeline[stepName]?.[0];
  if (!pRaw) return null;

  if (Array.isArray(pRaw)) {
    // Multi-Model Race Mode: Return a special holder
    // The scheduler will handle the parallel execution
    return {
      providerName: pRaw.join("|"),
      provider: pRaw.map(name => {
        const pc = config.providers[name];
        if (!pc) throw new Error(`Provider config not found for: ${name}`);
        const p = createProvider(name, pc);
        if (!p) throw new Error(`Failed to create provider: ${name}`);
        return p;
      })
    };
  }

  const providerConfig = typeof pRaw === "string" ? config.providers[pRaw] : undefined;
  if (!providerConfig) {
    if (pRaw === "builtin") return { providerName: "builtin", provider: null };
    throw new Error(`Provider config not found for: ${pRaw}`);
  }

  return {
    providerName: pRaw,
    provider: createProvider(pRaw, providerConfig),
  };
}

/**
 * Validates the DAG and returns stages that can be executed in parallel.
 * Using a simple topological sort for stages.
 */
/** Always derived from current `config.pipeline` (safe after dynamic step inject). */
export function getDagStages(config: PipelineConfig): string[][] {
  return computePipelineStages(config.pipeline);
}

/**
 * Generate a deterministic hash for the current configuration.
 * `sortKeys` recurses into nested objects and **arrays** (element order is preserved;
 * object keys are sorted at each level). Hash therefore changes if array order or any nested key changes.
 */
function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
}

export function calculateConfigHash(config: unknown): string {
  const content = JSON.stringify(sortKeys(config));
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
