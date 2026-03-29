import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(join(__dirname, ".."));
const testRepo = resolve(join(__dirname, "../tmp/test-repo-lock"));
const lockHome = resolve(join(__dirname, "../tmp/concurrency-lock-pipeline-home"));

/** One Python process + multiprocessing — avoids cross-subprocess kill(0) quirks vs Node-spawned siblings. */
const MULTIPROCESS_PROBE = `import multiprocessing as mp
import os
import sys
import time

repo_root = os.environ["REPO_ROOT"]
repo = os.environ["TEST_REPO"]
os.environ["LLM_PIPELINE_HOME"] = os.environ["LOCK_HOME"]
sys.path.insert(0, repo_root)

from scripts.workspace_manager import RepoLock  # noqa: E402


def exclusive_holder(path: str, q: mp.Queue) -> None:
    sys.path.insert(0, repo_root)
    os.environ["LLM_PIPELINE_HOME"] = os.environ["LOCK_HOME"]
    r = RepoLock(path, None)
    r.acquire(os.getpid(), timeout=30)
    q.put("ready")
    time.sleep(8)
    r.release(os.getpid())


def shared_holder(path: str, key: str, q: mp.Queue) -> None:
    sys.path.insert(0, repo_root)
    os.environ["LLM_PIPELINE_HOME"] = os.environ["LOCK_HOME"]
    r = RepoLock(path, key)
    r.acquire(os.getpid(), timeout=30)
    q.put("ready")
    time.sleep(8)
    r.release(os.getpid())


def main() -> None:
    ctx = mp.get_context("spawn")
    q: mp.Queue = ctx.Queue()
    p = ctx.Process(target=exclusive_holder, args=(repo, q))
    p.start()
    assert q.get(timeout=20) == "ready"
    parent = RepoLock(repo, None)
    try:
        parent.acquire(os.getpid(), timeout=5)
        print("EXCLUSIVE_FAIL_BOTH_ACQUIRED")
        sys.exit(1)
    except RuntimeError as e:
        if "Repository is locked" not in str(e):
            raise
        print("EXCLUSIVE_OK")
    p.join(timeout=12)
    if p.exitcode not in (0, None):
        print("EXCLUSIVE_CHILD_BAD_EXIT", p.exitcode)
        sys.exit(1)

    shared_key = "agent-collab-123"
    q2: mp.Queue = ctx.Queue()
    p2 = ctx.Process(target=shared_holder, args=(repo, shared_key, q2))
    p2.start()
    assert q2.get(timeout=20) == "ready"
    r3 = RepoLock(repo, shared_key)
    r3.acquire(os.getpid(), timeout=30)
    print("SHARED_OK")
    r3.release(os.getpid())
    p2.join(timeout=12)
    if p2.exitcode not in (0, None):
        print("SHARED_CHILD_BAD_EXIT", p2.exitcode)
        sys.exit(1)


if __name__ == "__main__":
    main()
`;

test("RepoLock - P0: Strict Exclusion by Default", (t) => {
  if (existsSync(testRepo)) rmSync(testRepo, { recursive: true });
  mkdirSync(testRepo, { recursive: true });
  mkdirSync(lockHome, { recursive: true });

  const probePath = resolve(join(__dirname, "../tmp/repo_lock_mp_probe.py"));
  mkdirSync(dirname(probePath), { recursive: true });
  writeFileSync(probePath, MULTIPROCESS_PROBE, "utf-8");

  t.test("exclusive vs second holder; then shared same key", () => {
    const r = spawnSync("python3", [probePath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        PYTHONPATH: repoRoot,
        REPO_ROOT: repoRoot,
        TEST_REPO: testRepo,
        LOCK_HOME: lockHome,
      },
    });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    assert.equal(r.status, 0, out);
    assert.match(out, /EXCLUSIVE_OK/);
    assert.match(out, /SHARED_OK/);
    assert.ok(!out.includes("EXCLUSIVE_FAIL_BOTH_ACQUIRED"));
  });
});
