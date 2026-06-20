#!/usr/bin/env npx tsx
/**
 * runoff CLI (no MCP host required).
 *
 *   pipeline run | init | doctor | config edit | config validate | mcp
 *   pipeline runs list|show
 *   pipeline harness coreset|mine|dataset|create|propose|evaluate|evaluate-dataset|audit|rank|frontier|decide|export|list
 *   pipeline traces list|show|tail | observability ui
 */

import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { clearConfigCache, loadConfigFromPath, validateConfig } from "../../../src/core/config.js";
import { executePipelineRun } from "../../../src/orchestration/pipeline-mcp-run.js";
import { getPipelineHomeDir } from "../../../src/core/paths.js";
import {
  openInBrowser,
  startConfigEditorServer,
} from "../../../src/pipeline/config-editor-server.js";
import { formatDoctorReport, runDoctor } from "../../../src/pipeline/pipeline-doctor.js";
import { formatPipelineRunOutcomeHints } from "../../../src/pipeline/run-outcome-hints.js";
import { pipelineInit, type InitProfile } from "../../../src/pipeline/pipeline-init.js";
import {
  applyRaceSession,
  abortRaceSession,
  resolveRaceTraceId,
} from "../../../src/runtime/race-finalize.js";
import { startObservabilityUiServer } from "../../../src/pipeline/observability-ui-server.js";
import {
  harnessEvolveAudit,
  harnessEvolveCoreset,
  harnessEvolveCreate,
  harnessEvolveDataset,
  harnessEvolveDecide,
  harnessEvolveEvaluate,
  harnessEvolveEvaluateDataset,
  harnessEvolveExport,
  harnessEvolveFrontier,
  harnessEvolveList,
  harnessEvolveMine,
  harnessEvolvePropose,
  harnessEvolveRank,
} from "../../../src/pipeline/harness-evolve-cli.js";
import { runsList, runsShow } from "../../../src/pipeline/run-control-cli.js";
import { tracesList, tracesShow, tracesTail } from "../../../src/pipeline/trace-cli.js";
import type { PipelineStatus } from "../../../src/core/state.js";
import type { RunStatus } from "../../../src/orchestration/run-store.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const INIT_PROFILES = ["mock", "feature", "bugfix", "refactor", "cli-detected"] as const;

function printHelp(): void {
  console.log(`runoff CLI

Usage:
  pipeline run --prompt <text> --work-dir <git-repo> [--config <path>]
  pipeline init --work-dir <dir> [--profile mock|feature|bugfix|refactor|cli-detected]
  pipeline doctor [--config <path>] [--cleanup-orphans]
  pipeline config edit [--config <path>] [--port <n>] [--no-open]
  pipeline config validate [--config <path>]
  pipeline race apply --trace-id <id> --winner <n>
  pipeline race apply --session <checkpointId> --winner <n>
  pipeline race abort --trace-id <id> [--reason <text>]
  pipeline runs list [--status <status>] [--session-id <id>] [--limit <n>] [--json]
  pipeline runs show <runId> [--json]
  pipeline harness coreset [--limit <n>] [--since <iso>] [--json]
  pipeline harness mine [--trace-ids-json <json>] [--limit <n>] [--since <iso>] [--json]
  pipeline harness dataset --summary <name> [--dataset-id <id>] [--trace-ids-json <json>] [--failure-signature-ids-json <json>] [--held-in-ratio <n>] [--leakage-terms-json <json>] [--json]
  pipeline harness create --summary <text> [--candidate-id <id>] [--source-dir <dir>] [--parent-candidate-ids-json <json>] [--dataset-ids-json <json>] [--json]
  pipeline harness propose --summary <text> [--candidate-id <id>] [--provider <name>] [--source-dir <dir>] [--instructions <text>] [--parent-candidate-ids-json <json>] [--dataset-ids-json <json>] [--json]
  pipeline harness evaluate <candidateId> --pairs-json <json> [--json]
  pipeline harness evaluate-dataset <candidateId> --dataset-id <id> --candidate-trace-map-json <json> [--json]
  pipeline harness audit <candidateId> [--dataset-id <id>] [--leakage-terms-json <json>] [--json]
  pipeline harness rank [--candidate-ids-json <json>] [--json]
  pipeline harness frontier [--frontier-id <id>] [--candidate-ids-json <json>] [--json]
  pipeline harness decide <candidateId> [--decision accept|rollback] [--reason <text>] [--json]
  pipeline harness export <candidateId> [--json]
  pipeline harness list [--limit <n>] [--json]
  pipeline traces list [--status <status>] [--session <id>] [--limit <n>] [--json]
  pipeline traces show <traceId> [--postmortem] [--json]
  pipeline traces tail [--once]
  pipeline observability ui [--port <n>] [--no-open]

Examples:
  npx runoff init --work-dir ../my-repo --profile feature
  npx runoff doctor --config ../my-repo/pipeline.config.json
  npx runoff run --prompt "Add tests" --work-dir ../my-repo
  npx runoff mcp                # start MCP server (stdio)

Docs: docs/guides/getting-started-30min.md, docs/guides/mcp-host-setup.md
`);
}

type CliArgs = {
  command: string;
  sub?: string;
  prompt?: string;
  workDir?: string;
  config?: string;
  profile?: InitProfile;
  maxRounds?: number;
  home?: string;
  port?: number;
  noOpen?: boolean;
  traceId?: string;
  sessionId?: string;
  winner?: number;
  reason?: string;
  summary?: string;
  datasetId?: string;
  frontierId?: string;
  sourceDir?: string;
  provider?: string;
  instructions?: string;
  editableSurfaceJson?: string;
  expectedFixesJson?: string;
  possibleRegressionsJson?: string;
  evidenceTraceIdsJson?: string;
  failureSignatureIdsJson?: string;
  parentCandidateIdsJson?: string;
  datasetIdsJson?: string;
  leakageTermsJson?: string;
  candidateTraceMapJson?: string;
  pairsJson?: string;
  candidateIdsJson?: string;
  traceIdsJson?: string;
  decision?: "accept" | "rollback";
  since?: string;
  cleanupOrphans?: boolean;
  json?: boolean;
  postmortem?: boolean;
  once?: boolean;
  status?: PipelineStatus;
  runStatus?: RunStatus;
  sessionFilter?: string;
  limit?: number;
  heldInRatio?: number;
};

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { command: argv[0] ?? "help" };
  if (out.command === "config" || out.command === "race" || out.command === "runs" || out.command === "harness" || out.command === "traces" || out.command === "observability") {
    out.sub = argv[1] ?? "help";
  }
  const multiSub =
    out.command === "config" || out.command === "race" || out.command === "runs" || out.command === "harness" || out.command === "traces" || out.command === "observability";
  const start = multiSub ? 2 : 1;
  let positionalConsumed = 0;
  if (out.command === "runs" && out.sub === "show" && argv[2] && !argv[2].startsWith("-")) {
    out.traceId = argv[2];
    positionalConsumed = 1;
  }
  if (
    out.command === "harness" &&
    (out.sub === "evaluate" || out.sub === "evaluate-dataset" || out.sub === "audit" || out.sub === "decide" || out.sub === "export") &&
    argv[2] &&
    !argv[2].startsWith("-")
  ) {
    out.traceId = argv[2];
    positionalConsumed = 1;
  }
  if (out.command === "traces" && out.sub === "show" && argv[2] && !argv[2].startsWith("-")) {
    out.traceId = argv[2];
    positionalConsumed = 1;
  }
  for (let i = start + positionalConsumed; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    if (a === "--prompt") out.prompt = next();
    else if (a === "--work-dir") out.workDir = next();
    else if (a === "--config") out.config = next();
    else if (a === "--profile") {
      const p = next();
      if (!INIT_PROFILES.includes(p as InitProfile)) {
        throw new Error(`--profile must be one of: ${INIT_PROFILES.join(", ")}`);
      }
      out.profile = p as InitProfile;
    } else if (a === "--max-rounds") out.maxRounds = Number(next());
    else if (a === "--home") out.home = next();
    else if (a === "--port") out.port = Number(next());
    else if (a === "--no-open") out.noOpen = true;
    else if (a === "--trace-id") out.traceId = next();
    else if (a === "--candidate-id") out.traceId = next();
    else if (a === "--dataset-id") out.datasetId = next();
    else if (a === "--frontier-id") out.frontierId = next();
    else if (a === "--source-dir") out.sourceDir = next();
    else if (a === "--provider") out.provider = next();
    else if (a === "--instructions") out.instructions = next();
    else if (a === "--editable-surface-json") out.editableSurfaceJson = next();
    else if (a === "--expected-fixes-json") out.expectedFixesJson = next();
    else if (a === "--possible-regressions-json") out.possibleRegressionsJson = next();
    else if (a === "--evidence-trace-ids-json") out.evidenceTraceIdsJson = next();
    else if (a === "--failure-signature-ids-json") out.failureSignatureIdsJson = next();
    else if (a === "--parent-candidate-ids-json") out.parentCandidateIdsJson = next();
    else if (a === "--dataset-ids-json") out.datasetIdsJson = next();
    else if (a === "--leakage-terms-json") out.leakageTermsJson = next();
    else if (a === "--candidate-trace-map-json") out.candidateTraceMapJson = next();
    else if (a === "--summary") out.summary = next();
    else if (a === "--pairs-json") out.pairsJson = next();
    else if (a === "--candidate-ids-json") out.candidateIdsJson = next();
    else if (a === "--trace-ids-json") out.traceIdsJson = next();
    else if (a === "--held-in-ratio") out.heldInRatio = Number(next());
    else if (a === "--since") out.since = next();
    else if (a === "--decision") {
      const decision = next();
      if (decision !== "accept" && decision !== "rollback") throw new Error("--decision must be accept or rollback");
      out.decision = decision;
    }
    else if (a === "--session") out.sessionId = next();
    else if (a === "--winner") out.winner = Number(next());
    else if (a === "--reason") out.reason = next();
    else if (a === "--cleanup-orphans") out.cleanupOrphans = true;
    else if (a === "--json") out.json = true;
    else if (a === "--postmortem") out.postmortem = true;
    else if (a === "--once") out.once = true;
    else if (a === "--status") {
      const status = next();
      if (out.command === "runs") out.runStatus = status as RunStatus;
      else out.status = status as PipelineStatus;
    }
    else if (a === "--session-id") out.sessionFilter = next();
    else if (a === "--session") out.sessionFilter = next();
    else if (a === "--limit") out.limit = Number(next());
    else if (a === "--help" || a === "-h") out.command = "help";
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

async function cmdRun(args: CliArgs): Promise<void> {
  if (!args.prompt?.trim()) throw new Error("--prompt is required");
  if (!args.workDir?.trim()) throw new Error("--work-dir is required");

  const workDir = resolve(args.workDir);
  if (!existsSync(workDir)) throw new Error(`work-dir not found: ${workDir}`);

  if (args.home) process.env.RUNOFF_HOME = resolve(args.home);

  const configPath = resolve(args.config ?? join(workDir, "pipeline.config.json"));
  if (!existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}\nRun: npm run pipeline:init -- --work-dir ${workDir}`);
  }

  const runDir = mkdtempSync(join(tmpdir(), "runoff-cli-cwd-"));
  cpSync(configPath, join(runDir, "pipeline.config.json"));
  process.chdir(runDir);
  clearConfigCache();

  console.log("runoff run");
  console.log(`  work-dir:  ${workDir}`);
  console.log(`  config:    ${configPath}`);
  console.log(`  data home: ${getPipelineHomeDir()}\n`);

  const result = await executePipelineRun({
    prompt: args.prompt,
    workDir,
    maxRounds: args.maxRounds,
  });

  console.log(formatPipelineRunOutcomeHints(result, { sessionId: result.checkpointFile }));
  process.exit(result.status === "approved" ? 0 : 1);
}

function cmdInit(args: CliArgs): void {
  if (!args.workDir?.trim()) throw new Error("--work-dir is required");
  const profile = args.profile ?? "feature";
  const result = pipelineInit(args.workDir, profile);
  console.log("Created pipeline.config.json");
  console.log(`  path:    ${result.configPath}`);
  console.log(`  profile: ${result.profile}`);
  console.log("\nNext:");
  console.log(`  npm run pipeline:config:edit -- --config ${result.configPath}`);
  console.log(`  npm run pipeline:doctor -- --config ${result.configPath}`);
}

function cmdDoctor(args: CliArgs): void {
  const configPath = args.config ? resolve(args.config) : undefined;
  const report = runDoctor({ configPath, cleanupOrphans: args.cleanupOrphans });
  console.log(formatDoctorReport(report));
  process.exit(report.ok ? 0 : 1);
}

function cmdConfigValidate(args: CliArgs): void {
  const configPath = resolve(args.config ?? join(process.cwd(), "pipeline.config.json"));
  if (!existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    process.exit(1);
  }
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!validateConfig(raw)) {
      console.error("Invalid config (validateConfig returned false)");
      process.exit(1);
    }
    loadConfigFromPath(configPath);
    console.log(`OK: ${configPath}`);
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function cmdRaceApply(args: CliArgs): Promise<void> {
  const traceId = await resolveRaceTraceId({
    traceId: args.traceId,
    sessionId: args.sessionId,
  });
  const winner = args.winner ?? 0;
  const result = await applyRaceSession(traceId, winner);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdRaceAbort(args: CliArgs): Promise<void> {
  const traceId = await resolveRaceTraceId({
    traceId: args.traceId,
    sessionId: args.sessionId,
  });
  const result = await abortRaceSession(traceId, args.reason);
  console.log(JSON.stringify(result, null, 2));
}

function cmdTraces(args: CliArgs): void {
  if (args.sub === "list") {
    tracesList({
      status: args.status,
      sessionId: args.sessionFilter,
      limit: args.limit,
      json: args.json,
    });
    return;
  }
  if (args.sub === "show") {
    const id = args.traceId;
    if (!id) throw new Error("trace id required: pipeline traces show <traceId>");
    tracesShow(id, { postmortem: args.postmortem, json: args.json });
    return;
  }
  if (args.sub === "tail") {
    tracesTail({ once: args.once });
    return;
  }
  throw new Error("Usage: pipeline traces list|show|tail");
}

function cmdRuns(args: CliArgs): void {
  const configPath = resolve(args.config ?? join(process.cwd(), "pipeline.config.json"));
  if (!existsSync(configPath)) throw new Error(`Config not found: ${configPath}`);
  if (args.home) process.env.RUNOFF_HOME = resolve(args.home);

  if (args.sub === "list") {
    runsList({
      configPath,
      status: args.runStatus,
      sessionId: args.sessionFilter,
      limit: args.limit,
      json: args.json,
    });
    return;
  }
  if (args.sub === "show") {
    if (!args.traceId) throw new Error("run id required: pipeline runs show <runId>");
    runsShow({ configPath, runId: args.traceId, json: args.json });
    return;
  }
  throw new Error("Usage: pipeline runs list|show");
}

function parseJsonArray<T>(raw: string | undefined, name: string): T[] {
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${name} must be a JSON array`);
  return parsed as T[];
}

async function cmdHarness(args: CliArgs): Promise<void> {
  if (args.home) process.env.RUNOFF_HOME = resolve(args.home);
  if (args.sub === "coreset") {
    harnessEvolveCoreset({ limit: args.limit, since: args.since, json: args.json });
    return;
  }
  if (args.sub === "mine") {
    harnessEvolveMine({
      traceIds: parseJsonArray(args.traceIdsJson, "--trace-ids-json"),
      limit: args.limit,
      since: args.since,
      json: args.json,
    });
    return;
  }
  if (args.sub === "dataset") {
    if (!args.summary?.trim()) throw new Error("--summary is required");
    harnessEvolveDataset({
      datasetId: args.datasetId,
      name: args.summary,
      traceIds: parseJsonArray(args.traceIdsJson, "--trace-ids-json"),
      failureSignatureIds: parseJsonArray(args.failureSignatureIdsJson, "--failure-signature-ids-json"),
      heldInRatio: args.heldInRatio,
      leakageTerms: parseJsonArray(args.leakageTermsJson, "--leakage-terms-json"),
      json: args.json,
    });
    return;
  }
  if (args.sub === "create") {
    if (!args.summary?.trim()) throw new Error("--summary is required");
    harnessEvolveCreate({
      candidateId: args.traceId,
      summary: args.summary,
      sourceDir: args.sourceDir,
      editableSurface: parseJsonArray(args.editableSurfaceJson, "--editable-surface-json"),
      expectedFixes: parseJsonArray(args.expectedFixesJson, "--expected-fixes-json"),
      possibleRegressions: parseJsonArray(args.possibleRegressionsJson, "--possible-regressions-json"),
      evidenceTraceIds: parseJsonArray(args.evidenceTraceIdsJson, "--evidence-trace-ids-json"),
      failureSignatureIds: parseJsonArray(args.failureSignatureIdsJson, "--failure-signature-ids-json"),
      parentCandidateIds: parseJsonArray(args.parentCandidateIdsJson, "--parent-candidate-ids-json"),
      datasetIds: parseJsonArray(args.datasetIdsJson, "--dataset-ids-json"),
      json: args.json,
    });
    return;
  }
  if (args.sub === "propose") {
    if (!args.summary?.trim() && !args.traceId) throw new Error("--summary is required unless --candidate-id targets an existing candidate");
    const configPath = resolve(args.config ?? join(process.cwd(), "pipeline.config.json"));
    if (!existsSync(configPath)) throw new Error(`Config not found: ${configPath}`);
    await harnessEvolvePropose({
      configPath,
      candidateId: args.traceId,
      summary: args.summary ?? "Harness proposer candidate",
      sourceDir: args.sourceDir,
      provider: args.provider,
      instructions: args.instructions,
      editableSurface: parseJsonArray(args.editableSurfaceJson, "--editable-surface-json"),
      expectedFixes: parseJsonArray(args.expectedFixesJson, "--expected-fixes-json"),
      possibleRegressions: parseJsonArray(args.possibleRegressionsJson, "--possible-regressions-json"),
      evidenceTraceIds: parseJsonArray(args.evidenceTraceIdsJson, "--evidence-trace-ids-json"),
      failureSignatureIds: parseJsonArray(args.failureSignatureIdsJson, "--failure-signature-ids-json"),
      parentCandidateIds: parseJsonArray(args.parentCandidateIdsJson, "--parent-candidate-ids-json"),
      datasetIds: parseJsonArray(args.datasetIdsJson, "--dataset-ids-json"),
      json: args.json,
    });
    return;
  }
  if (args.sub === "evaluate") {
    if (!args.traceId) throw new Error("candidate id required: pipeline harness evaluate <candidateId>");
    harnessEvolveEvaluate({
      candidateId: args.traceId,
      pairs: parseJsonArray(args.pairsJson, "--pairs-json"),
      json: args.json,
    });
    return;
  }
  if (args.sub === "evaluate-dataset") {
    if (!args.traceId) throw new Error("candidate id required: pipeline harness evaluate-dataset <candidateId>");
    if (!args.datasetId) throw new Error("--dataset-id is required");
    const candidateTraceMap = args.candidateTraceMapJson ? JSON.parse(args.candidateTraceMapJson) as Record<string, string> : {};
    harnessEvolveEvaluateDataset({
      candidateId: args.traceId,
      datasetId: args.datasetId,
      candidateTraceMap,
      json: args.json,
    });
    return;
  }
  if (args.sub === "audit") {
    if (!args.traceId) throw new Error("candidate id required: pipeline harness audit <candidateId>");
    harnessEvolveAudit({
      candidateId: args.traceId,
      datasetId: args.datasetId,
      leakageTerms: parseJsonArray(args.leakageTermsJson, "--leakage-terms-json"),
      json: args.json,
    });
    return;
  }
  if (args.sub === "rank") {
    harnessEvolveRank({
      candidateIds: parseJsonArray(args.candidateIdsJson, "--candidate-ids-json"),
      json: args.json,
    });
    return;
  }
  if (args.sub === "frontier") {
    harnessEvolveFrontier({
      frontierId: args.frontierId,
      candidateIds: parseJsonArray(args.candidateIdsJson, "--candidate-ids-json"),
      json: args.json,
    });
    return;
  }
  if (args.sub === "decide") {
    if (!args.traceId) throw new Error("candidate id required: pipeline harness decide <candidateId>");
    harnessEvolveDecide({
      candidateId: args.traceId,
      decision: args.decision,
      reason: args.reason,
      json: args.json,
    });
    return;
  }
  if (args.sub === "export") {
    if (!args.traceId) throw new Error("candidate id required: pipeline harness export <candidateId>");
    harnessEvolveExport({
      candidateId: args.traceId,
      json: args.json,
    });
    return;
  }
  if (args.sub === "list") {
    harnessEvolveList({ limit: args.limit, json: args.json });
    return;
  }
  throw new Error("Usage: pipeline harness coreset|mine|dataset|create|propose|evaluate|evaluate-dataset|audit|rank|frontier|decide|export|list");
}

async function cmdObservabilityUi(args: CliArgs): Promise<void> {
  if (args.home) process.env.RUNOFF_HOME = resolve(args.home);
  const handle = await startObservabilityUiServer({ port: args.port });
  console.log("Observability UI");
  console.log(`  url:  ${handle.url}`);
  console.log(`  home: ${getPipelineHomeDir()}\n`);
  if (!args.noOpen) openInBrowser(handle.url);
  await new Promise<void>((resolvePromise) => {
    const onSignal = () => void handle.close().then(() => resolvePromise());
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

async function cmdConfigEdit(args: CliArgs): Promise<void> {
  const configPath = resolve(args.config ?? join(process.cwd(), "pipeline.config.json"));
  if (!existsSync(configPath)) {
    throw new Error(
      `Config not found: ${configPath}\nRun: npm run pipeline:init -- --work-dir <dir> --profile feature`,
    );
  }

  const handle = await startConfigEditorServer({ configPath, port: args.port });

  console.log("Pipeline config editor (providers + DAG + retry)");
  console.log(`  config: ${handle.configPath}`);
  console.log(`  url:    ${handle.url}`);
  console.log("\nClick **Save to config** in the browser. Ctrl+C to stop.\n");

  if (!args.noOpen) openInBrowser(handle.url);

  await new Promise<void>((resolvePromise) => {
    const onSignal = () => void handle.close().then(() => resolvePromise());
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help" || args.command === "--help") {
    printHelp();
    return;
  }
  if (args.command === "run") {
    await cmdRun(args);
    return;
  }
  if (args.command === "init") {
    cmdInit(args);
    return;
  }
  if (args.command === "doctor") {
    cmdDoctor(args);
    return;
  }
  if (args.command === "config" && args.sub === "edit") {
    await cmdConfigEdit(args);
    return;
  }
  if (args.command === "config" && args.sub === "validate") {
    cmdConfigValidate(args);
    return;
  }
  if (args.command === "race" && args.sub === "apply") {
    await cmdRaceApply(args);
    return;
  }
  if (args.command === "race" && args.sub === "abort") {
    await cmdRaceAbort(args);
    return;
  }
  if (args.command === "runs") {
    cmdRuns(args);
    return;
  }
  if (args.command === "harness") {
    await cmdHarness(args);
    return;
  }
  if (args.command === "traces") {
    cmdTraces({ ...args, traceId: args.traceId });
    return;
  }
  if (args.command === "observability" && args.sub === "ui") {
    await cmdObservabilityUi(args);
    return;
  }
  if (args.command === "mcp") {
    // Start the MCP server (stdio transport — used by npx runoff mcp)
    await import(join(REPO_ROOT, "src", "index.ts"));
    return;
  }
  printHelp();
  process.exit(args.command ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
