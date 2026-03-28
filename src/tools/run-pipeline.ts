import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveRepoRoot } from "../workspace.js";
import { SessionWorkspace } from "../workspace.js";
import {
  loadConfig,
  getDagStages,
  calculateConfigHash,
  clearDagStagesCache
} from "../config.js";
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
import {
  PipelineResult,
  PipelineParams,
  ensureWorkDirForStep,
  pipelineHasAgentWriteStep
} from "./helpers.js";
import { 
  recordTrace, 
  type StepTrace 
} from "../trace.js";
import {
  ExecutionScheduler,
  SchedulerContext
} from "../scheduler.js";
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
  } catch (err: any) {
    if (controller.signal?.aborted) {
      throw new Error(`Pipeline global timeout exceeded (${GLOBAL_TIMEOUT_MS}ms). All background processes terminated.`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutTimer);
  }
}

async function executePipelineInternal(args: PipelineParams & { signal?: AbortSignal }): Promise<PipelineResult> {
  const config = loadConfig();
  const currentConfigHash = calculateConfigHash(config);
  
  const { 
    prompt, language, context, workDir, acceptanceCriteria, 
    verifyResults, sessionId: originalSessionId, 
    maxRounds: requestedMaxRounds, setPipelineTraceId, signal
  } = args;
  
  const sessionId = originalSessionId ?? (randomUUID() as string);
  let traceId = (randomUUID() as string);
  const startTime = Date.now();

  const stages = getDagStages(config);
  const maxRounds = requestedMaxRounds ?? config.retry?.maxRounds ?? 1;
  const reviewStepName = config.retry?.reviewStep ?? "review";

  const scheduler = new ExecutionScheduler(config);
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
       Object.assign(config.pipeline, resumedState.dynamicPipeline);
    }
  }

  if (setPipelineTraceId) setPipelineTraceId(traceId);

  let workspace: SessionWorkspace | null = null;
  let effectiveWorkDir = workDir;

  try {
    if (workDir && pipelineHasAgentWriteStep(config)) {
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

    const checkpointSnapshot = (currentRound: number, status: PipelineStatus = "running"): PipelineState => ({
      sessionId: sessionId,
      prompt,
      round: currentRound,
      maxRounds,
      lastCode: getCandidateContent(candidate),
      lastReviewFeedback,
      approved,
      stepResults,
      stepTraces,
      globalKnowledge,
      traceId,
      timestamp: new Date().toISOString(),
      status,
      resume: resumeMetadata,
      dynamicPipeline: config.pipeline, // Save the evolved DAG
      ...(workspace ? {
        workspacePath: workspace.worktreePath,
        workspaceRepoRoot: workspace.repoRoot,
        workspaceBaseRef: workspace.baseRef,
      } : {}),
    });

    let round = startRound;
    let finalStatus: PipelineStatus = "running";
    let completedRounds = 0;

    for (; round <= maxRounds; round++) {
      let stepFailed = false;
      const completedThisRound = new Set<string>();

      // Loop until no more steps can be executed in this round
      while (true) {
        if (stepFailed) break;

        // Re-calculate stages based on current (potentially expanded) pipeline
        const allStages = getDagStages(config);
        const nextStage = allStages.find(s => s.some(step => !stepResults[step] && !completedThisRound.has(step)));
        
        if (!nextStage) break; // Nothing left to do in this DAG

        // Only run steps in this stage that haven't been done
        const pendingInStage = nextStage.filter(s => !stepResults[s] && !completedThisRound.has(s));
        if (pendingInStage.length === 0) break;

        const stageOutcomes = await Promise.all(pendingInStage.map(async (stepName) => {
          if (args.sessionId && round === startRound && stepResults[stepName]) return { skipped: true, stepName };
          
          ensureWorkDirForStep(stepName, config, workDir);

          const ctx: SchedulerContext = {
            prompt, language, context, workDir: effectiveWorkDir,
            sessionId: traceId, round, globalKnowledge, candidate,
            acceptanceCriteria, verifyResults, signal
          };

          const outcome = await scheduler.executeStep(stepName, ctx);
          return outcome;
        }));

        for (const outcome of stageOutcomes) {
          if ("skipped" in outcome) continue;
          const { stepName, response, trace, verdict, candidateSnapshot } = outcome;
          
          const stepResult: StepResult = {
            round, status: response.failed ? "failed" : "success",
            provider: outcome.usedProvider, routedFrom: outcome.routedFrom,
            durationMs: outcome.durationMs, error: response.error, usage: response.usage
          };

          if (!response.failed && candidateSnapshot) {
            candidate = { ...candidateSnapshot };
            stepResult.candidateSnapshot = { ...candidate };
          }

          stepResults[stepName] = stepResult;
          stepTraces.push(trace);
          costTracker.addCall(stepName, "unknown", response.model, response.usage || { promptTokens: 0, completionTokens: 0 });
          completedThisRound.add(stepName);

          // Wave 6: Dynamic DAG Expansion - Inject nextSteps
          if (outcome.nextSteps && Array.isArray(outcome.nextSteps)) {
            for (const ns of outcome.nextSteps) {
              if (!config.pipeline[ns.name]) {
                console.log(`[Orchestrator] Injecting dynamic step: ${ns.name} (from ${stepName})`);
                // Auto-depend on the parent if no deps specified
                const deps = ns.dependsOn || [stepName];
                config.pipeline[ns.name] = [ns.provider, ...deps];
                // Reset cached stages to force re-calculation
                clearDagStagesCache();
              }
            }
          }

          // Merge insights
          if (response.insights) {
            globalKnowledge = { ...globalKnowledge, ...response.insights };
          }

          if (response.failed) { stepFailed = true; break; }

          if (stepName === reviewStepName && verdict) {
            approved = verdict.approved;
            lastReviewFeedback = verdict.feedback;
            if (approved) break;
          }
        }
      }
      completedRounds++;
      if (approved) { finalStatus = "approved"; break; }
      if (stepFailed && finalStatus === "running") { finalStatus = "failed"; break; }
      await saveCheckpoint(sessionId, checkpointSnapshot(round));
    }

    if (finalStatus === "running") finalStatus = round > maxRounds ? "max_rounds" : "approved";
    
    const summary = costTracker.getSummary();
    const finalResult: PipelineResult = {
      status: finalStatus as any, rounds: completedRounds,
      totalDurationMs: Date.now() - startTime, totalCostUSD: summary.totalCostUSD,
      checkpointFile: sessionId, traceId, stepResults,
      usage: { promptTokens: summary.totalTokens, completionTokens: 0 },
      costBreakdown: {},
      error: undefined
    };

    recordTrace({
      id: traceId, prompt, promptLength: prompt.length, mode: "pipeline",
      steps: stepTraces, totalRounds: completedRounds, finalStatus: finalStatus as any,
      totalDurationMs: Date.now() - startTime, timestamp: new Date().toISOString(),
      hasVerifyResults: !!verifyResults, totalUsage: { promptTokens: summary.totalTokens, completionTokens: 0 }
    });

    await saveCheckpoint(sessionId, checkpointSnapshot(Math.min(round, maxRounds), finalStatus));
    return finalResult;

  } finally {
    if (workspace) {
      try { await workspace.applyToSource(); } catch (e) { /* best-effort apply */ }
      await workspace.destroy();
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
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Pipeline error: ${err.message}` }],
          isError: true
        };
      }
    }
  );
}
