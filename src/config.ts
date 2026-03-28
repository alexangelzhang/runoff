import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ProviderMode } from "./providers/types.js";

export type ProviderConfig = {
  type: "openai" | "anthropic" | "builtin" | "cli";
  model?: string;
  apiKey?: string;
  command?: string;
  args?: string[];
  timeoutMs?: number;
};

export type PipelineConfig = {
  providers: Record<string, ProviderConfig>;
  /** 
   * Each step is defined as [providerName, ...dependsOn]
   * (Wave 5: Simplified DAG configuration)
   */
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

/**
 * Deep validation for pipeline configuration.
 * (Wave 5: Strict Schema & DAG integrity)
 */
export function validateConfig(config: any): config is PipelineConfig {
  if (!config || typeof config !== "object") throw new Error("Config must be an object");
  if (!config.providers || typeof config.providers !== "object") throw new Error("Missing providers object");
  if (!config.pipeline || typeof config.pipeline !== "object") throw new Error("Missing pipeline object");

  const allSteps = Object.keys(config.pipeline);
  for (const [stepName, stepConfig] of Object.entries(config.pipeline)) {
    if (!Array.isArray(stepConfig) || stepConfig.length === 0) {
      throw new Error(`Step "${stepName}" must be an array with [provider, ...dependsOn]`);
    }

    const [pRaw, ...deps] = stepConfig;
    const providersToCheck = Array.isArray(pRaw) ? pRaw : [pRaw];
    
    for (const pName of providersToCheck) {
      if (!config.providers[pName] && pName !== "builtin") {
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
  provider: any; 
};

import { OpenAIProvider } from "./providers/openai.js";
import { CLIProvider } from "./providers/cli.js";

const providerRegistry: Record<string, any> = {
  openai: OpenAIProvider,
  cli: CLIProvider,
};

export function createProvider(name: string, config: ProviderConfig): any {
  const ProviderClass = providerRegistry[config.type];
  if (!ProviderClass) {
    if (config.type === "builtin") return null;
    throw new Error(`Unknown provider type: ${config.type}`);
  }
  return new ProviderClass(config);
}

export function getConfiguredProviderMode(config: ProviderConfig): ProviderMode {
  if (config.type === "openai") return "text";
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
        return createProvider(name, pc);
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
  if (_cachedDagStages) return _cachedDagStages;

  const stages: string[][] = [];
  const visited = new Set<string>();
  const allSteps = Object.keys(config.pipeline);

  while (visited.size < allSteps.length) {
    const currentStage: string[] = [];
    for (const step of allSteps) {
      if (visited.has(step)) continue;

      const [_, ...deps] = config.pipeline[step];
      if (deps.every((dep) => visited.has(dep))) {
        currentStage.push(step);
      }
    }

    if (currentStage.length === 0) {
      throw new Error("Circular dependency detected in pipeline configuration");
    }

    for (const step of currentStage) visited.add(step);
    stages.push(currentStage);
  }

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
