/**
 * CLI helpers for local harness evolution commands.
 */

import { createProvider, loadConfigFromPath } from "../core/config.js";
import {
  auditHarnessCandidate,
  buildHarnessArtifactIndex,
  createHarnessCandidate,
  createHarnessDataset,
  createHarnessReplayManifest,
  createHarnessRolloutBatch,
  createHarnessSandboxLease,
  createHarnessTaskSet,
  createHarnessTrajectory,
  compileHarnessFeedback,
  completeHarnessRolloutBatch,
  createHarnessContextTopology,
  decideHarnessCandidate,
  decideHarnessSkillPatch,
  decideHarnessAutonomy,
  doctorHarnessArtifactStore,
  evaluateHarnessCandidate,
  evaluateHarnessDataset,
  evaluateHarnessReward,
  evaluateHarnessTaskSet,
  exportHarnessPromotionBundle,
  exportHarnessTrainingTrajectories,
  listHarnessCandidates,
  listHarnessAutonomyDecisions,
  listHarnessAutonomyPolicies,
  listHarnessContextRoutes,
  listHarnessContextTopologies,
  listHarnessEvolutionRuns,
  listHarnessFeedback,
  listHarnessGcReports,
  listHarnessPaddockAdapters,
  listHarnessRejectedBuffer,
  listHarnessRewardFunctions,
  listHarnessRewardReports,
  listHarnessRolloutBatches,
  listHarnessSandboxLeases,
  listHarnessRules,
  listHarnessTaskSets,
  listHarnessTrainingExports,
  listHarnessVerifiers,
  mineHarnessFailureSignatures,
  proposeHarnessCandidate,
  evolveHarnessCandidate,
  queryHarnessEvolutionReport,
  rankHarnessCandidates,
  recordHarnessRejectedBuffer,
  registerHarnessAutonomyPolicy,
  registerHarnessPaddockAdapter,
  registerHarnessRewardFunction,
  registerHarnessRule,
  registerHarnessVerifier,
  releaseHarnessSandboxLease,
  routeHarnessContext,
  runHarnessGcLoop,
  runHarnessEvolution,
  scanHarnessTriggers,
  selectHarnessCoreset,
  updateHarnessFrontier,
  writeHarnessConnectorReport,
  type HarnessConnectorTarget,
  type HarnessEvalPair,
  type HarnessPaddockAdapterKind,
  type HarnessPaddockProtocol,
  type HarnessAutonomyPolicy,
  type HarnessContextNode,
  type HarnessContextTopology,
  type HarnessRewardFunctionKind,
  type HarnessRolePolicy,
  type HarnessRuleKind,
  type HarnessRolloutMode,
  type HarnessSandboxSpec,
  type HarnessTask,
  type HarnessTrainingExportFormat,
  type HarnessVerifierKind,
  type HarnessTriggerRule,
} from "../orchestration/harness-evolution.js";

export type HarnessEvolveListOptions = {
  limit?: number;
  json?: boolean;
};

export type HarnessEvolveMineOptions = {
  traceIds?: string[];
  limit?: number;
  since?: string;
  json?: boolean;
};

export type HarnessEvolveCoresetOptions = {
  limit?: number;
  since?: string;
  json?: boolean;
};

export type HarnessEvolveCreateOptions = {
  candidateId?: string;
  summary: string;
  sourceDir?: string;
  editableSurface?: string[];
  expectedFixes?: string[];
  possibleRegressions?: string[];
  evidenceTraceIds?: string[];
  failureSignatureIds?: string[];
  parentCandidateIds?: string[];
  datasetIds?: string[];
  json?: boolean;
};

export type HarnessEvolveProposeOptions = HarnessEvolveCreateOptions & {
  configPath: string;
  provider?: string;
  instructions?: string;
};

export type HarnessEvolveEvolveOptions = HarnessEvolveProposeOptions & {
  iterations?: number;
  earlyStopThreshold?: number;
  reflectOnTrajectory?: boolean;
};

export type HarnessEvolveEvaluateOptions = {
  candidateId: string;
  pairs: HarnessEvalPair[];
  json?: boolean;
};

export type HarnessEvolveDatasetOptions = {
  datasetId?: string;
  name: string;
  description?: string;
  traceIds?: string[];
  failureSignatureIds?: string[];
  heldInRatio?: number;
  leakageTerms?: string[];
  json?: boolean;
};

export type HarnessEvolveVerifierOptions = {
  verifierId?: string;
  kind: HarnessVerifierKind;
  summary: string;
  command?: string[];
  expectedFiles?: string[];
  requiredTraceStatuses?: Array<
    | "queued"
    | "running"
    | "approved"
    | "failed"
    | "aborted"
    | "max_rounds"
    | "awaiting_judge"
    | "awaiting_approval"
    | "awaiting_plan_approval"
  >;
  requiredStepNames?: string[];
  forbiddenPaths?: string[];
  rubric?: string;
  json?: boolean;
};

export type HarnessEvolveTaskSetOptions = {
  taskSetId?: string;
  name: string;
  description?: string;
  tasks?: HarnessTask[];
  traceIds?: string[];
  verifierId?: string;
  heldInRatio?: number;
  leakageTerms?: string[];
  json?: boolean;
};

export type HarnessEvolveEvaluateDatasetOptions = {
  candidateId: string;
  datasetId: string;
  candidateTraceMap: Record<string, string>;
  json?: boolean;
};

export type HarnessEvolveEvaluateTaskSetOptions = {
  candidateId: string;
  taskSetId: string;
  candidateTraceMap: Record<string, string>;
  baselineTraceMap?: Record<string, string>;
  runId?: string;
  skillVersion?: string;
  json?: boolean;
};

export type HarnessEvolveTrajectoryOptions = {
  traceId: string;
  taskId?: string;
  runId?: string;
  candidateId?: string;
  model?: string;
  skillVersion?: string;
  toolsets?: string[];
  json?: boolean;
};

export type HarnessEvolveReplayOptions = {
  replayId?: string;
  runId?: string;
  taskSetId?: string;
  candidateId?: string;
  trajectoryIds: string[];
  json?: boolean;
};

export type HarnessEvolveTrainingExportOptions = {
  exportId?: string;
  trajectoryIds?: string[];
  taskSetId?: string;
  candidateId?: string;
  format?: HarnessTrainingExportFormat;
  rewardRefs?: string[];
  limit?: number;
  json?: boolean;
};

export type HarnessEvolvePaddockOptions = {
  paddockId?: string;
  kind?: HarnessPaddockAdapterKind;
  protocol?: HarnessPaddockProtocol;
  summary?: string;
  command?: string[];
  endpoint?: string;
  toolsets?: string[];
  capabilities?: string[];
  headerNames?: string[];
  isolationRequired?: boolean;
  limit?: number;
  json?: boolean;
};

export type HarnessEvolveSandboxOptions = {
  leaseId?: string;
  candidateId?: string;
  taskSetId?: string;
  spec?: HarnessSandboxSpec;
  release?: boolean;
  reason?: string;
  limit?: number;
  json?: boolean;
};

export type HarnessEvolveRolloutBatchOptions = {
  batchId?: string;
  mode?: HarnessRolloutMode;
  taskSetId?: string;
  candidateId?: string;
  paddockId?: string;
  sandboxLeaseIds?: string[];
  candidateTraceMap?: Record<string, string>;
  trainingExportId?: string;
  rewardReportId?: string;
  complete?: boolean;
  reason?: string;
  limit?: number;
  json?: boolean;
};

export type HarnessEvolveRewardOptions = {
  rewardId?: string;
  kind?: HarnessRewardFunctionKind;
  summary?: string;
  weight?: number;
  sourceVerifierId?: string;
  rubric?: string;
  taskSetId?: string;
  candidateId?: string;
  rolloutBatchId?: string;
  trainingExportId?: string;
  reports?: boolean;
  limit?: number;
  json?: boolean;
};

export type HarnessEvolveRuleOptions = {
  ruleId?: string;
  kind?: HarnessRuleKind;
  summary?: string;
  guidance?: string;
  appliesTo?: string[];
  triggers?: string[];
  severity?: "info" | "warn" | "blocker";
  skillRef?: string;
  verifierIds?: string[];
  limit?: number;
  json?: boolean;
};

export type HarnessEvolveFeedbackOptions = {
  feedbackId?: string;
  traceId?: string;
  candidateId?: string;
  taskSetId?: string;
  manualText?: string;
  ruleIds?: string[];
  limit?: number;
  json?: boolean;
};

export type HarnessEvolveGcOptions = {
  reportId?: string;
  since?: string;
  limit?: number;
  json?: boolean;
};

export type HarnessEvolveAutonomyOptions = {
  policyId?: string;
  decisionId?: string;
  action?: string;
  summary?: string;
  defaultDecision?: HarnessAutonomyPolicy["defaultDecision"];
  rules?: HarnessAutonomyPolicy["rules"];
  risk?: number;
  confidence?: number;
  candidateId?: string;
  runId?: string;
  evidenceRefs?: string[];
  decisions?: boolean;
  limit?: number;
  json?: boolean;
};

export type HarnessEvolveContextOptions = {
  topologyId?: string;
  routeId?: string;
  summary?: string;
  nodes?: HarnessContextNode[];
  edges?: HarnessContextTopology["edges"];
  includeRules?: boolean;
  includeTaskSets?: boolean;
  taskId?: string;
  candidateId?: string;
  changedFiles?: string[];
  routes?: boolean;
  limit?: number;
  json?: boolean;
};

export type HarnessEvolveSkillPatchOptions = {
  candidateId: string;
  baseSkill: string;
  candidateSkill?: string;
  patchId?: string;
  maxFiles?: number;
  maxBytes?: number;
  selectionDelta?: number;
  regressionPassed?: boolean;
  policyPassed?: boolean;
  auditPassed?: boolean;
  accepted?: boolean;
  reason?: string;
  json?: boolean;
};

export type HarnessEvolveRejectedOptions = {
  candidateId?: string;
  patchId?: string;
  selectionDelta?: number;
  regressionFailures?: string[];
  rejectionReason?: string;
  reviewNotes?: string;
  limit?: number;
  json?: boolean;
};

export type HarnessEvolveAuditOptions = {
  candidateId: string;
  datasetId?: string;
  leakageTerms?: string[];
  json?: boolean;
};

export type HarnessEvolveFrontierOptions = {
  frontierId?: string;
  candidateIds?: string[];
  json?: boolean;
};

export type HarnessEvolveRunOptions = {
  runId?: string;
  summary: string;
  configPath: string;
  provider?: string;
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
  candidateTraceMap?: Record<string, string>;
  candidateTraceMapByTask?: Record<string, string>;
  rolePolicy?: HarnessRolePolicy;
  connectors?: HarnessConnectorTarget[];
  taskSetId?: string;
  baseSkill?: string;
  candidateSkill?: string;
  exportOnAccept?: boolean;
  json?: boolean;
};

export type HarnessEvolveReportOptions = {
  runId: string;
  json?: boolean;
};

export type HarnessEvolveRunsOptions = {
  limit?: number;
  json?: boolean;
};

export type HarnessEvolveTriggerScanOptions = {
  rules: HarnessTriggerRule[];
  scanId?: string;
  json?: boolean;
};

export type HarnessEvolveWritebackOptions = {
  runId: string;
  targets?: HarnessConnectorTarget[];
  json?: boolean;
};

export type HarnessEvolveRankOptions = {
  candidateIds?: string[];
  json?: boolean;
};

export type HarnessEvolveDecideOptions = {
  candidateId: string;
  decision?: "accept" | "rollback";
  reason?: string;
  json?: boolean;
};

export type HarnessEvolveExportOptions = {
  candidateId: string;
  json?: boolean;
};

export type HarnessEvolveArtifactStoreOptions = {
  limit?: number;
  json?: boolean;
};

export function harnessEvolveList(opts: HarnessEvolveListOptions = {}): void {
  const candidates = listHarnessCandidates().slice(0, opts.limit ?? 20);
  if (opts.json) {
    console.log(
      JSON.stringify({ candidates, count: candidates.length }, null, 2),
    );
    return;
  }
  if (!candidates.length) {
    console.log("No harness candidates found.");
    return;
  }
  for (const c of candidates) {
    console.log(
      `${c.createdAt}  ${c.candidateId}  ${c.status}  gate=${c.gate?.accepted ?? "none"}  ${c.manifest.summary}`,
    );
  }
}

export function harnessEvolveIndex(
  opts: HarnessEvolveArtifactStoreOptions = {},
): void {
  const index = buildHarnessArtifactIndex({ limit: opts.limit });
  if (opts.json) {
    console.log(JSON.stringify({ index }, null, 2));
    return;
  }
  console.log(`HARNESS_ARTIFACT_INDEX ${index.rootDir}`);
  console.log(`  artifacts: ${index.entries.length}`);
  console.log(`  invalid:   ${index.invalidCount}`);
  console.log(`  truncated: ${index.truncated}`);
  for (const [kind, count] of Object.entries(index.countsByKind).sort()) {
    console.log(`  ${kind}: ${count}`);
  }
}

export function harnessEvolveDoctor(
  opts: HarnessEvolveArtifactStoreOptions = {},
): void {
  const report = doctorHarnessArtifactStore({ limit: opts.limit });
  if (opts.json) {
    console.log(JSON.stringify({ report }, null, 2));
    return;
  }
  console.log(`HARNESS_DOCTOR ${report.status}`);
  console.log(`  root:    ${report.rootDir}`);
  console.log(`  invalid: ${report.invalidCount}`);
  console.log(`  next:    ${report.nextAction}`);
  for (const warning of report.warnings) console.log(`  warning: ${warning}`);
}

export function harnessEvolveCoreset(
  opts: HarnessEvolveCoresetOptions = {},
): void {
  const items = selectHarnessCoreset({ limit: opts.limit, since: opts.since });
  if (opts.json) {
    console.log(JSON.stringify({ items, count: items.length }, null, 2));
    return;
  }
  for (const item of items) {
    console.log(
      `${item.traceId}  difficulty=${item.difficulty}  key=${item.diversityKey}  status=${item.finalStatus}`,
    );
  }
}

export function harnessEvolveMine(opts: HarnessEvolveMineOptions = {}): void {
  const signatures = mineHarnessFailureSignatures({
    traceIds: opts.traceIds,
    limit: opts.limit,
    since: opts.since,
  });
  if (opts.json) {
    console.log(
      JSON.stringify({ signatures, count: signatures.length }, null, 2),
    );
    return;
  }
  for (const signature of signatures) {
    console.log(
      `${signature.signatureId}  severity=${signature.severity}  traces=${signature.traceCount}  ${signature.title}`,
    );
  }
}

export function harnessEvolveCreate(opts: HarnessEvolveCreateOptions): void {
  const candidate = createHarnessCandidate({
    candidateId: opts.candidateId,
    summary: opts.summary,
    sourceDir: opts.sourceDir,
    editableSurface: opts.editableSurface,
    expectedFixes: opts.expectedFixes,
    possibleRegressions: opts.possibleRegressions,
    evidenceTraceIds: opts.evidenceTraceIds,
    failureSignatureIds: opts.failureSignatureIds,
    parentCandidateIds: opts.parentCandidateIds,
    datasetIds: opts.datasetIds,
    author: "runoff CLI",
  });
  if (opts.json) {
    console.log(JSON.stringify({ candidate }, null, 2));
    return;
  }
  console.log(`Created ${candidate.candidateId}`);
  console.log(`  variant: ${candidate.variant.variantDir}`);
  console.log(`  manifest: ${candidate.manifest.summary}`);
}

export async function harnessEvolvePropose(
  opts: HarnessEvolveProposeOptions,
): Promise<void> {
  const config = loadConfigFromPath(opts.configPath);
  const providerName =
    opts.provider ??
    config.orchestration?.plannerProvider ??
    Object.keys(config.providers)[0];
  if (!providerName || !config.providers[providerName])
    throw new Error("provider is required");
  const provider = createProvider(
    providerName,
    config.providers[providerName]!,
  );
  if (!provider)
    throw new Error(`provider "${providerName}" cannot execute proposals`);
  const result = await proposeHarnessCandidate({
    candidateId: opts.candidateId,
    provider,
    summary: opts.summary,
    sourceDir: opts.sourceDir,
    editableSurface: opts.editableSurface,
    expectedFixes: opts.expectedFixes,
    possibleRegressions: opts.possibleRegressions,
    evidenceTraceIds: opts.evidenceTraceIds,
    failureSignatureIds: opts.failureSignatureIds,
    parentCandidateIds: opts.parentCandidateIds,
    datasetIds: opts.datasetIds,
    instructions: opts.instructions,
  });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    `${result.proposal.failed ? "FAILED" : "PROPOSED"} ${result.candidate.candidateId}`,
  );
  console.log(`  provider: ${result.proposal.provider}`);
  console.log(`  variant:  ${result.candidate.variant.variantDir}`);
  console.log(
    `  files:    ${result.proposal.filesModified.join(", ") || "none reported"}`,
  );
  console.log(
    `  observed: ${result.proposal.observedFilesModified.join(", ") || "none"}`,
  );
  if (result.proposal.error)
    console.log(`  error:    ${result.proposal.error}`);
}

export async function harnessEvolveEvolve(
  opts: HarnessEvolveEvolveOptions,
): Promise<void> {
  const config = loadConfigFromPath(opts.configPath);
  const providerName =
    opts.provider ??
    config.orchestration?.plannerProvider ??
    Object.keys(config.providers)[0];
  if (!providerName || !config.providers[providerName])
    throw new Error("provider is required");
  const provider = createProvider(
    providerName,
    config.providers[providerName]!,
  );
  if (!provider)
    throw new Error(`provider "${providerName}" cannot execute proposals`);
  const result = await evolveHarnessCandidate({
    candidateId: opts.candidateId,
    provider,
    summary: opts.summary,
    sourceDir: opts.sourceDir,
    editableSurface: opts.editableSurface,
    expectedFixes: opts.expectedFixes,
    possibleRegressions: opts.possibleRegressions,
    evidenceTraceIds: opts.evidenceTraceIds,
    failureSignatureIds: opts.failureSignatureIds,
    parentCandidateIds: opts.parentCandidateIds,
    datasetIds: opts.datasetIds,
    instructions: opts.instructions,
    iterations: opts.iterations,
    earlyStopThreshold: opts.earlyStopThreshold,
    reflectOnTrajectory: opts.reflectOnTrajectory,
  });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    `EVOLVED ${result.baseCandidateId} — best iteration ${result.bestIteration} (score ${result.bestScore.toFixed(3)})`,
  );
  console.log(
    `  iterations: ${result.totalIterations}${result.earlyStopped ? " (early-stopped)" : ""}`,
  );
  console.log(`  winner:     ${result.finalCandidate.candidateId}`);
  for (const it of result.history) {
    const tag = it.skipped ? "skip" : "iter";
    console.log(
      `  [${tag} ${it.iteration}] score=${it.score.toFixed(3)} ${it.feedback}`,
    );
  }
}

export function harnessEvolveDataset(opts: HarnessEvolveDatasetOptions): void {
  const dataset = createHarnessDataset({
    datasetId: opts.datasetId,
    name: opts.name,
    description: opts.description,
    traceIds: opts.traceIds,
    failureSignatureIds: opts.failureSignatureIds,
    heldInRatio: opts.heldInRatio,
    leakageTerms: opts.leakageTerms,
  });
  if (opts.json) {
    console.log(JSON.stringify({ dataset }, null, 2));
    return;
  }
  console.log(`DATASET ${dataset.datasetId}`);
  console.log(`  held-in:  ${dataset.heldIn.length}`);
  console.log(`  held-out: ${dataset.heldOut.length}`);
}

export function harnessEvolveVerifier(
  opts: HarnessEvolveVerifierOptions,
): void {
  const verifier = registerHarnessVerifier({
    verifierId: opts.verifierId,
    kind: opts.kind,
    summary: opts.summary,
    command: opts.command,
    expectedFiles: opts.expectedFiles,
    requiredTraceStatuses: opts.requiredTraceStatuses,
    requiredStepNames: opts.requiredStepNames,
    forbiddenPaths: opts.forbiddenPaths,
    rubric: opts.rubric,
  });
  if (opts.json) {
    console.log(JSON.stringify({ verifier }, null, 2));
    return;
  }
  console.log(`VERIFIER ${verifier.verifierId}`);
  console.log(`  kind:    ${verifier.kind}`);
  console.log(`  summary: ${verifier.summary}`);
}

export function harnessEvolveVerifiers(
  opts: HarnessEvolveListOptions = {},
): void {
  const verifiers = listHarnessVerifiers().slice(0, opts.limit ?? 20);
  if (opts.json) {
    console.log(
      JSON.stringify({ verifiers, count: verifiers.length }, null, 2),
    );
    return;
  }
  for (const verifier of verifiers)
    console.log(
      `${verifier.createdAt}  ${verifier.verifierId}  ${verifier.kind}  ${verifier.summary}`,
    );
}

export function harnessEvolveTaskSet(opts: HarnessEvolveTaskSetOptions): void {
  const taskSet = createHarnessTaskSet({
    taskSetId: opts.taskSetId,
    name: opts.name,
    description: opts.description,
    tasks: opts.tasks,
    traceIds: opts.traceIds,
    verifierId: opts.verifierId,
    heldInRatio: opts.heldInRatio,
    leakageTerms: opts.leakageTerms,
  });
  if (opts.json) {
    console.log(JSON.stringify({ taskSet }, null, 2));
    return;
  }
  console.log(`TASKSET ${taskSet.taskSetId}`);
  console.log(`  tasks:      ${taskSet.tasks.length}`);
  console.log(`  selection:  ${taskSet.selectionTaskIds.length}`);
  console.log(`  regression: ${taskSet.regressionTaskIds.length}`);
}

export function harnessEvolveTaskSets(
  opts: HarnessEvolveListOptions = {},
): void {
  const taskSets = listHarnessTaskSets().slice(0, opts.limit ?? 20);
  if (opts.json) {
    console.log(JSON.stringify({ taskSets, count: taskSets.length }, null, 2));
    return;
  }
  for (const taskSet of taskSets)
    console.log(
      `${taskSet.createdAt}  ${taskSet.taskSetId}  tasks=${taskSet.tasks.length}  ${taskSet.name}`,
    );
}

export function harnessEvolveEvaluateDataset(
  opts: HarnessEvolveEvaluateDatasetOptions,
): void {
  const evaluation = evaluateHarnessDataset({
    candidateId: opts.candidateId,
    datasetId: opts.datasetId,
    candidateTraceIdsByBaseline: opts.candidateTraceMap,
  });
  if (opts.json) {
    console.log(JSON.stringify({ evaluation }, null, 2));
    return;
  }
  console.log(
    `${evaluation.gate.accepted ? "ACCEPTABLE" : "REJECTED"} ${evaluation.candidateId} on ${evaluation.datasetId}: ${evaluation.gate.reason}`,
  );
}

export function harnessEvolveEvaluateTaskSet(
  opts: HarnessEvolveEvaluateTaskSetOptions,
): void {
  const evaluation = evaluateHarnessTaskSet({
    candidateId: opts.candidateId,
    taskSetId: opts.taskSetId,
    candidateTraceIdsByTask: opts.candidateTraceMap,
    baselineTraceIdsByTask: opts.baselineTraceMap,
    runId: opts.runId,
    skillVersion: opts.skillVersion,
  });
  if (opts.json) {
    console.log(JSON.stringify({ evaluation }, null, 2));
    return;
  }
  console.log(
    `${evaluation.accepted ? "TASKSET ACCEPTED" : "TASKSET BLOCKED"} ${evaluation.candidateId} on ${evaluation.taskSetId}: ${evaluation.reason}`,
  );
}

export function harnessEvolveTrajectory(
  opts: HarnessEvolveTrajectoryOptions,
): void {
  const trajectory = createHarnessTrajectory({
    traceId: opts.traceId,
    taskId: opts.taskId,
    runId: opts.runId,
    candidateId: opts.candidateId,
    model: opts.model,
    skillVersion: opts.skillVersion,
    toolsets: opts.toolsets,
  });
  if (opts.json) {
    console.log(JSON.stringify({ trajectory }, null, 2));
    return;
  }
  console.log(`TRAJECTORY ${trajectory.trajectoryId}`);
  console.log(`  trace: ${trajectory.traceId}`);
  console.log(`  path:  ${trajectory.trajectoryPath}`);
}

export function harnessEvolveReplay(opts: HarnessEvolveReplayOptions): void {
  const replay = createHarnessReplayManifest({
    replayId: opts.replayId,
    runId: opts.runId,
    taskSetId: opts.taskSetId,
    candidateId: opts.candidateId,
    trajectoryIds: opts.trajectoryIds,
  });
  if (opts.json) {
    console.log(JSON.stringify({ replay }, null, 2));
    return;
  }
  console.log(`REPLAY ${replay.replayId}`);
  for (const command of replay.commands) console.log(`  ${command}`);
}

export function harnessEvolveTrainingExport(
  opts: HarnessEvolveTrainingExportOptions = {},
): void {
  if (!opts.trajectoryIds?.length) {
    const exports = listHarnessTrainingExports(opts.limit ?? 20);
    if (opts.json) {
      console.log(JSON.stringify({ exports, count: exports.length }, null, 2));
      return;
    }
    for (const entry of exports)
      console.log(
        `${entry.createdAt}  ${entry.exportId}  samples=${entry.sampleCount}  format=${entry.format}`,
      );
    return;
  }
  const result = exportHarnessTrainingTrajectories({
    exportId: opts.exportId,
    trajectoryIds: opts.trajectoryIds,
    taskSetId: opts.taskSetId,
    candidateId: opts.candidateId,
    format: opts.format,
    rewardRefs: opts.rewardRefs,
  });
  if (opts.json) {
    console.log(JSON.stringify({ export: result }, null, 2));
    return;
  }
  console.log(`TRAINING_EXPORT ${result.exportId}`);
  console.log(`  samples: ${result.sampleCount}`);
  console.log(`  path:    ${result.samplesPath}`);
}

export function harnessEvolvePaddock(
  opts: HarnessEvolvePaddockOptions = {},
): void {
  if (!opts.kind) {
    const paddocks = listHarnessPaddockAdapters(opts.limit ?? 20);
    if (opts.json) {
      console.log(
        JSON.stringify({ paddocks, count: paddocks.length }, null, 2),
      );
      return;
    }
    for (const paddock of paddocks)
      console.log(
        `${paddock.createdAt}  ${paddock.paddockId}  ${paddock.kind}/${paddock.protocol}  ${paddock.summary}`,
      );
    return;
  }
  if (!opts.protocol) throw new Error("protocol is required for paddock");
  if (!opts.summary?.trim()) throw new Error("summary is required for paddock");
  const paddock = registerHarnessPaddockAdapter({
    paddockId: opts.paddockId,
    kind: opts.kind,
    protocol: opts.protocol,
    summary: opts.summary,
    command: opts.command,
    endpoint: opts.endpoint,
    toolsets: opts.toolsets,
    capabilities: opts.capabilities,
    headerNames: opts.headerNames,
    isolationRequired: opts.isolationRequired,
  });
  if (opts.json) {
    console.log(JSON.stringify({ paddock }, null, 2));
    return;
  }
  console.log(`PADDOCK ${paddock.paddockId}`);
  console.log(`  kind:     ${paddock.kind}`);
  console.log(`  protocol: ${paddock.protocol}`);
}

export function harnessEvolveSandbox(
  opts: HarnessEvolveSandboxOptions = {},
): void {
  if (opts.release) {
    if (!opts.leaseId) throw new Error("leaseId is required for release");
    const lease = releaseHarnessSandboxLease({
      leaseId: opts.leaseId,
      reason: opts.reason,
    });
    if (opts.json) {
      console.log(JSON.stringify({ lease }, null, 2));
      return;
    }
    console.log(`SANDBOX_RELEASED ${lease.leaseId}`);
    return;
  }
  if (!opts.spec) {
    const leases = listHarnessSandboxLeases(opts.limit ?? 20);
    if (opts.json) {
      console.log(JSON.stringify({ leases, count: leases.length }, null, 2));
      return;
    }
    for (const lease of leases)
      console.log(
        `${lease.updatedAt}  ${lease.leaseId}  ${lease.status}  ${lease.spec.provider}`,
      );
    return;
  }
  const lease = createHarnessSandboxLease({
    leaseId: opts.leaseId,
    candidateId: opts.candidateId,
    taskSetId: opts.taskSetId,
    spec: opts.spec,
  });
  if (opts.json) {
    console.log(JSON.stringify({ lease }, null, 2));
    return;
  }
  console.log(`SANDBOX ${lease.leaseId}`);
  console.log(`  provider: ${lease.spec.provider}`);
  console.log(`  status:   ${lease.status}`);
}

export function harnessEvolveRolloutBatch(
  opts: HarnessEvolveRolloutBatchOptions = {},
): void {
  if (opts.complete) {
    if (!opts.batchId) throw new Error("batchId is required for completion");
    const batch = completeHarnessRolloutBatch({
      batchId: opts.batchId,
      candidateTraceIdsByTask: opts.candidateTraceMap,
      trainingExportId: opts.trainingExportId,
      rewardReportId: opts.rewardReportId,
      reason: opts.reason,
    });
    if (opts.json) {
      console.log(JSON.stringify({ batch }, null, 2));
      return;
    }
    console.log(`ROLLOUT_BATCH ${batch.batchId} status=${batch.status}`);
    return;
  }
  if (!opts.taskSetId || !opts.candidateId) {
    const batches = listHarnessRolloutBatches(opts.limit ?? 20);
    if (opts.json) {
      console.log(JSON.stringify({ batches, count: batches.length }, null, 2));
      return;
    }
    for (const batch of batches)
      console.log(
        `${batch.updatedAt}  ${batch.batchId}  ${batch.status}  taskset=${batch.taskSetId}  candidate=${batch.candidateId}`,
      );
    return;
  }
  const batch = createHarnessRolloutBatch({
    batchId: opts.batchId,
    mode: opts.mode,
    taskSetId: opts.taskSetId,
    candidateId: opts.candidateId,
    paddockId: opts.paddockId,
    sandboxLeaseIds: opts.sandboxLeaseIds,
    candidateTraceIdsByTask: opts.candidateTraceMap,
    trainingExportId: opts.trainingExportId,
    rewardReportId: opts.rewardReportId,
  });
  if (opts.json) {
    console.log(JSON.stringify({ batch }, null, 2));
    return;
  }
  console.log(`ROLLOUT_BATCH ${batch.batchId} status=${batch.status}`);
  console.log(`  items: ${batch.items.length}`);
}

export function harnessEvolveReward(
  opts: HarnessEvolveRewardOptions = {},
): void {
  if (opts.reports) {
    const reports = listHarnessRewardReports(opts.limit ?? 20);
    if (opts.json) {
      console.log(JSON.stringify({ reports, count: reports.length }, null, 2));
      return;
    }
    for (const report of reports)
      console.log(
        `${report.createdAt}  ${report.reportId}  reward=${report.aggregateReward}  candidate=${report.candidateId}`,
      );
    return;
  }
  if (opts.rewardId && opts.taskSetId && opts.candidateId) {
    const report = evaluateHarnessReward({
      rewardId: opts.rewardId,
      taskSetId: opts.taskSetId,
      candidateId: opts.candidateId,
      rolloutBatchId: opts.rolloutBatchId,
      trainingExportId: opts.trainingExportId,
    });
    if (opts.json) {
      console.log(JSON.stringify({ report }, null, 2));
      return;
    }
    console.log(`REWARD_REPORT ${report.reportId}`);
    console.log(`  aggregate: ${report.aggregateReward}`);
    return;
  }
  if (!opts.kind) {
    const rewards = listHarnessRewardFunctions(opts.limit ?? 20);
    if (opts.json) {
      console.log(JSON.stringify({ rewards, count: rewards.length }, null, 2));
      return;
    }
    for (const reward of rewards)
      console.log(
        `${reward.createdAt}  ${reward.rewardId}  ${reward.kind}  weight=${reward.weight}  ${reward.summary}`,
      );
    return;
  }
  if (!opts.summary?.trim()) throw new Error("summary is required for reward");
  const reward = registerHarnessRewardFunction({
    rewardId: opts.rewardId,
    kind: opts.kind,
    summary: opts.summary,
    weight: opts.weight,
    sourceVerifierId: opts.sourceVerifierId,
    rubric: opts.rubric,
  });
  if (opts.json) {
    console.log(JSON.stringify({ reward }, null, 2));
    return;
  }
  console.log(`REWARD ${reward.rewardId}`);
  console.log(`  kind:   ${reward.kind}`);
  console.log(`  weight: ${reward.weight}`);
}

export function harnessEvolveRule(opts: HarnessEvolveRuleOptions = {}): void {
  if (!opts.kind) {
    const rules = listHarnessRules(opts.limit ?? 50);
    if (opts.json) {
      console.log(JSON.stringify({ rules, count: rules.length }, null, 2));
      return;
    }
    for (const rule of rules)
      console.log(
        `${rule.updatedAt}  ${rule.ruleId}  ${rule.kind}  ${rule.severity}  ${rule.summary}`,
      );
    return;
  }
  if (!opts.summary?.trim()) throw new Error("summary is required for rule");
  if (!opts.guidance?.trim()) throw new Error("guidance is required for rule");
  const rule = registerHarnessRule({
    ruleId: opts.ruleId,
    kind: opts.kind,
    summary: opts.summary,
    guidance: opts.guidance,
    appliesTo: opts.appliesTo,
    triggers: opts.triggers,
    severity: opts.severity,
    skillRef: opts.skillRef,
    verifierIds: opts.verifierIds,
  });
  if (opts.json) {
    console.log(JSON.stringify({ rule }, null, 2));
    return;
  }
  console.log(`RULE ${rule.ruleId}`);
  console.log(`  kind:     ${rule.kind}`);
  console.log(`  severity: ${rule.severity}`);
}

export function harnessEvolveFeedback(
  opts: HarnessEvolveFeedbackOptions = {},
): void {
  if (!opts.traceId && !opts.candidateId && !opts.manualText) {
    const feedbacks = listHarnessFeedback(opts.limit ?? 50);
    if (opts.json) {
      console.log(
        JSON.stringify({ feedbacks, count: feedbacks.length }, null, 2),
      );
      return;
    }
    for (const feedback of feedbacks)
      console.log(
        `${feedback.createdAt}  ${feedback.feedbackId}  messages=${feedback.messages.length}  source=${feedback.source}`,
      );
    return;
  }
  const feedback = compileHarnessFeedback({
    feedbackId: opts.feedbackId,
    traceId: opts.traceId,
    candidateId: opts.candidateId,
    taskSetId: opts.taskSetId,
    manualText: opts.manualText,
    ruleIds: opts.ruleIds,
  });
  if (opts.json) {
    console.log(JSON.stringify({ feedback }, null, 2));
    return;
  }
  console.log(`FEEDBACK ${feedback.feedbackId}`);
  console.log(`  messages: ${feedback.messages.length}`);
  console.log(`  source:   ${feedback.source}`);
}

export function harnessEvolveGc(opts: HarnessEvolveGcOptions = {}): void {
  if (!opts.reportId && !opts.since && opts.limit === undefined) {
    const reports = listHarnessGcReports(20);
    if (reports.length) {
      if (opts.json) {
        console.log(
          JSON.stringify({ reports, count: reports.length }, null, 2),
        );
        return;
      }
      for (const report of reports)
        console.log(
          `${report.createdAt}  ${report.reportId}  items=${report.items.length}  next=${report.nextAction}`,
        );
      return;
    }
  }
  const report = runHarnessGcLoop({
    reportId: opts.reportId,
    since: opts.since,
    limit: opts.limit,
  });
  if (opts.json) {
    console.log(JSON.stringify({ report }, null, 2));
    return;
  }
  console.log(`GC_REPORT ${report.reportId}`);
  console.log(`  items: ${report.items.length}`);
  console.log(`  next:  ${report.nextAction}`);
}

export function harnessEvolveAutonomy(
  opts: HarnessEvolveAutonomyOptions = {},
): void {
  if (opts.decisions) {
    const decisions = listHarnessAutonomyDecisions(opts.limit ?? 20);
    if (opts.json) {
      console.log(
        JSON.stringify({ decisions, count: decisions.length }, null, 2),
      );
      return;
    }
    for (const decision of decisions)
      console.log(
        `${decision.createdAt}  ${decision.decisionId}  ${decision.action} -> ${decision.decision}`,
      );
    return;
  }
  if (opts.action) {
    const decision = decideHarnessAutonomy({
      decisionId: opts.decisionId,
      policyId: opts.policyId,
      action: opts.action,
      risk: opts.risk,
      confidence: opts.confidence,
      candidateId: opts.candidateId,
      runId: opts.runId,
      evidenceRefs: opts.evidenceRefs,
    });
    if (opts.json) {
      console.log(JSON.stringify({ decision }, null, 2));
      return;
    }
    console.log(`AUTONOMY_DECISION ${decision.decisionId}`);
    console.log(`  decision: ${decision.decision}`);
    console.log(`  next:     ${decision.nextHint}`);
    return;
  }
  if (opts.summary) {
    const policy = registerHarnessAutonomyPolicy({
      policyId: opts.policyId,
      summary: opts.summary,
      defaultDecision: opts.defaultDecision,
      rules: opts.rules,
    });
    if (opts.json) {
      console.log(JSON.stringify({ policy }, null, 2));
      return;
    }
    console.log(`AUTONOMY_POLICY ${policy.policyId}`);
    console.log(`  default: ${policy.defaultDecision}`);
    return;
  }
  const policies = listHarnessAutonomyPolicies(opts.limit ?? 20);
  if (opts.json) {
    console.log(JSON.stringify({ policies, count: policies.length }, null, 2));
    return;
  }
  for (const policy of policies)
    console.log(
      `${policy.createdAt}  ${policy.policyId}  default=${policy.defaultDecision}  ${policy.summary}`,
    );
}

export function harnessEvolveContext(
  opts: HarnessEvolveContextOptions = {},
): void {
  if (opts.routes) {
    const routes = listHarnessContextRoutes(opts.limit ?? 20);
    if (opts.json) {
      console.log(JSON.stringify({ routes, count: routes.length }, null, 2));
      return;
    }
    for (const route of routes)
      console.log(
        `${route.createdAt}  ${route.routeId}  selected=${route.selectedRefs.length}`,
      );
    return;
  }
  if (opts.changedFiles?.length || opts.candidateId || opts.routeId) {
    const route = routeHarnessContext({
      routeId: opts.routeId,
      topologyId: opts.topologyId,
      taskId: opts.taskId,
      candidateId: opts.candidateId,
      changedFiles: opts.changedFiles,
      limit: opts.limit,
    });
    if (opts.json) {
      console.log(JSON.stringify({ route }, null, 2));
      return;
    }
    console.log(`CONTEXT_ROUTE ${route.routeId}`);
    console.log(`  selected: ${route.selectedRefs.length}`);
    return;
  }
  if (opts.summary) {
    const topology = createHarnessContextTopology({
      topologyId: opts.topologyId,
      summary: opts.summary,
      nodes: opts.nodes,
      edges: opts.edges,
      includeRules: opts.includeRules,
      includeTaskSets: opts.includeTaskSets,
    });
    if (opts.json) {
      console.log(JSON.stringify({ topology }, null, 2));
      return;
    }
    console.log(`CONTEXT_TOPOLOGY ${topology.topologyId}`);
    console.log(`  nodes: ${topology.nodes.length}`);
    return;
  }
  const topologies = listHarnessContextTopologies(opts.limit ?? 20);
  if (opts.json) {
    console.log(
      JSON.stringify({ topologies, count: topologies.length }, null, 2),
    );
    return;
  }
  for (const topology of topologies)
    console.log(
      `${topology.createdAt}  ${topology.topologyId}  nodes=${topology.nodes.length}  ${topology.summary}`,
    );
}

export function harnessEvolveSkillPatch(
  opts: HarnessEvolveSkillPatchOptions,
): void {
  const patch = decideHarnessSkillPatch({
    candidateId: opts.candidateId,
    baseSkill: opts.baseSkill,
    candidateSkill: opts.candidateSkill,
    patchId: opts.patchId,
    patchBudget: { maxFiles: opts.maxFiles, maxBytes: opts.maxBytes },
    selectionDelta: opts.selectionDelta,
    regressionPassed: opts.regressionPassed,
    policyPassed: opts.policyPassed,
    auditPassed: opts.auditPassed,
    accepted: opts.accepted,
    reason: opts.reason,
  });
  if (opts.json) {
    console.log(JSON.stringify({ patch }, null, 2));
    return;
  }
  console.log(
    `${patch.accepted ? "PATCH ACCEPTED" : "PATCH REJECTED"} ${patch.patchId}`,
  );
  console.log(`  candidate: ${patch.candidateId}`);
  console.log(`  reason:    ${patch.reason}`);
}

export function harnessEvolveRejected(
  opts: HarnessEvolveRejectedOptions = {},
): void {
  if (opts.candidateId) {
    const entry = recordHarnessRejectedBuffer({
      candidateId: opts.candidateId,
      patchId: opts.patchId,
      selectionDelta: opts.selectionDelta,
      regressionFailures: opts.regressionFailures,
      rejectionReason: opts.rejectionReason ?? "manual rejected buffer entry",
      reviewNotes: opts.reviewNotes,
    });
    if (opts.json) {
      console.log(JSON.stringify({ entry }, null, 2));
      return;
    }
    console.log(`REJECTED ${entry.rejectedId}`);
    console.log(`  candidate: ${entry.candidateId}`);
    console.log(`  reason:    ${entry.rejectionReason}`);
    return;
  }
  const entries = listHarnessRejectedBuffer(opts.limit ?? 20);
  if (opts.json) {
    console.log(JSON.stringify({ entries, count: entries.length }, null, 2));
    return;
  }
  for (const entry of entries)
    console.log(
      `${entry.createdAt}  ${entry.rejectedId}  candidate=${entry.candidateId}  ${entry.rejectionReason}`,
    );
}

export function harnessEvolveAudit(opts: HarnessEvolveAuditOptions): void {
  const audit = auditHarnessCandidate({
    candidateId: opts.candidateId,
    datasetId: opts.datasetId,
    leakageTerms: opts.leakageTerms,
  });
  if (opts.json) {
    console.log(JSON.stringify({ audit }, null, 2));
    return;
  }
  console.log(
    `${audit.passed ? "AUDIT PASSED" : "AUDIT BLOCKED"} ${audit.candidateId}`,
  );
  for (const finding of audit.findings)
    console.log(`  ${finding.severity} ${finding.rule}: ${finding.message}`);
}

export function harnessEvolveFrontier(
  opts: HarnessEvolveFrontierOptions = {},
): void {
  const frontier = updateHarnessFrontier({
    frontierId: opts.frontierId,
    candidateIds: opts.candidateIds,
  });
  if (opts.json) {
    console.log(JSON.stringify({ frontier }, null, 2));
    return;
  }
  console.log(`FRONTIER ${frontier.frontierId}`);
  for (const entry of frontier.entries) {
    console.log(
      `  ${entry.candidateId} score=${entry.score} accepted=${entry.accepted} audit=${entry.auditPassed}`,
    );
  }
}

export async function harnessEvolveRun(
  opts: HarnessEvolveRunOptions,
): Promise<void> {
  const config = loadConfigFromPath(opts.configPath);
  const providerName =
    opts.provider ??
    config.orchestration?.plannerProvider ??
    Object.keys(config.providers)[0];
  if (!providerName || !config.providers[providerName])
    throw new Error("provider is required");
  const provider = createProvider(
    providerName,
    config.providers[providerName]!,
  );
  if (!provider)
    throw new Error(
      `provider "${providerName}" cannot execute harness evolution runs`,
    );
  const run = await runHarnessEvolution({
    runId: opts.runId,
    summary: opts.summary,
    provider,
    traceIds: opts.traceIds,
    failureSignatureIds: opts.failureSignatureIds,
    datasetId: opts.datasetId,
    taskSetId: opts.taskSetId,
    candidateId: opts.candidateId,
    frontierId: opts.frontierId,
    sourceDir: opts.sourceDir,
    editableSurface: opts.editableSurface,
    expectedFixes: opts.expectedFixes,
    possibleRegressions: opts.possibleRegressions,
    leakageTerms: opts.leakageTerms,
    instructions: opts.instructions,
    candidateTraceIdsByBaseline: opts.candidateTraceMap,
    candidateTraceIdsByTask: opts.candidateTraceMapByTask,
    rolePolicy: opts.rolePolicy,
    connectors: opts.connectors,
    baseSkill: opts.baseSkill,
    candidateSkill: opts.candidateSkill,
    exportOnAccept: opts.exportOnAccept,
  });
  if (opts.json) {
    console.log(JSON.stringify({ run }, null, 2));
    return;
  }
  console.log(`RUN ${run.runId} status=${run.status}`);
  console.log(`  candidate: ${run.plan.candidateId}`);
  console.log(`  dataset:   ${run.plan.datasetId}`);
  console.log(`  next:      ${run.nextAction}`);
}

export function harnessEvolveReport(opts: HarnessEvolveReportOptions): void {
  const report = queryHarnessEvolutionReport(opts.runId);
  if (opts.json) {
    console.log(JSON.stringify({ report }, null, 2));
    return;
  }
  console.log(`REPORT ${report.runId} status=${report.status}`);
  console.log(`  next:      ${report.nextAction}`);
  console.log(`  candidate: ${report.candidateId}`);
  console.log(`  dataset:   ${report.datasetId}`);
}

export function harnessEvolveRuns(opts: HarnessEvolveRunsOptions = {}): void {
  const runs = listHarnessEvolutionRuns().slice(0, opts.limit ?? 20);
  if (opts.json) {
    console.log(JSON.stringify({ runs, count: runs.length }, null, 2));
    return;
  }
  if (!runs.length) {
    console.log("No harness evolution runs found.");
    return;
  }
  for (const run of runs) {
    console.log(
      `${run.startedAt}  ${run.runId}  ${run.status}  candidate=${run.plan.candidateId}  ${run.plan.summary}`,
    );
  }
}

export function harnessEvolveTriggerScan(
  opts: HarnessEvolveTriggerScanOptions,
): void {
  const scan = scanHarnessTriggers({ rules: opts.rules, scanId: opts.scanId });
  if (opts.json) {
    console.log(JSON.stringify({ scan }, null, 2));
    return;
  }
  console.log(`TRIGGER_SCAN ${scan.scanId} events=${scan.events.length}`);
  for (const event of scan.events)
    console.log(
      `  ${event.eventId} kind=${event.kind} action=${event.allowedAction}`,
    );
}

export function harnessEvolveWriteback(
  opts: HarnessEvolveWritebackOptions,
): void {
  const writebacks = writeHarnessConnectorReport({
    runId: opts.runId,
    targets: opts.targets,
  });
  if (opts.json) {
    console.log(
      JSON.stringify({ writebacks, count: writebacks.length }, null, 2),
    );
    return;
  }
  for (const writeback of writebacks)
    console.log(`WRITEBACK ${writeback.kind} ${writeback.path}`);
}

export function harnessEvolveEvaluate(
  opts: HarnessEvolveEvaluateOptions,
): void {
  const gate = evaluateHarnessCandidate({
    candidateId: opts.candidateId,
    pairs: opts.pairs,
  });
  if (opts.json) {
    console.log(JSON.stringify({ gate }, null, 2));
    return;
  }
  console.log(
    `${gate.accepted ? "ACCEPTABLE" : "REJECTED"} ${gate.candidateId}: ${gate.reason}`,
  );
  console.log(
    `  held-in:  ${gate.heldIn.passed}/${gate.heldIn.total} passed, regressions=${gate.heldIn.regressions.length}`,
  );
  console.log(
    `  held-out: ${gate.heldOut.passed}/${gate.heldOut.total} passed, regressions=${gate.heldOut.regressions.length}`,
  );
}

export function harnessEvolveRank(opts: HarnessEvolveRankOptions = {}): void {
  const ranks = rankHarnessCandidates(opts.candidateIds);
  if (opts.json) {
    console.log(JSON.stringify({ ranks, count: ranks.length }, null, 2));
    return;
  }
  for (const rank of ranks) {
    console.log(
      `#${rank.rank} ${rank.candidateId} score=${rank.score} wins=${rank.preferenceWins} losses=${rank.preferenceLosses}`,
    );
  }
}

export function harnessEvolveDecide(opts: HarnessEvolveDecideOptions): void {
  const decision = decideHarnessCandidate({
    candidateId: opts.candidateId,
    decision: opts.decision,
    reason: opts.reason,
  });
  if (opts.json) {
    console.log(JSON.stringify({ decision }, null, 2));
    return;
  }
  console.log(
    `${decision.decision.toUpperCase()} ${decision.candidateId}: ${decision.reason}`,
  );
  console.log(
    `  acceptance: ${decision.acceptanceChecks.accepted ? "pass" : "blocked"}`,
  );
}

export function harnessEvolveExport(opts: HarnessEvolveExportOptions): void {
  const bundle = exportHarnessPromotionBundle({
    candidateId: opts.candidateId,
  });
  if (opts.json) {
    console.log(JSON.stringify({ bundle }, null, 2));
    return;
  }
  console.log(`EXPORTED ${bundle.candidateId}`);
  console.log(`  bundle: ${bundle.bundleDir}`);
  console.log(
    `  files:  ${bundle.files.filter((file) => file.copied).length}/${bundle.files.length} copied`,
  );
}
