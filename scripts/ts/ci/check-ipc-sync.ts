#!/usr/bin/env npx tsx
/**
 * Verifies TypeScript `src/core/ipc.ts` stays in sync with `scripts/python/task_runner.py`
 * (schema versions + payload/result field manifests). Run from repo root:
 *   npm run check-ipc-sync
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  TASK_PAYLOAD_FIELDS,
  TASK_PAYLOAD_SCHEMA_VERSION,
  TASK_RESULT_FIELDS,
  TASK_RESULT_SCHEMA_VERSION,
} from "../../../src/core/ipc.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const pyProbe = `
import json, sys, os
sys.path.insert(0, os.path.join(sys.argv[1], "scripts", "python"))
from task_runner import (
    TASK_PAYLOAD_SCHEMA_VERSION as pv,
    TASK_RESULT_SCHEMA_VERSION as rv,
    TASK_PAYLOAD_FIELD_NAMES as pf,
    TASK_RESULT_FIELD_NAMES as rf,
)
print(json.dumps({"payloadVer": pv, "resultVer": rv, "payloadFields": list(pf), "resultFields": list(rf)}))
`;

function fail(msg: string): never {
  console.error(`check-ipc-sync: ${msg}`);
  process.exit(1);
}

let raw: string;
try {
  raw = execFileSync("python3", ["-c", pyProbe, root], {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 2 * 1024 * 1024,
  }).trim();
} catch (e: unknown) {
  const err = e as { stderr?: Buffer; message?: string };
  const stderr = err.stderr?.toString?.() ?? "";
  fail(`python3 probe failed: ${stderr || err.message || e}`);
}

const py = JSON.parse(raw) as {
  payloadVer: number;
  resultVer: number;
  payloadFields: string[];
  resultFields: string[];
};

if (py.payloadVer !== TASK_PAYLOAD_SCHEMA_VERSION) {
  fail(
    `TASK_PAYLOAD_SCHEMA_VERSION mismatch: ipc.ts=${TASK_PAYLOAD_SCHEMA_VERSION} task_runner.py=${py.payloadVer}`
  );
}
if (py.resultVer !== TASK_RESULT_SCHEMA_VERSION) {
  fail(
    `TASK_RESULT_SCHEMA_VERSION mismatch: ipc.ts=${TASK_RESULT_SCHEMA_VERSION} task_runner.py=${py.resultVer}`
  );
}

function sameList(a: string[], b: string[], label: string) {
  if (a.length !== b.length) {
    fail(`${label}: length ${a.length} vs ${b.length}`);
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      fail(`${label}: differ at index ${i}: ipc.ts ${JSON.stringify(a[i])} vs Python ${JSON.stringify(b[i])}`);
    }
  }
}

sameList(TASK_PAYLOAD_FIELDS, py.payloadFields, "TASK_PAYLOAD_FIELDS vs TASK_PAYLOAD_FIELD_NAMES");
sameList(TASK_RESULT_FIELDS, py.resultFields, "TASK_RESULT_FIELDS vs TASK_RESULT_FIELD_NAMES");

console.log(
  `check-ipc-sync: OK (payload v${TASK_PAYLOAD_SCHEMA_VERSION}, result v${TASK_RESULT_SCHEMA_VERSION}, ${TASK_PAYLOAD_FIELDS.length} payload / ${TASK_RESULT_FIELDS.length} result fields)`
);
