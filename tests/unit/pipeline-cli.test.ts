import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createControlPlane } from "../../src/orchestration/control-plane.ts";
import { syncRunStoreFromPipeline } from "../../src/orchestration/run-control.ts";
import type { PipelineConfig } from "../../src/core/config.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "scripts", "ts", "dev", "pipeline-cli.ts");

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
