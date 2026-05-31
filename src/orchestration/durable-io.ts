/**
 * Shared atomic file helpers for durable control-plane adapters.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function atomicWriteJson(path: string, data: unknown): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

export function appendJsonl(path: string, record: unknown): void {
  ensureDir(dirname(path));
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split("\n").filter((line) => line.trim());
  const out: T[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

export function safePathSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}
