/**
 * llm_dreamify_tune — grid-search retrieval params using experiment eval data.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "../core/config.js";
import { getPipelineLocalMemory } from "../memory/pipeline-memory.js";
import { runDreamifyTune } from "../dreamify/dreamify-tuner.js";
import { getDreamifyBestParamsPath, loadDreamifyParamsFile } from "../dreamify/dreamify-params.js";
import { mcpError, mcpJson, mcpErrorFrom } from "./mcp-response.js";

export function register(server: McpServer) {
  server.tool(
    "llm_dreamify_tune",
    "Tune pattern retrieval hyperparameters (semantic threshold, limit, decay, file-link overlap) " +
      "from experiments.jsonl + traces. Writes ~/.llm-pipeline/dreamify/best-params.json when improved.",
    {
      experimentId: z.string().describe("A/B experiment id (prompt hash bucket from pipeline hooks)"),
      dryRun: z.boolean().optional().describe("Score only; do not write best-params.json"),
      project: z.string().optional().describe("Memory scope.project (default: default)"),
    },
    async ({ experimentId, dryRun, project }) => {
      try {
        const config = loadConfig();
        const exp = experimentId || config.orchestration?.dreamify?.experimentId;
        if (!exp) {
          return mcpError(
            "Dreamify tune error",
            "experimentId required (arg or orchestration.dreamify.experimentId)",
          );
        }

        const report = runDreamifyTune({
          experimentId: exp as string,
          memory: getPipelineLocalMemory(),
          scope: { project: project ?? config.orchestration?.dreamify?.project ?? "default" },
          dryRun: dryRun ?? false,
        });

        return mcpJson({
          report,
          bestParamsPath: getDreamifyBestParamsPath(),
          activeFile: loadDreamifyParamsFile(),
        });
      } catch (err: unknown) {
        return mcpErrorFrom("Dreamify tune error", err);
      }
    },
  );
}
