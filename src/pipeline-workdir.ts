/**
 * Workdir requirements for agent-mode steps (orchestration layer — not MCP tools).
 */

import type { PipelineConfig } from "./config.js";
import { getConfiguredProviderMode } from "./config.js";
import { isAgentMode } from "./providers/types.js";

function getStepProviderNames(stepName: string, config: PipelineConfig): string[] {
  const stepConfig = config.pipeline[stepName];
  if (!stepConfig) {
    throw new Error(`Unknown pipeline step "${stepName}"`);
  }
  const pRaw = stepConfig[0];
  return Array.isArray(pRaw) ? pRaw : [pRaw];
}

export function ensureWorkDirForStep(stepName: string, config: PipelineConfig, workDir?: string): void {
  const names = getStepProviderNames(stepName, config);
  let needsWorkDir = false;
  for (const name of names) {
    if (name === "builtin") continue;
    const pc = config.providers[name];
    if (pc && isAgentMode(getConfiguredProviderMode(pc))) {
      needsWorkDir = true;
      break;
    }
  }
  if (needsWorkDir && (!workDir || String(workDir).trim() === "")) {
    throw new Error(
      `Step "${stepName}" uses an agent-mode provider and requires workDir (absolute path to the project directory)`
    );
  }
}

export function pipelineHasAgentWriteStep(config: PipelineConfig): boolean {
  for (const stepName of Object.keys(config.pipeline)) {
    const names = getStepProviderNames(stepName, config);
    for (const name of names) {
      if (name === "builtin") continue;
      const pc = config.providers[name];
      if (!pc) continue;
      if (getConfiguredProviderMode(pc) === "agent-write") return true;
    }
  }
  return false;
}

export function pipelineHasStandaloneAgentWriteStep(config: PipelineConfig): boolean {
  for (const stepName of Object.keys(config.pipeline)) {
    const providerEntry = config.pipeline[stepName][0];
    if (Array.isArray(providerEntry)) continue;
    if (providerEntry === "builtin") continue;
    const pc = config.providers[providerEntry];
    if (!pc) continue;
    if (getConfiguredProviderMode(pc) === "agent-write") return true;
  }
  return false;
}

export function pipelineHasAgentRaceStep(config: PipelineConfig): boolean {
  for (const stepName of Object.keys(config.pipeline)) {
    const stepConfig = config.pipeline[stepName];
    const providerEntry = stepConfig[0];
    if (!Array.isArray(providerEntry) || providerEntry.length < 2) continue;
    for (const name of providerEntry) {
      if (name === "builtin") continue;
      const pc = config.providers[name];
      if (!pc) continue;
      if (isAgentMode(getConfiguredProviderMode(pc))) return true;
    }
  }
  return false;
}

export function pipelineUsesGlobalSessionWorkspace(config: PipelineConfig): boolean {
  return pipelineHasStandaloneAgentWriteStep(config) && !pipelineHasAgentRaceStep(config);
}
