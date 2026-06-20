/**
 * runoff_query_memory — hybrid local + remote memory search (retrieveMerged).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "../core/config.js";
import { queryPipelineMemoryMerged } from "../memory/memory-backend-status.js";
import { agentId } from "../orchestration/multi-agent-types.js";
import type { MemoryCategory } from "../orchestration/memory.js";
import { mcpJson, mcpErrorFrom } from "./mcp-response.js";

const CATEGORIES = [
  "pattern",
  "lesson",
  "preference",
  "context",
  "trace_summary",
] as const satisfies readonly MemoryCategory[];

export function register(server: McpServer) {
  server.tool(
    "runoff_query_memory",
    "Search pipeline agent memory (local disk + optional Mem0/Zep/http remote via retrieveMerged).",
    {
      query: z.string().optional().describe("Semantic or text search string"),
      textSearch: z.string().optional().describe("Substring match in content (overrides query for text)"),
      agentId: z.string().optional().describe("Filter by agent id"),
      category: z.enum(CATEGORIES).optional(),
      project: z.string().optional().describe("Memory scope.project filter"),
      limit: z.number().optional().describe("Max entries (default 10)"),
      sessionId: z
        .string()
        .optional()
        .describe("Pipeline session — Zep sessionId fallback when not in config"),
    },
    async ({ query, textSearch, agentId: aid, category, project, limit, sessionId }) => {
      try {
        const config = loadConfig();
        const memoryQuery = {
          agentId: aid ? agentId(aid) : undefined,
          category,
          scope: project ? { project } : undefined,
          textSearch: textSearch,
          semanticQuery: textSearch ? undefined : query,
          limit: limit ?? 10,
        };

        const { entries, layered } = await queryPipelineMemoryMerged(config, memoryQuery, {
          pipelineSessionId: sessionId,
        });

        return mcpJson({
          layered,
          count: entries.length,
          entries: entries.map((e) => ({
            id: e.id,
            agentId: e.agentId,
            category: e.category,
            relevance: e.relevance,
            content: e.content.slice(0, 500),
            scope: e.scope,
            createdAt: e.createdAt,
          })),
        });
      } catch (err: unknown) {
        return mcpErrorFrom("Query memory error", err);
      }
    },
  );
}
