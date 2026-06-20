import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createControlPlane } from "../../src/orchestration/control-plane.ts";
import { syncRunStoreFromPipeline } from "../../src/orchestration/run-control.ts";
import type { PipelineConfig } from "../../src/core/config.ts";
import {
  auditHarnessCandidate,
  createHarnessCandidate,
  createHarnessDataset,
  decideHarnessCandidate,
  evaluateHarnessCandidate,
  loadHarnessCandidate,
} from "../../src/orchestration/harness-evolution.ts";
import { recordTrace, type PipelineTrace } from "../../src/observability/trace.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "scripts", "ts", "dev", "pipeline-cli.ts");

function trace(id: string, overrides: Partial<PipelineTrace> = {}): PipelineTrace {
  return {
    id,
    prompt: `cli harness ${id}`,
    promptLength: 12,
    mode: "pipeline",
    steps: [{ name: "implement", provider: "mock", durationMs: 10, round: 1 }],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 1000,
    hasVerifyResults: false,
    timestamp: `2026-06-20T00:00:00.000Z`,
    ...overrides,
  };
}

test("pipeline-cli --help exits 0", async () => {
  const code = await new Promise<number>((resolve, reject) => {
    const c = spawn("npx", ["tsx", CLI, "--help"], { cwd: ROOT, stdio: "ignore" });
    c.on("error", reject);
    c.on("close", (x) => resolve(x ?? 1));
  });
  assert.equal(code, 0);
});

test("pipeline-cli run requires --work-dir", async () => {
  const child = spawn("npx", ["tsx", CLI, "run", "--prompt", "test"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d) => { stderr += d.toString(); });
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (x) => resolve(x ?? 1));
  });
  assert.notEqual(code, 0);
  assert.match(stderr, /work-dir/i);
});

test("examples/configs/cli.config.json exists", () => {
  assert.ok(existsSync(join(ROOT, "examples", "configs", "cli.config.json")));
});

test("pipeline-cli runs list emits JSON control-plane state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-runs-"));
  try {
    const home = join(dir, "home");
    const config: PipelineConfig = {
      providers: { mock: { type: "mock" } },
      pipeline: { implement: ["mock"] },
      runtime: { controlPlane: "file" },
    };
    const configPath = join(dir, "pipeline.config.json");
    writeFileSync(configPath, JSON.stringify(config), "utf-8");
    const oldHome = process.env.RUNOFF_HOME;
    process.env.RUNOFF_HOME = home;
    try {
      const controlPlane = createControlPlane(config);
      syncRunStoreFromPipeline(controlPlane.runStore, {
        runId: "trace-cli",
        sessionId: "session-cli",
        round: 1,
        pipelineStatus: "running",
      });
    } finally {
      if (oldHome !== undefined) process.env.RUNOFF_HOME = oldHome;
      else delete process.env.RUNOFF_HOME;
    }

    const child = spawn("npx", ["tsx", CLI, "runs", "list", "--config", configPath, "--home", home, "--json"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (x) => resolve(x ?? 1));
    });

    assert.equal(code, 0, stderr);
    const body = JSON.parse(stdout) as { count: number; runs: Array<{ runId: string; nextAction: string }> };
    assert.equal(body.count, 1);
    assert.equal(body.runs[0]?.runId, "trace-cli");
    assert.equal(body.runs[0]?.nextAction, "wait");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline-cli runs show accepts positional run id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-runs-show-"));
  try {
    const home = join(dir, "home");
    const config: PipelineConfig = {
      providers: { mock: { type: "mock" } },
      pipeline: { implement: ["mock"] },
      runtime: { controlPlane: "file" },
    };
    const configPath = join(dir, "pipeline.config.json");
    writeFileSync(configPath, JSON.stringify(config), "utf-8");
    const oldHome = process.env.RUNOFF_HOME;
    process.env.RUNOFF_HOME = home;
    try {
      const controlPlane = createControlPlane(config);
      syncRunStoreFromPipeline(controlPlane.runStore, {
        runId: "trace-cli-show",
        sessionId: "session-cli-show",
        round: 1,
        pipelineStatus: "awaiting_judge",
      });
    } finally {
      if (oldHome !== undefined) process.env.RUNOFF_HOME = oldHome;
      else delete process.env.RUNOFF_HOME;
    }

    const child = spawn("npx", ["tsx", CLI, "runs", "show", "trace-cli-show", "--config", configPath, "--home", home], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (x) => resolve(x ?? 1));
    });

    assert.equal(code, 0, stderr);
    assert.match(stdout, /runId:\s+trace-cli-show/);
    assert.match(stdout, /nextAction:\s+approve_or_reject/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline-cli harness create and list use isolated evolution home", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-harness-"));
  try {
    const home = join(dir, "home");
    const create = spawn("npx", [
      "tsx",
      CLI,
      "harness",
      "create",
      "--candidate-id",
      "cli-candidate",
      "--summary",
      "try recovery manifest",
      "--home",
      home,
      "--json",
    ], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let createStdout = "";
    let createStderr = "";
    create.stdout?.on("data", (d) => { createStdout += d.toString(); });
    create.stderr?.on("data", (d) => { createStderr += d.toString(); });
    const createCode = await new Promise<number>((resolve, reject) => {
      create.on("error", reject);
      create.on("close", (x) => resolve(x ?? 1));
    });
    assert.equal(createCode, 0, createStderr);
    assert.equal(JSON.parse(createStdout).candidate.candidateId, "cli-candidate");

    const list = spawn("npx", ["tsx", CLI, "harness", "list", "--home", home, "--json"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let listStdout = "";
    let listStderr = "";
    list.stdout?.on("data", (d) => { listStdout += d.toString(); });
    list.stderr?.on("data", (d) => { listStderr += d.toString(); });
    const listCode = await new Promise<number>((resolve, reject) => {
      list.on("error", reject);
      list.on("close", (x) => resolve(x ?? 1));
    });
    assert.equal(listCode, 0, listStderr);
    const body = JSON.parse(listStdout) as { count: number; candidates: Array<{ candidateId: string }> };
    assert.equal(body.count, 1);
    assert.equal(body.candidates[0]?.candidateId, "cli-candidate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline-cli harness mine emits failure signatures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-harness-mine-"));
  try {
    const home = join(dir, "home");
    const oldHome = process.env.RUNOFF_HOME;
    process.env.RUNOFF_HOME = home;
    try {
      recordTrace(trace("cli-mine", {
        finalStatus: "failed",
        steps: [{ name: "implement", provider: "mock", durationMs: 10, round: 1, error: "verify failed" }],
        hasVerifyResults: false,
      }));
    } finally {
      if (oldHome !== undefined) process.env.RUNOFF_HOME = oldHome;
      else delete process.env.RUNOFF_HOME;
    }

    const child = spawn("npx", ["tsx", CLI, "harness", "mine", "--trace-ids-json", "[\"cli-mine\"]", "--home", home, "--json"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (x) => resolve(x ?? 1));
    });

    assert.equal(code, 0, stderr);
    const body = JSON.parse(stdout) as { count: number; signatures: Array<{ category: string; evidenceTraceIds: string[] }> };
    assert.equal(body.count, 1);
    assert.equal(body.signatures[0]?.category, "step_error");
    assert.deepEqual(body.signatures[0]?.evidenceTraceIds, ["cli-mine"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline-cli harness dataset creates persisted held-in and held-out split", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-harness-dataset-"));
  try {
    const home = join(dir, "home");
    const oldHome = process.env.RUNOFF_HOME;
    process.env.RUNOFF_HOME = home;
    try {
      recordTrace(trace("cli-dataset-a", { finalStatus: "failed", timestamp: "2026-06-20T00:00:01.000Z" }));
      recordTrace(trace("cli-dataset-b", { totalDurationMs: 2000, timestamp: "2026-06-20T00:00:02.000Z" }));
    } finally {
      if (oldHome !== undefined) process.env.RUNOFF_HOME = oldHome;
      else delete process.env.RUNOFF_HOME;
    }

    const child = spawn("npx", [
      "tsx",
      CLI,
      "harness",
      "dataset",
      "--dataset-id",
      "cli-dataset",
      "--summary",
      "cli regression split",
      "--trace-ids-json",
      "[\"cli-dataset-a\",\"cli-dataset-b\"]",
      "--held-in-ratio",
      "0.5",
      "--home",
      home,
      "--json",
    ], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (x) => resolve(x ?? 1));
    });

    assert.equal(code, 0, stderr);
    const body = JSON.parse(stdout) as { dataset: { datasetId: string; heldIn: unknown[]; heldOut: unknown[] } };
    assert.equal(body.dataset.datasetId, "cli-dataset");
    assert.equal(body.dataset.heldIn.length, 1);
    assert.equal(body.dataset.heldOut.length, 1);
    assert.equal(existsSync(join(home, "harness-evolution", "datasets", "cli-dataset.json")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline-cli harness evaluate-dataset emits dataset evaluation gate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-harness-evaluate-dataset-"));
  try {
    const home = join(dir, "home");
    const oldHome = process.env.RUNOFF_HOME;
    process.env.RUNOFF_HOME = home;
    try {
      recordTrace(trace("cli-eval-base-a", { finalStatus: "failed", timestamp: "2026-06-20T00:00:01.000Z" }));
      recordTrace(trace("cli-eval-base-b", { totalDurationMs: 2000, timestamp: "2026-06-20T00:00:02.000Z" }));
      recordTrace(trace("cli-eval-cand-a", { finalStatus: "approved", timestamp: "2026-06-20T00:00:03.000Z" }));
      recordTrace(trace("cli-eval-cand-b", { totalDurationMs: 1000, timestamp: "2026-06-20T00:00:04.000Z" }));
      createHarnessCandidate({ candidateId: "cli-eval-candidate", summary: "dataset evaluation candidate" });
      createHarnessDataset({
        datasetId: "cli-eval-dataset",
        name: "cli dataset",
        traceIds: ["cli-eval-base-a", "cli-eval-base-b"],
        heldInRatio: 0.5,
      });
    } finally {
      if (oldHome !== undefined) process.env.RUNOFF_HOME = oldHome;
      else delete process.env.RUNOFF_HOME;
    }

    const child = spawn("npx", [
      "tsx",
      CLI,
      "harness",
      "evaluate-dataset",
      "cli-eval-candidate",
      "--dataset-id",
      "cli-eval-dataset",
      "--candidate-trace-map-json",
      "{\"cli-eval-base-a\":\"cli-eval-cand-a\",\"cli-eval-base-b\":\"cli-eval-cand-b\"}",
      "--home",
      home,
      "--json",
    ], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (x) => resolve(x ?? 1));
    });

    assert.equal(code, 0, stderr);
    const body = JSON.parse(stdout) as { evaluation: { datasetId: string; gate: { accepted: boolean } } };
    assert.equal(body.evaluation.datasetId, "cli-eval-dataset");
    assert.equal(body.evaluation.gate.accepted, true);
    assert.equal(existsSync(join(home, "harness-evolution", "datasets", "cli-eval-dataset", "evaluations", "cli-eval-candidate.json")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline-cli harness propose writes proposal with configured provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-harness-propose-"));
  try {
    const home = join(dir, "home");
    const config: PipelineConfig = {
      providers: { mock: { type: "mock" } },
      pipeline: { implement: ["mock"] },
      orchestration: { mode: "dag", plannerProvider: "mock" },
    };
    const configPath = join(dir, "pipeline.config.json");
    writeFileSync(configPath, JSON.stringify(config), "utf-8");

    const child = spawn("npx", [
      "tsx",
      CLI,
      "harness",
      "propose",
      "--candidate-id",
      "cli-proposal",
      "--summary",
      "try automatic proposer",
      "--editable-surface-json",
      "[\"skill/\"]",
      "--config",
      configPath,
      "--home",
      home,
      "--json",
    ], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (x) => resolve(x ?? 1));
    });

    assert.equal(code, 0, stderr);
    const body = JSON.parse(stdout) as {
      candidate: { candidateId: string; proposal?: { provider: string } };
      proposal: { provider: string; filesModified: string[] };
    };
    assert.equal(body.candidate.candidateId, "cli-proposal");
    assert.equal(body.proposal.provider, "mock");
    assert.deepEqual(body.proposal.filesModified, []);
    assert.equal(existsSync(join(home, "harness-evolution", "candidates", "cli-proposal", "proposal.json")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline-cli harness audit and frontier expose acceptance artifacts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-harness-audit-frontier-"));
  try {
    const home = join(dir, "home");
    const oldHome = process.env.RUNOFF_HOME;
    process.env.RUNOFF_HOME = home;
    try {
      const candidate = createHarnessCandidate({
        candidateId: "cli-audit",
        summary: "audit candidate",
        editableSurface: ["skill/"],
      });
      mkdirSync(join(candidate.variant.variantDir, "skill"), { recursive: true });
      writeFileSync(join(candidate.variant.variantDir, "skill", "SKILL.md"), "updated", "utf-8");
      const record = loadHarnessCandidate("cli-audit")!;
      const proposal = {
        schema: record.schema,
        candidateId: "cli-audit",
        proposedAt: "2026-06-20T00:00:00.000Z",
        provider: "test",
        model: "test-model",
        prompt: "test",
        summary: "clean",
        filesModified: ["skill/SKILL.md"],
        diffStat: "1 file changed",
        failed: false,
        surfaceViolations: [],
        observedFilesModified: ["skill/SKILL.md"],
        observedDiffStat: "1 files changed",
        unreportedFilesModified: [],
        reportedButUnchangedFiles: [],
        failureSignatureIds: [],
      };
      writeFileSync(
        join(home, "harness-evolution", "candidates", "cli-audit", "candidate.json"),
        JSON.stringify({ ...record, proposal }, null, 2),
        "utf-8",
      );
    } finally {
      if (oldHome !== undefined) process.env.RUNOFF_HOME = oldHome;
      else delete process.env.RUNOFF_HOME;
    }

    const audit = spawn("npx", ["tsx", CLI, "harness", "audit", "cli-audit", "--home", home, "--json"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let auditStdout = "";
    let auditStderr = "";
    audit.stdout?.on("data", (d) => { auditStdout += d.toString(); });
    audit.stderr?.on("data", (d) => { auditStderr += d.toString(); });
    const auditCode = await new Promise<number>((resolve, reject) => {
      audit.on("error", reject);
      audit.on("close", (x) => resolve(x ?? 1));
    });
    assert.equal(auditCode, 0, auditStderr);
    const auditBody = JSON.parse(auditStdout) as { audit: { passed: boolean; checkedFiles: string[] } };
    assert.equal(auditBody.audit.passed, true);
    assert.deepEqual(auditBody.audit.checkedFiles, ["skill/SKILL.md"]);

    const frontier = spawn("npx", ["tsx", CLI, "harness", "frontier", "--frontier-id", "cli-frontier", "--home", home, "--json"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let frontierStdout = "";
    let frontierStderr = "";
    frontier.stdout?.on("data", (d) => { frontierStdout += d.toString(); });
    frontier.stderr?.on("data", (d) => { frontierStderr += d.toString(); });
    const frontierCode = await new Promise<number>((resolve, reject) => {
      frontier.on("error", reject);
      frontier.on("close", (x) => resolve(x ?? 1));
    });
    assert.equal(frontierCode, 0, frontierStderr);
    const frontierBody = JSON.parse(frontierStdout) as { frontier: { frontierId: string; entries: Array<{ candidateId: string; auditPassed: boolean }> } };
    assert.equal(frontierBody.frontier.frontierId, "cli-frontier");
    assert.equal(frontierBody.frontier.entries[0]?.candidateId, "cli-audit");
    assert.equal(frontierBody.frontier.entries[0]?.auditPassed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline-cli harness run report and runs expose orchestrated run state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-harness-run-"));
  try {
    const home = join(dir, "home");
    const config: PipelineConfig = {
      providers: { mock: { type: "mock" } },
      pipeline: { implement: ["mock"] },
      orchestration: { mode: "dag", plannerProvider: "mock" },
    };
    const configPath = join(dir, "pipeline.config.json");
    writeFileSync(configPath, JSON.stringify(config), "utf-8");
    const oldHome = process.env.RUNOFF_HOME;
    process.env.RUNOFF_HOME = home;
    try {
      recordTrace(trace("cli-run-base-a", { finalStatus: "failed", timestamp: "2026-06-20T00:00:01.000Z" }));
      recordTrace(trace("cli-run-base-b", { totalDurationMs: 2000, timestamp: "2026-06-20T00:00:02.000Z" }));
    } finally {
      if (oldHome !== undefined) process.env.RUNOFF_HOME = oldHome;
      else delete process.env.RUNOFF_HOME;
    }

    const run = spawn("npx", [
      "tsx",
      CLI,
      "harness",
      "run",
      "--run-id",
      "cli-run",
      "--candidate-id",
      "cli-run-candidate",
      "--dataset-id",
      "cli-run-dataset",
      "--summary",
      "cli orchestrated run",
      "--trace-ids-json",
      "[\"cli-run-base-a\",\"cli-run-base-b\"]",
      "--editable-surface-json",
      "[\"skill/\"]",
      "--config",
      configPath,
      "--home",
      home,
      "--json",
    ], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let runStdout = "";
    let runStderr = "";
    run.stdout?.on("data", (d) => { runStdout += d.toString(); });
    run.stderr?.on("data", (d) => { runStderr += d.toString(); });
    const runCode = await new Promise<number>((resolve, reject) => {
      run.on("error", reject);
      run.on("close", (x) => resolve(x ?? 1));
    });
    assert.equal(runCode, 0, runStderr);
    const runBody = JSON.parse(runStdout) as { run: { runId: string; status: string; missingCandidateTraceIds: string[] } };
    assert.equal(runBody.run.runId, "cli-run");
    assert.equal(runBody.run.status, "awaiting_candidate_traces");
    assert.deepEqual(runBody.run.missingCandidateTraceIds, ["cli-run-base-a", "cli-run-base-b"]);

    const report = spawn("npx", ["tsx", CLI, "harness", "report", "cli-run", "--home", home, "--json"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let reportStdout = "";
    let reportStderr = "";
    report.stdout?.on("data", (d) => { reportStdout += d.toString(); });
    report.stderr?.on("data", (d) => { reportStderr += d.toString(); });
    const reportCode = await new Promise<number>((resolve, reject) => {
      report.on("error", reject);
      report.on("close", (x) => resolve(x ?? 1));
    });
    assert.equal(reportCode, 0, reportStderr);
    const reportBody = JSON.parse(reportStdout) as { report: { runId: string; status: string; nextAction: string } };
    assert.equal(reportBody.report.runId, "cli-run");
    assert.equal(reportBody.report.status, "awaiting_candidate_traces");
    assert.match(reportBody.report.nextAction, /provide candidateTraceIdsByBaseline/);

    const runs = spawn("npx", ["tsx", CLI, "harness", "runs", "--home", home, "--json"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let runsStdout = "";
    let runsStderr = "";
    runs.stdout?.on("data", (d) => { runsStdout += d.toString(); });
    runs.stderr?.on("data", (d) => { runsStderr += d.toString(); });
    const runsCode = await new Promise<number>((resolve, reject) => {
      runs.on("error", reject);
      runs.on("close", (x) => resolve(x ?? 1));
    });
    assert.equal(runsCode, 0, runsStderr);
    const runsBody = JSON.parse(runsStdout) as { count: number; runs: Array<{ runId: string }> };
    assert.equal(runsBody.count, 1);
    assert.equal(runsBody.runs[0]?.runId, "cli-run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline-cli harness export writes accepted promotion bundle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-harness-export-"));
  try {
    const home = join(dir, "home");
    const oldHome = process.env.RUNOFF_HOME;
    process.env.RUNOFF_HOME = home;
    try {
      const candidate = createHarnessCandidate({
        candidateId: "cli-export",
        summary: "export accepted candidate",
        editableSurface: ["skill/"],
      });
      mkdirSync(join(candidate.variant.variantDir, "skill"), { recursive: true });
      writeFileSync(join(candidate.variant.variantDir, "skill", "SKILL.md"), "updated", "utf-8");
      const record = loadHarnessCandidate("cli-export")!;
      const proposal = {
        schema: record.schema,
        candidateId: "cli-export",
        proposedAt: "2026-06-20T00:00:00.000Z",
        provider: "test",
        model: "test-model",
        prompt: "test",
        summary: "clean",
        filesModified: ["skill/SKILL.md"],
        diffStat: "1 file changed",
        failed: false,
        surfaceViolations: [],
        observedFilesModified: ["skill/SKILL.md"],
        observedDiffStat: "1 files changed",
        unreportedFilesModified: [],
        reportedButUnchangedFiles: [],
        failureSignatureIds: [],
      };
      writeFileSync(
        join(home, "harness-evolution", "candidates", "cli-export", "candidate.json"),
        JSON.stringify({ ...record, proposal }, null, 2),
        "utf-8",
      );
      recordTrace(trace("cli-export-base-in", { finalStatus: "failed" }));
      recordTrace(trace("cli-export-cand-in", { finalStatus: "approved" }));
      recordTrace(trace("cli-export-base-out", { totalDurationMs: 2000 }));
      recordTrace(trace("cli-export-cand-out", { totalDurationMs: 1000 }));
      evaluateHarnessCandidate({
        candidateId: "cli-export",
        pairs: [
          { split: "held-in", baselineTraceId: "cli-export-base-in", candidateTraceId: "cli-export-cand-in" },
          { split: "held-out", baselineTraceId: "cli-export-base-out", candidateTraceId: "cli-export-cand-out" },
        ],
      });
      auditHarnessCandidate({ candidateId: "cli-export" });
      decideHarnessCandidate({ candidateId: "cli-export" });
    } finally {
      if (oldHome !== undefined) process.env.RUNOFF_HOME = oldHome;
      else delete process.env.RUNOFF_HOME;
    }

    const child = spawn("npx", ["tsx", CLI, "harness", "export", "cli-export", "--home", home, "--json"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (x) => resolve(x ?? 1));
    });

    assert.equal(code, 0, stderr);
    const body = JSON.parse(stdout) as { bundle: { candidateId: string; bundleDir: string; files: Array<{ copied: boolean }> } };
    assert.equal(body.bundle.candidateId, "cli-export");
    assert.equal(body.bundle.files[0]?.copied, true);
    assert.equal(existsSync(join(body.bundle.bundleDir, "bundle.json")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
