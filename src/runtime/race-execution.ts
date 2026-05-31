/**
 * Phase 5.4 — parallel provider race with budget cap and early winner termination.
 */

import { isSyntaxValid } from "../infra/ast_utils.js";
import { CostTracker, recordPipelineStepCost, type PipelineCostAccumulator } from "../routing/pricing.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../providers/types.js";
import { isTextResponse } from "../providers/types.js";
import { parseVerdict } from "../core/verdict.js";

type ParsedVerdict = ReturnType<typeof parseVerdict>;

export type RaceParticipantOutcome = {
  provider: LLMProvider;
  resp: LLMResponse;
  verdict: ParsedVerdict;
  abortedEarly?: boolean;
};

export type ExecuteProviderRaceOptions = {
  providers: LLMProvider[];
  buildRequest: (provider: LLMProvider) => LLMRequest;
  parentSignal?: AbortSignal;
  /** Per-race USD ceiling (checked against a local accumulator). */
  raceBudgetUSD?: number;
  /** Also enforce pipeline-wide accumulator when provided. */
  costTracker?: PipelineCostAccumulator;
  earlyTermination?: boolean;
  stepName: string;
};

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((s): s is AbortSignal => !!s);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

function isViableRaceWinner(resp: LLMResponse): boolean {
  if (resp.failed) return false;
  if (isTextResponse(resp) && resp.code && !isSyntaxValid(resp.code)) return false;
  return true;
}

function recordParticipantCost(
  localTracker: CostTracker,
  pipelineTracker: PipelineCostAccumulator | undefined,
  stepName: string,
  provider: LLMProvider,
  resp: LLMResponse,
): void {
  const usage = resp.usage ?? { promptTokens: 0, completionTokens: 0 };
  localTracker.addCall(`${stepName}:race`, provider.name, resp.model, usage);
  if (pipelineTracker) {
    recordPipelineStepCost(pipelineTracker, `${stepName}:race`, provider.name, resp.model, usage);
  }
}

export function resolveRaceBudgetUSD(
  raceBudgetUSD?: number,
  pipelineBudgetUSD?: number,
): number | undefined {
  if (typeof raceBudgetUSD === "number" && raceBudgetUSD > 0) return raceBudgetUSD;
  if (typeof pipelineBudgetUSD === "number" && pipelineBudgetUSD > 0) return pipelineBudgetUSD;
  return undefined;
}

/**
 * Run providers in parallel; abort siblings after first viable winner or when race budget is exceeded.
 */
export async function executeProviderRace(
  options: ExecuteProviderRaceOptions,
): Promise<RaceParticipantOutcome[]> {
  const {
    providers,
    buildRequest,
    parentSignal,
    raceBudgetUSD,
    costTracker,
    earlyTermination = true,
    stepName,
  } = options;

  const raceAbort = new AbortController();
  const linked = combineAbortSignals(parentSignal, raceAbort.signal);
  const localCost = new CostTracker();
  let earlyWinnerSeen = false;

  const tasks = providers.map(async (provider): Promise<RaceParticipantOutcome> => {
    if (linked?.aborted) {
      const aborted: LLMResponse = {
        kind: "text",
        model: provider.name,
        content: "",
        code: "",
        explanation: "",
        failed: true,
        error: "Race aborted (budget or early winner)",
      };
      return {
        provider,
        resp: aborted,
        verdict: parseVerdict(""),
        abortedEarly: true,
      };
    }

    const baseReq = buildRequest(provider);
    const req: LLMRequest = {
      ...baseReq,
      signal: combineAbortSignals(baseReq.signal, linked),
    };

    let resp: LLMResponse;
    try {
      resp = await provider.execute(req);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      resp = {
        kind: "text",
        model: provider.name,
        content: "",
        code: "",
        explanation: "",
        failed: true,
        error: message,
      };
    }

    recordParticipantCost(localCost, costTracker, stepName, provider, resp);

    if (typeof raceBudgetUSD === "number" && localCost.getTotalCost() >= raceBudgetUSD) {
      raceAbort.abort();
    }

    const verdict = parseVerdict(isTextResponse(resp) ? resp.content || "" : resp.summary || "");
    if (earlyTermination && !earlyWinnerSeen && isViableRaceWinner(resp)) {
      earlyWinnerSeen = true;
      raceAbort.abort();
    }

    return {
      provider,
      resp,
      verdict,
      abortedEarly: raceAbort.signal.aborted && earlyWinnerSeen,
    };
  });

  return Promise.all(tasks);
}
