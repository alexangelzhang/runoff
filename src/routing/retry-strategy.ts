/**
 * Phase 5.5 — retry / upgrade provider selection by failure reason.
 */

import type { ProviderConfig } from "../core/config.js";
import {
  findUpgradedProvider,
  getProviderTier,
  type ModelTier,
} from "./router.js";
import type { LLMResponse } from "../providers/types.js";
import { isTextResponse } from "../providers/types.js";
import { isSyntaxValid } from "../infra/ast_utils.js";
import { parseVerdict } from "../core/verdict.js";

export type FailureReason = "timeout" | "quality" | "provider_error" | "unknown";

export function classifyStepFailure(input: {
  failed?: boolean;
  error?: string;
  response?: LLMResponse;
  reviewStepName?: string;
  stepName?: string;
}): FailureReason {
  const err = (input.error ?? "").toLowerCase();
  if (/timeout|timed out|etimedout|deadline exceeded|aborterror/i.test(err)) {
    return "timeout";
  }

  if (input.response) {
    const text = isTextResponse(input.response)
      ? input.response.content || ""
      : input.response.summary || "";
    const verdict = parseVerdict(text);
    if (verdict.format === "structured" && !verdict.approved) {
      return "quality";
    }
    if (isTextResponse(input.response) && input.response.code && !isSyntaxValid(input.response.code)) {
      return "quality";
    }
  }

  if (input.failed && err.length > 0) {
    if (/rate limit|429|503|unavailable|overloaded/i.test(err)) {
      return "provider_error";
    }
    return "provider_error";
  }

  if (input.failed) return "unknown";
  return "unknown";
}

/** Classify orchestrator step errors (message-only). */
export function classifyOrchestratorFailure(error: Error): FailureReason {
  return classifyStepFailure({ failed: true, error: error.message });
}

/** Prefer a faster/cheaper provider after timeouts. */
export function findDowngradedProvider(
  currentProvider: string,
  availableProviders: string[],
  providers?: Record<string, ProviderConfig>,
): string {
  const currentTier = getProviderTier(currentProvider, providers);
  if (currentTier === "lite") return currentProvider;

  const lite = availableProviders.filter((p) => getProviderTier(p, providers) === "lite");
  if (lite.length === 0) return currentProvider;

  lite.sort((a, b) => {
    const la = providers?.[a]?.avgLatencyMs ?? Number.MAX_SAFE_INTEGER;
    const lb = providers?.[b]?.avgLatencyMs ?? Number.MAX_SAFE_INTEGER;
    if (la !== lb) return la - lb;
    const ca = providers?.[a]?.costPerToken ?? Number.MAX_SAFE_INTEGER;
    const cb = providers?.[b]?.costPerToken ?? Number.MAX_SAFE_INTEGER;
    return ca - cb;
  });
  return lite[0]!;
}

/** Same tier, different provider (for provider_error). */
export function findAlternateProvider(
  currentProvider: string,
  availableProviders: string[],
  providers?: Record<string, ProviderConfig>,
): string {
  const tier = getProviderTier(currentProvider, providers);
  const alternates = availableProviders.filter(
    (p) => p !== currentProvider && getProviderTier(p, providers) === tier,
  );
  return alternates[0] ?? currentProvider;
}

export function pickRetryProvider(
  currentProvider: string,
  availableProviders: string[],
  providers: Record<string, ProviderConfig> | undefined,
  reason: FailureReason,
): string {
  switch (reason) {
    case "timeout":
      return findDowngradedProvider(currentProvider, availableProviders, providers);
    case "quality":
      return findUpgradedProvider(currentProvider, availableProviders, providers);
    case "provider_error":
      return findAlternateProvider(currentProvider, availableProviders, providers);
    default:
      return findUpgradedProvider(currentProvider, availableProviders, providers);
  }
}

export function describeRetryStrategy(reason: FailureReason): string {
  const map: Record<FailureReason, string> = {
    timeout: "downgrade-to-lite",
    quality: "upgrade-to-full",
    provider_error: "alternate-same-tier",
    unknown: "upgrade-default",
  };
  return map[reason];
}

export function tierForReason(reason: FailureReason): ModelTier | "alternate" {
  if (reason === "timeout") return "lite";
  if (reason === "quality") return "full";
  if (reason === "provider_error") return "alternate";
  return "full";
}
