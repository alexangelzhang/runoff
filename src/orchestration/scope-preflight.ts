import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PipelineConfig } from "../core/config.js";
import type { PipelineParams } from "../core/pipeline-run-types.js";
import type {
  ScopePreflightCheck,
  ScopePreflightCheckStatus,
  ScopePreflightReport,
} from "../core/state.js";
import {
  pipelineHasAgentRaceStep,
  pipelineHasAgentWriteStep,
} from "../runtime/pipeline-workdir.js";

type ScopePreflightOverrides = NonNullable<PipelineParams["scopePreflight"]>;
type ScopePolicy = "allow" | "warn" | "clarify";

function add(
  checks: ScopePreflightCheck[],
  name: string,
  status: ScopePreflightCheckStatus,
  detail: string,
  extra: Omit<ScopePreflightCheck, "name" | "status" | "detail"> = {},
): void {
  checks.push({ name, status, detail, ...extra });
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function findGitRoot(workDir?: string): string | undefined {
  if (!workDir || !existsSync(workDir)) return undefined;
  return git(workDir, ["rev-parse", "--show-toplevel"]);
}

function dirtyWorktreeStatus(repoRoot: string):
  | { kind: "clean" }
  | { kind: "dirty"; summary: string }
  | { kind: "unknown" } {
  const output = git(repoRoot, ["status", "--porcelain"]);
  if (output === undefined) return { kind: "unknown" };
  const lines = output.split("\n").filter(Boolean);
  if (!lines.length) return { kind: "clean" };
  return {
    kind: "dirty",
    summary: `${lines.length} dirty entr${lines.length === 1 ? "y" : "ies"}`,
  };
}

function requestedDocsUpdate(input: {
  prompt: string;
  context?: string;
  acceptanceCriteria?: string[];
}): boolean {
  const haystack = [
    input.prompt,
    input.context ?? "",
    ...(input.acceptanceCriteria ?? []),
  ].join("\n").toLowerCase();
  return /\b(readme|roadmap|agents\.md|changelog|markdown|docs?\/|documentation|\.md)\b/.test(haystack) ||
    /文档|设计文档|说明|总结|报告/.test(haystack);
}

function policyFromConfig(
  configured: ScopePolicy | undefined,
  overrideAllow: boolean | undefined,
  fallback: ScopePolicy,
): ScopePolicy {
  if (overrideAllow === true) return "allow";
  if (overrideAllow === false) return "clarify";
  return configured ?? fallback;
}

function policyStatus(policy: ScopePolicy): ScopePreflightCheckStatus {
  if (policy === "clarify") return "block";
  if (policy === "warn") return "warn";
  return "pass";
}

function aggregateReport(checks: ScopePreflightCheck[]): Pick<
  ScopePreflightReport,
  "assumptions" | "warnings" | "blockers" | "clarificationQuestions" | "evidenceRefs" | "safeDefaults"
> {
  const assumptions: string[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  const clarificationQuestions: string[] = [];
  const evidenceRefs = new Set<string>();
  const safeDefaults: string[] = [];

  for (const check of checks) {
    if (check.assumption) assumptions.push(check.assumption);
    if (check.status === "warn") warnings.push(check.detail);
    if (check.status === "block") blockers.push(check.detail);
    if (check.clarificationQuestion) clarificationQuestions.push(check.clarificationQuestion);
    for (const ref of check.evidenceRefs ?? []) evidenceRefs.add(ref);
  }

  if (!warnings.length && !blockers.length) {
    safeDefaults.push("No scope preflight blocker was detected; proceed with configured pipeline defaults.");
  }

  return {
    assumptions,
    warnings,
    blockers,
    clarificationQuestions,
    evidenceRefs: [...evidenceRefs],
    safeDefaults,
  };
}

export function runScopePreflight(input: {
  config: PipelineConfig;
  prompt: string;
  context?: string;
  workDir?: string;
  acceptanceCriteria?: string[];
  verifyResults?: string;
  configHash: string;
  overrides?: ScopePreflightOverrides;
}): ScopePreflightReport {
  const cfg = input.config.runtime?.scopePreflight;
  const checks: ScopePreflightCheck[] = [];
  const configPath = join(process.cwd(), "pipeline.config.json");
  if (cfg?.enabled === false) {
    return {
      schemaVersion: 1,
      decision: "proceed",
      risk: "low",
      checks: [
        {
          name: "scopePreflight",
          status: "pass",
          detail: "Scope preflight is disabled by runtime.scopePreflight.enabled=false.",
          evidenceRefs: ["runtime.scopePreflight.enabled=false", `config=${configPath}`],
        },
      ],
      assumptions: ["Caller disabled scope preflight checks in runtime config."],
      warnings: [],
      blockers: [],
      clarificationQuestions: [],
      evidenceRefs: ["runtime.scopePreflight.enabled=false", `config=${configPath}`],
      safeDefaults: [],
    };
  }
  const hasAgentWrite = pipelineHasAgentWriteStep(input.config);
  const hasRace = pipelineHasAgentRaceStep(input.config);
  const docIntent = requestedDocsUpdate(input);

  add(checks, "config", "pass", "pipeline.config.json was loaded and hashed.", {
    evidenceRefs: [`config=${configPath}`, `configHash=${input.configHash}`],
  });

  if (input.workDir) {
    if (!existsSync(input.workDir)) {
      add(checks, "workDir", "block", `workDir does not exist: ${input.workDir}`, {
        evidenceRefs: [`workDir=${input.workDir}`],
        clarificationQuestion: "Provide an existing absolute workDir or rerun without agent-mode steps.",
      });
    } else if (!statSync(input.workDir).isDirectory()) {
      add(checks, "workDir", "block", `workDir is not a directory: ${input.workDir}`, {
        evidenceRefs: [`workDir=${input.workDir}`],
        clarificationQuestion: "Provide a directory workDir.",
      });
    } else {
      add(checks, "workDir", "pass", `workDir exists: ${input.workDir}`, {
        evidenceRefs: [`workDir=${input.workDir}`],
      });
    }
  } else if (hasAgentWrite) {
    add(checks, "workDir", "block", "Agent write steps require an explicit workDir.", {
      evidenceRefs: ["pipeline.agentWriteSteps=true"],
      clarificationQuestion: "Pass workDir as an absolute path to the target repository.",
    });
  } else {
    add(checks, "workDir", "pass", "No explicit workDir supplied; non-agent-write pipeline can use process.cwd().", {
      assumption: "Using process.cwd() for non-agent-write execution.",
    });
  }

  const dirtyProbeDir = input.workDir ?? (hasAgentWrite ? undefined : process.cwd());
  const gitRoot = findGitRoot(dirtyProbeDir);
  const dirtyStatus = gitRoot ? dirtyWorktreeStatus(gitRoot) : undefined;
  const requireCleanWorktree =
    input.overrides?.requireCleanWorktree === true ||
    cfg?.requireCleanWorktree === true;
  const dirtyPolicy = policyFromConfig(
    cfg?.dirtyWorktree,
    input.overrides?.allowDirtyWorktree,
    hasAgentWrite ? "clarify" : "warn",
  );
  if (dirtyStatus?.kind === "dirty") {
    const status = requireCleanWorktree ? "block" : policyStatus(dirtyPolicy);
    add(checks, "dirtyWorktree", status, `Target git worktree is dirty (${dirtyStatus.summary}).`, {
      evidenceRefs: [`gitRoot=${gitRoot}`, "git.status=dirty"],
      clarificationQuestion:
        status === "block"
          ? requireCleanWorktree
            ? "Clean/stash dirty changes or set requireCleanWorktree=false."
            : "Confirm allowDirtyWorktree=true, clean/stash unrelated changes, or choose another workDir."
          : undefined,
      assumption:
        dirtyPolicy === "allow" && !requireCleanWorktree
          ? "Caller explicitly allowed dirty worktree execution."
          : undefined,
    });
  } else if (dirtyStatus?.kind === "clean") {
    add(checks, "dirtyWorktree", "pass", "Target git worktree is clean.", {
      evidenceRefs: [`gitRoot=${gitRoot}`, "git.status=clean"],
    });
  } else if (dirtyStatus?.kind === "unknown") {
    add(checks, "dirtyWorktree", requireCleanWorktree ? "block" : "warn", "git status failed; dirty-state protection is unavailable.", {
      evidenceRefs: [`gitRoot=${gitRoot}`, "git.status=unknown"],
      clarificationQuestion: requireCleanWorktree
        ? "Fix git status for the target worktree or set requireCleanWorktree=false."
        : undefined,
    });
  } else if (dirtyProbeDir) {
    add(checks, "dirtyWorktree", requireCleanWorktree ? "block" : "warn", "workDir is not inside a git worktree; dirty-state protection is unavailable.", {
      evidenceRefs: [`workDir=${dirtyProbeDir}`],
      clarificationQuestion: requireCleanWorktree
        ? "Pass a git worktree workDir or set requireCleanWorktree=false."
        : undefined,
    });
  }

  const docsPolicy = policyFromConfig(cfg?.docUpdates, input.overrides?.allowDocUpdates, "clarify");
  if (docIntent) {
    add(checks, "docUpdates", policyStatus(docsPolicy), "Prompt or criteria request documentation changes.", {
      evidenceRefs: ["prompt.docsIntent=true"],
      clarificationQuestion:
        docsPolicy === "clarify"
          ? "Confirm allowDocUpdates=true or remove documentation changes from scope."
          : undefined,
      assumption: docsPolicy === "allow" ? "Caller explicitly allowed documentation changes." : undefined,
    });
  } else {
    add(checks, "docUpdates", "pass", "No documentation-update intent was detected in prompt/context/criteria.");
  }

  const verificationCommand = input.overrides?.verificationCommand;
  const requireVerification =
    input.overrides?.requireVerificationCommand === true ||
    cfg?.requireVerificationCommand === true;
  if (verificationCommand) {
    add(checks, "verification", "pass", `Verification command declared: ${verificationCommand}`, {
      evidenceRefs: [`verificationCommand=${verificationCommand}`],
    });
  } else if (input.verifyResults) {
    add(checks, "verification", "pass", "External verifyResults were supplied.", {
      evidenceRefs: ["verifyResults"],
    });
  } else if (requireVerification) {
    add(checks, "verification", "block", "No verification command or verifyResults were supplied.", {
      clarificationQuestion: "Pass scopePreflight.verificationCommand or verifyResults before running.",
    });
  } else {
    add(checks, "verification", "warn", "No verification command was declared; pipeline must infer validation from prompt/config.", {
      assumption: "Proceeding without a declared verification command.",
    });
  }

  const racePolicy = policyFromConfig(cfg?.race, input.overrides?.allowRace, "allow");
  if (hasRace) {
    add(checks, "race", policyStatus(racePolicy), "Provider race is configured for at least one step.", {
      evidenceRefs: ["pipeline.race=true"],
      clarificationQuestion:
        racePolicy === "clarify"
          ? "Confirm allowRace=true or change pipeline config to a single provider."
          : undefined,
      assumption: racePolicy === "allow" ? "Proceeding with configured provider race." : undefined,
    });
  } else {
    add(checks, "race", "pass", "No provider race step is configured.");
  }

  const governance = input.config.runtime?.governance;
  if (governance?.enabled && governance.requirePlanApproval) {
    add(checks, "approval", "warn", "Plan approval is enabled; pipeline may pause at awaiting_plan_approval.", {
      evidenceRefs: ["runtime.governance.requirePlanApproval=true"],
    });
  } else if (governance?.enabled && governance.approvalMode === "defer") {
    add(checks, "approval", "warn", "Deferred action approval is enabled; pipeline may pause at awaiting_approval.", {
      evidenceRefs: ["runtime.governance.approvalMode=defer"],
    });
  } else {
    add(checks, "approval", "pass", "No deferred approval precondition was detected.");
  }

  const aggregate = aggregateReport(checks);
  const hasBlocker = aggregate.blockers.length > 0;
  const risk =
    hasBlocker || checks.some((check) => check.status === "warn" && ["dirtyWorktree", "docUpdates"].includes(check.name))
      ? "high"
      : checks.some((check) => check.status === "warn")
        ? "medium"
        : "low";

  return {
    schemaVersion: 1,
    decision: hasBlocker ? "needs_clarification" : "proceed",
    risk,
    checks,
    ...aggregate,
  };
}
