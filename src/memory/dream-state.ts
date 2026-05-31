/**
 * Dream worker state (M1 placeholder) — ~/.llm-pipeline/dream-state.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getPipelineHomeDir } from "../core/paths.js";

export const DREAM_STATE_VERSION = 1 as const;

export interface DreamState {
  version: typeof DREAM_STATE_VERSION;
  /** ISO-8601 timestamp of last successful Dream run; null before first run. */
  lastDreamAt: string | null;
}

export function getDreamStatePath(): string {
  return `${getPipelineHomeDir()}/dream-state.json`;
}

export function defaultDreamState(): DreamState {
  return { version: DREAM_STATE_VERSION, lastDreamAt: null };
}

export function loadDreamState(): DreamState {
  const path = getDreamStatePath();
  if (!existsSync(path)) return defaultDreamState();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DreamState>;
    return {
      version: DREAM_STATE_VERSION,
      lastDreamAt: typeof raw.lastDreamAt === "string" ? raw.lastDreamAt : null,
    };
  } catch {
    return defaultDreamState();
  }
}

export function saveDreamState(state: DreamState): void {
  const path = getDreamStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
}

/** Update lastDreamAt to now (for future Dream worker / MCP). */
export function touchDreamState(at: Date = new Date()): DreamState {
  const state: DreamState = { version: DREAM_STATE_VERSION, lastDreamAt: at.toISOString() };
  saveDreamState(state);
  return state;
}
