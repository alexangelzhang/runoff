import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "scripts", "ts", "dev", "pipeline-cli.ts");

test("pipeline-cli --help exits 0", async () => {
  const code = await new Promise<number>((resolve, reject) => {
    const c = spawn("npx", ["tsx", CLI, "--help"], { cwd: ROOT, stdio: "ignore" });
    c.on("error", reject);
    c.on("close", (x) => resolve(x ?? 1));
  });
  assert.equal(code, 0);
});

test("pipeline-cli run requires --work-dir", async () => {
  const child = spawn("npx", ["tsx", CLI, "run", "--prompt", "test"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d) => { stderr += d.toString(); });
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (x) => resolve(x ?? 1));
  });
  assert.notEqual(code, 0);
  assert.match(stderr, /work-dir/i);
});

test("examples/cli.config.json exists", () => {
  assert.ok(existsSync(join(ROOT, "examples", "cli.config.json")));
});
