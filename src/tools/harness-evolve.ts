/**
 * runoff_harness_evolve — local harness evolution control plane.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createProvider, loadConfig } from "../core/config.js";
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
  type HarnessRuleKind,
  type HarnessAutonomyPolicy,
  type HarnessContextNode,
  type HarnessContextTopology,
  type HarnessRewardFunctionKind,
  type HarnessRolePolicy,
  type HarnessRolloutMode,
  type HarnessSandboxSpec,
  type HarnessTask,
  type HarnessTrainingExportFormat,
  type HarnessVerifierKind,
  type HarnessTriggerRule,
} from "../orchestration/harness-evolution.js";
import { mcpError, mcpErrorFrom, mcpJson } from "./mcp-response.js";

const ACTIONS = [
  "coreset",
  "mine",
  "dataset",
  "verifier",
  "verifiers",
  "taskset",
  "tasksets",
  "trajectory",
  "replay",
  "training_export",
  "paddock",
  "paddocks",
  "sandbox",
  "sandboxes",
  "rollout_batch",
  "rollout_batches",
  "reward",
  "rewards",
  "reward_reports",
  "rule",
  "rules",
  "feedback",
  "feedbacks",
  "gc",
  "gc_reports",
  "autonomy_policy",
  "autonomy_policies",
  "autonomy_decide",
  "autonomy_decisions",
  "context_topology",
  "context_topologies",
  "context_route",
  "context_routes",
  "index",
  "doctor",
  "skill_patch",
  "rejected",
  "create",
  "propose",
  "evolve",
  "run",
  "report",
  "runs",
  "trigger_scan",
  "writeback",
  "evaluate",
  "evaluate_dataset",
  "evaluate_taskset",
  "audit",
  "rank",
  "frontier",
  "decide",
  "export",
  "list",
] as const;

function parseJsonArray<T>(raw: string | undefined, name: string): T[] {
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${name} must be a JSON array`);
  return parsed as T[];
}

export function register(server: McpServer) {
  server.tool(
    "runoff_harness_evolve",
    "Manage local harness evolution: artifact store index/doctor, coreset selection, change manifests, isolated variants, dataset runs, regression gates, leakage audits, frontier state, and accept/rollback records.",
    {
      action: z
        .enum(ACTIONS)
        .describe(
          "coreset | mine | dataset | verifier | verifiers | taskset | tasksets | trajectory | replay | training_export | paddock | paddocks | sandbox | sandboxes | rollout_batch | rollout_batches | reward | rewards | reward_reports | rule | rules | feedback | feedbacks | gc | gc_reports | autonomy_policy | autonomy_policies | autonomy_decide | autonomy_decisions | context_topology | context_topologies | context_route | context_routes | index | doctor | skill_patch | rejected | create | propose | run | report | runs | trigger_scan | writeback | evaluate | evaluate_dataset | evaluate_taskset | audit | rank | frontier | decide | export | list",
        ),
      runId: z.string().optional().describe("Harness evolution run id"),
      scanId: z.string().optional().describe("Harness trigger scan id"),
      candidateId: z.string().optional().describe("Harness candidate id"),
      datasetId: z.string().optional().describe("Harness dataset id"),
      taskSetId: z.string().optional().describe("Harness task set id"),
      verifierId: z.string().optional().describe("Harness verifier id"),
      verifierIdsJson: z
        .string()
        .optional()
        .describe("JSON array of harness verifier ids"),
      trajectoryId: z.string().optional().describe("Harness trajectory id"),
      replayId: z.string().optional().describe("Harness replay manifest id"),
      exportId: z.string().optional().describe("Harness training export id"),
      paddockId: z.string().optional().describe("Harness paddock adapter id"),
      leaseId: z.string().optional().describe("Harness sandbox lease id"),
      batchId: z.string().optional().describe("Harness rollout batch id"),
      rewardId: z.string().optional().describe("Harness reward function id"),
      rewardReportId: z
        .string()
        .optional()
        .describe("Harness reward report id"),
      ruleId: z.string().optional().describe("Harness rule id"),
      feedbackId: z.string().optional().describe("Harness feedback id"),
      gcReportId: z.string().optional().describe("Harness GC report id"),
      policyId: z.string().optional().describe("Harness autonomy policy id"),
      decisionId: z
        .string()
        .optional()
        .describe("Harness autonomy decision id"),
      topologyId: z.string().optional().describe("Harness context topology id"),
      routeId: z.string().optional().describe("Harness context route id"),
      frontierId: z.string().optional().describe("Harness frontier id"),
      summary: z
        .string()
        .optional()
        .describe("Candidate manifest summary for action=create"),
      name: z.string().optional().describe("TaskSet or dataset name"),
      provider: z
        .string()
        .optional()
        .describe("Provider name for action=propose"),
      instructions: z
        .string()
        .optional()
        .describe("Additional proposer instructions for action=propose"),
      iterations: z
        .number()
        .optional()
        .describe("Max iterations for action=evolve (default 5)"),
      earlyStopThreshold: z
        .number()
        .optional()
        .describe("Score 0-1 that stops action=evolve early (default 0.9)"),
      reflectOnTrajectory: z
        .boolean()
        .optional()
        .describe(
          "Inject previous iteration diff + score into the next prompt for action=evolve (default true)",
        ),
      sourceDir: z
        .string()
        .optional()
        .describe(
          "Optional harness/source directory copied into an isolated variant directory",
        ),
      editableSurfaceJson: z
        .string()
        .optional()
        .describe("JSON array of editable files/components"),
      expectedFixesJson: z
        .string()
        .optional()
        .describe("JSON array of expected fixes"),
      possibleRegressionsJson: z
        .string()
        .optional()
        .describe("JSON array of possible regressions"),
      evidenceTraceIdsJson: z
        .string()
        .optional()
        .describe("JSON array of evidence trace ids"),
      failureSignatureIdsJson: z
        .string()
        .optional()
        .describe("JSON array of mined failure signature ids"),
      parentCandidateIdsJson: z
        .string()
        .optional()
        .describe("JSON array of parent candidate ids"),
      datasetIdsJson: z
        .string()
        .optional()
        .describe("JSON array of dataset ids"),
      leakageTermsJson: z
        .string()
        .optional()
        .describe("JSON array of leakage terms"),
      candidateTraceMapJson: z
        .string()
        .optional()
        .describe(
          "JSON object mapping baseline trace id to candidate trace id",
        ),
      rolePolicyJson: z
        .string()
        .optional()
        .describe("JSON object with role policy for action=run"),
      connectorsJson: z
        .string()
        .optional()
        .describe("JSON array of connector writeback targets"),
      rulesJson: z
        .string()
        .optional()
        .describe("JSON array of trigger rules for action=trigger_scan"),
      tasksJson: z
        .string()
        .optional()
        .describe("JSON array of HarnessTask objects for action=taskset"),
      verifierKind: z
        .enum([
          "command",
          "file_diff",
          "json_schema",
          "trace_process",
          "policy",
          "llm_judge",
        ])
        .optional()
        .describe("Verifier kind for action=verifier"),
      verifierCommandJson: z
        .string()
        .optional()
        .describe("JSON array command for action=verifier"),
      expectedFilesJson: z
        .string()
        .optional()
        .describe("JSON array of expected files for verifier"),
      requiredTraceStatusesJson: z
        .string()
        .optional()
        .describe("JSON array of required trace statuses for verifier"),
      requiredStepNamesJson: z
        .string()
        .optional()
        .describe("JSON array of required step names for verifier"),
      forbiddenPathsJson: z
        .string()
        .optional()
        .describe("JSON array of forbidden paths for task/policy verifier"),
      rubric: z
        .string()
        .optional()
        .describe("Verifier rubric or judge instructions"),
      candidateTraceMapByTaskJson: z
        .string()
        .optional()
        .describe("JSON object mapping task id to candidate trace id"),
      baselineTraceMapByTaskJson: z
        .string()
        .optional()
        .describe("JSON object mapping task id to baseline trace id"),
      trajectoryIdsJson: z
        .string()
        .optional()
        .describe("JSON array of trajectory ids for replay"),
      rewardRefsJson: z
        .string()
        .optional()
        .describe("JSON array of reward report refs for training export"),
      trainingFormat: z
        .enum(["runoff_training_jsonl", "dressage_compatible_jsonl"])
        .optional()
        .describe("Training export format"),
      paddockKind: z
        .enum(["local_cli", "mcp_host", "http_blackbox"])
        .optional()
        .describe("Paddock adapter kind"),
      paddockProtocol: z
        .enum(["runoff_provider", "openai_compatible", "blackbox_http"])
        .optional()
        .describe("Paddock adapter protocol"),
      commandJson: z
        .string()
        .optional()
        .describe("JSON array command for paddock adapter"),
      endpoint: z.string().optional().describe("Blackbox adapter endpoint"),
      toolsetsJson: z
        .string()
        .optional()
        .describe("JSON array of adapter toolsets"),
      capabilitiesJson: z
        .string()
        .optional()
        .describe("JSON array of adapter capabilities"),
      headerNamesJson: z
        .string()
        .optional()
        .describe("JSON array of configured header names, never values"),
      sandboxSpecJson: z
        .string()
        .optional()
        .describe("JSON object HarnessSandboxSpec for action=sandbox"),
      release: z.boolean().optional().describe("Release sandbox lease"),
      rolloutMode: z
        .enum(["sync", "async", "partial"])
        .optional()
        .describe("Rollout batch scheduling mode"),
      sandboxLeaseIdsJson: z
        .string()
        .optional()
        .describe("JSON array of sandbox lease ids for rollout batch"),
      complete: z.boolean().optional().describe("Complete rollout batch"),
      rewardKind: z
        .enum([
          "verifier_score",
          "binary_success",
          "regression_delta",
          "policy_safe",
          "custom",
        ])
        .optional()
        .describe("Reward function kind"),
      rewardWeight: z.number().optional().describe("Reward function weight"),
      ruleKind: z
        .enum([
          "coding_standard",
          "qa_plan",
          "review_rubric",
          "lint_guidance",
          "architecture_boundary",
          "workflow",
        ])
        .optional()
        .describe("Harness rule kind"),
      guidance: z.string().optional().describe("Rule guidance text"),
      appliesToJson: z
        .string()
        .optional()
        .describe("JSON array of files/directories a rule applies to"),
      triggersJson: z
        .string()
        .optional()
        .describe("JSON array of text triggers for rule matching"),
      ruleSeverity: z
        .enum(["info", "warn", "blocker"])
        .optional()
        .describe("Harness rule severity"),
      skillRef: z.string().optional().describe("Rule skill reference"),
      manualText: z
        .string()
        .optional()
        .describe("Manual text for feedback compilation"),
      ruleIdsJson: z.string().optional().describe("JSON array of rule ids"),
      defaultDecision: z
        .enum(["auto_continue", "ask_approval", "report_only"])
        .optional()
        .describe("Autonomy policy default decision"),
      autonomyRulesJson: z
        .string()
        .optional()
        .describe("JSON array of autonomy policy rules"),
      autonomyAction: z
        .string()
        .optional()
        .describe("Action name for autonomy decision"),
      risk: z.number().optional().describe("Autonomy risk score 0-5"),
      confidence: z
        .number()
        .optional()
        .describe("Autonomy confidence score 0-1"),
      evidenceRefsJson: z
        .string()
        .optional()
        .describe("JSON array of evidence references"),
      contextNodesJson: z
        .string()
        .optional()
        .describe("JSON array of context topology nodes"),
      contextEdgesJson: z
        .string()
        .optional()
        .describe("JSON array of context topology edges"),
      changedFilesJson: z
        .string()
        .optional()
        .describe("JSON array of changed files for context routing"),
      includeRules: z.boolean().optional().describe("Include rule nodes"),
      includeTaskSets: z.boolean().optional().describe("Include taskset nodes"),
      baseSkill: z
        .string()
        .optional()
        .describe("Base skill version for action=skill_patch"),
      candidateSkill: z
        .string()
        .optional()
        .describe("Candidate skill version for action=skill_patch"),
      patchId: z
        .string()
        .optional()
        .describe("Skill patch id for action=skill_patch"),
      maxFiles: z.number().optional().describe("Skill patch max files budget"),
      maxBytes: z.number().optional().describe("Skill patch max bytes budget"),
      selectionDelta: z
        .number()
        .optional()
        .describe("Measured selection delta"),
      regressionPassed: z
        .boolean()
        .optional()
        .describe("Regression gate status for action=skill_patch"),
      policyPassed: z
        .boolean()
        .optional()
        .describe("Policy gate status for action=skill_patch"),
      auditPassed: z
        .boolean()
        .optional()
        .describe("Audit gate status for action=skill_patch"),
      accepted: z
        .boolean()
        .optional()
        .describe("Explicit skill patch acceptance override"),
      regressionFailuresJson: z
        .string()
        .optional()
        .describe("JSON array of rejected buffer regression failures"),
      reviewNotes: z
        .string()
        .optional()
        .describe("Rejected buffer review notes"),
      evalPairsJson: z
        .string()
        .optional()
        .describe(
          "JSON array of {baselineTraceId,candidateTraceId,split:'held-in'|'held-out'}",
        ),
      candidateIdsJson: z
        .string()
        .optional()
        .describe("JSON array of candidate ids for ranking"),
      traceIdsJson: z
        .string()
        .optional()
        .describe("JSON array of trace ids for coreset selection"),
      limit: z.number().optional().describe("Limit for list/coreset responses"),
      since: z
        .string()
        .optional()
        .describe("ISO timestamp lower bound for coreset trace search"),
      heldInRatio: z
        .number()
        .optional()
        .describe("Held-in ratio for action=dataset"),
      exportOnAccept: z
        .boolean()
        .optional()
        .describe(
          "Export promotion bundle automatically when action=run accepts the candidate",
        ),
      decision: z
        .enum(["accept", "rollback"])
        .optional()
        .describe(
          "Explicit decision for action=decide; defaults from gate result",
        ),
      reason: z.string().optional().describe("Decision reason"),
    },
    async (args) => {
      try {
        switch (args.action) {
          case "coreset":
            return mcpJson({
              action: args.action,
              items: selectHarnessCoreset({
                limit: args.limit,
                since: args.since,
                traceIds: parseJsonArray<string>(
                  args.traceIdsJson,
                  "traceIdsJson",
                ),
              }),
            });
          case "mine":
            return mcpJson({
              action: args.action,
              signatures: mineHarnessFailureSignatures({
                limit: args.limit,
                since: args.since,
                traceIds: parseJsonArray<string>(
                  args.traceIdsJson,
                  "traceIdsJson",
                ),
              }),
            });
          case "dataset": {
            if (!args.summary?.trim())
              return mcpError(
                "Harness evolve error",
                "summary is required as dataset name for action=dataset",
              );
            return mcpJson({
              action: args.action,
              dataset: createHarnessDataset({
                datasetId: args.datasetId,
                name: args.summary,
                traceIds: parseJsonArray<string>(
                  args.traceIdsJson,
                  "traceIdsJson",
                ),
                failureSignatureIds: parseJsonArray<string>(
                  args.failureSignatureIdsJson,
                  "failureSignatureIdsJson",
                ),
                heldInRatio: args.heldInRatio,
                leakageTerms: parseJsonArray<string>(
                  args.leakageTermsJson,
                  "leakageTermsJson",
                ),
              }),
            });
          }
          case "verifier": {
            if (!args.verifierKind)
              return mcpError(
                "Harness evolve error",
                "verifierKind is required for action=verifier",
              );
            if (!args.summary?.trim())
              return mcpError(
                "Harness evolve error",
                "summary is required for action=verifier",
              );
            return mcpJson({
              action: args.action,
              verifier: registerHarnessVerifier({
                verifierId: args.verifierId,
                kind: args.verifierKind as HarnessVerifierKind,
                summary: args.summary,
                command: parseJsonArray<string>(
                  args.verifierCommandJson,
                  "verifierCommandJson",
                ),
                expectedFiles: parseJsonArray<string>(
                  args.expectedFilesJson,
                  "expectedFilesJson",
                ),
                requiredTraceStatuses: parseJsonArray(
                  args.requiredTraceStatusesJson,
                  "requiredTraceStatusesJson",
                ),
                requiredStepNames: parseJsonArray<string>(
                  args.requiredStepNamesJson,
                  "requiredStepNamesJson",
                ),
                forbiddenPaths: parseJsonArray<string>(
                  args.forbiddenPathsJson,
                  "forbiddenPathsJson",
                ),
                rubric: args.rubric,
              }),
            });
          }
          case "verifiers":
            return mcpJson({
              action: args.action,
              verifiers: listHarnessVerifiers().slice(0, args.limit ?? 20),
            });
          case "taskset": {
            const name = args.name ?? args.summary;
            if (!name?.trim())
              return mcpError(
                "Harness evolve error",
                "name or summary is required for action=taskset",
              );
            return mcpJson({
              action: args.action,
              taskSet: createHarnessTaskSet({
                taskSetId: args.taskSetId,
                name,
                tasks: parseJsonArray<HarnessTask>(args.tasksJson, "tasksJson"),
                traceIds: parseJsonArray<string>(
                  args.traceIdsJson,
                  "traceIdsJson",
                ),
                verifierId: args.verifierId,
                heldInRatio: args.heldInRatio,
                leakageTerms: parseJsonArray<string>(
                  args.leakageTermsJson,
                  "leakageTermsJson",
                ),
              }),
            });
          }
          case "tasksets":
            return mcpJson({
              action: args.action,
              taskSets: listHarnessTaskSets().slice(0, args.limit ?? 20),
            });
          case "trajectory": {
            const traceIds = parseJsonArray<string>(
              args.traceIdsJson,
              "traceIdsJson",
            );
            if (!traceIds[0]) {
              return mcpError(
                "Harness evolve error",
                "traceIdsJson with one trace id is required for action=trajectory",
              );
            }
            const traceId = traceIds[0]!;
            return mcpJson({
              action: args.action,
              trajectory: createHarnessTrajectory({
                traceId,
                runId: args.runId,
                candidateId: args.candidateId,
                skillVersion: args.baseSkill,
              }),
            });
          }
          case "replay":
            return mcpJson({
              action: args.action,
              replay: createHarnessReplayManifest({
                replayId: args.replayId,
                runId: args.runId,
                taskSetId: args.taskSetId,
                candidateId: args.candidateId,
                trajectoryIds: parseJsonArray<string>(
                  args.trajectoryIdsJson,
                  "trajectoryIdsJson",
                ),
              }),
            });
          case "training_export": {
            const trajectoryIds = parseJsonArray<string>(
              args.trajectoryIdsJson,
              "trajectoryIdsJson",
            );
            if (!trajectoryIds.length) {
              return mcpJson({
                action: args.action,
                exports: listHarnessTrainingExports(args.limit ?? 20),
              });
            }
            return mcpJson({
              action: args.action,
              export: exportHarnessTrainingTrajectories({
                exportId: args.exportId,
                trajectoryIds,
                taskSetId: args.taskSetId,
                candidateId: args.candidateId,
                format: args.trainingFormat as
                  | HarnessTrainingExportFormat
                  | undefined,
                rewardRefs: parseJsonArray<string>(
                  args.rewardRefsJson,
                  "rewardRefsJson",
                ),
              }),
            });
          }
          case "paddock": {
            if (!args.paddockKind)
              return mcpError(
                "Harness evolve error",
                "paddockKind is required for action=paddock",
              );
            if (!args.paddockProtocol)
              return mcpError(
                "Harness evolve error",
                "paddockProtocol is required for action=paddock",
              );
            if (!args.summary?.trim())
              return mcpError(
                "Harness evolve error",
                "summary is required for action=paddock",
              );
            return mcpJson({
              action: args.action,
              paddock: registerHarnessPaddockAdapter({
                paddockId: args.paddockId,
                kind: args.paddockKind as HarnessPaddockAdapterKind,
                protocol: args.paddockProtocol as HarnessPaddockProtocol,
                summary: args.summary,
                command: parseJsonArray<string>(
                  args.commandJson,
                  "commandJson",
                ),
                endpoint: args.endpoint,
                toolsets: parseJsonArray<string>(
                  args.toolsetsJson,
                  "toolsetsJson",
                ),
                capabilities: parseJsonArray<string>(
                  args.capabilitiesJson,
                  "capabilitiesJson",
                ),
                headerNames: parseJsonArray<string>(
                  args.headerNamesJson,
                  "headerNamesJson",
                ),
              }),
            });
          }
          case "paddocks":
            return mcpJson({
              action: args.action,
              paddocks: listHarnessPaddockAdapters(args.limit ?? 20),
            });
          case "sandbox": {
            if (args.release) {
              if (!args.leaseId?.trim())
                return mcpError(
                  "Harness evolve error",
                  "leaseId is required to release sandbox",
                );
              return mcpJson({
                action: args.action,
                lease: releaseHarnessSandboxLease({
                  leaseId: args.leaseId,
                  reason: args.reason,
                }),
              });
            }
            if (!args.sandboxSpecJson)
              return mcpError(
                "Harness evolve error",
                "sandboxSpecJson is required for action=sandbox",
              );
            return mcpJson({
              action: args.action,
              lease: createHarnessSandboxLease({
                leaseId: args.leaseId,
                candidateId: args.candidateId,
                taskSetId: args.taskSetId,
                spec: JSON.parse(args.sandboxSpecJson) as HarnessSandboxSpec,
              }),
            });
          }
          case "sandboxes":
            return mcpJson({
              action: args.action,
              leases: listHarnessSandboxLeases(args.limit ?? 20),
            });
          case "rollout_batch": {
            if (args.complete) {
              if (!args.batchId?.trim())
                return mcpError(
                  "Harness evolve error",
                  "batchId is required to complete rollout_batch",
                );
              return mcpJson({
                action: args.action,
                batch: completeHarnessRolloutBatch({
                  batchId: args.batchId,
                  candidateTraceIdsByTask: args.candidateTraceMapByTaskJson
                    ? (JSON.parse(args.candidateTraceMapByTaskJson) as Record<
                        string,
                        string
                      >)
                    : {},
                  trainingExportId: args.exportId,
                  rewardReportId: args.rewardReportId,
                  reason: args.reason,
                }),
              });
            }
            if (!args.taskSetId?.trim())
              return mcpError(
                "Harness evolve error",
                "taskSetId is required for action=rollout_batch",
              );
            if (!args.candidateId?.trim())
              return mcpError(
                "Harness evolve error",
                "candidateId is required for action=rollout_batch",
              );
            return mcpJson({
              action: args.action,
              batch: createHarnessRolloutBatch({
                batchId: args.batchId,
                mode: args.rolloutMode as HarnessRolloutMode | undefined,
                taskSetId: args.taskSetId,
                candidateId: args.candidateId,
                paddockId: args.paddockId,
                sandboxLeaseIds: parseJsonArray<string>(
                  args.sandboxLeaseIdsJson,
                  "sandboxLeaseIdsJson",
                ),
                candidateTraceIdsByTask: args.candidateTraceMapByTaskJson
                  ? (JSON.parse(args.candidateTraceMapByTaskJson) as Record<
                      string,
                      string
                    >)
                  : {},
                trainingExportId: args.exportId,
                rewardReportId: args.rewardReportId,
              }),
            });
          }
          case "rollout_batches":
            return mcpJson({
              action: args.action,
              batches: listHarnessRolloutBatches(args.limit ?? 20),
            });
          case "reward": {
            if (args.rewardId && args.taskSetId && args.candidateId) {
              return mcpJson({
                action: args.action,
                report: evaluateHarnessReward({
                  rewardId: args.rewardId,
                  taskSetId: args.taskSetId,
                  candidateId: args.candidateId,
                  rolloutBatchId: args.batchId,
                  trainingExportId: args.exportId,
                }),
              });
            }
            if (!args.rewardKind)
              return mcpError(
                "Harness evolve error",
                "rewardKind is required for action=reward when not evaluating",
              );
            if (!args.summary?.trim())
              return mcpError(
                "Harness evolve error",
                "summary is required for action=reward",
              );
            return mcpJson({
              action: args.action,
              reward: registerHarnessRewardFunction({
                rewardId: args.rewardId,
                kind: args.rewardKind as HarnessRewardFunctionKind,
                summary: args.summary,
                weight: args.rewardWeight,
                sourceVerifierId: args.verifierId,
                rubric: args.rubric,
              }),
            });
          }
          case "rewards":
            return mcpJson({
              action: args.action,
              rewards: listHarnessRewardFunctions(args.limit ?? 20),
            });
          case "reward_reports":
            return mcpJson({
              action: args.action,
              reports: listHarnessRewardReports(args.limit ?? 20),
            });
          case "rule": {
            if (!args.ruleKind)
              return mcpError(
                "Harness evolve error",
                "ruleKind is required for action=rule",
              );
            if (!args.summary?.trim())
              return mcpError(
                "Harness evolve error",
                "summary is required for action=rule",
              );
            if (!args.guidance?.trim())
              return mcpError(
                "Harness evolve error",
                "guidance is required for action=rule",
              );
            return mcpJson({
              action: args.action,
              rule: registerHarnessRule({
                ruleId: args.ruleId,
                kind: args.ruleKind as HarnessRuleKind,
                summary: args.summary,
                guidance: args.guidance,
                appliesTo: parseJsonArray<string>(
                  args.appliesToJson,
                  "appliesToJson",
                ),
                triggers: parseJsonArray<string>(
                  args.triggersJson,
                  "triggersJson",
                ),
                severity: args.ruleSeverity,
                skillRef: args.skillRef,
                verifierIds: parseJsonArray<string>(
                  args.verifierIdsJson,
                  "verifierIdsJson",
                ),
              }),
            });
          }
          case "rules":
            return mcpJson({
              action: args.action,
              rules: listHarnessRules(args.limit ?? 50),
            });
          case "feedback":
            return mcpJson({
              action: args.action,
              feedback: compileHarnessFeedback({
                feedbackId: args.feedbackId,
                traceId: parseJsonArray<string>(
                  args.traceIdsJson,
                  "traceIdsJson",
                )[0],
                candidateId: args.candidateId,
                taskSetId: args.taskSetId,
                manualText: args.manualText,
                ruleIds: parseJsonArray<string>(
                  args.ruleIdsJson,
                  "ruleIdsJson",
                ),
              }),
            });
          case "feedbacks":
            return mcpJson({
              action: args.action,
              feedbacks: listHarnessFeedback(args.limit ?? 50),
            });
          case "gc":
            return mcpJson({
              action: args.action,
              report: runHarnessGcLoop({
                reportId: args.gcReportId,
                since: args.since,
                limit: args.limit,
              }),
            });
          case "gc_reports":
            return mcpJson({
              action: args.action,
              reports: listHarnessGcReports(args.limit ?? 20),
            });
          case "autonomy_policy": {
            if (!args.summary?.trim())
              return mcpError(
                "Harness evolve error",
                "summary is required for action=autonomy_policy",
              );
            return mcpJson({
              action: args.action,
              policy: registerHarnessAutonomyPolicy({
                policyId: args.policyId,
                summary: args.summary,
                defaultDecision: args.defaultDecision,
                rules: args.autonomyRulesJson
                  ? (JSON.parse(
                      args.autonomyRulesJson,
                    ) as HarnessAutonomyPolicy["rules"])
                  : undefined,
              }),
            });
          }
          case "autonomy_policies":
            return mcpJson({
              action: args.action,
              policies: listHarnessAutonomyPolicies(args.limit ?? 20),
            });
          case "autonomy_decide": {
            if (!args.autonomyAction?.trim())
              return mcpError(
                "Harness evolve error",
                "autonomyAction is required for action=autonomy_decide",
              );
            return mcpJson({
              action: args.action,
              decision: decideHarnessAutonomy({
                decisionId: args.decisionId,
                policyId: args.policyId,
                action: args.autonomyAction,
                risk: args.risk,
                confidence: args.confidence,
                candidateId: args.candidateId,
                runId: args.runId,
                evidenceRefs: parseJsonArray<string>(
                  args.evidenceRefsJson,
                  "evidenceRefsJson",
                ),
              }),
            });
          }
          case "autonomy_decisions":
            return mcpJson({
              action: args.action,
              decisions: listHarnessAutonomyDecisions(args.limit ?? 20),
            });
          case "context_topology": {
            if (!args.summary?.trim())
              return mcpError(
                "Harness evolve error",
                "summary is required for action=context_topology",
              );
            return mcpJson({
              action: args.action,
              topology: createHarnessContextTopology({
                topologyId: args.topologyId,
                summary: args.summary,
                nodes: parseJsonArray<HarnessContextNode>(
                  args.contextNodesJson,
                  "contextNodesJson",
                ),
                edges: parseJsonArray<HarnessContextTopology["edges"][number]>(
                  args.contextEdgesJson,
                  "contextEdgesJson",
                ),
                includeRules: args.includeRules,
                includeTaskSets: args.includeTaskSets,
              }),
            });
          }
          case "context_topologies":
            return mcpJson({
              action: args.action,
              topologies: listHarnessContextTopologies(args.limit ?? 20),
            });
          case "context_route":
            return mcpJson({
              action: args.action,
              route: routeHarnessContext({
                routeId: args.routeId,
                topologyId: args.topologyId,
                taskId: args.taskSetId,
                candidateId: args.candidateId,
                changedFiles: parseJsonArray<string>(
                  args.changedFilesJson,
                  "changedFilesJson",
                ),
                limit: args.limit,
              }),
            });
          case "context_routes":
            return mcpJson({
              action: args.action,
              routes: listHarnessContextRoutes(args.limit ?? 20),
            });
          case "index":
            return mcpJson({
              action: args.action,
              index: buildHarnessArtifactIndex({ limit: args.limit }),
            });
          case "doctor":
            return mcpJson({
              action: args.action,
              report: doctorHarnessArtifactStore({ limit: args.limit }),
            });
          case "skill_patch": {
            if (!args.candidateId?.trim())
              return mcpError(
                "Harness evolve error",
                "candidateId is required for action=skill_patch",
              );
            if (!args.baseSkill?.trim())
              return mcpError(
                "Harness evolve error",
                "baseSkill is required for action=skill_patch",
              );
            return mcpJson({
              action: args.action,
              patch: decideHarnessSkillPatch({
                candidateId: args.candidateId,
                baseSkill: args.baseSkill,
                candidateSkill: args.candidateSkill,
                patchId: args.patchId,
                patchBudget: {
                  maxFiles: args.maxFiles,
                  maxBytes: args.maxBytes,
                },
                selectionDelta: args.selectionDelta,
                regressionPassed: args.regressionPassed,
                policyPassed: args.policyPassed,
                auditPassed: args.auditPassed,
                accepted: args.accepted,
                reason: args.reason,
              }),
            });
          }
          case "rejected":
            if (args.candidateId?.trim()) {
              return mcpJson({
                action: args.action,
                entry: recordHarnessRejectedBuffer({
                  candidateId: args.candidateId,
                  patchId: args.patchId,
                  selectionDelta: args.selectionDelta,
                  regressionFailures: parseJsonArray<string>(
                    args.regressionFailuresJson,
                    "regressionFailuresJson",
                  ),
                  rejectionReason:
                    args.reason ?? "manual rejected buffer entry",
                  reviewNotes: args.reviewNotes,
                }),
              });
            }
            return mcpJson({
              action: args.action,
              entries: listHarnessRejectedBuffer(args.limit ?? 20),
            });
          case "create": {
            if (!args.summary?.trim())
              return mcpError(
                "Harness evolve error",
                "summary is required for action=create",
              );
            return mcpJson({
              action: args.action,
              candidate: createHarnessCandidate({
                candidateId: args.candidateId,
                summary: args.summary,
                sourceDir: args.sourceDir,
                editableSurface: parseJsonArray<string>(
                  args.editableSurfaceJson,
                  "editableSurfaceJson",
                ),
                expectedFixes: parseJsonArray<string>(
                  args.expectedFixesJson,
                  "expectedFixesJson",
                ),
                possibleRegressions: parseJsonArray<string>(
                  args.possibleRegressionsJson,
                  "possibleRegressionsJson",
                ),
                evidenceTraceIds: parseJsonArray<string>(
                  args.evidenceTraceIdsJson,
                  "evidenceTraceIdsJson",
                ),
                failureSignatureIds: parseJsonArray<string>(
                  args.failureSignatureIdsJson,
                  "failureSignatureIdsJson",
                ),
                parentCandidateIds: parseJsonArray<string>(
                  args.parentCandidateIdsJson,
                  "parentCandidateIdsJson",
                ),
                datasetIds: parseJsonArray<string>(
                  args.datasetIdsJson,
                  "datasetIdsJson",
                ),
                author: "runoff_harness_evolve",
              }),
            });
          }
          case "propose": {
            const config = loadConfig();
            const providerName =
              args.provider ??
              config.orchestration?.plannerProvider ??
              Object.keys(config.providers)[0];
            if (!providerName || !config.providers[providerName]) {
              return mcpError(
                "Harness evolve error",
                "provider is required for action=propose",
              );
            }
            const provider = createProvider(
              providerName,
              config.providers[providerName]!,
            );
            if (!provider)
              return mcpError(
                "Harness evolve error",
                `provider "${providerName}" cannot execute proposals`,
              );
            return mcpJson({
              action: args.action,
              ...(await proposeHarnessCandidate({
                candidateId: args.candidateId,
                provider,
                summary: args.summary,
                sourceDir: args.sourceDir,
                editableSurface: parseJsonArray<string>(
                  args.editableSurfaceJson,
                  "editableSurfaceJson",
                ),
                expectedFixes: parseJsonArray<string>(
                  args.expectedFixesJson,
                  "expectedFixesJson",
                ),
                possibleRegressions: parseJsonArray<string>(
                  args.possibleRegressionsJson,
                  "possibleRegressionsJson",
                ),
                evidenceTraceIds: parseJsonArray<string>(
                  args.evidenceTraceIdsJson,
                  "evidenceTraceIdsJson",
                ),
                failureSignatureIds: parseJsonArray<string>(
                  args.failureSignatureIdsJson,
                  "failureSignatureIdsJson",
                ),
                parentCandidateIds: parseJsonArray<string>(
                  args.parentCandidateIdsJson,
                  "parentCandidateIdsJson",
                ),
                datasetIds: parseJsonArray<string>(
                  args.datasetIdsJson,
                  "datasetIdsJson",
                ),
                instructions: args.instructions,
              })),
            });
          }
          case "evolve": {
            const config = loadConfig();
            const providerName =
              args.provider ??
              config.orchestration?.plannerProvider ??
              Object.keys(config.providers)[0];
            if (!providerName || !config.providers[providerName]) {
              return mcpError(
                "Harness evolve error",
                "provider is required for action=evolve",
              );
            }
            const provider = createProvider(
              providerName,
              config.providers[providerName]!,
            );
            if (!provider)
              return mcpError(
                "Harness evolve error",
                `provider "${providerName}" cannot execute proposals`,
              );
            return mcpJson({
              action: args.action,
              ...(await evolveHarnessCandidate({
                candidateId: args.candidateId,
                provider,
                summary: args.summary,
                sourceDir: args.sourceDir,
                editableSurface: parseJsonArray<string>(
                  args.editableSurfaceJson,
                  "editableSurfaceJson",
                ),
                expectedFixes: parseJsonArray<string>(
                  args.expectedFixesJson,
                  "expectedFixesJson",
                ),
                possibleRegressions: parseJsonArray<string>(
                  args.possibleRegressionsJson,
                  "possibleRegressionsJson",
                ),
                evidenceTraceIds: parseJsonArray<string>(
                  args.evidenceTraceIdsJson,
                  "evidenceTraceIdsJson",
                ),
                failureSignatureIds: parseJsonArray<string>(
                  args.failureSignatureIdsJson,
                  "failureSignatureIdsJson",
                ),
                parentCandidateIds: parseJsonArray<string>(
                  args.parentCandidateIdsJson,
                  "parentCandidateIdsJson",
                ),
                datasetIds: parseJsonArray<string>(
                  args.datasetIdsJson,
                  "datasetIdsJson",
                ),
                instructions: args.instructions,
                iterations: args.iterations,
                earlyStopThreshold: args.earlyStopThreshold,
                reflectOnTrajectory: args.reflectOnTrajectory,
              })),
            });
          }
          case "run": {
            if (!args.summary?.trim())
              return mcpError(
                "Harness evolve error",
                "summary is required for action=run",
              );
            const config = loadConfig();
            const providerName =
              args.provider ??
              config.orchestration?.plannerProvider ??
              Object.keys(config.providers)[0];
            if (!providerName || !config.providers[providerName]) {
              return mcpError(
                "Harness evolve error",
                "provider is required for action=run",
              );
            }
            const provider = createProvider(
              providerName,
              config.providers[providerName]!,
            );
            if (!provider)
              return mcpError(
                "Harness evolve error",
                `provider "${providerName}" cannot execute harness evolution runs`,
              );
            const candidateTraceMap = args.candidateTraceMapJson
              ? (JSON.parse(args.candidateTraceMapJson) as Record<
                  string,
                  string
                >)
              : undefined;
            const candidateTraceMapByTask = args.candidateTraceMapByTaskJson
              ? (JSON.parse(args.candidateTraceMapByTaskJson) as Record<
                  string,
                  string
                >)
              : undefined;
            return mcpJson({
              action: args.action,
              run: await runHarnessEvolution({
                runId: args.runId,
                candidateId: args.candidateId,
                datasetId: args.datasetId,
                taskSetId: args.taskSetId,
                frontierId: args.frontierId,
                provider,
                summary: args.summary,
                sourceDir: args.sourceDir,
                editableSurface: parseJsonArray<string>(
                  args.editableSurfaceJson,
                  "editableSurfaceJson",
                ),
                expectedFixes: parseJsonArray<string>(
                  args.expectedFixesJson,
                  "expectedFixesJson",
                ),
                possibleRegressions: parseJsonArray<string>(
                  args.possibleRegressionsJson,
                  "possibleRegressionsJson",
                ),
                traceIds: parseJsonArray<string>(
                  args.traceIdsJson,
                  "traceIdsJson",
                ),
                failureSignatureIds: parseJsonArray<string>(
                  args.failureSignatureIdsJson,
                  "failureSignatureIdsJson",
                ),
                leakageTerms: parseJsonArray<string>(
                  args.leakageTermsJson,
                  "leakageTermsJson",
                ),
                instructions: args.instructions,
                candidateTraceIdsByBaseline: candidateTraceMap,
                candidateTraceIdsByTask: candidateTraceMapByTask,
                rolePolicy: args.rolePolicyJson
                  ? (JSON.parse(args.rolePolicyJson) as HarnessRolePolicy)
                  : undefined,
                connectors: parseJsonArray<HarnessConnectorTarget>(
                  args.connectorsJson,
                  "connectorsJson",
                ),
                baseSkill: args.baseSkill,
                candidateSkill: args.candidateSkill,
                exportOnAccept: args.exportOnAccept,
              }),
            });
          }
          case "report": {
            if (!args.runId?.trim())
              return mcpError(
                "Harness evolve error",
                "runId is required for action=report",
              );
            return mcpJson({
              action: args.action,
              report: queryHarnessEvolutionReport(args.runId),
            });
          }
          case "runs":
            return mcpJson({
              action: args.action,
              runs: listHarnessEvolutionRuns().slice(0, args.limit ?? 20),
            });
          case "trigger_scan":
            return mcpJson({
              action: args.action,
              scan: scanHarnessTriggers({
                scanId: args.scanId,
                rules: parseJsonArray<HarnessTriggerRule>(
                  args.rulesJson,
                  "rulesJson",
                ),
              }),
            });
          case "writeback": {
            if (!args.runId?.trim())
              return mcpError(
                "Harness evolve error",
                "runId is required for action=writeback",
              );
            return mcpJson({
              action: args.action,
              writebacks: writeHarnessConnectorReport({
                runId: args.runId,
                targets: parseJsonArray<HarnessConnectorTarget>(
                  args.connectorsJson,
                  "connectorsJson",
                ),
              }),
            });
          }
          case "evaluate": {
            if (!args.candidateId?.trim())
              return mcpError(
                "Harness evolve error",
                "candidateId is required for action=evaluate",
              );
            const pairs = parseJsonArray<HarnessEvalPair>(
              args.evalPairsJson,
              "evalPairsJson",
            );
            if (!pairs.length)
              return mcpError(
                "Harness evolve error",
                "evalPairsJson is required for action=evaluate",
              );
            return mcpJson({
              action: args.action,
              gate: evaluateHarnessCandidate({
                candidateId: args.candidateId,
                pairs,
              }),
            });
          }
          case "evaluate_dataset": {
            if (!args.candidateId?.trim())
              return mcpError(
                "Harness evolve error",
                "candidateId is required for action=evaluate_dataset",
              );
            if (!args.datasetId?.trim())
              return mcpError(
                "Harness evolve error",
                "datasetId is required for action=evaluate_dataset",
              );
            const candidateTraceMap = args.candidateTraceMapJson
              ? (JSON.parse(args.candidateTraceMapJson) as Record<
                  string,
                  string
                >)
              : {};
            return mcpJson({
              action: args.action,
              evaluation: evaluateHarnessDataset({
                candidateId: args.candidateId,
                datasetId: args.datasetId,
                candidateTraceIdsByBaseline: candidateTraceMap,
              }),
            });
          }
          case "evaluate_taskset": {
            if (!args.candidateId?.trim())
              return mcpError(
                "Harness evolve error",
                "candidateId is required for action=evaluate_taskset",
              );
            if (!args.taskSetId?.trim())
              return mcpError(
                "Harness evolve error",
                "taskSetId is required for action=evaluate_taskset",
              );
            const candidateTraceMap = args.candidateTraceMapByTaskJson
              ? (JSON.parse(args.candidateTraceMapByTaskJson) as Record<
                  string,
                  string
                >)
              : {};
            const baselineTraceMap = args.baselineTraceMapByTaskJson
              ? (JSON.parse(args.baselineTraceMapByTaskJson) as Record<
                  string,
                  string
                >)
              : undefined;
            return mcpJson({
              action: args.action,
              evaluation: evaluateHarnessTaskSet({
                candidateId: args.candidateId,
                taskSetId: args.taskSetId,
                candidateTraceIdsByTask: candidateTraceMap,
                baselineTraceIdsByTask: baselineTraceMap,
                runId: args.runId,
                skillVersion: args.baseSkill,
              }),
            });
          }
          case "audit": {
            if (!args.candidateId?.trim())
              return mcpError(
                "Harness evolve error",
                "candidateId is required for action=audit",
              );
            return mcpJson({
              action: args.action,
              audit: auditHarnessCandidate({
                candidateId: args.candidateId,
                datasetId: args.datasetId,
                leakageTerms: parseJsonArray<string>(
                  args.leakageTermsJson,
                  "leakageTermsJson",
                ),
              }),
            });
          }
          case "rank":
            return mcpJson({
              action: args.action,
              ranks: rankHarnessCandidates(
                parseJsonArray<string>(
                  args.candidateIdsJson,
                  "candidateIdsJson",
                ),
              ),
            });
          case "frontier":
            return mcpJson({
              action: args.action,
              frontier: updateHarnessFrontier({
                frontierId: args.frontierId,
                candidateIds: parseJsonArray<string>(
                  args.candidateIdsJson,
                  "candidateIdsJson",
                ),
              }),
            });
          case "decide": {
            if (!args.candidateId?.trim())
              return mcpError(
                "Harness evolve error",
                "candidateId is required for action=decide",
              );
            return mcpJson({
              action: args.action,
              decision: decideHarnessCandidate({
                candidateId: args.candidateId,
                decision: args.decision,
                reason: args.reason,
              }),
            });
          }
          case "export": {
            if (!args.candidateId?.trim())
              return mcpError(
                "Harness evolve error",
                "candidateId is required for action=export",
              );
            return mcpJson({
              action: args.action,
              bundle: exportHarnessPromotionBundle({
                candidateId: args.candidateId,
              }),
            });
          }
          case "list":
            return mcpJson({
              action: args.action,
              candidates: listHarnessCandidates().slice(0, args.limit ?? 20),
            });
        }
      } catch (err: unknown) {
        return mcpErrorFrom("Harness evolve error", err);
      }
    },
  );
}
