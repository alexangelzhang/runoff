import assert from "node:assert/strict";
import test from "node:test";
import { exportLeaseAuditLog } from "../src/orchestration/a2a/federation-lease-audit.ts";
import { exportSkillDepsPruneLog } from "../src/orchestration/a2a/federation-skill-deps-log.ts";
import {
  FEDERATION_LOG_EMPTY_NDJSON_SCHEMA,
  federationLogNdjsonEmptyMetaObject,
} from "../src/orchestration/a2a/federation-ndjson-meta.ts";

const EMPTY_NDJSON_META_KEYS = [
  "_meta",
  "schema",
  "version",
  "updatedAt",
  "totalCount",
  "truncated",
  "filteredEmpty",
  "emptyHint",
  "emptyHintCode",
] as const;

test("federationLogNdjsonEmptyMetaObject uses federation-log-empty-v1 schema", () => {
  const obj = federationLogNdjsonEmptyMetaObject({
    version: 1,
    updatedAt: "2026-05-27T00:00:00.000Z",
    totalCount: 3,
    truncated: true,
    emptyHint: "no events match filter",
    emptyHintCode: "no_events_match_filter",
  });
  assert.equal(obj._meta, true);
  assert.equal(obj.schema, FEDERATION_LOG_EMPTY_NDJSON_SCHEMA);
  assert.equal(obj.totalCount, 3);
  assert.equal(obj.truncated, true);
  assert.equal(obj.filteredEmpty, true);
  assert.equal(obj.emptyHintCode, "no_events_match_filter");
});

test("exportLeaseAuditLog and exportSkillDepsPruneLog share empty NDJSON meta keys", () => {
  const updatedAt = "2026-05-27T00:00:00.000Z";
  const auditNd = exportLeaseAuditLog(
    {
      version: 1,
      updatedAt,
      events: [
        {
          seq: 1,
          at: updatedAt,
          type: "acquire",
          nodeId: "n1",
          holderNodeId: "n1",
          term: 1,
          prevHash: "",
          hash: "test-hash",
        },
      ],
    },
    { types: ["skill_prune_strategy"] },
    "ndjson",
  );
  const pruneNd = exportSkillDepsPruneLog(
    { version: 1, updatedAt, entries: [] },
    "ndjson",
    {
      filteredEmpty: true,
      emptyHint: "prune log empty",
      emptyHintCode: "prune_log_empty",
      totalEntries: 0,
      truncated: false,
    },
  );
  const auditMeta = JSON.parse(auditNd.trim()) as Record<string, unknown>;
  const pruneMeta = JSON.parse(pruneNd.trim()) as Record<string, unknown>;
  for (const key of EMPTY_NDJSON_META_KEYS) {
    assert.ok(key in auditMeta, `audit missing ${key}`);
    assert.ok(key in pruneMeta, `prune missing ${key}`);
  }
  assert.equal(auditMeta.schema, FEDERATION_LOG_EMPTY_NDJSON_SCHEMA);
  assert.equal(pruneMeta.schema, FEDERATION_LOG_EMPTY_NDJSON_SCHEMA);
});
