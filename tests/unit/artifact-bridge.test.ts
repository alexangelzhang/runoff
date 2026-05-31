import assert from "node:assert/strict";
import test from "node:test";
import { artifactsFromStepResponse } from "../../src/orchestration/artifact-bridge.ts";
import { isCodeArtifact, isDiffArtifact } from "../../src/orchestration/artifacts.ts";
import type { AgentResponse, TextResponse } from "../../src/providers/types.ts";

test("artifactsFromStepResponse maps text response to CodeArtifact", () => {
  const response: TextResponse = {
    kind: "text",
    content: "c",
    code: "x=1",
    explanation: "e",
    model: "m",
  };
  const arts = artifactsFromStepResponse(response, { stepName: "gen", producedBy: "gen" });
  assert.equal(arts.length, 1);
  assert.ok(isCodeArtifact(arts[0]!));
  assert.equal(arts[0]!.producedBy, "gen");
});

test("artifactsFromStepResponse maps agent response to DiffArtifact", () => {
  const response: AgentResponse = {
    kind: "agent",
    summary: "done",
    changes: "+line",
    filesModified: ["a.ts"],
    diffStat: "1 file",
    model: "m",
  };
  const arts = artifactsFromStepResponse(response, { stepName: "patch" });
  assert.equal(arts.length, 1);
  assert.ok(isDiffArtifact(arts[0]!));
});
