import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyRaceSession } from "../../src/runtime/race-finalize.ts";
import { getRaceSession, saveRaceSession, raceSessions } from "../../src/runtime/race-registry.ts";

const WINNER_PATCH = `diff --git a/foo.txt b/foo.txt
new file mode 100644
index 0000000..ce01362
--- /dev/null
+++ b/foo.txt
@@ -0,0 +1 @@
+hello
`;

function initGitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "race-finalize-repo-"));
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@test"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
  writeFileSync(join(repo, "README"), "init\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

let home: string;
let origHome: string | undefined;

test.beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "race-finalize-home-"));
  origHome = process.env.LLM_PIPELINE_HOME;
  process.env.LLM_PIPELINE_HOME = home;
  raceSessions.clear();
});

test.afterEach(() => {
  if (origHome !== undefined) process.env.LLM_PIPELINE_HOME = origHome;
  else delete process.env.LLM_PIPELINE_HOME;
  rmSync(home, { recursive: true, force: true });
  raceSessions.clear();
});

test("applyRaceSession throws when trace persist fails and clears session", async () => {
  const repo = initGitRepo();
  try {
    saveRaceSession({
      traceId: "race-no-trace",
      applyTargetPath: repo,
      candidates: [{ providerName: "p1", patchText: WINNER_PATCH }],
      createdAt: Date.now(),
    });

    await assert.rejects(
      () => applyRaceSession("race-no-trace", 0),
      /trace persist failed/i,
    );
    assert.equal(getRaceSession("race-no-trace"), undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
