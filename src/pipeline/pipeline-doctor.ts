/**
 * Environment and config health checks for local onboarding.
 */

import { execFileSync } from "node:child_process";
import { logger } from "../core/logger.js";
import { existsSync } from "node:fs";
import { loadConfigFromPath } from "../core/config.js";
import { cleanupOrphanWorkspaces, scanOrphanWorkspaces } from "./workspace-orphans.js";

export type DoctorCheckStatus = "ok" | "warn" | "fail";

export type DoctorCheck = {
  name: string;
  status: DoctorCheckStatus;
  message: string;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
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
        if (unknownCli.length) {
          checks.push({
            name: "config-providers",
            status: "warn",
            message: `CLI not in PATH: ${unknownCli.join(", ")}`,
          });
        }
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
      message: "No unmanaged session-* dirs under ~/.llm-pipeline/workspaces",
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

  const ok = !checks.some((c) => c.status === "fail");
  return { ok, checks };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["=== llm-pipeline doctor ===", ""];
  for (const c of report.checks) {
    const tag = c.status === "ok" ? "OK" : c.status === "warn" ? "WARN" : "FAIL";
    lines.push(`[${tag}] ${c.name}: ${c.message}`);
  }
  lines.push("");
  lines.push(report.ok ? "All required checks passed." : "Fix FAIL items before running real CLIs.");
  return lines.join("\n");
}
