#!/usr/bin/env npx tsx
/**
 * runoff CLI (no MCP host required).
 *
 *   pipeline run | init | doctor | config edit | config validate | mcp
 *   pipeline runs list|show
 *   pipeline harness coreset|mine|dataset|create|propose|run|training-export|paddock|sandbox|rollout-batch|reward|rule|feedback|gc|autonomy|context|index|doctor|report|runs|trigger-scan|writeback|evaluate|evaluate-dataset|audit|rank|frontier|decide|export|list
 *   pipeline traces list|show|tail | observability ui
 */

import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearConfigCache,
  loadConfigFromPath,
  validateConfig,
} from "../../../src/core/config.js";
import { executePipelineRun } from "../../../src/orchestration/pipeline-mcp-run.js";
import { getPipelineHomeDir } from "../../../src/core/paths.js";
import {
  openInBrowser,
  startConfigEditorServer,
} from "../../../src/pipeline/config-editor-server.js";
import {
  formatDoctorReport,
  formatLoopReadinessBadge,
  runDoctor,
} from "../../../src/pipeline/pipeline-doctor.js";
import {
  estimateLoopCost,
  formatLoopCostReport,
  type LoopCadence,
  type LoopCostLevel,
  type LoopPattern,
} from "../../../src/pipeline/pipeline-cost.js";
import { formatPipelineRunOutcomeHints } from "../../../src/pipeline/run-outcome-hints.js";
import {
  pipelineInit,
  type InitProfile,
} from "../../../src/pipeline/pipeline-init.js";
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
  harnessEvolveDoctor,
  harnessEvolveEvaluate,
  harnessEvolveEvaluateDataset,
  harnessEvolveEvaluateTaskSet,
  harnessEvolveExport,
  harnessEvolveFrontier,
  harnessEvolveAutonomy,
  harnessEvolveContext,
  harnessEvolveFeedback,
  harnessEvolveGc,
  harnessEvolveIndex,
  harnessEvolveList,
  harnessEvolveMine,
  harnessEvolvePaddock,
  harnessEvolvePropose,
  harnessEvolveEvolve,
  harnessEvolveRank,
  harnessEvolveRejected,
  harnessEvolveReplay,
  harnessEvolveReport,
  harnessEvolveReward,
  harnessEvolveRule,
  harnessEvolveRun,
  harnessEvolveRuns,
  harnessEvolveRolloutBatch,
  harnessEvolveSandbox,
  harnessEvolveSkillPatch,
  harnessEvolveTaskSet,
  harnessEvolveTaskSets,
  harnessEvolveTrainingExport,
  harnessEvolveTriggerScan,
  harnessEvolveTrajectory,
  harnessEvolveVerifier,
  harnessEvolveVerifiers,
  harnessEvolveWriteback,
} from "../../../src/pipeline/harness-evolve-cli.js";
import { runsList, runsShow } from "../../../src/pipeline/run-control-cli.js";
import {
  tracesList,
  tracesShow,
  tracesTail,
} from "../../../src/pipeline/trace-cli.js";
import type { PipelineStatus } from "../../../src/core/state.js";
import type { RunStatus } from "../../../src/orchestration/run-store.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const INIT_PROFILES = [
  "mock",
  "feature",
  "bugfix",
  "refactor",
  "cli-detected",
  "pr-babysitter",
  "race-pr-babysitter",
  "ci-sweeper",
  "daily-triage",
] as const;

function printHelp(): void {
  console.log(`runoff CLI

Usage:
  pipeline run --prompt <text> --work-dir <git-repo> [--config <path>]
  pipeline init --work-dir <dir> [--profile mock|feature|bugfix|refactor|cli-detected|pr-babysitter|race-pr-babysitter|ci-sweeper|daily-triage]
  pipeline doctor [--config <path>] [--cleanup-orphans] [--badge]
  pipeline cost [--config <path>] [--pattern pr-babysitter|ci-sweeper|daily-triage] [--cadence 5m|10m|15m|30m|1h|2h|1d] [--level L1|L2|L3] [--conservative] [--json]
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
	  pipeline harness verifier --verifier-kind <kind> --summary <text> [--verifier-id <id>] [--json]
	  pipeline harness verifiers [--limit <n>] [--json]
	  pipeline harness taskset --summary <name> [--taskset-id <id>] [--tasks-json <json>] [--trace-ids-json <json>] [--verifier-id <id>] [--json]
	  pipeline harness tasksets [--limit <n>] [--json]
	  pipeline harness trajectory --trace-id <id> [--candidate-id <id>] [--run-id <id>] [--json]
	  pipeline harness replay --trajectory-ids-json <json> [--replay-id <id>] [--json]
	  pipeline harness training-export --trajectory-ids-json <json> [--export-id <id>] [--taskset-id <id>] [--candidate-id <id>] [--format runoff_training_jsonl|dressage_compatible_jsonl] [--json]
	  pipeline harness paddock [--paddock-id <id>] [--kind local_cli|mcp_host|http_blackbox] [--protocol runoff_provider|openai_compatible|blackbox_http] [--summary <text>] [--command-json <json>] [--endpoint <url>] [--json]
	  pipeline harness sandbox [--lease-id <id>] [--candidate-id <id>] [--taskset-id <id>] [--spec-json <json>] [--release] [--json]
	  pipeline harness rollout-batch [--batch-id <id>] [--taskset-id <id>] [--candidate-id <id>] [--paddock-id <id>] [--sandbox-lease-ids-json <json>] [--candidate-trace-map-by-task-json <json>] [--reward-report-id <id>] [--complete] [--json]
	  pipeline harness reward [--reward-id <id>] [--kind verifier_score|binary_success|regression_delta|policy_safe|custom] [--summary <text>] [--taskset-id <id>] [--candidate-id <id>] [--reports] [--json]
	  pipeline harness rule [--rule-id <id>] [--kind coding_standard|qa_plan|review_rubric|lint_guidance|architecture_boundary|workflow] [--summary <text>] [--guidance <text>] [--applies-to-json <json>] [--triggers-json <json>] [--json]
	  pipeline harness feedback [--feedback-id <id>] [--trace-id <id>] [--candidate-id <id>] [--taskset-id <id>] [--manual-text <text>] [--rule-ids-json <json>] [--json]
	  pipeline harness gc [--report-id <id>] [--since <iso>] [--limit <n>] [--json]
	  pipeline harness autonomy [--policy-id <id>] [--summary <text>] [--action <name>] [--risk <n>] [--confidence <n>] [--decisions] [--json]
	  pipeline harness context [--topology-id <id>] [--summary <text>] [--context-nodes-json <json>] [--include-rules] [--changed-files-json <json>] [--routes] [--json]
	  pipeline harness index [--limit <n>] [--json]
	  pipeline harness doctor [--limit <n>] [--json]
	  pipeline harness skill-patch <candidateId> --base-skill <version> [--candidate-skill <version>] [--json]
	  pipeline harness rejected [<candidateId>] [--reason <text>] [--limit <n>] [--json]
	  pipeline harness create --summary <text> [--candidate-id <id>] [--source-dir <dir>] [--parent-candidate-ids-json <json>] [--dataset-ids-json <json>] [--json]
  pipeline harness propose --summary <text> [--candidate-id <id>] [--provider <name>] [--source-dir <dir>] [--instructions <text>] [--parent-candidate-ids-json <json>] [--dataset-ids-json <json>] [--json]
  pipeline harness run --summary <text> [--run-id <id>] [--candidate-id <id>] [--dataset-id <id>] [--frontier-id <id>] [--trace-ids-json <json>] [--candidate-trace-map-json <json>] [--export-on-accept] [--json]
  pipeline harness report <runId> [--json]
  pipeline harness runs [--limit <n>] [--json]
  pipeline harness trigger-scan --rules-json <json> [--scan-id <id>] [--json]
  pipeline harness writeback <runId> [--connectors-json <json>] [--json]
	  pipeline harness evaluate <candidateId> --pairs-json <json> [--json]
	  pipeline harness evaluate-dataset <candidateId> --dataset-id <id> --candidate-trace-map-json <json> [--json]
	  pipeline harness evaluate-taskset <candidateId> --taskset-id <id> --candidate-trace-map-by-task-json <json> [--json]
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
  npx runoff init --work-dir ../my-repo --profile pr-babysitter
  npx runoff doctor --config ../my-repo/pipeline.config.json
  npx runoff run --prompt "Add tests" --work-dir ../my-repo
  npx runoff mcp                # start MCP server (stdio)

Docs: docs/guides/host-loop-cookbook.md, docs/guides/getting-started-30min.md
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
  candidateId?: string;
  runId?: string;
  scanId?: string;
  sessionId?: string;
  winner?: number;
  reason?: string;
  summary?: string;
  datasetId?: string;
  taskSetId?: string;
  verifierId?: string;
  exportId?: string;
  paddockId?: string;
  leaseId?: string;
  batchId?: string;
  rewardId?: string;
  rewardReportId?: string;
  ruleId?: string;
  feedbackId?: string;
  reportId?: string;
  policyId?: string;
  decisionId?: string;
  topologyId?: string;
  routeId?: string;
  replayId?: string;
  frontierId?: string;
  sourceDir?: string;
  provider?: string;
  instructions?: string;
  iterations?: number;
  earlyStopThreshold?: number;
  reflectOnTrajectory?: boolean;
  editableSurfaceJson?: string;
  expectedFixesJson?: string;
  possibleRegressionsJson?: string;
  evidenceTraceIdsJson?: string;
  failureSignatureIdsJson?: string;
  parentCandidateIdsJson?: string;
  datasetIdsJson?: string;
  leakageTermsJson?: string;
  candidateTraceMapJson?: string;
  rolePolicyJson?: string;
  connectorsJson?: string;
  rulesJson?: string;
  tasksJson?: string;
  verifierKind?:
    | "command"
    | "file_diff"
    | "json_schema"
    | "trace_process"
    | "policy"
    | "llm_judge";
  paddockKind?: "local_cli" | "mcp_host" | "http_blackbox";
  paddockProtocol?: "runoff_provider" | "openai_compatible" | "blackbox_http";
  trainingFormat?: "runoff_training_jsonl" | "dressage_compatible_jsonl";
  rolloutMode?: "sync" | "async" | "partial";
  rewardKind?:
    | "verifier_score"
    | "binary_success"
    | "regression_delta"
    | "policy_safe"
    | "custom";
  ruleKind?:
    | "coding_standard"
    | "qa_plan"
    | "review_rubric"
    | "lint_guidance"
    | "architecture_boundary"
    | "workflow";
  defaultDecision?: "auto_continue" | "ask_approval" | "report_only";
  verifierCommandJson?: string;
  verifierIdsJson?: string;
  commandJson?: string;
  endpoint?: string;
  toolsetsJson?: string;
  capabilitiesJson?: string;
  headerNamesJson?: string;
  sandboxSpecJson?: string;
  sandboxLeaseIdsJson?: string;
  rewardRefsJson?: string;
  appliesToJson?: string;
  triggersJson?: string;
  ruleIdsJson?: string;
  autonomyRulesJson?: string;
  evidenceRefsJson?: string;
  contextNodesJson?: string;
  contextEdgesJson?: string;
  changedFilesJson?: string;
  guidance?: string;
  manualText?: string;
  autonomyAction?: string;
  risk?: number;
  confidence?: number;
  includeRules?: boolean;
  includeTaskSets?: boolean;
  decisions?: boolean;
  routes?: boolean;
  expectedFilesJson?: string;
  requiredTraceStatusesJson?: string;
  requiredStepNamesJson?: string;
  forbiddenPathsJson?: string;
  rubric?: string;
  candidateTraceMapByTaskJson?: string;
  baselineTraceMapByTaskJson?: string;
  trajectoryIdsJson?: string;
  baseSkill?: string;
  candidateSkill?: string;
  patchId?: string;
  maxFiles?: number;
  maxBytes?: number;
  selectionDelta?: number;
  regressionPassed?: boolean;
  policyPassed?: boolean;
  auditPassed?: boolean;
  accepted?: boolean;
  regressionFailuresJson?: string;
  reviewNotes?: string;
  pairsJson?: string;
  candidateIdsJson?: string;
  traceIdsJson?: string;
  decision?: "accept" | "rollback";
  since?: string;
  cleanupOrphans?: boolean;
  exportOnAccept?: boolean;
  release?: boolean;
  complete?: boolean;
  reports?: boolean;
  json?: boolean;
  postmortem?: boolean;
  once?: boolean;
  status?: PipelineStatus;
  runStatus?: RunStatus;
  sessionFilter?: string;
  limit?: number;
  heldInRatio?: number;
  cadence?: LoopCadence;
  pattern?: LoopPattern;
  level?: LoopCostLevel;
  conservative?: boolean;
  badge?: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { command: argv[0] ?? "help" };
  if (
    out.command === "config" ||
    out.command === "race" ||
    out.command === "runs" ||
    out.command === "harness" ||
    out.command === "traces" ||
    out.command === "observability"
  ) {
    out.sub = argv[1] ?? "help";
  }
  const multiSub =
    out.command === "config" ||
    out.command === "race" ||
    out.command === "runs" ||
    out.command === "harness" ||
    out.command === "traces" ||
    out.command === "observability";
  const start = multiSub ? 2 : 1;
  let positionalConsumed = 0;
  if (
    out.command === "runs" &&
    out.sub === "show" &&
    argv[2] &&
    !argv[2].startsWith("-")
  ) {
    out.traceId = argv[2];
    positionalConsumed = 1;
  }
  if (
    out.command === "harness" &&
    (out.sub === "evaluate" ||
      out.sub === "evaluate-dataset" ||
      out.sub === "evaluate-taskset" ||
      out.sub === "audit" ||
      out.sub === "decide" ||
      out.sub === "export" ||
      out.sub === "skill-patch" ||
      out.sub === "rejected") &&
    argv[2] &&
    !argv[2].startsWith("-")
  ) {
    out.traceId = argv[2];
    positionalConsumed = 1;
  }
  if (
    out.command === "harness" &&
    (out.sub === "report" || out.sub === "writeback") &&
    argv[2] &&
    !argv[2].startsWith("-")
  ) {
    out.runId = argv[2];
    positionalConsumed = 1;
  }
  if (
    out.command === "traces" &&
    out.sub === "show" &&
    argv[2] &&
    !argv[2].startsWith("-")
  ) {
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
        throw new Error(
          `--profile must be one of: ${INIT_PROFILES.join(", ")}`,
        );
      }
      out.profile = p as InitProfile;
    } else if (a === "--max-rounds") out.maxRounds = Number(next());
    else if (a === "--home") out.home = next();
    else if (a === "--port") out.port = Number(next());
    else if (a === "--no-open") out.noOpen = true;
    else if (a === "--trace-id") out.traceId = next();
    else if (a === "--run-id") out.runId = next();
    else if (a === "--scan-id") out.scanId = next();
    else if (a === "--candidate-id") {
      out.candidateId = next();
      out.traceId = out.traceId ?? out.candidateId;
    } else if (a === "--dataset-id") out.datasetId = next();
    else if (a === "--taskset-id" || a === "--task-set-id")
      out.taskSetId = next();
    else if (a === "--verifier-id") out.verifierId = next();
    else if (a === "--export-id") out.exportId = next();
    else if (a === "--paddock-id") out.paddockId = next();
    else if (a === "--lease-id") out.leaseId = next();
    else if (a === "--batch-id") out.batchId = next();
    else if (a === "--reward-id") out.rewardId = next();
    else if (a === "--reward-report-id") out.rewardReportId = next();
    else if (a === "--rule-id") out.ruleId = next();
    else if (a === "--feedback-id") out.feedbackId = next();
    else if (a === "--report-id") out.reportId = next();
    else if (a === "--policy-id") out.policyId = next();
    else if (a === "--decision-id") out.decisionId = next();
    else if (a === "--topology-id") out.topologyId = next();
    else if (a === "--route-id") out.routeId = next();
    else if (a === "--replay-id") out.replayId = next();
    else if (a === "--frontier-id") out.frontierId = next();
    else if (a === "--source-dir") out.sourceDir = next();
    else if (a === "--provider") out.provider = next();
    else if (a === "--instructions") out.instructions = next();
    else if (a === "--iterations") out.iterations = Number(next());
    else if (a === "--early-stop") out.earlyStopThreshold = Number(next());
    else if (a === "--reflect") out.reflectOnTrajectory = true;
    else if (a === "--no-reflect") out.reflectOnTrajectory = false;
    else if (a === "--editable-surface-json") out.editableSurfaceJson = next();
    else if (a === "--expected-fixes-json") out.expectedFixesJson = next();
    else if (a === "--possible-regressions-json")
      out.possibleRegressionsJson = next();
    else if (a === "--evidence-trace-ids-json")
      out.evidenceTraceIdsJson = next();
    else if (a === "--failure-signature-ids-json")
      out.failureSignatureIdsJson = next();
    else if (a === "--parent-candidate-ids-json")
      out.parentCandidateIdsJson = next();
    else if (a === "--dataset-ids-json") out.datasetIdsJson = next();
    else if (a === "--leakage-terms-json") out.leakageTermsJson = next();
    else if (a === "--candidate-trace-map-json")
      out.candidateTraceMapJson = next();
    else if (a === "--role-policy-json") out.rolePolicyJson = next();
    else if (a === "--connectors-json") out.connectorsJson = next();
    else if (a === "--rules-json") out.rulesJson = next();
    else if (a === "--tasks-json") out.tasksJson = next();
    else if (a === "--verifier-kind") {
      const kind = next();
      if (
        ![
          "command",
          "file_diff",
          "json_schema",
          "trace_process",
          "policy",
          "llm_judge",
        ].includes(kind)
      )
        throw new Error("--verifier-kind is invalid");
      out.verifierKind = kind as CliArgs["verifierKind"];
    } else if (a === "--kind") {
      const kind = next();
      if (["local_cli", "mcp_host", "http_blackbox"].includes(kind)) {
        out.paddockKind = kind as CliArgs["paddockKind"];
      } else if (
        [
          "verifier_score",
          "binary_success",
          "regression_delta",
          "policy_safe",
          "custom",
        ].includes(kind)
      ) {
        out.rewardKind = kind as CliArgs["rewardKind"];
      } else if (
        [
          "coding_standard",
          "qa_plan",
          "review_rubric",
          "lint_guidance",
          "architecture_boundary",
          "workflow",
        ].includes(kind)
      ) {
        out.ruleKind = kind as CliArgs["ruleKind"];
      } else {
        throw new Error("--kind is invalid");
      }
    } else if (a === "--protocol") {
      const protocol = next();
      if (
        !["runoff_provider", "openai_compatible", "blackbox_http"].includes(
          protocol,
        )
      )
        throw new Error("--protocol is invalid");
      out.paddockProtocol = protocol as CliArgs["paddockProtocol"];
    } else if (a === "--format") {
      const format = next();
      if (
        format !== "runoff_training_jsonl" &&
        format !== "dressage_compatible_jsonl"
      )
        throw new Error("--format is invalid");
      out.trainingFormat = format;
    } else if (a === "--mode") {
      const mode = next();
      if (mode !== "sync" && mode !== "async" && mode !== "partial")
        throw new Error("--mode is invalid");
      out.rolloutMode = mode;
    } else if (a === "--default-decision") {
      const decision = next();
      if (
        decision !== "auto_continue" &&
        decision !== "ask_approval" &&
        decision !== "report_only"
      )
        throw new Error("--default-decision is invalid");
      out.defaultDecision = decision;
    } else if (a === "--verifier-command-json")
      out.verifierCommandJson = next();
    else if (a === "--verifier-ids-json") out.verifierIdsJson = next();
    else if (a === "--command-json") out.commandJson = next();
    else if (a === "--endpoint") out.endpoint = next();
    else if (a === "--toolsets-json") out.toolsetsJson = next();
    else if (a === "--capabilities-json") out.capabilitiesJson = next();
    else if (a === "--header-names-json") out.headerNamesJson = next();
    else if (a === "--spec-json") out.sandboxSpecJson = next();
    else if (a === "--sandbox-lease-ids-json") out.sandboxLeaseIdsJson = next();
    else if (a === "--reward-refs-json") out.rewardRefsJson = next();
    else if (a === "--applies-to-json") out.appliesToJson = next();
    else if (a === "--triggers-json") out.triggersJson = next();
    else if (a === "--rule-ids-json") out.ruleIdsJson = next();
    else if (a === "--autonomy-rules-json") out.autonomyRulesJson = next();
    else if (a === "--evidence-refs-json") out.evidenceRefsJson = next();
    else if (a === "--context-nodes-json") out.contextNodesJson = next();
    else if (a === "--context-edges-json") out.contextEdgesJson = next();
    else if (a === "--changed-files-json") out.changedFilesJson = next();
    else if (a === "--guidance") out.guidance = next();
    else if (a === "--manual-text") out.manualText = next();
    else if (a === "--action") out.autonomyAction = next();
    else if (a === "--risk") out.risk = Number(next());
    else if (a === "--confidence") out.confidence = Number(next());
    else if (a === "--expected-files-json") out.expectedFilesJson = next();
    else if (a === "--required-trace-statuses-json")
      out.requiredTraceStatusesJson = next();
    else if (a === "--required-step-names-json")
      out.requiredStepNamesJson = next();
    else if (a === "--forbidden-paths-json") out.forbiddenPathsJson = next();
    else if (a === "--rubric") out.rubric = next();
    else if (a === "--candidate-trace-map-by-task-json")
      out.candidateTraceMapByTaskJson = next();
    else if (a === "--baseline-trace-map-by-task-json")
      out.baselineTraceMapByTaskJson = next();
    else if (a === "--trajectory-ids-json") out.trajectoryIdsJson = next();
    else if (a === "--base-skill") out.baseSkill = next();
    else if (a === "--candidate-skill") out.candidateSkill = next();
    else if (a === "--patch-id") out.patchId = next();
    else if (a === "--max-files") out.maxFiles = Number(next());
    else if (a === "--max-bytes") out.maxBytes = Number(next());
    else if (a === "--selection-delta") out.selectionDelta = Number(next());
    else if (a === "--regression-passed") out.regressionPassed = true;
    else if (a === "--policy-passed") out.policyPassed = true;
    else if (a === "--audit-passed") out.auditPassed = true;
    else if (a === "--accepted") out.accepted = true;
    else if (a === "--regression-failures-json")
      out.regressionFailuresJson = next();
    else if (a === "--review-notes") out.reviewNotes = next();
    else if (a === "--summary") out.summary = next();
    else if (a === "--pairs-json") out.pairsJson = next();
    else if (a === "--candidate-ids-json") out.candidateIdsJson = next();
    else if (a === "--trace-ids-json") out.traceIdsJson = next();
    else if (a === "--held-in-ratio") out.heldInRatio = Number(next());
    else if (a === "--since") out.since = next();
    else if (a === "--decision") {
      const decision = next();
      if (decision !== "accept" && decision !== "rollback")
        throw new Error("--decision must be accept or rollback");
      out.decision = decision;
    } else if (a === "--session") out.sessionId = next();
    else if (a === "--winner") out.winner = Number(next());
    else if (a === "--reason") out.reason = next();
    else if (a === "--cleanup-orphans") out.cleanupOrphans = true;
    else if (a === "--cadence") {
      const c = next() as LoopCadence;
      if (!["5m", "10m", "15m", "30m", "1h", "2h", "1d"].includes(c)) {
        throw new Error("--cadence must be 5m|10m|15m|30m|1h|2h|1d");
      }
      out.cadence = c;
    } else if (a === "--pattern") {
      const p = next() as LoopPattern;
      if (!["pr-babysitter", "ci-sweeper", "daily-triage", "custom"].includes(p)) {
        throw new Error("--pattern must be pr-babysitter|ci-sweeper|daily-triage|custom");
      }
      out.pattern = p;
    } else if (a === "--level") {
      const l = next().toUpperCase() as LoopCostLevel;
      if (!["L1", "L2", "L3"].includes(l)) {
        throw new Error("--level must be L1|L2|L3");
      }
      out.level = l;
    } else if (a === "--conservative") out.conservative = true;
    else if (a === "--badge") out.badge = true;
    else if (a === "--export-on-accept") out.exportOnAccept = true;
    else if (a === "--release") out.release = true;
    else if (a === "--complete") out.complete = true;
    else if (a === "--reports") out.reports = true;
    else if (a === "--include-rules") out.includeRules = true;
    else if (a === "--include-tasksets") out.includeTaskSets = true;
    else if (a === "--decisions") out.decisions = true;
    else if (a === "--routes") out.routes = true;
    else if (a === "--json") out.json = true;
    else if (a === "--postmortem") out.postmortem = true;
    else if (a === "--once") out.once = true;
    else if (a === "--status") {
      const status = next();
      if (out.command === "runs") out.runStatus = status as RunStatus;
      else out.status = status as PipelineStatus;
    } else if (a === "--session-id") out.sessionFilter = next();
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

  const configPath = resolve(
    args.config ?? join(workDir, "pipeline.config.json"),
  );
  if (!existsSync(configPath)) {
    throw new Error(
      `Config not found: ${configPath}\nRun: npm run pipeline:init -- --work-dir ${workDir}`,
    );
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

  console.log(
    formatPipelineRunOutcomeHints(result, { sessionId: result.checkpointFile }),
  );
  process.exit(result.status === "approved" ? 0 : 1);
}

function cmdInit(args: CliArgs): void {
  if (!args.workDir?.trim()) throw new Error("--work-dir is required");
  const profile = args.profile ?? "feature";
  const result = pipelineInit(args.workDir, profile);
  console.log("Created pipeline.config.json");
  console.log(`  path:    ${result.configPath}`);
  console.log(`  profile: ${result.profile}`);
  if (result.scaffoldedFiles.length) {
    console.log("\nScaffolded:");
    for (const file of result.scaffoldedFiles) {
      console.log(`  ${file}`);
    }
  }
  console.log("\nNext:");
  console.log(
    `  npm run pipeline:config:edit -- --config ${result.configPath}`,
  );
  console.log(`  npm run pipeline:doctor -- --config ${result.configPath}`);
  if (["pr-babysitter", "race-pr-babysitter", "ci-sweeper", "daily-triage"].includes(result.profile)) {
    console.log("  docs/guides/host-loop-cookbook.md — schedule the host loop");
  }
}

function cmdDoctor(args: CliArgs): void {
  const configPath = args.config ? resolve(args.config) : undefined;
  if (args.badge && !configPath) {
    throw new Error("--badge requires --config <path>");
  }
  const report = runDoctor({ configPath, cleanupOrphans: args.cleanupOrphans });
  if (args.badge) {
    if (!report.loopReadiness) {
      throw new Error("Loop readiness requires a valid --config path");
    }
    console.log(formatLoopReadinessBadge(report.loopReadiness));
    process.exit(report.loopReadiness.level === "L0" ? 2 : 0);
    return;
  }
  console.log(formatDoctorReport(report));
  process.exit(report.ok ? 0 : 1);
}

function cmdCost(args: CliArgs): void {
  const cadence = args.cadence ?? "15m";
  const configPath = args.config ? resolve(args.config) : undefined;
  const estimate = estimateLoopCost({
    pattern: args.pattern,
    cadence,
    level: args.level,
    configPath,
    conservative: args.conservative,
  });
  if (args.json) {
    console.log(JSON.stringify(estimate, null, 2));
    return;
  }
  console.log(formatLoopCostReport(estimate));
}

function cmdConfigValidate(args: CliArgs): void {
  const configPath = resolve(
    args.config ?? join(process.cwd(), "pipeline.config.json"),
  );
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
    if (!id)
      throw new Error("trace id required: pipeline traces show <traceId>");
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
  const configPath = resolve(
    args.config ?? join(process.cwd(), "pipeline.config.json"),
  );
  if (!existsSync(configPath))
    throw new Error(`Config not found: ${configPath}`);
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
    if (!args.traceId)
      throw new Error("run id required: pipeline runs show <runId>");
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

function parseJsonObject<T>(
  raw: string | undefined,
  name: string,
): T | undefined {
  if (!raw?.trim()) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${name} must be a JSON object`);
  return parsed as T;
}

async function cmdHarness(args: CliArgs): Promise<void> {
  if (args.home) process.env.RUNOFF_HOME = resolve(args.home);
  if (args.sub === "coreset") {
    harnessEvolveCoreset({
      limit: args.limit,
      since: args.since,
      json: args.json,
    });
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
      failureSignatureIds: parseJsonArray(
        args.failureSignatureIdsJson,
        "--failure-signature-ids-json",
      ),
      heldInRatio: args.heldInRatio,
      leakageTerms: parseJsonArray(
        args.leakageTermsJson,
        "--leakage-terms-json",
      ),
      json: args.json,
    });
    return;
  }
  if (args.sub === "verifier") {
    if (!args.verifierKind) throw new Error("--verifier-kind is required");
    if (!args.summary?.trim()) throw new Error("--summary is required");
    harnessEvolveVerifier({
      verifierId: args.verifierId,
      kind: args.verifierKind,
      summary: args.summary,
      command: parseJsonArray(
        args.verifierCommandJson,
        "--verifier-command-json",
      ),
      expectedFiles: parseJsonArray(
        args.expectedFilesJson,
        "--expected-files-json",
      ),
      requiredTraceStatuses: parseJsonArray(
        args.requiredTraceStatusesJson,
        "--required-trace-statuses-json",
      ),
      requiredStepNames: parseJsonArray(
        args.requiredStepNamesJson,
        "--required-step-names-json",
      ),
      forbiddenPaths: parseJsonArray(
        args.forbiddenPathsJson,
        "--forbidden-paths-json",
      ),
      rubric: args.rubric,
      json: args.json,
    });
    return;
  }
  if (args.sub === "verifiers") {
    harnessEvolveVerifiers({ limit: args.limit, json: args.json });
    return;
  }
  if (args.sub === "taskset") {
    if (!args.summary?.trim()) throw new Error("--summary is required");
    harnessEvolveTaskSet({
      taskSetId: args.taskSetId,
      name: args.summary,
      tasks: parseJsonArray(args.tasksJson, "--tasks-json"),
      traceIds: parseJsonArray(args.traceIdsJson, "--trace-ids-json"),
      verifierId: args.verifierId,
      heldInRatio: args.heldInRatio,
      leakageTerms: parseJsonArray(
        args.leakageTermsJson,
        "--leakage-terms-json",
      ),
      json: args.json,
    });
    return;
  }
  if (args.sub === "tasksets") {
    harnessEvolveTaskSets({ limit: args.limit, json: args.json });
    return;
  }
  if (args.sub === "trajectory") {
    if (!args.traceId) throw new Error("--trace-id is required");
    harnessEvolveTrajectory({
      traceId: args.traceId,
      runId: args.runId,
      skillVersion: args.baseSkill,
      json: args.json,
    });
    return;
  }
  if (args.sub === "replay") {
    harnessEvolveReplay({
      replayId: args.replayId,
      runId: args.runId,
      taskSetId: args.taskSetId,
      candidateId: args.candidateId ?? args.traceId,
      trajectoryIds: parseJsonArray(
        args.trajectoryIdsJson,
        "--trajectory-ids-json",
      ),
      json: args.json,
    });
    return;
  }
  if (args.sub === "training-export") {
    harnessEvolveTrainingExport({
      exportId: args.exportId,
      trajectoryIds: parseJsonArray(
        args.trajectoryIdsJson,
        "--trajectory-ids-json",
      ),
      taskSetId: args.taskSetId,
      candidateId: args.candidateId ?? args.traceId,
      format: args.trainingFormat,
      rewardRefs: parseJsonArray(args.rewardRefsJson, "--reward-refs-json"),
      limit: args.limit,
      json: args.json,
    });
    return;
  }
  if (args.sub === "paddock") {
    harnessEvolvePaddock({
      paddockId: args.paddockId,
      kind: args.paddockKind,
      protocol: args.paddockProtocol,
      summary: args.summary,
      command: parseJsonArray(args.commandJson, "--command-json"),
      endpoint: args.endpoint,
      toolsets: parseJsonArray(args.toolsetsJson, "--toolsets-json"),
      capabilities: parseJsonArray(
        args.capabilitiesJson,
        "--capabilities-json",
      ),
      headerNames: parseJsonArray(args.headerNamesJson, "--header-names-json"),
      limit: args.limit,
      json: args.json,
    });
    return;
  }
  if (args.sub === "sandbox") {
    harnessEvolveSandbox({
      leaseId: args.leaseId ?? args.traceId,
      candidateId: args.candidateId ?? args.traceId,
      taskSetId: args.taskSetId,
      spec: parseJsonObject(args.sandboxSpecJson, "--spec-json"),
      release: args.release,
      reason: args.reason,
      limit: args.limit,
      json: args.json,
    });
    return;
  }
  if (args.sub === "rollout-batch") {
    const candidateTraceMap = args.candidateTraceMapByTaskJson
      ? (JSON.parse(args.candidateTraceMapByTaskJson) as Record<string, string>)
      : {};
    harnessEvolveRolloutBatch({
      batchId: args.batchId ?? args.traceId,
      mode: args.rolloutMode,
      taskSetId: args.taskSetId,
      candidateId: args.candidateId ?? args.traceId,
      paddockId: args.paddockId,
      sandboxLeaseIds: parseJsonArray(
        args.sandboxLeaseIdsJson,
        "--sandbox-lease-ids-json",
      ),
      candidateTraceMap,
      trainingExportId: args.exportId,
      rewardReportId: args.rewardReportId,
      complete: args.complete,
      reason: args.reason,
      limit: args.limit,
      json: args.json,
    });
    return;
  }
  if (args.sub === "reward") {
    harnessEvolveReward({
      rewardId: args.rewardId,
      kind: args.rewardKind,
      summary: args.summary,
      sourceVerifierId: args.verifierId,
      rubric: args.rubric,
      taskSetId: args.taskSetId,
      candidateId: args.candidateId ?? args.traceId,
      rolloutBatchId: args.batchId,
      trainingExportId: args.exportId,
      reports: args.reports,
      limit: args.limit,
      json: args.json,
    });
    return;
  }
  if (args.sub === "rule") {
    harnessEvolveRule({
      ruleId: args.ruleId,
      kind: args.ruleKind,
      summary: args.summary,
      guidance: args.guidance,
      appliesTo: parseJsonArray(args.appliesToJson, "--applies-to-json"),
      triggers: parseJsonArray(args.triggersJson, "--triggers-json"),
      skillRef: args.baseSkill,
      verifierIds: parseJsonArray(args.verifierIdsJson, "--verifier-ids-json"),
      limit: args.limit,
      json: args.json,
    });
    return;
  }
  if (args.sub === "feedback") {
    harnessEvolveFeedback({
      feedbackId: args.feedbackId,
      traceId: args.traceId,
      candidateId: args.candidateId,
      taskSetId: args.taskSetId,
      manualText: args.manualText,
      ruleIds: parseJsonArray(args.ruleIdsJson, "--rule-ids-json"),
      limit: args.limit,
      json: args.json,
    });
    return;
  }
  if (args.sub === "gc") {
    harnessEvolveGc({
      reportId: args.reportId,
      since: args.since,
      limit: args.limit,
      json: args.json,
    });
    return;
  }
  if (args.sub === "autonomy") {
    harnessEvolveAutonomy({
      policyId: args.policyId,
      decisionId: args.decisionId,
      action: args.autonomyAction,
      summary: args.summary,
      defaultDecision: args.defaultDecision,
      rules: parseJsonArray(args.autonomyRulesJson, "--autonomy-rules-json"),
      risk: args.risk,
      confidence: args.confidence,
      candidateId: args.candidateId,
      runId: args.runId,
      evidenceRefs: parseJsonArray(
        args.evidenceRefsJson,
        "--evidence-refs-json",
      ),
      decisions: args.decisions,
      limit: args.limit,
      json: args.json,
    });
    return;
  }
  if (args.sub === "context") {
    harnessEvolveContext({
      topologyId: args.topologyId,
      routeId: args.routeId,
      summary: args.summary,
      nodes: parseJsonArray(args.contextNodesJson, "--context-nodes-json"),
      edges: parseJsonArray(args.contextEdgesJson, "--context-edges-json"),
      includeRules: args.includeRules,
      includeTaskSets: args.includeTaskSets,
      taskId: args.taskSetId,
      candidateId: args.candidateId,
      changedFiles: parseJsonArray(
        args.changedFilesJson,
        "--changed-files-json",
      ),
      routes: args.routes,
      limit: args.limit,
      json: args.json,
    });
    return;
  }
  if (args.sub === "index") {
    harnessEvolveIndex({ limit: args.limit, json: args.json });
    return;
  }
  if (args.sub === "doctor") {
    harnessEvolveDoctor({ limit: args.limit, json: args.json });
    return;
  }
  if (args.sub === "skill-patch") {
    if (!args.traceId)
      throw new Error(
        "candidate id required: pipeline harness skill-patch <candidateId>",
      );
    if (!args.baseSkill?.trim()) throw new Error("--base-skill is required");
    harnessEvolveSkillPatch({
      candidateId: args.traceId,
      baseSkill: args.baseSkill,
      candidateSkill: args.candidateSkill,
      patchId: args.patchId,
      maxFiles: args.maxFiles,
      maxBytes: args.maxBytes,
      selectionDelta: args.selectionDelta,
      regressionPassed: args.regressionPassed,
      policyPassed: args.policyPassed,
      auditPassed: args.auditPassed,
      accepted: args.accepted,
      reason: args.reason,
      json: args.json,
    });
    return;
  }
  if (args.sub === "rejected") {
    harnessEvolveRejected({
      candidateId: args.traceId,
      patchId: args.patchId,
      selectionDelta: args.selectionDelta,
      regressionFailures: parseJsonArray(
        args.regressionFailuresJson,
        "--regression-failures-json",
      ),
      rejectionReason: args.reason,
      reviewNotes: args.reviewNotes,
      limit: args.limit,
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
      editableSurface: parseJsonArray(
        args.editableSurfaceJson,
        "--editable-surface-json",
      ),
      expectedFixes: parseJsonArray(
        args.expectedFixesJson,
        "--expected-fixes-json",
      ),
      possibleRegressions: parseJsonArray(
        args.possibleRegressionsJson,
        "--possible-regressions-json",
      ),
      evidenceTraceIds: parseJsonArray(
        args.evidenceTraceIdsJson,
        "--evidence-trace-ids-json",
      ),
      failureSignatureIds: parseJsonArray(
        args.failureSignatureIdsJson,
        "--failure-signature-ids-json",
      ),
      parentCandidateIds: parseJsonArray(
        args.parentCandidateIdsJson,
        "--parent-candidate-ids-json",
      ),
      datasetIds: parseJsonArray(args.datasetIdsJson, "--dataset-ids-json"),
      json: args.json,
    });
    return;
  }
  if (args.sub === "propose") {
    if (!args.summary?.trim() && !args.traceId)
      throw new Error(
        "--summary is required unless --candidate-id targets an existing candidate",
      );
    const configPath = resolve(
      args.config ?? join(process.cwd(), "pipeline.config.json"),
    );
    if (!existsSync(configPath))
      throw new Error(`Config not found: ${configPath}`);
    await harnessEvolvePropose({
      configPath,
      candidateId: args.traceId,
      summary: args.summary ?? "Harness proposer candidate",
      sourceDir: args.sourceDir,
      provider: args.provider,
      instructions: args.instructions,
      editableSurface: parseJsonArray(
        args.editableSurfaceJson,
        "--editable-surface-json",
      ),
      expectedFixes: parseJsonArray(
        args.expectedFixesJson,
        "--expected-fixes-json",
      ),
      possibleRegressions: parseJsonArray(
        args.possibleRegressionsJson,
        "--possible-regressions-json",
      ),
      evidenceTraceIds: parseJsonArray(
        args.evidenceTraceIdsJson,
        "--evidence-trace-ids-json",
      ),
      failureSignatureIds: parseJsonArray(
        args.failureSignatureIdsJson,
        "--failure-signature-ids-json",
      ),
      parentCandidateIds: parseJsonArray(
        args.parentCandidateIdsJson,
        "--parent-candidate-ids-json",
      ),
      datasetIds: parseJsonArray(args.datasetIdsJson, "--dataset-ids-json"),
      json: args.json,
    });
    return;
  }
  if (args.sub === "evolve") {
    if (!args.summary?.trim() && !args.traceId)
      throw new Error(
        "--summary is required unless --candidate-id targets an existing candidate",
      );
    const configPath = resolve(
      args.config ?? join(process.cwd(), "pipeline.config.json"),
    );
    if (!existsSync(configPath))
      throw new Error(`Config not found: ${configPath}`);
    await harnessEvolveEvolve({
      configPath,
      candidateId: args.traceId,
      summary: args.summary ?? "Harness evolution candidate",
      sourceDir: args.sourceDir,
      provider: args.provider,
      instructions: args.instructions,
      iterations: args.iterations,
      earlyStopThreshold: args.earlyStopThreshold,
      reflectOnTrajectory: args.reflectOnTrajectory,
      editableSurface: parseJsonArray(
        args.editableSurfaceJson,
        "--editable-surface-json",
      ),
      expectedFixes: parseJsonArray(
        args.expectedFixesJson,
        "--expected-fixes-json",
      ),
      possibleRegressions: parseJsonArray(
        args.possibleRegressionsJson,
        "--possible-regressions-json",
      ),
      evidenceTraceIds: parseJsonArray(
        args.evidenceTraceIdsJson,
        "--evidence-trace-ids-json",
      ),
      failureSignatureIds: parseJsonArray(
        args.failureSignatureIdsJson,
        "--failure-signature-ids-json",
      ),
      parentCandidateIds: parseJsonArray(
        args.parentCandidateIdsJson,
        "--parent-candidate-ids-json",
      ),
      datasetIds: parseJsonArray(args.datasetIdsJson, "--dataset-ids-json"),
      json: args.json,
    });
    return;
  }
  if (args.sub === "run") {
    if (!args.summary?.trim()) throw new Error("--summary is required");
    const configPath = resolve(
      args.config ?? join(process.cwd(), "pipeline.config.json"),
    );
    if (!existsSync(configPath))
      throw new Error(`Config not found: ${configPath}`);
    const candidateTraceMap = args.candidateTraceMapJson
      ? (JSON.parse(args.candidateTraceMapJson) as Record<string, string>)
      : undefined;
    const candidateTraceMapByTask = args.candidateTraceMapByTaskJson
      ? (JSON.parse(args.candidateTraceMapByTaskJson) as Record<string, string>)
      : undefined;
    await harnessEvolveRun({
      runId: args.runId,
      configPath,
      candidateId: args.traceId,
      datasetId: args.datasetId,
      taskSetId: args.taskSetId,
      frontierId: args.frontierId,
      summary: args.summary,
      sourceDir: args.sourceDir,
      provider: args.provider,
      instructions: args.instructions,
      editableSurface: parseJsonArray(
        args.editableSurfaceJson,
        "--editable-surface-json",
      ),
      expectedFixes: parseJsonArray(
        args.expectedFixesJson,
        "--expected-fixes-json",
      ),
      possibleRegressions: parseJsonArray(
        args.possibleRegressionsJson,
        "--possible-regressions-json",
      ),
      traceIds: parseJsonArray(args.traceIdsJson, "--trace-ids-json"),
      failureSignatureIds: parseJsonArray(
        args.failureSignatureIdsJson,
        "--failure-signature-ids-json",
      ),
      leakageTerms: parseJsonArray(
        args.leakageTermsJson,
        "--leakage-terms-json",
      ),
      candidateTraceMap,
      candidateTraceMapByTask,
      rolePolicy: parseJsonObject(args.rolePolicyJson, "--role-policy-json"),
      connectors: parseJsonArray(args.connectorsJson, "--connectors-json"),
      baseSkill: args.baseSkill,
      candidateSkill: args.candidateSkill,
      exportOnAccept: args.exportOnAccept,
      json: args.json,
    });
    return;
  }
  if (args.sub === "report") {
    if (!args.runId)
      throw new Error("run id required: pipeline harness report <runId>");
    harnessEvolveReport({ runId: args.runId, json: args.json });
    return;
  }
  if (args.sub === "runs") {
    harnessEvolveRuns({ limit: args.limit, json: args.json });
    return;
  }
  if (args.sub === "trigger-scan") {
    harnessEvolveTriggerScan({
      scanId: args.scanId,
      rules: parseJsonArray(args.rulesJson, "--rules-json"),
      json: args.json,
    });
    return;
  }
  if (args.sub === "writeback") {
    if (!args.runId)
      throw new Error("run id required: pipeline harness writeback <runId>");
    harnessEvolveWriteback({
      runId: args.runId,
      targets: parseJsonArray(args.connectorsJson, "--connectors-json"),
      json: args.json,
    });
    return;
  }
  if (args.sub === "evaluate") {
    if (!args.traceId)
      throw new Error(
        "candidate id required: pipeline harness evaluate <candidateId>",
      );
    harnessEvolveEvaluate({
      candidateId: args.traceId,
      pairs: parseJsonArray(args.pairsJson, "--pairs-json"),
      json: args.json,
    });
    return;
  }
  if (args.sub === "evaluate-dataset") {
    if (!args.traceId)
      throw new Error(
        "candidate id required: pipeline harness evaluate-dataset <candidateId>",
      );
    if (!args.datasetId) throw new Error("--dataset-id is required");
    const candidateTraceMap = args.candidateTraceMapJson
      ? (JSON.parse(args.candidateTraceMapJson) as Record<string, string>)
      : {};
    harnessEvolveEvaluateDataset({
      candidateId: args.traceId,
      datasetId: args.datasetId,
      candidateTraceMap,
      json: args.json,
    });
    return;
  }
  if (args.sub === "evaluate-taskset") {
    if (!args.traceId)
      throw new Error(
        "candidate id required: pipeline harness evaluate-taskset <candidateId>",
      );
    if (!args.taskSetId) throw new Error("--taskset-id is required");
    const candidateTraceMap = args.candidateTraceMapByTaskJson
      ? (JSON.parse(args.candidateTraceMapByTaskJson) as Record<string, string>)
      : {};
    const baselineTraceMap = args.baselineTraceMapByTaskJson
      ? (JSON.parse(args.baselineTraceMapByTaskJson) as Record<string, string>)
      : undefined;
    harnessEvolveEvaluateTaskSet({
      candidateId: args.traceId,
      taskSetId: args.taskSetId,
      candidateTraceMap,
      baselineTraceMap,
      runId: args.runId,
      skillVersion: args.baseSkill,
      json: args.json,
    });
    return;
  }
  if (args.sub === "audit") {
    if (!args.traceId)
      throw new Error(
        "candidate id required: pipeline harness audit <candidateId>",
      );
    harnessEvolveAudit({
      candidateId: args.traceId,
      datasetId: args.datasetId,
      leakageTerms: parseJsonArray(
        args.leakageTermsJson,
        "--leakage-terms-json",
      ),
      json: args.json,
    });
    return;
  }
  if (args.sub === "rank") {
    harnessEvolveRank({
      candidateIds: parseJsonArray(
        args.candidateIdsJson,
        "--candidate-ids-json",
      ),
      json: args.json,
    });
    return;
  }
  if (args.sub === "frontier") {
    harnessEvolveFrontier({
      frontierId: args.frontierId,
      candidateIds: parseJsonArray(
        args.candidateIdsJson,
        "--candidate-ids-json",
      ),
      json: args.json,
    });
    return;
  }
  if (args.sub === "decide") {
    if (!args.traceId)
      throw new Error(
        "candidate id required: pipeline harness decide <candidateId>",
      );
    harnessEvolveDecide({
      candidateId: args.traceId,
      decision: args.decision,
      reason: args.reason,
      json: args.json,
    });
    return;
  }
  if (args.sub === "export") {
    if (!args.traceId)
      throw new Error(
        "candidate id required: pipeline harness export <candidateId>",
      );
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
  throw new Error(
    "Usage: pipeline harness coreset|mine|dataset|create|propose|run|index|doctor|report|runs|trigger-scan|writeback|evaluate|evaluate-dataset|audit|rank|frontier|decide|export|list",
  );
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
  const configPath = resolve(
    args.config ?? join(process.cwd(), "pipeline.config.json"),
  );
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
  if (args.command === "cost") {
    cmdCost(args);
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
