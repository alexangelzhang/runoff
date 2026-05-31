/**
 * llm_dream_run — offline Dream worker (tracks A + B + optional C).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "../core/config.js";
import { runDreamWorker } from "../dream/dream-worker.js";

export function register(server: McpServer) {
  server.tool(
    "llm_dream_run",
    "Run offline Dream worker: structure traces (A), apply rule evolution (B), optional LLM enrich (C). " +
      "Writes dream-audit.jsonl and updates dream-state.json lastDreamAt.",
    {
      dryRun: z.boolean().optional().describe("When true, no memory writes or lastDreamAt update"),
      llmEnabled: z.boolean().optional().describe("Override orchestration.dream.llmEnabled"),
      sinceLastRun: z.boolean().optional().describe("Only process experiments since last Dream run"),
      batchLimit: z.number().optional().describe("Max experiment entries to process"),
    },
    async ({ dryRun, llmEnabled, sinceLastRun, batchLimit }) => {
      try {
        const config = loadConfig();
        const report = await runDreamWorker({
          config,
          dryRun: dryRun ?? false,
          llmEnabled,
          sinceLastRun,
          batchLimit,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
          isError: true,
        };
      }
    },
  );
}
