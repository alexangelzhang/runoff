/**
 * llm_run_step — Execute a single pipeline step with a given provider.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, getProviderForStep } from "../core/config.js";
import { ResponseCache, getCache } from "../routing/cache.js";
import { getSemanticCache } from "../routing/semantic-cache.js";
import { isAgentMode, isTextResponse } from "../providers/types.js";
import { serializeResponse, type PipelineConfig } from "./helpers.js";
import { ensureWorkDirForStep } from "../runtime/pipeline-workdir.js";

export function register(server: McpServer, initialConfig: PipelineConfig) {
  server.tool(
    "llm_run_step",
    `Execute a pipeline step using the configured provider. Available steps: ${Object.keys(initialConfig.pipeline).join(", ")}. ` +
    `Steps configured as "builtin" (e.g. claude) are handled by Claude Code itself and will return an error if called here.`,
    {
      step: z.string().describe(`Pipeline step to execute: ${Object.keys(initialConfig.pipeline).join(", ")}`),
      prompt: z.string().describe("The prompt / specification to send to the provider"),
      language: z.string().optional().describe("Target programming language"),
      context: z.string().optional().describe("Existing code context for style matching"),
      workDir: z.string().optional().describe("Absolute path to project directory (agent mode)"),
    },
    async ({ step, prompt, language, context, workDir }) => {
      try {
        const config = loadConfig();
        const result = getProviderForStep(step, config);
        if (!result) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "skip",
                step,
                reason: `Step "${step}" is configured as builtin — handle it in Claude Code directly.`,
              }, null, 2),
            }],
          };
        }

        ensureWorkDirForStep(step, config, workDir);

        if (!result.provider || Array.isArray(result.provider)) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                step,
                reason: Array.isArray(result.provider)
                  ? `Step "${step}" is a race step — use llm_run_pipeline instead.`
                  : `No provider available for step "${step}".`,
              }, null, 2),
            }],
          };
        }

        const provider = result.provider;
        const useSemantic = config.runtime?.semanticCache === true;
        const cache = useSemantic
          ? getSemanticCache({
              minSimilarity: config.runtime?.semanticCacheMinSimilarity,
            })
          : getCache();
        const providerRunsAsAgent = isAgentMode(provider.mode);
        const cacheKey = ResponseCache.key(result.providerName, prompt, language, context);
        const cacheLookup = {
          provider: result.providerName,
          prompt,
          language,
          context,
        };

        // Agent mode: skip cache entirely (same prompt can produce different results per workDir)
        if (!providerRunsAsAgent) {
          const cached = useSemantic
            ? cache.get(cacheKey, cacheLookup)
            : cache.get(cacheKey);
          if (cached) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  status: "success",
                  step,
                  provider: result.providerName,
                  cached: true,
                  ...serializeResponse(cached),
                }, null, 2),
              }],
            };
          }
        }

        const response = await provider.execute({ prompt, language, context, workDir });

        if (response.failed) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                step,
                provider: result.providerName,
                error: response.error ?? "Unknown execution error",
                ...serializeResponse(response),
              }, null, 2),
            }],
            isError: true,
          };
        }

        // Only cache text mode responses
        if (isTextResponse(response)) {
          if (useSemantic) {
            cache.put(cacheKey, response, cacheLookup);
          } else {
            cache.put(cacheKey, response);
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "success",
              step,
              provider: result.providerName,
              ...serializeResponse(response),
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Step "${step}" error: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
