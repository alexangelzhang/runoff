import assert from "node:assert/strict";
import test from "node:test";
import type { StepResult } from "../../src/core/state.ts";
import { createCodeArtifact, createDiffArtifact } from "../../src/orchestration/artifacts.ts";
import {
  buildStepResumeMetadata,
  hashStepInput,
  resolveWorkspaceAttachment,
} from "../../src/orchestration/step-resume-metadata.ts";

test("hashStepInput is stable for equivalent object key order", () => {
  assert.equal(
    hashStepInput({ b: 2, a: ["x", "y"] }),
    hashStepInput({ a: ["x", "y"], b: 2 }),
  );
});

test("buildStepResumeMetadata marks complete successful step as skippable", () => {
  const result: StepResult = {
    status: "success",
    provider: "codex",
    kind: "agent",
    filesModified: ["src/retry.ts"],
    diffStat: "1 file changed",
    contextContract: {
      kind: "generate",
      inputs: ["spec"],
      forbidden: [],
      requiredEvidence: ["filesModified", "diffStat", "artifacts"],
    },
  };
  const artifact = createDiffArtifact(
    "diff --git a/src/retry.ts b/src/retry.ts",
    "changed retry",
    ["src/retry.ts"],
    "1 file changed",
  );
  const metadata = buildStepResumeMetadata({
    stepName: "implement",
    round: 1,
    inputHash: "hash-step",
    stepResult: result,
    artifacts: [artifact],
    workspaceAttachment: "session_workspace",
  });

  assert.equal(metadata.artifactCompleteness, "complete");
  assert.equal(metadata.canSkipOnResume, true);
  assert.equal(metadata.mustRerunReason, undefined);
  assert.equal(metadata.providerResultPresent, true);
  assert.equal(metadata.workspaceAttachment, "session_workspace");
});

test("buildStepResumeMetadata treats text code artifacts as complete output evidence", () => {
  const result: StepResult = {
    status: "success",
    provider: "mock",
    kind: "text",
    code: "export const ok = true;",
    explanation: "Generated code.",
    contextContract: {
      kind: "generate",
      inputs: ["spec"],
      forbidden: [],
      requiredEvidence: ["code", "artifacts"],
    },
  };

  const metadata = buildStepResumeMetadata({
    stepName: "generate",
    round: 1,
    inputHash: "hash-text-step",
    stepResult: result,
    artifacts: [
      createCodeArtifact("export const ok = true;", "Generated code."),
    ],
    workspaceAttachment: "none",
  });

  assert.equal(metadata.artifactCompleteness, "complete");
  assert.equal(metadata.canSkipOnResume, true);
  assert.equal(metadata.mustRerunReason, undefined);
});

test("buildStepResumeMetadata marks missing evidence as partial and must-rerun", () => {
  const result: StepResult = {
    status: "success",
    provider: "codex",
    kind: "agent",
    filesModified: ["src/retry.ts"],
    contextContract: {
      kind: "generate",
      inputs: ["spec"],
      forbidden: [],
      requiredEvidence: ["filesModified", "diffStat"],
    },
  };

  const metadata = buildStepResumeMetadata({
    stepName: "implement",
    round: 1,
    inputHash: "hash-step",
    stepResult: result,
    artifacts: [
      createDiffArtifact(
        "diff --git a/src/retry.ts b/src/retry.ts",
        "changed retry",
        ["src/retry.ts"],
        "",
      ),
    ],
    workspaceAttachment: "source_workdir",
  });

  assert.equal(metadata.artifactCompleteness, "partial");
  assert.equal(metadata.canSkipOnResume, false);
  assert.match(metadata.mustRerunReason ?? "", /partial/);
});

test("resolveWorkspaceAttachment distinguishes source, session, and race workspaces", () => {
  assert.equal(resolveWorkspaceAttachment({}), "none");
  assert.equal(resolveWorkspaceAttachment({ effectiveWorkDir: "/repo", sourceWorkDir: "/repo" }), "source_workdir");
  assert.equal(resolveWorkspaceAttachment({ effectiveWorkDir: "/worktree", sourceWorkDir: "/repo" }), "session_workspace");
  assert.equal(resolveWorkspaceAttachment({ effectiveWorkDir: "/race", sourceWorkDir: "/repo", raceCandidateWorkspace: true }), "race_candidate_workspace");
});
