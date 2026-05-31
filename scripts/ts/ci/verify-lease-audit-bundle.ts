#!/usr/bin/env npx tsx
/**
 * P17 — Offline verify lease audit signed bundle JSON.
 *
 * Usage:
 *   npx tsx scripts/verify-lease-audit-bundle.ts path/to/bundle.json --secret <hmac-secret>
 *   npx tsx scripts/verify-lease-audit-bundle.ts bundle.json --key-ring '{"k1":"secret"}'
 */

import { readFileSync } from "node:fs";
import type { LeaseAuditSignedBundle } from "../../../src/experimental/a2a/federation-lease-audit-export.ts";
import { verifyLeaseAuditSignedBundle } from "../../../src/experimental/a2a/federation-lease-audit-export.ts";

function parseArgs(argv: string[]): {
  path: string;
  secrets: Record<string, string>;
} {
  const path = argv[2];
  if (!path) {
    console.error("Usage: verify-lease-audit-bundle.ts <bundle.json> [--secret S | --key-ring JSON]");
    process.exit(2);
  }
  const secrets: Record<string, string> = {};
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === "--secret" && argv[i + 1]) {
      secrets.default = argv[++i]!;
    } else if (argv[i] === "--key-ring" && argv[i + 1]) {
      const ring = JSON.parse(argv[++i]!) as Record<string, string>;
      Object.assign(secrets, ring);
    }
  }
  if (process.env.FEDERATION_LEASE_AUDIT_SECRET && !Object.keys(secrets).length) {
    secrets.default = process.env.FEDERATION_LEASE_AUDIT_SECRET;
  }
  return { path, secrets };
}

const { path, secrets } = parseArgs(process.argv);
const raw = JSON.parse(readFileSync(path, "utf-8")) as LeaseAuditSignedBundle;
const result = verifyLeaseAuditSignedBundle(raw, {
  secrets: Object.keys(secrets).length ? secrets : undefined,
});

if (result.ok) {
  console.log(`OK: ${path} (events=${raw.events?.length ?? 0})`);
  process.exit(0);
}
console.error(`FAIL: ${path}`);
for (const err of result.errors) console.error(`  - ${err}`);
process.exit(1);
