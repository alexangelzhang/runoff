import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { A2AAgentCard } from "../../src/experimental/a2a/agent-card.ts";
import { mergeAgentCardCrdt } from "../../src/experimental/a2a/federation-crdt.ts";
import { appendLeaseAuditEvent } from "../../src/experimental/a2a/federation-lease-audit.ts";
import { configureSkillDepPruneStrategyAuditStore } from "../../src/experimental/a2a/federation-skill-deps-audit.ts";
import { appendSkillDepsPruneLog } from "../../src/experimental/a2a/federation-skill-deps-log.ts";
import { persistFederatedAgentCards } from "../../src/experimental/a2a/federated-registry-store.ts";
import {
  configureSkillDepPruneStrategyRollback,
  isSkillDepPruneStrategyRollbackEnabled,
  setAgentSkillDepPruneStrategy,
  skillDepRef,
} from "../../src/experimental/a2a/federation-skill-deps.ts";
import { HttpA2ATransport } from "../../src/experimental/a2a/http-transport.ts";

function card(agentId: string): A2AAgentCard {
  return {
    agentId,
    name: agentId,
    description: "",
    role: "worker",
    capabilities: ["text"],
    skills: [{ id: "s1", name: "s1" }],
    protocolVersion: "0.3",
    endpoint: `http://${agentId}`,
    metadata: { federationUpdatedAt: "2026-01-01T00:00:00.000Z" },
  };
}

test("GET /a2a/federation/skill-deps/prune-log returns prune log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-http-prune-"));
  const storePath = join(dir, "agents.json");
  try {
    appendSkillDepsPruneLog({
      source: "sync",
      pruned: [{ dependent: "a:s1", removedDep: skillDepRef("b", "s2") }],
      storePath,
    });
    const transport = new HttpA2ATransport({ federationPath: storePath });
    const { url } = await transport.start();
    const res = await fetch(`${url}/a2a/federation/skill-deps/prune-log`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { entries: unknown[]; totalEntries: number };
    assert.equal(body.totalEntries, 1);
    assert.equal(body.entries.length, 1);
    await transport.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /a2a/federation/skill-deps/prune-log filters by agentId", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-http-agent-"));
  const storePath = join(dir, "agents.json");
  try {
    appendSkillDepsPruneLog({
      source: "sync",
      pruned: [
        { dependent: skillDepRef("agent-a", "s1"), removedDep: skillDepRef("agent-b", "s2") },
        { dependent: skillDepRef("agent-c", "s3"), removedDep: skillDepRef("agent-d", "s4") },
      ],
      storePath,
    });
    const transport = new HttpA2ATransport({ federationPath: storePath });
    const { url } = await transport.start();
    const res = await fetch(`${url}/a2a/federation/skill-deps/prune-log?agentId=agent-a`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      entries: Array<{ pruned: unknown[] }>;
      agentFilter: string;
      totalEntries: number;
    };
    assert.equal(body.agentFilter, "agent-a");
    assert.equal(body.totalEntries, 1);
    assert.equal(body.entries[0]!.pruned.length, 1);
    await transport.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET prune-log filters by receiptId", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-http-receipt-"));
  const storePath = join(dir, "agents.json");
  try {
    const receipt = appendSkillDepsPruneLog({
      source: "sync",
      pruned: [{ dependent: "a:s1", removedDep: skillDepRef("b", "s2") }],
      storePath,
    });
    assert.ok(receipt);
    const transport = new HttpA2ATransport({ federationPath: storePath });
    const { url } = await transport.start();
    const res = await fetch(
      `${url}/a2a/federation/skill-deps/prune-log?receiptId=${encodeURIComponent(receipt!.receiptId)}`,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      entries: Array<{ receiptId: string }>;
      receiptFound: boolean;
    };
    assert.equal(body.receiptFound, true);
    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0]!.receiptId, receipt!.receiptId);
    await transport.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET prune-log and audit/log support format=ndjson", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-http-ndjson-"));
  const storePath = join(dir, "agents.json");
  try {
    appendSkillDepsPruneLog({
      source: "merge",
      pruned: [{ dependent: "a:s1", removedDep: skillDepRef("b", "s2") }],
      storePath,
    });
    appendLeaseAuditEvent({
      type: "acquire",
      nodeId: "n1",
      holderNodeId: "n1",
      term: 1,
      storePath,
    });
    const transport = new HttpA2ATransport({ federationPath: storePath });
    const { url } = await transport.start();
    const pruneRes = await fetch(`${url}/a2a/federation/skill-deps/prune-log?format=ndjson`);
    assert.equal(pruneRes.status, 200);
    assert.match(pruneRes.headers.get("content-type") ?? "", /ndjson/);
    const pruneBody = await pruneRes.text();
    assert.ok(pruneBody.trim().startsWith("{"));

    const auditRes = await fetch(`${url}/a2a/federation/lease/audit/log?format=ndjson`);
    assert.equal(auditRes.status, 200);
    assert.match(auditRes.headers.get("content-type") ?? "", /ndjson/);
    const auditBody = await auditRes.text();
    assert.ok(auditBody.includes('"type":"acquire"'));
    await transport.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET audit/log filters by type=skill_prune_strategy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-http-audit-type-"));
  const storePath = join(dir, "agents.json");
  try {
    appendLeaseAuditEvent({
      type: "acquire",
      nodeId: "n1",
      holderNodeId: "n1",
      term: 1,
      storePath,
    });
    configureSkillDepPruneStrategyAuditStore(storePath);
    const a = setAgentSkillDepPruneStrategy(
      { ...card("agent-a"), metadata: { federationUpdatedAt: "2026-06-01T00:00:00.000Z" } },
      "last-edge",
    );
    const b = setAgentSkillDepPruneStrategy(
      { ...card("agent-a"), metadata: { federationUpdatedAt: "2020-01-01T00:00:00.000Z" } },
      "min-edge",
    );
    mergeAgentCardCrdt(a, b);
    const transport = new HttpA2ATransport({ federationPath: storePath });
    const { url } = await transport.start();
    const res = await fetch(`${url}/a2a/federation/lease/audit/log?type=skill_prune_strategy`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { events: Array<{ type: string }>; typeFilter: string };
    assert.equal(body.typeFilter, "skill_prune_strategy");
    assert.ok(body.events.length >= 1);
    assert.ok(body.events.every((e) => e.type === "skill_prune_strategy"));
    await transport.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET audit/log filters by comma-separated types", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-http-audit-types-"));
  const storePath = join(dir, "agents.json");
  try {
    appendLeaseAuditEvent({
      type: "acquire",
      nodeId: "n1",
      holderNodeId: "n1",
      term: 1,
      storePath,
    });
    configureSkillDepPruneStrategyAuditStore(storePath);
    const older = setAgentSkillDepPruneStrategy(
      { ...card("agent-a"), metadata: { federationUpdatedAt: "2020-01-01T00:00:00.000Z" } },
      "last-edge",
    );
    const newer = setAgentSkillDepPruneStrategy(
      { ...card("agent-a"), metadata: { federationUpdatedAt: "2026-06-01T00:00:00.000Z" } },
      "min-edge",
    );
    mergeAgentCardCrdt(older, newer);
    const transport = new HttpA2ATransport({ federationPath: storePath });
    const { url } = await transport.start();
    const res = await fetch(
      `${url}/a2a/federation/lease/audit/log?type=acquire,skill_prune_strategy`,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      events: Array<{ type: string }>;
      typeFilter: string;
    };
    assert.equal(body.typeFilter, "acquire,skill_prune_strategy");
    assert.ok(body.events.some((e) => e.type === "acquire"));
    assert.ok(body.events.some((e) => e.type === "skill_prune_strategy"));
    assert.ok(body.events.every((e) => e.type === "acquire" || e.type === "skill_prune_strategy"));
    await transport.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET audit/log filters by exclude=acquire", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-http-audit-exclude-"));
  const storePath = join(dir, "agents.json");
  try {
    appendLeaseAuditEvent({
      type: "acquire",
      nodeId: "n1",
      holderNodeId: "n1",
      term: 1,
      storePath,
    });
    configureSkillDepPruneStrategyAuditStore(storePath);
    const older = setAgentSkillDepPruneStrategy(
      { ...card("agent-a"), metadata: { federationUpdatedAt: "2020-01-01T00:00:00.000Z" } },
      "last-edge",
    );
    const newer = setAgentSkillDepPruneStrategy(
      { ...card("agent-a"), metadata: { federationUpdatedAt: "2026-06-01T00:00:00.000Z" } },
      "min-edge",
    );
    mergeAgentCardCrdt(older, newer);
    const transport = new HttpA2ATransport({ federationPath: storePath });
    const { url } = await transport.start();
    const res = await fetch(`${url}/a2a/federation/lease/audit/log?exclude=acquire`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      events: Array<{ type: string }>;
      excludeFilter: string;
    };
    assert.equal(body.excludeFilter, "acquire");
    assert.ok(body.events.every((e) => e.type !== "acquire"));
    assert.ok(body.events.some((e) => e.type === "skill_prune_strategy"));
    await transport.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET prune-log returns emptyHint when agent filter matches nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-http-prune-empty-"));
  const storePath = join(dir, "agents.json");
  try {
    appendSkillDepsPruneLog({
      source: "sync",
      pruned: [{ dependent: skillDepRef("agent-a", "s1"), removedDep: skillDepRef("agent-b", "s2") }],
      storePath,
    });
    const transport = new HttpA2ATransport({ federationPath: storePath });
    const { url } = await transport.start();
    const res = await fetch(`${url}/a2a/federation/skill-deps/prune-log?agentId=ghost`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      entries: unknown[];
      filteredEmpty?: boolean;
      emptyHint?: string;
    };
    assert.equal(body.entries.length, 0);
    assert.equal(body.filteredEmpty, true);
    assert.equal(body.emptyHint, "no prune entries for agent");
    await transport.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET prune-log returns receipt_not_found emptyHintCode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-http-prune-receipt-miss-"));
  const storePath = join(dir, "agents.json");
  try {
    appendSkillDepsPruneLog({
      source: "sync",
      pruned: [{ dependent: skillDepRef("agent-a", "s1"), removedDep: skillDepRef("agent-b", "s2") }],
      storePath,
    });
    const transport = new HttpA2ATransport({ federationPath: storePath });
    const { url } = await transport.start();
    const res = await fetch(
      `${url}/a2a/federation/skill-deps/prune-log?receiptId=sdp-missing-receipt`,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      emptyHint: string;
      emptyHintCode: string;
      receiptNotFound: boolean;
      receiptFound: boolean;
    };
    assert.equal(body.emptyHint, "receipt not found");
    assert.equal(body.emptyHintCode, "receipt_not_found");
    assert.equal(body.receiptNotFound, true);
    assert.equal(body.receiptFound, false);
    await transport.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET prune-log ndjson emits meta line when agent filter matches nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-http-prune-ndjson-empty-"));
  const storePath = join(dir, "agents.json");
  try {
    appendSkillDepsPruneLog({
      source: "sync",
      pruned: [{ dependent: skillDepRef("agent-a", "s1"), removedDep: skillDepRef("agent-b", "s2") }],
      storePath,
    });
    const transport = new HttpA2ATransport({ federationPath: storePath });
    const { url } = await transport.start();
    const res = await fetch(`${url}/a2a/federation/skill-deps/prune-log?agentId=ghost&format=ndjson`);
    assert.equal(res.status, 200);
    const line = JSON.parse((await res.text()).trim()) as {
      _meta?: boolean;
      schema?: string;
      totalCount?: number;
      emptyHintCode?: string;
    };
    assert.equal(line._meta, true);
    assert.equal(line.schema, "federation-log-empty-v1");
    assert.equal(line.totalCount, 0);
    assert.equal(line.emptyHintCode, "no_prune_entries_for_agent");
    await transport.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET audit/log ndjson emits meta line when filter matches nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-http-audit-ndjson-empty-"));
  const storePath = join(dir, "agents.json");
  try {
    appendLeaseAuditEvent({
      type: "acquire",
      nodeId: "n1",
      holderNodeId: "n1",
      term: 1,
      storePath,
    });
    const transport = new HttpA2ATransport({ federationPath: storePath });
    const { url } = await transport.start();
    const res = await fetch(
      `${url}/a2a/federation/lease/audit/log?type=skill_prune_strategy&format=ndjson`,
    );
    assert.equal(res.status, 200);
    const body = await res.text();
    const line = JSON.parse(body.trim()) as {
      _meta?: boolean;
      schema?: string;
      totalCount?: number;
      filteredEmpty?: boolean;
      emptyHintCode?: string;
    };
    assert.equal(line._meta, true);
    assert.equal(line.schema, "federation-log-empty-v1");
    assert.equal(line.totalCount, 0);
    assert.equal(line.filteredEmpty, true);
    assert.equal(line.emptyHintCode, "no_events_match_filter");
    await transport.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET audit/log returns emptyHint when filter matches nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-http-audit-empty-"));
  const storePath = join(dir, "agents.json");
  try {
    appendLeaseAuditEvent({
      type: "acquire",
      nodeId: "n1",
      holderNodeId: "n1",
      term: 1,
      storePath,
    });
    const transport = new HttpA2ATransport({ federationPath: storePath });
    const { url } = await transport.start();
    const res = await fetch(
      `${url}/a2a/federation/lease/audit/log?type=skill_prune_strategy`,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      events: unknown[];
      filteredEmpty?: boolean;
      emptyHint?: string;
      emptyHintCode?: string;
    };
    assert.equal(body.events.length, 0);
    assert.equal(body.filteredEmpty, true);
    assert.equal(body.emptyHint, "no events match filter");
    assert.equal(body.emptyHintCode, "no_events_match_filter");
    await transport.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET audit/log rejects overlapping type and exclude", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-http-audit-overlap-"));
  const storePath = join(dir, "agents.json");
  try {
    appendLeaseAuditEvent({
      type: "acquire",
      nodeId: "n1",
      holderNodeId: "n1",
      term: 1,
      storePath,
    });
    const transport = new HttpA2ATransport({ federationPath: storePath });
    const { url } = await transport.start();
    const res = await fetch(
      `${url}/a2a/federation/lease/audit/log?type=acquire&exclude=acquire`,
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /overlap/);
    await transport.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST prune-strategy/rollback returns priorMode when toggling enable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-http-rollback-prior-"));
  const storePath = join(dir, "agents.json");
  try {
    configureSkillDepPruneStrategyRollback(true);
    const transport = new HttpA2ATransport({ federationPath: storePath });
    const { url } = await transport.start();
    const res = await fetch(`${url}/a2a/federation/skill-deps/prune-strategy/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enable: false }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      priorMode: boolean;
      rollbackMode: boolean;
      applied?: unknown;
    };
    assert.equal(body.ok, true);
    assert.equal(body.priorMode, true);
    assert.equal(body.rollbackMode, false);
    assert.equal("applied" in body, false);
    assert.equal(isSkillDepPruneStrategyRollbackEnabled(), false);
    await transport.stop();
  } finally {
    configureSkillDepPruneStrategyRollback(false);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST prune-strategy/rollback keeps rollback mode when agent missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-http-rollback-fail-"));
  const storePath = join(dir, "agents.json");
  try {
    configureSkillDepPruneStrategyRollback(true);
    const transport = new HttpA2ATransport({ federationPath: storePath });
    const { url } = await transport.start();
    const res = await fetch(`${url}/a2a/federation/skill-deps/prune-strategy/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "missing-agent" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      priorMode: boolean;
      rollbackMode: boolean;
      applied: { ok: boolean; reason?: string; reasonCode?: string };
    };
    assert.equal(body.ok, false);
    assert.equal(body.priorMode, true);
    assert.equal(body.applied.ok, false);
    assert.equal(body.applied.reason, "no rollback audit");
    assert.equal(body.applied.reasonCode, "no_rollback_audit");
    assert.equal(body.rollbackMode, true);
    assert.equal(isSkillDepPruneStrategyRollbackEnabled(), true);
    await transport.stop();
  } finally {
    configureSkillDepPruneStrategyRollback(false);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST prune-strategy/rollback applies audit rollbackTarget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-http-rollback-"));
  const storePath = join(dir, "agents.json");
  try {
    configureSkillDepPruneStrategyAuditStore(storePath);
    const older = setAgentSkillDepPruneStrategy(
      { ...card("agent-a"), metadata: { federationUpdatedAt: "2020-01-01T00:00:00.000Z" } },
      "last-edge",
    );
    const newer = setAgentSkillDepPruneStrategy(
      { ...card("agent-a"), metadata: { federationUpdatedAt: "2026-06-01T00:00:00.000Z" } },
      "min-edge",
    );
    const merged = mergeAgentCardCrdt(older, newer);
    persistFederatedAgentCards([merged], storePath);
    configureSkillDepPruneStrategyRollback(true);
    const transport = new HttpA2ATransport({ federationPath: storePath });
    const { url } = await transport.start();
    const res = await fetch(`${url}/a2a/federation/skill-deps/prune-strategy/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agent-a" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      rollbackMode: boolean;
      applied: { ok: boolean; strategy?: string; reasonCode?: string };
    };
    assert.equal(body.ok, true);
    assert.equal(body.applied.ok, true);
    assert.equal(body.applied.strategy, "last-edge");
    assert.equal(body.applied.reasonCode, "applied");
    assert.equal(body.rollbackMode, false);
    assert.equal(isSkillDepPruneStrategyRollbackEnabled(), false);
    await transport.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /a2a/federation/lease/audit/log supports limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fed-http-audit-"));
  const storePath = join(dir, "agents.json");
  try {
    for (let i = 0; i < 3; i++) {
      appendLeaseAuditEvent({
        type: "acquire",
        nodeId: "n1",
        holderNodeId: "n1",
        term: i + 1,
        storePath,
      });
    }
    const transport = new HttpA2ATransport({ federationPath: storePath });
    const { url } = await transport.start();
    const res = await fetch(`${url}/a2a/federation/lease/audit/log?limit=2`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      events: unknown[];
      totalEvents: number;
      truncated: boolean;
    };
    assert.equal(body.totalEvents, 3);
    assert.equal(body.events.length, 2);
    assert.equal(body.truncated, true);
    await transport.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
