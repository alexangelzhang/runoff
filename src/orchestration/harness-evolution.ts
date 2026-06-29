/**
 * Harness evolution substrate.
 *
 * This is intentionally deterministic and local-first: it gives future
 * Self-Harness/RHO/HarnessX-style optimizers typed edit manifests, isolated
 * candidate variants, held-in/held-out regression gates, coreset selection,
 * pairwise self-preference ranking, and auditable accept/rollback records.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { LLMProvider, LLMResponse } from "../providers/types.js";
import { getTracesDir } from "../core/paths.js";
import type { PipelineTrace } from "../observability/trace.js";
import { loadTraceById, queryTraces } from "../observability/trace.js";
import {
  atomicWriteJson,
  readJsonFile,
  safePathSegment,
} from "./durable-io.js";
import {
  auditPath,
  buildHarnessArtifactIndex,
  candidateDir,
  candidatePath,
  candidatesDir,
  connectorDefaultPath,
  connectorsDir,
  datasetEvaluationPath,
  datasetPath,
  datasetsDir,
  decisionPath,
  doctorHarnessArtifactStore,
  frontierPath,
  frontiersDir,
  gatePath,
  isHarnessSurfaceAllowed,
  normalizeHarnessSurfacePath,
  paddockPath,
  paddocksDir,
  promotionDir,
  proposalPath,
  rankingPath,
  rejectedBufferDir,
  rejectedEntryPath,
  replayDir,
  replayManifestPath,
  rewardFunctionPath,
  rewardReportPath,
  rewardsDir,
  rolloutBatchPath,
  rolloutBatchesDir,
  runDir,
  runPath,
  runPlanPath,
  runReportPath,
  runsDir,
  sandboxLeasePath,
  sandboxesDir,
  signaturePath,
  signaturesDir,
  skillPatchPath,
  taskSetEvaluationPath,
  taskSetPath,
  taskSetsDir,
  trainingExportDir,
  trainingExportPath,
  trainingExportsDir,
  trainingExportSamplesPath,
  trajectoriesDir,
  trajectoryPath,
  triggerEventPath,
  triggersDir,
  triggerScanPath,
  variantDir,
  verifierPath,
  verifiersDir,
  type HarnessArtifactDoctorReport,
  type HarnessArtifactIndex,
} from "./harness-artifact-store.js";
import {
  compareRegression,
  evaluatePipelineTrace,
  type RegressionTolerance,
} from "./harness.js";

export const HARNESS_EVOLUTION_SCHEMA = "runoff-harness-evolution-v1" as const;

export {
  compileHarnessFeedback,
  createHarnessContextTopology,
  decideHarnessAutonomy,
  listHarnessAutonomyDecisions,
  listHarnessAutonomyPolicies,
  listHarnessContextRoutes,
  listHarnessContextTopologies,
  listHarnessFeedback,
  listHarnessGcReports,
  listHarnessRules,
  loadHarnessAutonomyPolicy,
  loadHarnessContextTopology,
  loadHarnessRule,
  registerHarnessAutonomyPolicy,
  registerHarnessRule,
  routeHarnessContext,
  runHarnessGcLoop,
  type HarnessAutonomyDecision,
  type HarnessAutonomyPolicy,
  type HarnessCompiledFeedback,
  type HarnessContextNode,
  type HarnessContextRoute,
  type HarnessContextTopology,
  type HarnessGcDebtItem,
  type HarnessGcReport,
  type HarnessRule,
  type HarnessRuleKind,
} from "./harness-operating-layer.js";
export {
  buildHarnessArtifactIndex,
  doctorHarnessArtifactStore,
  type HarnessArtifactDoctorReport,
  type HarnessArtifactIndex,
} from "./harness-artifact-store.js";

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

export type HarnessVerifierKind =
  | "command"
  | "file_diff"
  | "json_schema"
  | "trace_process"
  | "policy"
  | "llm_judge";

export interface HarnessVerifier {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  verifierId: string;
  createdAt: string;
  kind: HarnessVerifierKind;
  summary: string;
  command?: string[];
  expectedFiles?: string[];
  requiredTraceStatuses?: PipelineTrace["finalStatus"][];
  requiredStepNames?: string[];
  forbiddenPaths?: string[];
  rubric?: string;
}

export interface HarnessTask {
  taskId: string;
  prompt: string;
  fixture?: string;
  toolsets: string[];
  verifierId: string;
  timeoutSec: number;
  budget?: {
    maxRounds?: number;
    maxToolCalls?: number;
    maxCostUsd?: number;
  };
  forbiddenPaths: string[];
  expectedArtifacts: string[];
  criticality: "selection" | "critical-regression" | "exploratory";
  policyBoundary?: string;
  sourceTraceId?: string;
}

export interface HarnessTaskSet {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  taskSetId: string;
  createdAt: string;
  name: string;
  description?: string;
  tasks: HarnessTask[];
  selectionTaskIds: string[];
  regressionTaskIds: string[];
  leakageTerms: string[];
}

export interface HarnessVerifierResult {
  verifierId: string;
  kind: HarnessVerifierKind;
  passed: boolean;
  score: number;
  reason: string;
  evidence: string[];
}

export interface HarnessTaskRunResult {
  taskId: string;
  baselineTraceId?: string;
  candidateTraceId?: string;
  completed: boolean;
  score: number;
  verifier: HarnessVerifierResult;
  trajectoryId?: string;
  replayId?: string;
}

export interface HarnessTaskSetEvaluation {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  taskSetId: string;
  candidateId: string;
  evaluatedAt: string;
  results: HarnessTaskRunResult[];
  selectionDelta: number;
  regressionPassed: boolean;
  policyPassed: boolean;
  accepted: boolean;
  reason: string;
}

export interface HarnessSplitGate {
  split: "held-in" | "held-out";
  total: number;
  passed: number;
  regressions: Array<{
    baselineTraceId: string;
    candidateTraceId: string;
    message: string;
  }>;
  improvements: Array<{
    baselineTraceId: string;
    candidateTraceId: string;
    reason: string;
  }>;
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
  taskSetId?: string;
  candidateId: string;
  frontierId: string;
  sourceDir?: string;
  provider?: string;
  editableSurface: string[];
  expectedFixes: string[];
  possibleRegressions: string[];
  leakageTerms: string[];
  instructions?: string;
  triggerEventId?: string;
  rolePolicy?: HarnessRolePolicy;
  connectors: HarnessConnectorTarget[];
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
  taskSet?: HarnessTaskSet;
  taskSetEvaluation?: HarnessTaskSetEvaluation;
  candidate?: HarnessCandidateRecord;
  evaluation?: HarnessDatasetEvaluation;
  audit?: HarnessAuditReport;
  ranks?: HarnessCandidateRank[];
  frontier?: HarnessFrontier;
  triggerEvent?: HarnessTriggerEvent;
  roleEvidence?: HarnessRoleEvidence;
  connectorWritebacks?: HarnessConnectorWriteback[];
  decision?: HarnessDecisionRecord;
  skillPatch?: HarnessSkillPatchDecision;
  bundle?: HarnessPromotionBundle;
  trajectories?: HarnessTrajectory[];
  replay?: HarnessReplayManifest;
  gateResults?: HarnessGateStageResult[];
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
  taskSetId?: string;
  frontierId: string;
  triggerEventId?: string;
  gateAccepted?: boolean;
  auditPassed?: boolean;
  rolePolicyPassed?: boolean;
  taskSetAccepted?: boolean;
  connectorWritebacks: HarnessConnectorWriteback[];
  decision?: "accept" | "rollback";
  skillPatchId?: string;
  exportedBundleDir?: string;
  missingCandidateTraceIds: string[];
  artifactRefs: string[];
}

export type HarnessTriggerKind =
  | "trace_failure"
  | "audit_blocker"
  | "frontier_stagnation";
export type HarnessTriggerAllowedAction = "report" | "propose" | "export";

export interface HarnessTriggerRule {
  ruleId: string;
  kind: HarnessTriggerKind;
  enabled: boolean;
  summary: string;
  allowedAction: HarnessTriggerAllowedAction;
  traceIds?: string[];
  frontierId?: string;
  minFailureCount?: number;
  minBlockedAudits?: number;
}

export interface HarnessTriggerEvent {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  eventId: string;
  ruleId: string;
  kind: HarnessTriggerKind;
  createdAt: string;
  allowedAction: HarnessTriggerAllowedAction;
  summary: string;
  traceIds: string[];
  candidateIds: string[];
  frontierId?: string;
  plan?: HarnessEvolutionPlan;
  nextAction: string;
}

export interface HarnessTriggerScan {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  scanId: string;
  createdAt: string;
  rules: HarnessTriggerRule[];
  events: HarnessTriggerEvent[];
  artifactRefs: string[];
}

export interface HarnessRolePolicy {
  requireIndependentReviewer: boolean;
  requireIndependentVerifier: boolean;
  builderProvider?: string;
  reviewerProvider?: string;
  verifierProvider?: string;
}

export interface HarnessRoleEvidence {
  builderProvider?: string;
  reviewerProvider?: string;
  verifierProvider?: string;
  independentReviewer: boolean;
  independentVerifier: boolean;
  passed: boolean;
  reasons: string[];
}

export type HarnessConnectorKind = "local_jsonl" | "markdown";

export interface HarnessConnectorTarget {
  kind: HarnessConnectorKind;
  path?: string;
}

export interface HarnessConnectorWriteback {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  writebackId: string;
  runId: string;
  kind: HarnessConnectorKind;
  writtenAt: string;
  path: string;
  status: "written";
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

/**
 * One iteration of an iterative (GEPA-style) evolution loop.
 *
 * Each iteration is a full `proposeHarnessCandidate` call against its own
 * candidateId, scored by a cheap local heuristic so the loop can reflect and
 * improve without paying for an LLM judge on every round.
 */
export interface HarnessIterationRecord {
  iteration: number;
  candidateId: string;
  score: number;
  feedback: string;
  filesModified: string[];
  diffStat?: string;
  durationMs: number;
  skipped?: boolean;
  skipReason?: string;
}

/**
 * Result of an iterative evolution run that wraps `proposeHarnessCandidate`
 * in a reflect-and-improve loop and returns the best-scoring iteration.
 */
export interface HarnessEvolutionResult {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  baseCandidateId: string;
  totalIterations: number;
  bestIteration: number;
  bestScore: number;
  earlyStopped: boolean;
  history: HarnessIterationRecord[];
  finalCandidate: HarnessCandidateRecord;
  finalProposal: HarnessProposalResult;
}

/**
 * Rubric for the LLM-as-judge fitness function. Mirrors Hermes-ASE's
 * multi-dimensional scoring (correctness / procedure / conciseness) with a
 * length penalty to discourage evolutionary bloat.
 */
export interface HarnessLLMJudgeRubric {
  correctnessWeight: number;
  procedureWeight: number;
  concisenessWeight: number;
  /** Size ratio (evolved/baseline) above which a length penalty starts. */
  lengthPenaltyThreshold?: number;
}

export const DEFAULT_LLM_JUDGE_RUBRIC: HarnessLLMJudgeRubric = {
  correctnessWeight: 0.5,
  procedureWeight: 0.3,
  concisenessWeight: 0.2,
  lengthPenaltyThreshold: 1.2,
};

/**
 * A single stage in the graded gate pipeline. Encodes the Hermes-ASE
 * principle "benchmarks are GATES, not fitness functions": constraint and
 * benchmark stages can reject a candidate, while fitness stages only score.
 */
export interface HarnessGateStage {
  name: string;
  kind: "constraint" | "quick_fitness" | "fitness" | "full_benchmark" | "coherence";
  required: boolean;
  order: number;
}

export const DEFAULT_GATE_STAGES: HarnessGateStage[] = [
  { name: "constraints", kind: "constraint", required: true, order: 1 },
  { name: "quick_fitness", kind: "quick_fitness", required: false, order: 2 },
  { name: "dataset_gate", kind: "fitness", required: true, order: 3 },
  { name: "audit", kind: "coherence", required: true, order: 4 },
];

export interface HarnessGateStageResult {
  stage: HarnessGateStage;
  passed: boolean;
  score?: number;
  feedback?: string;
  durationMs: number;
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
  skillPatch?: HarnessSkillPatchDecision;
  instructions: string[];
}

export interface HarnessTrajectoryStep {
  index: number;
  name: string;
  provider: string;
  round: number;
  durationMs: number;
  verdict?: StepTraceVerdict;
  filesModified: string[];
  error?: string;
  observationSummary?: string;
  artifactRefs: string[];
  toolStats: Record<string, number>;
}

type StepTraceVerdict = NonNullable<PipelineTrace["steps"][number]["verdict"]>;

export interface HarnessTrajectory {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  trajectoryId: string;
  createdAt: string;
  traceId: string;
  taskId?: string;
  runId?: string;
  candidateId?: string;
  model?: string;
  skillVersion?: string;
  toolsets: string[];
  completed: boolean;
  score: number;
  tracePath?: string;
  trajectoryPath: string;
  artifactHashes: Array<{ path: string; sha256: string; size: number }>;
  steps: HarnessTrajectoryStep[];
}

export interface HarnessReplayManifest {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  replayId: string;
  createdAt: string;
  runId?: string;
  taskSetId?: string;
  candidateId?: string;
  trajectoryIds: string[];
  commands: string[];
  artifactRefs: string[];
}

export interface HarnessSkillPatchDecision {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  patchId: string;
  createdAt: string;
  candidateId: string;
  baseSkill: string;
  candidateSkill: string;
  touchedSurfaces: string[];
  patchBudget: {
    maxFiles: number;
    maxBytes?: number;
  };
  selectionDelta: number;
  regressionPassed: boolean;
  policyPassed: boolean;
  auditPassed: boolean;
  accepted: boolean;
  decision: "accept" | "reject" | "rollback";
  reason: string;
  rollbackRef?: string;
}

export interface HarnessRejectedBufferEntry {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  rejectedId: string;
  createdAt: string;
  candidateId: string;
  patchId?: string;
  sourceFailureSignatureIds: string[];
  sourceTraceIds: string[];
  selectionDelta?: number;
  regressionFailures: string[];
  rejectionReason: string;
  reviewNotes?: string;
  similarityKeys: string[];
  optimizerOnly: true;
}

export type HarnessTrainingExportFormat =
  | "runoff_training_jsonl"
  | "dressage_compatible_jsonl";

export interface HarnessTrainingSample {
  sampleId: string;
  trajectoryId: string;
  traceId: string;
  taskId?: string;
  runId?: string;
  candidateId?: string;
  prompt: string;
  messages: Array<{
    role: "user" | "assistant" | "tool" | "system";
    content: string;
    source: string;
  }>;
  steps: HarnessTrajectoryStep[];
  outcome: {
    completed: boolean;
    score: number;
    finalStatus?: PipelineTrace["finalStatus"];
    totalRounds?: number;
    totalDurationMs?: number;
  };
  usage?: PipelineTrace["totalUsage"];
  rewardRefs: string[];
  provenance: {
    tracePath?: string;
    trajectoryPath: string;
    artifactHashes: HarnessTrajectory["artifactHashes"];
  };
}

export interface HarnessTrainingTrajectoryExport {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  exportId: string;
  createdAt: string;
  format: HarnessTrainingExportFormat;
  taskSetId?: string;
  candidateId?: string;
  trajectoryIds: string[];
  sampleCount: number;
  manifestPath: string;
  samplesPath: string;
  artifactRefs: string[];
  tokenTelemetry: {
    status: "not_captured" | "partial";
    availableFields: string[];
    note: string;
  };
  samples: HarnessTrainingSample[];
}

export type HarnessPaddockAdapterKind =
  | "local_cli"
  | "mcp_host"
  | "http_blackbox";

export type HarnessPaddockProtocol =
  | "runoff_provider"
  | "openai_compatible"
  | "blackbox_http";

export interface HarnessPaddockAdapter {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  paddockId: string;
  createdAt: string;
  kind: HarnessPaddockAdapterKind;
  protocol: HarnessPaddockProtocol;
  summary: string;
  command?: string[];
  endpoint?: string;
  toolsets: string[];
  capabilities: string[];
  headerNames: string[];
  isolationRequired: boolean;
}

export type HarnessSandboxProvider =
  | "local_worktree"
  | "local_directory"
  | "remote_e2b"
  | "custom";

export interface HarnessSandboxSpec {
  provider: HarnessSandboxProvider;
  workspaceRoot?: string;
  serviceEndpoints: string[];
  cleanupPolicy: "manual" | "on_release" | "ephemeral";
  artifactArchive?: string;
  metadata?: Record<string, string>;
}

export interface HarnessSandboxLease {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  leaseId: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "released";
  candidateId?: string;
  taskSetId?: string;
  spec: HarnessSandboxSpec;
  variantDir?: string;
  releaseReason?: string;
}

export type HarnessRolloutMode = "sync" | "async" | "partial";

export interface HarnessRolloutItem {
  itemId: string;
  taskId: string;
  status: "planned" | "running" | "completed" | "blocked";
  candidateTraceId?: string;
  baselineTraceId?: string;
  trajectoryId?: string;
  sandboxLeaseId?: string;
  reward?: number;
  reason?: string;
}

export interface HarnessRolloutBatch {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  batchId: string;
  createdAt: string;
  updatedAt: string;
  mode: HarnessRolloutMode;
  status: "planned" | "running" | "completed" | "blocked";
  taskSetId: string;
  candidateId: string;
  paddockId?: string;
  sandboxLeaseIds: string[];
  candidateTraceIdsByTask: Record<string, string>;
  trainingExportId?: string;
  rewardReportId?: string;
  items: HarnessRolloutItem[];
  reason?: string;
}

export type HarnessRewardFunctionKind =
  | "verifier_score"
  | "binary_success"
  | "regression_delta"
  | "policy_safe"
  | "heuristic_overlap"
  | "llm_judge"
  | "custom";

export interface HarnessRewardFunction {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  rewardId: string;
  createdAt: string;
  kind: HarnessRewardFunctionKind;
  summary: string;
  weight: number;
  sourceVerifierId?: string;
  rubric?: string;
}

export interface HarnessRewardReport {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  reportId: string;
  createdAt: string;
  rewardId: string;
  taskSetId: string;
  candidateId: string;
  evaluationPath?: string;
  rolloutBatchId?: string;
  trainingExportId?: string;
  rewards: Array<{
    taskId: string;
    reward: number;
    sourceScore: number;
    passed: boolean;
    reason: string;
  }>;
  aggregateReward: number;
  accepted: boolean;
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

const normalizeSurfacePath = normalizeHarnessSurfacePath;
const isAllowedBySurface = isHarnessSurfaceAllowed;

function snapshotVariantFiles(
  dir: string,
  prefix = "",
): Map<string, FileSnapshotEntry> {
  const out = new Map<string, FileSnapshotEntry>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = normalizeSurfacePath(prefix ? join(prefix, name) : name);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      for (const [child, entry] of snapshotVariantFiles(abs, rel))
        out.set(child, entry);
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

function copyPromotionFile(
  variantRoot: string,
  filesRoot: string,
  file: string,
): HarnessPromotionBundle["files"][number] {
  const normalized = normalizeSurfacePath(file);
  const source = resolve(variantRoot, normalized);
  const variantRootResolved = resolve(variantRoot);
  if (
    !source.startsWith(`${variantRootResolved}/`) &&
    source !== variantRootResolved
  ) {
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

function diffVariantSnapshots(
  before: Map<string, FileSnapshotEntry>,
  after: Map<string, FileSnapshotEntry>,
): VariantDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [file, entry] of after) {
    const previous = before.get(file);
    if (!previous) added.push(file);
    else if (previous.hash !== entry.hash || previous.size !== entry.size)
      modified.push(file);
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
    diffStat: parts.length
      ? `${filesModified.length} files changed (${parts.join(", ")})`
      : "0 files changed",
  };
}

function isAllowedByEditableSurface(file: string, surface: string[]): boolean {
  if (!surface.length) return true;
  const normalizedFile = normalizeSurfacePath(file);
  return surface.some((entry) => {
    const normalizedEntry = normalizeSurfacePath(entry);
    if (normalizedEntry.endsWith("/"))
      return normalizedFile.startsWith(normalizedEntry);
    return (
      normalizedFile === normalizedEntry ||
      normalizedFile.startsWith(`${normalizedEntry}/`)
    );
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
  const candidateId =
    input.candidateId?.trim() || `harness-${randomUUID().slice(0, 8)}`;
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
      source: manifest.failureSignatureIds.length
        ? "mined-signature"
        : input.parentCandidateIds?.length
          ? "derived-candidate"
          : "manual",
    },
  };
  atomicWriteJson(candidatePath(candidateId), record);
  atomicWriteJson(join(dir, "manifest.json"), manifest);
  return record;
}

function buildCandidateLineage(
  record: HarnessCandidateRecord,
  parentCandidateIds: string[] = [],
  datasetIds: string[] = [],
): HarnessCandidateLineage {
  return {
    candidateId: record.candidateId,
    createdAt: record.createdAt,
    parentCandidateIds,
    failureSignatureIds: record.manifest.failureSignatureIds,
    datasetIds,
    source: record.manifest.failureSignatureIds.length
      ? "mined-signature"
      : parentCandidateIds.length
        ? "derived-candidate"
        : "manual",
  };
}

export function loadHarnessCandidate(
  candidateId: string,
): HarnessCandidateRecord | undefined {
  return readJsonFile<HarnessCandidateRecord>(candidatePath(candidateId));
}

export function listHarnessCandidates(): HarnessCandidateRecord[] {
  if (!existsSync(candidatesDir())) return [];
  return readdirSync(candidatesDir())
    .flatMap((name) => {
      const record = readJsonFile<HarnessCandidateRecord>(
        join(candidatesDir(), name, "candidate.json"),
      );
      return record ? [record] : [];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function buildHarnessHistoryContext(
  record: HarnessCandidateRecord,
): string | undefined {
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
  const rejectedBuffer = listHarnessRejectedBuffer(10).map((entry) => ({
    rejectedId: entry.rejectedId,
    candidateId: entry.candidateId,
    patchId: entry.patchId,
    selectionDelta: entry.selectionDelta,
    regressionFailures: entry.regressionFailures,
    rejectionReason: entry.rejectionReason,
    similarityKeys: entry.similarityKeys,
    optimizerOnly: entry.optimizerOnly,
  }));
  const context = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    candidateId: record.candidateId,
    generatedAt: new Date().toISOString(),
    failureSignatures: signatures,
    priorCandidates,
    rejectedBuffer,
  };
  const path = join(candidateDir(record.candidateId), "history-context.json");
  atomicWriteJson(path, context);
  return path;
}

function buildProposalPrompt(
  record: HarnessCandidateRecord,
  historyContextPath: string | undefined,
  extraInstructions?: string,
): string {
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
    extraInstructions?.trim() ||
      "Make the smallest harness change that satisfies the manifest.",
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
}): Promise<{
  candidate: HarnessCandidateRecord;
  proposal: HarnessProposalResult;
}> {
  const existing = input.candidateId
    ? loadHarnessCandidate(input.candidateId)
    : undefined;
  const candidate =
    existing ??
    createHarnessCandidate({
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
  const prompt = buildProposalPrompt(
    candidate,
    historyContextPath,
    input.instructions,
  );
  const beforeSnapshot = snapshotVariantFiles(candidate.variant.variantDir);
  const response = await input.provider.execute({
    prompt,
    workDir: candidate.variant.variantDir,
    stepName: "harness-propose",
    round: 1,
  });
  const observedDiff = diffVariantSnapshots(
    beforeSnapshot,
    snapshotVariantFiles(candidate.variant.variantDir),
  );
  const summary = summarizeProviderResponse(response);
  const reportedFiles = [
    ...new Set(summary.filesModified.map(normalizeSurfacePath)),
  ].sort((a, b) => a.localeCompare(b));
  const observedFiles = observedDiff.filesModified;
  const changedFileSet = new Set([...reportedFiles, ...observedFiles]);
  const surfaceViolations = [...changedFileSet]
    .filter(
      (file) =>
        !isAllowedByEditableSurface(file, candidate.manifest.editableSurface),
    )
    .sort((a, b) => a.localeCompare(b));
  const observedFileSet = new Set(observedFiles);
  const reportedFileSet = new Set(reportedFiles);
  const unreportedFilesModified = observedFiles.filter(
    (file) => !reportedFileSet.has(file),
  );
  const reportedButUnchangedFiles = reportedFiles.filter(
    (file) => !observedFileSet.has(file),
  );
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

/**
 * Cheap, local fitness heuristic — zero API calls. Used inside the iterative
 * evolution loop to score every round so reflection can proceed without an
 * LLM judge. Mirrors Hermes-ASE's keyword-overlap proxy plus a length penalty.
 *
 * Score (0-1) is composed of:
 *  - 0.30 base for producing a non-empty diff
 *  - 0.30 weighted by how many declared expectedFixes appear in the diff
 *  - 0.20 for passing constraints
 *  - 0.20 weighted by (1 - lengthPenalty), where the penalty ramps once the
 *    evolved artifact grows past 90% of the allowed growth budget
 */
export function heuristicFitness(input: {
  expectedFixes: string[];
  observedDiff: string;
  constraintsPassed: boolean;
  baselineSize: number;
  evolvedSize: number;
}): { score: number; feedback: string } {
  const diff = input.observedDiff ?? "";
  const hasDiff = diff.trim().length > 0;
  if (!hasDiff) {
    return { score: 0, feedback: "no diff produced" };
  }

  const diffLower = diff.toLowerCase();
  const fixes = input.expectedFixes.filter((f) => f.trim().length > 0);
  let matched = 0;
  for (const fix of fixes) {
    const tokens = fix
      .toLowerCase()
      .match(/[a-z0-9_]{3,}/g)
      ?.filter((t) => t.length >= 3);
    if (!tokens || tokens.length === 0) continue;
    const hit = tokens.filter((t) => diffLower.includes(t)).length / tokens.length;
    if (hit >= 0.5) matched += 1;
  }
  const fixRatio = fixes.length ? matched / fixes.length : 1;

  // Length penalty: ramps from 0 at 90% growth ratio to 0.3 at >=100%.
  let lengthPenalty = 0;
  if (input.baselineSize > 0) {
    const ratio = input.evolvedSize / input.baselineSize;
    if (ratio > 1.9) lengthPenalty = 0.3;
    else if (ratio > 1.0) lengthPenalty = Math.min(0.3, (ratio - 1.0) * 0.333);
  }

  const raw =
    0.3 +
    0.3 * fixRatio +
    0.2 * (input.constraintsPassed ? 1 : 0) +
    0.2 * (1 - Math.min(1, lengthPenalty / 0.2));
  const score = Number(Math.max(0, Math.min(1, raw)).toFixed(4));

  const feedback = [
    `matched fixes: ${matched}/${fixes.length}`,
    `constraints: ${input.constraintsPassed ? "pass" : "fail"}`,
    `size: ${input.baselineSize}→${input.evolvedSize} chars`,
    lengthPenalty > 0 ? `length penalty: -${lengthPenalty.toFixed(2)}` : "no length penalty",
  ].join("; ");

  return { score, feedback };
}

function variantSurfaceSize(record: HarnessCandidateRecord): number {
  const files =
    record.proposal?.observedFilesModified?.length
      ? record.proposal.observedFilesModified
      : record.manifest.editableSurface;
  return readVariantTextFiles(record, files).reduce(
    (sum, f) => sum + f.text.length,
    0,
  );
}

function buildReflectionInstructions(
  base: string | undefined,
  previous: HarnessIterationRecord,
  previousProposal: HarnessProposalResult | undefined,
): string {
  return [
    base?.trim() || "Make the smallest harness change that satisfies the manifest.",
    "",
    "--- Reflection on the previous attempt ---",
    `Previous iteration ${previous.iteration} scored ${previous.score.toFixed(3)}/1.0.`,
    `Score breakdown: ${previous.feedback}`,
    previousProposal?.summary
      ? `Previous change summary: ${previousProposal.summary}`
      : "",
    previousProposal?.observedDiffStat
      ? `Previous diff stat: ${previousProposal.observedDiffStat}`
      : "",
    previousProposal?.surfaceViolations?.length
      ? `Previous attempt edited files outside the allowed surface: ${previousProposal.surfaceViolations.join(", ")}. Stay within the editable surface this time.`
      : "",
    "Improve on the previous attempt: address the unmatched expected fixes, keep the change concise, and stay within the editable surface.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * GEPA-style iterative evolution. Wraps {@link proposeHarnessCandidate} in a
 * reflect-and-improve loop: each round produces a fresh candidate variant,
 * scores it with the cheap local {@link heuristicFitness}, then feeds the diff
 * and score back into the next round's prompt as reflection. Returns the
 * best-scoring iteration.
 *
 * This does not import DSPy/GEPA — it reuses runoff's existing provider,
 * variant isolation, and editable-surface contract. To plug in a real GEPA
 * optimizer process, expose it as a cli/MCP provider and pass it as `provider`.
 */
export async function evolveHarnessCandidate(input: {
  provider: LLMProvider;
  candidateId?: string;
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
  iterations?: number;
  earlyStopThreshold?: number;
  reflectOnTrajectory?: boolean;
}): Promise<HarnessEvolutionResult> {
  const maxIterations = Math.max(1, Math.min(20, input.iterations ?? 5));
  const earlyStop = input.earlyStopThreshold ?? 0.9;
  const reflect = input.reflectOnTrajectory !== false;
  const baseId =
    input.candidateId?.trim() || `evolve-${randomUUID().slice(0, 8)}`;

  const history: HarnessIterationRecord[] = [];
  let best:
    | { record: HarnessCandidateRecord; proposal: HarnessProposalResult; score: number; iteration: number }
    | undefined;
  let previousParents = input.parentCandidateIds ?? [];
  let earlyStopped = false;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const started = Date.now();
    const iterationCandidateId = `${baseId}-iter-${iteration}`;

    let instructions = input.instructions;
    if (reflect && iteration > 0 && history.length) {
      const prev = history[history.length - 1]!;
      const prevRecord = loadHarnessCandidate(prev.candidateId);
      instructions = buildReflectionInstructions(
        input.instructions,
        prev,
        prevRecord?.proposal,
      );
    }

    const { candidate, proposal } = await proposeHarnessCandidate({
      candidateId: iterationCandidateId,
      provider: input.provider,
      summary: input.summary,
      sourceDir: input.sourceDir,
      editableSurface: input.editableSurface,
      expectedFixes: input.expectedFixes,
      possibleRegressions: input.possibleRegressions,
      evidenceTraceIds: input.evidenceTraceIds,
      failureSignatureIds: input.failureSignatureIds,
      parentCandidateIds: previousParents,
      datasetIds: input.datasetIds,
      instructions,
    });
    previousParents = [iterationCandidateId];

    // Constraint gate: a failed proposal (e.g. surface violation) is skipped.
    if (proposal.failed) {
      const record: HarnessIterationRecord = {
        iteration,
        candidateId: iterationCandidateId,
        score: 0,
        feedback: proposal.error ?? "proposal failed constraints",
        filesModified: proposal.filesModified,
        diffStat: proposal.diffStat,
        durationMs: Date.now() - started,
        skipped: true,
        skipReason: proposal.error ?? "proposal failed",
      };
      history.push(record);
      continue;
    }

    const evolvedSize = variantSurfaceSize(candidate);
    const baselineSize = input.sourceDir
      ? readVariantTextFiles(
          { ...candidate, variant: { ...candidate.variant, variantDir: input.sourceDir } },
          proposal.observedFilesModified.length
            ? proposal.observedFilesModified
            : candidate.manifest.editableSurface,
        ).reduce((sum, f) => sum + f.text.length, 0)
      : evolvedSize;

    const fitness = heuristicFitness({
      expectedFixes: candidate.manifest.expectedFixes,
      observedDiff: [
        proposal.observedDiffStat,
        proposal.diffStat,
        proposal.summary,
      ]
        .filter(Boolean)
        .join(" "),
      constraintsPassed: !proposal.failed,
      baselineSize,
      evolvedSize,
    });

    const record: HarnessIterationRecord = {
      iteration,
      candidateId: iterationCandidateId,
      score: fitness.score,
      feedback: fitness.feedback,
      filesModified: proposal.filesModified,
      diffStat: proposal.diffStat,
      durationMs: Date.now() - started,
    };
    history.push(record);

    if (!best || fitness.score > best.score) {
      best = { record: candidate, proposal, score: fitness.score, iteration };
    }
    if (fitness.score >= earlyStop) {
      earlyStopped = true;
      break;
    }
  }

  // If every iteration was skipped, fall back to the last attempt so callers
  // always get a concrete candidate to inspect.
  if (!best) {
    const lastId = history[history.length - 1]?.candidateId ?? `${baseId}-iter-0`;
    const fallback = loadHarnessCandidate(lastId);
    if (!fallback?.proposal) {
      throw new Error(
        `Harness evolution produced no usable candidate (base ${baseId})`,
      );
    }
    best = {
      record: fallback,
      proposal: fallback.proposal,
      score: 0,
      iteration: history[history.length - 1]?.iteration ?? 0,
    };
  }

  const result: HarnessEvolutionResult = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    baseCandidateId: baseId,
    totalIterations: history.length,
    bestIteration: best.iteration,
    bestScore: best.score,
    earlyStopped,
    history,
    finalCandidate: best.record,
    finalProposal: best.proposal,
  };
  return result;
}

function traceDifficulty(trace: PipelineTrace): number {
  let score = 0;
  if (trace.finalStatus === "failed" || trace.finalStatus === "max_rounds")
    score += 5;
  if (trace.finalStatus === "aborted") score += 3;
  score += Math.min(3, trace.totalRounds);
  score += Math.min(3, trace.steps.filter((s) => s.error).length);
  score += Math.min(3, Math.floor(trace.totalDurationMs / 60_000));
  return score;
}

function diversityKey(trace: PipelineTrace): string {
  const providers =
    [...new Set(trace.steps.map((s) => s.provider))].sort().join("+") || "none";
  const words = trace.prompt.toLowerCase().match(/[a-z0-9_-]{4,}/g) ?? [];
  return `${trace.finalStatus}:${providers}:${words.slice(0, 3).join("-")}`;
}

function firstFailureStep(trace: PipelineTrace) {
  return (
    trace.steps.find(
      (step) => step.error || step.verdict === "needs_revision",
    ) ?? trace.steps.at(-1)
  );
}

function failureCategory(
  trace: PipelineTrace,
): HarnessFailureCategory | undefined {
  if (trace.steps.some((step) => step.error)) return "step_error";
  if (
    trace.candidates?.some((candidate) => candidate.failed || candidate.error)
  )
    return "race_failure";
  if (trace.steps.some((step) => step.verdict === "needs_revision"))
    return "approval_rejected";
  if (trace.finalStatus === "max_rounds") return "max_rounds";
  if (trace.finalStatus === "aborted") return "aborted";
  if (!trace.hasVerifyResults && trace.finalStatus !== "approved")
    return "missing_verification";
  if (trace.finalStatus === "failed") return "terminal_failure";
  return undefined;
}

function suggestedSurfaceForCategory(
  category: HarnessFailureCategory,
): string[] {
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

function signatureTitle(
  category: HarnessFailureCategory,
  trace: PipelineTrace,
): string {
  const step = firstFailureStep(trace);
  return `${category} in ${step?.name ?? trace.mode}`;
}

function signatureKey(
  category: HarnessFailureCategory,
  trace: PipelineTrace,
): string {
  const step = firstFailureStep(trace);
  const providers =
    [...new Set(trace.steps.map((s) => s.provider))].sort().join("+") || "none";
  return `${category}:${step?.name ?? "run"}:${providers}`;
}

function buildFailureSignature(
  key: string,
  traces: PipelineTrace[],
): HarnessFailureSignature {
  const first = traces[0]!;
  const category = failureCategory(first) ?? "terminal_failure";
  const step = firstFailureStep(first);
  const errors = traces
    .flatMap((trace) => trace.steps.flatMap((s) => (s.error ? [s.error] : [])))
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
    ]
      .filter(Boolean)
      .join("; "),
    agentActionPattern: `providers=${[...new Set(traces.flatMap((trace) => trace.steps.map((s) => s.provider)))].sort().join("+") || "none"}`,
    suspectedHarnessSurface: surface,
    evidenceTraceIds: traces.map((trace) => trace.id),
    suggestedEditableSurface: surface,
    suggestedExpectedFixes: [
      `Reduce ${category} recurrence for ${step?.name ?? first.mode}`,
    ],
    suggestedPossibleRegressions: [
      "overfitting to mined failure traces",
      "extra prompt or runtime overhead",
    ],
    severity: Math.min(
      10,
      Math.max(...traces.map(traceDifficulty)) + traces.length,
    ),
    traceCount: traces.length,
  };
}

export function mineHarnessFailureSignatures(
  input: {
    traceIds?: string[];
    limit?: number;
    since?: string;
  } = {},
): HarnessFailureSignature[] {
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
  for (const signature of signatures)
    atomicWriteJson(signaturePath(signature.signatureId), signature);
  return signatures;
}

export function loadHarnessFailureSignature(
  signatureId: string,
): HarnessFailureSignature | undefined {
  return readJsonFile<HarnessFailureSignature>(signaturePath(signatureId));
}

function defaultVerifier(kind: HarnessVerifierKind): HarnessVerifier {
  return {
    schema: HARNESS_EVOLUTION_SCHEMA,
    verifierId: kind,
    createdAt: new Date().toISOString(),
    kind,
    summary: `Built-in ${kind} verifier`,
  };
}

export function registerHarnessVerifier(input: {
  verifierId?: string;
  kind: HarnessVerifierKind;
  summary: string;
  command?: string[];
  expectedFiles?: string[];
  requiredTraceStatuses?: PipelineTrace["finalStatus"][];
  requiredStepNames?: string[];
  forbiddenPaths?: string[];
  rubric?: string;
}): HarnessVerifier {
  const verifierId =
    input.verifierId?.trim() ||
    `verifier-${input.kind}-${randomUUID().slice(0, 8)}`;
  const verifier: HarnessVerifier = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    verifierId,
    createdAt: new Date().toISOString(),
    kind: input.kind,
    summary: input.summary,
    command: input.command,
    expectedFiles: input.expectedFiles,
    requiredTraceStatuses: input.requiredTraceStatuses,
    requiredStepNames: input.requiredStepNames,
    forbiddenPaths: input.forbiddenPaths,
    rubric: input.rubric,
  };
  mkdirSync(verifiersDir(), { recursive: true });
  atomicWriteJson(verifierPath(verifierId), verifier);
  return verifier;
}

export function loadHarnessVerifier(
  verifierId: string,
): HarnessVerifier | undefined {
  return readJsonFile<HarnessVerifier>(verifierPath(verifierId));
}

export function listHarnessVerifiers(): HarnessVerifier[] {
  if (!existsSync(verifiersDir())) return [];
  return readdirSync(verifiersDir())
    .flatMap((name) => {
      const verifier = readJsonFile<HarnessVerifier>(
        join(verifiersDir(), name),
      );
      return verifier ? [verifier] : [];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function taskFromTrace(
  trace: PipelineTrace,
  verifierId: string,
  criticality: HarnessTask["criticality"],
): HarnessTask {
  return {
    taskId: `task-${trace.id}`,
    prompt: trace.prompt,
    toolsets: [
      ...new Set(
        trace.steps.map(
          (step) => step.mode ?? (step.isAgent ? "agent" : "text"),
        ),
      ),
    ].sort(),
    verifierId,
    timeoutSec: Math.max(60, Math.ceil(trace.totalDurationMs / 1000) * 2),
    budget: { maxRounds: Math.max(1, trace.totalRounds + 1) },
    forbiddenPaths: [],
    expectedArtifacts: [],
    criticality,
    sourceTraceId: trace.id,
  };
}

export function createHarnessTaskSet(input: {
  taskSetId?: string;
  name: string;
  description?: string;
  tasks?: HarnessTask[];
  traceIds?: string[];
  verifierId?: string;
  heldInRatio?: number;
  leakageTerms?: string[];
}): HarnessTaskSet {
  const taskSetId =
    input.taskSetId?.trim() || `taskset-${randomUUID().slice(0, 8)}`;
  const verifierId = input.verifierId?.trim() || "trace_process";
  const traces = input.traceIds?.length
    ? input.traceIds.flatMap((id) => {
        const trace = loadTraceById(id);
        return trace ? [trace] : [];
      })
    : [];
  const traceTasks = traces.map((trace, index) =>
    taskFromTrace(
      trace,
      verifierId,
      index === traces.length - 1 ? "critical-regression" : "selection",
    ),
  );
  const tasks = [...(input.tasks ?? []), ...traceTasks];
  if (!tasks.length)
    throw new Error("Harness task set requires at least one task or trace");
  const heldInRatio = Math.min(0.8, Math.max(0.2, input.heldInRatio ?? 0.6));
  const selectionCount =
    tasks.length === 1
      ? 1
      : Math.max(
          1,
          Math.min(tasks.length - 1, Math.ceil(tasks.length * heldInRatio)),
        );
  const selectionTaskIds = tasks
    .filter(
      (task, index) =>
        task.criticality === "selection" ||
        (task.criticality === "exploratory" && index < selectionCount),
    )
    .map((task) => task.taskId);
  const regressionTaskIds = tasks
    .filter(
      (task, index) =>
        task.criticality === "critical-regression" ||
        (!selectionTaskIds.includes(task.taskId) && index >= selectionCount),
    )
    .map((task) => task.taskId);
  const taskSet: HarnessTaskSet = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    taskSetId,
    createdAt: new Date().toISOString(),
    name: input.name,
    description: input.description,
    tasks,
    selectionTaskIds: [
      ...new Set(
        selectionTaskIds.length
          ? selectionTaskIds
          : tasks.slice(0, selectionCount).map((task) => task.taskId),
      ),
    ],
    regressionTaskIds: [
      ...new Set(
        regressionTaskIds.length
          ? regressionTaskIds
          : tasks.slice(selectionCount).map((task) => task.taskId),
      ),
    ],
    leakageTerms: input.leakageTerms ?? [],
  };
  mkdirSync(taskSetsDir(), { recursive: true });
  atomicWriteJson(taskSetPath(taskSetId), taskSet);
  return taskSet;
}

export function loadHarnessTaskSet(
  taskSetId: string,
): HarnessTaskSet | undefined {
  return readJsonFile<HarnessTaskSet>(taskSetPath(taskSetId));
}

export function listHarnessTaskSets(): HarnessTaskSet[] {
  if (!existsSync(taskSetsDir())) return [];
  return readdirSync(taskSetsDir())
    .flatMap((name) => {
      const taskSet = readJsonFile<HarnessTaskSet>(join(taskSetsDir(), name));
      return taskSet ? [taskSet] : [];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function locateTraceFile(traceId: string): string | undefined {
  const trace = loadTraceById(traceId);
  if (!trace) return undefined;
  return join(
    getTracesDir(),
    `${trace.timestamp.slice(0, 10)}_${traceId}.json`,
  );
}

function runHarnessVerifier(
  verifier: HarnessVerifier,
  task: HarnessTask,
  candidateTrace: PipelineTrace | null,
): HarnessVerifierResult {
  const evidence: string[] = [];
  if (!candidateTrace) {
    return {
      verifierId: verifier.verifierId,
      kind: verifier.kind,
      passed: false,
      score: 0,
      reason: "candidate trace missing",
      evidence: [task.taskId],
    };
  }
  if (verifier.kind === "command") {
    if (!verifier.command?.length)
      return {
        verifierId: verifier.verifierId,
        kind: verifier.kind,
        passed: false,
        score: 0,
        reason: "command verifier missing command",
        evidence,
      };
    const result = spawnSync(verifier.command[0]!, verifier.command.slice(1), {
      cwd: task.fixture ? resolve(task.fixture) : undefined,
      encoding: "utf-8",
      timeout: task.timeoutSec * 1000,
    });
    const passed = result.status === 0;
    evidence.push(`status=${result.status ?? "null"}`);
    if (result.stdout) evidence.push(result.stdout.slice(0, 500));
    if (result.stderr) evidence.push(result.stderr.slice(0, 500));
    return {
      verifierId: verifier.verifierId,
      kind: verifier.kind,
      passed,
      score: passed ? 1 : 0,
      reason: passed ? "command passed" : "command failed",
      evidence,
    };
  }
  if (verifier.kind === "file_diff") {
    const expected = verifier.expectedFiles ?? task.expectedArtifacts;
    const touched = new Set(
      candidateTrace.steps.flatMap((step) => step.filesModified ?? []),
    );
    const missing = expected.filter((file) => !touched.has(file));
    return {
      verifierId: verifier.verifierId,
      kind: verifier.kind,
      passed: missing.length === 0,
      score: expected.length
        ? (expected.length - missing.length) / expected.length
        : 1,
      reason: missing.length
        ? `missing expected files: ${missing.join(", ")}`
        : "expected files touched",
      evidence: [...touched],
    };
  }
  if (verifier.kind === "policy") {
    const forbidden = [
      ...(verifier.forbiddenPaths ?? []),
      ...task.forbiddenPaths,
    ].map(normalizeSurfacePath);
    const touched = candidateTrace.steps
      .flatMap((step) => step.filesModified ?? [])
      .map(normalizeSurfacePath);
    const violations = touched.filter((file) =>
      forbidden.some((path) => file === path || file.startsWith(`${path}/`)),
    );
    return {
      verifierId: verifier.verifierId,
      kind: verifier.kind,
      passed: violations.length === 0,
      score: violations.length ? 0 : 1,
      reason: violations.length
        ? `forbidden paths touched: ${violations.join(", ")}`
        : "policy boundary passed",
      evidence: violations.length ? violations : touched,
    };
  }
  if (verifier.kind === "trace_process") {
    const requiredStatuses = verifier.requiredTraceStatuses ?? ["approved"];
    const requiredStepNames = verifier.requiredStepNames ?? [];
    const missingSteps = requiredStepNames.filter(
      (name) => !candidateTrace.steps.some((step) => step.name === name),
    );
    const passed =
      requiredStatuses.includes(candidateTrace.finalStatus) &&
      missingSteps.length === 0;
    evidence.push(
      `status=${candidateTrace.finalStatus}`,
      `rounds=${candidateTrace.totalRounds}`,
    );
    return {
      verifierId: verifier.verifierId,
      kind: verifier.kind,
      passed,
      score: passed ? 1 : 0,
      reason: passed
        ? "trace process passed"
        : missingSteps.length
          ? `missing required steps: ${missingSteps.join(", ")}`
          : `unexpected status: ${candidateTrace.finalStatus}`,
      evidence,
    };
  }
  if (verifier.kind === "json_schema") {
    const passed =
      candidateTrace.finalStatus === "approved" &&
      candidateTrace.steps.length > 0;
    return {
      verifierId: verifier.verifierId,
      kind: verifier.kind,
      passed,
      score: passed ? 1 : 0,
      reason: passed
        ? "trace JSON shape present"
        : "trace JSON shape incomplete",
      evidence: [candidateTrace.id],
    };
  }
  return {
    verifierId: verifier.verifierId,
    kind: verifier.kind,
    passed: false,
    score: 0,
    reason:
      "llm_judge verifier requires external scorer output and is not auto-passing",
    evidence: [verifier.rubric ?? verifier.summary],
  };
}

function datasetItem(
  trace: PipelineTrace,
  split: "held-in" | "held-out",
  signatures: HarnessFailureSignature[],
): HarnessDatasetItem {
  const matching = signatures.filter((signature) =>
    signature.evidenceTraceIds.includes(trace.id),
  );
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
  const signatureTraceIds = signatures.flatMap(
    (signature) => signature.evidenceTraceIds,
  );
  const allTraceIds = [
    ...new Set([...(input.traceIds ?? []), ...signatureTraceIds]),
  ];
  const selected = allTraceIds.length
    ? allTraceIds.flatMap((id) => {
        const trace = loadTraceById(id);
        return trace ? [trace] : [];
      })
    : traces;
  const sorted = selected.sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
  const heldInRatio = Math.min(0.8, Math.max(0.2, input.heldInRatio ?? 0.6));
  const heldInCount = Math.max(
    1,
    Math.min(sorted.length - 1, Math.ceil(sorted.length * heldInRatio)),
  );
  const heldInTraces = sorted.slice(0, heldInCount);
  const heldOutTraces = sorted.slice(heldInCount);
  const datasetId =
    input.datasetId?.trim() || `dataset-${randomUUID().slice(0, 8)}`;
  const dataset: HarnessDataset = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    datasetId,
    createdAt: new Date().toISOString(),
    name: input.name,
    description: input.description,
    sourceTraceIds: sorted.map((trace) => trace.id),
    sourceFailureSignatureIds: signatures.map(
      (signature) => signature.signatureId,
    ),
    heldIn: heldInTraces.map((trace) =>
      datasetItem(trace, "held-in", signatures),
    ),
    heldOut: heldOutTraces.map((trace) =>
      datasetItem(trace, "held-out", signatures),
    ),
    leakageTerms: input.leakageTerms ?? [],
  };
  if (dataset.heldIn.length === 0 || dataset.heldOut.length === 0) {
    throw new Error(
      "Harness dataset requires at least one held-in and one held-out trace",
    );
  }
  mkdirSync(datasetsDir(), { recursive: true });
  atomicWriteJson(datasetPath(datasetId), dataset);
  return dataset;
}

export function loadHarnessDataset(
  datasetId: string,
): HarnessDataset | undefined {
  return readJsonFile<HarnessDataset>(datasetPath(datasetId));
}

export function evaluateHarnessDataset(input: {
  candidateId: string;
  datasetId: string;
  candidateTraceIdsByBaseline: Record<string, string>;
  tolerance?: RegressionTolerance;
}): HarnessDatasetEvaluation {
  const dataset = loadHarnessDataset(input.datasetId);
  if (!dataset)
    throw new Error(`Harness dataset not found: ${input.datasetId}`);
  const items = [...dataset.heldIn, ...dataset.heldOut];
  const missingBaselineTraceIds = items
    .filter((item) => !input.candidateTraceIdsByBaseline[item.baselineTraceId])
    .map((item) => item.baselineTraceId);
  if (missingBaselineTraceIds.length) {
    throw new Error(
      `Missing candidate traces for dataset baselines: ${missingBaselineTraceIds.join(", ")}`,
    );
  }
  const pairs: HarnessEvalPair[] = items.map((item) => ({
    baselineTraceId: item.baselineTraceId,
    candidateTraceId: input.candidateTraceIdsByBaseline[item.baselineTraceId]!,
    split: item.split,
  }));
  const gate = evaluateHarnessCandidate({
    candidateId: input.candidateId,
    pairs,
    tolerance: input.tolerance,
  });
  const result: HarnessDatasetEvaluation = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    datasetId: input.datasetId,
    candidateId: input.candidateId,
    evaluatedAt: new Date().toISOString(),
    pairs,
    missingBaselineTraceIds,
    gate,
  };
  atomicWriteJson(
    datasetEvaluationPath(input.datasetId, input.candidateId),
    result,
  );
  const record = loadHarnessCandidate(input.candidateId);
  if (record) {
    const lineage =
      record.lineage ?? buildCandidateLineage(record, [], [input.datasetId]);
    atomicWriteJson(candidatePath(input.candidateId), {
      ...record,
      lineage: {
        ...lineage,
        datasetIds: [...new Set([...lineage.datasetIds, input.datasetId])],
      },
    } satisfies HarnessCandidateRecord);
  }
  return result;
}

function traceScore(trace: PipelineTrace | null): number {
  if (!trace) return 0;
  const evaluated = evaluatePipelineTrace(trace);
  if (evaluated.success) return 1;
  if (trace.finalStatus === "max_rounds") return 0.35;
  if (trace.finalStatus === "aborted") return 0.2;
  return 0;
}

function artifactHash(
  path: string,
): { path: string; sha256: string; size: number } | undefined {
  if (!existsSync(path)) return undefined;
  const stat = statSync(path);
  if (!stat.isFile()) return undefined;
  const content = readFileSync(path);
  return {
    path,
    sha256: createHash("sha256").update(content).digest("hex"),
    size: stat.size,
  };
}

function toolStatsForStep(
  step: PipelineTrace["steps"][number],
): Record<string, number> {
  const stats: Record<string, number> = {};
  if (step.mode) stats[step.mode] = (stats[step.mode] ?? 0) + 1;
  if (step.isAgent) stats.agent = (stats.agent ?? 0) + 1;
  if (step.raceParticipants?.length) stats.race = step.raceParticipants.length;
  return stats;
}

export function createHarnessTrajectory(input: {
  traceId: string;
  taskId?: string;
  runId?: string;
  candidateId?: string;
  model?: string;
  skillVersion?: string;
  toolsets?: string[];
}): HarnessTrajectory {
  const trace = loadTraceById(input.traceId);
  if (!trace) throw new Error(`Trace not found: ${input.traceId}`);
  const trajectoryId = `traj-${safePathSegment(input.traceId)}-${randomUUID().slice(0, 8)}`;
  const tracePath = locateTraceFile(input.traceId);
  const steps: HarnessTrajectoryStep[] = trace.steps.map((step, index) => ({
    index,
    name: step.name,
    provider: step.provider,
    round: step.round,
    durationMs: step.durationMs,
    verdict: step.verdict,
    filesModified: step.filesModified ?? [],
    error: step.error,
    observationSummary: step.observation?.summary,
    artifactRefs:
      step.observation?.artifactRefs?.map(
        (ref) =>
          ref.ref ||
          ref.artifactId ||
          `${ref.stepName}:${ref.kind}:${ref.artifactIndex}`,
      ) ?? [],
    toolStats: toolStatsForStep(step),
  }));
  const hashes = [tracePath].flatMap((path) => {
    if (!path) return [];
    const hash = artifactHash(path);
    return hash ? [hash] : [];
  });
  const trajectory: HarnessTrajectory = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    trajectoryId,
    createdAt: new Date().toISOString(),
    traceId: input.traceId,
    taskId: input.taskId,
    runId: input.runId,
    candidateId: input.candidateId,
    model: input.model,
    skillVersion: input.skillVersion,
    toolsets:
      input.toolsets ??
      [
        ...new Set(
          trace.steps.map(
            (step) => step.mode ?? (step.isAgent ? "agent" : "text"),
          ),
        ),
      ].sort(),
    completed: trace.finalStatus === "approved",
    score: traceScore(trace),
    tracePath,
    trajectoryPath: trajectoryPath(trajectoryId),
    artifactHashes: hashes,
    steps,
  };
  mkdirSync(trajectoriesDir(), { recursive: true });
  atomicWriteJson(trajectory.trajectoryPath, trajectory);
  return trajectory;
}

export function loadHarnessTrajectory(
  trajectoryId: string,
): HarnessTrajectory | undefined {
  return readJsonFile<HarnessTrajectory>(trajectoryPath(trajectoryId));
}

export function createHarnessReplayManifest(input: {
  replayId?: string;
  runId?: string;
  taskSetId?: string;
  candidateId?: string;
  trajectoryIds: string[];
}): HarnessReplayManifest {
  const replayId =
    input.replayId?.trim() || `replay-${randomUUID().slice(0, 8)}`;
  const trajectories = input.trajectoryIds.flatMap((id) => {
    const trajectory = loadHarnessTrajectory(id);
    return trajectory ? [trajectory] : [];
  });
  const commands = trajectories.map(
    (trajectory) =>
      `npm run runoff:traces -- show ${trajectory.traceId} --json`,
  );
  const artifactRefs = trajectories.flatMap((trajectory) => [
    trajectory.trajectoryPath,
    ...trajectory.artifactHashes.map((hash) => hash.path),
  ]);
  const replay: HarnessReplayManifest = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    replayId,
    createdAt: new Date().toISOString(),
    runId: input.runId,
    taskSetId: input.taskSetId,
    candidateId: input.candidateId,
    trajectoryIds: input.trajectoryIds,
    commands,
    artifactRefs,
  };
  mkdirSync(replayDir(), { recursive: true });
  atomicWriteJson(replayManifestPath(replayId), replay);
  return replay;
}

function trainingSampleFromTrajectory(
  trajectory: HarnessTrajectory,
  rewardRefs: string[],
): HarnessTrainingSample {
  const trace = loadTraceById(trajectory.traceId);
  const messages: HarnessTrainingSample["messages"] = [];
  if (trace?.prompt) {
    messages.push({
      role: "user",
      content: trace.prompt,
      source: "pipeline_trace.prompt",
    });
  }
  for (const step of trace?.steps ?? []) {
    if (step.observation?.summary) {
      messages.push({
        role: "assistant",
        content: step.observation.summary,
        source: `step.${step.name}.observation.summary`,
      });
    }
    for (const ref of step.observation?.artifactRefs ?? []) {
      messages.push({
        role: "tool",
        content:
          ref.ref ||
          ref.artifactId ||
          `${ref.stepName}:${ref.kind}:${ref.artifactIndex}`,
        source: `step.${step.name}.artifact_ref`,
      });
    }
  }
  return {
    sampleId: `sample-${trajectory.trajectoryId}`,
    trajectoryId: trajectory.trajectoryId,
    traceId: trajectory.traceId,
    taskId: trajectory.taskId,
    runId: trajectory.runId,
    candidateId: trajectory.candidateId,
    prompt: trace?.prompt ?? "",
    messages,
    steps: trajectory.steps,
    outcome: {
      completed: trajectory.completed,
      score: trajectory.score,
      finalStatus: trace?.finalStatus,
      totalRounds: trace?.totalRounds,
      totalDurationMs: trace?.totalDurationMs,
    },
    usage: trace?.totalUsage,
    rewardRefs,
    provenance: {
      tracePath: trajectory.tracePath,
      trajectoryPath: trajectory.trajectoryPath,
      artifactHashes: trajectory.artifactHashes,
    },
  };
}

function writeJsonLines(path: string, rows: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    rows.map((row) => JSON.stringify(row)).join("\n") +
      (rows.length ? "\n" : ""),
    "utf-8",
  );
}

export function exportHarnessTrainingTrajectories(input: {
  exportId?: string;
  trajectoryIds: string[];
  taskSetId?: string;
  candidateId?: string;
  format?: HarnessTrainingExportFormat;
  rewardRefs?: string[];
}): HarnessTrainingTrajectoryExport {
  const exportId =
    input.exportId?.trim() || `train-export-${randomUUID().slice(0, 8)}`;
  const trajectories = input.trajectoryIds.flatMap((id) => {
    const trajectory = loadHarnessTrajectory(id);
    return trajectory ? [trajectory] : [];
  });
  if (!trajectories.length)
    throw new Error("Training export requires at least one known trajectory");
  const samplesPath = trainingExportSamplesPath(exportId);
  const manifestPath = trainingExportPath(exportId);
  const samples = trajectories.map((trajectory) =>
    trainingSampleFromTrajectory(trajectory, input.rewardRefs ?? []),
  );
  const availableFields = [
    "prompt",
    "step.provider",
    "step.durationMs",
    "step.filesModified",
    "step.observation.summary",
    "usage.promptTokens",
    "usage.completionTokens",
  ];
  const exportRecord: HarnessTrainingTrajectoryExport = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    exportId,
    createdAt: new Date().toISOString(),
    format: input.format ?? "runoff_training_jsonl",
    taskSetId: input.taskSetId,
    candidateId: input.candidateId,
    trajectoryIds: input.trajectoryIds,
    sampleCount: samples.length,
    manifestPath,
    samplesPath,
    artifactRefs: [
      ...new Set(
        samples.flatMap((sample) => [
          sample.provenance.trajectoryPath,
          ...(sample.provenance.tracePath ? [sample.provenance.tracePath] : []),
          ...sample.provenance.artifactHashes.map((hash) => hash.path),
        ]),
      ),
    ],
    tokenTelemetry: {
      status: "not_captured",
      availableFields,
      note: "runoff traces do not capture token-level logprobs/loss masks; export preserves available usage and step telemetry without fabricating trainer-only fields.",
    },
    samples,
  };
  writeJsonLines(samplesPath, samples);
  atomicWriteJson(manifestPath, exportRecord);
  return exportRecord;
}

export function listHarnessTrainingExports(
  limit = 20,
): HarnessTrainingTrajectoryExport[] {
  if (!existsSync(trainingExportsDir())) return [];
  return readdirSync(trainingExportsDir())
    .flatMap((name) => {
      const record = readJsonFile<HarnessTrainingTrajectoryExport>(
        join(trainingExportsDir(), name, "manifest.json"),
      );
      return record ? [record] : [];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, limit));
}

export function registerHarnessPaddockAdapter(input: {
  paddockId?: string;
  kind: HarnessPaddockAdapterKind;
  protocol: HarnessPaddockProtocol;
  summary: string;
  command?: string[];
  endpoint?: string;
  toolsets?: string[];
  capabilities?: string[];
  headerNames?: string[];
  isolationRequired?: boolean;
}): HarnessPaddockAdapter {
  const paddockId =
    input.paddockId?.trim() || `paddock-${randomUUID().slice(0, 8)}`;
  if (input.kind === "local_cli" && !input.command?.length)
    throw new Error("local_cli paddock adapter requires command");
  if (input.kind === "http_blackbox" && !input.endpoint?.trim())
    throw new Error("http_blackbox paddock adapter requires endpoint");
  const adapter: HarnessPaddockAdapter = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    paddockId,
    createdAt: new Date().toISOString(),
    kind: input.kind,
    protocol: input.protocol,
    summary: input.summary,
    command: input.command,
    endpoint: input.endpoint,
    toolsets: [...new Set(input.toolsets ?? [])].sort(),
    capabilities: [...new Set(input.capabilities ?? [])].sort(),
    headerNames: [...new Set(input.headerNames ?? [])].sort(),
    isolationRequired: input.isolationRequired ?? true,
  };
  mkdirSync(paddocksDir(), { recursive: true });
  atomicWriteJson(paddockPath(paddockId), adapter);
  return adapter;
}

export function loadHarnessPaddockAdapter(
  paddockId: string,
): HarnessPaddockAdapter | undefined {
  return readJsonFile<HarnessPaddockAdapter>(paddockPath(paddockId));
}

export function listHarnessPaddockAdapters(
  limit = 20,
): HarnessPaddockAdapter[] {
  if (!existsSync(paddocksDir())) return [];
  return readdirSync(paddocksDir())
    .flatMap((name) => {
      const adapter = readJsonFile<HarnessPaddockAdapter>(
        join(paddocksDir(), name),
      );
      return adapter ? [adapter] : [];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, limit));
}

export function createHarnessSandboxLease(input: {
  leaseId?: string;
  candidateId?: string;
  taskSetId?: string;
  spec: HarnessSandboxSpec;
}): HarnessSandboxLease {
  const leaseId =
    input.leaseId?.trim() || `sandbox-${randomUUID().slice(0, 8)}`;
  const candidate = input.candidateId
    ? loadHarnessCandidate(input.candidateId)
    : undefined;
  if (input.candidateId && !candidate)
    throw new Error(`Harness candidate not found: ${input.candidateId}`);
  if (input.taskSetId && !loadHarnessTaskSet(input.taskSetId))
    throw new Error(`Harness task set not found: ${input.taskSetId}`);
  const now = new Date().toISOString();
  const lease: HarnessSandboxLease = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    leaseId,
    createdAt: now,
    updatedAt: now,
    status: "active",
    candidateId: input.candidateId,
    taskSetId: input.taskSetId,
    spec: {
      ...input.spec,
      serviceEndpoints: [...new Set(input.spec.serviceEndpoints ?? [])].sort(),
    },
    variantDir: candidate?.variant.variantDir,
  };
  mkdirSync(sandboxesDir(), { recursive: true });
  atomicWriteJson(sandboxLeasePath(leaseId), lease);
  return lease;
}

export function loadHarnessSandboxLease(
  leaseId: string,
): HarnessSandboxLease | undefined {
  return readJsonFile<HarnessSandboxLease>(sandboxLeasePath(leaseId));
}

export function listHarnessSandboxLeases(limit = 20): HarnessSandboxLease[] {
  if (!existsSync(sandboxesDir())) return [];
  return readdirSync(sandboxesDir())
    .flatMap((name) => {
      const lease = readJsonFile<HarnessSandboxLease>(
        join(sandboxesDir(), name),
      );
      return lease ? [lease] : [];
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(1, limit));
}

export function releaseHarnessSandboxLease(input: {
  leaseId: string;
  reason?: string;
}): HarnessSandboxLease {
  const lease = loadHarnessSandboxLease(input.leaseId);
  if (!lease)
    throw new Error(`Harness sandbox lease not found: ${input.leaseId}`);
  const released: HarnessSandboxLease = {
    ...lease,
    updatedAt: new Date().toISOString(),
    status: "released",
    releaseReason: input.reason ?? "released by harness control plane",
  };
  atomicWriteJson(sandboxLeasePath(input.leaseId), released);
  return released;
}

function rolloutItemsFromTaskSet(
  taskSet: HarnessTaskSet,
  candidateTraceIdsByTask: Record<string, string>,
  sandboxLeaseIds: string[],
): HarnessRolloutItem[] {
  return taskSet.tasks.map((task, index) => {
    const candidateTraceId = candidateTraceIdsByTask[task.taskId];
    return {
      itemId: `rollout-item-${task.taskId}`,
      taskId: task.taskId,
      status: candidateTraceId ? "completed" : "planned",
      candidateTraceId,
      baselineTraceId: task.sourceTraceId,
      sandboxLeaseId:
        sandboxLeaseIds[index % Math.max(1, sandboxLeaseIds.length)],
    };
  });
}

export function createHarnessRolloutBatch(input: {
  batchId?: string;
  mode?: HarnessRolloutMode;
  taskSetId: string;
  candidateId: string;
  paddockId?: string;
  sandboxLeaseIds?: string[];
  candidateTraceIdsByTask?: Record<string, string>;
  trainingExportId?: string;
  rewardReportId?: string;
}): HarnessRolloutBatch {
  const taskSet = loadHarnessTaskSet(input.taskSetId);
  if (!taskSet)
    throw new Error(`Harness task set not found: ${input.taskSetId}`);
  if (!loadHarnessCandidate(input.candidateId))
    throw new Error(`Harness candidate not found: ${input.candidateId}`);
  if (input.paddockId && !loadHarnessPaddockAdapter(input.paddockId))
    throw new Error(`Harness paddock adapter not found: ${input.paddockId}`);
  for (const leaseId of input.sandboxLeaseIds ?? []) {
    if (!loadHarnessSandboxLease(leaseId))
      throw new Error(`Harness sandbox lease not found: ${leaseId}`);
  }
  const batchId =
    input.batchId?.trim() || `rollout-${randomUUID().slice(0, 8)}`;
  const items = rolloutItemsFromTaskSet(
    taskSet,
    input.candidateTraceIdsByTask ?? {},
    input.sandboxLeaseIds ?? [],
  );
  const completed = items.filter((item) => item.status === "completed").length;
  const now = new Date().toISOString();
  const batch: HarnessRolloutBatch = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    batchId,
    createdAt: now,
    updatedAt: now,
    mode: input.mode ?? "sync",
    status:
      completed === items.length
        ? "completed"
        : completed > 0
          ? "running"
          : "planned",
    taskSetId: input.taskSetId,
    candidateId: input.candidateId,
    paddockId: input.paddockId,
    sandboxLeaseIds: input.sandboxLeaseIds ?? [],
    candidateTraceIdsByTask: input.candidateTraceIdsByTask ?? {},
    trainingExportId: input.trainingExportId,
    rewardReportId: input.rewardReportId,
    items,
    reason:
      completed === items.length
        ? "all rollout task traces are mapped"
        : "waiting for candidate traces",
  };
  mkdirSync(rolloutBatchesDir(), { recursive: true });
  atomicWriteJson(rolloutBatchPath(batchId), batch);
  return batch;
}

export function loadHarnessRolloutBatch(
  batchId: string,
): HarnessRolloutBatch | undefined {
  return readJsonFile<HarnessRolloutBatch>(rolloutBatchPath(batchId));
}

export function listHarnessRolloutBatches(limit = 20): HarnessRolloutBatch[] {
  if (!existsSync(rolloutBatchesDir())) return [];
  return readdirSync(rolloutBatchesDir())
    .flatMap((name) => {
      const batch = readJsonFile<HarnessRolloutBatch>(
        join(rolloutBatchesDir(), name),
      );
      return batch ? [batch] : [];
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(1, limit));
}

export function registerHarnessRewardFunction(input: {
  rewardId?: string;
  kind: HarnessRewardFunctionKind;
  summary: string;
  weight?: number;
  sourceVerifierId?: string;
  rubric?: string;
}): HarnessRewardFunction {
  const rewardId =
    input.rewardId?.trim() ||
    `reward-${input.kind}-${randomUUID().slice(0, 8)}`;
  const reward: HarnessRewardFunction = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    rewardId,
    createdAt: new Date().toISOString(),
    kind: input.kind,
    summary: input.summary,
    weight: input.weight ?? 1,
    sourceVerifierId: input.sourceVerifierId,
    rubric: input.rubric,
  };
  mkdirSync(dirname(rewardFunctionPath(rewardId)), { recursive: true });
  atomicWriteJson(rewardFunctionPath(rewardId), reward);
  return reward;
}

export function loadHarnessRewardFunction(
  rewardId: string,
): HarnessRewardFunction | undefined {
  return readJsonFile<HarnessRewardFunction>(rewardFunctionPath(rewardId));
}

export function listHarnessRewardFunctions(
  limit = 20,
): HarnessRewardFunction[] {
  const dir = join(rewardsDir(), "functions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((name) => {
      const reward = readJsonFile<HarnessRewardFunction>(join(dir, name));
      return reward ? [reward] : [];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, limit));
}

function loadHarnessTaskSetEvaluation(
  taskSetId: string,
  candidateId: string,
): HarnessTaskSetEvaluation | undefined {
  return readJsonFile<HarnessTaskSetEvaluation>(
    taskSetEvaluationPath(taskSetId, candidateId),
  );
}

function rewardForResult(
  reward: HarnessRewardFunction,
  result: HarnessTaskRunResult,
  evaluation: HarnessTaskSetEvaluation,
): number {
  if (reward.kind === "binary_success") return result.verifier.passed ? 1 : 0;
  if (reward.kind === "policy_safe")
    return result.verifier.kind === "policy"
      ? result.verifier.passed
        ? 1
        : 0
      : evaluation.policyPassed
        ? 1
        : 0;
  if (reward.kind === "regression_delta")
    return Math.max(-1, Math.min(1, evaluation.selectionDelta));
  // heuristic_overlap: cheap proxy — blend the verifier score with the
  // selection delta so a reward report can be produced without an LLM judge.
  if (reward.kind === "heuristic_overlap")
    return Math.max(
      0,
      Math.min(1, 0.7 * result.score + 0.3 * Math.max(0, evaluation.selectionDelta)),
    );
  // llm_judge / verifier_score / custom: use the verifier-derived score that
  // was computed during task-set evaluation. The expensive LLM-as-judge pass
  // is provided separately by `llmJudgeFitness` for final/top-N comparison.
  return result.score;
}

export function evaluateHarnessReward(input: {
  rewardId: string;
  taskSetId: string;
  candidateId: string;
  rolloutBatchId?: string;
  trainingExportId?: string;
}): HarnessRewardReport {
  const reward = loadHarnessRewardFunction(input.rewardId);
  if (!reward)
    throw new Error(`Harness reward function not found: ${input.rewardId}`);
  const evaluation = loadHarnessTaskSetEvaluation(
    input.taskSetId,
    input.candidateId,
  );
  if (!evaluation)
    throw new Error(
      `Harness task set evaluation not found: ${input.taskSetId}/${input.candidateId}`,
    );
  const reportId = `reward-report-${safePathSegment(input.candidateId)}-${randomUUID().slice(0, 8)}`;
  const rewards = evaluation.results.map((result) => {
    const rawReward = rewardForResult(reward, result, evaluation);
    const scaled = Number((rawReward * reward.weight).toFixed(4));
    return {
      taskId: result.taskId,
      reward: scaled,
      sourceScore: result.score,
      passed: result.verifier.passed,
      reason: result.verifier.reason,
    };
  });
  const aggregateReward = rewards.length
    ? Number(
        (
          rewards.reduce((sum, item) => sum + item.reward, 0) / rewards.length
        ).toFixed(4),
      )
    : 0;
  const report: HarnessRewardReport = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    reportId,
    createdAt: new Date().toISOString(),
    rewardId: input.rewardId,
    taskSetId: input.taskSetId,
    candidateId: input.candidateId,
    evaluationPath: taskSetEvaluationPath(input.taskSetId, input.candidateId),
    rolloutBatchId: input.rolloutBatchId,
    trainingExportId: input.trainingExportId,
    rewards,
    aggregateReward,
    accepted: evaluation.accepted && aggregateReward > 0,
  };
  mkdirSync(dirname(rewardReportPath(reportId)), { recursive: true });
  atomicWriteJson(rewardReportPath(reportId), report);
  return report;
}

/**
 * LLM-as-judge fitness — expensive, multi-dimensional scoring via an LLM call.
 * Use for final/top-N comparison or when called from an explicit "llm_judge"
 * reward pipeline. Do NOT call inside tight loops; prefer {@link heuristicFitness}
 * for cheap per-iteration scoring.
 *
 * The judge evaluates the evolved artifact against the baseline on three
 * dimensions (correctness, procedure-following, conciseness) weighted by
 * the provided rubric, with a length penalty for bloat.
 */
export async function llmJudgeFitness(input: {
  provider: LLMProvider;
  rubric?: HarnessLLMJudgeRubric;
  taskDescription: string;
  baselineText: string;
  evolvedText: string;
  maxTokens?: number;
}): Promise<{
  score: number;
  feedback: string;
  dimensions: Record<string, number>;
}> {
  const rubric = input.rubric ?? DEFAULT_LLM_JUDGE_RUBRIC;
  const prompt = [
    "You are an evaluation judge for a harness artifact evolution system.",
    "Score the evolved artifact against the baseline on three dimensions (0.0 to 1.0 each):",
    `1. correctness (weight ${rubric.correctnessWeight}): Did the evolved version correctly address the task?`,
    `2. procedure_following (weight ${rubric.procedureWeight}): Does it follow the expected approach/procedure?`,
    `3. conciseness (weight ${rubric.concisenessWeight}): Is it appropriately concise without omitting important info?`,
    "",
    "Also provide specific, actionable feedback on what could be improved.",
    "",
    `Task description: ${input.taskDescription}`,
    "",
    "--- BASELINE ---",
    input.baselineText.slice(0, 4000),
    "",
    "--- EVOLVED ---",
    input.evolvedText.slice(0, 4000),
    "",
    "Respond with ONLY a JSON object: {\"correctness\": <0-1>, \"procedure_following\": <0-1>, \"conciseness\": <0-1>, \"feedback\": \"<text>\"}",
  ].join("\n");

  const response = await input.provider.execute({
    prompt,
    stepName: "llm-judge-fitness",
    round: 1,
  });

  const text =
    response.kind === "text" ? response.content : response.summary ?? "";

  // Parse JSON from response, tolerating surrounding text
  let correctness = 0.5;
  let procedureFollowing = 0.5;
  let conciseness = 0.5;
  let feedback = "";
  try {
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      correctness = clampScore(parsed.correctness);
      procedureFollowing = clampScore(parsed.procedure_following);
      conciseness = clampScore(parsed.conciseness);
      feedback = typeof parsed.feedback === "string" ? parsed.feedback : "";
    }
  } catch {
    feedback = `judge parse error — raw: ${text.slice(0, 200)}`;
  }

  // Length penalty (mirrors Hermes-ASE)
  let lengthPenalty = 0;
  const threshold = rubric.lengthPenaltyThreshold ?? 1.2;
  if (input.baselineText.length > 0) {
    const ratio = input.evolvedText.length / input.baselineText.length;
    if (ratio > threshold) {
      lengthPenalty = Math.min(0.3, (ratio - threshold) * 0.5);
    }
  }

  const raw =
    rubric.correctnessWeight * correctness +
    rubric.procedureWeight * procedureFollowing +
    rubric.concisenessWeight * conciseness;
  const score = Number(Math.max(0, Math.min(1, raw - lengthPenalty)).toFixed(4));

  return {
    score,
    feedback,
    dimensions: {
      correctness,
      procedure_following: procedureFollowing,
      conciseness,
      length_penalty: lengthPenalty,
    },
  };
}

function clampScore(value: unknown): number {
  if (typeof value === "number") return Math.max(0, Math.min(1, value));
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}

export function listHarnessRewardReports(limit = 20): HarnessRewardReport[] {
  const dir = join(rewardsDir(), "reports");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((name) => {
      const report = readJsonFile<HarnessRewardReport>(join(dir, name));
      return report ? [report] : [];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, limit));
}

export function completeHarnessRolloutBatch(input: {
  batchId: string;
  candidateTraceIdsByTask?: Record<string, string>;
  trainingExportId?: string;
  rewardReportId?: string;
  reason?: string;
}): HarnessRolloutBatch {
  const batch = loadHarnessRolloutBatch(input.batchId);
  if (!batch)
    throw new Error(`Harness rollout batch not found: ${input.batchId}`);
  const candidateTraceIdsByTask = {
    ...batch.candidateTraceIdsByTask,
    ...(input.candidateTraceIdsByTask ?? {}),
  };
  const taskSet = loadHarnessTaskSet(batch.taskSetId);
  if (!taskSet)
    throw new Error(`Harness task set not found: ${batch.taskSetId}`);
  const previousByTask = new Map(
    batch.items.map((item) => [item.taskId, item]),
  );
  const items = rolloutItemsFromTaskSet(
    taskSet,
    candidateTraceIdsByTask,
    batch.sandboxLeaseIds,
  ).map((item) => ({
    ...item,
    trajectoryId: previousByTask.get(item.taskId)?.trajectoryId,
    reward: previousByTask.get(item.taskId)?.reward,
  }));
  const completed = items.filter((item) => item.status === "completed").length;
  const updated: HarnessRolloutBatch = {
    ...batch,
    updatedAt: new Date().toISOString(),
    status: completed === items.length ? "completed" : "running",
    candidateTraceIdsByTask,
    trainingExportId: input.trainingExportId ?? batch.trainingExportId,
    rewardReportId: input.rewardReportId ?? batch.rewardReportId,
    items,
    reason:
      input.reason ??
      (completed === items.length
        ? "all rollout task traces are mapped"
        : "rollout still has unmapped task traces"),
  };
  atomicWriteJson(rolloutBatchPath(input.batchId), updated);
  return updated;
}

export function evaluateHarnessTaskSet(input: {
  candidateId: string;
  taskSetId: string;
  candidateTraceIdsByTask: Record<string, string>;
  baselineTraceIdsByTask?: Record<string, string>;
  runId?: string;
  skillVersion?: string;
}): HarnessTaskSetEvaluation {
  const taskSet = loadHarnessTaskSet(input.taskSetId);
  if (!taskSet)
    throw new Error(`Harness task set not found: ${input.taskSetId}`);
  const results: HarnessTaskRunResult[] = [];
  for (const task of taskSet.tasks) {
    const verifier =
      loadHarnessVerifier(task.verifierId) ??
      defaultVerifier(task.verifierId as HarnessVerifierKind);
    const candidateTraceId = input.candidateTraceIdsByTask[task.taskId];
    const baselineTraceId =
      input.baselineTraceIdsByTask?.[task.taskId] ?? task.sourceTraceId;
    const candidateTrace = candidateTraceId
      ? loadTraceById(candidateTraceId)
      : null;
    const verifierResult = runHarnessVerifier(verifier, task, candidateTrace);
    const trajectory = candidateTraceId
      ? createHarnessTrajectory({
          traceId: candidateTraceId,
          taskId: task.taskId,
          runId: input.runId,
          candidateId: input.candidateId,
          skillVersion: input.skillVersion,
          toolsets: task.toolsets,
        })
      : undefined;
    const baseline = baselineTraceId ? loadTraceById(baselineTraceId) : null;
    const candidateScore = verifierResult.passed
      ? Math.max(verifierResult.score, traceScore(candidateTrace))
      : verifierResult.score;
    results.push({
      taskId: task.taskId,
      baselineTraceId,
      candidateTraceId,
      completed: candidateTrace?.finalStatus === "approved",
      score: candidateScore,
      verifier: verifierResult,
      trajectoryId: trajectory?.trajectoryId,
    });
    if (
      baseline &&
      candidateTrace &&
      task.criticality === "critical-regression"
    ) {
      const regression = compareRegression(
        evaluatePipelineTrace(candidateTrace),
        evaluatePipelineTrace(baseline),
      );
      if (!regression.pass) {
        results.at(-1)!.verifier = {
          ...results.at(-1)!.verifier,
          passed: false,
          score: 0,
          reason: regression.message ?? "critical regression",
          evidence: [
            ...results.at(-1)!.verifier.evidence,
            baseline.id,
            candidateTrace.id,
          ],
        };
        results.at(-1)!.score = 0;
      }
    }
  }
  const selection = results.filter((result) =>
    taskSet.selectionTaskIds.includes(result.taskId),
  );
  const regression = results.filter((result) =>
    taskSet.regressionTaskIds.includes(result.taskId),
  );
  const selectionAverage = selection.length
    ? selection.reduce((sum, result) => sum + result.score, 0) /
      selection.length
    : 0;
  const baselineAverage = selection.length
    ? selection.reduce(
        (sum, result) =>
          sum +
          traceScore(
            result.baselineTraceId
              ? loadTraceById(result.baselineTraceId)
              : null,
          ),
        0,
      ) / selection.length
    : 0;
  const selectionDelta = Number(
    (selectionAverage - baselineAverage).toFixed(4),
  );
  const regressionPassed = regression.every((result) => result.verifier.passed);
  const policyPassed = results
    .filter((result) => {
      const task = taskSet.tasks.find((t) => t.taskId === result.taskId);
      const verifier = task
        ? (loadHarnessVerifier(task.verifierId) ??
          defaultVerifier(task.verifierId as HarnessVerifierKind))
        : undefined;
      return verifier?.kind === "policy";
    })
    .every((result) => result.verifier.passed);
  const accepted =
    selectionDelta > 0 &&
    regressionPassed &&
    policyPassed &&
    results.every((result) => result.verifier.passed);
  mkdirSync(
    join(taskSetsDir(), safePathSegment(input.taskSetId), "evaluations"),
    { recursive: true },
  );
  const replay = createHarnessReplayManifest({
    runId: input.runId,
    taskSetId: input.taskSetId,
    candidateId: input.candidateId,
    trajectoryIds: results.flatMap((result) =>
      result.trajectoryId ? [result.trajectoryId] : [],
    ),
  });
  for (const result of results) result.replayId = replay.replayId;
  const evaluation: HarnessTaskSetEvaluation = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    taskSetId: input.taskSetId,
    candidateId: input.candidateId,
    evaluatedAt: new Date().toISOString(),
    results,
    selectionDelta,
    regressionPassed,
    policyPassed,
    accepted,
    reason: accepted
      ? "taskset selection improved and regression/policy tasks passed"
      : selectionDelta <= 0
        ? "taskset selection did not improve"
        : !regressionPassed
          ? "critical regression task failed"
          : !policyPassed
            ? "policy task failed"
            : "one or more task verifiers failed",
  };
  atomicWriteJson(
    taskSetEvaluationPath(input.taskSetId, input.candidateId),
    evaluation,
  );
  return evaluation;
}

export function selectHarnessCoreset(
  input: {
    limit?: number;
    since?: string;
    traceIds?: string[];
  } = {},
): HarnessCoresetItem[] {
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
    .sort(
      (a, b) =>
        b.item.difficulty - a.item.difficulty ||
        b.trace.timestamp.localeCompare(a.trace.timestamp),
    );

  const selected: HarnessCoresetItem[] = [];
  const seenKeys = new Set<string>();
  for (const entry of ranked) {
    if (selected.length >= limit) break;
    if (
      seenKeys.has(entry.item.diversityKey) &&
      selected.length < Math.ceil(limit / 2)
    )
      continue;
    selected.push(entry.item);
    seenKeys.add(entry.item.diversityKey);
  }
  for (const entry of ranked) {
    if (selected.length >= limit) break;
    if (!selected.some((item) => item.traceId === entry.item.traceId))
      selected.push(entry.item);
  }
  return selected;
}

function improvementReason(
  candidate: PipelineTrace,
  baseline: PipelineTrace,
): string | undefined {
  const c = evaluatePipelineTrace(candidate);
  const b = evaluatePipelineTrace(baseline);
  if (c.success && !b.success)
    return "candidate succeeded where baseline failed";
  if (c.success === b.success && c.durationMs < b.durationMs)
    return "candidate reduced duration";
  if (c.success === b.success && c.roundCount < b.roundCount)
    return "candidate reduced rounds";
  return undefined;
}

function emptySplit(split: "held-in" | "held-out"): HarnessSplitGate {
  return { split, total: 0, passed: 0, regressions: [], improvements: [] };
}

export function evaluateHarnessCandidate(
  input: HarnessEvalInput,
): HarnessGateResult {
  const candidate = loadHarnessCandidate(input.candidateId);
  if (!candidate)
    throw new Error(`Harness candidate not found: ${input.candidateId}`);

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
        message: !baseline
          ? "baseline trace missing"
          : "candidate trace missing",
      });
      bySplit[pair.split].total += 1;
      continue;
    }

    const split = bySplit[pair.split];
    split.total += 1;
    const reason = improvementReason(actual, baseline);
    if (reason) {
      split.passed += 1;
      split.improvements.push({
        baselineTraceId: baseline.id,
        candidateTraceId: actual.id,
        reason,
      });
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
  const regressionCount =
    heldIn.regressions.length + heldOut.regressions.length;
  const improvementCount =
    heldIn.improvements.length + heldOut.improvements.length;
  const hasBothSplits = heldIn.total > 0 && heldOut.total > 0;
  const accepted =
    hasBothSplits && regressionCount === 0 && improvementCount > 0;
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

function rankScore(record: HarnessCandidateRecord): {
  score: number;
  reasons: string[];
} {
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
  const improvementCount =
    gate.heldIn.improvements.length + gate.heldOut.improvements.length;
  const regressionCount =
    gate.heldIn.regressions.length + gate.heldOut.regressions.length;
  score += improvementCount * 10;
  score -= regressionCount * 25;
  score += gate.heldOut.passed * 3 + gate.heldIn.passed;
  if (record.manifest.expectedFixes.length)
    score += Math.min(5, record.manifest.expectedFixes.length);
  reasons.push(
    `${improvementCount} improvement(s), ${regressionCount} regression(s)`,
  );
  return { score, reasons };
}

function readVariantTextFiles(
  record: HarnessCandidateRecord,
  files: string[],
): Array<{ path: string; text: string }> {
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

function addFinding(
  findings: HarnessAuditFinding[],
  severity: HarnessAuditSeverity,
  rule: string,
  message: string,
  evidence: string[],
): void {
  findings.push({ severity, rule, message, evidence });
}

export function auditHarnessCandidate(input: {
  candidateId: string;
  datasetId?: string;
  leakageTerms?: string[];
}): HarnessAuditReport {
  const record = loadHarnessCandidate(input.candidateId);
  if (!record)
    throw new Error(`Harness candidate not found: ${input.candidateId}`);
  const dataset = input.datasetId
    ? loadHarnessDataset(input.datasetId)
    : undefined;
  if (input.datasetId && !dataset)
    throw new Error(`Harness dataset not found: ${input.datasetId}`);
  const findings: HarnessAuditFinding[] = [];
  const proposal = record.proposal;
  if (!proposal)
    addFinding(
      findings,
      "blocker",
      "proposal-required",
      "candidate has no proposal",
      [record.candidateId],
    );
  if (proposal?.failed)
    addFinding(
      findings,
      "blocker",
      "proposal-failed",
      "proposal is marked failed",
      [proposal.error ?? "failed"],
    );
  if (proposal?.surfaceViolations.length)
    addFinding(
      findings,
      "blocker",
      "surface-violation",
      "proposal modified files outside editable surface",
      proposal.surfaceViolations,
    );
  if (proposal?.unreportedFilesModified.length)
    addFinding(
      findings,
      "blocker",
      "unreported-files",
      "observed variant files were not reported by provider",
      proposal.unreportedFilesModified,
    );
  if (proposal?.reportedButUnchangedFiles.length)
    addFinding(
      findings,
      "warning",
      "reported-unchanged-files",
      "provider reported files that did not change",
      proposal.reportedButUnchangedFiles,
    );

  const changedFiles = proposal?.observedFilesModified ?? [];
  const texts = readVariantTextFiles(record, changedFiles);
  const terms = [
    ...(input.leakageTerms ?? []),
    ...(dataset?.leakageTerms ?? []),
    ...(dataset?.heldOut.flatMap((item) => [
      item.baselineTraceId,
      ...item.failureSignatureIds,
    ]) ?? []),
  ].filter((term) => term.length >= 4);
  for (const term of [...new Set(terms)]) {
    const matches = texts
      .filter((file) => file.text.includes(term))
      .map((file) => file.path);
    if (matches.length) {
      addFinding(
        findings,
        "blocker",
        "leakage-term",
        `candidate variant contains leakage term: ${term}`,
        matches,
      );
    }
  }
  for (const file of changedFiles) {
    if (!isAllowedByEditableSurface(file, record.manifest.editableSurface)) {
      addFinding(
        findings,
        "blocker",
        "editable-surface",
        `changed file is outside editable surface: ${file}`,
        [file],
      );
    }
  }
  if (!changedFiles.length)
    addFinding(
      findings,
      "blocker",
      "empty-diff",
      "candidate has no observed variant diff",
      [record.candidateId],
    );

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
  atomicWriteJson(candidatePath(record.candidateId), {
    ...record,
    audit: report,
  } satisfies HarnessCandidateRecord);
  return report;
}

export function rankHarnessCandidates(
  candidateIds?: string[],
): HarnessCandidateRank[] {
  const records = candidateIds?.length
    ? candidateIds.flatMap((id) => {
        const record = loadHarnessCandidate(id);
        return record ? [record] : [];
      })
    : listHarnessCandidates();

  const scored = records.map((record) => ({
    record,
    ...rankScore(record),
    wins: 0,
    losses: 0,
  }));
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
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.wins - a.wins ||
        a.record.createdAt.localeCompare(b.record.createdAt),
    )
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
    atomicWriteJson(candidatePath(rank.candidateId), {
      ...record,
      ranking: rank,
    });
    atomicWriteJson(rankingPath(rank.candidateId), rank);
  }
  return ranks;
}

function frontierEntry(record: HarnessCandidateRecord): HarnessFrontierEntry {
  const gate = record.gate;
  const audit = record.audit;
  const score = rankScore(record);
  const regressionCount = gate
    ? gate.heldIn.regressions.length + gate.heldOut.regressions.length
    : 0;
  const improvementCount = gate
    ? gate.heldIn.improvements.length + gate.heldOut.improvements.length
    : 0;
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
      audit
        ? audit.passed
          ? "audit passed"
          : `audit blocked: ${audit.findings.filter((f) => f.severity === "blocker").length} blocker(s)`
        : "no audit",
      record.status === "accepted" ? "accepted" : `status=${record.status}`,
    ],
  };
}

export function updateHarnessFrontier(
  input: {
    frontierId?: string;
    candidateIds?: string[];
  } = {},
): HarnessFrontier {
  const records = input.candidateIds?.length
    ? input.candidateIds.flatMap((id) => {
        const record = loadHarnessCandidate(id);
        return record ? [record] : [];
      })
    : listHarnessCandidates();
  const candidateIds = records.map((record) => record.candidateId);
  if (candidateIds.length) rankHarnessCandidates(candidateIds);
  const refreshed = candidateIds.flatMap((id) => {
    const record = loadHarnessCandidate(id);
    return record ? [record] : [];
  });
  const entries = refreshed
    .map(frontierEntry)
    .sort(
      (a, b) =>
        Number(b.accepted) - Number(a.accepted) ||
        Number(b.auditPassed) - Number(a.auditPassed) ||
        b.score - a.score,
    );
  const frontier: HarnessFrontier = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    frontierId: input.frontierId ?? "default",
    updatedAt: new Date().toISOString(),
    candidateIds,
    entries,
    rejectedCandidateIds: entries
      .filter(
        (entry) => !entry.accepted || !entry.auditPassed || !entry.gateAccepted,
      )
      .map((entry) => entry.candidateId),
  };
  mkdirSync(frontiersDir(), { recursive: true });
  atomicWriteJson(frontierPath(frontier.frontierId), frontier);
  return frontier;
}

function acceptanceChecks(
  record: HarnessCandidateRecord,
): HarnessAcceptanceChecks {
  const proposal = record.proposal;
  const audit = record.audit;
  const gateAccepted = record.gate?.accepted === true;
  const proposalPresent = proposal !== undefined;
  const proposalClean = proposalPresent && proposal.failed !== true;
  const observedDiffPresent = (proposal?.observedFilesModified.length ?? 0) > 0;
  const noSurfaceViolations = (proposal?.surfaceViolations.length ?? 0) === 0;
  const noUnreportedFiles =
    (proposal?.unreportedFilesModified.length ?? 0) === 0;
  const noReportedButUnchangedFiles =
    (proposal?.reportedButUnchangedFiles.length ?? 0) === 0;
  const auditPassed = audit?.passed === true;
  const reasons: string[] = [];
  if (!gateAccepted)
    reasons.push(
      record.gate
        ? `gate rejected: ${record.gate.reason}`
        : "missing held-in/held-out gate",
    );
  if (!proposalPresent) reasons.push("missing proposal");
  if (proposalPresent && !proposalClean)
    reasons.push(
      proposal?.error
        ? `proposal failed: ${proposal.error}`
        : "proposal failed",
    );
  if (proposalPresent && !observedDiffPresent)
    reasons.push("proposal has no observed variant diff");
  if (proposalPresent && !noSurfaceViolations)
    reasons.push(
      `surface violations: ${proposal.surfaceViolations.join(", ")}`,
    );
  if (proposalPresent && !noUnreportedFiles)
    reasons.push(
      `unreported files: ${proposal.unreportedFilesModified.join(", ")}`,
    );
  if (proposalPresent && !noReportedButUnchangedFiles)
    reasons.push(
      `reported but unchanged files: ${proposal.reportedButUnchangedFiles.join(", ")}`,
    );
  if (!auditPassed)
    reasons.push(
      audit
        ? `audit blocked: ${audit.findings.filter((finding) => finding.severity === "blocker").length} blocker(s)`
        : "missing audit report",
    );
  const accepted =
    gateAccepted &&
    proposalPresent &&
    proposalClean &&
    observedDiffPresent &&
    noSurfaceViolations &&
    noUnreportedFiles &&
    noReportedButUnchangedFiles &&
    auditPassed;
  if (accepted)
    reasons.push(
      "proposal, audit, observed diff, and held-in/held-out gate accepted",
    );
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

function rejectedSimilarityKeys(
  record: HarnessCandidateRecord,
  reason: string,
): string[] {
  return [
    record.manifest.summary.toLowerCase().slice(0, 80),
    ...record.manifest.failureSignatureIds,
    ...(record.proposal?.observedFilesModified ?? []),
    reason.toLowerCase().slice(0, 80),
  ].filter(Boolean);
}

export function recordHarnessRejectedBuffer(input: {
  candidateId: string;
  patchId?: string;
  selectionDelta?: number;
  regressionFailures?: string[];
  rejectionReason: string;
  reviewNotes?: string;
}): HarnessRejectedBufferEntry {
  const record = loadHarnessCandidate(input.candidateId);
  if (!record)
    throw new Error(`Harness candidate not found: ${input.candidateId}`);
  const rejectedId = `reject-${safePathSegment(input.candidateId)}-${randomUUID().slice(0, 8)}`;
  const gateRegressionFailures = [
    ...(record.gate?.heldIn.regressions.map(
      (regression) => regression.message,
    ) ?? []),
    ...(record.gate?.heldOut.regressions.map(
      (regression) => regression.message,
    ) ?? []),
  ];
  const entry: HarnessRejectedBufferEntry = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    rejectedId,
    createdAt: new Date().toISOString(),
    candidateId: input.candidateId,
    patchId: input.patchId,
    sourceFailureSignatureIds: record.manifest.failureSignatureIds,
    sourceTraceIds: record.manifest.evidenceTraceIds,
    selectionDelta: input.selectionDelta,
    regressionFailures: input.regressionFailures ?? gateRegressionFailures,
    rejectionReason: input.rejectionReason,
    reviewNotes: input.reviewNotes,
    similarityKeys: rejectedSimilarityKeys(record, input.rejectionReason),
    optimizerOnly: true,
  };
  mkdirSync(rejectedBufferDir(), { recursive: true });
  atomicWriteJson(rejectedEntryPath(rejectedId), entry);
  return entry;
}

export function listHarnessRejectedBuffer(
  limit = 20,
): HarnessRejectedBufferEntry[] {
  if (!existsSync(rejectedBufferDir())) return [];
  return readdirSync(rejectedBufferDir())
    .flatMap((name) => {
      const entry = readJsonFile<HarnessRejectedBufferEntry>(
        join(rejectedBufferDir(), name),
      );
      return entry ? [entry] : [];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, limit));
}

export function decideHarnessSkillPatch(input: {
  candidateId: string;
  baseSkill: string;
  candidateSkill?: string;
  patchId?: string;
  patchBudget?: { maxFiles?: number; maxBytes?: number };
  selectionDelta?: number;
  regressionPassed?: boolean;
  policyPassed?: boolean;
  auditPassed?: boolean;
  accepted?: boolean;
  reason?: string;
}): HarnessSkillPatchDecision {
  const record = loadHarnessCandidate(input.candidateId);
  if (!record)
    throw new Error(`Harness candidate not found: ${input.candidateId}`);
  const maxFiles = Math.max(
    1,
    input.patchBudget?.maxFiles ??
      Math.max(1, record.proposal?.observedFilesModified.length ?? 1),
  );
  const touchedSurfaces =
    record.proposal?.observedFilesModified ?? record.manifest.editableSurface;
  const patchWithinBudget = touchedSurfaces.length <= maxFiles;
  const selectionDelta =
    input.selectionDelta ??
    (record.gate
      ? Number(
          (
            (record.gate.heldIn.improvements.length +
              record.gate.heldOut.improvements.length -
              (record.gate.heldIn.regressions.length +
                record.gate.heldOut.regressions.length)) /
            Math.max(1, record.gate.heldIn.total + record.gate.heldOut.total)
          ).toFixed(4),
        )
      : 0);
  const regressionPassed =
    input.regressionPassed ??
    (record.gate?.heldOut.regressions.length === 0 &&
      record.gate?.heldIn.regressions.length === 0);
  const policyPassed =
    input.policyPassed ??
    (record.proposal?.surfaceViolations.length ?? 0) === 0;
  const auditPassed = input.auditPassed ?? record.audit?.passed === true;
  const accepted =
    input.accepted ??
    (selectionDelta > 0 &&
      regressionPassed &&
      policyPassed &&
      auditPassed &&
      patchWithinBudget);
  const decision = accepted
    ? "accept"
    : record.status === "rolled_back"
      ? "rollback"
      : "reject";
  const reason =
    input.reason ??
    (accepted
      ? "skill patch accepted by selection, regression, policy, audit, and budget gates"
      : !patchWithinBudget
        ? "skill patch exceeds patch budget"
        : selectionDelta <= 0
          ? "selection delta is not positive"
          : !regressionPassed
            ? "regression gate failed"
            : !policyPassed
              ? "policy gate failed"
              : !auditPassed
                ? "audit gate failed"
                : "skill patch rejected");
  const patch: HarnessSkillPatchDecision = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    patchId:
      input.patchId?.trim() ||
      `skillpatch-${safePathSegment(input.candidateId)}-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    candidateId: input.candidateId,
    baseSkill: input.baseSkill,
    candidateSkill:
      input.candidateSkill ??
      `${input.baseSkill}-candidate-${input.candidateId}`,
    touchedSurfaces,
    patchBudget: { maxFiles, maxBytes: input.patchBudget?.maxBytes },
    selectionDelta,
    regressionPassed,
    policyPassed,
    auditPassed,
    accepted,
    decision,
    reason,
    rollbackRef: accepted ? undefined : decisionPath(input.candidateId),
  };
  atomicWriteJson(skillPatchPath(input.candidateId), patch);
  if (!accepted) {
    recordHarnessRejectedBuffer({
      candidateId: input.candidateId,
      patchId: patch.patchId,
      selectionDelta,
      rejectionReason: reason,
    });
  }
  return patch;
}

function evaluateHarnessRolePolicy(
  plan: HarnessEvolutionPlan,
): HarnessRoleEvidence {
  const builderProvider = plan.rolePolicy?.builderProvider ?? plan.provider;
  const reviewerProvider = plan.rolePolicy?.reviewerProvider;
  const verifierProvider = plan.rolePolicy?.verifierProvider;
  const requireIndependentReviewer =
    plan.rolePolicy?.requireIndependentReviewer ?? false;
  const requireIndependentVerifier =
    plan.rolePolicy?.requireIndependentVerifier ?? false;
  const independentReviewer =
    !requireIndependentReviewer ||
    Boolean(reviewerProvider && reviewerProvider !== builderProvider);
  const independentVerifier =
    !requireIndependentVerifier ||
    Boolean(
      verifierProvider &&
      verifierProvider !== builderProvider &&
      verifierProvider !== reviewerProvider,
    );
  const reasons: string[] = [];
  if (!independentReviewer)
    reasons.push(
      "reviewerProvider must be present and different from builderProvider",
    );
  if (!independentVerifier)
    reasons.push(
      "verifierProvider must be present and different from builderProvider/reviewerProvider",
    );
  if (!reasons.length) reasons.push("role policy passed");
  return {
    builderProvider,
    reviewerProvider,
    verifierProvider,
    independentReviewer,
    independentVerifier,
    passed: independentReviewer && independentVerifier,
    reasons,
  };
}

export function decideHarnessCandidate(input: {
  candidateId: string;
  decision?: "accept" | "rollback";
  reason?: string;
}): HarnessDecisionRecord {
  const record = loadHarnessCandidate(input.candidateId);
  if (!record)
    throw new Error(`Harness candidate not found: ${input.candidateId}`);
  const checks = acceptanceChecks(record);
  const autoDecision = checks.accepted ? "accept" : "rollback";
  const decision = input.decision ?? autoDecision;
  if (decision === "accept" && !checks.accepted) {
    throw new Error(
      `Harness candidate cannot be accepted: ${checks.reasons.join("; ")}`,
    );
  }
  const nextStatus = decision === "accept" ? "accepted" : "rolled_back";
  const decisionRecord: HarnessDecisionRecord = {
    candidateId: input.candidateId,
    decision,
    decidedAt: new Date().toISOString(),
    reason:
      input.reason ??
      (decision === "accept"
        ? "accepted by proposal, audit, observed diff, and regression gate"
        : checks.reasons.join("; ") || "rolled back without passing gate"),
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
  if (!record)
    throw new Error(`Harness candidate not found: ${input.candidateId}`);
  if (record.status !== "accepted")
    throw new Error(`Harness candidate is not accepted: ${input.candidateId}`);
  if (!record.proposal)
    throw new Error(`Harness candidate has no proposal: ${input.candidateId}`);
  if (!record.gate)
    throw new Error(
      `Harness candidate has no gate result: ${input.candidateId}`,
    );
  if (!record.decision)
    throw new Error(
      `Harness candidate has no decision record: ${input.candidateId}`,
    );
  if (!record.decision.acceptanceChecks.accepted) {
    throw new Error(
      `Harness candidate acceptance checks are not passing: ${input.candidateId}`,
    );
  }

  const dir = promotionDir(input.candidateId);
  const filesDir = join(dir, "files");
  mkdirSync(filesDir, { recursive: true });
  const files = record.proposal.observedFilesModified.map((file) =>
    copyPromotionFile(record.variant.variantDir, filesDir, file),
  );
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
    skillPatch: readJsonFile<HarnessSkillPatchDecision>(
      skillPatchPath(input.candidateId),
    ),
    instructions: [
      "Review this promotion bundle before applying anything to a user repository.",
      "Files under files/ are copied from the accepted candidate variant directory.",
      "This bundle is audit evidence only; runoff did not mutate the source repository.",
    ],
  };
  atomicWriteJson(join(dir, "bundle.json"), bundle);
  return bundle;
}

export function loadHarnessEvolutionRun(
  runId: string,
): HarnessEvolutionRun | undefined {
  return readJsonFile<HarnessEvolutionRun>(runPath(runId));
}

export function listHarnessEvolutionRuns(): HarnessEvolutionRun[] {
  if (!existsSync(runsDir())) return [];
  return readdirSync(runsDir())
    .flatMap((name) => {
      const run = readJsonFile<HarnessEvolutionRun>(
        join(runsDir(), name, "run.json"),
      );
      return run ? [run] : [];
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function artifactRefsForRun(
  runId: string,
  plan: HarnessEvolutionPlan,
  includePromotion: boolean,
): string[] {
  const refs = [
    runPlanPath(runId),
    runPath(runId),
    runReportPath(runId),
    datasetPath(plan.datasetId),
    ...(plan.taskSetId
      ? [
          taskSetPath(plan.taskSetId),
          taskSetEvaluationPath(plan.taskSetId, plan.candidateId),
        ]
      : []),
    candidatePath(plan.candidateId),
    proposalPath(plan.candidateId),
    auditPath(plan.candidateId),
    gatePath(plan.candidateId),
    rankingPath(plan.candidateId),
    frontierPath(plan.frontierId),
    decisionPath(plan.candidateId),
    skillPatchPath(plan.candidateId),
  ];
  if (includePromotion)
    refs.push(join(promotionDir(plan.candidateId), "bundle.json"));
  return refs;
}

function buildHarnessEvolutionReport(
  run: HarnessEvolutionRun,
): HarnessEvolutionReport {
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
    taskSetId: run.plan.taskSetId,
    frontierId: run.plan.frontierId,
    triggerEventId: run.plan.triggerEventId,
    gateAccepted: run.evaluation?.gate.accepted,
    auditPassed: run.audit?.passed,
    rolePolicyPassed: run.roleEvidence?.passed,
    taskSetAccepted: run.taskSetEvaluation?.accepted,
    connectorWritebacks: run.connectorWritebacks ?? [],
    decision: run.decision?.decision,
    skillPatchId: run.skillPatch?.patchId,
    exportedBundleDir: run.bundle?.bundleDir,
    missingCandidateTraceIds: run.missingCandidateTraceIds,
    artifactRefs: run.artifactRefs,
  };
}

function persistHarnessEvolutionRun(
  run: HarnessEvolutionRun,
): HarnessEvolutionRun {
  mkdirSync(runDir(run.runId), { recursive: true });
  atomicWriteJson(runPlanPath(run.runId), run.plan);
  atomicWriteJson(runPath(run.runId), run);
  atomicWriteJson(runReportPath(run.runId), buildHarnessEvolutionReport(run));
  return run;
}

function renderHarnessReportMarkdown(report: HarnessEvolutionReport): string {
  return [
    `# Harness Evolution Report: ${report.runId}`,
    "",
    `- Status: ${report.status}`,
    `- Summary: ${report.summary}`,
    `- Next action: ${report.nextAction}`,
    `- Candidate: ${report.candidateId}`,
    `- Dataset: ${report.datasetId}`,
    `- Frontier: ${report.frontierId}`,
    `- Gate accepted: ${report.gateAccepted ?? "unknown"}`,
    `- Audit passed: ${report.auditPassed ?? "unknown"}`,
    `- Role policy passed: ${report.rolePolicyPassed ?? "unknown"}`,
    `- Decision: ${report.decision ?? "none"}`,
    "",
    "## Missing Candidate Trace Mappings",
    report.missingCandidateTraceIds.length
      ? report.missingCandidateTraceIds.map((id) => `- ${id}`).join("\n")
      : "- none",
    "",
    "## Artifacts",
    report.artifactRefs.map((ref) => `- ${ref}`).join("\n"),
    "",
  ].join("\n");
}

export function writeHarnessConnectorReport(input: {
  runId: string;
  targets?: HarnessConnectorTarget[];
}): HarnessConnectorWriteback[] {
  const run = loadHarnessEvolutionRun(input.runId);
  if (!run) throw new Error(`Harness evolution run not found: ${input.runId}`);
  const report = queryHarnessEvolutionReport(input.runId);
  const targets = input.targets?.length ? input.targets : run.plan.connectors;
  const writebacks: HarnessConnectorWriteback[] = [];
  for (const target of targets) {
    const path = resolve(
      target.path ?? connectorDefaultPath(input.runId, target.kind),
    );
    mkdirSync(dirname(path), { recursive: true });
    if (target.kind === "markdown") {
      atomicWriteJson(`${path}.meta.json`, {
        schema: HARNESS_EVOLUTION_SCHEMA,
        runId: input.runId,
        path,
      });
      // Keep the human-facing file plain Markdown while preserving atomic metadata separately.
      const content = renderHarnessReportMarkdown(report);
      const tmpPath = `${path}.${randomUUID().slice(0, 8)}.tmp`;
      writeFileSync(tmpPath, content, "utf-8");
      renameSync(tmpPath, path);
    } else {
      const row = JSON.stringify({
        ...report,
        writtenAt: new Date().toISOString(),
      });
      const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
      const tmpPath = `${path}.${randomUUID().slice(0, 8)}.tmp`;
      writeFileSync(tmpPath, `${existing}${row}\n`, "utf-8");
      renameSync(tmpPath, path);
    }
    writebacks.push({
      schema: HARNESS_EVOLUTION_SCHEMA,
      writebackId: `writeback-${randomUUID().slice(0, 8)}`,
      runId: input.runId,
      kind: target.kind,
      writtenAt: new Date().toISOString(),
      path,
      status: "written",
    });
  }
  const nextRun = {
    ...run,
    connectorWritebacks: writebacks,
  } satisfies HarnessEvolutionRun;
  persistHarnessEvolutionRun(nextRun);
  return writebacks;
}

function triggerEventFromRule(
  rule: HarnessTriggerRule,
  traceIds: string[],
  candidateIds: string[],
): HarnessTriggerEvent {
  const eventId = `trigger-${rule.ruleId}-${randomUUID().slice(0, 8)}`;
  const plan =
    rule.allowedAction === "report"
      ? undefined
      : createHarnessEvolutionPlan({
          runId: `run-${eventId}`,
          summary: rule.summary,
          traceIds,
          candidateId: candidateIds[0],
          frontierId: rule.frontierId,
          triggerEventId: eventId,
          autoDecide: false,
          exportOnAccept: rule.allowedAction === "export",
        });
  return {
    schema: HARNESS_EVOLUTION_SCHEMA,
    eventId,
    ruleId: rule.ruleId,
    kind: rule.kind,
    createdAt: new Date().toISOString(),
    allowedAction: rule.allowedAction,
    summary: rule.summary,
    traceIds,
    candidateIds,
    frontierId: rule.frontierId,
    plan,
    nextAction: plan
      ? "review pending harness evolution plan before running"
      : "inspect trigger report and decide whether to create a harness evolution run",
  };
}

export function scanHarnessTriggers(input: {
  rules: HarnessTriggerRule[];
  scanId?: string;
}): HarnessTriggerScan {
  const events: HarnessTriggerEvent[] = [];
  for (const rule of input.rules.filter((item) => item.enabled)) {
    if (rule.kind === "trace_failure") {
      const traces = (
        rule.traceIds?.length
          ? rule.traceIds.flatMap((id) => {
              const trace = loadTraceById(id);
              return trace ? [trace] : [];
            })
          : queryTraces({})
      ).filter(
        (trace) =>
          trace.finalStatus === "failed" ||
          trace.finalStatus === "max_rounds" ||
          trace.finalStatus === "aborted",
      );
      const traceIds = traces.map((trace) => trace.id);
      if (traceIds.length >= (rule.minFailureCount ?? 1))
        events.push(triggerEventFromRule(rule, traceIds, []));
    }
    if (rule.kind === "audit_blocker") {
      const blocked = listHarnessCandidates().filter(
        (candidate) => candidate.audit?.passed === false,
      );
      const candidateIds = blocked.map((candidate) => candidate.candidateId);
      if (candidateIds.length >= (rule.minBlockedAudits ?? 1)) {
        const traceIds = [
          ...new Set(
            blocked.flatMap((candidate) => candidate.manifest.evidenceTraceIds),
          ),
        ];
        events.push(triggerEventFromRule(rule, traceIds, candidateIds));
      }
    }
    if (rule.kind === "frontier_stagnation") {
      const frontier = readJsonFile<HarnessFrontier>(
        frontierPath(rule.frontierId ?? "default"),
      );
      const rejectedCandidateIds = frontier?.rejectedCandidateIds ?? [];
      if (
        frontier &&
        rejectedCandidateIds.length > 0 &&
        !frontier.entries.some((entry) => entry.accepted)
      ) {
        events.push(triggerEventFromRule(rule, [], rejectedCandidateIds));
      }
    }
  }
  const scan: HarnessTriggerScan = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    scanId: input.scanId?.trim() || `scan-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    rules: input.rules,
    events,
    artifactRefs: [],
  };
  mkdirSync(join(triggersDir(), "events"), { recursive: true });
  mkdirSync(join(triggersDir(), "scans"), { recursive: true });
  for (const event of events)
    atomicWriteJson(triggerEventPath(event.eventId), event);
  const refs = [
    triggerScanPath(scan.scanId),
    ...events.map((event) => triggerEventPath(event.eventId)),
  ];
  const persisted = { ...scan, artifactRefs: refs };
  atomicWriteJson(triggerScanPath(scan.scanId), persisted);
  return persisted;
}

function createHarnessEvolutionPlan(input: {
  runId: string;
  summary: string;
  traceIds?: string[];
  failureSignatureIds?: string[];
  datasetId?: string;
  taskSetId?: string;
  candidateId?: string;
  frontierId?: string;
  sourceDir?: string;
  provider?: string;
  editableSurface?: string[];
  expectedFixes?: string[];
  possibleRegressions?: string[];
  leakageTerms?: string[];
  instructions?: string;
  triggerEventId?: string;
  rolePolicy?: HarnessRolePolicy;
  connectors?: HarnessConnectorTarget[];
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
    taskSetId: input.taskSetId?.trim(),
    candidateId: input.candidateId?.trim() || `candidate-${input.runId}`,
    frontierId: input.frontierId?.trim() || "default",
    sourceDir: input.sourceDir,
    provider: input.provider,
    editableSurface: input.editableSurface ?? [],
    expectedFixes: input.expectedFixes ?? [],
    possibleRegressions: input.possibleRegressions ?? [],
    leakageTerms: input.leakageTerms ?? [],
    instructions: input.instructions,
    triggerEventId: input.triggerEventId,
    rolePolicy: input.rolePolicy,
    connectors: input.connectors ?? [],
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
  taskSetId?: string;
  candidateId?: string;
  frontierId?: string;
  sourceDir?: string;
  editableSurface?: string[];
  expectedFixes?: string[];
  possibleRegressions?: string[];
  leakageTerms?: string[];
  instructions?: string;
  triggerEventId?: string;
  rolePolicy?: HarnessRolePolicy;
  connectors?: HarnessConnectorTarget[];
  candidateTraceIdsByBaseline?: Record<string, string>;
  candidateTraceIdsByTask?: Record<string, string>;
  baseSkill?: string;
  candidateSkill?: string;
  autoDecide?: boolean;
  exportOnAccept?: boolean;
}): Promise<HarnessEvolutionRun> {
  const runId = input.runId?.trim() || `run-${randomUUID().slice(0, 8)}`;
  const plan = createHarnessEvolutionPlan({
    ...input,
    runId,
    provider: input.provider.name,
  });
  const coreset = selectHarnessCoreset({
    traceIds: plan.traceIds,
    limit: Math.max(2, plan.traceIds.length || 10),
  });
  const coresetTraceIds = coreset.map((item) => item.traceId);
  const mined = mineHarnessFailureSignatures({
    traceIds: plan.traceIds.length ? plan.traceIds : coresetTraceIds,
  });
  const failureSignatureIds = [
    ...new Set([
      ...plan.failureSignatureIds,
      ...mined.map((signature) => signature.signatureId),
    ]),
  ];
  const datasetTraceIds = plan.traceIds.length
    ? plan.traceIds
    : coresetTraceIds;
  const dataset = createHarnessDataset({
    datasetId: plan.datasetId,
    name: plan.summary,
    traceIds: datasetTraceIds,
    failureSignatureIds,
    leakageTerms: plan.leakageTerms,
  });
  const taskSet = plan.taskSetId
    ? (loadHarnessTaskSet(plan.taskSetId) ??
      createHarnessTaskSet({
        taskSetId: plan.taskSetId,
        name: plan.summary,
        traceIds: datasetTraceIds,
        leakageTerms: plan.leakageTerms,
      }))
    : createHarnessTaskSet({
        taskSetId: `taskset-${runId}`,
        name: plan.summary,
        traceIds: datasetTraceIds,
        leakageTerms: plan.leakageTerms,
      });
  plan.taskSetId = taskSet.taskSetId;
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
    .filter(
      (baselineTraceId) =>
        !input.candidateTraceIdsByBaseline?.[baselineTraceId],
    );

  let evaluation: HarnessDatasetEvaluation | undefined;
  let audit: HarnessAuditReport | undefined;
  let ranks: HarnessCandidateRank[] | undefined;
  let frontier: HarnessFrontier | undefined;
  let decision: HarnessDecisionRecord | undefined;
  let skillPatch: HarnessSkillPatchDecision | undefined;
  let bundle: HarnessPromotionBundle | undefined;
  let taskSetEvaluation: HarnessTaskSetEvaluation | undefined;
  let trajectories: HarnessTrajectory[] = [];
  let replay: HarnessReplayManifest | undefined;
  const roleEvidence = evaluateHarnessRolePolicy(plan);
  let connectorWritebacks: HarnessConnectorWriteback[] = [];
  let status: HarnessEvolutionRunStatus = "awaiting_candidate_traces";
  let nextAction = `provide candidateTraceIdsByBaseline for: ${missingCandidateTraceIds.join(", ")}`;

  // Graded gate pipeline — "benchmarks are GATES, not fitness functions"
  // (Hermes-ASE). GATE 1 (constraint) + GATE 2 (quick fitness) are recorded
  // right after the proposal; GATE 3 (fitness) + GATE 4 (coherence/audit) are
  // recorded once the dataset/audit evaluation runs below.
  const gateResults: HarnessGateStageResult[] = [];
  const constraintStage = DEFAULT_GATE_STAGES.find((s) => s.kind === "constraint")!;
  gateResults.push({
    stage: constraintStage,
    passed: !proposal.proposal.failed,
    feedback: proposal.proposal.failed
      ? (proposal.proposal.error ?? "proposal failed constraints")
      : "no surface violations; diff within editable surface",
    durationMs: 0,
  });
  const quickFitnessStage = DEFAULT_GATE_STAGES.find(
    (s) => s.kind === "quick_fitness",
  )!;
  const quickFitness = heuristicFitness({
    expectedFixes: plan.expectedFixes,
    observedDiff:
      proposal.proposal.observedDiffStat || proposal.proposal.diffStat || proposal.proposal.summary,
    constraintsPassed: !proposal.proposal.failed,
    baselineSize: 0,
    evolvedSize: 0,
  });
  gateResults.push({
    stage: quickFitnessStage,
    passed: true,
    score: quickFitness.score,
    feedback: quickFitness.feedback,
    durationMs: 0,
  });

  if (!missingCandidateTraceIds.length) {
    evaluation = evaluateHarnessDataset({
      candidateId: plan.candidateId,
      datasetId: plan.datasetId,
      candidateTraceIdsByBaseline: input.candidateTraceIdsByBaseline ?? {},
    });
    const candidateTraceIdsByTask =
      input.candidateTraceIdsByTask ??
      Object.fromEntries(
        taskSet.tasks.flatMap((task) => {
          const baselineTraceId = task.sourceTraceId;
          const candidateTraceId = baselineTraceId
            ? input.candidateTraceIdsByBaseline?.[baselineTraceId]
            : undefined;
          return candidateTraceId ? [[task.taskId, candidateTraceId]] : [];
        }),
      );
    taskSetEvaluation = evaluateHarnessTaskSet({
      candidateId: plan.candidateId,
      taskSetId: taskSet.taskSetId,
      candidateTraceIdsByTask,
      runId,
      skillVersion: input.baseSkill,
    });
    trajectories = taskSetEvaluation.results.flatMap((result) => {
      if (!result.trajectoryId) return [];
      const trajectory = loadHarnessTrajectory(result.trajectoryId);
      return trajectory ? [trajectory] : [];
    });
    const replayId = taskSetEvaluation.results.find(
      (result) => result.replayId,
    )?.replayId;
    replay = replayId
      ? readJsonFile<HarnessReplayManifest>(replayManifestPath(replayId))
      : undefined;
    audit = auditHarnessCandidate({
      candidateId: plan.candidateId,
      datasetId: plan.datasetId,
      leakageTerms: plan.leakageTerms,
    });
    const fitnessStage = DEFAULT_GATE_STAGES.find((s) => s.kind === "fitness")!;
    gateResults.push({
      stage: fitnessStage,
      passed: evaluation.gate.accepted,
      feedback: evaluation.gate.reason,
      durationMs: 0,
    });
    const coherenceStage = DEFAULT_GATE_STAGES.find(
      (s) => s.kind === "coherence",
    )!;
    gateResults.push({
      stage: coherenceStage,
      passed: audit.passed,
      feedback: audit.passed
        ? "audit passed"
        : `audit findings: ${audit.findings.length}`,
      durationMs: 0,
    });
    ranks = rankHarnessCandidates([plan.candidateId]);
    frontier = updateHarnessFrontier({
      frontierId: plan.frontierId,
      candidateIds: [plan.candidateId],
    });
    skillPatch = decideHarnessSkillPatch({
      candidateId: plan.candidateId,
      baseSkill: input.baseSkill ?? "harness@current",
      candidateSkill: input.candidateSkill,
      selectionDelta: taskSetEvaluation.selectionDelta,
      regressionPassed:
        taskSetEvaluation.regressionPassed &&
        evaluation.gate.heldOut.regressions.length === 0 &&
        evaluation.gate.heldIn.regressions.length === 0,
      policyPassed: taskSetEvaluation.policyPassed && roleEvidence.passed,
      auditPassed: audit.passed,
    });
    if (!roleEvidence.passed) {
      status = "blocked";
      nextAction = `fix role policy before deciding: ${roleEvidence.reasons.join("; ")}`;
    } else if (!taskSetEvaluation.accepted) {
      status = "blocked";
      nextAction = `fix taskset gate before deciding: ${taskSetEvaluation.reason}`;
    } else if (plan.autoDecide) {
      decision = decideHarnessCandidate({ candidateId: plan.candidateId });
      status = decision.decision === "accept" ? "accepted" : "rolled_back";
      nextAction =
        decision.decision === "accept"
          ? "review promotion bundle or export accepted candidate"
          : "inspect audit/gate findings and create a derived candidate";
      if (decision.decision === "accept" && plan.exportOnAccept) {
        bundle = exportHarnessPromotionBundle({
          candidateId: plan.candidateId,
        });
        status = "exported";
        nextAction =
          "review exported promotion bundle before applying outside runoff";
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
    taskSet,
    taskSetEvaluation,
    candidate: loadHarnessCandidate(plan.candidateId) ?? proposal.candidate,
    evaluation,
    audit,
    ranks,
    frontier,
    triggerEvent: undefined,
    roleEvidence,
    connectorWritebacks,
    decision,
    skillPatch,
    bundle,
    trajectories,
    replay,
    gateResults,
    missingCandidateTraceIds,
    artifactRefs: artifactRefsForRun(runId, plan, Boolean(bundle)),
    nextAction,
  };
  const persisted = persistHarnessEvolutionRun(run);
  if (plan.connectors.length) {
    connectorWritebacks = writeHarnessConnectorReport({
      runId,
      targets: plan.connectors,
    });
    return (
      loadHarnessEvolutionRun(runId) ?? { ...persisted, connectorWritebacks }
    );
  }
  return persisted;
}

export function queryHarnessEvolutionReport(
  runId: string,
): HarnessEvolutionReport {
  const run = loadHarnessEvolutionRun(runId);
  if (!run) throw new Error(`Harness evolution run not found: ${runId}`);
  const report = buildHarnessEvolutionReport(run);
  atomicWriteJson(runReportPath(runId), report);
  return report;
}
