/**
 * P4 — Vector-clock style federation merge (CRDT-lite, multi-master MVP).
 */

import type { A2AAgentCard } from "./agent-card.js";

export type FederationVector = Record<string, number>;

const VECTOR_KEY = "federationVector";

export function resolveFederationNodeId(configured?: string): string {
  return (
    configured ??
    process.env.LLM_PIPELINE_FEDERATION_NODE_ID ??
    process.env.HOSTNAME ??
    "local"
  );
}

export function getCardVector(card: A2AAgentCard): FederationVector {
  const raw = card.metadata?.[VECTOR_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: FederationVector = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export function mergeVectors(a: FederationVector, b: FederationVector): FederationVector {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = Math.max(out[k] ?? 0, v);
  }
  return out;
}

/** True when `a` is strictly newer than `b` in vector-clock partial order. */
export function vectorDominates(a: FederationVector, b: FederationVector): boolean {
  let anyGreater = false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    if (av < bv) return false;
    if (av > bv) anyGreater = true;
  }
  return anyGreater;
}

export function bumpCardVector(card: A2AAgentCard, nodeId: string): A2AAgentCard {
  const vector = mergeVectors(getCardVector(card), { [nodeId]: (getCardVector(card)[nodeId] ?? 0) + 1 });
  return {
    ...card,
    metadata: {
      ...card.metadata,
      [VECTOR_KEY]: vector,
      federationNodeId: nodeId,
      federationUpdatedAt: new Date().toISOString(),
    },
  };
}

export function stampFederationCards(cards: A2AAgentCard[], nodeId: string): A2AAgentCard[] {
  return cards.map((c) => bumpCardVector(c, nodeId));
}

export function pickVectorWinner(
  existing: A2AAgentCard,
  incoming: A2AAgentCard,
): A2AAgentCard {
  const ev = getCardVector(existing);
  const iv = getCardVector(incoming);
  if (vectorDominates(iv, ev)) return incoming;
  if (vectorDominates(ev, iv)) return existing;
  const eu = existing.metadata?.updatedAt ?? existing.metadata?.federationUpdatedAt;
  const iu = incoming.metadata?.updatedAt ?? incoming.metadata?.federationUpdatedAt;
  const et = typeof eu === "string" ? Date.parse(eu) : typeof eu === "number" ? eu : 0;
  const it = typeof iu === "string" ? Date.parse(iu) : typeof iu === "number" ? iu : 0;
  return it >= et ? incoming : existing;
}
