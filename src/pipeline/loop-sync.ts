/**
 * Loop sync checks — detect drift between loop scaffold files and pipeline config.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PipelineConfig } from "../core/config.js";
import type { DoctorCheck } from "./pipeline-doctor.js";

export type LoopManifest = {
  schemaVersion: 1;
  profile: string;
  pipelineSteps: string[];
  configFingerprint: string;
  createdAt: string;
};

export function configFingerprint(config: PipelineConfig): string {
  const payload = JSON.stringify({
    pipeline: config.pipeline,
    retry: config.retry,
    governance: config.runtime?.governance?.enabled ?? false,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function loopManifestPath(configDir: string): string {
  return join(configDir, ".runoff", "loop-manifest.json");
}

export function writeLoopManifest(configDir: string, profile: string, config: PipelineConfig): string {
  const dir = join(configDir, ".runoff");
  mkdirSync(dir, { recursive: true });
  const manifest: LoopManifest = {
    schemaVersion: 1,
    profile,
    pipelineSteps: Object.keys(config.pipeline),
    configFingerprint: configFingerprint(config),
    createdAt: new Date().toISOString(),
  };
  const path = loopManifestPath(configDir);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  return path;
}

function readAgentsLevel(agentsPath: string): "L1" | "L2" | "L3" | null {
  try {
    const text = readFileSync(agentsPath, "utf-8");
    if (/L1\b/i.test(text) || /report-only/i.test(text)) return "L1";
    if (/L3\b/i.test(text)) return "L3";
    if (/L2\b/i.test(text)) return "L2";
  } catch {
    return null;
  }
  return null;
}

function parseStateLastRun(statePath: string): Date | null {
  try {
    const text = readFileSync(statePath, "utf-8");
    const match = text.match(/Last run:\s*([^\n(]+)/i);
    if (!match?.[1]) return null;
    const raw = match[1].replace(/_/g, "").trim();
    if (raw.toLowerCase().includes("host updates")) return null;
    const ts = Date.parse(raw);
    return Number.isFinite(ts) ? new Date(ts) : null;
  } catch {
    return null;
  }
}

function configImpliesLevel(config: PipelineConfig): "L1" | "L2" | "L3" {
  const steps = Object.keys(config.pipeline);
  const hasFix = steps.some((s) => /fix|implement/i.test(s));
  if (!hasFix) return "L1";
  if (config.runtime?.governance?.enabled) {
    const risky =
      config.runtime.governance.rules?.some(
        (r) => r.decision === "deny" || r.decision === "require-approval",
      ) ?? false;
    return risky && config.runtime.costBudgetUSD ? "L3" : "L2";
  }
  return "L2";
}

export function evaluateLoopSync(configDir: string, config: PipelineConfig): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const steps = Object.keys(config.pipeline);
  const manifestPath = loopManifestPath(configDir);

  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as LoopManifest;
      const currentFp = configFingerprint(config);
      if (manifest.configFingerprint !== currentFp) {
        checks.push({
          name: "loop-sync-config",
          status: "warn",
          message: `pipeline.config.json drifted since init (profile=${manifest.profile}, was ${manifest.pipelineSteps.join("→")})`,
        });
      } else {
        checks.push({
          name: "loop-sync-config",
          status: "ok",
          message: `Config matches loop manifest (${manifest.profile})`,
        });
      }
    } catch {
      checks.push({
        name: "loop-sync-config",
        status: "warn",
        message: "Invalid .runoff/loop-manifest.json — re-run pipeline init or refresh manifest",
      });
    }
  }

  const agentsPath = join(configDir, "AGENTS.md");
  if (existsSync(agentsPath)) {
    const declared = readAgentsLevel(agentsPath);
    const implied = configImpliesLevel(config);
    if (declared && declared !== implied && !(declared === "L1" && implied === "L2")) {
      checks.push({
        name: "loop-sync-agents-level",
        status: "warn",
        message: `AGENTS.md declares ${declared} but config implies ${implied} — align before unattended loops`,
      });
    } else if (declared) {
      checks.push({
        name: "loop-sync-agents-level",
        status: "ok",
        message: `AGENTS.md level (${declared}) consistent with config (${implied})`,
      });
    }
  }

  const statePath = join(configDir, "STATE.md");
  if (existsSync(statePath)) {
    const lastRun = parseStateLastRun(statePath);
    if (!lastRun) {
      checks.push({
        name: "loop-sync-state",
        status: "warn",
        message: "STATE.md has no parseable Last run timestamp — host loop should update each tick",
      });
    } else {
      const ageDays = (Date.now() - lastRun.getTime()) / 86_400_000;
      if (ageDays > 7) {
        checks.push({
          name: "loop-sync-state",
          status: "warn",
          message: `STATE.md Last run is ${Math.round(ageDays)}d old — loop may be stale or unscheduled`,
        });
      } else {
        checks.push({
          name: "loop-sync-state",
          status: "ok",
          message: `STATE.md Last run ${lastRun.toISOString().slice(0, 10)} (${Math.round(ageDays)}d ago)`,
        });
      }
    }
  } else if (steps.includes("triage")) {
    checks.push({
      name: "loop-sync-state",
      status: "warn",
      message: "No STATE.md — add loop memory spine for multi-tick loops",
    });
  }

  const hasReview = Boolean(config.retry?.reviewStep && config.pipeline[config.retry.reviewStep]);
  const hasFix = steps.some((s) => /fix|implement/i.test(s));
  if (hasFix && !hasReview) {
    checks.push({
      name: "loop-sync-completion",
      status: "warn",
      message: "Fix steps without review gate — completion contract cannot be verifier-checked",
    });
  } else if (hasReview) {
    checks.push({
      name: "loop-sync-completion",
      status: "ok",
      message: `Review step "${config.retry!.reviewStep}" present for completion gating`,
    });
  }

  return checks;
}
