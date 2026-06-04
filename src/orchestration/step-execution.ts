/**
 * B8 follow-up — Pipeline step execution (routing, race, prompts).
 * Shared by executePipelineStep callers and PipelineStepAgent.
 */

import {
  getProviderForStep,
  createProvider,
  type PipelineConfig,
} from "../core/config.js";
import { routeProvider } from "../routing/router.js";
import { isProviderAvailable, recordProviderOutcome } from "../routing/provider-circuit.js";
import { executeProviderRace, resolveRaceBudgetUSD } from "../runtime/race-execution.js";
import { pickRetryProvider, type FailureReason } from "../routing/retry-strategy.js";
import type { PipelineCostAccumulator } from "../routing/pricing.js";
import { renderPrompt } from "../pipeline/prompt.js";
import { buildStructuredPromptForStep } from "./step-strategy.js";
import {
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  isTextResponse,
  isAgentResponse,
  isAgentMode,
  filterValidNextSteps,
  type NextStep,
} from "../providers/types.js";
import { type Candidate, getCandidateContent } from "../core/candidate.js";
import { parseVerdict } from "../core/verdict.js";
import { createStepSpanId, type StepTrace } from "../observability/trace.js";
import { saveRaceSession, type RaceSession } from "../runtime/race-registry.js";
import { logger } from "../core/logger.js";
import {
  resolveProviderRaceWinner,
  verdictFromRaceEntry,
  type ProviderRaceResolution,
} from "./race-merge.js";
import { artifactsFromStepResponse } from "./artifact-bridge.js";
import type { Artifact } from "./artifacts.js";
import {
  isPromptVersionStoreEnabled,
  recordPromptVersion,
} from "../observability/prompt-version.js";

export interface SchedulerContext {
  prompt: string;
  language?: string;
  context?: string;
  workDir?: string;
  sessionId: string;
  pipelineSessionId?: string;
  round: number;
  globalKnowledge: Record<string, string>;
  candidate: Candidate;
  acceptanceCriteria?: string[];
  verifyResults?: string;
  signal?: AbortSignal;
  reviewStepName?: string;
  lastReviewFeedback?: string;
  promptVersionStore?: boolean;
  lastRetryFailure?: { reason: FailureReason; error?: string; provider?: string };
  costTracker?: PipelineCostAccumulator;
  raceBudgetUSD?: number;
  raceEarlyTermination?: boolean;
}

export interface StepOutcome {
  stepName: string;
  response: LLMResponse;
  usedProvider: string;
  routedFrom?: string;
  upgraded: boolean;
  durationMs: number;
  trace: StepTrace;
  verdict?: { approved: boolean; feedback: string };
  candidateSnapshot?: Candidate;
  artifacts?: Artifact[];
  awaitingJudge?: boolean;
  raceSession?: RaceSession;
  /** Index into raceSession.candidates when awaitingJudge (for auto-pick). */
  raceWinnerIndex?: number;
  nextSteps?: NextStep[];
}

/** Execute a single pipeline step (routing, retry upgrade, race, verdict). */
export async function executePipelineStep(
  config: PipelineConfig,
  stepName: string,
  ctx: SchedulerContext,
): Promise<StepOutcome> {
  const sStart = Date.now();
  const reviewStepName = ctx.reviewStepName ?? "review";

  let stepConfig = getProviderForStep(stepName, config);
  let routedFrom: string | undefined;

  if (stepConfig && config.routing?.length && !Array.isArray(stepConfig.provider)) {
    const originalName = stepConfig.providerName;
    const best = routeProvider(ctx.prompt, config.routing, originalName, (p) => isProviderAvailable(p), {
      stepName,
    });
    if (best !== originalName) {
      const pc = config.providers[best];
      if (pc) {
        routedFrom = originalName;
        stepConfig = { providerName: best, provider: createProvider(best, pc) };
      }
    }
  }

  if (!stepConfig) throw new Error(`No provider found for step: ${stepName}`);

  let upgraded = false;
  let providers: LLMProvider[];
  let providerNames: string[];

  if (Array.isArray(stepConfig.provider)) {
    providers = stepConfig.provider;
    providerNames = stepConfig.providerName.split("|");
  } else {
    let finalP: LLMProvider | null = stepConfig.provider as LLMProvider | null;
    let finalName = stepConfig.providerName;
    if (ctx.round > 1) {
      const all = Object.keys(config.providers);
      const reason = ctx.lastRetryFailure?.reason ?? "unknown";
      const better = pickRetryProvider(finalName, all, config.providers, reason);
      if (better !== finalName) {
        logger.info("scheduler", `Retry strategy (${reason}) for ${stepName}: ${finalName} -> ${better}`);
        const pc = config.providers[better];
        if (pc) {
          finalP = createProvider(better, pc);
          finalName = better;
          upgraded = true;
        }
      }
    }
    if (!finalP) throw new Error(`No provider found for step "${stepName}"`);
    providers = [finalP];
    providerNames = [finalName];
  }

  const conflictResolution = (config.orchestration?.conflictResolution ??
    "pick-winner") as ProviderRaceResolution;

  const structuredPrompt = buildStructuredPromptForStep({
    stepName,
    reviewStepName,
    spec: ctx.prompt,
    round: ctx.round,
    globalKnowledge: ctx.globalKnowledge,
    candidate: ctx.candidate,
    acceptanceCriteria: ctx.acceptanceCriteria,
    verifyResults: ctx.verifyResults,
    lastReviewFeedback: ctx.lastReviewFeedback,
    context: ctx.context,
  });

  const renderedPrompt = renderPrompt(structuredPrompt);
  let promptVersionId: string | undefined;
  if (isPromptVersionStoreEnabled(ctx.promptVersionStore)) {
    try {
      promptVersionId = recordPromptVersion({
        traceId: ctx.sessionId,
        stepName,
        round: ctx.round,
        structured: structuredPrompt,
        rendered: renderedPrompt,
      }).id;
    } catch {
      // non-critical
    }
  }

  const baseReq: LLMRequest = {
    prompt: renderedPrompt,
    system: structuredPrompt.system,
    staticContext: structuredPrompt.staticContext,
    dynamicContext: structuredPrompt.dynamicContext,
    language: ctx.language,
    context: getCandidateContent(ctx.candidate) || ctx.context,
    workDir: ctx.workDir,
    sessionId: ctx.sessionId,
    stepName,
    round: ctx.round,
    signal: ctx.signal,
  };

  const isAgentRace = providers.length > 1 && providers.some((provider) => isAgentMode(provider.mode));

  const raceBudgetUSD = resolveRaceBudgetUSD(
    ctx.raceBudgetUSD,
    config.runtime?.costBudgetUSD,
  );
  const raceEarlyTermination = config.orchestration?.raceEarlyTermination !== false;
  const useRaceEarlyTermination = raceEarlyTermination && !isAgentRace;

  const responses =
    providers.length > 1
      ? await executeProviderRace({
          providers,
          stepName,
          parentSignal: ctx.signal,
          raceBudgetUSD,
          costTracker: ctx.costTracker,
          earlyTermination: useRaceEarlyTermination,
          buildRequest: (provider) =>
            isAgentRace && isAgentMode(provider.mode)
              ? {
                  ...baseReq,
                  finalizeStrategy: "defer",
                  sharedLockKey: ctx.sessionId,
                }
              : baseReq,
        })
      : [
          await (async () => {
            const provider = providers[0]!;
            const req: LLMRequest =
              isAgentRace && isAgentMode(provider.mode)
                ? {
                    ...baseReq,
                    finalizeStrategy: "defer",
                    sharedLockKey: ctx.sessionId,
                  }
                : baseReq;
            const resp = await provider.execute(req);
            const verdict = parseVerdict(
              isTextResponse(resp) ? resp.content || "" : resp.summary || "",
            );
            return { provider, resp, verdict };
          })(),
        ];

  const raceEntries = responses.map((r, i) => ({
    provider: r.provider,
    providerName: providerNames[i] ?? r.provider.name,
    resp: r.resp,
  }));

  const racePick =
    providers.length > 1
      ? await resolveProviderRaceWinner(raceEntries, conflictResolution, {
          stepName,
          prompt: ctx.prompt,
        })
      : {
          entry: raceEntries[0]!,
          merged: false,
          mergeStrategy: "pick-winner" as const,
        };

  const response = racePick.entry.resp;
  const verdictParsed = verdictFromRaceEntry(racePick.entry);
  const finalProviderName =
    providers.length > 1
      ? racePick.merged
        ? raceEntries.map((e) => e.providerName).join("+")
        : racePick.entry.providerName
      : providerNames[0];
  const raceFinalize = config.runtime?.raceFinalize ?? "defer";
  const awaitingJudge =
    !racePick.merged &&
    providers.length > 1 &&
    (
      // Agent race: pause when at least one candidate produced a real workspace
      (isAgentRace && responses.some(({ resp }) => isAgentResponse(resp) && !!resp.workspace)) ||
      // Text race with explicit defer config: pause so human can compare diffs
      (!isAgentRace && raceFinalize === "defer")
    );

  const durationMs = Date.now() - sStart;
  let candidateSnapshot: Candidate | undefined;
  if (!response.failed && !awaitingJudge) {
    if (isTextResponse(response)) {
      candidateSnapshot = { code: response.code, isAgent: false };
    } else if (isAgentResponse(response)) {
      candidateSnapshot = {
        changes: response.changes,
        summary: response.summary,
        filesModified: response.filesModified,
        diffStat: response.diffStat,
        workspace: response.workspace?.workspacePath,
        isAgent: true,
      };
    }
  }

  const stepOk = !response.failed;
  if (providers.length > 1) {
    for (const { provider, resp } of responses) {
      recordProviderOutcome(provider.name, !resp.failed);
    }
  } else {
    recordProviderOutcome(finalProviderName, stepOk);
  }

  const trace: StepTrace = {
    name: stepName,
    provider: finalProviderName,
    routedFrom,
    durationMs,
    round: ctx.round,
    promptVersionId,
    usage: response.usage,
    error: response.error,
    errorDetail: response.error
      ? { message: response.error, source: finalProviderName }
      : undefined,
    spanId: createStepSpanId(),
    filesModified: isAgentResponse(response) ? response.filesModified : undefined,
    isAgent: isAgentResponse(response),
    verdict:
      verdictParsed.format === "structured"
        ? verdictParsed.approved
          ? "approved"
          : "needs_revision"
        : undefined,
    upgraded,
    ...(providers.length > 1
      ? {
          raceMergeStrategy: racePick.mergeStrategy,
          raceMerged: racePick.merged,
          ...(racePick.conflictFiles?.length ? { raceMergeConflicts: racePick.conflictFiles } : {}),
        }
      : {}),
  };

  const raceWinnerIndex =
    awaitingJudge
      ? Math.max(0, responses.findIndex((r) => r.provider.name === racePick.entry.providerName))
      : undefined;

  let raceSession: RaceSession | undefined;
  if (awaitingJudge) {
    trace.raceParticipants = providerNames;
    const applyTargetPath =
      responses
        .map(({ resp }) => (isAgentResponse(resp) ? resp.workspace?.workspaceRepoRoot : undefined))
        .find((value): value is string => typeof value === "string" && value.length > 0) ??
      ctx.workDir ??
      process.cwd();

    raceSession = saveRaceSession({
      traceId: ctx.sessionId,
      sessionId: ctx.pipelineSessionId,
      applyTargetPath,
      candidates: responses.map(({ provider, resp }) => ({
        providerName: provider.name,
        workspacePath: isAgentResponse(resp) ? resp.workspace?.workspacePath : undefined,
        workspaceRepoRoot: isAgentResponse(resp) ? resp.workspace?.workspaceRepoRoot : undefined,
        workspaceBaseRef: isAgentResponse(resp) ? resp.workspace?.workspaceBaseRef : undefined,
        workspaceSharedLockKey: isAgentResponse(resp) ? resp.workspace?.workspaceSharedLockKey : undefined,
        // Agent race: use workspace changes; text race: use code output as patch
        patchText: isAgentResponse(resp) ? resp.changes : (isTextResponse(resp) ? resp.code : undefined),
        filesModified: isAgentResponse(resp) ? resp.filesModified : undefined,
        diffStat: isAgentResponse(resp) ? resp.diffStat : undefined,
      })),
      createdAt: Date.now(),
    });
  }

  const artifacts = artifactsFromStepResponse(response, {
    stepName,
    producedBy: stepName,
    verdict:
      verdictParsed.format === "structured"
        ? { approved: verdictParsed.approved, feedback: verdictParsed.feedback }
        : undefined,
    reviewText:
      verdictParsed.format === "structured" && !verdictParsed.approved
        ? verdictParsed.feedback
        : undefined,
  });

  return {
    stepName,
    response,
    usedProvider: finalProviderName,
    routedFrom,
    upgraded,
    durationMs,
    trace,
    verdict: { approved: verdictParsed.approved, feedback: verdictParsed.feedback },
    candidateSnapshot,
    artifacts: artifacts.length > 0 ? artifacts : undefined,
    awaitingJudge,
    raceSession,
    raceWinnerIndex,
    nextSteps: filterValidNextSteps(response.nextSteps),
  };
}
