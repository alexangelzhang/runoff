import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("npm run demo completes with approved mock pipeline", { timeout: 60_000 }, async () => {
  const child = spawn("npm", ["run", "demo"], {
    cwd: ROOT,
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (c) => { stdout += c.toString(); });
  child.stderr?.on("data", (c) => { stderr += c.toString(); });

  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (c) => resolve(c ?? 1));
  });

  if (code !== 0) {
    console.error(stderr);
  }
  assert.equal(code, 0);
  assert.match(stdout, /finalStatus:\s+approved/);
  assert.match(stdout, /experiment rows:\s+[1-9]/);
});

test("examples/configs/quickstart.config.json exists", () => {
  assert.ok(existsSync(join(ROOT, "examples", "configs", "quickstart.config.json")));
});
