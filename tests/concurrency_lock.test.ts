import { test } from "node:test";
import assert from "node:assert";
import { spawnSync, spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const testRepo = join(__dirname, "../tmp/test-repo-lock");

test("RepoLock - P0: Strict Exclusion by Default", async (t) => {
  if (existsSync(testRepo)) rmSync(testRepo, { recursive: true });
  mkdirSync(testRepo, { recursive: true });

  const lockScript = `
import sys
import os
import time
# Add repo root to path to ensure scripts module is found
sys.path.insert(0, os.getcwd())
from scripts.workspace_manager import RepoLock

repo = sys.argv[1]
key = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != "None" else None
lock = RepoLock(repo, shared_lock_key=key)

try:
    if lock.acquire(os.getpid(), timeout=2):
        print("LOCKED", flush=True)
        time.sleep(5) 
        lock.release(os.getpid())
    else:
        print("FAILED", flush=True)
except Exception as e:
    print(f"ERROR: {str(e)}", flush=True)
    sys.exit(1)
`;

  const scriptPath = join(__dirname, "../tmp/lock_helper.py");
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, lockScript);

  await t.test("Two sessions without shared key should NOT overlap", async () => {
    // Session 1: Exclusive lock
    // Wave 5 Fix: Use -u for unbuffered output to avoid test hang
    const p1 = spawn("python3", ["-u", scriptPath, testRepo, "None"], {
      cwd: repoRoot,
      env: { ...process.env, PYTHONPATH: repoRoot }
    });

    let p1Locked = false;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout waiting for p1 LOCKED")), 10000);
      p1.stdout.on("data", (data) => {
        if (data.toString().includes("LOCKED")) {
          p1Locked = true;
          clearTimeout(timeout);
          resolve(true);
        }
      });
      p1.on("error", reject);
      p1.stderr.on("data", (d) => console.error(`p1 stderr: ${d}`));
    });

    assert.ok(p1Locked, "Session 1 should have acquired the lock");

    // Session 2: Try to steal (should fail)
    const p2 = spawnSync("python3", ["-u", scriptPath, testRepo, "None"], {
      cwd: repoRoot,
      env: { ...process.env, PYTHONPATH: repoRoot }
    });

    const output = p2.stdout.toString() + p2.stderr.toString();
    assert.match(output, /Repository is locked by another session/, "Should report repo is locked");
    
    p1.kill();
  });

  await t.test("Two sessions with SAME shared key SHOULD overlap", async () => {
    const key = "agent-collab-123";
    
    // Session 1: Shared lock
    const p1 = spawn("python3", ["-u", scriptPath, testRepo, key], {
      cwd: repoRoot,
      env: { ...process.env, PYTHONPATH: repoRoot }
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout waiting for LOCKED")), 10000);
      p1.stdout.on("data", (data) => {
        if (data.toString().includes("LOCKED")) {
          clearTimeout(timeout);
          resolve(true);
        }
      });
      p1.stderr.on("data", (d) => console.error(`p1 shared stderr: ${d}`));
    });

    // Session 2: Shared lock with same key (should succeed)
    const p2 = spawnSync("python3", ["-u", scriptPath, testRepo, key], {
      cwd: repoRoot,
      env: { ...process.env, PYTHONPATH: repoRoot }
    });

    assert.match(p2.stdout.toString(), /LOCKED/, "Should be able to share the lock with same key");
    
    p1.kill();
  });
});
