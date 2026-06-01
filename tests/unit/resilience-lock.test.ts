import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(join(__dirname, "../.."));
const lockHome = resolve(join(__dirname, "../../tmp/resilience-lock-pipeline-home"));
const repoPath = resolve(join(__dirname, "../../tmp/resilience-lock-test-repo"));

const LOCK_HELPER = String.raw`
import os
import sys
import time

repo_root = sys.argv[1]
repo = sys.argv[2]
hold_seconds = float(sys.argv[3])
lock_home = sys.argv[4]

os.environ["RUNOFF_HOME"] = lock_home
sys.path.insert(0, os.path.join(repo_root, "scripts", "python"))

from workspace_manager import RepoLock  # noqa: E402

lock = RepoLock(repo, None)
lock.acquire(os.getpid(), timeout=30)
print("LOCKED", flush=True)
time.sleep(hold_seconds)
lock.release(os.getpid())
print("RELEASED", flush=True)
`;

test("Resilience: Lock Contention & Backoff", async (t) => {
  if (existsSync(lockHome)) rmSync(lockHome, { recursive: true, force: true });
  if (existsSync(repoPath)) rmSync(repoPath, { recursive: true, force: true });
  mkdirSync(lockHome, { recursive: true });
  mkdirSync(repoPath, { recursive: true });

  await t.test("Should handle 5 simultaneous lock requests via exponential backoff", async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => {
      return new Promise<{ id: number; success: boolean; out: string }>((resolve) => {
        const proc = spawn(
          "python3",
          ["-c", LOCK_HELPER, repoRoot, repoPath, "1.2", lockHome],
          {
            cwd: repoRoot,
            env: {
              ...process.env,
              PYTHONPATH: repoRoot,
              RUNOFF_HOME: lockHome,
            },
          },
        );

        let out = "";
        proc.stdout.on("data", (d) => {
          out += d;
        });
        proc.stderr.on("data", (d) => {
          out += d;
        });

        proc.on("exit", (code) => {
          resolve({ id: i, success: code === 0, out });
        });
      });
    });

    const results = await Promise.all(tasks);
    const failures = results.filter((result) => !result.success);

    assert.equal(
      failures.length,
      0,
      `All 5 should eventually get the lock. Fails: ${failures.map((result) => result.out).join("\n")}`,
    );
    assert.equal(
      results.filter((result) => result.out.includes("LOCKED")).length,
      5,
      `Expected every worker to acquire the lock once. Outputs: ${results.map((result) => result.out).join(" | ")}`,
    );
  });
});
