import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { startConfigEditorServer } from "../../src/pipeline/config-editor-server.js";

const baseConfig = {
  providers: { mock: { type: "mock" } },
  pipeline: { implement: ["mock"] },
  retry: { maxRounds: 1 },
};

test("config editor server POST /api/save persists pipeline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-editor-srv-"));
  const configPath = join(dir, "pipeline.config.json");
  writeFileSync(configPath, JSON.stringify(baseConfig, null, 2));

  const handle = await startConfigEditorServer({ configPath, port: 0 });
  try {
    const fullConfig = JSON.parse(readFileSync(configPath, "utf-8")) as {
      providers: Record<string, unknown>;
      pipeline: Record<string, unknown>;
      retry: { maxRounds: number; reviewStep?: string };
      routing: unknown[];
    };
    fullConfig.pipeline = {
      plan: ["mock"],
      implement: ["mock", "plan"],
    };
    fullConfig.retry = { maxRounds: 2, reviewStep: "review" };

    const res = await fetch(`${handle.url}/api/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: fullConfig }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; configPath?: string };
    assert.equal(body.ok, true);

    const onDisk = JSON.parse(readFileSync(configPath, "utf-8")) as {
      pipeline: Record<string, unknown>;
      retry: { maxRounds: number };
    };
    assert.ok(onDisk.pipeline.plan);
    assert.ok(onDisk.pipeline.implement);
    assert.equal(onDisk.retry.maxRounds, 2);

    const page = await fetch(handle.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Save to config/);
    assert.match(html, /panelProviders/);
    assert.match(html, /__lpSaveUrl/);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
