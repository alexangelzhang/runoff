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
  decideHarnessCandidate,
  evaluateHarnessCandidate,
  evaluateHarnessDataset,
  exportHarnessPromotionBundle,
  listHarnessCandidates,
  mineHarnessFailureSignatures,
  proposeHarnessCandidate,
  rankHarnessCandidates,
  selectHarnessCoreset,
  updateHarnessFrontier,
  type HarnessEvalPair,
} from "../orchestration/harness-evolution.js";
import { mcpError, mcpErrorFrom, mcpJson } from "./mcp-response.js";

const ACTIONS = ["coreset", "mine", "dataset", "create", "propose", "evaluate", "evaluate_dataset", "audit", "rank", "frontier", "decide", "export", "list"] as const;

function parseJsonArray<T>(raw: string | undefined, name: string): T[] {
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${name} must be a JSON array`);
  return parsed as T[];
}

export function register(server: McpServer) {
  server.tool(
    "runoff_harness_evolve",
    "Manage local harness evolution: coreset selection, change manifests, isolated variants, regression gates, self-preference ranking, and accept/rollback records.",
    {
      action: z.enum(ACTIONS).describe("coreset | mine | dataset | create | propose | evaluate | evaluate_dataset | audit | rank | frontier | decide | export | list"),
      candidateId: z.string().optional().describe("Harness candidate id"),
      datasetId: z.string().optional().describe("Harness dataset id"),
      frontierId: z.string().optional().describe("Harness frontier id"),
      summary: z.string().optional().describe("Candidate manifest summary for action=create"),
      provider: z.string().optional().describe("Provider name for action=propose"),
      instructions: z.string().optional().describe("Additional proposer instructions for action=propose"),
      sourceDir: z.string().optional().describe("Optional harness/source directory copied into an isolated variant directory"),
      editableSurfaceJson: z.string().optional().describe("JSON array of editable files/components"),
      expectedFixesJson: z.string().optional().describe("JSON array of expected fixes"),
      possibleRegressionsJson: z.string().optional().describe("JSON array of possible regressions"),
      evidenceTraceIdsJson: z.string().optional().describe("JSON array of evidence trace ids"),
      failureSignatureIdsJson: z.string().optional().describe("JSON array of mined failure signature ids"),
      parentCandidateIdsJson: z.string().optional().describe("JSON array of parent candidate ids"),
      datasetIdsJson: z.string().optional().describe("JSON array of dataset ids"),
      leakageTermsJson: z.string().optional().describe("JSON array of leakage terms"),
      candidateTraceMapJson: z.string().optional().describe("JSON object mapping baseline trace id to candidate trace id"),
      evalPairsJson: z.string().optional().describe("JSON array of {baselineTraceId,candidateTraceId,split:'held-in'|'held-out'}"),
      candidateIdsJson: z.string().optional().describe("JSON array of candidate ids for ranking"),
      traceIdsJson: z.string().optional().describe("JSON array of trace ids for coreset selection"),
      limit: z.number().optional().describe("Limit for list/coreset responses"),
      since: z.string().optional().describe("ISO timestamp lower bound for coreset trace search"),
      heldInRatio: z.number().optional().describe("Held-in ratio for action=dataset"),
      decision: z.enum(["accept", "rollback"]).optional().describe("Explicit decision for action=decide; defaults from gate result"),
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
                traceIds: parseJsonArray<string>(args.traceIdsJson, "traceIdsJson"),
              }),
            });
          case "mine":
            return mcpJson({
              action: args.action,
              signatures: mineHarnessFailureSignatures({
                limit: args.limit,
                since: args.since,
                traceIds: parseJsonArray<string>(args.traceIdsJson, "traceIdsJson"),
              }),
            });
          case "dataset": {
            if (!args.summary?.trim()) return mcpError("Harness evolve error", "summary is required as dataset name for action=dataset");
            return mcpJson({
              action: args.action,
              dataset: createHarnessDataset({
                datasetId: args.datasetId,
                name: args.summary,
                traceIds: parseJsonArray<string>(args.traceIdsJson, "traceIdsJson"),
                failureSignatureIds: parseJsonArray<string>(args.failureSignatureIdsJson, "failureSignatureIdsJson"),
                heldInRatio: args.heldInRatio,
                leakageTerms: parseJsonArray<string>(args.leakageTermsJson, "leakageTermsJson"),
              }),
            });
          }
          case "create": {
            if (!args.summary?.trim()) return mcpError("Harness evolve error", "summary is required for action=create");
            return mcpJson({
              action: args.action,
              candidate: createHarnessCandidate({
                candidateId: args.candidateId,
                summary: args.summary,
                sourceDir: args.sourceDir,
                editableSurface: parseJsonArray<string>(args.editableSurfaceJson, "editableSurfaceJson"),
                expectedFixes: parseJsonArray<string>(args.expectedFixesJson, "expectedFixesJson"),
                possibleRegressions: parseJsonArray<string>(args.possibleRegressionsJson, "possibleRegressionsJson"),
                evidenceTraceIds: parseJsonArray<string>(args.evidenceTraceIdsJson, "evidenceTraceIdsJson"),
                failureSignatureIds: parseJsonArray<string>(args.failureSignatureIdsJson, "failureSignatureIdsJson"),
                parentCandidateIds: parseJsonArray<string>(args.parentCandidateIdsJson, "parentCandidateIdsJson"),
                datasetIds: parseJsonArray<string>(args.datasetIdsJson, "datasetIdsJson"),
                author: "runoff_harness_evolve",
              }),
            });
          }
          case "propose": {
            const config = loadConfig();
            const providerName = args.provider ?? config.orchestration?.plannerProvider ?? Object.keys(config.providers)[0];
            if (!providerName || !config.providers[providerName]) {
              return mcpError("Harness evolve error", "provider is required for action=propose");
            }
            const provider = createProvider(providerName, config.providers[providerName]!);
            if (!provider) return mcpError("Harness evolve error", `provider "${providerName}" cannot execute proposals`);
            return mcpJson({
              action: args.action,
              ...(await proposeHarnessCandidate({
                candidateId: args.candidateId,
                provider,
                summary: args.summary,
                sourceDir: args.sourceDir,
                editableSurface: parseJsonArray<string>(args.editableSurfaceJson, "editableSurfaceJson"),
                expectedFixes: parseJsonArray<string>(args.expectedFixesJson, "expectedFixesJson"),
                possibleRegressions: parseJsonArray<string>(args.possibleRegressionsJson, "possibleRegressionsJson"),
                evidenceTraceIds: parseJsonArray<string>(args.evidenceTraceIdsJson, "evidenceTraceIdsJson"),
                failureSignatureIds: parseJsonArray<string>(args.failureSignatureIdsJson, "failureSignatureIdsJson"),
                parentCandidateIds: parseJsonArray<string>(args.parentCandidateIdsJson, "parentCandidateIdsJson"),
                datasetIds: parseJsonArray<string>(args.datasetIdsJson, "datasetIdsJson"),
                instructions: args.instructions,
              })),
            });
          }
          case "evaluate": {
            if (!args.candidateId?.trim()) return mcpError("Harness evolve error", "candidateId is required for action=evaluate");
            const pairs = parseJsonArray<HarnessEvalPair>(args.evalPairsJson, "evalPairsJson");
            if (!pairs.length) return mcpError("Harness evolve error", "evalPairsJson is required for action=evaluate");
            return mcpJson({ action: args.action, gate: evaluateHarnessCandidate({ candidateId: args.candidateId, pairs }) });
          }
          case "evaluate_dataset": {
            if (!args.candidateId?.trim()) return mcpError("Harness evolve error", "candidateId is required for action=evaluate_dataset");
            if (!args.datasetId?.trim()) return mcpError("Harness evolve error", "datasetId is required for action=evaluate_dataset");
            const candidateTraceMap = args.candidateTraceMapJson ? JSON.parse(args.candidateTraceMapJson) as Record<string, string> : {};
            return mcpJson({
              action: args.action,
              evaluation: evaluateHarnessDataset({ candidateId: args.candidateId, datasetId: args.datasetId, candidateTraceIdsByBaseline: candidateTraceMap }),
            });
          }
          case "audit": {
            if (!args.candidateId?.trim()) return mcpError("Harness evolve error", "candidateId is required for action=audit");
            return mcpJson({
              action: args.action,
              audit: auditHarnessCandidate({
                candidateId: args.candidateId,
                datasetId: args.datasetId,
                leakageTerms: parseJsonArray<string>(args.leakageTermsJson, "leakageTermsJson"),
              }),
            });
          }
          case "rank":
            return mcpJson({
              action: args.action,
              ranks: rankHarnessCandidates(parseJsonArray<string>(args.candidateIdsJson, "candidateIdsJson")),
            });
          case "frontier":
            return mcpJson({
              action: args.action,
              frontier: updateHarnessFrontier({
                frontierId: args.frontierId,
                candidateIds: parseJsonArray<string>(args.candidateIdsJson, "candidateIdsJson"),
              }),
            });
          case "decide": {
            if (!args.candidateId?.trim()) return mcpError("Harness evolve error", "candidateId is required for action=decide");
            return mcpJson({
              action: args.action,
              decision: decideHarnessCandidate({ candidateId: args.candidateId, decision: args.decision, reason: args.reason }),
            });
          }
          case "export": {
            if (!args.candidateId?.trim()) return mcpError("Harness evolve error", "candidateId is required for action=export");
            return mcpJson({
              action: args.action,
              bundle: exportHarnessPromotionBundle({ candidateId: args.candidateId }),
            });
          }
          case "list":
            return mcpJson({ action: args.action, candidates: listHarnessCandidates().slice(0, args.limit ?? 20) });
        }
      } catch (err: unknown) {
        return mcpErrorFrom("Harness evolve error", err);
      }
    },
  );
}
