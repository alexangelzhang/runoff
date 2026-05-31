/**
 * Pipeline config validation (tuple DSL only — object step entries are rejected).
 */
import { computePipelineStages } from "../orchestration/dag.js";
import {
  FEDERATION_CONFLICT_STRATEGIES,
  SKILL_DEP_PRUNE_STRATEGIES,
} from "./a2a-config-types.js";
import type { PipelineConfig } from "./config.js";

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
  for (const f of ["memoryAutoCompact", "memoryFormationAsync", "memoryHotPathForget"] as const) {
    if (orch[f] !== undefined && typeof orch[f] !== "boolean") {
      throw new Error(`orchestration.${f} must be a boolean`);
    }
  }
  if (orch.dream !== undefined) {
    const d = orch.dream as Record<string, unknown>;
    if (typeof d !== "object" || d === null || Array.isArray(d)) throw new Error("orchestration.dream must be an object");
    for (const f of ["enabled", "llmEnabled", "sinceLastRun", "promoteGlobalKnowledge"] as const) {
      if (d[f] !== undefined && typeof d[f] !== "boolean") throw new Error(`orchestration.dream.${f} must be a boolean`);
    }
    if (d.batchLimit !== undefined && (typeof d.batchLimit !== "number" || d.batchLimit < 1)) throw new Error("orchestration.dream.batchLimit must be a positive number");
    if (d.globalKnowledgeMinLength !== undefined && (typeof d.globalKnowledgeMinLength !== "number" || d.globalKnowledgeMinLength < 1)) {
      throw new Error("orchestration.dream.globalKnowledgeMinLength must be a positive number");
    }
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
    const validFed = [...FEDERATION_CONFLICT_STRATEGIES];
    if (
      a2a.federationConflictStrategy !== undefined &&
      (typeof a2a.federationConflictStrategy !== "string" ||
        !(FEDERATION_CONFLICT_STRATEGIES as readonly string[]).includes(
          a2a.federationConflictStrategy as string,
        ))
    ) {
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
      if (!(SKILL_DEP_PRUNE_STRATEGIES as readonly string[]).includes(s as string)) throw new Error("orchestration.a2a.federationSkillDepsPruneStrategy must be last-edge, oldest-dep, or min-edge");
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
  if (
    runtime.raceFinalize !== undefined &&
    runtime.raceFinalize !== "defer" &&
    runtime.raceFinalize !== "auto-pick"
  ) {
    throw new Error('runtime.raceFinalize must be "defer" or "auto-pick"');
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

