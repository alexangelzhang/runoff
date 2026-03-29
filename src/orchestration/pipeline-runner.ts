import type { PipelineConfig } from "../config.js";
import { getDagStages, clearDagStagesCache } from "../config.js";
import type { Candidate } from "../candidate.js";
import type { StepResult, PipelineStatus } from "../state.js";
import type { StepTrace } from "../trace.js";
import { CostTracker } from "../pricing.js";
import { ensureWorkDirForStep } from "../pipeline-workdir.js";
import { logger } from "../logger.js";
import { ExecutionScheduler, type SchedulerContext } from "../scheduler.js";

export type MutablePipelineRunState = {
  stepResults: Record<string, StepResult>;
  stepTraces: StepTrace[];
  globalKnowledge: Record<string, string>;
  candidate: Candidate;
  approved: boolean;
  lastReviewFeedback: string;
};

export type PipelineDAGLoopOptions = {
  runtimeConfig: PipelineConfig;
  scheduler: ExecutionScheduler;
  costTracker: CostTracker;
  state: MutablePipelineRunState;
  startRound: number;
  maxRounds: number;
  /** Defaults to "review" when omitted. */
  reviewStepName?: string;
  resumeSessionId?: string;
  traceId: string;
  prompt: string;
  language?: string;
  context?: string;
  workDir?: string;
  effectiveWorkDir?: string;
  acceptanceCriteria?: string[];
  verifyResults?: string;
  signal?: AbortSignal;
  onRoundComplete: (round: number) => Promise<void>;
};

/**
 * Round-based DAG execution: parallel stages within each wave, dynamic step injection, review gating.
 */
export async function runPipelineDAGLoop(
  opts: PipelineDAGLoopOptions
): Promise<{ finalStatus: PipelineStatus; completedRounds: number; endRound: number }> {
  const {
    runtimeConfig,
    scheduler,
    costTracker,
    state,
    startRound,
    maxRounds,
    reviewStepName: reviewStepNameOpt,
    resumeSessionId,
    traceId,
    prompt,
    language,
    context,
    workDir,
    effectiveWorkDir,
    acceptanceCriteria,
    verifyResults,
    signal,
    onRoundComplete,
  } = opts;

  const reviewStepName = reviewStepNameOpt ?? "review";

  let round = startRound;
  let finalStatus: PipelineStatus = "running";
  let completedRounds = 0;

  for (; round <= maxRounds; round++) {
    let stepFailed = false;
    const completedThisRound = new Set<string>();

    while (true) {
      if (stepFailed) break;

      const allStages = getDagStages(runtimeConfig);
      const nextStage = allStages.find((s) =>
        s.some((step) => !state.stepResults[step] && !completedThisRound.has(step))
      );

      if (!nextStage) break;

      const pendingInStage = nextStage.filter(
        (s) => !state.stepResults[s] && !completedThisRound.has(s)
      );
      if (pendingInStage.length === 0) break;

      const stageOutcomes = await Promise.all(
        pendingInStage.map(async (stepName) => {
          if (resumeSessionId && round === startRound && state.stepResults[stepName]) {
            return { skipped: true as const, stepName };
          }

          ensureWorkDirForStep(stepName, runtimeConfig, workDir);

          const ctx: SchedulerContext = {
            prompt,
            language,
            context,
            workDir: effectiveWorkDir,
            sessionId: traceId,
            round,
            globalKnowledge: state.globalKnowledge,
            candidate: state.candidate,
            acceptanceCriteria,
            verifyResults,
            signal,
            reviewStepName,
            lastReviewFeedback: state.lastReviewFeedback,
          };

          return scheduler.executeStep(stepName, ctx);
        })
      );

      for (const outcome of stageOutcomes) {
        if ("skipped" in outcome) continue;
        const { stepName, response, trace, verdict, candidateSnapshot, awaitingJudge } = outcome;

        const stepResult: StepResult = {
          round,
          status: response.failed ? "failed" : "success",
          provider: outcome.usedProvider,
          routedFrom: outcome.routedFrom,
          durationMs: outcome.durationMs,
          error: response.error,
          usage: response.usage,
        };

        if (!response.failed && candidateSnapshot) {
          state.candidate = { ...candidateSnapshot };
          stepResult.candidateSnapshot = { ...state.candidate };
        }

        state.stepResults[stepName] = stepResult;
        state.stepTraces.push(trace);
        costTracker.addCall(
          stepName,
          "unknown",
          response.model,
          response.usage || { promptTokens: 0, completionTokens: 0 }
        );
        completedThisRound.add(stepName);

        if (outcome.nextSteps && Array.isArray(outcome.nextSteps)) {
          for (const ns of outcome.nextSteps) {
            if (!runtimeConfig.pipeline[ns.name]) {
              logger.info("orchestrator", `Injecting dynamic step: ${ns.name} (from ${stepName})`);
              const deps = ns.dependsOn || [stepName];
              runtimeConfig.pipeline[ns.name] = [ns.provider, ...deps];
              clearDagStagesCache();
            }
          }
        }

        if (response.insights) {
          state.globalKnowledge = { ...state.globalKnowledge, ...response.insights };
        }

        if (response.failed) {
          stepFailed = true;
          break;
        }

        if (awaitingJudge) {
          finalStatus = "awaiting_judge";
          break;
        }

        if (stepName === reviewStepName && verdict) {
          state.approved = verdict.approved;
          state.lastReviewFeedback = verdict.feedback;
          if (state.approved) break;
        }
      }
    }

    completedRounds++;
    if (finalStatus === "awaiting_judge") {
      break;
    }
    if (state.approved) {
      finalStatus = "approved";
      break;
    }
    if (stepFailed && finalStatus === "running") {
      finalStatus = "failed";
      break;
    }
    await onRoundComplete(round);
  }

  if (finalStatus === "running") {
    finalStatus = round > maxRounds ? "max_rounds" : "approved";
  }

  return { finalStatus, completedRounds, endRound: round };
}
