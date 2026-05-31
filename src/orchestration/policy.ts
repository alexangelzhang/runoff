/**
 * Policy Engine (Wave 7.7).
 *
 * Machine-enforced allow/deny/require-approval decisions based on
 * agent role, action type, and configurable rules.
 * Policy runs BEFORE guardrails and approval gates.
 */

import type { AgentId, AgentRole } from "./multi-agent-types.js";

// --- Policy Decision ---

export type PolicyDecision = "allow" | "deny" | "require-approval";

export interface PolicyResult {
  decision: PolicyDecision;
  reason?: string;
  /** Which rule matched. */
  matchedRule?: string;
}

// --- Policy Rule ---

export interface PolicyRule {
  name: string;
  /** Match by agent role. Undefined = match all. */
  role?: AgentRole;
  /** Match by action type. Undefined = match all. */
  action?: string;
  /** Match by target path pattern (glob-like prefix). Undefined = match all. */
  pathPrefix?: string;
  /** The decision to apply when this rule matches. */
  decision: PolicyDecision;
}

// --- Policy Request ---

export interface PolicyRequest {
  agentId: AgentId;
  role: AgentRole;
  action: string;
  /** Target path (file, directory, URL). */
  targetPath?: string;
  /** Additional context for the policy decision. */
  metadata?: Record<string, unknown>;
}

// --- Policy Engine ---

export class PolicyEngine {
  private rules: PolicyRule[] = [];
  private defaultDecision: PolicyDecision;

  constructor(defaultDecision: PolicyDecision = "allow") {
    this.defaultDecision = defaultDecision;
  }

  /** Add a rule. Rules are evaluated in order; first match wins. */
  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
  }

  /** Remove a rule by name. */
  removeRule(name: string): boolean {
    const idx = this.rules.findIndex((r) => r.name === name);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    return true;
  }

  /** Evaluate a request against all rules. First match wins. */
  evaluate(request: PolicyRequest): PolicyResult {
    for (const rule of this.rules) {
      if (this.matches(rule, request)) {
        return {
          decision: rule.decision,
          reason: `Matched rule: ${rule.name}`,
          matchedRule: rule.name,
        };
      }
    }
    return { decision: this.defaultDecision, reason: "No matching rule; using default" };
  }

  /** Get all rules. */
  getRules(): readonly PolicyRule[] {
    return this.rules;
  }

  /** Clear all rules. */
  clearRules(): void {
    this.rules = [];
  }

  private matches(rule: PolicyRule, request: PolicyRequest): boolean {
    if (rule.role !== undefined && rule.role !== request.role) return false;
    if (rule.action !== undefined && rule.action !== request.action) return false;
    if (rule.pathPrefix !== undefined) {
      if (!request.targetPath || !request.targetPath.startsWith(rule.pathPrefix)) return false;
    }
    return true;
  }
}
