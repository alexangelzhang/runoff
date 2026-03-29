import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LLMProvider, ProviderMode } from "./providers/types.js";
import { OpenAIProvider } from "./providers/openai.js";
import { CLIProvider } from "./providers/cli.js";
import { MockProvider } from "./providers/mock.js";
import { computePipelineStages } from "./orchestration/dag.js";

export type ProviderConfig = {
  type: "openai" | "anthropic" | "builtin" | "cli" | "mock";
  model?: string;
  apiKey?: string;
  command?: string;
  args?: string[];
  timeoutMs?: number;
  mode?: ProviderMode;
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
};

let _cachedConfig: PipelineConfig | null = null;
let _cachedDagStages: string[][] | null = null;

export function clearDagStagesCache(): void {
  _cachedDagStages = null;
}

/** Clears memoized config/DAG from {@link loadConfig} / {@link getDagStages} (for tests and hot-reload tooling). */
export function clearConfigCache(): void {
  _cachedConfig = null;
  clearDagStagesCache();
}

/**
 * Deep validation for pipeline configuration.
 * (Wave 5: Strict Schema & DAG integrity)
 */
export function validateConfig(config: unknown): config is PipelineConfig {
  if (!config || typeof config !== "object" || config === null) {
    throw new Error("Config must be an object");
  }
  const c = config as Record<string, unknown>;
  if (!c.providers || typeof c.providers !== "object" || c.providers === null || Array.isArray(c.providers)) {
    throw new Error("Missing providers object");
  }
  if (!c.pipeline || typeof c.pipeline !== "object" || c.pipeline === null || Array.isArray(c.pipeline)) {
    throw new Error("Missing pipeline object");
  }

  const providers = c.providers as Record<string, unknown>;
  const pipeline = c.pipeline as Record<string, unknown>;
  const allSteps = Object.keys(pipeline);

  for (const [stepName, stepConfig] of Object.entries(pipeline)) {
    if (!Array.isArray(stepConfig)) {
      throw new Error(
        `Step "${stepName}" must use the tuple DSL [provider, ...dependsOn], not an object. Pipeline steps must be JSON arrays.`,
      );
    }
    if (stepConfig.length === 0) {
      throw new Error(`Step "${stepName}" must be an array with [provider, ...dependsOn]`);
    }

    const [pRaw, ...deps] = stepConfig;
    const providersToCheck = Array.isArray(pRaw) ? pRaw : [pRaw];

    for (const pName of providersToCheck) {
      if (typeof pName !== "string") {
        throw new Error(`Step "${stepName}" provider entry must be a string or array of strings`);
      }
      if (!providers[pName] && pName !== "builtin") {
        throw new Error(`Step "${stepName}" references unknown provider "${pName}"`);
      }
    }

    for (const dep of deps) {
      if (typeof dep !== "string") {
        throw new Error(`Step "${stepName}" dependsOn entries must be strings`);
      }
      if (dep === stepName) {
        throw new Error(`Step "${stepName}" cannot depend on itself`);
      }
      if (!allSteps.includes(dep)) {
        throw new Error(`Step "${stepName}" dependsOn references unknown step "${dep}"`);
      }
    }
  }

  computePipelineStages(pipeline as PipelineConfig["pipeline"]);

  return true;
}

export function loadConfig(): PipelineConfig {
  if (_cachedConfig) return _cachedConfig;

  const configPath = join(process.cwd(), "pipeline.config.json");
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  validateConfig(config);
  _cachedConfig = config;
  return config;
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
export function getDagStages(config: PipelineConfig): string[][] {
  if (_cachedDagStages && config === _cachedConfig) return _cachedDagStages;

  const stages = computePipelineStages(config.pipeline);

  if (config === _cachedConfig) _cachedDagStages = stages;
  return stages;
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
