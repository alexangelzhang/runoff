import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PipelineTrace } from "../../src/observability/trace.ts";
import { recordTrace } from "../../src/observability/trace.ts";
import type { LLMProvider, LLMRequest, LLMResponse, ProviderMode } from "../../src/providers/types.ts";
import {
  createHarnessCandidate,
  decideHarnessCandidate,
  evaluateHarnessCandidate,
  loadHarnessCandidate,
  listHarnessCandidates,
  proposeHarnessCandidate,
  rankHarnessCandidates,
  selectHarnessCoreset,
} from "../../src/orchestration/harness-evolution.ts";

function trace(id: string, overrides: Partial<PipelineTrace> = {}): PipelineTrace {
  return {
    id,
    prompt: `fix task ${id}`,
    promptLength: 12,
    mode: "pipeline",
    steps: [{ name: "implement", provider: "mock", durationMs: 10, round: 1 }],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 1000,
    hasVerifyResults: false,
    timestamp: `2026-06-20T00:00:0${id.at(-1) ?? "0"}.000Z`,
    totalUsage: { promptTokens: 100, completionTokens: 50 },
    ...overrides,
  };
}

class ProposalProvider implements LLMProvider {
  mode: ProviderMode = "agent-write";
  lastRequest?: LLMRequest;

  constructor(
    public name: string,
    private response: Omit<Extract<LLMResponse, { kind: "agent" }>, "kind" | "model">,
  ) {}

  async execute(req: LLMRequest): Promise<LLMResponse> {
    this.lastRequest = req;
    return {
      kind: "agent",
      model: "proposal-model",
      ...this.response,
    };
  }
}

test("harness evolution creates isolated candidate manifest and lists it", () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-harness-evolution-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    const sourceDir = join(dir, "source");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "SKILL.md"), "original", "utf-8");

    const candidate = createHarnessCandidate({
      candidateId: "candidate-a",
      summary: "Add recovery skill",
      sourceDir,
      editableSurface: ["skill/SKILL.md"],
      expectedFixes: ["recover failed trace"],
      possibleRegressions: ["extra tokens"],
      evidenceTraceIds: ["trace-a"],
    });

    assert.equal(candidate.manifest.summary, "Add recovery skill");
    assert.equal(candidate.variant.isolated, true);
    assert.match(candidate.variant.variantDir, /candidate-a/);
    assert.equal(listHarnessCandidates()[0]?.candidateId, "candidate-a");
  } finally {
    if (oldHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness evolution proposer writes proposal inside isolated variant", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-harness-propose-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    const provider = new ProposalProvider("agent-proposer", {
      summary: "Added a stricter observation hint check",
      changes: "diff --git a/skill/SKILL.md b/skill/SKILL.md\n",
      filesModified: ["skill/SKILL.md"],
      diffStat: "1 file changed, 2 insertions(+)",
    });

    const result = await proposeHarnessCandidate({
      candidateId: "candidate-propose",
      provider,
      summary: "Keep nextHint tool names current",
      editableSurface: ["skill/"],
      expectedFixes: ["observation hints use runoff_*"],
      instructions: "Update the skill guidance only.",
    });

    assert.equal(result.candidate.candidateId, "candidate-propose");
    assert.equal(result.proposal.failed, false);
    assert.deepEqual(result.proposal.filesModified, ["skill/SKILL.md"]);
    assert.equal(provider.lastRequest?.workDir, result.candidate.variant.variantDir);
    assert.equal(provider.lastRequest?.stepName, "harness-propose");
    assert.match(provider.lastRequest?.prompt ?? "", /Keep nextHint tool names current/);
    assert.match(provider.lastRequest?.prompt ?? "", /Update the skill guidance only/);

    const persisted = loadHarnessCandidate("candidate-propose");
    assert.equal(persisted?.proposal?.provider, "agent-proposer");
    const proposalPath = join(process.env.RUNOFF_HOME, "harness-evolution", "candidates", "candidate-propose", "proposal.json");
    assert.equal(existsSync(proposalPath), true);
    const proposal = JSON.parse(readFileSync(proposalPath, "utf-8")) as { surfaceViolations: string[] };
    assert.deepEqual(proposal.surfaceViolations, []);
  } finally {
    if (oldHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness evolution proposer flags files outside editable surface", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-harness-propose-violation-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    createHarnessCandidate({
      candidateId: "candidate-violation",
      summary: "Restrict proposer edits",
      editableSurface: ["skill/SKILL.md"],
    });
    const provider = new ProposalProvider("agent-proposer", {
      summary: "Changed skill plus source registration",
      changes: "diff --git a/src/index.ts b/src/index.ts\n",
      filesModified: ["skill/SKILL.md", "src/index.ts"],
      diffStat: "2 files changed",
    });

    const result = await proposeHarnessCandidate({
      candidateId: "candidate-violation",
      provider,
    });

    assert.equal(result.proposal.failed, true);
    assert.deepEqual(result.proposal.surfaceViolations, ["src/index.ts"]);
    assert.match(result.proposal.error ?? "", /outside editable surface/);
    assert.equal(loadHarnessCandidate("candidate-violation")?.proposal?.failed, true);
  } finally {
    if (oldHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness evolution selects difficult diverse coreset", () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-harness-coreset-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    recordTrace(trace("t1", { finalStatus: "approved", prompt: "simple docs update" }));
    recordTrace(trace("t2", { finalStatus: "failed", totalRounds: 3, prompt: "database migration failure" }));
    recordTrace(trace("t3", { finalStatus: "max_rounds", totalRounds: 4, prompt: "frontend state failure" }));

    const items = selectHarnessCoreset({ limit: 2 });

    assert.equal(items.length, 2);
    assert.equal(items[0]?.traceId, "t3");
    assert.ok(items.some((item) => item.traceId === "t2"));
  } finally {
    if (oldHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness evolution gates require held-in and held-out with improvement", () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-harness-gate-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    createHarnessCandidate({ candidateId: "candidate-b", summary: "Improve recovery" });
    recordTrace(trace("base-in", { finalStatus: "failed" }));
    recordTrace(trace("cand-in", { finalStatus: "approved" }));
    recordTrace(trace("base-out", { totalDurationMs: 2000 }));
    recordTrace(trace("cand-out", { totalDurationMs: 1000 }));

    const gate = evaluateHarnessCandidate({
      candidateId: "candidate-b",
      pairs: [
        { split: "held-in", baselineTraceId: "base-in", candidateTraceId: "cand-in" },
        { split: "held-out", baselineTraceId: "base-out", candidateTraceId: "cand-out" },
      ],
    });

    assert.equal(gate.accepted, true);
    assert.match(gate.reason, /passed/);
    assert.equal(gate.heldIn.improvements.length, 1);
    assert.equal(gate.heldOut.improvements.length, 1);
  } finally {
    if (oldHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness evolution ranks candidates and records rollback decision", () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-harness-rank-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    createHarnessCandidate({ candidateId: "good", summary: "Good candidate", expectedFixes: ["fix"] });
    createHarnessCandidate({ candidateId: "bad", summary: "Bad candidate" });
    recordTrace(trace("base-in", { finalStatus: "failed" }));
    recordTrace(trace("cand-in", { finalStatus: "approved" }));
    recordTrace(trace("base-out", { totalDurationMs: 2000 }));
    recordTrace(trace("cand-out", { totalDurationMs: 1000 }));
    recordTrace(trace("bad-out", { finalStatus: "failed" }));
    evaluateHarnessCandidate({
      candidateId: "good",
      pairs: [
        { split: "held-in", baselineTraceId: "base-in", candidateTraceId: "cand-in" },
        { split: "held-out", baselineTraceId: "base-out", candidateTraceId: "cand-out" },
      ],
    });
    evaluateHarnessCandidate({
      candidateId: "bad",
      pairs: [
        { split: "held-in", baselineTraceId: "base-in", candidateTraceId: "cand-in" },
        { split: "held-out", baselineTraceId: "base-out", candidateTraceId: "bad-out" },
      ],
    });

    const ranks = rankHarnessCandidates(["bad", "good"]);
    assert.equal(ranks[0]?.candidateId, "good");
    assert.equal(ranks[0]?.preferenceWins, 1);

    const decision = decideHarnessCandidate({ candidateId: "bad" });
    assert.equal(decision.decision, "rollback");
    assert.equal(listHarnessCandidates().find((c) => c.candidateId === "bad")?.status, "rolled_back");
  } finally {
    if (oldHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
