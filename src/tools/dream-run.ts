/**
 * llm_dream_run — offline Dream worker (tracks A + B + optional C).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "../core/config.js";
import { runDreamWorker } from "../dream/dream-worker.js";
import { mcpJson, mcpErrorFrom } from "./mcp-response.js";

export function register(server: McpServer) {
  server.tool(
    "runoff_dream_run",
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
        return mcpJson(report);
      } catch (err: unknown) {
        return mcpErrorFrom("Dream run error", err);
      }
    },
  );
}
