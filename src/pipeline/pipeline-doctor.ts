/**
 * Environment and config health checks for local onboarding.
 */

import { execFileSync } from "node:child_process";
import { logger } from "../core/logger.js";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { loadConfigFromPath, type PipelineConfig } from "../core/config.js";
import { cleanupOrphanWorkspaces, scanOrphanWorkspaces } from "./workspace-orphans.js";
import { evaluateLoopSync } from "./loop-sync.js";

export type DoctorCheckStatus = "ok" | "warn" | "fail";

export type DoctorCheck = {
  name: string;
  status: DoctorCheckStatus;
  message: string;
};

export type LoopReadinessLevel = "L0" | "L1" | "L2" | "L3";

export type LoopReadinessReport = {
  level: LoopReadinessLevel;
  score: number;
  maxScore: number;
  suggestions: string[];
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
  loopReadiness?: LoopReadinessReport;
};

const CODING_CLI = [
  { id: "codex", command: "codex" },
  { id: "gemini", command: "gemini" },
  { id: "claude-code", command: "claude" },
  { id: "opencode", command: "opencode" },
] as const;

export function commandExists(command: string): boolean {
  if (!command.trim()) return false;
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function nodeMajor(): number {
  const v = process.versions.node.split(".")[0] ?? "0";
  return Number(v) || 0;
}

const IMPLEMENT_LIKE = /implement|fix|refactor|write|diagnose/i;

/** A pipeline step value: a provider name or a provider-race array. */
type PipelineStepValue = string | string[] | readonly (string | string[])[];

/** Flattens a step's provider/race value into a list of provider names. */
function stepProviders(value: PipelineStepValue | undefined): string[] {
  if (value === undefined) return [];
  const items = typeof value === "string" ? [value] : Array.from(value);
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      if (item) out.push(item);
    } else {
      for (const provider of item) {
        if (provider) out.push(provider);
      }
    }
  }
  return out;
}

function reviewDependsOnImplementLike(
  pipeline: PipelineConfig["pipeline"],
  reviewStep: string,
): boolean {
  const deps = stepProviders(pipeline[reviewStep]);
  return deps.some((dep) => IMPLEMENT_LIKE.test(dep));
}

function collectPipelineProviders(
  pipeline: PipelineConfig["pipeline"],
  stepNames: string[],
): Set<string> {
  const names = new Set<string>();
  for (const step of stepNames) {
    for (const provider of stepProviders(pipeline[step])) {
      names.add(provider);
    }
  }
  return names;
}

function resolveLoopLevel(score: number): LoopReadinessLevel {
  if (score >= 80) return "L3";
  if (score >= 55) return "L2";
  if (score >= 30) return "L1";
  return "L0";
}

/** Loop-readiness checks aligned with loop-engineering design checklist. */
export function evaluateLoopReadiness(
  config: PipelineConfig,
  configDir: string,
): { checks: DoctorCheck[]; report: LoopReadinessReport } {
  const checks: DoctorCheck[] = [];
  const suggestions: string[] = [];
  let score = 0;
  const maxScore = 100;

  const pipeline = config.pipeline;
  const stepNames = Object.keys(pipeline);
  const reviewStep = config.retry?.reviewStep;
  const implementSteps = stepNames.filter((s) => IMPLEMENT_LIKE.test(s));

  if (reviewStep && pipeline[reviewStep]) {
    score += 15;
    checks.push({
      name: "loop-review-step",
      status: "ok",
      message: `retry.reviewStep="${reviewStep}" is defined in pipeline`,
    });
  } else {
    checks.push({
      name: "loop-review-step",
      status: "warn",
      message: "Missing retry.reviewStep or step not in pipeline — add a review gate for loops",
    });
    suggestions.push("Add a review step and set retry.reviewStep (maker/checker split).");
  }

  if (reviewStep && reviewDependsOnImplementLike(pipeline, reviewStep)) {
    score += 15;
    checks.push({
      name: "loop-maker-checker",
      status: "ok",
      message: `Review step "${reviewStep}" depends on an implement/fix step`,
    });
  } else {
    checks.push({
      name: "loop-maker-checker",
      status: "warn",
      message: "Review step should depend on implement/fix output — verifier must not grade its own work",
    });
    suggestions.push("Wire review dependencies to implement or fix steps.");
  }

  const implementProviders = collectPipelineProviders(pipeline, implementSteps);
  const reviewProviders = reviewStep
    ? collectPipelineProviders(pipeline, [reviewStep])
    : new Set<string>();
  const shared = [...implementProviders].filter((p) => reviewProviders.has(p));
  if (implementProviders.size && reviewProviders.size && shared.length === 0) {
    score += 10;
    checks.push({
      name: "loop-separate-reviewer",
      status: "ok",
      message: "Implement and review use different providers",
    });
  } else if (implementProviders.size <= 1 && reviewProviders.size <= 1) {
    checks.push({
      name: "loop-separate-reviewer",
      status: "warn",
      message: "Same provider for implement and review — use distinct providers before L2 auto-fix",
    });
    suggestions.push("Assign a dedicated reviewer provider separate from the fixer/implementer.");
  } else {
    checks.push({
      name: "loop-separate-reviewer",
      status: "warn",
      message: `Shared provider(s) across implement/review: ${shared.join(", ") || "unknown"}`,
    });
    suggestions.push("Use different providers for implement vs review (maker/checker).");
  }

  if (config.runtime?.controlPlane === "file") {
    score += 10;
    checks.push({
      name: "loop-control-plane",
      status: "ok",
      message: 'runtime.controlPlane is "file" — durable RunStore/EventLog enabled',
    });
  } else {
    checks.push({
      name: "loop-control-plane",
      status: "warn",
      message: 'Set runtime.controlPlane to "file" for loop state across host restarts',
    });
    suggestions.push('Enable runtime.controlPlane: "file" for durable loop state.');
  }

  const maxRounds = config.retry?.maxRounds;
  if (typeof maxRounds === "number" && maxRounds >= 1 && maxRounds <= 10) {
    score += 5;
    checks.push({
      name: "loop-retry-bounds",
      status: "ok",
      message: `retry.maxRounds=${maxRounds}`,
    });
  } else {
    checks.push({
      name: "loop-retry-bounds",
      status: "warn",
      message: "Set retry.maxRounds (1–10) to cap automated fix attempts per item",
    });
    suggestions.push("Set retry.maxRounds to limit fix iterations per PR/item.");
  }

  const governance = config.runtime?.governance;
  if (governance?.enabled) {
    score += 15;
    checks.push({
      name: "loop-governance",
      status: "ok",
      message: "runtime.governance.enabled — Policy → Guardrails → Approval active",
    });
  } else {
    checks.push({
      name: "loop-governance",
      status: "warn",
      message: "Governance disabled — enable before L2 assisted or L3 unattended loops",
    });
    suggestions.push("Enable runtime.governance before unattended auto-fix loops.");
  }

  const riskyRules =
    governance?.rules?.filter(
      (r) => r.decision === "deny" || r.decision === "require-approval",
    ) ?? [];
  if (riskyRules.length > 0) {
    score += 10;
    checks.push({
      name: "loop-governance-rules",
      status: "ok",
      message: `${riskyRules.length} deny/require-approval rule(s) — ${riskyRules.map((r) => r.name).join(", ")}`,
    });
  } else if (governance?.enabled) {
    checks.push({
      name: "loop-governance-rules",
      status: "warn",
      message: "No deny/require-approval path rules — add gates for auth, payments, secrets",
    });
    suggestions.push("Add governance rules with require-approval or deny for sensitive paths.");
  } else {
    checks.push({
      name: "loop-governance-rules",
      status: "warn",
      message: "Governance rules not configured",
    });
  }

  if (typeof config.runtime?.costBudgetUSD === "number" && config.runtime.costBudgetUSD > 0) {
    score += 10;
    checks.push({
      name: "loop-budget",
      status: "ok",
      message: `runtime.costBudgetUSD=${config.runtime.costBudgetUSD}`,
    });
  } else {
    checks.push({
      name: "loop-budget",
      status: "warn",
      message: "No runtime.costBudgetUSD — high-cadence loops can burn tokens unchecked",
    });
    suggestions.push("Set runtime.costBudgetUSD before running frequent loops (e.g. PR babysitter).");
  }

  const hasAgents = existsSync(join(configDir, "AGENTS.md"));
  const hasClaude = existsSync(join(configDir, "CLAUDE.md"));
  if (hasAgents || hasClaude) {
    score += 10;
    checks.push({
      name: "loop-project-docs",
      status: "ok",
      message: hasAgents ? "AGENTS.md found" : "CLAUDE.md found",
    });
  } else {
    checks.push({
      name: "loop-project-docs",
      status: "warn",
      message: "No AGENTS.md or CLAUDE.md beside config — add project conventions for the loop",
    });
    suggestions.push("Add AGENTS.md or CLAUDE.md with build/test commands and loop non-goals.");
  }

  if (governance?.enabled) {
    if (typeof governance.maxStepExecutionsPerStep === "number") {
      score += 10;
      checks.push({
        name: "loop-step-cap",
        status: "ok",
        message: `maxStepExecutionsPerStep=${governance.maxStepExecutionsPerStep}`,
      });
    } else {
      checks.push({
        name: "loop-step-cap",
        status: "warn",
        message: "Set governance.maxStepExecutionsPerStep to prevent infinite fix loops",
      });
      suggestions.push("Set governance.maxStepExecutionsPerStep (e.g. 3–5) per step per run.");
    }
  }

  const level = resolveLoopLevel(score);
  const cappedScore = Math.min(score, maxScore);
  return {
    checks,
    report: {
      level: resolveLoopLevel(cappedScore),
      score: cappedScore,
      maxScore,
      suggestions: [...new Set(suggestions)],
    },
  };
}

export function runDoctor(options?: {
  configPath?: string;
  cleanupOrphans?: boolean;
}): DoctorReport {
  const checks: DoctorCheck[] = [];

  checks.push({
    name: "node",
    status: nodeMajor() >= 20 ? "ok" : "warn",
    message:
      nodeMajor() >= 20
        ? `Node ${process.versions.node}`
        : `Node ${process.versions.node} — Node 20+ recommended`,
  });

  for (const tool of ["python3", "git"] as const) {
    try {
      const out = execFileSync(tool, ["--version"], { encoding: "utf-8" }).trim().split("\n")[0];
      checks.push({ name: tool, status: "ok", message: out ?? tool });
    } catch {
      checks.push({
        name: tool,
        status: "fail",
        message: `${tool} not found — required for pipeline execution`,
      });
    }
  }

  const foundClis: string[] = [];
  for (const cli of CODING_CLI) {
    if (commandExists(cli.command)) foundClis.push(cli.id);
  }
  checks.push({
    name: "coding-agent-cli",
    status: foundClis.length ? "ok" : "warn",
    message: foundClis.length
      ? `Found: ${foundClis.join(", ")}`
      : "No Codex/Gemini/Claude/OpenCode in PATH — mock providers still work",
  });

  const configPath = options?.configPath;
  let loopReadiness: LoopReadinessReport | undefined;
  if (configPath) {
    if (!existsSync(configPath)) {
      checks.push({
        name: "config",
        status: "fail",
        message: `Not found: ${configPath}`,
      });
    } else {
      try {
        const config = loadConfigFromPath(configPath);
        const steps = Object.keys(config.pipeline);
        const unknownCli: string[] = [];
        for (const [name, pc] of Object.entries(config.providers)) {
          if (pc.type === "cli" && pc.command && !commandExists(pc.command)) {
            unknownCli.push(name);
          }
        }
        checks.push({
          name: "config",
          status: "ok",
          message: `Valid — ${steps.length} step(s): ${steps.join(", ")}`,
        });
        const loop = evaluateLoopReadiness(config, dirname(configPath));
        checks.push(...loop.checks);
        checks.push(...evaluateLoopSync(dirname(configPath), config));
        if (unknownCli.length) {
          checks.push({
            name: "config-providers",
            status: "warn",
            message: `CLI not in PATH: ${unknownCli.join(", ")}`,
          });
        }
        loopReadiness = loop.report;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("pipeline-doctor", "config check failed", { error: message });
        checks.push({
          name: "config",
          status: "fail",
          message,
        });
      }
    }
  }

  const orphans = scanOrphanWorkspaces();
  if (orphans.length === 0) {
    checks.push({
      name: "workspace-orphans",
      status: "ok",
      message: "No unmanaged session-* dirs under ~/.runoff/workspaces",
    });
  } else {
    const preview = orphans
      .slice(0, 3)
      .map((o) => `${o.name} (${Math.round(o.ageMs / 3600000)}h)`)
      .join(", ");
    checks.push({
      name: "workspace-orphans",
      status: "warn",
      message: `${orphans.length} orphan worktree(s): ${preview}${orphans.length > 3 ? ", …" : ""}`,
    });
    if (options?.cleanupOrphans) {
      const { removed, errors } = cleanupOrphanWorkspaces(orphans);
      checks.push({
        name: "workspace-orphans-cleanup",
        status: errors.length ? "warn" : "ok",
        message: errors.length
          ? `Removed ${removed}, errors: ${errors.join("; ")}`
          : `Removed ${removed} orphan worktree(s)`,
      });
    }
  }

  return finalizeDoctorReport(checks, loopReadiness);
}

function finalizeDoctorReport(
  checks: DoctorCheck[],
  loopReadiness?: LoopReadinessReport,
): DoctorReport {
  const ok = !checks.some((c) => c.status === "fail");
  return { ok, checks, loopReadiness };
}

export function formatLoopReadinessBadge(report: LoopReadinessReport): string {
  const color =
    report.level === "L3"
      ? "brightgreen"
      : report.level === "L2"
        ? "green"
        : report.level === "L1"
          ? "yellow"
          : "lightgrey";
  const scoreLabel = `${report.score}%2F${report.maxScore}`;
  const alt = `Loop Ready ${report.level} (${report.score}/${report.maxScore})`;
  return `[![${alt}](https://img.shields.io/badge/Loop_Ready-${report.level}_${scoreLabel}-${color}?style=flat-square)](docs/guides/harness-vs-loop.md)`;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["=== runoff doctor ===", ""];
  for (const c of report.checks) {
    const tag = c.status === "ok" ? "OK" : c.status === "warn" ? "WARN" : "FAIL";
    lines.push(`[${tag}] ${c.name}: ${c.message}`);
  }
  if (report.loopReadiness) {
    const lr = report.loopReadiness;
    lines.push("");
    lines.push("--- Loop Readiness ---");
    lines.push(`Level: ${lr.level}  Score: ${lr.score}/${lr.maxScore}`);
    if (lr.suggestions.length) {
      lines.push("Suggestions:");
      for (const s of lr.suggestions) {
        lines.push(`  - ${s}`);
      }
    }
  }
  lines.push("");
  lines.push(report.ok ? "All required checks passed." : "Fix FAIL items before running real CLIs.");
  return lines.join("\n");
}
