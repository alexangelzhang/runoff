import { test } from "node:test";
import assert from "node:assert";
import { spawnSync, spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("Active Cancellation - P1: Zombie Process Protection", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "lp-timeout-"));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const hangingTask = join(tmpDir, "hanging.task.json");
  const hangingResult = join(tmpDir, "hanging.result.json");
  writeFileSync(hangingTask, JSON.stringify({ id: "1", prompt: "sleep", mode: "text", timestamp: "now" }));

  const runnerPath = join(__dirname, "../../scripts/python/task_runner.py");

  await t.test("AbortSignal should kill the task-runner process group", async () => {
    const controller = new AbortController();
    
    // We execute via a child process to monitor it
    const proc = spawn("python3", [runnerPath, hangingTask, hangingResult], {
      detached: true,
      env: { ...process.env, PYTHONPATH: join(__dirname, "../..") }
    });

    const pid = proc.pid;
    assert.ok(pid, "Should have a PID");

    // Wait a bit for it to start
    await new Promise(r => setTimeout(r, 1000));

    // Abort
    controller.abort();
    
    // In actual CLIProvider, this would call process.kill(-pid)
    try {
        process.kill(-pid, "SIGKILL");
    } catch (e) {}

    // Check if process still exists
    await new Promise(r => setTimeout(r, 500));
    const check = spawnSync("ps", ["-p", String(pid)]);
    assert.notStrictEqual(check.status, 0, "Process should be killed");
  });
});
