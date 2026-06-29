import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { executePipelineRun } from "../orchestration/pipeline-mcp-run.js";
import { PipelineResult, PipelineParams } from "./helpers.js";
import { mcpJson, mcpErrorFrom, pipelineMcpIsError } from "./mcp-response.js";

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
    "runoff_run_pipeline",
    "Execute full multi-agent pipeline with parallel stages and automatic retries.",
    {
      prompt: z.string().describe("Specification for the code changes"),
      language: z.string().optional().describe("Target programming language"),
      context: z.string().optional().describe("Existing code context"),
      workDir: z.string().optional().describe("Absolute path to project directory"),
      acceptanceCriteria: z.array(z.string()).optional().describe("List of constraints to verify"),
      verifyResults: z.string().optional().describe("Verification instructions"),
      scopePreflight: z
        .object({
          allowDirtyWorktree: z.boolean().optional().describe("Confirm the pipeline may run on a dirty git worktree"),
          allowDocUpdates: z.boolean().optional().describe("Confirm documentation updates are in scope"),
          allowRace: z.boolean().optional().describe("Confirm configured provider race is allowed"),
          verificationCommand: z.string().optional().describe("Explicit verification command expected after changes"),
          requireVerificationCommand: z.boolean().optional().describe("Pause unless verificationCommand or verifyResults is supplied"),
          requireCleanWorktree: z.boolean().optional().describe("Pause unless the target git worktree is clean"),
        })
        .optional()
        .describe("P2 scope preflight overrides and confirmations"),
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
        return mcpJson(result, { isError: pipelineMcpIsError(result.status) });
      } catch (err: unknown) {
        return mcpErrorFrom("Pipeline error", err);
      }
    },
  );
}
