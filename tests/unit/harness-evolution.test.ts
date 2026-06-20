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
  exportHarnessPromotionBundle,
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
    private onExecute?: (req: LLMRequest) => void,
  ) {}

  async execute(req: LLMRequest): Promise<LLMResponse> {
    this.lastRequest = req;
    this.onExecute?.(req);
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
    }, (req) => {
      mkdirSync(join(req.workDir!, "skill"), { recursive: true });
      writeFileSync(join(req.workDir!, "skill", "SKILL.md"), "updated", "utf-8");
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
    assert.deepEqual(result.proposal.observedFilesModified, ["skill/SKILL.md"]);
    assert.equal(result.proposal.observedDiffStat, "1 files changed (1 added)");
    assert.deepEqual(result.proposal.unreportedFilesModified, []);
    assert.deepEqual(result.proposal.reportedButUnchangedFiles, []);
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
    }, (req) => {
      mkdirSync(join(req.workDir!, "skill"), { recursive: true });
      writeFileSync(join(req.workDir!, "skill", "SKILL.md"), "updated", "utf-8");
    });

    const result = await proposeHarnessCandidate({
      candidateId: "candidate-violation",
      provider,
    });

    assert.equal(result.proposal.failed, true);
    assert.deepEqual(result.proposal.surfaceViolations, ["src/index.ts"]);
    assert.match(result.proposal.error ?? "", /outside editable surface/);
    assert.deepEqual(result.proposal.reportedButUnchangedFiles, ["src/index.ts"]);
    assert.equal(loadHarnessCandidate("candidate-violation")?.proposal?.failed, true);
  } finally {
    if (oldHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness evolution proposer detects unreported variant edits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-harness-propose-unreported-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    const provider = new ProposalProvider("agent-proposer", {
      summary: "Changed files but forgot to report them",
      changes: "",
      filesModified: [],
      diffStat: "0 files changed",
    }, (req) => {
      mkdirSync(join(req.workDir!, "skill"), { recursive: true });
      writeFileSync(join(req.workDir!, "skill", "SKILL.md"), "updated", "utf-8");
      mkdirSync(join(req.workDir!, "src"), { recursive: true });
      writeFileSync(join(req.workDir!, "src", "index.ts"), "export const changed = true;\n", "utf-8");
    });

    const result = await proposeHarnessCandidate({
      candidateId: "candidate-unreported",
      provider,
      summary: "Detect actual edits",
      editableSurface: ["skill/"],
    });

    assert.equal(result.proposal.failed, true);
    assert.deepEqual(result.proposal.filesModified, []);
    assert.deepEqual(result.proposal.observedFilesModified, ["skill/SKILL.md", "src/index.ts"]);
    assert.deepEqual(result.proposal.unreportedFilesModified, ["skill/SKILL.md", "src/index.ts"]);
    assert.deepEqual(result.proposal.surfaceViolations, ["src/index.ts"]);
    assert.match(result.proposal.observedDiffStat, /2 files changed/);
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

test("harness evolution accepts only clean proposal with observed diff and passing gate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-harness-accept-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    const provider = new ProposalProvider("agent-proposer", {
      summary: "Clean harness proposal",
      changes: "diff --git a/skill/SKILL.md b/skill/SKILL.md\n",
      filesModified: ["skill/SKILL.md"],
      diffStat: "1 file changed",
    }, (req) => {
      mkdirSync(join(req.workDir!, "skill"), { recursive: true });
      writeFileSync(join(req.workDir!, "skill", "SKILL.md"), "updated", "utf-8");
    });
    await proposeHarnessCandidate({
      candidateId: "candidate-accept",
      provider,
      summary: "Accept clean proposal",
      editableSurface: ["skill/"],
    });
    recordTrace(trace("accept-base-in", { finalStatus: "failed" }));
    recordTrace(trace("accept-cand-in", { finalStatus: "approved" }));
    recordTrace(trace("accept-base-out", { totalDurationMs: 2000 }));
    recordTrace(trace("accept-cand-out", { totalDurationMs: 1000 }));
    evaluateHarnessCandidate({
      candidateId: "candidate-accept",
      pairs: [
        { split: "held-in", baselineTraceId: "accept-base-in", candidateTraceId: "accept-cand-in" },
        { split: "held-out", baselineTraceId: "accept-base-out", candidateTraceId: "accept-cand-out" },
      ],
    });

    const decision = decideHarnessCandidate({ candidateId: "candidate-accept" });

    assert.equal(decision.decision, "accept");
    assert.equal(decision.acceptanceChecks.accepted, true);
    assert.equal(decision.acceptanceChecks.observedDiffPresent, true);
    assert.equal(loadHarnessCandidate("candidate-accept")?.status, "accepted");
  } finally {
    if (oldHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness evolution blocks forced accept when proposal audit is not clean", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-harness-accept-blocked-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    const provider = new ProposalProvider("agent-proposer", {
      summary: "Unreported outside edit",
      changes: "",
      filesModified: [],
      diffStat: "0 files changed",
    }, (req) => {
      mkdirSync(join(req.workDir!, "src"), { recursive: true });
      writeFileSync(join(req.workDir!, "src", "index.ts"), "export const changed = true;\n", "utf-8");
    });
    await proposeHarnessCandidate({
      candidateId: "candidate-blocked",
      provider,
      summary: "Block unsafe proposal",
      editableSurface: ["skill/"],
    });
    recordTrace(trace("blocked-base-in", { finalStatus: "failed" }));
    recordTrace(trace("blocked-cand-in", { finalStatus: "approved" }));
    recordTrace(trace("blocked-base-out", { totalDurationMs: 2000 }));
    recordTrace(trace("blocked-cand-out", { totalDurationMs: 1000 }));
    evaluateHarnessCandidate({
      candidateId: "candidate-blocked",
      pairs: [
        { split: "held-in", baselineTraceId: "blocked-base-in", candidateTraceId: "blocked-cand-in" },
        { split: "held-out", baselineTraceId: "blocked-base-out", candidateTraceId: "blocked-cand-out" },
      ],
    });

    assert.throws(
      () => decideHarnessCandidate({ candidateId: "candidate-blocked", decision: "accept" }),
      /cannot be accepted/,
    );
    const rollback = decideHarnessCandidate({ candidateId: "candidate-blocked" });
    assert.equal(rollback.decision, "rollback");
    assert.equal(rollback.acceptanceChecks.accepted, false);
    assert.equal(rollback.acceptanceChecks.noSurfaceViolations, false);
    assert.equal(loadHarnessCandidate("candidate-blocked")?.status, "rolled_back");
  } finally {
    if (oldHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness evolution exports promotion bundle only after accepted decision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-harness-export-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    const provider = new ProposalProvider("agent-proposer", {
      summary: "Exportable harness proposal",
      changes: "diff --git a/skill/SKILL.md b/skill/SKILL.md\n",
      filesModified: ["skill/SKILL.md"],
      diffStat: "1 file changed",
    }, (req) => {
      mkdirSync(join(req.workDir!, "skill"), { recursive: true });
      writeFileSync(join(req.workDir!, "skill", "SKILL.md"), "updated", "utf-8");
    });
    await proposeHarnessCandidate({
      candidateId: "candidate-export",
      provider,
      summary: "Export clean proposal",
      editableSurface: ["skill/"],
    });
    assert.throws(
      () => exportHarnessPromotionBundle({ candidateId: "candidate-export" }),
      /not accepted/,
    );
    recordTrace(trace("export-base-in", { finalStatus: "failed" }));
    recordTrace(trace("export-cand-in", { finalStatus: "approved" }));
    recordTrace(trace("export-base-out", { totalDurationMs: 2000 }));
    recordTrace(trace("export-cand-out", { totalDurationMs: 1000 }));
    evaluateHarnessCandidate({
      candidateId: "candidate-export",
      pairs: [
        { split: "held-in", baselineTraceId: "export-base-in", candidateTraceId: "export-cand-in" },
        { split: "held-out", baselineTraceId: "export-base-out", candidateTraceId: "export-cand-out" },
      ],
    });
    decideHarnessCandidate({ candidateId: "candidate-export" });

    const bundle = exportHarnessPromotionBundle({ candidateId: "candidate-export" });

    assert.equal(bundle.candidateId, "candidate-export");
    assert.equal(bundle.decision.acceptanceChecks.accepted, true);
    assert.equal(bundle.files.length, 1);
    assert.equal(bundle.files[0]?.path, "skill/SKILL.md");
    assert.equal(bundle.files[0]?.copied, true);
    assert.equal(existsSync(join(bundle.filesDir, "skill", "SKILL.md")), true);
    assert.equal(existsSync(join(bundle.bundleDir, "bundle.json")), true);
    const persisted = JSON.parse(readFileSync(join(bundle.bundleDir, "bundle.json"), "utf-8")) as { candidateId: string };
    assert.equal(persisted.candidateId, "candidate-export");
  } finally {
    if (oldHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
