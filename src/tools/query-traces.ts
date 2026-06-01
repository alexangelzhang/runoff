/**
 * llm_query_traces — Query pipeline execution traces for analysis.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PIPELINE_STATUS_FILTERS } from "../core/state.js";
import {
  queryTraces,
  aggregateTraceStats,
  loadTraceById,
  type TraceQuery,
} from "../observability/trace.js";
import { buildTracePostmortem } from "../observability/trace-postmortem.js";
import { buildTraceListPayload, traceSummaryRow } from "../observability/trace-list-format.js";
import { mcpJson, mcpError, mcpErrorFrom } from "./mcp-response.js";

const TRACE_STATUS_FILTER = PIPELINE_STATUS_FILTERS;

export function register(server: McpServer) {
  server.tool(
    "runoff_query_traces",
    "Query pipeline execution traces. Use traceId for a single run; format=postmortem for failure analysis; " +
    "detail=true for full JSON. Returns summaries and optional aggregate stats.",
    {
      status: z.enum(TRACE_STATUS_FILTER).optional()
        .describe("Filter by final pipeline status"),
      mode: z.enum(["pipeline", "race"]).optional().describe("Filter by execution mode"),
      since: z.string().optional().describe("ISO date string — only traces after this timestamp"),
      until: z.string().optional().describe("ISO date string — only traces before this timestamp"),
      limit: z.number().optional().describe("Max number of traces to return (most recent first)"),
      traceId: z.string().optional().describe("Load one trace by id"),
      sessionId: z.string().optional().describe("Filter traces by checkpoint session id"),
      detail: z.boolean().optional().describe("Deprecated — use format=full. When true, same as format=full"),
      legacy: z.boolean().optional().describe("When true, list response omits format wrapper (pre-3.0 shape)"),
      format: z.enum(["summary", "full", "postmortem"]).optional()
        .describe("summary (default), full trace JSON, or postmortem analysis"),
      aggregate: z.boolean().optional().describe("Include aggregate statistics (default: true for list queries)"),
    },
    async ({ status, mode, since, until, limit, traceId, sessionId, detail, legacy, format, aggregate }) => {
      try {
        const query: TraceQuery = { status, mode, since, until, limit, traceId, sessionId };
        const fmt = format ?? (detail ? "full" : "summary");

        if (traceId && fmt === "postmortem") {
          const trace = loadTraceById(traceId);
          if (!trace) {
            return mcpError("Trace query error", `Trace not found: ${traceId}`);
          }
          return mcpJson({ format: "postmortem", postmortem: buildTracePostmortem(trace), trace: traceSummaryRow(trace) });
        }

        if (traceId && fmt === "full") {
          const trace = loadTraceById(traceId);
          if (!trace) return mcpError("Trace query error", `Trace not found: ${traceId}`);
          return mcpJson({ format: "full", trace, count: 1 });
        }

        const traces = queryTraces(query);

        if (fmt === "postmortem") {
          return mcpJson({
            format: "postmortem",
            items: traces.map((t) => ({ summary: traceSummaryRow(t), postmortem: buildTracePostmortem(t) })),
            count: traces.length,
          });
        }

        const includeAggregate = aggregate !== false && !traceId;
        const stats = includeAggregate ? aggregateTraceStats(query) : undefined;
        return mcpJson(buildTraceListPayload(traces, fmt, { legacy, detail, stats }));
      } catch (err: unknown) {
        return mcpErrorFrom("Trace query error", err);
      }
    },
  );
}
