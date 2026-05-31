/**
 * Tests for auto-repair system (OpenSpace auto-fix + autoresearch crash handling).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  diagnoseFailure,
  buildRepairAction,
  planRepairs,
  type DiagnosticReport,
  type RepairAttempt,
  type FailureType,
} from "../../src/orchestration/auto-repair.js";
import type { StepResult } from "../../src/core/state.js";

// --- Helpers ---

function makeFailedStep(error: string, extra: Partial<StepResult> = {}): StepResult {
  return { status: "failed", provider: "claude", round: 1, error, ...extra };
}

// ============================================================
// Failure Diagnosis
// ============================================================

describe("Failure Diagnosis", () => {
  const cases: Array<{ error: string; expectedType: FailureType; expectedStrategy: string }> = [
    { error: "Request timed out after 30s", expectedType: "timeout", expectedStrategy: "upgrade_provider" },
    { error: "ETIMEDOUT connecting to API", expectedType: "timeout", expectedStrategy: "upgrade_provider" },
    { error: "429 Too Many Requests", expectedType: "provider_error", expectedStrategy: "retry_as_is" },
    { error: "Rate limit exceeded", expectedType: "provider_error", expectedStrategy: "retry_as_is" },
    { error: "500 Internal Server Error", expectedType: "provider_error", expectedStrategy: "upgrade_provider" },
    { error: "Connection refused ECONNREFUSED", expectedType: "provider_error", expectedStrategy: "upgrade_provider" },
    { error: "SyntaxError: Unexpected token }", expectedType: "syntax_error", expectedStrategy: "adjust_prompt" },
    { error: "Parse error: unterminated string", expectedType: "syntax_error", expectedStrategy: "adjust_prompt" },
    { error: "Tripwire triggered by CostLimitGuardrail: cost limit exceeded", expectedType: "guardrail_trip", expectedStrategy: "skip_step" },
    { error: "Guardrail triggered: output validation failed", expectedType: "guardrail_trip", expectedStrategy: "adjust_prompt" },
    { error: "Empty response from provider", expectedType: "empty_response", expectedStrategy: "upgrade_provider" },
  ];

  for (const { error, expectedType, expectedStrategy } of cases) {
    it(`classifies "${error.slice(0, 40)}..." as ${expectedType}`, () => {
      const report = diagnoseFailure(makeFailedStep(error));
      assert.equal(report.failureType, expectedType);
      assert.equal(report.suggestedStrategy, expectedStrategy);
      assert.ok(report.confidence > 0);
      assert.ok(report.rootCause.length > 0);
    });
  }

  it("classifies empty response with no error", () => {
    const report = diagnoseFailure(makeFailedStep(""));
    assert.equal(report.failureType, "empty_response");
  });

  it("classifies unknown errors", () => {
    const report = diagnoseFailure(makeFailedStep("something completely unexpected", { code: "x" }));
    assert.equal(report.failureType, "unknown");
    assert.ok(report.confidence < 0.5);
  });
});

// ============================================================
// Repair Action Builder
// ============================================================

describe("Repair Action Builder", () => {
  it("builds upgrade_provider action", () => {
    const diagnosis: DiagnosticReport = {
      failureType: "timeout",
      rootCause: "timed out",
      suggestedStrategy: "upgrade_provider",
      confidence: 0.85,
    };
    const action = buildRepairAction(diagnosis, ["claude", "gpt4"], "claude");
    assert.equal(action.strategy, "upgrade_provider");
    assert.equal(action.newProvider, "gpt4");
  });

  it("falls back to adjust_prompt when no alternative provider", () => {
    const diagnosis: DiagnosticReport = {
      failureType: "timeout",
      rootCause: "timed out",
      suggestedStrategy: "upgrade_provider",
      confidence: 0.85,
    };
    const action = buildRepairAction(diagnosis, ["claude"], "claude");
    assert.equal(action.strategy, "adjust_prompt");
    assert.ok(action.promptPrefix!.includes("timed out"));
  });

  it("builds adjust_prompt action", () => {
    const diagnosis: DiagnosticReport = {
      failureType: "syntax_error",
      rootCause: "unexpected token",
      suggestedStrategy: "adjust_prompt",
      confidence: 0.85,
    };
    const action = buildRepairAction(diagnosis, ["claude"], "claude");
    assert.equal(action.strategy, "adjust_prompt");
    assert.ok(action.promptPrefix!.includes("unexpected token"));
  });

  it("builds retry_as_is action", () => {
    const diagnosis: DiagnosticReport = {
      failureType: "provider_error",
      rootCause: "rate limited",
      suggestedStrategy: "retry_as_is",
      confidence: 0.9,
    };
    const action = buildRepairAction(diagnosis, ["claude"], "claude");
    assert.equal(action.strategy, "retry_as_is");
  });

  it("builds skip_step action", () => {
    const diagnosis: DiagnosticReport = {
      failureType: "guardrail_trip",
      rootCause: "cost limit",
      suggestedStrategy: "skip_step",
      confidence: 0.9,
    };
    const action = buildRepairAction(diagnosis, ["claude"], "claude");
    assert.equal(action.strategy, "skip_step");
  });

  it("builds abort action", () => {
    const diagnosis: DiagnosticReport = {
      failureType: "unknown",
      rootCause: "no idea",
      suggestedStrategy: "abort",
      confidence: 0.3,
    };
    const action = buildRepairAction(diagnosis, ["claude"], "claude");
    assert.equal(action.strategy, "abort");
  });
});

// ============================================================
// Repair Planning
// ============================================================

describe("Repair Planning", () => {
  it("plans first repair attempt", () => {
    const step = makeFailedStep("500 Internal Server Error");
    const action = planRepairs(step, "claude", ["claude", "gpt4"]);
    assert.ok(action);
    assert.equal(action.strategy, "upgrade_provider");
    assert.equal(action.newProvider, "gpt4");
  });

  it("returns null when max attempts exhausted", () => {
    const step = makeFailedStep("timeout");
    const prev: RepairAttempt[] = [
      { attempt: 1, diagnosis: diagnoseFailure(step), action: { strategy: "upgrade_provider", explanation: "" }, applied: true },
      { attempt: 2, diagnosis: diagnoseFailure(step), action: { strategy: "adjust_prompt", explanation: "" }, applied: true },
    ];
    const action = planRepairs(step, "claude", ["claude", "gpt4"], { maxAttempts: 2 }, prev);
    assert.equal(action, null);
  });

  it("escalates when same strategy already tried", () => {
    const step = makeFailedStep("500 Internal Server Error");
    const prev: RepairAttempt[] = [
      { attempt: 1, diagnosis: diagnoseFailure(step), action: { strategy: "upgrade_provider", explanation: "" }, applied: true },
    ];
    const action = planRepairs(step, "claude", ["claude", "gpt4"], {}, prev);
    assert.ok(action);
    assert.notEqual(action.strategy, "upgrade_provider");
  });

  it("respects allowUpgrade=false", () => {
    const step = makeFailedStep("timeout");
    const action = planRepairs(step, "claude", ["claude", "gpt4"], { allowUpgrade: false });
    assert.ok(action);
    assert.notEqual(action.strategy, "upgrade_provider");
  });

  it("respects allowPromptAdjust=false", () => {
    const step = makeFailedStep("SyntaxError: unexpected token");
    const action = planRepairs(step, "claude", ["claude"], { allowPromptAdjust: false });
    // syntax_error suggests adjust_prompt, but it's disabled → escalates to abort
    assert.ok(action);
    assert.equal(action.strategy, "abort");
  });

  it("allows skip when configured", () => {
    const step = makeFailedStep("Tripwire triggered by CostLimitGuardrail: cost limit exceeded");
    const action = planRepairs(step, "claude", ["claude"], { allowSkip: true });
    assert.ok(action);
    assert.equal(action.strategy, "skip_step");
  });

  it("disallows skip by default", () => {
    const step = makeFailedStep("Tripwire triggered by CostLimitGuardrail: cost limit exceeded");
    const action = planRepairs(step, "claude", ["claude"], { allowSkip: false });
    // guardrail_trip + cost → skip_step, but skip disabled → abort
    assert.ok(action);
    assert.equal(action.strategy, "abort");
  });
});
