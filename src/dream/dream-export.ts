/**
 * M4 — Optional dream-export.jsonl for manual external knowledge ingest (no vault coupling).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getPipelineHomeDir } from "../core/paths.js";
import type { AgentMemory, MemoryEntry } from "../orchestration/memory.js";

export const DREAM_EXPORT_SCHEMA = "llm-pipeline-dream-export-v1" as const;

export type DreamExportCategory = "pattern" | "lesson" | "trace_summary" | "entity_relation";

export interface DreamExportRow {
  schema: typeof DREAM_EXPORT_SCHEMA;
  exportedAt: string;
  category: DreamExportCategory;
  content: string;
  metadata: Record<string, unknown>;
  memoryId: string;
  relevance?: number;
}

export function getDreamExportPath(): string {
  return join(getPipelineHomeDir(), "dream-export.jsonl");
}

function rowFromEntry(entry: MemoryEntry, exportedAt: string): DreamExportRow | null {
  const category = entry.category as DreamExportCategory;
  if (
    category !== "pattern" &&
    category !== "lesson" &&
    category !== "trace_summary" &&
    category !== "entity_relation"
  ) {
    return null;
  }
  return {
    schema: DREAM_EXPORT_SCHEMA,
    exportedAt,
    category,
    content: entry.content,
    metadata: { ...(entry.metadata ?? {}), agentId: entry.agentId, scope: entry.scope },
    memoryId: entry.id,
    relevance: entry.relevance,
  };
}

export interface ExportDreamMemoryOptions {
  scope?: { project?: string };
  categories?: DreamExportCategory[];
  limit?: number;
  outPath?: string;
}

export function exportDreamMemoryJsonl(
  memory: AgentMemory,
  options: ExportDreamMemoryOptions = {},
): { path: string; rowCount: number } {
  const scope = { project: options.scope?.project ?? "default" };
  const cats = new Set(
    options.categories ?? ["pattern", "lesson", "trace_summary", "entity_relation"],
  );
  const limit = options.limit ?? 5000;
  const exportedAt = new Date().toISOString();

  const entries = memory.retrieve({ scope, limit, includeExpired: false });
  const rows: DreamExportRow[] = [];
  for (const entry of entries) {
    if (!cats.has(entry.category as DreamExportCategory)) continue;
    const row = rowFromEntry(entry, exportedAt);
    if (row) rows.push(row);
  }

  const path = options.outPath ?? getDreamExportPath();
  mkdirSync(dirname(path), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  writeFileSync(path, body, "utf8");
  return { path, rowCount: rows.length };
}

export function appendDreamExportNote(note: string, path = getDreamExportPath()): void {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const line = JSON.stringify({
    schema: DREAM_EXPORT_SCHEMA,
    exportedAt: new Date().toISOString(),
    category: "lesson",
    content: note,
    metadata: { source: "dream-export-note" },
    memoryId: "manual",
  });
  writeFileSync(path, `${line}\n`, { encoding: "utf8", flag: "a" });
}
