/**
 * P21 — Audit skill dep prune strategy CRDT conflicts on lease audit chain.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { appendLeaseAuditEvent, readLeaseAuditChain } from "./federation-lease-audit.js";
import {
  loadFederatedAgentCards,
  persistFederatedAgentCards,
} from "./federated-registry-store.js";
import {
  configureSkillDepPruneStrategyRollback,
  setAgentSkillDepPruneStrategy,
  type SkillDepPruneStrategy,
} from "./federation-skill-deps.js";

let auditStorePath: string | undefined;

export function configureSkillDepPruneStrategyAuditStore(storePath?: string): void {
  auditStorePath = storePath;
}

/** Append hash-linked audit event when two replicas disagree on prune strategy. */
export function appendSkillDepPruneStrategyAudit(options: {
  agentId: string;
  priorA: SkillDepPruneStrategy;
  priorB: SkillDepPruneStrategy;
  merged: SkillDepPruneStrategy;
  /** P22: LWW rollback target (older replica's strategy). */
  rollbackTarget: SkillDepPruneStrategy;
  storePath?: string;
}): void {
  appendLeaseAuditEvent({
    type: "skill_prune_strategy",
    nodeId: options.agentId,
    detail: JSON.stringify({
      priorA: options.priorA,
      priorB: options.priorB,
      merged: options.merged,
      rollbackTarget: options.rollbackTarget,
    }),
    storePath: options.storePath ?? auditStorePath,
  });
}

export type SkillPruneStrategyAuditDetail = {
  priorA: SkillDepPruneStrategy;
  priorB: SkillDepPruneStrategy;
  merged: SkillDepPruneStrategy;
  rollbackTarget?: SkillDepPruneStrategy;
};

/** P22: last skill_prune_strategy audit for an agent. */
export function findLastSkillPruneStrategyAudit(
  agentId: string,
  storePath?: string,
): (SkillPruneStrategyAuditDetail & { at: string }) | null {
  const chain = readLeaseAuditChain(storePath ?? auditStorePath);
  const evs = chain.events.filter(
    (ev) => ev.type === "skill_prune_strategy" && ev.nodeId === agentId,
  );
  const last = evs[evs.length - 1];
  if (!last?.detail) return null;
  try {
    const parsed = JSON.parse(last.detail) as SkillPruneStrategyAuditDetail;
    if (!parsed.priorA || !parsed.priorB || !parsed.merged) return null;
    return { ...parsed, at: last.at };
  } catch {
    return null;
  }
}

export type SkillDepPruneRollbackFailureCode =
  | "no_rollback_audit"
  | "no_rollback_target"
  | "store_path_required"
  | "agent_not_found";

export type SkillDepPruneRollbackReasonCode = SkillDepPruneRollbackFailureCode | "applied";

export type SkillDepPruneRollbackResult =
  | { ok: true; strategy: SkillDepPruneStrategy; reasonCode: "applied" }
  | { ok: false; reason: string; reasonCode: SkillDepPruneRollbackFailureCode };

function resolveWritableAuditStore(storePath?: string): string | undefined {
  const path = storePath ?? auditStorePath;
  if (!path) return undefined;
  const dir = path.endsWith(".json") ? dirname(path) : path;
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return undefined;
    }
  }
  return path;
}

function appendSkillDepPruneStrategyRollbackAudit(
  agentId: string,
  result: SkillDepPruneRollbackResult,
  storePath?: string,
): void {
  const writable = resolveWritableAuditStore(storePath);
  if (!writable) return;
  try {
    appendLeaseAuditEvent({
      type: "skill_prune_strategy_rollback",
      nodeId: agentId,
      detail: JSON.stringify(
        result.ok
          ? { ok: true, reasonCode: result.reasonCode, strategy: result.strategy }
          : { ok: false, reasonCode: result.reasonCode, reason: result.reason },
      ),
      storePath: writable,
    });
  } catch {
    /* best-effort; rollback result must not depend on audit persistence */
  }
}

/** P22: apply rollbackTarget from last audit onto federated agent card. */
export function applySkillDepPruneStrategyRollbackForAgent(options: {
  agentId: string;
  storePath?: string;
}): SkillDepPruneRollbackResult {
  const audit = findLastSkillPruneStrategyAudit(options.agentId, options.storePath);
  if (!audit) {
    const result = {
      ok: false as const,
      reason: "no rollback audit",
      reasonCode: "no_rollback_audit" as const,
    };
    appendSkillDepPruneStrategyRollbackAudit(options.agentId, result, options.storePath);
    return result;
  }
  const target = audit.rollbackTarget ?? audit.priorA;
  if (!target) {
    const result = {
      ok: false as const,
      reason: "no rollback target in audit",
      reasonCode: "no_rollback_target" as const,
    };
    appendSkillDepPruneStrategyRollbackAudit(options.agentId, result, options.storePath);
    return result;
  }
  const path = options.storePath;
  if (!path) {
    const result = {
      ok: false as const,
      reason: "store path required",
      reasonCode: "store_path_required" as const,
    };
    appendSkillDepPruneStrategyRollbackAudit(options.agentId, result, options.storePath);
    return result;
  }
  const cards = loadFederatedAgentCards(path);
  const idx = cards.findIndex((c) => c.agentId === options.agentId);
  if (idx < 0) {
    const result = {
      ok: false as const,
      reason: "agent not found",
      reasonCode: "agent_not_found" as const,
    };
    appendSkillDepPruneStrategyRollbackAudit(options.agentId, result, options.storePath);
    return result;
  }
  cards[idx] = setAgentSkillDepPruneStrategy(cards[idx]!, target);
  persistFederatedAgentCards(cards, path);
  configureSkillDepPruneStrategyRollback(false);
  const result = { ok: true as const, strategy: target, reasonCode: "applied" as const };
  appendSkillDepPruneStrategyRollbackAudit(options.agentId, result, options.storePath);
  return result;
}
