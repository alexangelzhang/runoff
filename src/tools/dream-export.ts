/**
 * llm_dream_export — export local memory rows to dream-export.jsonl (M4).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "../core/config.js";
import { getPipelineLocalMemory } from "../memory/pipeline-memory.js";
import { exportDreamMemoryJsonl, getDreamExportPath } from "../dream/dream-export.js";

export function register(server: McpServer) {
  server.tool(
    "llm_dream_export",
    "Export pattern/lesson/entity memory to ~/.llm-pipeline/dream-export.jsonl for manual external ingest.",
    {
      project: z.string().optional().describe("Memory scope.project (default: default)"),
      limit: z.number().optional().describe("Max memory entries to scan"),
    },
    async ({ project, limit }) => {
      try {
        const config = loadConfig();
        const scope = {
          project: project ?? config.orchestration?.dreamify?.project ?? "default",
        };
        const result = exportDreamMemoryJsonl(getPipelineLocalMemory(), { scope, limit });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ...result, defaultPath: getDreamExportPath() },
                null,
                2,
              ),
            },
          ],
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
