import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { executePipelineRun } from "../orchestration/pipeline-mcp-run.js";
import { PipelineResult, PipelineParams } from "./helpers.js";

/**
 * Main entry point for pipeline execution with global timeout protection.
 */
export async function runPipelineMode(args: PipelineParams): Promise<PipelineResult> {
  const GLOBAL_TIMEOUT_MS = 30 * 60 * 1000;
  const controller = new AbortController();

  const timeoutTimer = setTimeout(() => {
    controller.abort();
  }, GLOBAL_TIMEOUT_MS);

  try {
    return await executePipelineRun({
      ...args,
      signal: controller.signal,
    });
  } catch (err: unknown) {
    if (controller.signal.aborted) {
      throw new Error(
        `Pipeline global timeout exceeded (${GLOBAL_TIMEOUT_MS}ms). All background processes terminated.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutTimer);
  }
}

export function register(server: McpServer) {
  server.tool(
    "llm_run_pipeline",
    "Execute full multi-agent pipeline with parallel stages and automatic retries.",
    {
      prompt: z.string().describe("Specification for the code changes"),
      language: z.string().optional().describe("Target programming language"),
      context: z.string().optional().describe("Existing code context"),
      workDir: z.string().optional().describe("Absolute path to project directory"),
      acceptanceCriteria: z.array(z.string()).optional().describe("List of constraints to verify"),
      verifyResults: z.string().optional().describe("Verification instructions"),
      sessionId: z.string().optional().describe("Resume from a specific checkpoint"),
      maxRounds: z.number().optional().describe("Override max pipeline rounds"),
      approvalDecision: z
        .enum(["approve", "reject"])
        .optional()
        .describe("Required when resuming a checkpoint in awaiting_approval status"),
      approvalReason: z.string().optional().describe("Reason when approvalDecision is reject"),
    },
    async (toolArgs) => {
      try {
        const result = await runPipelineMode({ ...toolArgs });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: result.status === "failed" || result.status === "aborted",
        };
      } catch (err: unknown) {
        return {
          content: [
            {
              type: "text",
              text: `Pipeline error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
