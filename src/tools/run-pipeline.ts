import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveRepoRoot } from "../workspace.js";
import { SessionWorkspace } from "../workspace.js";
import { loadConfig, calculateConfigHash } from "../config.js";
import { forkPipelineForRun } from "../orchestration/runtime-pipeline.js";
import { runPipelineDAGLoop } from "../orchestration/pipeline-runner.js";
import { shouldFinalizeAgentWorkspace } from "../orchestration/workspace-policy.js";
import { 
  saveCheckpoint, 
  loadCheckpoint, 
  assertResumeCompatible, 
  buildResumeMetadata,
  type StepResult,
  type PipelineStatus,
  type PipelineState
} from "../state.js";
import { 
  CostTracker 
} from "../pricing.js";
import { PipelineResult, PipelineParams } from "./helpers.js";
import { pipelineUsesGlobalSessionWorkspace } from "../pipeline-workdir.js";
import {
  recordTrace,
  persistRunningPipelineTrace,
  type StepTrace,
} from "../trace.js";
import { ExecutionScheduler } from "../scheduler.js";
import {
  emptyCandidate,
  getCandidateContent,
  Candidate
} from "../candidate.js";
/**
 * Main entry point for pipeline execution with global timeout protection.
 * (Wave 6: Refactored with ExecutionScheduler)
 */
export async function runPipelineMode(args: PipelineParams): Promise<PipelineResult> {
  const GLOBAL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
  const controller = new AbortController();

  const timeoutTimer = setTimeout(() => {
    controller.abort();
  }, GLOBAL_TIMEOUT_MS);

  try {
    const result = await executePipelineInternal({ 
      ...args, 
      signal: controller.signal 
    });
    return result;
  } catch (err: unknown) {
    if (controller.signal?.aborted) {
      throw new Error(`Pipeline global timeout exceeded (${GLOBAL_TIMEOUT_MS}ms). All background processes terminated.`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutTimer);
  }
}

async function executePipelineInternal(args: PipelineParams & { signal?: AbortSignal }): Promise<PipelineResult> {
  const baseConfig = loadConfig();
  const currentConfigHash = calculateConfigHash(baseConfig);
  const runtimeConfig = forkPipelineForRun(baseConfig);

  const {
    prompt,
    language,
    context,
    workDir,
    acceptanceCriteria,
    verifyResults,
    sessionId: originalSessionId,
    maxRounds: requestedMaxRounds,
    setPipelineTraceId,
    signal,
  } = args;

  const sessionId = originalSessionId ?? (randomUUID() as string);
  let traceId = (randomUUID() as string);
  const startTime = Date.now();

  const maxRounds = requestedMaxRounds ?? runtimeConfig.retry?.maxRounds ?? 1;
  const reviewStepName = runtimeConfig.retry?.reviewStep ?? "review";

  const scheduler = new ExecutionScheduler(runtimeConfig);
  const costTracker = new CostTracker();

  const resumeRequest = {
    mode: "pipeline" as const,
    prompt,
    language,
    context,
    workDir,
    acceptanceCriteria,
    verifyResults,
    configHash: currentConfigHash,
  };
  const resumeMetadata = buildResumeMetadata(resumeRequest);

  let stepResults: Record<string, StepResult> = {};
  let candidate: Candidate = emptyCandidate();
  let lastReviewFeedback = "";
  let approved = false;
  let startRound = 1;
  let stepTraces: StepTrace[] = []; 
  let globalKnowledge: Record<string, string> = {}; 
  let resumedState: PipelineState | null = null;

  if (args.sessionId) {
    resumedState = await loadCheckpoint(args.sessionId);
    if (!resumedState) throw new Error(`Checkpoint not found for: ${args.sessionId}`);
    assertResumeCompatible(resumedState, resumeRequest);
    traceId = resumedState.traceId;
    stepResults = resumedState.stepResults;
    const lastStepWithCandidate = Object.values(resumedState.stepResults)
      .filter((sr) => sr.candidateSnapshot)
      .pop();
    if (lastStepWithCandidate?.candidateSnapshot) {
      candidate = { ...lastStepWithCandidate.candidateSnapshot } as Candidate;
    } 
    lastReviewFeedback = resumedState.lastReviewFeedback;
    approved = resumedState.approved;
    startRound = resumedState.round;
    stepTraces = resumedState.stepTraces || [];
    globalKnowledge = resumedState.globalKnowledge || {};
    if (resumedState.dynamicPipeline) {
      Object.assign(runtimeConfig.pipeline, resumedState.dynamicPipeline);
    }
  }

  if (setPipelineTraceId) setPipelineTraceId(traceId);

  let workspace: SessionWorkspace | null = null;
  let effectiveWorkDir = workDir;
  let lastFinalStatus: PipelineStatus = "running";
  const shouldUseGlobalSessionWorkspace = !!workDir && pipelineUsesGlobalSessionWorkspace(runtimeConfig);

  try {
    if (shouldUseGlobalSessionWorkspace) {
      if (resumedState?.workspacePath) {
        workspace = await SessionWorkspace.resume(
          resumedState.workspacePath, resumedState.workspaceRepoRoot!, resumedState.workspaceBaseRef!, traceId
        );
      } else {
        const repoRoot = (await resolveRepoRoot(workDir)) ?? workDir;
        workspace = await SessionWorkspace.create({ repoRoot, sessionId: traceId });
      }
      effectiveWorkDir = await workspace.resolveWorkDir(workDir);
    }

    const loopState = {
      stepResults,
      stepTraces,
      globalKnowledge,
      candidate,
      approved,
      lastReviewFeedback,
    };

    const checkpointSnapshot = (currentRound: number, status: PipelineStatus = "running"): PipelineState => ({
      sessionId: sessionId,
      prompt,
      round: currentRound,
      maxRounds,
      lastCode: getCandidateContent(loopState.candidate),
      lastReviewFeedback: loopState.lastReviewFeedback,
      approved: loopState.approved,
      stepResults: loopState.stepResults,
      stepTraces: loopState.stepTraces,
      globalKnowledge: loopState.globalKnowledge,
      traceId,
      timestamp: new Date().toISOString(),
      status,
      resume: resumeMetadata,
      dynamicPipeline: runtimeConfig.pipeline,
      ...(workspace
        ? {
            workspacePath: workspace.worktreePath,
            workspaceRepoRoot: workspace.repoRoot,
            workspaceBaseRef: workspace.baseRef,
          }
        : {}),
    });

    const { finalStatus, completedRounds, endRound } = await runPipelineDAGLoop({
      runtimeConfig,
      scheduler,
      costTracker,
      state: loopState,
      startRound,
      maxRounds,
      reviewStepName,
      resumeSessionId: args.sessionId,
      traceId,
      prompt,
      language,
      context,
      workDir,
      effectiveWorkDir,
      acceptanceCriteria,
      verifyResults,
      signal,
      onRoundComplete: async (r) => {
        await saveCheckpoint(sessionId, checkpointSnapshot(r));
        const snap = costTracker.getSummary();
        persistRunningPipelineTrace({
          id: traceId,
          prompt,
          promptLength: prompt.length,
          mode: "pipeline",
          steps: [...loopState.stepTraces],
          totalRounds: r,
          finalStatus: "running",
          totalDurationMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          hasVerifyResults: !!verifyResults,
          totalUsage: { promptTokens: snap.totalTokens, completionTokens: 0 },
        });
      },
    });

    lastFinalStatus = finalStatus;

    stepResults = loopState.stepResults;
    stepTraces = loopState.stepTraces;
    globalKnowledge = loopState.globalKnowledge;
    candidate = loopState.candidate;
    approved = loopState.approved;
    lastReviewFeedback = loopState.lastReviewFeedback;
    
    const summary = costTracker.getSummary();
    const finalResult: PipelineResult = {
      status: finalStatus, rounds: completedRounds,
      totalDurationMs: Date.now() - startTime, totalCostUSD: summary.totalCostUSD,
      checkpointFile: sessionId, traceId, stepResults,
      usage: { promptTokens: summary.totalTokens, completionTokens: 0 },
      costBreakdown: {},
      error: undefined
    };

    recordTrace({
      id: traceId, prompt, promptLength: prompt.length, mode: "pipeline",
      steps: stepTraces, totalRounds: completedRounds, finalStatus,
      totalDurationMs: Date.now() - startTime, timestamp: new Date().toISOString(),
      hasVerifyResults: !!verifyResults, totalUsage: { promptTokens: summary.totalTokens, completionTokens: 0 },
      lifecycle: "final",
    });

    await saveCheckpoint(sessionId, checkpointSnapshot(Math.min(endRound, maxRounds), finalStatus));
    return finalResult;

  } finally {
    if (workspace) {
      // Cancel / abort: tear down worktree without applying (issue 6.11).
      if (args.signal?.aborted) {
        try {
          await workspace.destroy();
        } catch {
          /* best-effort */
        }
      } else if (shouldFinalizeAgentWorkspace(lastFinalStatus)) {
        try {
          await workspace.applyToSource();
        } catch {
          /* best-effort apply */
        }
        await workspace.destroy();
      }
    }
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
    },
    async (args) => {
      try {
        const result = await runPipelineMode({ ...args });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: result.status === "failed" || result.status === "aborted"
        };
      } catch (err: unknown) {
        return {
          content: [
            {
              type: "text",
              text: `Pipeline error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true
        };
      }
    }
  );
}
