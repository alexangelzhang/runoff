import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAgentMemory } from "../../src/orchestration/memory.ts";
import { PatternCache, extractPattern } from "../../src/orchestration/pattern-cache.ts";
import {
  filesIntersectionCount,
  getLinkedPatterns,
  linkPatternByFiles,
} from "../../src/orchestration/pattern-links.ts";
import { agentId } from "../../src/orchestration/multi-agent-types.ts";
import type { PipelineTrace } from "../../src/observability/trace.ts";

test("filesIntersectionCount detects overlap", () => {
  assert.equal(filesIntersectionCount(["a.ts", "b.ts"], ["b.ts", "c.ts"]), 1);
  assert.equal(filesIntersectionCount(["a.ts"], ["z.ts"]), 0);
});

test("linkPatternByFiles links patterns sharing filesModified", () => {
  const mem = new InMemoryAgentMemory();
  const scope = { project: "links" };

  const traceA: PipelineTrace = {
    id: "ta",
    prompt: "task A",
    promptLength: 6,
    mode: "pipeline",
    hasVerifyResults: false,
    steps: [
      { name: "gen", provider: "mock", durationMs: 1, round: 1, filesModified: ["src/auth.ts"] },
    ],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 1,
    timestamp: new Date().toISOString(),
    lifecycle: "final",
  };

  const traceB: PipelineTrace = {
    ...traceA,
    id: "tb",
    prompt: "task B unrelated prompt",
  };
  traceB.steps = [
    { name: "gen", provider: "mock", durationMs: 1, round: 1, filesModified: ["src/auth.ts", "src/user.ts"] },
  ];

  const cache = new PatternCache(mem, scope);
  const e1 = cache.storeFromTrace(traceA)!;
  const e2 = cache.storeFromTrace(traceB)!;

  const patternB = extractPattern(traceB)!;
  const linked = linkPatternByFiles(mem, scope, e2, patternB);
  assert.ok(linked.includes(e1.id));

  const related = getLinkedPatterns(mem, e2, scope);
  assert.equal(related.length, 1);
  assert.equal(related[0]!.promptHash, extractPattern(traceA)!.promptHash);
});
