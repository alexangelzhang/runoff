/**
 * llm_query_traces — Query pipeline execution traces for analysis.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PipelineStatus } from "../core/state.js";
import { queryTraces, aggregateTraceStats, type TraceQuery } from "../observability/trace.js";

const TRACE_STATUS_FILTER = [
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

export function register(server: McpServer) {
  server.tool(
    "llm_query_traces",
    "Query pipeline execution traces for analysis. Returns trace history and aggregate statistics " +
    "(approval rate, avg duration, provider performance). Useful for data-driven routing decisions.",
    {
      status: z.enum(TRACE_STATUS_FILTER).optional()
        .describe("Filter by final pipeline status"),
      mode: z.enum(["pipeline", "race"]).optional().describe("Filter by execution mode"),
      since: z.string().optional().describe("ISO date string — only traces after this timestamp"),
      until: z.string().optional().describe("ISO date string — only traces before this timestamp"),
      limit: z.number().optional().describe("Max number of traces to return (most recent first)"),
      aggregate: z.boolean().optional().describe("Include aggregate statistics (default: true)"),
    },
    async ({ status, mode, since, until, limit, aggregate }) => {
      try {
        const query: TraceQuery = { status, mode, since, until, limit };
        const traces = queryTraces(query);
        const includeAggregate = aggregate !== false;
        const stats = includeAggregate ? aggregateTraceStats(query) : undefined;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              traces: traces.map((t) => ({
                id: t.id,
                mode: t.mode,
                finalStatus: t.finalStatus,
                totalRounds: t.totalRounds,
                totalDurationMs: t.totalDurationMs,
                timestamp: t.timestamp,
                promptLength: t.promptLength,
                stepCount: t.steps.length,
                candidateCount: t.candidates?.length,
                totalUsage: t.totalUsage,
              })),
              ...(stats ? { stats } : {}),
              count: traces.length,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Trace query error: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
