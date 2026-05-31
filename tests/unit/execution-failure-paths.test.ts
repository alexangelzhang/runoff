import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseTaskResult } from "../../src/core/ipc.js";
import { TASK_PAYLOAD_SCHEMA_VERSION } from "../../src/core/ipc.js";
import { executeCliRunnerTask } from "../../src/providers/cli.ts";

test("parseTaskResult rejects garbage JSON shape", () => {
  assert.throws(() => parseTaskResult({ foo: 1 }), /Invalid TaskResult schema/i);
});

test("parseTaskResult rejects wrong status enum", () => {
  assert.throws(
    () =>
      parseTaskResult({
        id: "x",
        status: "pending",
        schemaVersion: 5,
        usage: { promptTokens: 0, completionTokens: 0 },
      }),
    /Invalid TaskResult schema/i
  );
});

function verifyPythonParsing(className: string, jsonData: unknown): { status: string; message?: string } {
  const script = `
import sys, json, os
sys.path.insert(0, os.path.join(".", "scripts", "python"))
from task_runner import ${className}
try:
    data = json.loads(sys.argv[1])
    obj = ${className}.from_dict(data)
    print(json.dumps({"status": "ok"}))
except Exception as e:
    print(json.dumps({"status": "error", "message": str(e)}))
`;
  const out = execFileSync("python3", ["-c", script, JSON.stringify(jsonData)], {
    encoding: "utf-8",
    cwd: process.cwd(),
  });
  return JSON.parse(out.trim()) as { status: string; message?: string };
}

test("Python TaskPayload rejects invalid delegateArgv type", () => {
  const r = verifyPythonParsing("TaskPayload", {
    id: "1",
    prompt: "p",
    mode: "text",
    timestamp: new Date().toISOString(),
    schemaVersion: TASK_PAYLOAD_SCHEMA_VERSION,
    delegateArgv: "not-an-array",
  });
  assert.equal(r.status, "error");
  assert.match(r.message ?? "", /delegateArgv/i);
});

test("task_runner execute_oneshot with delegateArgv returns delegate stdout (text mode)", () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-delegate-"));
  const taskFile = join(dir, "t.task.json");
  const resultFile = join(dir, "t.result.json");
  const payload = {
    id: "d1",
    prompt: "fallback",
    mode: "text",
    timestamp: new Date().toISOString(),
    schemaVersion: TASK_PAYLOAD_SCHEMA_VERSION,
    delegateArgv: ["python3", "-c", "import sys; print(sys.stdin.read())"],
    system: "OUT_FROM_STDIN",
  };
  writeFileSync(taskFile, JSON.stringify(payload));
  execFileSync("python3", ["scripts/python/task_runner.py", taskFile, resultFile], {
    cwd: process.cwd(),
    encoding: "utf-8",
  });
  const result = parseTaskResult(JSON.parse(readFileSync(resultFile, "utf-8")));
  assert.equal(result.status, "success");
  assert.ok(result.content.includes("OUT_FROM_STDIN"), `got ${result.content}`);
  rmSync(dir, { recursive: true, force: true });
});

test("executeCliRunnerTask rejects when runner exits without result file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-no-result-"));
  const taskFile = join(dir, "t.task.json");
  const resultFile = join(dir, "t.result.json");
  const exitScript = join(dir, "exit_only.py");
  writeFileSync(exitScript, "import sys\nsys.exit(3)\n");
  writeFileSync(
    taskFile,
    JSON.stringify({
      id: "nr1",
      prompt: "p",
      mode: "text",
      timestamp: new Date().toISOString(),
      schemaVersion: TASK_PAYLOAD_SCHEMA_VERSION,
    }),
  );
  await assert.rejects(
    () => executeCliRunnerTask("python3", [exitScript, taskFile, resultFile], taskFile, resultFile, 10_000),
    /no result file/i,
  );
  assert.equal(existsSync(resultFile), false);
  rmSync(dir, { recursive: true, force: true });
});

test("executeCliRunnerTask aborts in-flight runner via AbortSignal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-abort-"));
  const taskFile = join(dir, "t.task.json");
  const resultFile = join(dir, "t.result.json");
  writeFileSync(
    taskFile,
    JSON.stringify({
      id: "ab1",
      prompt: "p",
      mode: "text",
      timestamp: new Date().toISOString(),
      schemaVersion: TASK_PAYLOAD_SCHEMA_VERSION,
      delegateArgv: ["python3", "-c", "import time; time.sleep(30)"],
    }),
  );
  const controller = new AbortController();
  const run = executeCliRunnerTask("python3", [], taskFile, resultFile, 8_000, controller.signal);
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(run, /aborted/i);
  rmSync(dir, { recursive: true, force: true });
});

test("parseTaskResult rejects empty object", () => {
  assert.throws(() => parseTaskResult({}), /Invalid TaskResult schema/i);
});

test("parseTaskResult rejects invalid status in on-disk result shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-bad-result-"));
  const resultFile = join(dir, "t.result.json");
  writeFileSync(
    resultFile,
    JSON.stringify({
      id: "bad1",
      status: "pending",
      schemaVersion: 5,
      usage: { promptTokens: 0, completionTokens: 0 },
    }),
  );
  const raw = JSON.parse(readFileSync(resultFile, "utf-8"));
  assert.throws(() => parseTaskResult(raw), /Invalid TaskResult schema/i);
  rmSync(dir, { recursive: true, force: true });
});

test("workspace_manager apply surfaces git apply failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-patch-fail-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "p@test"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "P"], { cwd: repo });
  writeFileSync(join(repo, "src", "f.txt"), "line1\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
  writeFileSync(join(repo, "src", "f.txt"), "conflict\n");
  const patchFile = join(dir, "bad.patch");
  writeFileSync(patchFile, "not a valid patch\n");
  let out = "";
  try {
    out = execFileSync(
      "python3",
      [
        "scripts/python/workspace_manager.py",
        "apply",
        "--repo",
        repo,
        "--patch-file",
        patchFile,
        "--owner-pid",
        String(process.pid),
      ],
      { encoding: "utf-8", cwd: process.cwd() },
    );
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "stdout" in err) {
      out = String((err as { stdout?: unknown }).stdout ?? "");
    } else {
      throw err;
    }
  }
  const last = out.trim().split("\n").pop() ?? "";
  const parsed = JSON.parse(last) as { error?: string };
  assert.ok(parsed.error, `expected error JSON, got ${last}`);
  rmSync(dir, { recursive: true, force: true });
});
