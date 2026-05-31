#!/usr/bin/env node
/**
 * CI: example configs must not enable experimental subsystems (S3.3).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const EXAMPLES_CONFIGS = join(ROOT, "examples", "configs");

const FORBIDDEN_PATHS: Array<{ path: string; reason: string }> = [
  { path: "orchestration.a2a.federationSyncUrls", reason: "A2A federation is experimental" },
  { path: "orchestration.a2a.httpListen", reason: "A2A HTTP server is experimental" },
  { path: "runtime.dream", reason: "Dream worker is experimental" },
  { path: "runtime.dreamify", reason: "Dreamify is experimental" },
];

function getAtPath(obj: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function isEnabled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return true;
  return false;
}

let failed = false;
for (const file of readdirSync(EXAMPLES_CONFIGS).filter((f) => f.endsWith(".config.json"))) {
  const raw = JSON.parse(readFileSync(join(EXAMPLES_CONFIGS, file), "utf-8")) as Record<string, unknown>;
  for (const rule of FORBIDDEN_PATHS) {
    const value = getAtPath(raw, rule.path);
    if (isEnabled(value)) {
      console.error(`FAIL ${file}: ${rule.path} — ${rule.reason}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log("OK examples/configs/*.config.json — no experimental flags");
