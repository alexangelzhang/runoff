import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  parseMfsSearchOutput,
  readLocalContextExcerpt,
} from "../../src/orchestration/mfs-context-bridge.ts";

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
