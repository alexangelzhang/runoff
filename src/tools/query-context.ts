/**
 * runoff_query_context — optional thin bridge to the external `mfs` CLI.
 * Returns bounded excerpts + contextRefs (never raw search dumps).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  DEFAULT_MFS_EXCERPT_CHARS,
  DEFAULT_MFS_SEARCH_TOP_K,
  detectMfsCli,
  queryMfsContext,
} from "../orchestration/mfs-context-bridge.js";
import { mcpError, mcpErrorFrom, mcpJson } from "./mcp-response.js";

const MODES = ["search", "cat"] as const;

export function register(server: McpServer) {
  server.tool(
    "runoff_query_context",
    "Optional MFS context bridge: bounded search/cat excerpts + contextRefs for loop triage. Does not mutate repos.",
    {
      mode: z.enum(MODES).describe("search | cat"),
      query: z.string().optional().describe("Semantic search query (mode=search)"),
      uri: z.string().optional().describe("mfs:// or file:// URI (mode=cat)"),
      scope: z.string().optional().describe("Search scope path/URI (default: cwd)"),
      all: z.boolean().optional().describe("Search all indexed MFS sources (--all)"),
      topK: z.number().optional().describe(`Max hits (default ${DEFAULT_MFS_SEARCH_TOP_K})`),
      range: z.string().optional().describe("Line range for cat, e.g. 40:60 (mode=cat)"),
      skim: z.boolean().optional().describe("Use mfs cat --skim when true (default true for cat)"),
      workDir: z.string().optional().describe("Working directory for local file reads / mfs cwd"),
      mfsCommand: z.string().optional().describe("MFS CLI binary name/path (default: mfs)"),
      maxExcerptChars: z
        .number()
        .optional()
        .describe(`Max excerpt chars per ref (default ${DEFAULT_MFS_EXCERPT_CHARS})`),
    },
    async (args) => {
      try {
        const probe = detectMfsCli(args.mfsCommand);

        const result = queryMfsContext({
          mode: args.mode,
          query: args.query,
          uri: args.uri,
          scope: args.scope,
          all: args.all,
          topK: args.topK,
          range: args.range,
          skim: args.skim,
          mfsCommand: args.mfsCommand,
          cwd: args.workDir,
          maxExcerptChars: args.maxExcerptChars,
        });

        if (result.error && !result.promptBlock && !result.excerpt && !result.hits?.length) {
          return mcpJson(
            {
              ...result,
              probe,
              hint: probe.available
                ? undefined
                : "Install mfs-cli and run mfs-server, or gather context manually per docs/guides/mfs-context-layer.md",
            },
            { isError: true },
          );
        }

        return mcpJson({ ...result, probe });
      } catch (err: unknown) {
        return mcpErrorFrom("Query context error", err);
      }
    },
  );
}
