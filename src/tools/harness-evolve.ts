/**
 * runoff_harness_evolve — local harness evolution control plane.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createProvider, loadConfig } from "../core/config.js";
import {
  auditHarnessCandidate,
  createHarnessCandidate,
  createHarnessDataset,
  createHarnessReplayManifest,
  createHarnessTaskSet,
  createHarnessTrajectory,
  decideHarnessCandidate,
  decideHarnessSkillPatch,
  evaluateHarnessCandidate,
  evaluateHarnessDataset,
  evaluateHarnessTaskSet,
  exportHarnessPromotionBundle,
  listHarnessCandidates,
  listHarnessEvolutionRuns,
  listHarnessRejectedBuffer,
  listHarnessTaskSets,
  listHarnessVerifiers,
  mineHarnessFailureSignatures,
  proposeHarnessCandidate,
  queryHarnessEvolutionReport,
  rankHarnessCandidates,
  recordHarnessRejectedBuffer,
  registerHarnessVerifier,
  runHarnessEvolution,
  scanHarnessTriggers,
  selectHarnessCoreset,
  updateHarnessFrontier,
  writeHarnessConnectorReport,
  type HarnessConnectorTarget,
  type HarnessEvalPair,
  type HarnessRolePolicy,
  type HarnessTask,
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
  "skill_patch",
  "rejected",
  "create",
  "propose",
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
    "Manage local harness evolution: coreset selection, change manifests, isolated variants, dataset runs, regression gates, leakage audits, frontier state, and accept/rollback records.",
    {
      action: z
        .enum(ACTIONS)
        .describe(
          "coreset | mine | dataset | verifier | verifiers | taskset | tasksets | trajectory | replay | skill_patch | rejected | create | propose | run | report | runs | trigger_scan | writeback | evaluate | evaluate_dataset | evaluate_taskset | audit | rank | frontier | decide | export | list",
        ),
      runId: z.string().optional().describe("Harness evolution run id"),
      scanId: z.string().optional().describe("Harness trigger scan id"),
      candidateId: z.string().optional().describe("Harness candidate id"),
      datasetId: z.string().optional().describe("Harness dataset id"),
      taskSetId: z.string().optional().describe("Harness task set id"),
      verifierId: z.string().optional().describe("Harness verifier id"),
      trajectoryId: z.string().optional().describe("Harness trajectory id"),
      replayId: z.string().optional().describe("Harness replay manifest id"),
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
