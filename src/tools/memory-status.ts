/**
 * llm_memory_status — resolved external memory backend + optional reachability probe.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "../core/config.js";
import { describeMemoryBackend, probeMemoryBackend } from "../memory/memory-backend-status.js";
import { getPipelineMemorySessionKey } from "../memory/pipeline-memory.js";
import { loadDreamState } from "../memory/dream-state.js";

export function register(server: McpServer) {
  server.tool(
    "llm_memory_status",
    "Show resolved pipeline memory backend (local / http / mem0 / zep). " +
      "Set probe=true to attempt a lightweight remote search (requires network/credentials).",
    {
      sessionId: z
        .string()
        .optional()
        .describe("Pipeline session id — used as Zep sessionId when config omits it"),
      probe: z
        .boolean()
        .optional()
        .describe("When true, call remote search once to check reachability"),
    },
    async ({ sessionId, probe }) => {
      try {
        const config = loadConfig();
        const status = describeMemoryBackend(config, { pipelineSessionId: sessionId });
        const body: Record<string, unknown> = {
          status,
          memorySessionKey: getPipelineMemorySessionKey(config, sessionId),
          dreamState: loadDreamState(),
        };

        if (probe) {
          body.probe = await probeMemoryBackend(config, { pipelineSessionId: sessionId });
        }

        return {
          content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
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
