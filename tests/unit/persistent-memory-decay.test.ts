import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentId } from "../../src/orchestration/multi-agent-types.ts";
import { PersistentAgentMemory } from "../../src/orchestration/persistent-memory.ts";
import { DEFAULT_MEMORY_HALF_LIFE_MS } from "../../src/orchestration/memory-decay.ts";

test("PersistentAgentMemory ranks fresher entries higher with decay", () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-mem-decay-"));
  try {
    const memory = new PersistentAgentMemory(dir);
    const aid = agentId("test-agent");
    const fresh = memory.store({
      agentId: aid,
      scope: { project: "p" },
      category: "note",
      content: "fresh",
      relevance: 1,
    });
    const stale = memory.store({
      agentId: aid,
      scope: { project: "p" },
      category: "note",
      content: "stale",
      relevance: 1,
    });

    const stalePath = join(dir, `${stale.id}.json`);
    const raw = JSON.parse(readFileSync(stalePath, "utf-8")) as { createdAt: number };
    raw.createdAt = Date.now() - DEFAULT_MEMORY_HALF_LIFE_MS * 2;
    writeFileSync(stalePath, JSON.stringify(raw));

    const reloaded = new PersistentAgentMemory(dir);
    const ranked = reloaded.retrieve({ agentId: aid, limit: 2 });
    assert.equal(ranked[0]?.id, fresh.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
