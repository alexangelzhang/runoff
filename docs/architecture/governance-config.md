# Governance configuration (`runtime.governance`)

Governance runs **Policy → Guardrails → Approval** before each step (and optionally before plan execution).

## Enable

```json
{
  "runtime": {
    "controlPlane": "file",
    "governance": {
      "enabled": true,
      "defaultPolicy": "allow",
      "approvalMode": "defer",
      "requirePlanApproval": true
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | — | Master switch; when false, governance is not created. |
| `defaultPolicy` | `allow` \| `deny` \| `require-approval` | `allow` | Decision when no rule matches. |
| `rules` | array | built-in defaults | Ordered rules; **first match wins**. |
| `maxPromptChars` | number | — | Input guardrail: max rendered prompt size. |
| `maxStepExecutionsPerStep` | number | — | Loop detection: max executions per step name per run. |
| `tripwireOnFailedResponse` | boolean | `true` | Output guardrail on failed agent responses. |
| `detectSecrets` | boolean | `true` when `enabled` | Tripwire on API keys / tokens in input and output. |
| `detectPii` | boolean | `true` when `enabled` | Tripwire on email, phone, SSN, card patterns. |
| `detectPromptInjection` | boolean | `true` when `enabled` | Tripwire on common injection phrases in input. |
| `detectForbiddenPaths` | boolean | `true` when `enabled` | Tripwire on `../`, `.env`, `id_rsa`, etc. in input. |
| `rejectEmptyOutput` | boolean | `true` when `enabled` | Tripwire when a successful step returns no text. |
| `maxOutputChars` | number | `2000000` when `enabled` | Cap model output size per step. |
| `approvalMode` | `auto` \| `defer` \| `callback` | `auto` | How human approval is satisfied. |
| `approvalRiskThreshold` | `low` \| `medium` \| `high` | `medium` | Auto gate: approve risks below this level. |
| `requirePlanApproval` | boolean | `false` | Pause after `orchestrator.plan()` until operator approves. |

## Guardrails (when `enabled: true`)

Extended guardrails are **on by default** once governance is enabled. Opt out per category:

```json
{
  "runtime": {
    "governance": {
      "enabled": true,
      "detectSecrets": true,
      "detectPii": true,
      "detectPromptInjection": true,
      "detectForbiddenPaths": true,
      "rejectEmptyOutput": true,
      "maxOutputChars": 2000000,
      "maxPromptChars": 500000,
      "maxStepExecutionsPerStep": 5
    }
  }
}
```

| Guardrail | Direction | Purpose |
|-----------|-----------|---------|
| CostLimit | input | Prompt size budget |
| LoopDetection | input | Same step re-run cap |
| SecretLeakage | input + output | API keys, tokens, `api_key=` assignments |
| Pii | input + output | Email, phone, SSN, card numbers |
| PromptInjection | input | Ignore-instructions / jailbreak phrases |
| ForbiddenPath | input | `../`, `.env`, `id_rsa`, `/etc/passwd` |
| Success | output | Failed provider responses |
| EmptyOutput | output | Successful but empty text |
| OutputSize | output | Max chars per step output |
| OutputFormat | output | Text responses must include `model` |

Tripwires throw `TripwireError` → pipeline step fails; auto-repair may classify as `guardrail_trip`.

## Rule template (`runtime.governance.rules`)

Each rule:

```json
{
  "name": "unique-rule-id",
  "role": "worker",
  "action": "execute_step",
  "pathPrefix": "src/secrets",
  "decision": "deny"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Stable id for audit / errors (`matchedRule`). |
| `decision` | yes | `allow`, `deny`, or `require-approval`. |
| `role` | no | `orchestrator`, `worker`, or `reviewer`. |
| `action` | no | e.g. `execute_step`, `delete`, `execute_plan`. |
| `pathPrefix` | no | Prefix match on `targetPath` (file ops). |

### Examples

```json
"rules": [
  { "name": "deny-env", "action": "execute_step", "pathPrefix": ".env", "decision": "deny" },
  { "name": "reviewer-only-review", "role": "reviewer", "action": "execute_step", "decision": "allow" },
  { "name": "approve-deletes", "action": "delete", "decision": "require-approval" }
]
```

If `rules` is omitted or empty, the runtime applies **default rules** from `defaultGovernanceRules()`:

- Deny `execute_step` when `pathPrefix` is `.env`
- `require-approval` for `delete`

## Approval modes

| Mode | Behavior |
|------|----------|
| `auto` | Low-risk auto-approved; medium/high resolved in-process (tests/CI). |
| `defer` | Throws deferred error → run/checkpoint `awaiting_approval` or `awaiting_plan_approval`; resume via MCP `approvalDecision`. |
| `callback` | Uses MCP/CLI callback when provided. |

Environment overrides: `RUNOFF_APPROVAL_MODE`, `RUNOFF_AUTO_APPROVE=1`.

## Audit trail

When `controlPlane: "file"`, each approval emits:

- `approval_requested` — request id, agent, action, phase (`plan` \| `action`)
- `approval_resolved` — decision, `respondedBy`, timestamp

Events are appended to the durable event log and merged into `PipelineTrace.approvals` on completion (see `approval-audit.ts`, `replay.ts`).

## MCP resume

```json
{
  "sessionId": "<checkpoint-session>",
  "approvalDecision": "approve",
  "approvalReason": "optional for reject"
}
```

Plan pause uses checkpoint status `awaiting_plan_approval`; step/policy pause uses `awaiting_approval`.
