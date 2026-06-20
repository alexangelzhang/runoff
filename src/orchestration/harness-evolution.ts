/**
 * Harness evolution substrate.
 *
 * This is intentionally deterministic and local-first: it gives future
 * Self-Harness/RHO/HarnessX-style optimizers typed edit manifests, isolated
 * candidate variants, held-in/held-out regression gates, coreset selection,
 * pairwise self-preference ranking, and auditable accept/rollback records.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { LLMProvider, LLMResponse } from "../providers/types.js";
import { getHarnessEvolutionDir } from "../core/paths.js";
import type { PipelineTrace } from "../observability/trace.js";
import { loadTraceById, queryTraces } from "../observability/trace.js";
import { atomicWriteJson, readJsonFile, safePathSegment } from "./durable-io.js";
import { compareRegression, evaluatePipelineTrace, type RegressionTolerance } from "./harness.js";

export const HARNESS_EVOLUTION_SCHEMA = "runoff-harness-evolution-v1" as const;

export interface HarnessChangeManifest {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  candidateId: string;
  createdAt: string;
  summary: string;
  editableSurface: string[];
  expectedFixes: string[];
  possibleRegressions: string[];
  evidenceTraceIds: string[];
  failureSignatureIds: string[];
  author?: string;
}

export interface HarnessCandidateRecord {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  candidateId: string;
  createdAt: string;
  status: "proposed" | "accepted" | "rolled_back";
  manifest: HarnessChangeManifest;
  variant: {
    isolated: boolean;
    sourceDir?: string;
    variantDir: string;
  };
  proposal?: HarnessProposalResult;
  gate?: HarnessGateResult;
  ranking?: HarnessCandidateRank;
  decision?: HarnessDecisionRecord;
  lineage?: HarnessCandidateLineage;
  audit?: HarnessAuditReport;
}

export interface HarnessEvalPair {
  baselineTraceId: string;
  candidateTraceId: string;
  split: "held-in" | "held-out";
}

export interface HarnessEvalInput {
  candidateId: string;
  pairs: HarnessEvalPair[];
  tolerance?: RegressionTolerance;
}

export interface HarnessDatasetItem {
  itemId: string;
  split: "held-in" | "held-out";
  baselineTraceId: string;
  failureSignatureIds: string[];
  promptPreview: string;
  finalStatus: PipelineTrace["finalStatus"];
}

export interface HarnessDataset {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  datasetId: string;
  createdAt: string;
  name: string;
  description?: string;
  sourceTraceIds: string[];
  sourceFailureSignatureIds: string[];
  heldIn: HarnessDatasetItem[];
  heldOut: HarnessDatasetItem[];
  leakageTerms: string[];
}

export interface HarnessDatasetEvaluation {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  datasetId: string;
  candidateId: string;
  evaluatedAt: string;
  pairs: HarnessEvalPair[];
  missingBaselineTraceIds: string[];
  gate: HarnessGateResult;
}

export interface HarnessSplitGate {
  split: "held-in" | "held-out";
  total: number;
  passed: number;
  regressions: Array<{ baselineTraceId: string; candidateTraceId: string; message: string }>;
  improvements: Array<{ baselineTraceId: string; candidateTraceId: string; reason: string }>;
}

export interface HarnessGateResult {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  candidateId: string;
  evaluatedAt: string;
  accepted: boolean;
  reason: string;
  heldIn: HarnessSplitGate;
  heldOut: HarnessSplitGate;
}

export interface HarnessCoresetItem {
  traceId: string;
  difficulty: number;
  diversityKey: string;
  finalStatus: PipelineTrace["finalStatus"];
  promptPreview: string;
}

export type HarnessFailureCategory =
  | "step_error"
  | "race_failure"
  | "approval_rejected"
  | "max_rounds"
  | "aborted"
  | "missing_verification"
  | "terminal_failure";

export interface HarnessFailureSignature {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  signatureId: string;
  createdAt: string;
  category: HarnessFailureCategory;
  title: string;
  triggeringContext: string;
  agentActionPattern: string;
  suspectedHarnessSurface: string[];
  evidenceTraceIds: string[];
  suggestedEditableSurface: string[];
  suggestedExpectedFixes: string[];
  suggestedPossibleRegressions: string[];
  severity: number;
  traceCount: number;
}

export interface HarnessCandidateRank {
  candidateId: string;
  score: number;
  rank: number;
  preferenceWins: number;
  preferenceLosses: number;
  reasons: string[];
}

export interface HarnessCandidateLineage {
  candidateId: string;
  createdAt: string;
  parentCandidateIds: string[];
  failureSignatureIds: string[];
  datasetIds: string[];
  source: "manual" | "mined-signature" | "derived-candidate";
}

export interface HarnessFrontierEntry {
  candidateId: string;
  status: HarnessCandidateRecord["status"];
  rank?: number;
  score: number;
  accepted: boolean;
  gateAccepted: boolean;
  auditPassed: boolean;
  regressionCount: number;
  improvementCount: number;
  observedFileCount: number;
  parentCandidateIds: string[];
  reasons: string[];
}

export interface HarnessFrontier {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  frontierId: string;
  updatedAt: string;
  candidateIds: string[];
  entries: HarnessFrontierEntry[];
  rejectedCandidateIds: string[];
}

export type HarnessEvolutionRunStatus =
  | "planned"
  | "awaiting_candidate_traces"
  | "accepted"
  | "rolled_back"
  | "blocked"
  | "exported";

export interface HarnessEvolutionPlan {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  planId: string;
  createdAt: string;
  summary: string;
  traceIds: string[];
  failureSignatureIds: string[];
  datasetId: string;
  candidateId: string;
  frontierId: string;
  sourceDir?: string;
  provider?: string;
  editableSurface: string[];
  expectedFixes: string[];
  possibleRegressions: string[];
  leakageTerms: string[];
  instructions?: string;
  autoDecide: boolean;
  exportOnAccept: boolean;
}

export interface HarnessEvolutionRun {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  runId: string;
  plan: HarnessEvolutionPlan;
  startedAt: string;
  completedAt?: string;
  status: HarnessEvolutionRunStatus;
  coresetTraceIds: string[];
  failureSignatureIds: string[];
  dataset?: HarnessDataset;
  candidate?: HarnessCandidateRecord;
  evaluation?: HarnessDatasetEvaluation;
  audit?: HarnessAuditReport;
  ranks?: HarnessCandidateRank[];
  frontier?: HarnessFrontier;
  decision?: HarnessDecisionRecord;
  bundle?: HarnessPromotionBundle;
  missingCandidateTraceIds: string[];
  artifactRefs: string[];
  nextAction: string;
}

export interface HarnessEvolutionReport {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  runId: string;
  generatedAt: string;
  status: HarnessEvolutionRunStatus;
  summary: string;
  nextAction: string;
  planId: string;
  candidateId: string;
  datasetId: string;
  frontierId: string;
  gateAccepted?: boolean;
  auditPassed?: boolean;
  decision?: "accept" | "rollback";
  exportedBundleDir?: string;
  missingCandidateTraceIds: string[];
  artifactRefs: string[];
}

export interface HarnessDecisionRecord {
  candidateId: string;
  decision: "accept" | "rollback";
  decidedAt: string;
  reason: string;
  previousStatus: HarnessCandidateRecord["status"];
  acceptanceChecks: HarnessAcceptanceChecks;
}

export interface HarnessAcceptanceChecks {
  gateAccepted: boolean;
  proposalPresent: boolean;
  proposalClean: boolean;
  observedDiffPresent: boolean;
  noSurfaceViolations: boolean;
  noUnreportedFiles: boolean;
  noReportedButUnchangedFiles: boolean;
  auditPassed: boolean;
  accepted: boolean;
  reasons: string[];
}

export type HarnessAuditSeverity = "info" | "warning" | "blocker";

export interface HarnessAuditFinding {
  severity: HarnessAuditSeverity;
  rule: string;
  message: string;
  evidence: string[];
}

export interface HarnessAuditReport {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  auditId: string;
  candidateId: string;
  datasetId?: string;
  createdAt: string;
  passed: boolean;
  findings: HarnessAuditFinding[];
  checkedFiles: string[];
}

export interface HarnessProposalResult {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  candidateId: string;
  proposedAt: string;
  provider: string;
  model: string;
  prompt: string;
  summary: string;
  filesModified: string[];
  diffStat?: string;
  failed?: boolean;
  error?: string;
  surfaceViolations: string[];
  observedFilesModified: string[];
  observedDiffStat: string;
  unreportedFilesModified: string[];
  reportedButUnchangedFiles: string[];
  failureSignatureIds: string[];
  historyContextPath?: string;
}

export interface HarnessPromotionBundle {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  candidateId: string;
  exportedAt: string;
  bundleDir: string;
  filesDir: string;
  files: Array<{
    path: string;
    copied: boolean;
    sha256?: string;
    size?: number;
  }>;
  manifest: HarnessChangeManifest;
  proposal: HarnessProposalResult;
  gate: HarnessGateResult;
  decision: HarnessDecisionRecord;
  instructions: string[];
}

interface FileSnapshotEntry {
  hash: string;
  size: number;
}

interface VariantDiff {
  added: string[];
  modified: string[];
  deleted: string[];
  filesModified: string[];
  diffStat: string;
}

function evolutionDir(): string {
  return getHarnessEvolutionDir();
}

function candidatesDir(): string {
  return join(evolutionDir(), "candidates");
}

function signaturesDir(): string {
  return join(evolutionDir(), "failure-signatures");
}

function datasetsDir(): string {
  return join(evolutionDir(), "datasets");
}

function frontiersDir(): string {
  return join(evolutionDir(), "frontiers");
}

function runsDir(): string {
  return join(evolutionDir(), "runs");
}

function candidateDir(candidateId: string): string {
  return join(candidatesDir(), safePathSegment(candidateId));
}

function candidatePath(candidateId: string): string {
  return join(candidateDir(candidateId), "candidate.json");
}

function signaturePath(signatureId: string): string {
  return join(signaturesDir(), `${safePathSegment(signatureId)}.json`);
}

function datasetPath(datasetId: string): string {
  return join(datasetsDir(), `${safePathSegment(datasetId)}.json`);
}

function datasetEvaluationPath(datasetId: string, candidateId: string): string {
  return join(datasetsDir(), safePathSegment(datasetId), "evaluations", `${safePathSegment(candidateId)}.json`);
}

function frontierPath(frontierId = "default"): string {
  return join(frontiersDir(), `${safePathSegment(frontierId)}.json`);
}

function runDir(runId: string): string {
  return join(runsDir(), safePathSegment(runId));
}

function runPath(runId: string): string {
  return join(runDir(runId), "run.json");
}

function runPlanPath(runId: string): string {
  return join(runDir(runId), "plan.json");
}

function runReportPath(runId: string): string {
  return join(runDir(runId), "report.json");
}

function gatePath(candidateId: string): string {
  return join(candidateDir(candidateId), "gate.json");
}

function rankingPath(candidateId: string): string {
  return join(candidateDir(candidateId), "ranking.json");
}

function decisionPath(candidateId: string): string {
  return join(candidateDir(candidateId), "decision.json");
}

function proposalPath(candidateId: string): string {
  return join(candidateDir(candidateId), "proposal.json");
}

function promotionDir(candidateId: string): string {
  return join(candidateDir(candidateId), "promotion");
}

function auditPath(candidateId: string): string {
  return join(candidateDir(candidateId), "audit.json");
}

function variantDir(candidateId: string): string {
  return join(candidateDir(candidateId), "variant");
}

function normalizeSurfacePath(path: string): string {
  return normalize(path).replace(/\\/g, "/").replace(/^\.\//, "");
}

function snapshotVariantFiles(dir: string, prefix = ""): Map<string, FileSnapshotEntry> {
  const out = new Map<string, FileSnapshotEntry>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = normalizeSurfacePath(prefix ? join(prefix, name) : name);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      for (const [child, entry] of snapshotVariantFiles(abs, rel)) out.set(child, entry);
      continue;
    }
    if (!stat.isFile()) continue;
    const content = readFileSync(abs);
    out.set(rel, {
      hash: createHash("sha256").update(content).digest("hex"),
      size: stat.size,
    });
  }
  return out;
}

function copyPromotionFile(variantRoot: string, filesRoot: string, file: string): HarnessPromotionBundle["files"][number] {
  const normalized = normalizeSurfacePath(file);
  const source = resolve(variantRoot, normalized);
  const variantRootResolved = resolve(variantRoot);
  if (!source.startsWith(`${variantRootResolved}/`) && source !== variantRootResolved) {
    throw new Error(`Refusing to export file outside variant: ${file}`);
  }
  if (!existsSync(source)) return { path: normalized, copied: false };
  const stat = statSync(source);
  if (!stat.isFile()) return { path: normalized, copied: false };
  const target = join(filesRoot, normalized);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { force: true });
  const content = readFileSync(source);
  return {
    path: normalized,
    copied: true,
    sha256: createHash("sha256").update(content).digest("hex"),
    size: stat.size,
  };
}

function diffVariantSnapshots(before: Map<string, FileSnapshotEntry>, after: Map<string, FileSnapshotEntry>): VariantDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [file, entry] of after) {
    const previous = before.get(file);
    if (!previous) added.push(file);
    else if (previous.hash !== entry.hash || previous.size !== entry.size) modified.push(file);
  }
  for (const file of before.keys()) {
    if (!after.has(file)) deleted.push(file);
  }
  const sort = (files: string[]) => files.sort((a, b) => a.localeCompare(b));
  sort(added);
  sort(modified);
  sort(deleted);
  const filesModified = [...added, ...modified, ...deleted];
  const parts = [
    added.length ? `${added.length} added` : "",
    modified.length ? `${modified.length} modified` : "",
    deleted.length ? `${deleted.length} deleted` : "",
  ].filter(Boolean);
  return {
    added,
    modified,
    deleted,
    filesModified,
    diffStat: parts.length ? `${filesModified.length} files changed (${parts.join(", ")})` : "0 files changed",
  };
}

function isAllowedByEditableSurface(file: string, surface: string[]): boolean {
  if (!surface.length) return true;
  const normalizedFile = normalizeSurfacePath(file);
  return surface.some((entry) => {
    const normalizedEntry = normalizeSurfacePath(entry);
    if (normalizedEntry.endsWith("/")) return normalizedFile.startsWith(normalizedEntry);
    return normalizedFile === normalizedEntry || normalizedFile.startsWith(`${normalizedEntry}/`);
  });
}

function summarizeProviderResponse(response: LLMResponse): {
  model: string;
  summary: string;
  filesModified: string[];
  diffStat?: string;
  failed?: boolean;
  error?: string;
} {
  if (response.kind === "agent") {
    return {
      model: response.model,
      summary: response.summary,
      filesModified: response.filesModified,
      diffStat: response.diffStat,
      failed: response.failed,
      error: response.error,
    };
  }
  return {
    model: response.model,
    summary: response.explanation || response.content.slice(0, 500),
    filesModified: [],
    failed: response.failed,
    error: response.error,
  };
}

export function createHarnessCandidate(input: {
  candidateId?: string;
  summary: string;
  editableSurface?: string[];
  expectedFixes?: string[];
  possibleRegressions?: string[];
  evidenceTraceIds?: string[];
  failureSignatureIds?: string[];
  parentCandidateIds?: string[];
  datasetIds?: string[];
  sourceDir?: string;
  author?: string;
}): HarnessCandidateRecord {
  const candidateId = input.candidateId?.trim() || `harness-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const dir = candidateDir(candidateId);
  const vDir = variantDir(candidateId);
  mkdirSync(dir, { recursive: true });
  mkdirSync(vDir, { recursive: true });

  const sourceDir = input.sourceDir ? resolve(input.sourceDir) : undefined;
  if (sourceDir && existsSync(sourceDir)) {
    cpSync(sourceDir, vDir, { recursive: true, force: true });
  }

  const manifest: HarnessChangeManifest = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    candidateId,
    createdAt: now,
    summary: input.summary,
    editableSurface: input.editableSurface ?? [],
    expectedFixes: input.expectedFixes ?? [],
    possibleRegressions: input.possibleRegressions ?? [],
    evidenceTraceIds: input.evidenceTraceIds ?? [],
    failureSignatureIds: input.failureSignatureIds ?? [],
    author: input.author,
  };

  const record: HarnessCandidateRecord = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    candidateId,
    createdAt: now,
    status: "proposed",
    manifest,
    variant: {
      isolated: true,
      sourceDir,
      variantDir: vDir,
    },
    lineage: {
      candidateId,
      createdAt: now,
      parentCandidateIds: input.parentCandidateIds ?? [],
      failureSignatureIds: manifest.failureSignatureIds,
      datasetIds: input.datasetIds ?? [],
      source: manifest.failureSignatureIds.length ? "mined-signature" : input.parentCandidateIds?.length ? "derived-candidate" : "manual",
    },
  };
  atomicWriteJson(candidatePath(candidateId), record);
  atomicWriteJson(join(dir, "manifest.json"), manifest);
  return record;
}

function buildCandidateLineage(record: HarnessCandidateRecord, parentCandidateIds: string[] = [], datasetIds: string[] = []): HarnessCandidateLineage {
  return {
    candidateId: record.candidateId,
    createdAt: record.createdAt,
    parentCandidateIds,
    failureSignatureIds: record.manifest.failureSignatureIds,
    datasetIds,
    source: record.manifest.failureSignatureIds.length ? "mined-signature" : parentCandidateIds.length ? "derived-candidate" : "manual",
  };
}

export function loadHarnessCandidate(candidateId: string): HarnessCandidateRecord | undefined {
  return readJsonFile<HarnessCandidateRecord>(candidatePath(candidateId));
}

export function listHarnessCandidates(): HarnessCandidateRecord[] {
  if (!existsSync(candidatesDir())) return [];
  return readdirSync(candidatesDir())
    .flatMap((name) => {
      const record = readJsonFile<HarnessCandidateRecord>(join(candidatesDir(), name, "candidate.json"));
      return record ? [record] : [];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function buildHarnessHistoryContext(record: HarnessCandidateRecord): string | undefined {
  const signatures = record.manifest.failureSignatureIds.flatMap((id) => {
    const signature = loadHarnessFailureSignature(id);
    return signature ? [signature] : [];
  });
  const priorCandidates = listHarnessCandidates()
    .filter((candidate) => candidate.candidateId !== record.candidateId)
    .slice(0, 5)
    .map((candidate) => ({
      candidateId: candidate.candidateId,
      status: candidate.status,
      summary: candidate.manifest.summary,
      proposalFailed: candidate.proposal?.failed,
      gateAccepted: candidate.gate?.accepted,
      decision: candidate.decision?.decision,
      observedFilesModified: candidate.proposal?.observedFilesModified ?? [],
    }));
  const context = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    candidateId: record.candidateId,
    generatedAt: new Date().toISOString(),
    failureSignatures: signatures,
    priorCandidates,
  };
  const path = join(candidateDir(record.candidateId), "history-context.json");
  atomicWriteJson(path, context);
  return path;
}

function buildProposalPrompt(record: HarnessCandidateRecord, historyContextPath: string | undefined, extraInstructions?: string): string {
  const signatures = record.manifest.failureSignatureIds.flatMap((id) => {
    const signature = loadHarnessFailureSignature(id);
    return signature ? [signature] : [];
  });
  return [
    "You are proposing a harness candidate for runoff.",
    "Edit only inside the current isolated variant directory.",
    "Do not mutate the source repository or files outside the current working directory.",
    "Keep changes limited to the editable surface declared below.",
    "Before editing, inspect the harness history context if available.",
    "",
    "Manifest:",
    JSON.stringify(record.manifest, null, 2),
    "",
    "Failure signatures:",
    signatures.length ? JSON.stringify(signatures, null, 2) : "[]",
    "",
    "History context path:",
    historyContextPath ?? "(none)",
    "",
    "Additional instructions:",
    extraInstructions?.trim() || "Make the smallest harness change that satisfies the manifest.",
  ].join("\n");
}

export async function proposeHarnessCandidate(input: {
  candidateId?: string;
  provider: LLMProvider;
  summary?: string;
  sourceDir?: string;
  editableSurface?: string[];
  expectedFixes?: string[];
  possibleRegressions?: string[];
  evidenceTraceIds?: string[];
  failureSignatureIds?: string[];
  parentCandidateIds?: string[];
  datasetIds?: string[];
  instructions?: string;
}): Promise<{ candidate: HarnessCandidateRecord; proposal: HarnessProposalResult }> {
  const existing = input.candidateId ? loadHarnessCandidate(input.candidateId) : undefined;
  const candidate = existing ?? createHarnessCandidate({
    candidateId: input.candidateId,
    summary: input.summary ?? "Harness proposer candidate",
    sourceDir: input.sourceDir,
    editableSurface: input.editableSurface,
    expectedFixes: input.expectedFixes,
    possibleRegressions: input.possibleRegressions,
    evidenceTraceIds: input.evidenceTraceIds,
    failureSignatureIds: input.failureSignatureIds,
    parentCandidateIds: input.parentCandidateIds,
    datasetIds: input.datasetIds,
    author: "harness-proposer",
  });

  const historyContextPath = buildHarnessHistoryContext(candidate);
  const prompt = buildProposalPrompt(candidate, historyContextPath, input.instructions);
  const beforeSnapshot = snapshotVariantFiles(candidate.variant.variantDir);
  const response = await input.provider.execute({
    prompt,
    workDir: candidate.variant.variantDir,
    stepName: "harness-propose",
    round: 1,
  });
  const observedDiff = diffVariantSnapshots(beforeSnapshot, snapshotVariantFiles(candidate.variant.variantDir));
  const summary = summarizeProviderResponse(response);
  const reportedFiles = [...new Set(summary.filesModified.map(normalizeSurfacePath))].sort((a, b) => a.localeCompare(b));
  const observedFiles = observedDiff.filesModified;
  const changedFileSet = new Set([...reportedFiles, ...observedFiles]);
  const surfaceViolations = [...changedFileSet].filter(
    (file) => !isAllowedByEditableSurface(file, candidate.manifest.editableSurface),
  ).sort((a, b) => a.localeCompare(b));
  const observedFileSet = new Set(observedFiles);
  const reportedFileSet = new Set(reportedFiles);
  const unreportedFilesModified = observedFiles.filter((file) => !reportedFileSet.has(file));
  const reportedButUnchangedFiles = reportedFiles.filter((file) => !observedFileSet.has(file));
  const proposal: HarnessProposalResult = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    candidateId: candidate.candidateId,
    proposedAt: new Date().toISOString(),
    provider: input.provider.name,
    model: summary.model,
    prompt,
    summary: summary.summary,
    filesModified: reportedFiles,
    diffStat: summary.diffStat,
    failed: summary.failed || surfaceViolations.length > 0,
    error: surfaceViolations.length
      ? `proposal modified files outside editable surface: ${surfaceViolations.join(", ")}`
      : summary.error,
    surfaceViolations,
    observedFilesModified: observedFiles,
    observedDiffStat: observedDiff.diffStat,
    unreportedFilesModified,
    reportedButUnchangedFiles,
    failureSignatureIds: candidate.manifest.failureSignatureIds,
    historyContextPath,
  };

  const next: HarnessCandidateRecord = { ...candidate, proposal };
  atomicWriteJson(candidatePath(candidate.candidateId), next);
  atomicWriteJson(proposalPath(candidate.candidateId), proposal);
  return { candidate: next, proposal };
}

function traceDifficulty(trace: PipelineTrace): number {
  let score = 0;
  if (trace.finalStatus === "failed" || trace.finalStatus === "max_rounds") score += 5;
  if (trace.finalStatus === "aborted") score += 3;
  score += Math.min(3, trace.totalRounds);
  score += Math.min(3, trace.steps.filter((s) => s.error).length);
  score += Math.min(3, Math.floor(trace.totalDurationMs / 60_000));
  return score;
}

function diversityKey(trace: PipelineTrace): string {
  const providers = [...new Set(trace.steps.map((s) => s.provider))].sort().join("+") || "none";
  const words = trace.prompt.toLowerCase().match(/[a-z0-9_-]{4,}/g) ?? [];
  return `${trace.finalStatus}:${providers}:${words.slice(0, 3).join("-")}`;
}

function firstFailureStep(trace: PipelineTrace) {
  return trace.steps.find((step) => step.error || step.verdict === "needs_revision") ?? trace.steps.at(-1);
}

function failureCategory(trace: PipelineTrace): HarnessFailureCategory | undefined {
  if (trace.steps.some((step) => step.error)) return "step_error";
  if (trace.candidates?.some((candidate) => candidate.failed || candidate.error)) return "race_failure";
  if (trace.steps.some((step) => step.verdict === "needs_revision")) return "approval_rejected";
  if (trace.finalStatus === "max_rounds") return "max_rounds";
  if (trace.finalStatus === "aborted") return "aborted";
  if (!trace.hasVerifyResults && trace.finalStatus !== "approved") return "missing_verification";
  if (trace.finalStatus === "failed") return "terminal_failure";
  return undefined;
}

function suggestedSurfaceForCategory(category: HarnessFailureCategory): string[] {
  switch (category) {
    case "step_error":
    case "terminal_failure":
      return ["skill/", "docs/features/observability.md"];
    case "race_failure":
      return ["src/runtime/", "src/orchestration/"];
    case "approval_rejected":
      return ["skill/", "src/orchestration/observation.ts"];
    case "max_rounds":
      return ["skill/", "src/orchestration/pipeline-runner.ts"];
    case "aborted":
      return ["src/orchestration/", "src/runtime/"];
    case "missing_verification":
      return ["tests/", "skill/"];
  }
}

function signatureTitle(category: HarnessFailureCategory, trace: PipelineTrace): string {
  const step = firstFailureStep(trace);
  return `${category} in ${step?.name ?? trace.mode}`;
}

function signatureKey(category: HarnessFailureCategory, trace: PipelineTrace): string {
  const step = firstFailureStep(trace);
  const providers = [...new Set(trace.steps.map((s) => s.provider))].sort().join("+") || "none";
  return `${category}:${step?.name ?? "run"}:${providers}`;
}

function buildFailureSignature(key: string, traces: PipelineTrace[]): HarnessFailureSignature {
  const first = traces[0]!;
  const category = failureCategory(first) ?? "terminal_failure";
  const step = firstFailureStep(first);
  const errors = traces
    .flatMap((trace) => trace.steps.flatMap((s) => s.error ? [s.error] : []))
    .slice(0, 3);
  const signatureId = `sig-${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
  const surface = suggestedSurfaceForCategory(category);
  return {
    schema: HARNESS_EVOLUTION_SCHEMA,
    signatureId,
    createdAt: new Date().toISOString(),
    category,
    title: signatureTitle(category, first),
    triggeringContext: [
      `status=${first.finalStatus}`,
      `mode=${first.mode}`,
      `rounds=${first.totalRounds}`,
      `step=${step?.name ?? "unknown"}`,
      errors.length ? `errors=${errors.join(" | ")}` : "",
    ].filter(Boolean).join("; "),
    agentActionPattern: `providers=${[...new Set(traces.flatMap((trace) => trace.steps.map((s) => s.provider)))].sort().join("+") || "none"}`,
    suspectedHarnessSurface: surface,
    evidenceTraceIds: traces.map((trace) => trace.id),
    suggestedEditableSurface: surface,
    suggestedExpectedFixes: [`Reduce ${category} recurrence for ${step?.name ?? first.mode}`],
    suggestedPossibleRegressions: ["overfitting to mined failure traces", "extra prompt or runtime overhead"],
    severity: Math.min(10, Math.max(...traces.map(traceDifficulty)) + traces.length),
    traceCount: traces.length,
  };
}

export function mineHarnessFailureSignatures(input: {
  traceIds?: string[];
  limit?: number;
  since?: string;
} = {}): HarnessFailureSignature[] {
  const limit = Math.max(1, input.limit ?? 10);
  const traces = input.traceIds?.length
    ? input.traceIds.flatMap((id) => {
        const trace = loadTraceById(id);
        return trace ? [trace] : [];
      })
    : queryTraces({ since: input.since });
  const grouped = new Map<string, PipelineTrace[]>();
  for (const trace of traces) {
    const category = failureCategory(trace);
    if (!category) continue;
    const key = signatureKey(category, trace);
    const list = grouped.get(key) ?? [];
    list.push(trace);
    grouped.set(key, list);
  }
  const signatures = [...grouped.entries()]
    .map(([key, group]) => buildFailureSignature(key, group))
    .sort((a, b) => b.severity - a.severity || b.traceCount - a.traceCount)
    .slice(0, limit);
  mkdirSync(signaturesDir(), { recursive: true });
  for (const signature of signatures) atomicWriteJson(signaturePath(signature.signatureId), signature);
  return signatures;
}

export function loadHarnessFailureSignature(signatureId: string): HarnessFailureSignature | undefined {
  return readJsonFile<HarnessFailureSignature>(signaturePath(signatureId));
}

function datasetItem(trace: PipelineTrace, split: "held-in" | "held-out", signatures: HarnessFailureSignature[]): HarnessDatasetItem {
  const matching = signatures.filter((signature) => signature.evidenceTraceIds.includes(trace.id));
  return {
    itemId: `${split}-${trace.id}`,
    split,
    baselineTraceId: trace.id,
    failureSignatureIds: matching.map((signature) => signature.signatureId),
    promptPreview: trace.prompt.slice(0, 160),
    finalStatus: trace.finalStatus,
  };
}

export function createHarnessDataset(input: {
  datasetId?: string;
  name: string;
  description?: string;
  traceIds?: string[];
  failureSignatureIds?: string[];
  heldInRatio?: number;
  leakageTerms?: string[];
}): HarnessDataset {
  const traces = input.traceIds?.length
    ? input.traceIds.flatMap((id) => {
        const trace = loadTraceById(id);
        return trace ? [trace] : [];
      })
    : queryTraces({});
  const signatures = (input.failureSignatureIds ?? []).flatMap((id) => {
    const signature = loadHarnessFailureSignature(id);
    return signature ? [signature] : [];
  });
  const signatureTraceIds = signatures.flatMap((signature) => signature.evidenceTraceIds);
  const allTraceIds = [...new Set([...(input.traceIds ?? []), ...signatureTraceIds])];
  const selected = allTraceIds.length
    ? allTraceIds.flatMap((id) => {
        const trace = loadTraceById(id);
        return trace ? [trace] : [];
      })
    : traces;
  const sorted = selected.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const heldInRatio = Math.min(0.8, Math.max(0.2, input.heldInRatio ?? 0.6));
  const heldInCount = Math.max(1, Math.min(sorted.length - 1, Math.ceil(sorted.length * heldInRatio)));
  const heldInTraces = sorted.slice(0, heldInCount);
  const heldOutTraces = sorted.slice(heldInCount);
  const datasetId = input.datasetId?.trim() || `dataset-${randomUUID().slice(0, 8)}`;
  const dataset: HarnessDataset = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    datasetId,
    createdAt: new Date().toISOString(),
    name: input.name,
    description: input.description,
    sourceTraceIds: sorted.map((trace) => trace.id),
    sourceFailureSignatureIds: signatures.map((signature) => signature.signatureId),
    heldIn: heldInTraces.map((trace) => datasetItem(trace, "held-in", signatures)),
    heldOut: heldOutTraces.map((trace) => datasetItem(trace, "held-out", signatures)),
    leakageTerms: input.leakageTerms ?? [],
  };
  if (dataset.heldIn.length === 0 || dataset.heldOut.length === 0) {
    throw new Error("Harness dataset requires at least one held-in and one held-out trace");
  }
  mkdirSync(datasetsDir(), { recursive: true });
  atomicWriteJson(datasetPath(datasetId), dataset);
  return dataset;
}

export function loadHarnessDataset(datasetId: string): HarnessDataset | undefined {
  return readJsonFile<HarnessDataset>(datasetPath(datasetId));
}

export function evaluateHarnessDataset(input: {
  candidateId: string;
  datasetId: string;
  candidateTraceIdsByBaseline: Record<string, string>;
  tolerance?: RegressionTolerance;
}): HarnessDatasetEvaluation {
  const dataset = loadHarnessDataset(input.datasetId);
  if (!dataset) throw new Error(`Harness dataset not found: ${input.datasetId}`);
  const items = [...dataset.heldIn, ...dataset.heldOut];
  const missingBaselineTraceIds = items
    .filter((item) => !input.candidateTraceIdsByBaseline[item.baselineTraceId])
    .map((item) => item.baselineTraceId);
  if (missingBaselineTraceIds.length) {
    throw new Error(`Missing candidate traces for dataset baselines: ${missingBaselineTraceIds.join(", ")}`);
  }
  const pairs: HarnessEvalPair[] = items.map((item) => ({
    baselineTraceId: item.baselineTraceId,
    candidateTraceId: input.candidateTraceIdsByBaseline[item.baselineTraceId]!,
    split: item.split,
  }));
  const gate = evaluateHarnessCandidate({ candidateId: input.candidateId, pairs, tolerance: input.tolerance });
  const result: HarnessDatasetEvaluation = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    datasetId: input.datasetId,
    candidateId: input.candidateId,
    evaluatedAt: new Date().toISOString(),
    pairs,
    missingBaselineTraceIds,
    gate,
  };
  atomicWriteJson(datasetEvaluationPath(input.datasetId, input.candidateId), result);
  const record = loadHarnessCandidate(input.candidateId);
  if (record) {
    const lineage = record.lineage ?? buildCandidateLineage(record, [], [input.datasetId]);
    atomicWriteJson(candidatePath(input.candidateId), {
      ...record,
      lineage: { ...lineage, datasetIds: [...new Set([...lineage.datasetIds, input.datasetId])] },
    } satisfies HarnessCandidateRecord);
  }
  return result;
}

export function selectHarnessCoreset(input: {
  limit?: number;
  since?: string;
  traceIds?: string[];
} = {}): HarnessCoresetItem[] {
  const limit = Math.max(1, input.limit ?? 10);
  const traces = input.traceIds?.length
    ? input.traceIds.flatMap((id) => {
        const trace = loadTraceById(id);
        return trace ? [trace] : [];
      })
    : queryTraces({ since: input.since });

  const ranked = traces
    .map((trace) => ({
      trace,
      item: {
        traceId: trace.id,
        difficulty: traceDifficulty(trace),
        diversityKey: diversityKey(trace),
        finalStatus: trace.finalStatus,
        promptPreview: trace.prompt.slice(0, 160),
      } satisfies HarnessCoresetItem,
    }))
    .sort((a, b) => b.item.difficulty - a.item.difficulty || b.trace.timestamp.localeCompare(a.trace.timestamp));

  const selected: HarnessCoresetItem[] = [];
  const seenKeys = new Set<string>();
  for (const entry of ranked) {
    if (selected.length >= limit) break;
    if (seenKeys.has(entry.item.diversityKey) && selected.length < Math.ceil(limit / 2)) continue;
    selected.push(entry.item);
    seenKeys.add(entry.item.diversityKey);
  }
  for (const entry of ranked) {
    if (selected.length >= limit) break;
    if (!selected.some((item) => item.traceId === entry.item.traceId)) selected.push(entry.item);
  }
  return selected;
}

function improvementReason(candidate: PipelineTrace, baseline: PipelineTrace): string | undefined {
  const c = evaluatePipelineTrace(candidate);
  const b = evaluatePipelineTrace(baseline);
  if (c.success && !b.success) return "candidate succeeded where baseline failed";
  if (c.success === b.success && c.durationMs < b.durationMs) return "candidate reduced duration";
  if (c.success === b.success && c.roundCount < b.roundCount) return "candidate reduced rounds";
  return undefined;
}

function emptySplit(split: "held-in" | "held-out"): HarnessSplitGate {
  return { split, total: 0, passed: 0, regressions: [], improvements: [] };
}

export function evaluateHarnessCandidate(input: HarnessEvalInput): HarnessGateResult {
  const candidate = loadHarnessCandidate(input.candidateId);
  if (!candidate) throw new Error(`Harness candidate not found: ${input.candidateId}`);

  const bySplit: Record<"held-in" | "held-out", HarnessSplitGate> = {
    "held-in": emptySplit("held-in"),
    "held-out": emptySplit("held-out"),
  };

  for (const pair of input.pairs) {
    if (pair.split !== "held-in" && pair.split !== "held-out") {
      throw new Error(`Invalid harness eval split: ${String(pair.split)}`);
    }
    const baseline = loadTraceById(pair.baselineTraceId);
    const actual = loadTraceById(pair.candidateTraceId);
    if (!baseline || !actual) {
      bySplit[pair.split].regressions.push({
        baselineTraceId: pair.baselineTraceId,
        candidateTraceId: pair.candidateTraceId,
        message: !baseline ? "baseline trace missing" : "candidate trace missing",
      });
      bySplit[pair.split].total += 1;
      continue;
    }

    const split = bySplit[pair.split];
    split.total += 1;
    const reason = improvementReason(actual, baseline);
    if (reason) {
      split.passed += 1;
      split.improvements.push({ baselineTraceId: baseline.id, candidateTraceId: actual.id, reason });
      continue;
    }
    const regression = compareRegression(
      evaluatePipelineTrace(actual),
      evaluatePipelineTrace(baseline),
      input.tolerance,
    );
    if (regression.pass) {
      split.passed += 1;
    } else {
      split.regressions.push({
        baselineTraceId: baseline.id,
        candidateTraceId: actual.id,
        message: regression.message ?? "regression",
      });
    }
  }

  const heldIn = bySplit["held-in"];
  const heldOut = bySplit["held-out"];
  const regressionCount = heldIn.regressions.length + heldOut.regressions.length;
  const improvementCount = heldIn.improvements.length + heldOut.improvements.length;
  const hasBothSplits = heldIn.total > 0 && heldOut.total > 0;
  const accepted = hasBothSplits && regressionCount === 0 && improvementCount > 0;
  const reason = !hasBothSplits
    ? "held-in and held-out evidence are both required"
    : regressionCount > 0
      ? `${regressionCount} regression(s) detected`
      : improvementCount === 0
        ? "no measured improvement"
        : "passed held-in/held-out gate with measured improvement";

  const result: HarnessGateResult = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    candidateId: input.candidateId,
    evaluatedAt: new Date().toISOString(),
    accepted,
    reason,
    heldIn,
    heldOut,
  };

  const next: HarnessCandidateRecord = { ...candidate, gate: result };
  atomicWriteJson(candidatePath(input.candidateId), next);
  atomicWriteJson(gatePath(input.candidateId), result);
  return result;
}

function rankScore(record: HarnessCandidateRecord): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const gate = record.gate;
  if (!gate) {
    reasons.push("no gate result");
    return { score, reasons };
  }
  if (gate.accepted) {
    score += 100;
    reasons.push("gate accepted");
  } else {
    reasons.push(`gate rejected: ${gate.reason}`);
  }
  const improvementCount = gate.heldIn.improvements.length + gate.heldOut.improvements.length;
  const regressionCount = gate.heldIn.regressions.length + gate.heldOut.regressions.length;
  score += improvementCount * 10;
  score -= regressionCount * 25;
  score += gate.heldOut.passed * 3 + gate.heldIn.passed;
  if (record.manifest.expectedFixes.length) score += Math.min(5, record.manifest.expectedFixes.length);
  reasons.push(`${improvementCount} improvement(s), ${regressionCount} regression(s)`);
  return { score, reasons };
}

function readVariantTextFiles(record: HarnessCandidateRecord, files: string[]): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const file of files) {
    const normalized = normalizeSurfacePath(file);
    const abs = resolve(record.variant.variantDir, normalized);
    const root = resolve(record.variant.variantDir);
    if (!abs.startsWith(`${root}/`) && abs !== root) continue;
    if (!existsSync(abs)) continue;
    const stat = statSync(abs);
    if (!stat.isFile() || stat.size > 1_000_000) continue;
    const text = readFileSync(abs, "utf-8");
    out.push({ path: normalized, text });
  }
  return out;
}

function addFinding(findings: HarnessAuditFinding[], severity: HarnessAuditSeverity, rule: string, message: string, evidence: string[]): void {
  findings.push({ severity, rule, message, evidence });
}

export function auditHarnessCandidate(input: {
  candidateId: string;
  datasetId?: string;
  leakageTerms?: string[];
}): HarnessAuditReport {
  const record = loadHarnessCandidate(input.candidateId);
  if (!record) throw new Error(`Harness candidate not found: ${input.candidateId}`);
  const dataset = input.datasetId ? loadHarnessDataset(input.datasetId) : undefined;
  if (input.datasetId && !dataset) throw new Error(`Harness dataset not found: ${input.datasetId}`);
  const findings: HarnessAuditFinding[] = [];
  const proposal = record.proposal;
  if (!proposal) addFinding(findings, "blocker", "proposal-required", "candidate has no proposal", [record.candidateId]);
  if (proposal?.failed) addFinding(findings, "blocker", "proposal-failed", "proposal is marked failed", [proposal.error ?? "failed"]);
  if (proposal?.surfaceViolations.length) addFinding(findings, "blocker", "surface-violation", "proposal modified files outside editable surface", proposal.surfaceViolations);
  if (proposal?.unreportedFilesModified.length) addFinding(findings, "blocker", "unreported-files", "observed variant files were not reported by provider", proposal.unreportedFilesModified);
  if (proposal?.reportedButUnchangedFiles.length) addFinding(findings, "warning", "reported-unchanged-files", "provider reported files that did not change", proposal.reportedButUnchangedFiles);

  const changedFiles = proposal?.observedFilesModified ?? [];
  const texts = readVariantTextFiles(record, changedFiles);
  const terms = [
    ...(input.leakageTerms ?? []),
    ...(dataset?.leakageTerms ?? []),
    ...(dataset?.heldOut.flatMap((item) => [item.baselineTraceId, ...item.failureSignatureIds]) ?? []),
  ].filter((term) => term.length >= 4);
  for (const term of [...new Set(terms)]) {
    const matches = texts.filter((file) => file.text.includes(term)).map((file) => file.path);
    if (matches.length) {
      addFinding(findings, "blocker", "leakage-term", `candidate variant contains leakage term: ${term}`, matches);
    }
  }
  for (const file of changedFiles) {
    if (!isAllowedByEditableSurface(file, record.manifest.editableSurface)) {
      addFinding(findings, "blocker", "editable-surface", `changed file is outside editable surface: ${file}`, [file]);
    }
  }
  if (!changedFiles.length) addFinding(findings, "blocker", "empty-diff", "candidate has no observed variant diff", [record.candidateId]);

  const report: HarnessAuditReport = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    auditId: `audit-${record.candidateId}-${Date.now()}`,
    candidateId: record.candidateId,
    datasetId: input.datasetId,
    createdAt: new Date().toISOString(),
    passed: !findings.some((finding) => finding.severity === "blocker"),
    findings,
    checkedFiles: changedFiles,
  };
  atomicWriteJson(auditPath(record.candidateId), report);
  atomicWriteJson(candidatePath(record.candidateId), { ...record, audit: report } satisfies HarnessCandidateRecord);
  return report;
}

export function rankHarnessCandidates(candidateIds?: string[]): HarnessCandidateRank[] {
  const records = (candidateIds?.length ? candidateIds.flatMap((id) => {
    const record = loadHarnessCandidate(id);
    return record ? [record] : [];
  }) : listHarnessCandidates());

  const scored = records.map((record) => ({ record, ...rankScore(record), wins: 0, losses: 0 }));
  for (let i = 0; i < scored.length; i++) {
    for (let j = i + 1; j < scored.length; j++) {
      const left = scored[i]!;
      const right = scored[j]!;
      if (left.score === right.score) continue;
      if (left.score > right.score) {
        left.wins += 1;
        right.losses += 1;
      } else {
        right.wins += 1;
        left.losses += 1;
      }
    }
  }
  const ranks = scored
    .sort((a, b) => b.score - a.score || b.wins - a.wins || a.record.createdAt.localeCompare(b.record.createdAt))
    .map((item, index) => ({
      candidateId: item.record.candidateId,
      score: item.score,
      rank: index + 1,
      preferenceWins: item.wins,
      preferenceLosses: item.losses,
      reasons: item.reasons,
    }));

  for (const rank of ranks) {
    const record = loadHarnessCandidate(rank.candidateId);
    if (!record) continue;
    atomicWriteJson(candidatePath(rank.candidateId), { ...record, ranking: rank });
    atomicWriteJson(rankingPath(rank.candidateId), rank);
  }
  return ranks;
}

function frontierEntry(record: HarnessCandidateRecord): HarnessFrontierEntry {
  const gate = record.gate;
  const audit = record.audit;
  const score = rankScore(record);
  const regressionCount = gate ? gate.heldIn.regressions.length + gate.heldOut.regressions.length : 0;
  const improvementCount = gate ? gate.heldIn.improvements.length + gate.heldOut.improvements.length : 0;
  return {
    candidateId: record.candidateId,
    status: record.status,
    rank: record.ranking?.rank,
    score: score.score,
    accepted: record.status === "accepted",
    gateAccepted: gate?.accepted === true,
    auditPassed: audit?.passed === true,
    regressionCount,
    improvementCount,
    observedFileCount: record.proposal?.observedFilesModified.length ?? 0,
    parentCandidateIds: record.lineage?.parentCandidateIds ?? [],
    reasons: [
      ...score.reasons,
      audit ? (audit.passed ? "audit passed" : `audit blocked: ${audit.findings.filter((f) => f.severity === "blocker").length} blocker(s)`) : "no audit",
      record.status === "accepted" ? "accepted" : `status=${record.status}`,
    ],
  };
}

export function updateHarnessFrontier(input: {
  frontierId?: string;
  candidateIds?: string[];
} = {}): HarnessFrontier {
  const records = (input.candidateIds?.length ? input.candidateIds.flatMap((id) => {
    const record = loadHarnessCandidate(id);
    return record ? [record] : [];
  }) : listHarnessCandidates());
  const candidateIds = records.map((record) => record.candidateId);
  if (candidateIds.length) rankHarnessCandidates(candidateIds);
  const refreshed = candidateIds.flatMap((id) => {
    const record = loadHarnessCandidate(id);
    return record ? [record] : [];
  });
  const entries = refreshed
    .map(frontierEntry)
    .sort((a, b) => Number(b.accepted) - Number(a.accepted) || Number(b.auditPassed) - Number(a.auditPassed) || b.score - a.score);
  const frontier: HarnessFrontier = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    frontierId: input.frontierId ?? "default",
    updatedAt: new Date().toISOString(),
    candidateIds,
    entries,
    rejectedCandidateIds: entries.filter((entry) => !entry.accepted || !entry.auditPassed || !entry.gateAccepted).map((entry) => entry.candidateId),
  };
  mkdirSync(frontiersDir(), { recursive: true });
  atomicWriteJson(frontierPath(frontier.frontierId), frontier);
  return frontier;
}

function acceptanceChecks(record: HarnessCandidateRecord): HarnessAcceptanceChecks {
  const proposal = record.proposal;
  const audit = record.audit;
  const gateAccepted = record.gate?.accepted === true;
  const proposalPresent = proposal !== undefined;
  const proposalClean = proposalPresent && proposal.failed !== true;
  const observedDiffPresent = (proposal?.observedFilesModified.length ?? 0) > 0;
  const noSurfaceViolations = (proposal?.surfaceViolations.length ?? 0) === 0;
  const noUnreportedFiles = (proposal?.unreportedFilesModified.length ?? 0) === 0;
  const noReportedButUnchangedFiles = (proposal?.reportedButUnchangedFiles.length ?? 0) === 0;
  const auditPassed = audit?.passed === true;
  const reasons: string[] = [];
  if (!gateAccepted) reasons.push(record.gate ? `gate rejected: ${record.gate.reason}` : "missing held-in/held-out gate");
  if (!proposalPresent) reasons.push("missing proposal");
  if (proposalPresent && !proposalClean) reasons.push(proposal?.error ? `proposal failed: ${proposal.error}` : "proposal failed");
  if (proposalPresent && !observedDiffPresent) reasons.push("proposal has no observed variant diff");
  if (proposalPresent && !noSurfaceViolations) reasons.push(`surface violations: ${proposal.surfaceViolations.join(", ")}`);
  if (proposalPresent && !noUnreportedFiles) reasons.push(`unreported files: ${proposal.unreportedFilesModified.join(", ")}`);
  if (proposalPresent && !noReportedButUnchangedFiles) reasons.push(`reported but unchanged files: ${proposal.reportedButUnchangedFiles.join(", ")}`);
  if (!auditPassed) reasons.push(audit ? `audit blocked: ${audit.findings.filter((finding) => finding.severity === "blocker").length} blocker(s)` : "missing audit report");
  const accepted =
    gateAccepted &&
    proposalPresent &&
    proposalClean &&
    observedDiffPresent &&
    noSurfaceViolations &&
    noUnreportedFiles &&
    noReportedButUnchangedFiles &&
    auditPassed;
  if (accepted) reasons.push("proposal, audit, observed diff, and held-in/held-out gate accepted");
  return {
    gateAccepted,
    proposalPresent,
    proposalClean,
    observedDiffPresent,
    noSurfaceViolations,
    noUnreportedFiles,
    noReportedButUnchangedFiles,
    auditPassed,
    accepted,
    reasons,
  };
}

export function decideHarnessCandidate(input: {
  candidateId: string;
  decision?: "accept" | "rollback";
  reason?: string;
}): HarnessDecisionRecord {
  const record = loadHarnessCandidate(input.candidateId);
  if (!record) throw new Error(`Harness candidate not found: ${input.candidateId}`);
  const checks = acceptanceChecks(record);
  const autoDecision = checks.accepted ? "accept" : "rollback";
  const decision = input.decision ?? autoDecision;
  if (decision === "accept" && !checks.accepted) {
    throw new Error(`Harness candidate cannot be accepted: ${checks.reasons.join("; ")}`);
  }
  const nextStatus = decision === "accept" ? "accepted" : "rolled_back";
  const decisionRecord: HarnessDecisionRecord = {
    candidateId: input.candidateId,
    decision,
    decidedAt: new Date().toISOString(),
    reason: input.reason ?? (decision === "accept" ? "accepted by proposal, audit, observed diff, and regression gate" : checks.reasons.join("; ") || "rolled back without passing gate"),
    previousStatus: record.status,
    acceptanceChecks: checks,
  };
  atomicWriteJson(candidatePath(input.candidateId), {
    ...record,
    status: nextStatus,
    decision: decisionRecord,
  } satisfies HarnessCandidateRecord);
  atomicWriteJson(decisionPath(input.candidateId), decisionRecord);
  return decisionRecord;
}

export function exportHarnessPromotionBundle(input: {
  candidateId: string;
}): HarnessPromotionBundle {
  const record = loadHarnessCandidate(input.candidateId);
  if (!record) throw new Error(`Harness candidate not found: ${input.candidateId}`);
  if (record.status !== "accepted") throw new Error(`Harness candidate is not accepted: ${input.candidateId}`);
  if (!record.proposal) throw new Error(`Harness candidate has no proposal: ${input.candidateId}`);
  if (!record.gate) throw new Error(`Harness candidate has no gate result: ${input.candidateId}`);
  if (!record.decision) throw new Error(`Harness candidate has no decision record: ${input.candidateId}`);
  if (!record.decision.acceptanceChecks.accepted) {
    throw new Error(`Harness candidate acceptance checks are not passing: ${input.candidateId}`);
  }

  const dir = promotionDir(input.candidateId);
  const filesDir = join(dir, "files");
  mkdirSync(filesDir, { recursive: true });
  const files = record.proposal.observedFilesModified.map((file) => copyPromotionFile(record.variant.variantDir, filesDir, file));
  const bundle: HarnessPromotionBundle = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    candidateId: input.candidateId,
    exportedAt: new Date().toISOString(),
    bundleDir: dir,
    filesDir,
    files,
    manifest: record.manifest,
    proposal: record.proposal,
    gate: record.gate,
    decision: record.decision,
    instructions: [
      "Review this promotion bundle before applying anything to a user repository.",
      "Files under files/ are copied from the accepted candidate variant directory.",
      "This bundle is audit evidence only; runoff did not mutate the source repository.",
    ],
  };
  atomicWriteJson(join(dir, "bundle.json"), bundle);
  return bundle;
}

export function loadHarnessEvolutionRun(runId: string): HarnessEvolutionRun | undefined {
  return readJsonFile<HarnessEvolutionRun>(runPath(runId));
}

export function listHarnessEvolutionRuns(): HarnessEvolutionRun[] {
  if (!existsSync(runsDir())) return [];
  return readdirSync(runsDir())
    .flatMap((name) => {
      const run = readJsonFile<HarnessEvolutionRun>(join(runsDir(), name, "run.json"));
      return run ? [run] : [];
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function artifactRefsForRun(runId: string, plan: HarnessEvolutionPlan, includePromotion: boolean): string[] {
  const refs = [
    runPlanPath(runId),
    runPath(runId),
    runReportPath(runId),
    datasetPath(plan.datasetId),
    candidatePath(plan.candidateId),
    proposalPath(plan.candidateId),
    auditPath(plan.candidateId),
    gatePath(plan.candidateId),
    rankingPath(plan.candidateId),
    frontierPath(plan.frontierId),
    decisionPath(plan.candidateId),
  ];
  if (includePromotion) refs.push(join(promotionDir(plan.candidateId), "bundle.json"));
  return refs;
}

function buildHarnessEvolutionReport(run: HarnessEvolutionRun): HarnessEvolutionReport {
  return {
    schema: HARNESS_EVOLUTION_SCHEMA,
    runId: run.runId,
    generatedAt: new Date().toISOString(),
    status: run.status,
    summary: run.plan.summary,
    nextAction: run.nextAction,
    planId: run.plan.planId,
    candidateId: run.plan.candidateId,
    datasetId: run.plan.datasetId,
    frontierId: run.plan.frontierId,
    gateAccepted: run.evaluation?.gate.accepted,
    auditPassed: run.audit?.passed,
    decision: run.decision?.decision,
    exportedBundleDir: run.bundle?.bundleDir,
    missingCandidateTraceIds: run.missingCandidateTraceIds,
    artifactRefs: run.artifactRefs,
  };
}

function persistHarnessEvolutionRun(run: HarnessEvolutionRun): HarnessEvolutionRun {
  mkdirSync(runDir(run.runId), { recursive: true });
  atomicWriteJson(runPlanPath(run.runId), run.plan);
  atomicWriteJson(runPath(run.runId), run);
  atomicWriteJson(runReportPath(run.runId), buildHarnessEvolutionReport(run));
  return run;
}

function createHarnessEvolutionPlan(input: {
  runId: string;
  summary: string;
  traceIds?: string[];
  failureSignatureIds?: string[];
  datasetId?: string;
  candidateId?: string;
  frontierId?: string;
  sourceDir?: string;
  provider?: string;
  editableSurface?: string[];
  expectedFixes?: string[];
  possibleRegressions?: string[];
  leakageTerms?: string[];
  instructions?: string;
  autoDecide?: boolean;
  exportOnAccept?: boolean;
}): HarnessEvolutionPlan {
  return {
    schema: HARNESS_EVOLUTION_SCHEMA,
    planId: `plan-${input.runId}`,
    createdAt: new Date().toISOString(),
    summary: input.summary,
    traceIds: input.traceIds ?? [],
    failureSignatureIds: input.failureSignatureIds ?? [],
    datasetId: input.datasetId?.trim() || `dataset-${input.runId}`,
    candidateId: input.candidateId?.trim() || `candidate-${input.runId}`,
    frontierId: input.frontierId?.trim() || "default",
    sourceDir: input.sourceDir,
    provider: input.provider,
    editableSurface: input.editableSurface ?? [],
    expectedFixes: input.expectedFixes ?? [],
    possibleRegressions: input.possibleRegressions ?? [],
    leakageTerms: input.leakageTerms ?? [],
    instructions: input.instructions,
    autoDecide: input.autoDecide ?? true,
    exportOnAccept: input.exportOnAccept ?? false,
  };
}

export async function runHarnessEvolution(input: {
  runId?: string;
  summary: string;
  provider: LLMProvider;
  traceIds?: string[];
  failureSignatureIds?: string[];
  datasetId?: string;
  candidateId?: string;
  frontierId?: string;
  sourceDir?: string;
  editableSurface?: string[];
  expectedFixes?: string[];
  possibleRegressions?: string[];
  leakageTerms?: string[];
  instructions?: string;
  candidateTraceIdsByBaseline?: Record<string, string>;
  autoDecide?: boolean;
  exportOnAccept?: boolean;
}): Promise<HarnessEvolutionRun> {
  const runId = input.runId?.trim() || `run-${randomUUID().slice(0, 8)}`;
  const plan = createHarnessEvolutionPlan({ ...input, runId, provider: input.provider.name });
  const coreset = selectHarnessCoreset({ traceIds: plan.traceIds, limit: Math.max(2, plan.traceIds.length || 10) });
  const coresetTraceIds = coreset.map((item) => item.traceId);
  const mined = mineHarnessFailureSignatures({
    traceIds: plan.traceIds.length ? plan.traceIds : coresetTraceIds,
  });
  const failureSignatureIds = [...new Set([...plan.failureSignatureIds, ...mined.map((signature) => signature.signatureId)])];
  const datasetTraceIds = plan.traceIds.length ? plan.traceIds : coresetTraceIds;
  const dataset = createHarnessDataset({
    datasetId: plan.datasetId,
    name: plan.summary,
    traceIds: datasetTraceIds,
    failureSignatureIds,
    leakageTerms: plan.leakageTerms,
  });
  const proposal = await proposeHarnessCandidate({
    candidateId: plan.candidateId,
    provider: input.provider,
    summary: plan.summary,
    sourceDir: plan.sourceDir,
    editableSurface: plan.editableSurface,
    expectedFixes: plan.expectedFixes,
    possibleRegressions: plan.possibleRegressions,
    evidenceTraceIds: dataset.sourceTraceIds,
    failureSignatureIds,
    datasetIds: [plan.datasetId],
    instructions: plan.instructions,
  });
  const missingCandidateTraceIds = [...dataset.heldIn, ...dataset.heldOut]
    .map((item) => item.baselineTraceId)
    .filter((baselineTraceId) => !input.candidateTraceIdsByBaseline?.[baselineTraceId]);

  let evaluation: HarnessDatasetEvaluation | undefined;
  let audit: HarnessAuditReport | undefined;
  let ranks: HarnessCandidateRank[] | undefined;
  let frontier: HarnessFrontier | undefined;
  let decision: HarnessDecisionRecord | undefined;
  let bundle: HarnessPromotionBundle | undefined;
  let status: HarnessEvolutionRunStatus = "awaiting_candidate_traces";
  let nextAction = `provide candidateTraceIdsByBaseline for: ${missingCandidateTraceIds.join(", ")}`;

  if (!missingCandidateTraceIds.length) {
    evaluation = evaluateHarnessDataset({
      candidateId: plan.candidateId,
      datasetId: plan.datasetId,
      candidateTraceIdsByBaseline: input.candidateTraceIdsByBaseline ?? {},
    });
    audit = auditHarnessCandidate({ candidateId: plan.candidateId, datasetId: plan.datasetId, leakageTerms: plan.leakageTerms });
    ranks = rankHarnessCandidates([plan.candidateId]);
    frontier = updateHarnessFrontier({ frontierId: plan.frontierId, candidateIds: [plan.candidateId] });
    if (plan.autoDecide) {
      decision = decideHarnessCandidate({ candidateId: plan.candidateId });
      status = decision.decision === "accept" ? "accepted" : "rolled_back";
      nextAction = decision.decision === "accept" ? "review promotion bundle or export accepted candidate" : "inspect audit/gate findings and create a derived candidate";
      if (decision.decision === "accept" && plan.exportOnAccept) {
        bundle = exportHarnessPromotionBundle({ candidateId: plan.candidateId });
        status = "exported";
        nextAction = "review exported promotion bundle before applying outside runoff";
      }
    } else {
      status = audit.passed && evaluation.gate.accepted ? "planned" : "blocked";
      nextAction = "run decide after reviewing audit, gate, and frontier";
    }
  }

  const completed = status !== "awaiting_candidate_traces";
  const run: HarnessEvolutionRun = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    runId,
    plan,
    startedAt: plan.createdAt,
    completedAt: completed ? new Date().toISOString() : undefined,
    status,
    coresetTraceIds,
    failureSignatureIds,
    dataset,
    candidate: loadHarnessCandidate(plan.candidateId) ?? proposal.candidate,
    evaluation,
    audit,
    ranks,
    frontier,
    decision,
    bundle,
    missingCandidateTraceIds,
    artifactRefs: artifactRefsForRun(runId, plan, Boolean(bundle)),
    nextAction,
  };
  return persistHarnessEvolutionRun(run);
}

export function queryHarnessEvolutionReport(runId: string): HarnessEvolutionReport {
  const run = loadHarnessEvolutionRun(runId);
  if (!run) throw new Error(`Harness evolution run not found: ${runId}`);
  const report = buildHarnessEvolutionReport(run);
  atomicWriteJson(runReportPath(runId), report);
  return report;
}
