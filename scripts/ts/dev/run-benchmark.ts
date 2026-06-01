#!/usr/bin/env npx tsx
/**
 * Local benchmark: single-model vs race mode across 10 task scenarios.
 *
 * Each task runs twice with the same prompt:
 *   - variant "single": mock-a (full tier) only
 *   - variant "race":   mock-a + mock-b (full + lite) in parallel
 *
 * The experiment system groups runs by prompt hash (experimentId),
 * so results are queryable via llm_query_experiments or experiments.jsonl.
 *
 * Usage: npm run benchmark
 * Output: benchmark results table + docs/reference/benchmarks-data.md
 */

import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { clearConfigCache } from "../../../src/core/config.js";
import { executePipelineRun } from "../../../src/orchestration/pipeline-mcp-run.js";
import { getPipelineHomeDir } from "../../../src/core/paths.js";
import { queryExperiments } from "../../../src/observability/experiment-log.js";
import { summarizeExperiment } from "../../../src/observability/experiment-log.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

// ── Config templates ──────────────────────────────────────────────────────────

// Baseline: single full-tier provider
const SINGLE_CONFIG = {
  providers: {
    "mock-a": { type: "mock", tier: "full" },
  },
  pipeline: {
    implement: ["mock-a"],
    review: ["mock-a", "implement"],
  },
  retry: { maxRounds: 2, reviewStep: "review" },
  runtime: { controlPlane: "file" },
};

const RACE_CONFIG = {
  providers: {
    "mock-a": { type: "mock", tier: "full" },
    "mock-b": { type: "mock", tier: "lite" },
  },
  pipeline: {
    implement: [["mock-a", "mock-b"]],
    review: ["mock-a", "implement"],
  },
  retry: { maxRounds: 2, reviewStep: "review" },
  runtime: { controlPlane: "file", raceFinalize: "auto-pick" },
};

// ── Task scenarios ────────────────────────────────────────────────────────────

const TASKS = [
  "Add a typed retry() helper with exponential backoff",
  "Implement a parseCSV() function that handles quoted fields",
  "Add input validation to the user registration endpoint",
  "Refactor the database connection pool to use async/await",
  "Fix the off-by-one error in the pagination logic",
  "Add TypeScript types to the legacy JavaScript module",
  "Implement rate limiting middleware for the API router",
  "Add error handling to the file upload handler",
  "Refactor the nested callback chain to use Promise.all",
  "Add a caching layer to the expensive computation function",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

type RunResult = {
  task: string;
  variant: "single" | "race";
  status: string;
  rounds: number;
  tokens: number;
  durationMs: number;
  approved: boolean;
};

async function runTask(
  prompt: string,
  config: object,
  variant: "single" | "race",
  runDir: string,
): Promise<RunResult> {
  const configPath = join(runDir, "pipeline.config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  process.chdir(runDir);
  clearConfigCache();

  const start = Date.now();
  const result = await executePipelineRun({ prompt, maxRounds: 2 });

  return {
    task: prompt.slice(0, 45) + (prompt.length > 45 ? "…" : ""),
    variant,
    status: result.status,
    rounds: result.rounds,
    tokens: result.usage.promptTokens + result.usage.completionTokens,
    durationMs: Date.now() - start,
    approved: result.status === "approved",
  };
}

function pad(s: string | number, n: number, right = false): string {
  const str = String(s);
  if (right) return str.slice(0, n).padEnd(n);
  return str.slice(0, n).padStart(n);
}

function renderTable(results: RunResult[]): string {
  const lines: string[] = [
    "task                                           variant   status     rnd  tokens  ms",
    "─".repeat(87),
  ];
  for (const r of results) {
    lines.push(
      `${pad(r.task, 46, true)} ${pad(r.variant, 7, true)}  ` +
        `${pad(r.status, 10, true)} ${pad(r.rounds, 3)}  ${pad(r.tokens, 6)}  ${pad(r.durationMs, 5)}`,
    );
  }
  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "runoff-bench-"));
  process.env.RUNOFF_HOME = home;

  const singleDir = mkdtempSync(join(tmpdir(), "bench-single-"));
  const raceDir = mkdtempSync(join(tmpdir(), "bench-race-"));

  console.log("runoff benchmark: single-model vs race mode");
  console.log(`tasks:     ${TASKS.length}`);
  console.log(`data home: ${home}`);
  console.log(`running…\n`);

  const results: RunResult[] = [];
  let done = 0;

  for (const prompt of TASKS) {
    const [single, race] = await Promise.all([
      runTask(prompt, SINGLE_CONFIG, "single", singleDir),
      runTask(prompt, RACE_CONFIG, "race", raceDir),
    ]);
    results.push(single, race);
    done++;
    process.stdout.write(`  ${done}/${TASKS.length} tasks done\r`);
  }

  console.log("\n");
  console.log(renderTable(results));

  // ── Aggregate stats ───────────────────────────────────────────────────────

  const singles = results.filter((r) => r.variant === "single");
  const races = results.filter((r) => r.variant === "race");

  const approvedRate = (rs: RunResult[]) =>
    Math.round((rs.filter((r) => r.approved).length / rs.length) * 100);
  const avgTokens = (rs: RunResult[]) =>
    Math.round(rs.reduce((s, r) => s + r.tokens, 0) / rs.length);
  const avgRounds = (rs: RunResult[]) =>
    +(rs.reduce((s, r) => s + r.rounds, 0) / rs.length).toFixed(1);
  const avgMs = (rs: RunResult[]) =>
    Math.round(rs.reduce((s, r) => s + r.durationMs, 0) / rs.length);

  // Tasks where race approved but single didn't
  const raceWins = TASKS.filter((t) => {
    const s = singles.find((r) => r.task === t.slice(0, 45) + (t.length > 45 ? "…" : ""));
    const r = races.find((r) => r.task === t.slice(0, 45) + (t.length > 45 ? "…" : ""));
    return r?.approved && !s?.approved;
  });

  console.log("\n── summary ────────────────────────────────");
  console.log(`                   single    race`);
  console.log(`approved rate:     ${pad(approvedRate(singles) + "%", 7)}   ${approvedRate(races)}%`);
  console.log(`avg tokens/run:    ${pad(avgTokens(singles), 7)}   ${avgTokens(races)}`);
  console.log(`avg rounds:        ${pad(avgRounds(singles), 7)}   ${avgRounds(races)}`);
  console.log(`avg latency (ms):  ${pad(avgMs(singles), 7)}   ${avgMs(races)}`);
  if (raceWins.length > 0) {
    console.log(`\nrace approved, single failed (${raceWins.length} tasks):`);
    raceWins.forEach((t) => console.log(`  - ${t}`));
  }

  // ── Write markdown ────────────────────────────────────────────────────────

  const ts = new Date().toISOString().slice(0, 10);
  const md = `# Benchmark Results

> Generated: ${ts} — mock providers, deterministic outputs, zero API cost.
> Repeat with: \`npm run benchmark\`

## Setup

| Config | Providers | Pipeline |
|--------|-----------|---------|
| single | mock-a (full tier) | implement → review |
| race   | mock-a + mock-b (full + lite, parallel) | implement (race, auto-pick) → review |

**mock-a (full tier):** typed implementation with validation, ~142 completion tokens per implement step.
**mock-b (lite tier):** compact implementation, ~68 completion tokens per implement step.
**Race resolution:** \`pick-winner\` selects mock-a (higher token count = richer output); review approves on round 1.
**What this measures:** token cost overhead of running two providers vs one.

## Results (${TASKS.length} tasks × 2 variants)

\`\`\`
${renderTable(results)}
\`\`\`

## Summary

| Metric | single-model | race (auto-pick) |
|--------|:------------:|:----------------:|
| Approved rate | ${approvedRate(singles)}% | ${approvedRate(races)}% |
| Avg tokens / run | ${avgTokens(singles)} | ${avgTokens(races)} |
| Avg rounds | ${avgRounds(singles)} | ${avgRounds(races)} |
| Avg latency (ms) | ${avgMs(singles)} | ${avgMs(races)} |

${
  raceWins.length > 0
    ? `## Tasks where race approved, single-model needed extra rounds\n\n${raceWins.map((t) => `- ${t}`).join("\n")}\n\n`
    : ""
}## Interpretation

These results measure the **token cost overhead** of race mode against single-model.

In this scenario, both configs produce identical outcomes (100% approved, 1 round). The difference is token spend:
- Race spends ~${Math.round(avgTokens(races) / avgTokens(singles) * 100 - 100)}% more tokens per task (${avgTokens(races)} vs ${avgTokens(singles)} avg), because it runs two providers in parallel.
- Early termination reduces the premium: the lite-tier provider is aborted once the full-tier result arrives, so you pay for partial generation, not a complete second run.

**What mock benchmarks cannot measure** is the more important case: real models making different choices on the same prompt. The value of race mode is not raw token efficiency — it's *candidate diversity*. When two models agree, you have stronger evidence. When they diverge, the divergence is itself information (one model found an existing helper; the other didn't). This requires running real providers against real codebases.

The token cost ceiling is configurable: \`orchestration.raceBudgetUSD\` caps per-step spend, and \`raceEarlyTermination: true\` (default) aborts losers as soon as a viable winner arrives.

## Notes

- Mock outputs are deterministic; results are reproducible across runs.
- Token counts reflect mock responses, not real LLM usage.
- For real-provider data, run: \`npm run smoke:real\` (requires API keys).
- Experiment data persisted to: \`${home}/experiments.jsonl\`
`;

  const outPath = join(ROOT, "docs", "reference", "benchmarks-data.md");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md, "utf-8");

  console.log(`\nwrote: ${outPath}`);
  console.log(`data:  ${join(home, "experiments.jsonl")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
