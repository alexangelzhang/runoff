/**
 * Loop cost estimator — projects token/USD spend from trace history + cadence.
 * Aligned with loop-engineering loop-cost semantics.
 */

import { loadConfigFromPath, type PipelineConfig } from "../core/config.js";
import { queryTraces } from "../observability/trace.js";

export type LoopCadence = "5m" | "10m" | "15m" | "30m" | "1h" | "2h" | "1d";

export type LoopPattern = "pr-babysitter" | "ci-sweeper" | "daily-triage" | "custom";

export type LoopCostLevel = "L1" | "L2" | "L3";

export type LoopCostEstimate = {
  pattern: LoopPattern;
  cadence: LoopCadence;
  level: LoopCostLevel;
  runsPerDay: number;
  source: "traces" | "defaults";
  sampleTraces: number;
  avgTokensPerRun: number;
  avgCostUsdPerRun: number;
  p95TokensPerRun?: number;
  p95CostUsdPerRun?: number;
  estimatedDailyTokens: number;
  estimatedDailyCostUsd: number;
  estimatedWeeklyCostUsd: number;
  configBudgetUsd?: number;
  budgetHeadroomUsd?: number;
  warnings: string[];
};

const RUNS_PER_DAY: Record<LoopCadence, number> = {
  "5m": 288,
  "10m": 144,
  "15m": 96,
  "30m": 48,
  "1h": 24,
  "2h": 12,
  "1d": 1,
};

const PATTERN_DEFAULTS: Record<
  Exclude<LoopPattern, "custom">,
  Record<LoopCostLevel, { tokens: number; costUsd: number }>
> = {
  "daily-triage": {
    L1: { tokens: 50_000, costUsd: 0.05 },
    L2: { tokens: 200_000, costUsd: 0.25 },
    L3: { tokens: 350_000, costUsd: 0.45 },
  },
  "pr-babysitter": {
    L1: { tokens: 80_000, costUsd: 0.08 },
    L2: { tokens: 250_000, costUsd: 0.35 },
    L3: { tokens: 500_000, costUsd: 0.75 },
  },
  "ci-sweeper": {
    L1: { tokens: 50_000, costUsd: 0.05 },
    L2: { tokens: 200_000, costUsd: 0.3 },
    L3: { tokens: 400_000, costUsd: 0.6 },
  },
};

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))]!;
}

export function inferLoopPattern(config: PipelineConfig): LoopPattern {
  const steps = Object.keys(config.pipeline);
  if (steps.length === 1 && steps[0] === "triage") return "daily-triage";
  if (steps.includes("diagnose")) return "ci-sweeper";
  if (steps.includes("triage") && steps.includes("fix") && steps.includes("verify")) {
    return "pr-babysitter";
  }
  return "custom";
}

export function inferLoopLevel(config: PipelineConfig): LoopCostLevel {
  const steps = Object.keys(config.pipeline);
  const hasFix = steps.some((s) => /fix|implement/i.test(s));
  const governance = config.runtime?.governance?.enabled === true;
  if (!hasFix) return "L1";
  if (governance) return "L2";
  return "L2";
}

export function estimateLoopCost(input: {
  pattern?: LoopPattern;
  cadence: LoopCadence;
  level?: LoopCostLevel;
  configPath?: string;
  traceLimit?: number;
  conservative?: boolean;
}): LoopCostEstimate {
  const warnings: string[] = [];
  let config: PipelineConfig | undefined;
  if (input.configPath) {
    try {
      config = loadConfigFromPath(input.configPath);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`Config not loaded: ${message}`);
    }
  }

  const pattern = input.pattern ?? (config ? inferLoopPattern(config) : "custom");
  const level = input.level ?? (config ? inferLoopLevel(config) : "L1");
  const runsPerDay = RUNS_PER_DAY[input.cadence];
  const limit = input.traceLimit ?? 30;

  const traces = queryTraces({ limit, mode: "pipeline" });
  const tokens = traces
    .map(
      (t) =>
        t.costSummary?.totalTokens ??
        (t.totalUsage?.promptTokens ?? 0) + (t.totalUsage?.completionTokens ?? 0),
    )
    .filter((n) => n > 0);
  const costs = traces
    .map((t) => t.costSummary?.totalCostUSD ?? 0)
    .filter((n) => n > 0);

  let source: LoopCostEstimate["source"] = "defaults";
  let avgTokensPerRun: number;
  let avgCostUsdPerRun: number;
  let p95TokensPerRun: number | undefined;
  let p95CostUsdPerRun: number | undefined;

  if (tokens.length >= 3) {
    source = "traces";
    const sortedTokens = [...tokens].sort((a, b) => a - b);
    const sortedCosts = [...costs].sort((a, b) => a - b);
    avgTokensPerRun = tokens.reduce((a, b) => a + b, 0) / tokens.length;
    avgCostUsdPerRun =
      costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : avgTokensPerRun * 0.000001;
    p95TokensPerRun = percentile(sortedTokens, 95);
    p95CostUsdPerRun = costs.length ? percentile(sortedCosts, 95) : undefined;
  } else if (pattern !== "custom") {
    const defaults = PATTERN_DEFAULTS[pattern][level];
    avgTokensPerRun = defaults.tokens;
    avgCostUsdPerRun = defaults.costUsd;
    warnings.push(
      tokens.length
        ? `Only ${tokens.length} trace(s) with usage — using pattern defaults for ${pattern}/${level}.`
        : `No trace history — using pattern defaults for ${pattern}/${level}.`,
    );
  } else {
    avgTokensPerRun = 100_000;
    avgCostUsdPerRun = 0.15;
    warnings.push("No trace history and pattern=custom — using generic defaults.");
  }

  const perRunTokens = input.conservative && p95TokensPerRun ? p95TokensPerRun : avgTokensPerRun;
  const perRunCost =
    input.conservative && p95CostUsdPerRun ? p95CostUsdPerRun : avgCostUsdPerRun;

  const estimatedDailyTokens = Math.round(perRunTokens * runsPerDay);
  const estimatedDailyCostUsd = perRunCost * runsPerDay;
  const configBudgetUsd = config?.runtime?.costBudgetUSD;
  const budgetHeadroomUsd =
    typeof configBudgetUsd === "number" ? configBudgetUsd - perRunCost : undefined;

  if (typeof configBudgetUsd === "number" && perRunCost > configBudgetUsd) {
    warnings.push(
      `Single-run estimate ($${perRunCost.toFixed(2)}) exceeds runtime.costBudgetUSD (${configBudgetUsd}).`,
    );
  }
  if (input.cadence === "5m" && estimatedDailyCostUsd > 5) {
    warnings.push("High cadence (5m) without early-exit can exceed $5/day — require empty-watchlist exits.");
  }

  return {
    pattern,
    cadence: input.cadence,
    level,
    runsPerDay,
    source,
    sampleTraces: tokens.length,
    avgTokensPerRun: Math.round(avgTokensPerRun),
    avgCostUsdPerRun: Number(avgCostUsdPerRun.toFixed(4)),
    p95TokensPerRun: p95TokensPerRun ? Math.round(p95TokensPerRun) : undefined,
    p95CostUsdPerRun: p95CostUsdPerRun ? Number(p95CostUsdPerRun.toFixed(4)) : undefined,
    estimatedDailyTokens,
    estimatedDailyCostUsd: Number(estimatedDailyCostUsd.toFixed(2)),
    estimatedWeeklyCostUsd: Number((estimatedDailyCostUsd * 7).toFixed(2)),
    configBudgetUsd,
    budgetHeadroomUsd:
      budgetHeadroomUsd !== undefined ? Number(budgetHeadroomUsd.toFixed(4)) : undefined,
    warnings,
  };
}

export function formatLoopCostReport(estimate: LoopCostEstimate): string {
  const lines = [
    "=== runoff loop cost ===",
    "",
    `Pattern: ${estimate.pattern}  Level: ${estimate.level}  Cadence: ${estimate.cadence}`,
    `Runs/day: ${estimate.runsPerDay}  Source: ${estimate.source}  Sample traces: ${estimate.sampleTraces}`,
    "",
    `Avg / run: ${estimate.avgTokensPerRun.toLocaleString()} tokens  $${estimate.avgCostUsdPerRun.toFixed(2)}`,
  ];
  if (estimate.p95TokensPerRun) {
    lines.push(
      `P95 / run: ${estimate.p95TokensPerRun.toLocaleString()} tokens` +
        (estimate.p95CostUsdPerRun ? `  $${estimate.p95CostUsdPerRun.toFixed(2)}` : ""),
    );
  }
  lines.push(
    "",
    `Estimated daily: ${estimate.estimatedDailyTokens.toLocaleString()} tokens  $${estimate.estimatedDailyCostUsd.toFixed(2)}`,
    `Estimated weekly: $${estimate.estimatedWeeklyCostUsd.toFixed(2)}`,
  );
  if (estimate.configBudgetUsd !== undefined) {
    lines.push(`Config per-run budget: $${estimate.configBudgetUsd}`);
    if (estimate.budgetHeadroomUsd !== undefined) {
      lines.push(`Per-run headroom: $${estimate.budgetHeadroomUsd.toFixed(2)}`);
    }
  }
  if (estimate.warnings.length) {
    lines.push("", "Warnings:");
    for (const w of estimate.warnings) lines.push(`  - ${w}`);
  }
  return lines.join("\n");
}
