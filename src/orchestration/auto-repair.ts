/**
 * Auto-Repair System (OpenSpace auto-fix + autoresearch crash handling).
 *
 * Diagnose → Repair → Retry loop for pipeline step failures.
 * Instead of stopping on failure, the system:
 * 1. Diagnoses the failure type and root cause
 * 2. Selects a repair strategy (upgrade provider, adjust prompt, skip, etc.)
 * 3. Retries the step with the repair applied
 *
 * Integrates with:
 * - state.ts StepResult (failure input)
 * - guardrails.ts TripwireError (guardrail failures)
 * - router.ts findUpgradedProvider (provider upgrade strategy)
 */

import type { StepResult } from "../core/state.js";

// --- Failure Classification ---

export type FailureType =
  | "timeout"          // Step exceeded time limit
  | "provider_error"   // Provider returned error (API failure, rate limit)
  | "syntax_error"     // Generated code has syntax issues
  | "guardrail_trip"   // Guardrail tripwire triggered
  | "empty_response"   // Provider returned empty/null content
  | "validation_error" // Output failed validation
  | "unknown";         // Unclassifiable

export interface DiagnosticReport {
  /** Classified failure type. */
  failureType: FailureType;
  /** Human-readable root cause description. */
  rootCause: string;
  /** Suggested repair strategy. */
  suggestedStrategy: RepairStrategy;
  /** Confidence in the diagnosis (0-1). */
  confidence: number;
  /** Raw error string from the step result. */
  rawError?: string;
}

// --- Repair Strategy ---

export type RepairStrategy =
  | "upgrade_provider"  // Switch to a more capable provider
  | "adjust_prompt"     // Add error context to prompt for retry
  | "retry_as_is"       // Simple retry (transient errors)
  | "skip_step"         // Skip this step and continue pipeline
  | "abort";            // Unrecoverable — stop pipeline

export interface RepairAction {
  strategy: RepairStrategy;
  /** For upgrade_provider: the new provider name. */
  newProvider?: string;
  /** For adjust_prompt: additional context to prepend. */
  promptPrefix?: string;
  /** Human-readable explanation of what the repair does. */
  explanation: string;
}

// --- Diagnosis ---

const TIMEOUT_PATTERNS = [
  /timeout/i, /timed?\s*out/i, /deadline\s*exceeded/i, /ETIMEDOUT/i,
];

const RATE_LIMIT_PATTERNS = [
  /rate\s*limit/i, /429/i, /too\s*many\s*requests/i, /quota/i, /throttl/i,
];

const PROVIDER_ERROR_PATTERNS = [
  /api\s*error/i, /500/i, /502/i, /503/i, /service\s*unavailable/i,
  /internal\s*server/i, /connection\s*(refused|reset)/i, /ECONNREFUSED/i,
];

const SYNTAX_PATTERNS = [
  /syntax\s*error/i, /parse\s*error/i, /unexpected\s*token/i,
  /unterminated/i, /invalid\s*syntax/i,
];

const EMPTY_PATTERNS = [
  /empty\s*response/i, /no\s*content/i, /null\s*response/i,
  /missing\s*output/i,
];

const GUARDRAIL_PATTERNS = [
  /tripwire/i, /guardrail/i, /cost\s*limit/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Diagnose a step failure and suggest a repair strategy.
 */
export function diagnoseFailure(stepResult: StepResult): DiagnosticReport {
  const error = stepResult.error ?? stepResult.reason ?? "";

  // Guardrail trip
  if (matchesAny(error, GUARDRAIL_PATTERNS)) {
    return {
      failureType: "guardrail_trip",
      rootCause: `Guardrail triggered: ${error}`,
      suggestedStrategy: error.toLowerCase().includes("cost")
        ? "skip_step"
        : "adjust_prompt",
      confidence: 0.9,
      rawError: error,
    };
  }

  // Timeout
  if (matchesAny(error, TIMEOUT_PATTERNS)) {
    return {
      failureType: "timeout",
      rootCause: `Step timed out: ${error}`,
      suggestedStrategy: "upgrade_provider",
      confidence: 0.85,
      rawError: error,
    };
  }

  // Rate limit (subset of provider errors, but different strategy)
  if (matchesAny(error, RATE_LIMIT_PATTERNS)) {
    return {
      failureType: "provider_error",
      rootCause: `Rate limited: ${error}`,
      suggestedStrategy: "retry_as_is",
      confidence: 0.9,
      rawError: error,
    };
  }

  // Provider error
  if (matchesAny(error, PROVIDER_ERROR_PATTERNS)) {
    return {
      failureType: "provider_error",
      rootCause: `Provider error: ${error}`,
      suggestedStrategy: "upgrade_provider",
      confidence: 0.8,
      rawError: error,
    };
  }

  // Syntax error
  if (matchesAny(error, SYNTAX_PATTERNS)) {
    return {
      failureType: "syntax_error",
      rootCause: `Code syntax error: ${error}`,
      suggestedStrategy: "adjust_prompt",
      confidence: 0.85,
      rawError: error,
    };
  }

  // Empty response
  if (matchesAny(error, EMPTY_PATTERNS) || (!stepResult.code && !stepResult.changes && !stepResult.summary)) {
    return {
      failureType: "empty_response",
      rootCause: error ? `Empty response: ${error}` : "Provider returned no usable content",
      suggestedStrategy: "upgrade_provider",
      confidence: 0.7,
      rawError: error || undefined,
    };
  }

  // Unknown
  return {
    failureType: "unknown",
    rootCause: error || "Unknown failure with no error message",
    suggestedStrategy: error ? "adjust_prompt" : "abort",
    confidence: 0.3,
    rawError: error || undefined,
  };
}

// --- Repair Action Builder ---

/**
 * Build a concrete repair action from a diagnostic report.
 */
export function buildRepairAction(
  diagnosis: DiagnosticReport,
  availableProviders: string[],
  currentProvider: string,
): RepairAction {
  switch (diagnosis.suggestedStrategy) {
    case "upgrade_provider": {
      const others = availableProviders.filter((p) => p !== currentProvider);
      if (others.length > 0) {
        return {
          strategy: "upgrade_provider",
          newProvider: others[0],
          explanation: `Switching from ${currentProvider} to ${others[0]} due to: ${diagnosis.rootCause}`,
        };
      }
      // No alternative provider — fall back to adjust_prompt
      return {
        strategy: "adjust_prompt",
        promptPrefix: `[Previous attempt failed: ${diagnosis.rootCause}. Please try a different approach.]`,
        explanation: `No alternative provider available. Adding error context to prompt.`,
      };
    }

    case "adjust_prompt":
      return {
        strategy: "adjust_prompt",
        promptPrefix: `[Previous attempt failed: ${diagnosis.rootCause}. Please fix the issue and try again.]`,
        explanation: `Adding failure context to prompt for retry.`,
      };

    case "retry_as_is":
      return {
        strategy: "retry_as_is",
        explanation: `Transient error detected (${diagnosis.failureType}). Retrying without changes.`,
      };

    case "skip_step":
      return {
        strategy: "skip_step",
        explanation: `Skipping step due to: ${diagnosis.rootCause}`,
      };

    case "abort":
    default:
      return {
        strategy: "abort",
        explanation: `Unrecoverable failure: ${diagnosis.rootCause}`,
      };
  }
}

// --- Auto-Repair Loop ---

export interface RepairConfig {
  /** Maximum repair attempts per step. Default 2. */
  maxAttempts?: number;
  /** Whether to allow provider upgrades. Default true. */
  allowUpgrade?: boolean;
  /** Whether to allow prompt adjustment. Default true. */
  allowPromptAdjust?: boolean;
  /** Whether to allow skipping steps. Default false. */
  allowSkip?: boolean;
}

const DEFAULT_REPAIR_CONFIG: Required<RepairConfig> = {
  maxAttempts: 2,
  allowUpgrade: true,
  allowPromptAdjust: true,
  allowSkip: false,
};

export interface RepairAttempt {
  attempt: number;
  diagnosis: DiagnosticReport;
  action: RepairAction;
  /** Whether the repair was applied (false if strategy not allowed). */
  applied: boolean;
}

/**
 * Auto-repair loop: diagnose failure, select strategy, build action.
 * Returns the sequence of repair attempts to try.
 *
 * The caller (pipeline-runner) is responsible for actually executing
 * the retries — this function only plans the repair sequence.
 */
export function planRepairs(
  failedResult: StepResult,
  currentProvider: string,
  availableProviders: string[],
  config: RepairConfig = {},
  previousAttempts: RepairAttempt[] = [],
): RepairAction | null {
  const c = { ...DEFAULT_REPAIR_CONFIG, ...config };

  if (previousAttempts.length >= c.maxAttempts) {
    return null; // Exhausted repair budget
  }

  const diagnosis = diagnoseFailure(failedResult);

  // Check if strategy is allowed
  if (diagnosis.suggestedStrategy === "upgrade_provider" && !c.allowUpgrade) {
    diagnosis.suggestedStrategy = "adjust_prompt";
  }
  if (diagnosis.suggestedStrategy === "adjust_prompt" && !c.allowPromptAdjust) {
    diagnosis.suggestedStrategy = "abort";
  }
  if (diagnosis.suggestedStrategy === "skip_step" && !c.allowSkip) {
    diagnosis.suggestedStrategy = "abort";
  }

  // Don't repeat the same strategy that already failed
  const usedStrategies = new Set(previousAttempts.map((a) => a.action.strategy));
  if (usedStrategies.has(diagnosis.suggestedStrategy)) {
    // Escalate: try next strategy in priority order
    const escalation: RepairStrategy[] = ["retry_as_is", "adjust_prompt", "upgrade_provider", "skip_step", "abort"];
    const next = escalation.find((s) => !usedStrategies.has(s) && isAllowed(s, c));
    if (!next || next === "abort") return null;
    diagnosis.suggestedStrategy = next;
  }

  return buildRepairAction(diagnosis, availableProviders, currentProvider);
}

function isAllowed(strategy: RepairStrategy, config: Required<RepairConfig>): boolean {
  switch (strategy) {
    case "upgrade_provider": return config.allowUpgrade;
    case "adjust_prompt": return config.allowPromptAdjust;
    case "skip_step": return config.allowSkip;
    case "retry_as_is": return true;
    case "abort": return true;
  }
}
