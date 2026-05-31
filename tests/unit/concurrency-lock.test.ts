import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(join(__dirname, "../.."));
const probePath = resolve(join(__dirname, "../fixtures/lock/repo_lock_mp_probe.py"));

test("RepoLock - P0: Strict Exclusion by Default", (t) => {
  const testRepo = mkdtempSync(join(tmpdir(), "lp-lock-repo-"));
  const lockHome = mkdtempSync(join(tmpdir(), "lp-lock-home-"));

  t.after(() => {
    rmSync(testRepo, { recursive: true, force: true });
    rmSync(lockHome, { recursive: true, force: true });
  });

  mkdirSync(testRepo, { recursive: true });

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
