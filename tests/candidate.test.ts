import assert from "node:assert/strict";
import test from "node:test";
import { emptyCandidate, getCandidateContent, getCandidateContentLabel } from "../src/core/candidate.ts";

test("emptyCandidate returns empty object", () => {
  const c = emptyCandidate();
  assert.deepEqual(c, {});
  assert.equal(getCandidateContent(c), "");
});

test("getCandidateContent returns code for text mode", () => {
  const c = { code: "console.log('hi')", isAgent: false };
  assert.equal(getCandidateContent(c), "console.log('hi')");
});

test("getCandidateContent returns changes for agent mode", () => {
  const c = { changes: "diff --git a/foo.ts", isAgent: true };
  assert.equal(getCandidateContent(c), "diff --git a/foo.ts");
});

test("getCandidateContent prefers changes for agent, code for text", () => {
  const agent = { code: "old code", changes: "new changes", isAgent: true };
  assert.equal(getCandidateContent(agent), "new changes");

  const text = { code: "old code", changes: "new changes", isAgent: false };
  assert.equal(getCandidateContent(text), "old code");
});

test("getCandidateContent returns empty string for empty candidate", () => {
  assert.equal(getCandidateContent({}), "");
});

test("getCandidateContentLabel returns Code for text mode", () => {
  assert.equal(getCandidateContentLabel({ isAgent: false }), "Code");
  assert.equal(getCandidateContentLabel({}), "Code");
});

test("getCandidateContentLabel returns Changes for agent mode", () => {
  assert.equal(getCandidateContentLabel({ isAgent: true }), "Changes");
});
