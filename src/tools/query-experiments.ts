/**
 * llm_query_experiments — A/B experiment log, eval report, dataset export (Phase 9+).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PIPELINE_STATUS_FILTERS } from "../core/state.js";
import { queryExperiments, summarizeExperiment } from "../observability/experiment-log.js";
import {
  buildExperimentEvalReport,
  buildExperimentDatasetRows,
  exportExperimentDatasetJsonl,
} from "../observability/observability-dataset.js";
import { mcpJson, mcpError, mcpErrorFrom } from "./mcp-response.js";

const STATUS_FILTER = PIPELINE_STATUS_FILTERS;

const VERDICT_FILTER = ["keep", "discard", "regression"] as const;

export function register(server: McpServer) {
  server.tool(
    "runoff_query_experiments",
    "Query A/B experiment log (~/.runoff/experiments.jsonl). " +
      "Formats: entries (default), summary (per variant), eval-report (winner + recommendation), " +
      "dataset (JSONL export under ~/.runoff/datasets/).",
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
            return mcpError("Experiment query error", "experimentId is required for format=summary");
          }
          const summary = summarizeExperiment(experimentId);
          return mcpJson({ format: fmt, experimentId, variants: summary, count: summary.length });
        }

        if (fmt === "eval-report") {
          if (!experimentId) {
            return mcpError("Experiment query error", "experimentId is required for format=eval-report");
          }
          const report = buildExperimentEvalReport(experimentId);
          return mcpJson({ format: fmt, report });
        }

        if (fmt === "dataset") {
          if (!experimentId) {
            return mcpError("Experiment query error", "experimentId is required for format=dataset");
          }
          const exported = exportExperimentDatasetJsonl(experimentId, { query });
          const preview = buildExperimentDatasetRows(experimentId, query).slice(0, 5);
          return mcpJson({
            format: fmt,
            experimentId,
            datasetPath: exported.path,
            rowCount: exported.rowCount,
            preview,
          });
        }

        const entries = queryExperiments(query);
        return mcpJson({ format: "entries", entries, count: entries.length });
      } catch (err: unknown) {
        return mcpErrorFrom("Experiment query error", err);
      }
    },
  );
}
