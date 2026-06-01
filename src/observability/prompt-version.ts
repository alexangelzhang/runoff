/**
 * Phase 8.3.11 — Prompt version storage and replay (LangSmith-style).
 *
 * Append-only JSONL per trace: ~/.runoff/prompt-versions/{traceId}.jsonl
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { getPromptVersionsDir } from "../core/paths.js";
import type { StructuredPrompt } from "../pipeline/prompt.js";
import { renderPrompt } from "../pipeline/prompt.js";

export interface PromptVersionRecord {
  id: string;
  traceId: string;
  stepName: string;
  round: number;
  provider?: string;
  timestamp: string;
  structured: StructuredPrompt;
  rendered: string;
  renderedHash: string;
}

export interface RecordPromptVersionInput {
  traceId: string;
  stepName: string;
  round: number;
  structured: StructuredPrompt;
  rendered?: string;
  provider?: string;
}

export interface PromptVersionQuery {
  traceId: string;
  stepName?: string;
  round?: number;
  id?: string;
}

function versionsDir(): string {
  return process.env.LLM_PROMPT_VERSIONS_DIR ?? getPromptVersionsDir();
}

function traceLogPath(traceId: string): string {
  const safe = traceId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(versionsDir(), `${safe}.jsonl`);
}

export function hashRenderedPrompt(rendered: string): string {
  return createHash("sha256").update(rendered).digest("hex").slice(0, 16);
}

export function buildPromptVersionId(
  traceId: string,
  stepName: string,
  round: number,
  renderedHash: string,
): string {
  return createHash("sha256")
    .update(`${traceId}:${stepName}:${round}:${renderedHash}`)
    .digest("hex")
    .slice(0, 16);
}

/** Default on; set `LLM_PROMPT_VERSIONS=0` or `runtime.promptVersionStore: false` to disable. */
export function isPromptVersionStoreEnabled(configFlag?: boolean): boolean {
  if (process.env.LLM_PROMPT_VERSIONS === "0") return false;
  if (configFlag === false) return false;
  return true;
}

export function recordPromptVersion(input: RecordPromptVersionInput): PromptVersionRecord {
  const rendered = input.rendered ?? renderPrompt(input.structured);
  const renderedHash = hashRenderedPrompt(rendered);
  const record: PromptVersionRecord = {
    id: buildPromptVersionId(input.traceId, input.stepName, input.round, renderedHash),
    traceId: input.traceId,
    stepName: input.stepName,
    round: input.round,
    provider: input.provider,
    timestamp: new Date().toISOString(),
    structured: input.structured,
    rendered,
    renderedHash,
  };

  const path = traceLogPath(input.traceId);
  mkdirSync(versionsDir(), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n");
  return record;
}

function parseJsonl(content: string): PromptVersionRecord[] {
  const out: PromptVersionRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as PromptVersionRecord);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

export function readPromptVersionsForTrace(traceId: string): PromptVersionRecord[] {
  const path = traceLogPath(traceId);
  if (!existsSync(path)) return [];
  return parseJsonl(readFileSync(path, "utf-8"));
}

export function queryPromptVersions(query: PromptVersionQuery): PromptVersionRecord[] {
  let rows = readPromptVersionsForTrace(query.traceId);
  if (query.id) rows = rows.filter((r) => r.id === query.id);
  if (query.stepName) rows = rows.filter((r) => r.stepName === query.stepName);
  if (query.round !== undefined) rows = rows.filter((r) => r.round === query.round);
  return rows;
}

/** Latest matching version (by append order). */
export function latestPromptVersion(query: PromptVersionQuery): PromptVersionRecord | null {
  const rows = queryPromptVersions(query);
  return rows.length > 0 ? rows[rows.length - 1]! : null;
}

/** Reconstruct prompt layers + rendered text for debugging or re-run. */
export function replayPromptVersion(
  id: string,
  traceId: string,
): { structured: StructuredPrompt; rendered: string } | null {
  const record = latestPromptVersion({ traceId, id });
  if (!record) return null;
  return { structured: record.structured, rendered: record.rendered };
}

/** List trace ids that have stored prompt versions. */
export function listTracesWithPromptVersions(): string[] {
  const dir = versionsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length));
}
