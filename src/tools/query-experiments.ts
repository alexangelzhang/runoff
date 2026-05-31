/**
 * llm_query_experiments — A/B experiment log, eval report, dataset export (Phase 9+).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PipelineStatus } from "../core/state.js";
import { queryExperiments, summarizeExperiment } from "../observability/experiment-log.js";
import {
  buildExperimentEvalReport,
  buildExperimentDatasetRows,
  exportExperimentDatasetJsonl,
} from "../observability/observability-dataset.js";

const STATUS_FILTER = [
  "approved",
  "failed",
  "max_rounds",
  "running",
  "queued",
  "aborted",
  "awaiting_judge",
  "awaiting_approval",
  "awaiting_plan_approval",
] as const satisfies readonly PipelineStatus[];

const VERDICT_FILTER = ["keep", "discard", "regression"] as const;

export function register(server: McpServer) {
  server.tool(
    "llm_query_experiments",
    "Query A/B experiment log (~/.llm-pipeline/experiments.jsonl). " +
      "Formats: entries (default), summary (per variant), eval-report (winner + recommendation), " +
      "dataset (JSONL export under ~/.llm-pipeline/datasets/).",
    {
      experimentId: z
        .string()
        .optional()
        .describe("Filter by experiment id (prompt hash from pipeline hooks)"),
      variant: z.string().optional().describe("Filter by variant label"),
      status: z.enum(STATUS_FILTER).optional().describe("Filter by pipeline final status"),
      verdict: z.enum(VERDICT_FILTER).optional().describe("Filter by judge verdict"),
      since: z.string().optional().describe("ISO timestamp — entries on or after"),
      limit: z.number().optional().describe("Max entries (most recent when limited)"),
      format: z
        .enum(["entries", "summary", "eval-report", "dataset"])
        .optional()
        .describe("Response shape (default: entries)"),
    },
    async ({ experimentId, variant, status, verdict, since, limit, format }) => {
      try {
        const fmt = format ?? "entries";
        const query = { experimentId, variant, status, verdict, since, limit };

        if (fmt === "summary") {
          if (!experimentId) {
            return errorResponse("experimentId is required for format=summary");
          }
          const summary = summarizeExperiment(experimentId);
          return ok({ format: fmt, experimentId, variants: summary, count: summary.length });
        }

        if (fmt === "eval-report") {
          if (!experimentId) {
            return errorResponse("experimentId is required for format=eval-report");
          }
          const report = buildExperimentEvalReport(experimentId);
          return ok({ format: fmt, report });
        }

        if (fmt === "dataset") {
          if (!experimentId) {
            return errorResponse("experimentId is required for format=dataset");
          }
          const exported = exportExperimentDatasetJsonl(experimentId, { query });
          const preview = buildExperimentDatasetRows(experimentId, query).slice(0, 5);
          return ok({
            format: fmt,
            experimentId,
            datasetPath: exported.path,
            rowCount: exported.rowCount,
            preview,
          });
        }

        const entries = queryExperiments(query);
        return ok({ format: "entries", entries, count: entries.length });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResponse(message);
      }
    },
  );
}

function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: `Experiment query error: ${message}` }],
    isError: true,
  };
}
