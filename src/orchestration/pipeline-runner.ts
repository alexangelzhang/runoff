import type { PipelineConfig } from "../core/config.js";
import { getDagStages, clearDagStagesCache } from "../core/config.js";
import type { Candidate } from "../core/candidate.js";
import type { RaceCandidateSnapshot } from "../runtime/race-registry.js";
import {
  assertStepTransition,
  type StepResult,
  type StepStatus,
  type PipelineStatus,
} from "../core/state.js";
import type { StepTrace } from "../observability/trace.js";
import { recordPipelineStepCost, type PipelineCostAccumulator } from "../routing/pricing.js";
import { ensureWorkDirForStep } from "../runtime/pipeline-workdir.js";
import { logger } from "../core/logger.js";
import { applyRaceSession, abortRaceSession } from "../runtime/race-finalize.js";
import type { SchedulerContext, StepOutcome } from "./step-execution.js";
import type { ExecutionGovernance } from "./execution-governance.js";
import {
  PipelineAwaitingApprovalError,
  PolicyDenialError,
  roleForStep,
  schedulerContextToAgentTask,
} from "./execution-governance.js";
import { TripwireError } from "./guardrails.js";
import { agentId } from "./multi-agent-types.js";
import type { AgentResult } from "./agent.js";
import { SharedContext } from "./shared-context.js";
import {
  createParallelBranches,
  mergeParallelStageBranchesAsync,
  recordOutcomeOnBranch,
  resolveStageMergeMode,
} from "./context-integration.js";
import { WorkspaceOwnershipRegistry } from "./ownership.js";
import type { AgentRegistry } from "./registry.js";
import type { AgentToolRegistry } from "./agent-tools.js";
import { executeWorkflowParallelStage, useWorkflowAgents } from "./workflow-bridge.js";
import { classifyStepFailure, type FailureReason } from "../routing/retry-strategy.js";
import type { ExecutionPlan, OrchestrationContext, Orchestrator } from "./orchestrator.js";
import {
  appendNodeToAgentGraph,
  agentGraphToStages,
  syncExecutionPlanFromAgentGraph,
  type AgentGraph,
} from "./agent-graph.js";
import {
  appendStepToExecutionPlan,
  executionPlanToStages,
} from "./plan-scheduler.js";
import { resolveStepRunner, type StepRunner } from "./step-runner.js";
import type { EventLog } from "./event-log.js";
import { applyReflectReplan, shouldReflectOnTrigger } from "./reflect.js";
import { buildStepObservation } from "./observation.js";
import { assignArtifactIds } from "./artifacts.js";

export type MutablePipelineRunState = {
  stepResults: Record<string, StepResult>;
  stepTraces: StepTrace[];
  globalKnowledge: Record<string, string>;
  candidate: Candidate;
  approved: boolean;
  lastReviewFeedback: string;
  /** Phase 5.5: drives retry provider selection on round > 1. */
  lastRetryFailure?: { reason: FailureReason; error?: string; provider?: string };
  pendingRaceTraceId?: string;
  raceCandidates?: RaceCandidateSnapshot[];
  /** Parallel-stage branch/merge (Phase 7.4); recreated each round. */
  sharedContext?: SharedContext;
};

export type PipelineDAGLoopOptions = {
  runtimeConfig: PipelineConfig;
  /** B8: orchestration-layer step execution (required unless `agentRegistry` is set). */
  stepRunner?: StepRunner;
  costTracker: PipelineCostAccumulator;
  state: MutablePipelineRunState;
  pipelineSessionId: string;
  startRound: number;
  maxRounds: number;
  /** Defaults to "review" when omitted. */
  reviewStepName?: string;
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
  /** Called after each step completes (for cost tracking, event logging). */
  onStepComplete?: (ctx: { stepTrace: StepTrace; stepName: string; provider: string; model: string; usage: { promptTokens: number; completionTokens: number } }) => void;
  governance?: ExecutionGovernance;
  agentRegistry?: AgentRegistry;
  agentTools?: AgentToolRegistry;
  /** Backlog B3: orchestrator-owned execution plan (replaces getDagStages for wave order). */
  executionPlan?: ExecutionPlan;
  /** B7: runtime agent topology; when set, wave order follows `agentGraph.waves`. */
  agentGraph?: AgentGraph;
  orchestrator?: Orchestrator;
  orchestrationContext?: OrchestrationContext;
  /** Optional event log for plan_revision events after reflect. */
  eventLog?: EventLog;
};

import {
  failedStepOutcome,
  isStepCompletedForRound,
  outcomeToAgentResult,
  resolvePipelineStages,
} from "./pipeline-runner-helpers.js";

/** Attempt reflect-driven replan after a round. Returns true if the plan was updated. */
async function tryReflectReplan(opts: {
  runtimeConfig: PipelineConfig;
  orchestrator: Orchestrator;
  orchestrationContext: OrchestrationContext;
  executionPlan: ExecutionPlan;
  agentGraph: AgentGraph;
  state: MutablePipelineRunState;
  round: number;
  stepFailed: boolean;
  eventLog?: EventLog;
  traceId: string;
}): Promise<boolean> {
  const { runtimeConfig, orchestrator, orchestrationContext, executionPlan, agentGraph, state, round, stepFailed, eventLog, traceId } = opts;
  const trigger = stepFailed ? "step_failure" : "review_revision";
  if (!shouldReflectOnTrigger(runtimeConfig, trigger)) return false;

  orchestrationContext.round = round + 1;
  orchestrationContext.sharedKnowledge = { ...state.globalKnowledge };
  const failedStep = stepFailed
    ? Object.entries(state.stepResults).find(([, sr]) => sr.status === "failed")?.[0]
    : undefined;
  try {
    const replanned = await applyReflectReplan({
      config: runtimeConfig,
      orchestrator,
      context: orchestrationContext,
      executionPlan,
      agentGraph,
      trigger,
      details: {
        focusStep: failedStep,
        errorMessage: state.lastRetryFailure?.error,
        reviewFeedback: state.lastReviewFeedback,
      },
      eventLog,
      traceId,
    });
    if (replanned) {
      logger.info("orchestrator", `Reflect re-plan applied (${trigger})`);
      return true;
    }
  } catch {
    // non-critical
  }
  return false;
}

/**
 * Round-based DAG execution: parallel stages within each wave, dynamic step injection, review gating.
 * When `executionPlan` + `orchestrator` are set, waves follow the plan and callbacks drive next actions (B3).
 */
export async function runPipelineDAGLoop(
  opts: PipelineDAGLoopOptions
): Promise<{ finalStatus: PipelineStatus; completedRounds: number; endRound: number }> {
  const {
    runtimeConfig,
    costTracker,
    state,
    pipelineSessionId,
    startRound,
    maxRounds,
    reviewStepName: reviewStepNameOpt,
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
    onStepComplete,
    governance,
    agentRegistry,
    executionPlan,
    agentGraph,
    orchestrator,
    orchestrationContext,
    eventLog,
  } = opts;

  const stepRunner = resolveStepRunner(opts);

  const reviewStepName = reviewStepNameOpt ?? "review";
  const workflowMode = useWorkflowAgents(runtimeConfig);
  const initialPipelineSize = Object.keys(runtimeConfig.pipeline).length;

  let round = startRound;
  let finalStatus: PipelineStatus = "running";
  let pausedForApproval = false;
  let completedRounds = 0;
  const workspaceLeases = new WorkspaceOwnershipRegistry();
  const stageMergeMode = resolveStageMergeMode(runtimeConfig);

  for (; round <= maxRounds; round++) {
    let stepFailed = false;
    const completedThisRound = new Set<string>();
    state.pendingRaceTraceId = undefined;
    state.raceCandidates = undefined;
    state.sharedContext = new SharedContext();

    while (true) {
      if (stepFailed) break;

      const allStages = resolvePipelineStages(runtimeConfig, executionPlan, agentGraph);
      const nextStage = allStages.find((stage) =>
        stage.some((step) => !isStepCompletedForRound(state.stepResults, step, round) && !completedThisRound.has(step))
      );

      if (!nextStage) break;

      const pendingInStage = nextStage.filter(
        (stepName) => !isStepCompletedForRound(state.stepResults, stepName, round) && !completedThisRound.has(stepName)
      );
      if (pendingInStage.length === 0) break;

      const isParallelStage = pendingInStage.length > 1;
      const parallelBranches = isParallelStage
        ? createParallelBranches(state.sharedContext!, pendingInStage)
        : undefined;
      const branchIdByStep = new Map<string, string>();
      if (parallelBranches) {
        for (const [stepName, { branchId }] of parallelBranches) {
          branchIdByStep.set(stepName, branchId);
        }
      }

      let stageOutcomes: StepOutcome[];
      try {
        const runStageSteps = async (): Promise<StepOutcome[]> => {
          if (workflowMode && agentRegistry && isParallelStage) {
            const baseTask = schedulerContextToAgentTask(
              pendingInStage[0]!,
              {
                prompt,
                language,
                context,
                workDir: effectiveWorkDir,
                sessionId: traceId,
                pipelineSessionId,
                round,
                globalKnowledge: state.globalKnowledge,
                candidate: { ...state.candidate },
                acceptanceCriteria,
                verifyResults,
                signal,
                reviewStepName,
                lastReviewFeedback: state.lastReviewFeedback,
              },
              reviewStepName,
            );
            return executeWorkflowParallelStage({
              registry: agentRegistry,
              stepRunner,
              stepNames: pendingInStage,
              reviewStepName,
              baseTask,
              buildContext: (stepName, task) => ({
                prompt: task.prompt,
                language: task.language,
                context: task.context,
                workDir: task.workDir,
                sessionId: traceId,
                pipelineSessionId,
                round: task.round,
                globalKnowledge: state.globalKnowledge,
                candidate: { ...state.candidate },
                acceptanceCriteria,
                verifyResults,
                signal: task.signal,
                reviewStepName,
                lastReviewFeedback: task.reviewFeedback ?? state.lastReviewFeedback,
              }),
            });
          }

          return Promise.all(
          pendingInStage.map(async (stepName) => {
            ensureWorkDirForStep(stepName, runtimeConfig, workDir);

            const prior = state.stepResults[stepName];
            const fromStatus: StepStatus =
              prior && prior.round === round ? prior.status : "queued";
            if (fromStatus === "queued" || fromStatus === "failed") {
              assertStepTransition(fromStatus, "running", stepName);
              state.stepResults[stepName] = { ...prior, round, status: "running" };
            }

            if (effectiveWorkDir) {
              const leaseKey = effectiveWorkDir;
              const holder = stepName;
              const acquired = workspaceLeases.acquire(
                leaseKey,
                holder,
                isParallelStage ? "shared" : "exclusive",
              );
              if (!acquired) {
                return failedStepOutcome(
                  stepName,
                  round,
                  `Workspace lease denied for ${leaseKey}`,
                );
              }
            }

            const ctx: SchedulerContext = {
              prompt,
              language,
              context,
              workDir: effectiveWorkDir,
              sessionId: traceId,
              pipelineSessionId,
              round,
              globalKnowledge: state.globalKnowledge,
              candidate: isParallelStage ? { ...state.candidate } : state.candidate,
              acceptanceCriteria,
              verifyResults,
              signal,
              reviewStepName,
              lastReviewFeedback: state.lastReviewFeedback,
              lastRetryFailure: state.lastRetryFailure,
              costTracker,
              raceBudgetUSD: runtimeConfig.orchestration?.raceBudgetUSD,
              raceEarlyTermination: runtimeConfig.orchestration?.raceEarlyTermination,
              promptVersionStore: runtimeConfig.runtime?.promptVersionStore,
            };

            if (governance) {
              const task = schedulerContextToAgentTask(stepName, ctx, reviewStepName);
              const id = agentId(stepName);
              try {
                await governance.beforeStep({
                  agentId: id,
                  role: roleForStep(stepName, reviewStepName),
                  task,
                  action: "execute_step",
                  targetPath: effectiveWorkDir,
                });
              } catch (err: unknown) {
                if (err instanceof PolicyDenialError) {
                  return failedStepOutcome(stepName, round, err.message);
                }
                if (err instanceof TripwireError) {
                  return failedStepOutcome(stepName, round, err.message);
                }
                throw err;
              }
            }

            const outcome = await stepRunner.executeStep(stepName, ctx);

            if (governance) {
              await governance.afterStep(outcomeToAgentResult(outcome));
            }

            return outcome;
          }),
        );
        };

        stageOutcomes = await runStageSteps();
      } catch (err: unknown) {
        if (err instanceof PipelineAwaitingApprovalError) {
          finalStatus = "awaiting_approval";
          pausedForApproval = true;
          break;
        }
        throw err;
      }

      for (const outcome of stageOutcomes) {
        const {
          stepName,
          response,
          trace,
          verdict,
          candidateSnapshot,
          artifacts,
          awaitingJudge,
          raceSession,
        } = outcome;

        const stepResult: StepResult = {
          round,
          status: response.failed ? "failed" : "success",
          provider: outcome.usedProvider,
          routedFrom: outcome.routedFrom,
          kind: response.kind,
          model: response.model,
          durationMs: outcome.durationMs,
          error: response.error,
          usage: response.usage,
          ...(response.kind === "text"
            ? {
                code: response.code,
                explanation: response.explanation,
              }
            : {
                summary: response.summary,
                changes: response.changes,
                filesModified: response.filesModified,
                diffStat: response.diffStat,
              }),
        };

        const artifactsForStep = artifacts?.length ? assignArtifactIds(stepName, artifacts) : undefined;
        if (artifactsForStep?.length) {
          stepResult.artifacts = artifactsForStep;
        }
        stepResult.observation = buildStepObservation(stepName, stepResult);
        trace.observation = stepResult.observation;

        if (isParallelStage) {
          const branchId = branchIdByStep.get(stepName);
          if (branchId && artifactsForStep?.length) {
            recordOutcomeOnBranch(
              state.sharedContext!,
              branchId,
              artifactsForStep,
              stepResult.filesModified,
            );
          }
        } else if (!response.failed && candidateSnapshot) {
          state.candidate = { ...candidateSnapshot };
          stepResult.candidateSnapshot = { ...state.candidate };
        }

        if (effectiveWorkDir) {
          workspaceLeases.release(effectiveWorkDir, stepName);
        }

        const from = state.stepResults[stepName]?.status ?? "running";
        assertStepTransition(from, stepResult.status, stepName);
        state.stepResults[stepName] = stepResult;
        state.stepTraces.push(trace);
        recordPipelineStepCost(
          costTracker,
          stepName,
          "unknown",
          response.model,
          response.usage || { promptTokens: 0, completionTokens: 0 },
        );
        onStepComplete?.({
          stepTrace: trace,
          stepName,
          provider: "unknown",
          model: response.model,
          usage: response.usage || { promptTokens: 0, completionTokens: 0 },
        });
        completedThisRound.add(stepName);

        if (outcome.nextSteps && Array.isArray(outcome.nextSteps)) {
          for (const ns of outcome.nextSteps) {
            if (!runtimeConfig.pipeline[ns.name]) {
              const dynamicSteps = Object.keys(runtimeConfig.pipeline).length - initialPipelineSize;
              const maxHandoffs = runtimeConfig.orchestration?.maxHandoffs;
              if (typeof maxHandoffs === "number" && dynamicSteps >= maxHandoffs) {
                throw new Error(`Dynamic step limit exceeded (orchestration.maxHandoffs=${maxHandoffs})`);
              }
              logger.info("orchestrator", `Injecting dynamic step: ${ns.name} (from ${stepName})`);
              const deps = ns.dependsOn || [stepName];
              runtimeConfig.pipeline[ns.name] = [ns.provider, ...deps];
              clearDagStagesCache();
              if (agentGraph) {
                appendNodeToAgentGraph(
                  agentGraph,
                  ns.name,
                  { providers: ns.provider, dependsOn: deps },
                  runtimeConfig.pipeline,
                );
                if (executionPlan) {
                  syncExecutionPlanFromAgentGraph(executionPlan, agentGraph);
                }
              } else if (executionPlan) {
                appendStepToExecutionPlan(executionPlan, ns.name);
              }
            }
          }
        }

        if (response.insights) {
          state.globalKnowledge = { ...state.globalKnowledge, ...response.insights };
        }

        if (awaitingJudge) {
          const raceFinalize = runtimeConfig.runtime?.raceFinalize ?? "defer";
          if (raceFinalize === "auto-pick" && raceSession) {
            const winnerIndex = outcome.raceWinnerIndex ?? 0;
            logger.info("orchestrator", `Race auto-pick: applying winner index ${winnerIndex}`);
            try {
              await applyRaceSession(raceSession.traceId, winnerIndex);
              if (candidateSnapshot) state.candidate = candidateSnapshot;
              state.pendingRaceTraceId = undefined;
              state.raceCandidates = undefined;
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              logger.error("orchestrator", `Race auto-pick failed: ${message}`);
              try {
                await abortRaceSession(raceSession.traceId, `auto-pick failed: ${message}`);
              } catch {
                // best-effort cleanup
              }
              state.pendingRaceTraceId = undefined;
              state.raceCandidates = undefined;
              stepFailed = true;
              finalStatus = "failed";
              break;
            }
          } else {
            state.pendingRaceTraceId = raceSession?.traceId ?? traceId;
            state.raceCandidates = raceSession?.candidates.map((candidate) => ({ ...candidate }));
            finalStatus = "awaiting_judge";
            break;
          }
        }

        if (orchestrator && orchestrationContext) {
          const agentResult = outcomeToAgentResult(outcome);
          orchestrationContext.results.set(stepName, agentResult);
          orchestrationContext.round = round;
          orchestrationContext.sharedKnowledge = { ...state.globalKnowledge };
          try {
            const next = await orchestrator.onStepComplete(orchestrationContext, agentResult);
            if (next.type === "done") {
              if (next.success) {
                state.approved = true;
                finalStatus = "approved";
              } else {
                stepFailed = true;
                finalStatus = "failed";
              }
              break;
            }
          } catch {
            // non-critical
          }
        }

        if (response.failed) {
          if (orchestrator && orchestrationContext) {
            try {
              await orchestrator.onStepFailed(orchestrationContext, {
                stepName,
                agentId: agentId(stepName),
                error: new Error(response.error ?? "step failed"),
                attempt: round,
              });
            } catch {
              // non-critical
            }
          }
          state.lastRetryFailure = {
            reason: classifyStepFailure({
              failed: true,
              error: response.error,
              response,
              stepName,
              reviewStepName,
            }),
            error: response.error,
            provider: outcome.usedProvider,
          };
          stepFailed = true;
          break;
        }

        if (stepName === reviewStepName && verdict) {
          state.approved = verdict.approved;
          state.lastReviewFeedback = verdict.feedback;
          if (!verdict.approved) {
            state.lastRetryFailure = {
              reason: classifyStepFailure({
                failed: false,
                response,
                stepName,
                reviewStepName,
              }),
              provider: outcome.usedProvider,
            };
          } else {
            state.lastRetryFailure = undefined;
          }
          if (state.approved) break;
        }
      }

      if (isParallelStage && !stepFailed) {
        const mergeOutcome = await mergeParallelStageBranchesAsync(
          state.sharedContext!,
          branchIdByStep,
          stageMergeMode,
          { prompt, config: runtimeConfig },
        );
        if (!mergeOutcome.success) {
          logger.warn(
            "orchestrator",
            `Parallel stage merge failed (${mergeOutcome.strategy}): ${mergeOutcome.conflicts.join(", ")}`,
          );
          stepFailed = true;
        } else {
          state.candidate = mergeOutcome.candidate;
          for (const stepName of branchIdByStep.keys()) {
            const sr = state.stepResults[stepName];
            if (sr) sr.candidateSnapshot = { ...state.candidate };
          }
        }
      }
    }

    completedRounds++;
    if (pausedForApproval || finalStatus === "awaiting_judge") {
      break;
    }
    if (state.approved) {
      finalStatus = "approved";
      break;
    }

    if (
      orchestrator &&
      orchestrationContext &&
      executionPlan &&
      agentGraph &&
      !state.approved &&
      round < maxRounds
    ) {
      const replanned = await tryReflectReplan({
        runtimeConfig,
        orchestrator,
        orchestrationContext,
        executionPlan,
        agentGraph,
        state,
        round,
        stepFailed,
        eventLog,
        traceId,
      });
      if (replanned) {
        stepFailed = false;
        finalStatus = "running";
      }
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

/** Alias: orchestrator `executionPlan` drives stage waves (Backlog B3). */
export const runOrchestratorDrivenLoop = runPipelineDAGLoop;
