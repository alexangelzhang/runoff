/**
 * Guardrails (Wave 7.7).
 *
 * Input/Output guardrails with tripwire mechanism.
 * Guardrails check content/format/risk; Policy checks capability/permission.
 */

import type { GovernanceConfig } from "../core/config.js";
import type { AgentTask, AgentResult } from "./agent.js";
import { isTextResponse } from "../providers/types.js";
import {
  collectResultText,
  collectTaskText,
  scanForForbiddenPaths,
  scanForPii,
  scanForPromptInjection,
  scanForSecrets,
} from "./guardrail-scan.js";

// --- Guardrail Result ---

export interface GuardrailResult {
  tripwire: boolean;
  reason?: string;
  /** Corrected content for soft guardrail mode. */
  corrected?: unknown;
}

// --- Tripwire Error ---

export class TripwireError extends Error {
  readonly guardrailName: string;
  readonly reason: string;

  constructor(guardrailName: string, reason: string) {
    super(`Tripwire triggered by ${guardrailName}: ${reason}`);
    this.name = "TripwireError";
    this.guardrailName = guardrailName;
    this.reason = reason;
  }
}

// --- Guardrail Interfaces ---

export interface InputGuardrail {
  name: string;
  check(input: AgentTask): Promise<GuardrailResult>;
}

export interface OutputGuardrail {
  name: string;
  check(output: AgentResult): Promise<GuardrailResult>;
}

// --- Runner ---

/** Run all input guardrails. Throws TripwireError on first tripwire. */
export async function runInputGuardrails(
  guardrails: InputGuardrail[],
  input: AgentTask
): Promise<GuardrailResult[]> {
  const results: GuardrailResult[] = [];
  for (const g of guardrails) {
    const result = await g.check(input);
    results.push(result);
    if (result.tripwire) {
      throw new TripwireError(g.name, result.reason ?? "Input guardrail triggered");
    }
  }
  return results;
}

/** Run all output guardrails. Throws TripwireError on first tripwire. */
export async function runOutputGuardrails(
  guardrails: OutputGuardrail[],
  output: AgentResult
): Promise<GuardrailResult[]> {
  const results: GuardrailResult[] = [];
  for (const g of guardrails) {
    const result = await g.check(output);
    results.push(result);
    if (result.tripwire) {
      throw new TripwireError(g.name, result.reason ?? "Output guardrail triggered");
    }
  }
  return results;
}

// --- Built-in Guardrails ---

/** Rejects tasks whose prompt exceeds a token budget. */
export class CostLimitGuardrail implements InputGuardrail {
  readonly name = "CostLimitGuardrail";
  private maxPromptChars: number;

  constructor(maxPromptChars: number) {
    this.maxPromptChars = maxPromptChars;
  }

  async check(input: AgentTask): Promise<GuardrailResult> {
    if (input.prompt.length > this.maxPromptChars) {
      return {
        tripwire: true,
        reason: `Prompt exceeds cost limit: ${input.prompt.length} chars > ${this.maxPromptChars} max`,
      };
    }
    return { tripwire: false };
  }
}

/** Detects excessive re-execution of the same step (dead-loop guard). */
export class LoopDetectionGuardrail implements InputGuardrail {
  readonly name = "LoopDetectionGuardrail";
  private counts = new Map<string, number>();

  constructor(private maxExecutionsPerStep: number) {
    if (maxExecutionsPerStep < 1) {
      throw new Error("maxExecutionsPerStep must be at least 1");
    }
  }

  async check(input: AgentTask): Promise<GuardrailResult> {
    const count = (this.counts.get(input.stepName) ?? 0) + 1;
    this.counts.set(input.stepName, count);
    if (count > this.maxExecutionsPerStep) {
      return {
        tripwire: true,
        reason: `Step "${input.stepName}" exceeded max executions (${this.maxExecutionsPerStep})`,
      };
    }
    return { tripwire: false };
  }
}

/** Validates output response is not a failure. */
export class SuccessGuardrail implements OutputGuardrail {
  readonly name = "SuccessGuardrail";

  async check(output: AgentResult): Promise<GuardrailResult> {
    if (output.response.failed) {
      return {
        tripwire: true,
        reason: `Agent ${output.agentId} returned a failed response: ${output.response.error ?? "unknown error"}`,
      };
    }
    return { tripwire: false };
  }
}

// --- Content / risk guardrails (Backlog B4) ---

export type ResolvedGuardrailOptions = {
  detectSecrets: boolean;
  detectPii: boolean;
  detectPromptInjection: boolean;
  detectForbiddenPaths: boolean;
  rejectEmptyOutput: boolean;
  maxOutputChars: number;
};

const DEFAULT_MAX_OUTPUT_CHARS = 2_000_000;

/** Resolve extended guardrail toggles (defaults on when governance is enabled). */
export function resolveGuardrailOptions(gov: GovernanceConfig): ResolvedGuardrailOptions {
  const on = gov.enabled === true;
  return {
    detectSecrets: gov.detectSecrets ?? on,
    detectPii: gov.detectPii ?? on,
    detectPromptInjection: gov.detectPromptInjection ?? on,
    detectForbiddenPaths: gov.detectForbiddenPaths ?? on,
    rejectEmptyOutput: gov.rejectEmptyOutput ?? on,
    maxOutputChars:
      typeof gov.maxOutputChars === "number" ? gov.maxOutputChars : DEFAULT_MAX_OUTPUT_CHARS,
  };
}

function tripwireFinding(
  guardrail: string,
  scope: "input" | "output",
  finding: { category: string; label: string },
): GuardrailResult {
  return {
    tripwire: true,
    reason: `${guardrail}: ${scope} contains ${finding.category} (${finding.label})`,
  };
}

/** Blocks API keys / tokens in prompts and model output. */
export class SecretLeakageGuardrail implements InputGuardrail {
  readonly name = "SecretLeakageGuardrail";

  async check(input: AgentTask): Promise<GuardrailResult> {
    const finding = scanForSecrets(collectTaskText(input));
    return finding ? tripwireFinding(this.name, "input", finding) : { tripwire: false };
  }

  async checkOutput(output: AgentResult): Promise<GuardrailResult> {
    const finding = scanForSecrets(collectResultText(output));
    return finding ? tripwireFinding(this.name, "output", finding) : { tripwire: false };
  }
}

/** SecretLeakageGuardrail output adapter. */
export class SecretLeakageOutputGuardrail implements OutputGuardrail {
  readonly name = "SecretLeakageGuardrail";
  private readonly inner = new SecretLeakageGuardrail();

  async check(output: AgentResult): Promise<GuardrailResult> {
    return this.inner.checkOutput(output);
  }
}

/** Blocks PII patterns in prompts and model output. */
export class PiiGuardrail implements InputGuardrail {
  readonly name = "PiiGuardrail";

  async check(input: AgentTask): Promise<GuardrailResult> {
    const finding = scanForPii(collectTaskText(input));
    return finding ? tripwireFinding(this.name, "input", finding) : { tripwire: false };
  }

  async checkOutput(output: AgentResult): Promise<GuardrailResult> {
    const finding = scanForPii(collectResultText(output));
    return finding ? tripwireFinding(this.name, "output", finding) : { tripwire: false };
  }
}

export class PiiOutputGuardrail implements OutputGuardrail {
  readonly name = "PiiGuardrail";
  private readonly inner = new PiiGuardrail();

  async check(output: AgentResult): Promise<GuardrailResult> {
    return this.inner.checkOutput(output);
  }
}

/** Blocks common prompt-injection phrases in user-controlled input. */
export class PromptInjectionGuardrail implements InputGuardrail {
  readonly name = "PromptInjectionGuardrail";

  async check(input: AgentTask): Promise<GuardrailResult> {
    const finding = scanForPromptInjection(collectTaskText(input));
    return finding ? tripwireFinding(this.name, "input", finding) : { tripwire: false };
  }
}

/** Blocks path traversal and sensitive file references in task text. */
export class ForbiddenPathGuardrail implements InputGuardrail {
  readonly name = "ForbiddenPathGuardrail";

  async check(input: AgentTask): Promise<GuardrailResult> {
    const finding = scanForForbiddenPaths(collectTaskText(input));
    return finding ? tripwireFinding(this.name, "input", finding) : { tripwire: false };
  }
}

/** Rejects successful responses with no usable text content. */
export class EmptyOutputGuardrail implements OutputGuardrail {
  readonly name = "EmptyOutputGuardrail";

  async check(output: AgentResult): Promise<GuardrailResult> {
    if (output.response.failed) return { tripwire: false };
    const text = collectResultText(output).trim();
    if (text.length === 0) {
      return {
        tripwire: true,
        reason: `EmptyOutputGuardrail: agent ${output.agentId} returned no text content`,
      };
    }
    return { tripwire: false };
  }
}

/** Caps total output size to prevent runaway generations. */
export class OutputSizeGuardrail implements OutputGuardrail {
  readonly name = "OutputSizeGuardrail";

  constructor(private readonly maxChars: number) {
    if (maxChars < 1) throw new Error("maxChars must be at least 1");
  }

  async check(output: AgentResult): Promise<GuardrailResult> {
    const len = collectResultText(output).length;
    if (len > this.maxChars) {
      return {
        tripwire: true,
        reason: `OutputSizeGuardrail: output ${len} chars exceeds max ${this.maxChars}`,
      };
    }
    return { tripwire: false };
  }
}

/** Rejects malformed text responses missing required fields. */
export class OutputFormatGuardrail implements OutputGuardrail {
  readonly name = "OutputFormatGuardrail";

  async check(output: AgentResult): Promise<GuardrailResult> {
    const { response } = output;
    if (!isTextResponse(response) || response.failed) return { tripwire: false };
    if (!response.model?.trim()) {
      return {
        tripwire: true,
        reason: "OutputFormatGuardrail: text response missing model identifier",
      };
    }
    return { tripwire: false };
  }
}

export type BuiltGuardrails = {
  input: InputGuardrail[];
  output: OutputGuardrail[];
};

/** Build input/output guardrail lists from governance config. */
export function buildGuardrailsFromConfig(gov: GovernanceConfig): BuiltGuardrails {
  const input: InputGuardrail[] = [];
  const output: OutputGuardrail[] = [];

  if (gov.maxPromptChars) {
    input.push(new CostLimitGuardrail(gov.maxPromptChars));
  }
  if (gov.maxStepExecutionsPerStep) {
    input.push(new LoopDetectionGuardrail(gov.maxStepExecutionsPerStep));
  }

  const opts = resolveGuardrailOptions(gov);
  if (opts.detectSecrets) {
    input.push(new SecretLeakageGuardrail());
    output.push(new SecretLeakageOutputGuardrail());
  }
  if (opts.detectPii) {
    input.push(new PiiGuardrail());
    output.push(new PiiOutputGuardrail());
  }
  if (opts.detectPromptInjection) {
    input.push(new PromptInjectionGuardrail());
  }
  if (opts.detectForbiddenPaths) {
    input.push(new ForbiddenPathGuardrail());
  }
  if (gov.tripwireOnFailedResponse !== false) {
    output.push(new SuccessGuardrail());
  }
  if (opts.rejectEmptyOutput) {
    output.push(new EmptyOutputGuardrail());
  }
  if (opts.maxOutputChars > 0) {
    output.push(new OutputSizeGuardrail(opts.maxOutputChars));
  }
  output.push(new OutputFormatGuardrail());

  return { input, output };
}
