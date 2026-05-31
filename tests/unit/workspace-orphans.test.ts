import assert from "node:assert/strict";
import { mkdirSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  cleanupOrphanWorkspaces,
  scanOrphanWorkspaces,
} from "../../src/pipeline/workspace-orphans.js";

test("scanOrphanWorkspaces lists session-* dirs not in activeWorkspaces", () => {
  const home = mkdtempSync(join(tmpdir(), "lp-orphan-"));
  const wsDir = join(home, "workspaces");
  const orphanPath = join(wsDir, "session-deadbeef");
  mkdirSync(orphanPath, { recursive: true });

  const orphans = scanOrphanWorkspaces({ homeDir: home });
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0]!.name, "session-deadbeef");
  assert.equal(orphans[0]!.path, orphanPath);

  const { removed } = cleanupOrphanWorkspaces(orphans);
  assert.equal(removed, 1);
  assert.equal(existsSync(orphanPath), false);

  rmSync(home, { recursive: true, force: true });
});
