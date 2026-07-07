import assert from "node:assert/strict";
import test from "node:test";
import { emptyCandidate } from "../../src/core/candidate.ts";
import {
  buildContextCompositionReport,
  buildRequiredEvidenceGaps,
  buildStepContextContract,
  compactSearchHitList,
  composeBoundedStepContext,
  DEFAULT_BOUNDED_CONTEXT_CHARS,
  extractContextRefs,
  hasRequiredEvidence,
  looksLikeSearchHitList,
  resolveStepContextKind,
} from "../../src/orchestration/context-contract.ts";
import { createCodeArtifact } from "../../src/orchestration/artifacts.ts";
import type { StepResult } from "../../src/core/state.ts";

const baseInput = {
  stepName: "implement_fix",
  reviewStepName: "review",
  spec: "Fix the bug",
  round: 1,
  globalKnowledge: {},
  candidate: emptyCandidate(),
  outputKind: "agent" as const,
};

test("resolveStepContextKind maps step names to contract kinds", () => {
  assert.equal(resolveStepContextKind("analyze_scope", "review"), "analyze");
  assert.equal(resolveStepContextKind("triage", "review"), "analyze");
  assert.equal(resolveStepContextKind("diagnose_ci", "review"), "analyze");
  assert.equal(resolveStepContextKind("implement_fix", "review"), "implement");
  assert.equal(resolveStepContextKind("review", "review"), "review");
  assert.equal(resolveStepContextKind("verify_tests", "review"), "test");
  assert.equal(resolveStepContextKind("final_summary", "review"), "final_summary");
});

test("buildStepContextContract requires contextRefs for analyze steps", () => {
  const contract = buildStepContextContract({
    ...baseInput,
    stepName: "triage",
    outputKind: "text",
  });
  assert.equal(contract.kind, "analyze");
  assert.ok(contract.requiredEvidence.includes("contextRefs"));
  assert.ok(!contract.requiredEvidence.includes("artifacts"));
});

test("buildStepContextContract forbids unbounded repo context by default", () => {
  const contract = buildStepContextContract(baseInput);
  assert.equal(contract.kind, "implement");
  assert.ok(contract.forbidden.includes("unbounded_repo_context"));
  assert.deepEqual(contract.requiredEvidence, ["filesModified", "diffStat", "artifacts"]);
});

test("composeBoundedStepContext truncates oversized context", () => {
  const contract = buildStepContextContract(baseInput);
  const huge = "x".repeat(DEFAULT_BOUNDED_CONTEXT_CHARS + 500);
  const { effectiveContext, report } = composeBoundedStepContext(huge, contract);

  assert.ok(effectiveContext!.length <= DEFAULT_BOUNDED_CONTEXT_CHARS + 80);
  assert.equal(report.originalContextChars, huge.length);
  assert.ok(report.omittedForbidden.includes("unbounded_repo_context"));
  assert.ok(report.warnings.some((warning) => warning.includes("truncated")));
});

test("buildContextCompositionReport warns on missing expected inputs", () => {
  const contract = buildStepContextContract(baseInput);
  const report = buildContextCompositionReport(baseInput, contract);
  assert.ok(report.warnings.some((warning) => warning.includes("lastReviewFeedback")));
});

test("hasRequiredEvidence and buildRequiredEvidenceGaps detect missing diffStat", () => {
  const result: StepResult = {
    status: "success",
    kind: "agent",
    filesModified: ["src/a.ts"],
  };
  const artifacts = [createCodeArtifact("export {}", "ok")];
  const contract = buildStepContextContract(baseInput);

  assert.equal(hasRequiredEvidence("filesModified", result, artifacts), true);
  assert.equal(hasRequiredEvidence("diffStat", result, artifacts), false);

  const gaps = buildRequiredEvidenceGaps("implement_fix", result, contract, artifacts.length);
  assert.ok(gaps.some((gap) => gap.detail.includes("diffStat")));
});

test("extractContextRefs parses file and mfs URIs", () => {
  const text = "See mfs://repo/src/a.ts:10-20 and file:///tmp/ci.log for details.";
  const refs = extractContextRefs(text);
  assert.equal(refs.length, 2);
  assert.equal(refs[0]?.scheme, "mfs");
  assert.equal(refs[1]?.scheme, "file");
});

test("composeBoundedStepContext compacts inline search hit JSON", () => {
  const contract = buildStepContextContract({
    ...baseInput,
    stepName: "triage",
    outputKind: "text",
  });
  const hits = JSON.stringify([
    { uri: "mfs://repo/src/foo.ts", snippet: "x".repeat(500) },
    { uri: "mfs://repo/tests/foo.test.ts", snippet: "y".repeat(500) },
  ]);
  assert.equal(looksLikeSearchHitList(hits), true);
  const compacted = compactSearchHitList(hits);
  assert.ok(compacted);
  assert.equal(compacted!.refs.length, 2);

  const { effectiveContext, report } = composeBoundedStepContext(hits, contract);
  assert.ok(effectiveContext!.includes("search hit(s) omitted"));
  assert.equal(report.contextRefs?.length, 2);
  assert.ok(report.omittedForbidden.includes("inline_tool_json"));
});

test("hasRequiredEvidence contextRefs satisfied from contextComposition", () => {
  const result: StepResult = {
    status: "success",
    kind: "text",
    summary: "Triage complete",
    contextComposition: {
      schemaVersion: 1,
      suppliedInputs: ["context"],
      omittedForbidden: [],
      warnings: [],
      contextRefs: [{ ref: "mfs://repo/src/a.ts", scheme: "mfs" }],
    },
  };
  assert.equal(hasRequiredEvidence("contextRefs", result, []), true);
});
