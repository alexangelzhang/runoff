/**
 * llm_memory_status — resolved external memory backend + optional reachability probe.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "../core/config.js";
import { describeMemoryBackend, probeMemoryBackend } from "../memory/memory-backend-status.js";
import { getPipelineMemorySessionKey } from "../memory/pipeline-memory.js";
import { loadDreamState } from "../memory/dream-state.js";
import { mcpJson, mcpErrorFrom } from "./mcp-response.js";

export function register(server: McpServer) {
  server.tool(
    "runoff_memory_status",
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

        return mcpJson(body);
      } catch (err: unknown) {
        return mcpErrorFrom("Memory status error", err);
      }
    },
  );
}
