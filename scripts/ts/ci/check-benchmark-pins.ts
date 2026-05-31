#!/usr/bin/env node
/**
 * P0 — Warn when docs/benchmark-pins.json is stale (default 90 days).
 * Usage:
 *   npx tsx scripts/check-benchmark-pins.ts
 *   npx tsx scripts/check-benchmark-pins.ts --strict   # exit 1 if stale
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const PINS_PATH = resolve(ROOT, "docs/benchmark-pins.json");
const MAX_AGE_DAYS = Number(process.env.BENCHMARK_PINS_MAX_AGE_DAYS ?? "90");
const strict = process.argv.includes("--strict");

type PinsFile = {
  auditedAt: string;
  frameworks: Array<{ id: string; repo: string; ref: string; refDate?: string }>;
};

function main(): void {
  const raw = readFileSync(PINS_PATH, "utf-8");
  const pins = JSON.parse(raw) as PinsFile;
  if (!pins.auditedAt || !Array.isArray(pins.frameworks)) {
    console.error("Invalid benchmark-pins.json shape");
    process.exit(1);
  }

  const auditedMs = Date.parse(pins.auditedAt);
  if (Number.isNaN(auditedMs)) {
    console.error(`Invalid auditedAt: ${pins.auditedAt}`);
    process.exit(1);
  }

  const ageDays = (Date.now() - auditedMs) / 86_400_000;
  const stale = ageDays > MAX_AGE_DAYS;

  console.log(
    `benchmark-pins: auditedAt=${pins.auditedAt} age=${ageDays.toFixed(1)}d frameworks=${pins.frameworks.length}`,
  );

  if (stale) {
    const msg = `benchmark-pins older than ${MAX_AGE_DAYS}d — run ./scripts/refresh-benchmark-pins.sh`;
    if (strict) {
      console.error(msg);
      process.exit(1);
    }
    console.warn(`⚠ ${msg}`);
  }
}

main();
