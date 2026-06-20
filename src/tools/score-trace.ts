/**
 * runoff_score_trace — Append a human or system score to a pipeline trace.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadTraceById } from "../observability/trace.js";
import { appendTraceScore } from "../observability/trace-scores.js";
import { mcpError, mcpJson, mcpErrorFrom } from "./mcp-response.js";

export function register(server: McpServer) {
  server.tool(
    "runoff_score_trace",
    "Record a numeric score for a pipeline trace (stored in ~/.runoff/traces/scores.jsonl). " +
    "Use for human feedback or custom evaluators.",
    {
      traceId: z.string().describe("Pipeline trace id"),
      name: z.string().describe("Score name, e.g. helpfulness or correctness"),
      value: z.number().describe("Numeric score value"),
      comment: z.string().optional().describe("Optional note"),
      source: z.enum(["human", "system"]).optional().describe("Score source (default: human)"),
    },
    async ({ traceId, name, value, comment, source }) => {
      try {
        const trace = loadTraceById(traceId);
        if (!trace) {
          return mcpError("Score trace error", `Trace not found: ${traceId}`);
        }
        const score = appendTraceScore({ traceId, name, value, comment, source });
        return mcpJson({ ok: true, score });
      } catch (err: unknown) {
        return mcpErrorFrom("Score trace error", err);
      }
    },
  );
}
