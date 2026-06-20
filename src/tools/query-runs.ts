/**
 * runoff_query_runs — Query the harness control plane for active, paused, and completed runs.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "../core/config.js";
import { createControlPlane } from "../orchestration/control-plane.js";
import type { RunStatus } from "../orchestration/run-store.js";
import { queryRuns } from "../orchestration/run-query.js";
import { mcpErrorFrom, mcpJson } from "./mcp-response.js";

const RUN_STATUS_FILTERS = ["running", "paused", "awaiting_approval", "completed", "failed", "cancelled"] as const;

export function register(server: McpServer) {
  server.tool(
    "runoff_query_runs",
    "Query runoff's harness control plane. Lists runs, pending approvals, resume tokens, event cursors, and next-action hints.",
    {
      runId: z.string().optional().describe("Load one run by id / trace id"),
      sessionId: z.string().optional().describe("Filter runs by checkpoint session id"),
      status: z.enum(RUN_STATUS_FILTERS).optional().describe("Filter by run control-plane status"),
      limit: z.number().optional().describe("Max number of runs to return, most recently updated first"),
      format: z.enum(["summary", "full"]).optional().describe("summary (default) or full RunState JSON"),
    },
    async ({ runId, sessionId, status, limit, format }) => {
      try {
        const config = loadConfig();
        const controlPlane = createControlPlane(config);
        return mcpJson(queryRuns({
          runStore: controlPlane.runStore,
          eventLog: controlPlane.eventLog,
          controlPlaneMode: controlPlane.mode,
          runId,
          sessionId,
          status: status as RunStatus | undefined,
          limit,
          format,
        }));
      } catch (err: unknown) {
        return mcpErrorFrom("Run query error", err);
      }
    },
  );
}
