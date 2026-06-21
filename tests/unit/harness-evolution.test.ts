import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PipelineTrace } from "../../src/observability/trace.ts";
import { recordTrace } from "../../src/observability/trace.ts";
import type { LLMProvider, LLMRequest, LLMResponse, ProviderMode } from "../../src/providers/types.ts";
import {
  auditHarnessCandidate,
  createHarnessCandidate,
  createHarnessDataset,
  decideHarnessCandidate,
  evaluateHarnessCandidate,
  evaluateHarnessDataset,
  exportHarnessPromotionBundle,
  loadHarnessCandidate,
  loadHarnessDataset,
  loadHarnessEvolutionRun,
  listHarnessCandidates,
  listHarnessEvolutionRuns,
  mineHarnessFailureSignatures,
  proposeHarnessCandidate,
  queryHarnessEvolutionReport,
  rankHarnessCandidates,
  runHarnessEvolution,
  scanHarnessTriggers,
  selectHarnessCoreset,
  updateHarnessFrontier,
  writeHarnessConnectorReport,
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

test("harness evolution mines failure signatures and proposer receives history context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-harness-mine-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    recordTrace(trace("mine-a", {
      finalStatus: "failed",
      steps: [{ name: "implement", provider: "mock", durationMs: 10, round: 1, error: "missing verification command" }],
      hasVerifyResults: false,
    }));
    recordTrace(trace("mine-b", {
      finalStatus: "failed",
      steps: [{ name: "implement", provider: "mock", durationMs: 12, round: 1, error: "missing verification command" }],
      hasVerifyResults: false,
    }));

    const signatures = mineHarnessFailureSignatures({ traceIds: ["mine-a", "mine-b"] });

    assert.equal(signatures.length, 1);
    assert.equal(signatures[0]?.category, "step_error");
    assert.deepEqual(signatures[0]?.evidenceTraceIds, ["mine-a", "mine-b"]);
    assert.equal(existsSync(join(process.env.RUNOFF_HOME, "harness-evolution", "failure-signatures", `${signatures[0]!.signatureId}.json`)), true);

    const provider = new ProposalProvider("agent-proposer", {
      summary: "Uses mined failure signature",
      changes: "diff --git a/skill/SKILL.md b/skill/SKILL.md\n",
      filesModified: ["skill/SKILL.md"],
      diffStat: "1 file changed",
    }, (req) => {
      mkdirSync(join(req.workDir!, "skill"), { recursive: true });
      writeFileSync(join(req.workDir!, "skill", "SKILL.md"), "updated", "utf-8");
    });
    const result = await proposeHarnessCandidate({
      candidateId: "candidate-mined",
      provider,
      summary: "Address mined failure",
      editableSurface: ["skill/"],
      failureSignatureIds: [signatures[0]!.signatureId],
    });

    assert.deepEqual(result.proposal.failureSignatureIds, [signatures[0]!.signatureId]);
    assert.ok(result.proposal.historyContextPath);
    assert.equal(existsSync(result.proposal.historyContextPath!), true);
    assert.match(provider.lastRequest?.prompt ?? "", /Failure signatures/);
    assert.match(provider.lastRequest?.prompt ?? "", new RegExp(signatures[0]!.signatureId));
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

test("harness evolution persists dataset split and evaluates it as candidate gate evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-harness-dataset-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    recordTrace(trace("dataset-base-a", { finalStatus: "failed", timestamp: "2026-06-20T00:00:01.000Z" }));
    recordTrace(trace("dataset-base-b", { totalDurationMs: 2000, timestamp: "2026-06-20T00:00:02.000Z" }));
    recordTrace(trace("dataset-cand-a", { finalStatus: "approved", timestamp: "2026-06-20T00:00:03.000Z" }));
    recordTrace(trace("dataset-cand-b", { totalDurationMs: 1000, timestamp: "2026-06-20T00:00:04.000Z" }));
    createHarnessCandidate({
      candidateId: "candidate-dataset",
      summary: "Dataset-backed candidate",
      datasetIds: ["dataset-main"],
    });

    const dataset = createHarnessDataset({
      datasetId: "dataset-main",
      name: "main regression split",
      traceIds: ["dataset-base-a", "dataset-base-b"],
      heldInRatio: 0.5,
      leakageTerms: ["heldout-secret"],
    });
    const evaluation = evaluateHarnessDataset({
      candidateId: "candidate-dataset",
      datasetId: "dataset-main",
      candidateTraceIdsByBaseline: {
        "dataset-base-a": "dataset-cand-a",
        "dataset-base-b": "dataset-cand-b",
      },
    });

    assert.equal(dataset.heldIn.length, 1);
    assert.equal(dataset.heldOut.length, 1);
    assert.deepEqual(loadHarnessDataset("dataset-main")?.leakageTerms, ["heldout-secret"]);
    assert.equal(evaluation.gate.accepted, true);
    assert.deepEqual(evaluation.pairs.map((pair) => pair.split), ["held-in", "held-out"]);
    assert.deepEqual(loadHarnessCandidate("candidate-dataset")?.lineage?.datasetIds, ["dataset-main"]);
    assert.equal(
      existsSync(join(process.env.RUNOFF_HOME, "harness-evolution", "datasets", "dataset-main", "evaluations", "candidate-dataset.json")),
      true,
    );
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
    const audit = auditHarnessCandidate({ candidateId: "candidate-accept" });

    const decision = decideHarnessCandidate({ candidateId: "candidate-accept" });

    assert.equal(audit.passed, true);
    assert.equal(decision.decision, "accept");
    assert.equal(decision.acceptanceChecks.accepted, true);
    assert.equal(decision.acceptanceChecks.auditPassed, true);
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
    const audit = auditHarnessCandidate({ candidateId: "candidate-blocked" });

    assert.equal(audit.passed, false);
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
    auditHarnessCandidate({ candidateId: "candidate-export" });
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

test("harness evolution audit blocks leakage terms from held-out dataset", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-harness-leakage-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    recordTrace(trace("leak-base-in", { finalStatus: "failed", timestamp: "2026-06-20T00:00:01.000Z" }));
    recordTrace(trace("leak-base-out", { totalDurationMs: 2000, timestamp: "2026-06-20T00:00:02.000Z" }));
    const dataset = createHarnessDataset({
      datasetId: "leak-dataset",
      name: "leakage split",
      traceIds: ["leak-base-in", "leak-base-out"],
      heldInRatio: 0.5,
      leakageTerms: ["heldout-answer"],
    });
    const provider = new ProposalProvider("agent-proposer", {
      summary: "Leaks held-out answer",
      changes: "diff --git a/skill/SKILL.md b/skill/SKILL.md\n",
      filesModified: ["skill/SKILL.md"],
      diffStat: "1 file changed",
    }, (req) => {
      mkdirSync(join(req.workDir!, "skill"), { recursive: true });
      writeFileSync(join(req.workDir!, "skill", "SKILL.md"), `updated ${dataset.heldOut[0]!.baselineTraceId} heldout-answer`, "utf-8");
    });

    await proposeHarnessCandidate({
      candidateId: "candidate-leak",
      provider,
      summary: "Leak held-out facts",
      editableSurface: ["skill/"],
      datasetIds: ["leak-dataset"],
    });
    const audit = auditHarnessCandidate({ candidateId: "candidate-leak", datasetId: "leak-dataset" });

    assert.equal(audit.passed, false);
    assert.equal(audit.datasetId, "leak-dataset");
    assert.ok(audit.findings.some((finding) => finding.rule === "leakage-term" && finding.severity === "blocker"));
    assert.throws(
      () => decideHarnessCandidate({ candidateId: "candidate-leak", decision: "accept" }),
      /cannot be accepted/,
    );
  } finally {
    if (oldHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness evolution frontier records lineage, gate, audit, and rejected candidates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-harness-frontier-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    recordTrace(trace("frontier-base-in", { finalStatus: "failed" }));
    recordTrace(trace("frontier-cand-in", { finalStatus: "approved" }));
    recordTrace(trace("frontier-base-out", { totalDurationMs: 2000 }));
    recordTrace(trace("frontier-cand-out", { totalDurationMs: 1000 }));
    const provider = new ProposalProvider("agent-proposer", {
      summary: "Frontier candidate",
      changes: "diff --git a/skill/SKILL.md b/skill/SKILL.md\n",
      filesModified: ["skill/SKILL.md"],
      diffStat: "1 file changed",
    }, (req) => {
      mkdirSync(join(req.workDir!, "skill"), { recursive: true });
      writeFileSync(join(req.workDir!, "skill", "SKILL.md"), "updated", "utf-8");
    });
    await proposeHarnessCandidate({
      candidateId: "candidate-frontier-good",
      provider,
      summary: "Frontier accepted candidate",
      editableSurface: ["skill/"],
      parentCandidateIds: ["candidate-parent"],
      datasetIds: ["frontier-dataset"],
    });
    createHarnessCandidate({ candidateId: "candidate-frontier-rejected", summary: "No audit candidate" });
    evaluateHarnessCandidate({
      candidateId: "candidate-frontier-good",
      pairs: [
        { split: "held-in", baselineTraceId: "frontier-base-in", candidateTraceId: "frontier-cand-in" },
        { split: "held-out", baselineTraceId: "frontier-base-out", candidateTraceId: "frontier-cand-out" },
      ],
    });
    auditHarnessCandidate({ candidateId: "candidate-frontier-good" });
    decideHarnessCandidate({ candidateId: "candidate-frontier-good" });

    const frontier = updateHarnessFrontier({
      frontierId: "main",
      candidateIds: ["candidate-frontier-good", "candidate-frontier-rejected"],
    });
    const accepted = frontier.entries.find((entry) => entry.candidateId === "candidate-frontier-good")!;
    const rejected = frontier.entries.find((entry) => entry.candidateId === "candidate-frontier-rejected")!;

    assert.equal(accepted.accepted, true);
    assert.equal(accepted.gateAccepted, true);
    assert.equal(accepted.auditPassed, true);
    assert.deepEqual(accepted.parentCandidateIds, ["candidate-parent"]);
    assert.equal(rejected.auditPassed, false);
    assert.ok(frontier.rejectedCandidateIds.includes("candidate-frontier-rejected"));
    assert.equal(existsSync(join(process.env.RUNOFF_HOME, "harness-evolution", "frontiers", "main.json")), true);
  } finally {
    if (oldHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness evolution run persists complete accepted report and promotion bundle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-harness-run-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    recordTrace(trace("run-base-in", { finalStatus: "failed", timestamp: "2026-06-20T00:00:01.000Z" }));
    recordTrace(trace("run-base-out", { totalDurationMs: 2000, timestamp: "2026-06-20T00:00:02.000Z" }));
    recordTrace(trace("run-cand-in", { finalStatus: "approved", timestamp: "2026-06-20T00:00:03.000Z" }));
    recordTrace(trace("run-cand-out", { totalDurationMs: 1000, timestamp: "2026-06-20T00:00:04.000Z" }));
    const provider = new ProposalProvider("agent-proposer", {
      summary: "Complete run candidate",
      changes: "diff --git a/skill/SKILL.md b/skill/SKILL.md\n",
      filesModified: ["skill/SKILL.md"],
      diffStat: "1 file changed",
    }, (req) => {
      mkdirSync(join(req.workDir!, "skill"), { recursive: true });
      writeFileSync(join(req.workDir!, "skill", "SKILL.md"), "updated", "utf-8");
    });

    const run = await runHarnessEvolution({
      runId: "run-complete",
      provider,
      summary: "Complete harness evolution run",
      candidateId: "candidate-run-complete",
      datasetId: "dataset-run-complete",
      frontierId: "frontier-run-complete",
      traceIds: ["run-base-in", "run-base-out"],
      editableSurface: ["skill/"],
      candidateTraceIdsByBaseline: {
        "run-base-in": "run-cand-in",
        "run-base-out": "run-cand-out",
      },
      exportOnAccept: true,
    });
    const report = queryHarnessEvolutionReport("run-complete");

    assert.equal(run.status, "exported");
    assert.equal(run.decision?.decision, "accept");
    assert.equal(run.audit?.passed, true);
    assert.equal(run.evaluation?.gate.accepted, true);
    assert.equal(run.bundle?.candidateId, "candidate-run-complete");
    assert.equal(report.status, "exported");
    assert.equal(report.auditPassed, true);
    assert.equal(report.gateAccepted, true);
    assert.deepEqual(report.missingCandidateTraceIds, []);
    assert.equal(loadHarnessEvolutionRun("run-complete")?.runId, "run-complete");
    assert.equal(listHarnessEvolutionRuns()[0]?.runId, "run-complete");
    assert.equal(existsSync(join(process.env.RUNOFF_HOME, "harness-evolution", "runs", "run-complete", "report.json")), true);
  } finally {
    if (oldHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness evolution run stops with next action when candidate trace map is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-harness-run-awaiting-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    recordTrace(trace("await-base-in", { finalStatus: "failed", timestamp: "2026-06-20T00:00:01.000Z" }));
    recordTrace(trace("await-base-out", { totalDurationMs: 2000, timestamp: "2026-06-20T00:00:02.000Z" }));
    const provider = new ProposalProvider("agent-proposer", {
      summary: "Awaiting candidate traces",
      changes: "diff --git a/skill/SKILL.md b/skill/SKILL.md\n",
      filesModified: ["skill/SKILL.md"],
      diffStat: "1 file changed",
    }, (req) => {
      mkdirSync(join(req.workDir!, "skill"), { recursive: true });
      writeFileSync(join(req.workDir!, "skill", "SKILL.md"), "updated", "utf-8");
    });

    const run = await runHarnessEvolution({
      runId: "run-awaiting",
      provider,
      summary: "Awaiting trace map",
      candidateId: "candidate-run-awaiting",
      datasetId: "dataset-run-awaiting",
      traceIds: ["await-base-in", "await-base-out"],
      editableSurface: ["skill/"],
    });
    const report = queryHarnessEvolutionReport("run-awaiting");

    assert.equal(run.status, "awaiting_candidate_traces");
    assert.deepEqual(run.missingCandidateTraceIds, ["await-base-in", "await-base-out"]);
    assert.match(run.nextAction, /provide candidateTraceIdsByBaseline/);
    assert.equal(run.evaluation, undefined);
    assert.equal(report.status, "awaiting_candidate_traces");
    assert.deepEqual(report.missingCandidateTraceIds, ["await-base-in", "await-base-out"]);
  } finally {
    if (oldHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness trigger scan emits report-only and proposed pending plans from durable state", () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-harness-trigger-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    recordTrace(trace("trigger-failed", {
      finalStatus: "failed",
      steps: [{ name: "implement", provider: "mock", durationMs: 10, round: 1, error: "verify failed" }],
    }));

    const scan = scanHarnessTriggers({
      scanId: "scan-main",
      rules: [
        {
          ruleId: "failed-report",
          kind: "trace_failure",
          enabled: true,
          summary: "Report failed traces",
          allowedAction: "report",
          traceIds: ["trigger-failed"],
          minFailureCount: 1,
        },
        {
          ruleId: "failed-propose",
          kind: "trace_failure",
          enabled: true,
          summary: "Propose from failed traces",
          allowedAction: "propose",
          traceIds: ["trigger-failed"],
          minFailureCount: 1,
        },
      ],
    });

    assert.equal(scan.events.length, 2);
    assert.equal(scan.events[0]?.plan, undefined);
    assert.equal(scan.events[1]?.plan?.triggerEventId, scan.events[1]?.eventId);
    assert.deepEqual(scan.events[1]?.traceIds, ["trigger-failed"]);
    assert.equal(existsSync(join(process.env.RUNOFF_HOME, "harness-evolution", "triggers", "scans", "scan-main.json")), true);
  } finally {
    if (oldHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness evolution run blocks acceptance when role policy lacks independent checker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-harness-role-policy-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    recordTrace(trace("role-base-in", { finalStatus: "failed", timestamp: "2026-06-20T00:00:01.000Z" }));
    recordTrace(trace("role-base-out", { totalDurationMs: 2000, timestamp: "2026-06-20T00:00:02.000Z" }));
    recordTrace(trace("role-cand-in", { finalStatus: "approved", timestamp: "2026-06-20T00:00:03.000Z" }));
    recordTrace(trace("role-cand-out", { totalDurationMs: 1000, timestamp: "2026-06-20T00:00:04.000Z" }));
    const provider = new ProposalProvider("builder", {
      summary: "Role policy candidate",
      changes: "diff --git a/skill/SKILL.md b/skill/SKILL.md\n",
      filesModified: ["skill/SKILL.md"],
      diffStat: "1 file changed",
    }, (req) => {
      mkdirSync(join(req.workDir!, "skill"), { recursive: true });
      writeFileSync(join(req.workDir!, "skill", "SKILL.md"), "updated", "utf-8");
    });

    const run = await runHarnessEvolution({
      runId: "run-role-blocked",
      provider,
      summary: "Role policy blocked",
      candidateId: "candidate-role-blocked",
      datasetId: "dataset-role-blocked",
      traceIds: ["role-base-in", "role-base-out"],
      editableSurface: ["skill/"],
      candidateTraceIdsByBaseline: {
        "role-base-in": "role-cand-in",
        "role-base-out": "role-cand-out",
      },
      rolePolicy: {
        requireIndependentReviewer: true,
        requireIndependentVerifier: true,
        builderProvider: "builder",
        reviewerProvider: "builder",
      },
    });

    assert.equal(run.status, "blocked");
    assert.equal(run.roleEvidence?.passed, false);
    assert.match(run.nextAction, /fix role policy/);
    assert.equal(loadHarnessCandidate("candidate-role-blocked")?.status, "proposed");
    assert.equal(queryHarnessEvolutionReport("run-role-blocked").rolePolicyPassed, false);
  } finally {
    if (oldHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness connector writeback emits markdown and jsonl reports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-harness-writeback-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    recordTrace(trace("write-base-in", { finalStatus: "failed", timestamp: "2026-06-20T00:00:01.000Z" }));
    recordTrace(trace("write-base-out", { totalDurationMs: 2000, timestamp: "2026-06-20T00:00:02.000Z" }));
    const provider = new ProposalProvider("builder", {
      summary: "Writeback candidate",
      changes: "diff --git a/skill/SKILL.md b/skill/SKILL.md\n",
      filesModified: ["skill/SKILL.md"],
      diffStat: "1 file changed",
    }, (req) => {
      mkdirSync(join(req.workDir!, "skill"), { recursive: true });
      writeFileSync(join(req.workDir!, "skill", "SKILL.md"), "updated", "utf-8");
    });
    await runHarnessEvolution({
      runId: "run-writeback",
      provider,
      summary: "Writeback run",
      candidateId: "candidate-writeback",
      datasetId: "dataset-writeback",
      traceIds: ["write-base-in", "write-base-out"],
      editableSurface: ["skill/"],
    });

    const markdownPath = join(dir, "report.md");
    const jsonlPath = join(dir, "report.jsonl");
    const writebacks = writeHarnessConnectorReport({
      runId: "run-writeback",
      targets: [
        { kind: "markdown", path: markdownPath },
        { kind: "local_jsonl", path: jsonlPath },
      ],
    });

    assert.equal(writebacks.length, 2);
    assert.match(readFileSync(markdownPath, "utf-8"), /Harness Evolution Report: run-writeback/);
    assert.match(readFileSync(jsonlPath, "utf-8"), /"runId":"run-writeback"/);
    assert.equal(loadHarnessEvolutionRun("run-writeback")?.connectorWritebacks?.length, 2);
  } finally {
    if (oldHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
