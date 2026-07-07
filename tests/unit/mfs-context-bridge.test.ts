import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  parseMfsSearchOutput,
  readLocalContextExcerpt,
} from "../../src/orchestration/mfs-context-bridge.ts";
import {
  createHarnessContextTopology,
  resolveHarnessContextRoute,
  routeHarnessContext,
} from "../../src/orchestration/harness-operating-layer.ts";

test("parseMfsSearchOutput extracts refs from JSON hits", () => {
  const stdout = JSON.stringify([
    { uri: "mfs://repo/src/a.ts", score: 0.91, snippet: "export function a()" },
    { path: "./docs/readme.md", snippet: "# Title" },
  ]);
  const hits = parseMfsSearchOutput(stdout);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]?.ref, "mfs://repo/src/a.ts");
  assert.equal(hits[1]?.ref, "./docs/readme.md");
});

test("parseMfsSearchOutput compacts inline search hit arrays", () => {
  const stdout = JSON.stringify([{ uri: "mfs://repo/x.ts" }, { uri: "mfs://repo/y.ts" }]);
  const hits = parseMfsSearchOutput(stdout);
  assert.equal(hits.length, 2);
});

test("readLocalContextExcerpt reads file with line range", () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-mfs-bridge-"));
  const file = join(dir, "sample.ts");
  writeFileSync(file, ["line1", "line2", "line3", "line4", "line5"].join("\n"), "utf-8");
  const { excerpt, error } = readLocalContextExcerpt(`${file}:2-3`, { workDir: dir });
  assert.ifError(error);
  assert.match(excerpt ?? "", /line2/);
  assert.match(excerpt ?? "", /line3/);
  assert.doesNotMatch(excerpt ?? "", /line4/);
});

test("resolveHarnessContextRoute resolves local file refs from route", () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-route-resolve-"));
  const oldHome = process.env.RUNOFF_HOME;
  process.env.RUNOFF_HOME = join(dir, "home");
  const workDir = join(dir, "repo");
  const coreDir = join(workDir, "src/core");
  mkdirSync(coreDir, { recursive: true });
  const file = join(coreDir, "unsafe.ts");
  writeFileSync(file, "export const unsafe = true;\n", "utf-8");

  try {
    const topology = createHarnessContextTopology({
      topologyId: "topo-resolve",
      summary: "test",
      nodes: [
        {
          nodeId: "file:unsafe",
          kind: "file",
          ref: "src/core/unsafe.ts",
          summary: "unsafe module",
          tags: ["core"],
          priority: 90,
        },
      ],
    });
    const route = routeHarnessContext({
      routeId: "route-resolve-local",
      topologyId: topology.topologyId,
      changedFiles: ["src/core/unsafe.ts"],
      limit: 3,
    });

    const resolution = resolveHarnessContextRoute({
      routeId: route.routeId,
      workDir,
      limit: 3,
    });

    assert.equal(resolution.routeId, "route-resolve-local");
    assert.ok(resolution.contextRefs.some((ref) => ref.ref.includes("unsafe.ts")));
    assert.ok(resolution.items.some((item) => item.excerpt?.includes("unsafe")));
    assert.match(resolution.promptBlock, /Harness context route/);
    assert.equal(resolution.omittedRawPayload, true);
  } finally {
    if (oldHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = oldHome;
  }
});
