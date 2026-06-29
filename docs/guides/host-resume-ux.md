# Host resume UX

> **Audience:** MCP host agents (Cursor, Claude Code, Codex, etc.) that explain checkpoint resume behavior to users in natural conversation.
>
> **Companion doc:** [observability.md](../features/observability.md) documents **what fields exist** and where they are stored. This guide documents **how hosts should explain them** to users.

---

## 1. Purpose

When a pipeline resumes from a checkpoint, runoff records structured reuse decisions: which steps were skipped, which were re-executed, and why downstream work was invalidated. Those facts live in JSON fields (`resumeReusePlan`, `resumePlanner`, `resumeMetadata`).

**Host resume UX** is the contract for turning those facts into user-facing conversation:

- Lead with **what actually ran again** (rerun), not a dump of internal JSON.
- Explain **why** using planner `reason` strings and `downstreamOf` when present.
- Keep **skipped** steps collapsed unless the user asks for audit detail.
- Never claim "no reruns" when the planner is absent — say you cannot infer reuse from planner evidence.

Without this guide, hosts either ignore resume evidence or mis-explain it ("review failed" when the step was downstream invalidation).

---

## 2. Quick rules

| Rule | Do |
| ---- | -- |
| Parse JSON body | Always `JSON.parse(content[0].text)` — never rely on `isError` alone |
| Rerun first | List rerun steps before any skipped summary |
| Skipped collapsed | Report counts only; expand on explicit audit request |
| `downstreamOf` | When present, attribute rerun to upstream invalidation, not step failure |
| No planner | Do not fabricate skip/rerun claims; point to `stepResults` / trace |
| Pause statuses | `awaiting_*` and `needs_clarification` take precedence over resume planner copy |

---

## 3. Data sources and priority (Layer 1–5)

Hosts assemble user responses from five layers. Higher layers are for conversation; lower layers are evidence.

| Layer | Name | Source | Host use |
| ----- | ---- | ------ | -------- |
| **1** | Runtime facts | `PipelineResult.status`, `sessionId`, `round`, terminal `reason` | Outcome headline (approved / failed / paused) |
| **2** | Read models | `resumeReusePlan`, `observation.resumeReusePlan`, `run.resumePlanner`, trace/checkpoint planner | Structured skip/rerun decisions |
| **3** | Host interpretation | Apply decision matrix + copy rules below | Natural-language explanation |
| **4** | User response | Bilingual templates (§8) | What the user sees in chat |
| **5** | Evidence | `stepResults.*.observation`, `artifacts`, `runoff_query_traces`, checkpoint JSON | On-demand drilldown only |

**Read-model priority** (first hit wins for display; deeper layers remain for audit):

1. `PipelineResult.resumeReusePlan` — immediate `runoff_run_pipeline` response after resume
2. `PipelineResult.observation.resumeReusePlan` — work-memory mirror when top-level field omitted
3. `runoff_query_runs` `format=full` → `run.resumePlanner` — durable control-plane record
4. `PipelineTrace.resumeReusePlan` — `runoff_query_traces`, CLI `traces show`
5. Checkpoint `resumeReusePlan` — `~/.runoff/sessions/<session>.checkpoint.json`

Field definitions and storage paths: [observability.md § Resume planner](../features/observability.md#resume-planner-host-consumption-order).

---

## 4. MCP response handling

MCP tools return JSON in `content[0].text`. **`isError` is not sufficient** for pipeline semantics.

| Outcome | `isError` | Body |
| ------- | --------- | ---- |
| Success / approved | false | `PipelineResult` with `status: "approved"` |
| Terminal failure | **true** | `PipelineResult` with `status: "failed"` \| `"aborted"` \| `"max_rounds"` |
| Pause (resume needed) | false | `status: "awaiting_judge"` \| `"awaiting_approval"` \| `"awaiting_plan_approval"` \| `"needs_clarification"` |

**Required host steps:**

1. Parse `content[0].text` as JSON.
2. Read `status` and `observation.status` / `observation.nextHint`.
3. If resumed run: read `resumeReusePlan` (or fallbacks in §3).
4. Only then compose user-facing copy.

See also [skill/SKILL.md § MCP response contract](../../skill/SKILL.md#mcp-response-contract).

---

## 5. Resume planner concepts

| Concept | Meaning | Host wording |
| ------- | ------- | -------------- |
| **rerun** | Step was queued for re-execution this resume round | "Re-ran \<step\>" / "重跑 \<step\>" |
| **skipped** | Completed step reused without re-execution | "Reused" / "复用" — report as count, not expanded list |
| **downstreamOf** | Rerun caused by upstream invalidation (transitive DAG dependency) | "Because \<upstream\> was re-run, \<step\> was invalidated" / "因 \<upstream\> 重跑，\<step\> 作为下游需重跑" |
| **no planner** | Fresh start, or checkpoint from before planner existed | Do **not** say "all steps reused" or "no reruns" — say planner evidence is unavailable |

### Semantics table

| Condition | Planner present? | Host may claim |
| ----------- | ---------------- | -------------- |
| Same-round resume, metadata complete | Yes | Exact rerun/skipped counts from `summary` |
| Same-round resume, partial metadata | Yes | Rerun list + skipped count; note legacy skips if reasons say so |
| Fresh pipeline (no prior checkpoint) | No | No reuse narrative |
| Old checkpoint (pre-planner) | No | Direct user to `stepResults` / trace |
| `needs_clarification` before steps run | Maybe | Scope preflight first; planner secondary |

**Legacy skipped note:** entries with reason `legacy completed result has no resume metadata` mean pre-P3 compatibility — the step was treated as skippable. Mention only in audit expansion, not in routine summary.

---

## 6. Host display protocol

### A. Direct `runoff_run_pipeline` response

```
1. Parse JSON body
2. observation.status / nextHint  → pause or clarification?
3. resumeReusePlan ?? observation.resumeReusePlan  → planner evidence
4. Apply decision matrix (§7)
5. stepResults.<step>.observation  → only if user asks about a specific step
```

### B. `runoff_query_runs` `format=full`

```
1. run.status, run.sessionId
2. run.resumePlanner  → compact rerunSteps + skipped/skippedHidden counts
3. run.pendingApproval / resume hints if paused
4. Same decision matrix; planner shape differs but display policy matches
```

Summary/list format (`format=summary`) exposes only `{ rerun, skipped }` counts — no step names. Use for list views; use `full` before explaining reruns to the user.

### C. Audit fallback (trace / checkpoint / `--json`)

When user asks "show me everything" or disputes a skip:

```
1. runoff_query_traces traceId=<id> format=full  → resumeReusePlan.entries (all skipped + rerun)
2. Or checkpoint JSON resumeReusePlan
3. Expand skipped entries with reason + evidenceRefs
4. Do not paste full trace JSON into chat — summarize entries
```

---

## 7. Decision matrix

Combine **`PipelineResult.status`** (or run status) with **resume planner evidence**.

| # | status | Planner | Host action |
| - | ------ | ------- | ----------- |
| 1 | `approved` | rerun > 0 | Success + rerun list first, skipped count collapsed |
| 2 | `approved` | rerun = 0, skipped > 0 | All reused; no reruns required |
| 3 | `approved` | no planner | Success without reuse claims |
| 4 | `failed` | rerun > 0 | Failure reason first; then note reruns that ran before failure |
| 5 | `failed` | no planner | Failure only; no reuse narrative |
| 6 | `max_rounds` | rerun > 0 | Retry budget exhausted; mention reruns if relevant |
| 7 | `awaiting_judge` | any | Race pause — `runoff_race_apply` / `runoff_race_abort`; planner secondary |
| 8 | `awaiting_approval` / `awaiting_plan_approval` | any | Approval gate — resume with `approvalDecision`; no completion narrative |
| 9 | `needs_clarification` | any | Answer `scopePreflight.clarificationQuestions` first |

---

## 8. Templates (EN + 中文)

Replace `<R>`, `<N>`, `<M>`, `<step>`, `<reason>`, `<upstream>` with runtime values.

### 8.1 approved + rerun > 0

**EN:**
```
Pipeline completed successfully (round <R>).

Resume planner: re-ran <N> step(s), reused <M> completed step(s).
• Re-run <step>: <reason> [downstreamOf=<upstream>]
Skipped audit: <M> step(s) — ask to expand resumeReusePlan / trace if needed.
```

**中文:**
```
Pipeline 已成功完成（第 <R> 轮）。

恢复规划：重跑 <N> 步，复用 <M> 步已完成结果。
• 重跑 <step>：<reason> [下游=<upstream>]
跳过审计：<M> 步 — 如需详情可展开 resumeReusePlan / trace。
```

**Example (EN):**
```
Pipeline completed successfully (round 2).

Resume planner: re-ran 2 step(s), reused 1 completed step(s).
• Re-run generate: artifact completeness is partial
• Re-run validate: downstream dependency generate must rerun on resume (downstreamOf=generate)
Skipped audit: 1 step(s) — ask to expand resumeReusePlan / trace if needed.
```

### 8.2 approved + rerun = 0 + skipped > 0

**EN:**
```
Pipeline completed successfully (round <R>).

Resume planner: all completed steps reused (skipped=<M>). No reruns required.
Audit: inspect resumeReusePlan for evidence refs if you need step-level proof.
```

**中文:**
```
Pipeline 已成功完成（第 <R> 轮）。

恢复规划：已完成步骤均可复用（跳过 <M> 步），无需重跑。
审计：如需逐步证据可查看 resumeReusePlan 中的 evidenceRefs。
```

### 8.3 approved + no planner

**EN:**
```
Pipeline completed successfully.

No resume planner on this run (fresh start or pre-planner checkpoint). I cannot infer skip/rerun decisions from planner evidence — check stepResults or trace if reuse matters.
```

**中文:**
```
Pipeline 已成功完成。

本 run 无 resume planner（全新启动或旧 checkpoint）。无法从 planner 推断复用/重跑决策 — 若需复用证据请查 stepResults / trace。
```

### 8.4 failed + rerun > 0

**EN:**
```
Pipeline failed (round <R>): <reason>.

Before failure, resume planner re-ran <N> step(s), reused <M>.
• Re-run <step>: <reason> [downstreamOf=<upstream>]
Failure is independent of skip reuse unless the failed step is in the rerun list.
```

**中文:**
```
Pipeline 失败（第 <R> 轮）：<reason>。

失败前，恢复规划重跑 <N> 步，复用 <M> 步。
• 重跑 <step>：<reason> [下游=<upstream>]
失败原因与跳过复用无关，除非失败步骤本身在重跑列表中。
```

### 8.5 failed + no planner

**EN:**
```
Pipeline failed: <reason>.

No resume planner evidence on this run. See stepResults and trace for step-level failure detail.
```

**中文:**
```
Pipeline 失败：<reason>。

本 run 无 resume planner 证据。逐步失败详情请查 stepResults 与 trace。
```

### 8.6 max_rounds + rerun > 0

**EN:**
```
Pipeline stopped: retry budget exhausted (max_rounds, round <R>).

Resume planner had re-ran <N> step(s) this round before stopping.
• Re-run <step>: <reason> [downstreamOf=<upstream>]
Consider adjusting retry policy or fixing the blocking step.
```

**中文:**
```
Pipeline 已停止：重试次数用尽（max_rounds，第 <R> 轮）。

本轮恢复规划已重跑 <N> 步。
• 重跑 <step>：<reason> [下游=<upstream>]
可考虑调整重试策略或修复阻塞步骤。
```

### 8.7 awaiting_judge

**EN:**
```
Pipeline paused: awaiting judge (race mode).

Follow observation.nextHint, then call runoff_race_apply or runoff_race_abort. Do not treat this as a completed or failed run.
```

**中文:**
```
Pipeline 已暂停：等待 judge 裁决（race 模式）。

请按 observation.nextHint 操作，然后调用 runoff_race_apply 或 runoff_race_abort。不要将此状态当作已完成或失败。
```

### 8.8 awaiting_approval / awaiting_plan_approval

**EN:**
```
Pipeline paused: awaiting your approval (<status>).

Review pendingApproval / observation summary, then resume with runoff_run_pipeline(sessionId, approvalDecision). No completion narrative yet.
```

**中文:**
```
Pipeline 已暂停：等待审批（<status>）。

请查看 pendingApproval / observation 摘要，然后用 runoff_run_pipeline(sessionId, approvalDecision) 恢复。尚未完成。
```

### 8.9 needs_clarification

**EN:**
```
Pipeline paused: scope clarification required before steps run.

Answer scopePreflight.clarificationQuestions, then resume with the same sessionId and explicit scopePreflight confirmations. Resume planner does not apply until execution proceeds.
```

**中文:**
```
Pipeline 已暂停：执行前需确认范围（scope preflight）。

请先回答 scopePreflight.clarificationQuestions，再用相同 sessionId 与明确的 scopePreflight 确认恢复。步骤未开始前不适用 resume planner。
```

---

## 9. Rerun step copy rules

### Normal rerun (upstream step itself stale)

Use the planner `reason` verbatim or lightly paraphrased:

- `artifact completeness is partial` → "Re-ran \<step\> because saved artifacts were incomplete."
- `step status is failed` → "Re-ran \<step\> because the prior attempt did not succeed."

**中文:** "因 \<reason\>，重跑 \<step\>。"

### Downstream invalidation (`downstreamOf` set)

Reason pattern: `downstream dependency <upstream> must rerun on resume`

**EN:** "Re-ran \<step\> because \<upstream\> was re-executed and downstream results could be stale (downstreamOf=\<upstream\>)."

**中文:** "因 \<upstream\> 重跑，下游 \<step\> 的结果可能过期，需重跑（下游=\<upstream\>）。"

### Anti-patterns for rerun copy

| Don't say | Why |
| --------- | --- |
| "Review failed" | Downstream invalidation is not a verdict failure |
| "Skipped steps failed" | Skipped means reused, not failed |
| "No steps re-ran" | When `summary.rerun > 0` |
| Invent reasons | Use planner `reason` or say evidence is missing |

---

## 10. Skipped display rules

| Context | Policy |
| ------- | ------ |
| Routine user update | `skipped=M` count only |
| List / summary format | `resume=rerun:N,skipped:M` mark |
| User asks "which steps were skipped?" | Expand `resumeReusePlan.entries` where `decision=skipped` |
| Legacy reason present | Note: "Some skips used legacy compatibility (no resume metadata on step)." |

**Default collapsed line (EN):** `Skipped audit: M step(s) — expand resumeReusePlan / trace / checkpoint for details.`

**Default collapsed line (中文):** `跳过审计：M 步 — 展开 resumeReusePlan / trace / checkpoint 查看详情。`

---

## 11. Evidence drilldown protocol

Expand evidence **only on user request** or when disputing a reuse decision.

1. Identify `traceRef` / `checkpointRef` from `observation`.
2. `runoff_query_traces` with `traceId` and `format=full` — read `resumeReusePlan.entries`.
3. For a specific step: `stepResults.<step>.observation.resumeMetadata` + `artifacts`.
4. Summarize 3–5 bullet points; do not dump raw JSON.

---

## 12. Anti-patterns

| Anti-pattern | Fix |
| ------------ | --- |
| **`isError`-only handling** | Parse JSON `status`; pauses are often `isError: false` |
| **Skipped as failure** | Skipped = reused success; failed = `status: failed` on step or pipeline |
| **Downstream misattribution** | Check `downstreamOf`; don't blame review verdict |
| **No-planner fabrication** | Say planner unavailable; don't claim "all reused" |
| **Full JSON dump** | Use templates + on-demand audit |
| **Planner before pause resolution** | Handle `needs_clarification` / `awaiting_*` first |

---

## 13. Inline examples

### 13.1 Direct `runoff_run_pipeline` (compact)

```json
{
  "status": "approved",
  "sessionId": "sess-abc",
  "resumeReusePlan": {
    "schemaVersion": 1,
    "round": 2,
    "summary": { "rerun": 1, "skipped": 2 },
    "entries": [
      { "stepName": "implement", "decision": "rerun", "reason": "artifact completeness is partial", "round": 2 },
      { "stepName": "plan", "decision": "skipped", "reason": "resume metadata allows skip", "round": 2 },
      { "stepName": "analyze", "decision": "skipped", "reason": "resume metadata allows skip", "round": 2 }
    ]
  },
  "observation": { "status": "approved", "summary": "Pipeline approved after round 2" }
}
```

**Host says (中文):**
```
Pipeline 已成功完成（第 2 轮）。
恢复规划：重跑 1 步，复用 2 步。
• 重跑 implement：artifact completeness is partial
跳过审计：2 步 — 如需详情可展开 resumeReusePlan。
```

### 13.2 `runoff_query_runs` format=full

```json
{
  "runs": [{
    "runId": "run-xyz",
    "status": "approved",
    "resumePlanner": {
      "round": 2,
      "rerun": 2,
      "skipped": 1,
      "rerunSteps": [
        { "stepName": "generate", "reason": "artifact completeness is partial" },
        { "stepName": "validate", "reason": "downstream dependency generate must rerun on resume", "downstreamOf": "generate" }
      ],
      "skippedHidden": 1
    }
  }]
}
```

**Host says (EN):**
```
Run run-xyz approved (round 2). Resume planner: re-ran 2, reused 1.
• Re-run generate: artifact completeness is partial
• Re-run validate: downstream dependency generate must rerun on resume (downstreamOf=generate)
1 skipped step hidden — ask to expand for audit.
```

### 13.3 Audit request

User: "Which steps were skipped and why?"

Host actions:
1. Read `resumeReusePlan.entries` where `decision === "skipped"`.
2. Reply with step names + reasons (include legacy note if any).
3. Offer trace ID for full artifact history if needed.

**Host says (中文):**
```
跳过 2 步：
• plan — resume metadata allows skip
• analyze — legacy completed result has no resume metadata（兼容旧结果，审计时可查 trace）
重跑 1 步：implement — artifact completeness is partial
```

---

## Related links

- [observability.md](../features/observability.md) — field definitions, storage, CLI/MCP surfaces
- [skill/SKILL.md](../../skill/SKILL.md) — host routing index and MCP contract
- [trace-lifecycle.md](../architecture/trace-lifecycle.md) — trace persistence timing
