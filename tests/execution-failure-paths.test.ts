import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseTaskResult } from "../src/ipc.js";
import { TASK_PAYLOAD_SCHEMA_VERSION } from "../src/ipc.js";

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
import sys, json
sys.path.insert(0, ".")
from scripts.task_runner import ${className}
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
  execFileSync("python3", ["scripts/task_runner.py", taskFile, resultFile], {
    cwd: process.cwd(),
    encoding: "utf-8",
  });
  const result = parseTaskResult(JSON.parse(readFileSync(resultFile, "utf-8")));
  assert.equal(result.status, "success");
  assert.ok(result.content.includes("OUT_FROM_STDIN"), `got ${result.content}`);
  rmSync(dir, { recursive: true, force: true });
});
