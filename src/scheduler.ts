import {
  getProviderForStep,
  createProvider,
  PipelineConfig
} from "./config.js";
import {
  routeProvider,
  findUpgradedProvider
} from "./router.js";
import { renderPrompt } from "./prompt.js";
import { buildStructuredPromptForStep } from "./orchestration/step-strategy.js";
import {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  isTextResponse,
  isAgentResponse,
  isAgentMode,
  filterValidNextSteps,
  type NextStep
} from "./providers/types.js";
import {
  Candidate,
  getCandidateContent
} from "./candidate.js";
import {
  parseVerdict
} from "./verdict.js";
import {
  StepTrace
} from "./trace.js";
import {
  isSyntaxValid
} from "./ast_utils.js";
import { raceSessions } from "./race-registry.js";
import { logger } from "./logger.js";

export interface SchedulerContext {
  prompt: string;
  language?: string;
  context?: string;
  workDir?: string;
  sessionId: string;
  round: number;
  globalKnowledge: Record<string, string>;
  candidate: Candidate;
  acceptanceCriteria?: string[];
  verifyResults?: string;
  signal?: AbortSignal;
  /** Matches config retry.reviewStep; defaults to "review" in {@link ExecutionScheduler.executeStep}. */
  reviewStepName?: string;
  /** Last structured review feedback for generate rounds. */
  lastReviewFeedback?: string;
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
  awaitingJudge?: boolean;
  /** Matches TaskResult / IPC nextSteps: name, provider, optional dependsOn */
  nextSteps?: NextStep[];
}

export class ExecutionScheduler {
  private config: PipelineConfig;

  constructor(config: PipelineConfig) {
    this.config = config;
  }

  /**
   * Wave 2: Execute a single DAG step with Race Mode support.
   */
  async executeStep(stepName: string, ctx: SchedulerContext): Promise<StepOutcome> {
    const sStart = Date.now();
    const reviewStepName = ctx.reviewStepName ?? "review";

    // 1. Initial Routing
    let stepConfig = getProviderForStep(stepName, this.config);
    let routedFrom: string | undefined;

    if (stepConfig && this.config.routing?.length && !Array.isArray(stepConfig.provider)) {
      const originalName = stepConfig.providerName;
      const best = routeProvider(ctx.prompt, this.config.routing, originalName);
      if (best !== originalName) {
        const pc = this.config.providers[best];
        if (pc) {
          routedFrom = originalName;
          stepConfig = { providerName: best, provider: createProvider(best, pc) };
        }
      }
    }

    if (!stepConfig) throw new Error(`No provider found for step: ${stepName}`);

    // 2. Model Upgrade Strategy
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
        const all = Object.keys(this.config.providers);
        const better = findUpgradedProvider(finalName, all);
        if (better !== finalName) {
          logger.info("scheduler", `Upgrading for ${stepName}: ${finalName} -> ${better}`);
          const pc = this.config.providers[better];
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

    // 3. Prompt construction (review vs generate — step-strategy.ts)
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

    const baseReq: LLMRequest = {
      prompt: renderPrompt(structuredPrompt),
      system: structuredPrompt.system,
      staticContext: structuredPrompt.staticContext,
      dynamicContext: structuredPrompt.dynamicContext,
      language: ctx.language,
      context: getCandidateContent(ctx.candidate) || ctx.context,
      workDir: ctx.workDir,
      sessionId: ctx.sessionId,
      stepName,
      round: ctx.round,
      signal: ctx.signal
    };

    const isAgentRace = providers.length > 1 && providers.some((provider) => isAgentMode(provider.mode));

    // 4. Execution (Parallel Race if multiple providers)
    const responses = await Promise.all(providers.map(async (provider) => {
      const req: LLMRequest = isAgentRace && isAgentMode(provider.mode)
        ? {
            ...baseReq,
            finalizeStrategy: "defer",
            sharedLockKey: ctx.sessionId,
          }
        : baseReq;
      const resp = await provider.execute(req);
      // Approval semantics: parseVerdict only (see verdict.ts).
      const verdict = parseVerdict(isTextResponse(resp) ? (resp.content || "") : (resp.summary || ""));
      return { provider, resp, verdict };
    }));

    // Logic: Pick the winner
    // Rules: AST check passes > Non-failed > Lowest cost
    const winners = responses.filter((r) => !r.resp.failed);
    const bestWinner = winners.sort((a, b) => {
      // Priority 1: AST Check (Wave 6)
      const aSyntax = isTextResponse(a.resp) && a.resp.code ? isSyntaxValid(a.resp.code) : true;
      const bSyntax = isTextResponse(b.resp) && b.resp.code ? isSyntaxValid(b.resp.code) : true;
      if (aSyntax && !bSyntax) return -1;
      if (!aSyntax && bSyntax) return 1;
      return 0;
    })[0] || responses[0];

    const response = bestWinner.resp;
    const verdictParsed = bestWinner.verdict;
    const finalProviderName = providers.length > 1 ? bestWinner.provider.name : providerNames[0];
    const awaitingJudge = isAgentRace && responses.some(({ resp }) => isAgentResponse(resp) && !!resp.workspace);

    // 5. Finalize Outcome
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
          isAgent: true
        };
      }
    }

    const trace: StepTrace = {
      name: stepName,
      provider: finalProviderName,
      routedFrom,
      durationMs,
      round: ctx.round,
      usage: response.usage,
      error: response.error,
      filesModified: isAgentResponse(response) ? response.filesModified : undefined,
      isAgent: isAgentResponse(response),
      verdict: verdictParsed.format === "structured" ? (verdictParsed.approved ? "approved" : "needs_revision") : undefined,
      upgraded
    };

    if (isAgentRace) {
      trace.raceParticipants = providerNames;
      const applyTargetPath = responses
        .map(({ resp }) => (isAgentResponse(resp) ? resp.workspace?.workspaceRepoRoot : undefined))
        .find((value): value is string => typeof value === "string" && value.length > 0)
        ?? ctx.workDir
        ?? process.cwd();

      raceSessions.set(ctx.sessionId, {
        traceId: ctx.sessionId,
        applyTargetPath,
        candidates: responses.map(({ provider, resp }) => ({
          providerName: provider.name,
          workspacePath: isAgentResponse(resp) ? resp.workspace?.workspacePath : undefined,
          workspaceRepoRoot: isAgentResponse(resp) ? resp.workspace?.workspaceRepoRoot : undefined,
          workspaceBaseRef: isAgentResponse(resp) ? resp.workspace?.workspaceBaseRef : undefined,
          workspaceSharedLockKey: isAgentResponse(resp) ? resp.workspace?.workspaceSharedLockKey : undefined,
          patchText: isAgentResponse(resp) ? resp.changes : undefined,
          filesModified: isAgentResponse(resp) ? resp.filesModified : undefined,
          diffStat: isAgentResponse(resp) ? resp.diffStat : undefined,
        })),
        createdAt: Date.now(),
      });
    }

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
      awaitingJudge,
      nextSteps: filterValidNextSteps(response.nextSteps)
    };
  }
}
