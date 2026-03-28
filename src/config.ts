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
  if (!config || typeof config !== "object") throw new Error("Config must be an object");
  const c = config as Record<string, any>;
  if (!c.providers || typeof c.providers !== "object") throw new Error("Missing providers object");
  if (!c.pipeline || typeof c.pipeline !== "object") throw new Error("Missing pipeline object");

  const allSteps = Object.keys(c.pipeline);
  for (const [stepName, stepConfig] of Object.entries(c.pipeline)) {
    if (!Array.isArray(stepConfig) || stepConfig.length === 0) {
      throw new Error(`Step "${stepName}" must be an array with [provider, ...dependsOn]`);
    }

    const [pRaw, ...deps] = stepConfig;
    const providersToCheck = Array.isArray(pRaw) ? pRaw : [pRaw];

    for (const pName of providersToCheck) {
      if (!c.providers[pName] && pName !== "builtin") {
        throw new Error(`Step "${stepName}" references unknown provider "${pName}"`);
      }
    }

    for (const dep of deps) {
      if (dep === stepName) {
        throw new Error(`Step "${stepName}" cannot depend on itself`);
      }
      if (!allSteps.includes(dep)) {
        throw new Error(`Step "${stepName}" dependsOn references unknown step "${dep}"`);
      }
    }
  }

  // Cycle detection via topological sort
  const visited = new Set<string>();
  const remaining = new Set(allSteps);
  while (remaining.size > 0) {
    const ready: string[] = [];
    for (const step of remaining) {
      const [_, ...deps] = c.pipeline[step] as any[];
      if (deps.every((d: string) => visited.has(d))) ready.push(step);
    }
    if (ready.length === 0) {
      throw new Error(`Circular dependency detected among steps: ${[...remaining].join(", ")}`);
    }
    for (const s of ready) { visited.add(s); remaining.delete(s); }
  }

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

const providerRegistry: Record<string, new (...args: any[]) => LLMProvider> = {
  openai: OpenAIProvider,
  cli: CLIProvider,
  mock: MockProvider,
};

export function createProvider(name: string, config: ProviderConfig): LLMProvider | null {
  const ProviderClass = providerRegistry[config.type];
  if (!ProviderClass) {
    if (config.type === "builtin") return null;
    throw new Error(`Unknown provider type: ${config.type}`);
  }
  if (config.type === "mock") return new ProviderClass(name);
  if (config.type === "openai") return new ProviderClass(config.model);
  if (config.type === "cli") return new ProviderClass(name, config.command, config.args, config.mode, config);
  return new ProviderClass(config);
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
 * (Wave 5 Fix: Properly sorts keys recursively to detect any change)
 */
export function calculateConfigHash(config: any): string {
  function sortKeys(obj: any): any {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return obj;
    return Object.keys(obj).sort().reduce((acc: any, key) => {
      acc[key] = sortKeys(obj[key]);
      return acc;
    }, {});
  }
  const content = JSON.stringify(sortKeys(config));
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
