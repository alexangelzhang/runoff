/**
 * runoff_race_apply + runoff_race_abort — Race session finalization tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { applyRaceSession, abortRaceSession } from "../runtime/race-finalize.js";
import { mcpJson, mcpErrorFrom } from "./mcp-response.js";

export function register(server: McpServer) {
  server.tool(
    "runoff_race_apply",
    "Finalize a race: apply the winning candidate's changes to the source repo, clean up all candidate workspaces, and update the trace status.",
    {
      traceId: z.string().describe("The traceId returned by runoff_run_pipeline in race mode"),
      winnerIndex: z.number().describe("The index of the winning candidate (0-based)"),
    },
    async ({ traceId, winnerIndex }) => {
      try {
        const result = await applyRaceSession(traceId, winnerIndex);
        return mcpJson(result);
      } catch (err: unknown) {
        return mcpErrorFrom("Race apply error", err);
      }
    },
  );

  server.tool(
    "runoff_race_abort",
    "Abort a race session, reject all candidates, and clean up all candidate workspaces without applying anything.",
    {
      traceId: z.string().describe("The traceId returned by runoff_run_pipeline in race mode"),
      reason: z.string().optional().describe("Reason for aborting the race"),
    },
    async ({ traceId, reason }) => {
      try {
        const result = await abortRaceSession(traceId, reason);
        return mcpJson(result);
      } catch (err: unknown) {
        return mcpErrorFrom("Race abort error", err);
      }
    },
  );
}
