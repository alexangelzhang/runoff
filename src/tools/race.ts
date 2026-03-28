/**
 * llm_race_apply + llm_race_abort — Race session finalization tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { updateTrace } from "../trace.js";
import { raceSessions } from "./helpers.js";

export function register(server: McpServer) {
  server.tool(
    "llm_race_apply",
    "Finalize a race: apply the winning candidate's changes to the source repo, " +
    "clean up all candidate workspaces, and update the trace status.",
    {
      traceId: z.string().describe("The traceId returned by llm_run_pipeline in race mode"),
      winnerIndex: z.number().describe("The index of the winning candidate (0-based)"),
    },
    async ({ traceId, winnerIndex }) => {
      try {
        const session = raceSessions.get(traceId);
        if (!session) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              status: "error",
              reason: `No active race session found for traceId "${traceId}". It may have expired or already been applied.`,
            }, null, 2) }],
            isError: true,
          };
        }

        if (winnerIndex < 0 || winnerIndex >= session.candidates.length) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              status: "error",
              reason: `Invalid winnerIndex ${winnerIndex}. Must be 0-${session.candidates.length - 1}.`,
            }, null, 2) }],
            isError: true,
          };
        }

        const winner = session.candidates[winnerIndex];

        // Apply the winning candidate's changes
        if (winner.workspace) {
          await winner.workspace.applyToSource();
        }

        // Destroy all candidate workspaces
        for (const c of session.candidates) {
          if (c.workspace) {
            try { await c.workspace.destroy(); } catch { /* best effort */ }
          }
        }

        // Update trace: mark winner and set status to approved
        updateTrace(traceId, {
          finalStatus: "approved",
          candidates: session.candidates.map((c: any, idx: number) => ({
            provider: c.providerName,
            durationMs: 0,
            filesModified: c.filesModified,
            diffStat: c.diffStat,
            isWinner: idx === winnerIndex,
          })),
        });

        // Clean up registry
        raceSessions.delete(traceId);

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            status: "applied",
            traceId,
            winnerIndex,
            winnerProvider: winner.providerName,
            filesModified: winner.filesModified,
            diffStat: winner.diffStat,
          }, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Race apply error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "llm_race_abort",
    "Abort a race session, reject all candidates, and clean up all candidate workspaces without applying anything.",
    {
      traceId: z.string().describe("The traceId returned by llm_run_pipeline in race mode"),
      reason: z.string().optional().describe("Reason for aborting the race"),
    },
    async ({ traceId, reason }) => {
      try {
        const session = raceSessions.get(traceId);
        if (!session) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              status: "error",
              reason: `No active race session found for traceId "${traceId}". It may have expired.`,
            }, null, 2) }],
            isError: true,
          };
        }

        // Destroy all candidate workspaces
        for (const c of session.candidates) {
          if (c.workspace) {
            try { await c.workspace.destroy(); } catch { /* best effort */ }
          }
        }

        // Update trace
        updateTrace(traceId, {
          finalStatus: "aborted",
        });

        // Clean up registry
        raceSessions.delete(traceId);

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            status: "aborted",
            traceId,
            reason,
            workspacesCleaned: session.candidates.filter(c => c.workspace).length
          }, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Race abort error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
