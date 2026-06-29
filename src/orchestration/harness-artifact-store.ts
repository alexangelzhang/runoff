/**
 * Shared harness artifact store.
 *
 * This module is the durable local control-plane boundary for harness
 * evolution artifacts. It owns paths, indexing, and health checks; callers own
 * the domain-specific records written into those paths.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, normalize, relative } from "node:path";
import { getHarnessEvolutionDir } from "../core/paths.js";
import { safePathSegment } from "./durable-io.js";

export const HARNESS_ARTIFACT_STORE_SCHEMA =
  "runoff-harness-artifact-store-v1" as const;

export type HarnessArtifactKind =
  | "candidate"
  | "failure_signature"
  | "dataset"
  | "dataset_evaluation"
  | "verifier"
  | "taskset"
  | "taskset_evaluation"
  | "frontier"
  | "run"
  | "trajectory"
  | "replay"
  | "rejected_buffer"
  | "training_export"
  | "paddock"
  | "sandbox"
  | "rollout_batch"
  | "reward_function"
  | "reward_report"
  | "trigger_event"
  | "trigger_scan"
  | "connector"
  | "rule"
  | "feedback"
  | "gc_report"
  | "autonomy_policy"
  | "autonomy_decision"
  | "context_topology"
  | "context_route"
  | "promotion_bundle";

export interface HarnessArtifactIndexEntry {
  kind: HarnessArtifactKind;
  artifactId: string;
  path: string;
  relativePath: string;
  sizeBytes: number;
  updatedAt: string;
  jsonStatus: "valid" | "invalid" | "not_json";
  schema?: string;
  errors: string[];
}

export interface HarnessArtifactIndex {
  schema: typeof HARNESS_ARTIFACT_STORE_SCHEMA;
  rootDir: string;
  generatedAt: string;
  limit: number;
  truncated: boolean;
  entries: HarnessArtifactIndexEntry[];
  countsByKind: Partial<Record<HarnessArtifactKind, number>>;
  invalidCount: number;
  missingCoreDirs: string[];
}

export interface HarnessArtifactDoctorReport {
  schema: typeof HARNESS_ARTIFACT_STORE_SCHEMA;
  checkedAt: string;
  rootDir: string;
  status: "ok" | "needs_attention";
  invalidCount: number;
  missingCoreDirs: string[];
  warnings: string[];
  nextAction:
    | "no_action"
    | "inspect_invalid_artifacts"
    | "initialize_harness_artifacts";
  index: HarnessArtifactIndex;
}

type ArtifactDescriptor = {
  kind: HarnessArtifactKind;
  dir: string;
  recursive?: boolean;
  idFromPath: (path: string) => string;
};

export function harnessRootDir(): string {
  return getHarnessEvolutionDir();
}

export function candidatesDir(): string {
  return join(harnessRootDir(), "candidates");
}

export function signaturesDir(): string {
  return join(harnessRootDir(), "failure-signatures");
}

export function datasetsDir(): string {
  return join(harnessRootDir(), "datasets");
}

export function verifiersDir(): string {
  return join(harnessRootDir(), "verifiers");
}

export function taskSetsDir(): string {
  return join(harnessRootDir(), "tasksets");
}

export function frontiersDir(): string {
  return join(harnessRootDir(), "frontiers");
}

export function runsDir(): string {
  return join(harnessRootDir(), "runs");
}

export function trajectoriesDir(): string {
  return join(harnessRootDir(), "trajectories");
}

export function replayDir(): string {
  return join(harnessRootDir(), "replay");
}

export function rejectedBufferDir(): string {
  return join(harnessRootDir(), "rejected-buffer");
}

export function trainingExportsDir(): string {
  return join(harnessRootDir(), "training-exports");
}

export function paddocksDir(): string {
  return join(harnessRootDir(), "paddocks");
}

export function sandboxesDir(): string {
  return join(harnessRootDir(), "sandboxes");
}

export function rolloutBatchesDir(): string {
  return join(harnessRootDir(), "rollout-batches");
}

export function rewardsDir(): string {
  return join(harnessRootDir(), "rewards");
}

export function triggersDir(): string {
  return join(harnessRootDir(), "triggers");
}

export function connectorsDir(): string {
  return join(harnessRootDir(), "connectors");
}

export function rulesDir(): string {
  return join(harnessRootDir(), "rules");
}

export function feedbackDir(): string {
  return join(harnessRootDir(), "feedback");
}

export function gcReportsDir(): string {
  return join(harnessRootDir(), "gc-reports");
}

export function autonomyDir(): string {
  return join(harnessRootDir(), "autonomy");
}

export function contextTopologyDir(): string {
  return join(harnessRootDir(), "context-topology");
}

export function candidateDir(candidateId: string): string {
  return join(candidatesDir(), safePathSegment(candidateId));
}

export function candidatePath(candidateId: string): string {
  return join(candidateDir(candidateId), "candidate.json");
}

export function variantDir(candidateId: string): string {
  return join(candidateDir(candidateId), "variant");
}

export function gatePath(candidateId: string): string {
  return join(candidateDir(candidateId), "gate.json");
}

export function rankingPath(candidateId: string): string {
  return join(candidateDir(candidateId), "ranking.json");
}

export function decisionPath(candidateId: string): string {
  return join(candidateDir(candidateId), "decision.json");
}

export function skillPatchPath(candidateId: string): string {
  return join(candidateDir(candidateId), "skill-patch.json");
}

export function proposalPath(candidateId: string): string {
  return join(candidateDir(candidateId), "proposal.json");
}

export function promotionDir(candidateId: string): string {
  return join(candidateDir(candidateId), "promotion");
}

export function auditPath(candidateId: string): string {
  return join(candidateDir(candidateId), "audit.json");
}

export function signaturePath(signatureId: string): string {
  return join(signaturesDir(), `${safePathSegment(signatureId)}.json`);
}

export function datasetPath(datasetId: string): string {
  return join(datasetsDir(), `${safePathSegment(datasetId)}.json`);
}

export function datasetEvaluationPath(
  datasetId: string,
  candidateId: string,
): string {
  return join(
    datasetsDir(),
    safePathSegment(datasetId),
    "evaluations",
    `${safePathSegment(candidateId)}.json`,
  );
}

export function verifierPath(verifierId: string): string {
  return join(verifiersDir(), `${safePathSegment(verifierId)}.json`);
}

export function taskSetPath(taskSetId: string): string {
  return join(taskSetsDir(), `${safePathSegment(taskSetId)}.json`);
}

export function taskSetEvaluationPath(
  taskSetId: string,
  candidateId: string,
): string {
  return join(
    taskSetsDir(),
    safePathSegment(taskSetId),
    "evaluations",
    `${safePathSegment(candidateId)}.json`,
  );
}

export function frontierPath(frontierId = "default"): string {
  return join(frontiersDir(), `${safePathSegment(frontierId)}.json`);
}

export function runDir(runId: string): string {
  return join(runsDir(), safePathSegment(runId));
}

export function runPath(runId: string): string {
  return join(runDir(runId), "run.json");
}

export function runPlanPath(runId: string): string {
  return join(runDir(runId), "plan.json");
}

export function runReportPath(runId: string): string {
  return join(runDir(runId), "report.json");
}

export function trajectoryPath(trajectoryId: string): string {
  return join(trajectoriesDir(), `${safePathSegment(trajectoryId)}.json`);
}

export function replayManifestPath(replayId: string): string {
  return join(replayDir(), `${safePathSegment(replayId)}.json`);
}

export function triggerEventPath(eventId: string): string {
  return join(triggersDir(), "events", `${safePathSegment(eventId)}.json`);
}

export function triggerScanPath(scanId: string): string {
  return join(triggersDir(), "scans", `${safePathSegment(scanId)}.json`);
}

export type HarnessConnectorKind = "local_jsonl" | "markdown";

export function connectorDefaultPath(
  runId: string,
  kind: HarnessConnectorKind,
): string {
  const extension = kind === "markdown" ? "md" : "jsonl";
  return join(connectorsDir(), `${safePathSegment(runId)}.${extension}`);
}

export function rejectedEntryPath(rejectedId: string): string {
  return join(rejectedBufferDir(), `${safePathSegment(rejectedId)}.json`);
}

export function trainingExportDir(exportId: string): string {
  return join(trainingExportsDir(), safePathSegment(exportId));
}

export function trainingExportPath(exportId: string): string {
  return join(trainingExportDir(exportId), "manifest.json");
}

export function trainingExportSamplesPath(exportId: string): string {
  return join(trainingExportDir(exportId), "samples.jsonl");
}

export function paddockPath(paddockId: string): string {
  return join(paddocksDir(), `${safePathSegment(paddockId)}.json`);
}

export function sandboxLeasePath(leaseId: string): string {
  return join(sandboxesDir(), `${safePathSegment(leaseId)}.json`);
}

export function rolloutBatchPath(batchId: string): string {
  return join(rolloutBatchesDir(), `${safePathSegment(batchId)}.json`);
}

export function rewardFunctionPath(rewardId: string): string {
  return join(rewardsDir(), "functions", `${safePathSegment(rewardId)}.json`);
}

export function rewardReportPath(reportId: string): string {
  return join(rewardsDir(), "reports", `${safePathSegment(reportId)}.json`);
}

export function rulePath(ruleId: string): string {
  return join(rulesDir(), `${safePathSegment(ruleId)}.json`);
}

export function feedbackPath(feedbackId: string): string {
  return join(feedbackDir(), `${safePathSegment(feedbackId)}.json`);
}

export function gcReportPath(reportId: string): string {
  return join(gcReportsDir(), `${safePathSegment(reportId)}.json`);
}

export function autonomyPolicyPath(policyId: string): string {
  return join(autonomyDir(), "policies", `${safePathSegment(policyId)}.json`);
}

export function autonomyDecisionPath(decisionId: string): string {
  return join(
    autonomyDir(),
    "decisions",
    `${safePathSegment(decisionId)}.json`,
  );
}

export function contextTopologyPath(topologyId: string): string {
  return join(
    contextTopologyDir(),
    "topologies",
    `${safePathSegment(topologyId)}.json`,
  );
}

export function contextRoutePath(routeId: string): string {
  return join(
    contextTopologyDir(),
    "routes",
    `${safePathSegment(routeId)}.json`,
  );
}

export function normalizeHarnessSurfacePath(path: string): string {
  return normalize(path).replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isHarnessSurfaceAllowed(file: string, surface: string[]): boolean {
  if (!surface.length) return true;
  const normalizedFile = normalizeHarnessSurfacePath(file);
  return surface.some((entry) => {
    const normalizedEntry = normalizeHarnessSurfacePath(entry);
    if (normalizedEntry.endsWith("/"))
      return normalizedFile.startsWith(normalizedEntry);
    return (
      normalizedFile === normalizedEntry ||
      normalizedFile.startsWith(`${normalizedEntry}/`)
    );
  });
}

function stripJsonExtension(name: string): string {
  return name.replace(/\.json$/, "");
}

function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(...listFilesRecursive(path));
      continue;
    }
    if (stat.isFile()) out.push(path);
  }
  return out;
}

function readSchema(path: string): {
  jsonStatus: HarnessArtifactIndexEntry["jsonStatus"];
  schema?: string;
  errors: string[];
} {
  if (!path.endsWith(".json")) return { jsonStatus: "not_json", errors: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      schema?: unknown;
    };
    return {
      jsonStatus: "valid",
      schema: typeof parsed.schema === "string" ? parsed.schema : undefined,
      errors: [],
    };
  } catch (error) {
    return {
      jsonStatus: "invalid",
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function descriptorEntries(): ArtifactDescriptor[] {
  return [
    {
      kind: "candidate",
      dir: candidatesDir(),
      recursive: true,
      idFromPath: (path) => path.split("/").at(-2) ?? stripJsonExtension(path),
    },
    {
      kind: "failure_signature",
      dir: signaturesDir(),
      idFromPath: stripJsonExtension,
    },
    { kind: "dataset", dir: datasetsDir(), idFromPath: stripJsonExtension },
    {
      kind: "dataset_evaluation",
      dir: datasetsDir(),
      recursive: true,
      idFromPath: stripJsonExtension,
    },
    { kind: "verifier", dir: verifiersDir(), idFromPath: stripJsonExtension },
    { kind: "taskset", dir: taskSetsDir(), idFromPath: stripJsonExtension },
    {
      kind: "taskset_evaluation",
      dir: taskSetsDir(),
      recursive: true,
      idFromPath: stripJsonExtension,
    },
    { kind: "frontier", dir: frontiersDir(), idFromPath: stripJsonExtension },
    {
      kind: "run",
      dir: runsDir(),
      recursive: true,
      idFromPath: (path) => path.split("/").at(-2) ?? stripJsonExtension(path),
    },
    {
      kind: "trajectory",
      dir: trajectoriesDir(),
      idFromPath: stripJsonExtension,
    },
    { kind: "replay", dir: replayDir(), idFromPath: stripJsonExtension },
    {
      kind: "rejected_buffer",
      dir: rejectedBufferDir(),
      idFromPath: stripJsonExtension,
    },
    {
      kind: "training_export",
      dir: trainingExportsDir(),
      recursive: true,
      idFromPath: (path) => path.split("/").at(-2) ?? stripJsonExtension(path),
    },
    { kind: "paddock", dir: paddocksDir(), idFromPath: stripJsonExtension },
    { kind: "sandbox", dir: sandboxesDir(), idFromPath: stripJsonExtension },
    {
      kind: "rollout_batch",
      dir: rolloutBatchesDir(),
      idFromPath: stripJsonExtension,
    },
    {
      kind: "reward_function",
      dir: join(rewardsDir(), "functions"),
      idFromPath: stripJsonExtension,
    },
    {
      kind: "reward_report",
      dir: join(rewardsDir(), "reports"),
      idFromPath: stripJsonExtension,
    },
    {
      kind: "trigger_event",
      dir: join(triggersDir(), "events"),
      idFromPath: stripJsonExtension,
    },
    {
      kind: "trigger_scan",
      dir: join(triggersDir(), "scans"),
      idFromPath: stripJsonExtension,
    },
    { kind: "connector", dir: connectorsDir(), idFromPath: stripJsonExtension },
    { kind: "rule", dir: rulesDir(), idFromPath: stripJsonExtension },
    { kind: "feedback", dir: feedbackDir(), idFromPath: stripJsonExtension },
    { kind: "gc_report", dir: gcReportsDir(), idFromPath: stripJsonExtension },
    {
      kind: "autonomy_policy",
      dir: join(autonomyDir(), "policies"),
      idFromPath: stripJsonExtension,
    },
    {
      kind: "autonomy_decision",
      dir: join(autonomyDir(), "decisions"),
      idFromPath: stripJsonExtension,
    },
    {
      kind: "context_topology",
      dir: join(contextTopologyDir(), "topologies"),
      idFromPath: stripJsonExtension,
    },
    {
      kind: "context_route",
      dir: join(contextTopologyDir(), "routes"),
      idFromPath: stripJsonExtension,
    },
  ];
}

function isDescriptorMatch(
  descriptor: ArtifactDescriptor,
  path: string,
): boolean {
  if (!descriptor.recursive) return path.endsWith(".json");
  if (descriptor.kind === "candidate")
    return /^candidates\/[^/]+\/candidate\.json$/.test(path);
  if (descriptor.kind === "run") return /^runs\/[^/]+\/run\.json$/.test(path);
  if (descriptor.kind === "training_export")
    return /^training-exports\/[^/]+\/manifest\.json$/.test(path);
  if (descriptor.kind === "dataset_evaluation")
    return path.includes("/evaluations/") && path.endsWith(".json");
  if (descriptor.kind === "taskset_evaluation")
    return path.includes("/evaluations/") && path.endsWith(".json");
  return path.endsWith(".json");
}

export function buildHarnessArtifactIndex(input: {
  limit?: number;
} = {}): HarnessArtifactIndex {
  const rootDir = harnessRootDir();
  const limit = Math.max(1, input.limit ?? 500);
  const entries: HarnessArtifactIndexEntry[] = [];
  for (const descriptor of descriptorEntries()) {
    const files = descriptor.recursive
      ? listFilesRecursive(descriptor.dir)
      : existsSync(descriptor.dir)
        ? readdirSync(descriptor.dir).map((name) => join(descriptor.dir, name))
        : [];
    for (const path of files) {
      if (entries.length >= limit) break;
      const rel = normalizeHarnessSurfacePath(relative(rootDir, path));
      if (!isDescriptorMatch(descriptor, rel)) continue;
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      const schema = readSchema(path);
      entries.push({
        kind: descriptor.kind,
        artifactId: descriptor.idFromPath(rel),
        path,
        relativePath: rel,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
        ...schema,
      });
    }
  }
  const countsByKind: Partial<Record<HarnessArtifactKind, number>> = {};
  for (const entry of entries) {
    countsByKind[entry.kind] = (countsByKind[entry.kind] ?? 0) + 1;
  }
  const coreDirs = [candidatesDir(), taskSetsDir(), verifiersDir(), rulesDir()];
  const missingCoreDirs = coreDirs
    .filter((dir) => !existsSync(dir))
    .map((dir) => normalizeHarnessSurfacePath(relative(rootDir, dir)));
  return {
    schema: HARNESS_ARTIFACT_STORE_SCHEMA,
    rootDir,
    generatedAt: new Date().toISOString(),
    limit,
    truncated: entries.length >= limit,
    entries,
    countsByKind,
    invalidCount: entries.filter((entry) => entry.jsonStatus === "invalid")
      .length,
    missingCoreDirs,
  };
}

export function doctorHarnessArtifactStore(input: {
  limit?: number;
} = {}): HarnessArtifactDoctorReport {
  const index = buildHarnessArtifactIndex({ limit: input.limit });
  const warnings = [
    ...index.entries
      .filter((entry) => entry.jsonStatus === "invalid")
      .map((entry) => `invalid json: ${entry.relativePath}`),
  ];
  const nextAction = index.invalidCount
    ? "inspect_invalid_artifacts"
    : index.missingCoreDirs.length
      ? "initialize_harness_artifacts"
      : "no_action";
  return {
    schema: HARNESS_ARTIFACT_STORE_SCHEMA,
    checkedAt: new Date().toISOString(),
    rootDir: index.rootDir,
    status: index.invalidCount ? "needs_attention" : "ok",
    invalidCount: index.invalidCount,
    missingCoreDirs: index.missingCoreDirs,
    warnings,
    nextAction,
    index,
  };
}
