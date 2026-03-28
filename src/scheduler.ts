import { 
  getProviderForStep, 
  createProvider, 
  PipelineConfig
} from "./config.js";
import { 
  routeProvider,
  findUpgradedProvider
} from "./router.js";
import { 
  buildReviewPrompt, 
  renderPrompt 
} from "./prompt.js";
import { 
  LLMProvider,
  LLMRequest,
  LLMResponse,
  isTextResponse, 
  isAgentResponse 
} from "./providers/types.js";
import { 
  Candidate,
  getCandidateContent,
  getCandidateContentLabel
} from "./candidate.js";
import { 
  parseVerdict 
} from "./verdict.js";
import { 
  StepTrace,
  recordTrace
} from "./trace.js";
import { 
  isSyntaxValid 
} from "./ast_utils.js";
import { CostTracker } from "./pricing.js";

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
  nextSteps?: any[];
}

export class ExecutionScheduler {
  private config: PipelineConfig;
  private costTracker = new CostTracker();

  constructor(config: PipelineConfig) {
    this.config = config;
  }

  /**
   * Wave 2: Execute a single DAG step with Race Mode support.
   */
  async executeStep(stepName: string, ctx: SchedulerContext): Promise<StepOutcome> {
    const sStart = Date.now();
    
    // 1. Initial Routing
    let stepConfig = getProviderForStep(stepName, this.config);
    let routedFrom: string | undefined;

    if (stepConfig && this.config.routing?.length && !Array.isArray(stepConfig.provider)) {
      const best = routeProvider(ctx.prompt, this.config.routing, stepConfig.providerName);
      if (best !== stepConfig.providerName) {
        const pc = this.config.providers[best];
        if (pc) {
          stepConfig = { providerName: best, provider: createProvider(best, pc) };
          routedFrom = stepConfig.providerName;
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
      let finalP = stepConfig.provider;
      let finalName = stepConfig.providerName;
      if (ctx.round > 1) {
        const all = Object.keys(this.config.providers);
        const better = findUpgradedProvider(finalName, all);
        if (better !== finalName) {
          console.log(`[Scheduler] Upgrading for ${stepName}: ${finalName} -> ${better}`);
          const pc = this.config.providers[better];
          if (pc) {
            finalP = createProvider(better, pc);
            finalName = better;
            upgraded = true;
          }
        }
      }
      providers = [finalP];
      providerNames = [finalName];
    }

    // 3. Prompt Construction
    const structuredPrompt = buildReviewPrompt({
      spec: ctx.prompt,
      acceptanceCriteria: ctx.acceptanceCriteria,
      verifyResults: ctx.verifyResults,
      candidateContent: getCandidateContent(ctx.candidate),
      candidateLabel: getCandidateContentLabel(ctx.candidate),
      knowledge: ctx.globalKnowledge
    });

    const req: LLMRequest = {
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

    // 4. Execution (Parallel Race if multiple providers)
    const startTime = Date.now();
    const responses = await Promise.all(providers.map(async (p) => {
      const resp = await p.execute(req);
      const verdict = parseVerdict(isTextResponse(resp) ? (resp.content || "") : (resp.summary || ""));
      return { p, resp, verdict };
    }));

    // Logic: Pick the winner
    // Rules: AST check passes > Non-failed > Lowest cost
    const winners = responses.filter(r => !r.resp.failed);
    const bestWinner = winners.sort((a, b) => {
      // Priority 1: AST Check (Wave 6)
      const aSyntax = isTextResponse(a.resp) && a.resp.code ? isSyntaxValid(a.resp.code) : true;
      const bSyntax = isTextResponse(b.resp) && b.resp.code ? isSyntaxValid(b.resp.code) : true;
      if (aSyntax && !bSyntax) return -1;
      if (!aSyntax && bSyntax) return 1;

      // Priority 2: Cost (Placeholder for basic sorting)
      return 0;
    })[0] || responses[0];

    const response = bestWinner.resp;
    const verdictParsed = bestWinner.verdict;
    const finalProviderName = providers.length > 1 ? bestWinner.p.name : providerNames[0];

    // 5. Finalize Outcome
    const durationMs = Date.now() - sStart;
    let candidateSnapshot: Candidate | undefined;
    if (!response.failed) {
      if (isTextResponse(response)) {
        candidateSnapshot = { code: response.code, isAgent: false };
      } else if (isAgentResponse(response)) {
        candidateSnapshot = { 
          changes: response.changes, summary: response.summary, 
          filesModified: response.filesModified, diffStat: response.diffStat, isAgent: true 
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
      isAgent: isAgentResponse(response),
      verdict: verdictParsed.format === "structured" ? (verdictParsed.approved ? "approved" : "needs_revision") : undefined,
      upgraded
    } as any;

    if (providers.length > 1) {
       (trace as any).raceParticipants = providerNames;
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
      nextSteps: (response as any).nextSteps
    };
  }
}
