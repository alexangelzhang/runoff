import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LLMProvider, ProviderMode } from "../providers/types.js";
import { OpenAIProvider } from "../providers/openai.js";
import { CLIProvider } from "../providers/cli.js";
import { MockProvider } from "../providers/mock.js";
import { loadPluginProvider } from "../providers/plugin.js";
import { computePipelineStages } from "../orchestration/dag.js";
import type { A2AConfig } from "./a2a-config-types.js";

export type {
  A2AConfig,
  A2AClientTlsConfig,
  A2AServerTlsConfig,
  FederationConflictStrategy,
  SkillDepPruneStrategy,
} from "./a2a-config-types.js";
import { validateConfig } from "./config-validate.js";

export { validateConfig };

export type ProviderConfig = {
  type: "openai" | "anthropic" | "builtin" | "cli" | "mock" | "plugin";
  model?: string;
  apiKey?: string;
  command?: string;
  args?: string[];
  timeoutMs?: number;
  mode?: ProviderMode;
  /** Allocate a pseudo-TTY for the CLI process. Required for tools like Gemini CLI that exit when no TTY is detected. */
  pty?: boolean;
  /**
   * Use the ACP (Agent Client Protocol) JSON-RPC interface instead of plain stdin/stdout.
   * Requires Gemini CLI v0.45.0+ (preview). task_runner.py performs a version check at runtime
   * and falls back to an error if the installed version is too old.
   */
  acp?: boolean;
  /** Phase 5.3: declarative tier (overrides name heuristics in router). */
  tier?: "lite" | "full";
  /** Optional cost hint (USD per 1M tokens) for economics routing. */
  costPerToken?: number;
  /** Optional latency hint (ms) for tie-breaking. */
  avgLatencyMs?: number;
  /**
   * Plugin provider: npm package name that exports a `createProvider(name, config)` function.
   * Example: "runoff-provider-ollama"
   */
  package?: string;
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
  /** Provider name to use as rubric judge in runoff_race_judge (must not be a race candidate). */
  judgeProvider?: string;
  /** Agent-read provider name for repo context collection before rubric generation. */
  contextProvider?: string;
  /** Phase 9+: DeerFlow-style reflect → re-plan (llm-driven only). */
  reflect?: {
    enabled?: boolean;
    provider?: string;
    onReviewRevision?: boolean;
    onStepFailure?: boolean;
  };
  /** Phase 8.1.2: auto-compact persistent memory after successful pipeline. */
  memoryAutoCompact?: boolean;
  /** When true (default), pattern/entity formation runs off the hot path via serial queue. */
  memoryFormationAsync?: boolean;
  /** When true (default), run B6 decay/TTL forget after each formation job (hot path). */
  memoryHotPathForget?: boolean;
  /** M1: on pipeline start, opt-in hybrid retrieveMerged for pattern semantic match (layered backends). */
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
    /** Promote approved-run globalKnowledge entries to lesson memory (default false). */
    promoteGlobalKnowledge?: boolean;
    /** Minimum insight value length when promoting (default 24). */
    globalKnowledgeMinLength?: number;
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
  /** `file` persists RunStore/EventLog/MessageBus under ~/.runoff/control-plane. */
  controlPlane?: "memory" | "file";
  governance?: GovernanceConfig;
  /** Phase 8.2.2: enable semantic prompt similarity cache in runoff_run_step. */
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
  /**
   * Agent provider race: `defer` pauses for runoff_race_apply (default).
   * `auto-pick` applies resolveProviderRaceWinner choice immediately.
   */
  raceFinalize?: "defer" | "auto-pick";
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
        { timeoutMs: config.timeoutMs, pty: config.pty, acp: config.acp },
      );
    case "plugin":
      return loadPluginProvider(name, config);
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
