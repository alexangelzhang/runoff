/**
 * Human / manual scores for traces (LangFuse-style scores, local JSONL).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getTracesDir } from "../core/paths.js";

export type TraceScore = {
  id: string;
  traceId: string;
  name: string;
  value: number;
  comment?: string;
  source: "human" | "system";
  timestamp: string;
};

export function getTraceScoresPath(): string {
  return join(getTracesDir(), "scores.jsonl");
}

export function appendTraceScore(
  input: Omit<TraceScore, "id" | "timestamp" | "source"> & {
    id?: string;
    timestamp?: string;
    source?: TraceScore["source"];
  },
): TraceScore {
  const tracesDir = getTracesDir();
  mkdirSync(tracesDir, { recursive: true });
  const entry: TraceScore = {
    id: input.id ?? randomUUID().slice(0, 12),
    traceId: input.traceId,
    name: input.name,
    value: input.value,
    comment: input.comment,
    source: input.source ?? "human",
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
  appendFileSync(getTraceScoresPath(), `${JSON.stringify(entry)}\n`, "utf-8");
  return entry;
}

export function listTraceScores(traceId?: string): TraceScore[] {
  const path = getTraceScoresPath();
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  const scores: TraceScore[] = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as TraceScore;
      if (!traceId || row.traceId === traceId) scores.push(row);
    } catch {
      // skip corrupt line
    }
  }
  return scores;
}
