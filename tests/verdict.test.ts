import assert from "node:assert/strict";
import test from "node:test";
import { parseVerdict } from "../src/verdict.ts";

// --- Structured sentinel ---

test("parseVerdict: VERDICT: APPROVED", () => {
  const result = parseVerdict("Code looks good.\nVERDICT: APPROVED");
  assert.equal(result.approved, true);
  assert.equal(result.feedback, "");
});

test("parseVerdict: VERDICT: NEEDS_REVISION with reason", () => {
  const result = parseVerdict("Issues found.\nVERDICT: NEEDS_REVISION: missing error handling");
  assert.equal(result.approved, false);
  assert.equal(result.feedback, "missing error handling");
});

test("parseVerdict: VERDICT: NEEDS_REVISION without reason uses full text", () => {
  const raw = "Issues found.\nVERDICT: NEEDS_REVISION";
  const result = parseVerdict(raw);
  assert.equal(result.approved, false);
  assert.equal(result.feedback, raw);
});

test("parseVerdict: case insensitive sentinel", () => {
  const result = parseVerdict("verdict: approved");
  assert.equal(result.approved, true);
});

// --- Legacy fallback ---

test("parseVerdict: legacy APPROVED on its own line", () => {
  const result = parseVerdict("Looks fine.\nAPPROVED\n");
  assert.equal(result.approved, true);
});

test("parseVerdict: legacy APPROVED with surrounding whitespace", () => {
  const result = parseVerdict("Review done.\n  APPROVED  \nEnd.");
  assert.equal(result.approved, true);
});

test("parseVerdict: embedded APPROVED in sentence does NOT approve", () => {
  const raw = "The code is NOT APPROVED for production use.";
  const result = parseVerdict(raw);
  assert.equal(result.approved, false);
  assert.equal(result.feedback, raw);
});

test("parseVerdict: APPROVED with NEEDS_REVISION present does NOT approve", () => {
  const raw = "APPROVED\nBut actually NEEDS_REVISION: fix the bug";
  const result = parseVerdict(raw);
  // Structured sentinel takes precedence — VERDICT: pattern matches NEEDS_REVISION
  // Actually no VERDICT: prefix here, so legacy path: APPROVED line exists but NEEDS_REVISION also present
  assert.equal(result.approved, false);
});

// --- No verdict ---

test("parseVerdict: no verdict returns not approved with full text as feedback", () => {
  const raw = "The code has some issues but I'm not sure.";
  const result = parseVerdict(raw);
  assert.equal(result.approved, false);
  assert.equal(result.feedback, raw);
});

test("parseVerdict: empty string returns not approved", () => {
  const result = parseVerdict("");
  assert.equal(result.approved, false);
  assert.equal(result.feedback, "");
});
