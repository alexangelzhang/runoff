/**
 * Persist AgentGraph snapshot edits onto pipeline.config.json (declaration SoT).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { validateConfig, type PipelineConfig } from "../core/config.js";
import {
  applyAgentGraphToPipeline,
  recomputeSnapshotWaves,
  validateAgentGraphSnapshot,
  type AgentGraphSnapshot,
} from "../orchestration/agent-graph-io.js";

export type SaveConfigResult =
  | { ok: true; configPath: string }
  | { ok: false; error: string };

/** @deprecated alias */
export type SaveGraphResult = SaveConfigResult & { pipeline?: PipelineConfig["pipeline"] };

function normalizeSnapshot(snapshot: AgentGraphSnapshot): AgentGraphSnapshot {
  const check = validateAgentGraphSnapshot(snapshot);
  if (!check.valid) {
    if (check.cycle) {
      throw new Error(`AgentGraph cycle detected: ${check.cycle.join(" → ")}`);
    }
    if (check.missingDeps?.length) {
      throw new Error(`AgentGraph missing dependencies: ${check.missingDeps.join(", ")}`);
    }
    throw new Error("Invalid AgentGraph snapshot");
  }
  const waves = recomputeSnapshotWaves(snapshot);
  if (!waves.length) {
    throw new Error("AgentGraph cycle detected — fix dependsOn before saving");
  }
  return { ...snapshot, waves };
}

/** Apply snapshot to on-disk config; validates full file before write. */
export function saveGraphSnapshotToConfigFile(
  configPath: string,
  snapshot: AgentGraphSnapshot,
): SaveGraphResult {
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    if (!raw.pipeline || typeof raw.pipeline !== "object" || Array.isArray(raw.pipeline)) {
      return { ok: false, error: "Config must contain a pipeline object" };
    }

    const normalized = normalizeSnapshot(snapshot);
    const pipeline = raw.pipeline as PipelineConfig["pipeline"];
    applyAgentGraphToPipeline(normalized, pipeline, { skipValidation: true });

    if (!validateConfig(raw)) {
      return { ok: false, error: "Config validation failed after apply" };
    }

    writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
    return { ok: true, configPath, pipeline };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** Write full config object after validation (C2 editor). */
export function saveFullConfigToFile(configPath: string, config: unknown): SaveConfigResult {
  try {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return { ok: false, error: "Config must be a JSON object" };
    }
    if (!validateConfig(config)) {
      return { ok: false, error: "Config validation failed" };
    }
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    return { ok: true, configPath };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
