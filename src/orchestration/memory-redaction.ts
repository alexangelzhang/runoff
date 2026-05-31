/**
 * Phase 8 — Secret redaction before persisting agent memory.
 */

import { redactSecretsInText } from "./guardrail-scan.js";

export function redactSecrets(text: string): string {
  return redactSecretsInText(text);
}

export function redactMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return metadata;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") {
      out[key] = redactSecrets(value);
    } else if (Array.isArray(value)) {
      out[key] = value.map((v) => (typeof v === "string" ? redactSecrets(v) : v));
    } else {
      out[key] = value;
    }
  }
  return out;
}
