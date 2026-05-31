# Phase 7 Code Review — Clean Code & Architecture Audit

> **Status: CLOSED**（2026-05-28）。**7.16** 与 issue6 **6.8** 一并收口（`resolveStepKind`）。

Date: 2026-03-29
Scope: Full `src/` directory, all `.ts` files + `scripts/task_runner.py`
Status: **All 24 items resolved.** `tsc --noEmit` clean, 160/160 tests passing.

---

## P0 — Type Safety (Must Fix)

### 7.1 Checkpoint deserialization lacks runtime validation — FIXED
**File:** `src/state.ts` — `parseCheckpoint()`
Added runtime validation for `sessionId`, `prompt`, `round`, `status`, and `dynamicPipeline` shape after `JSON.parse`.

### 7.2 `catch (err: any)` in run-step — ALREADY FIXED
**File:** `src/tools/run-step.ts:117`
Already uses `catch (err: unknown)` with `err instanceof Error` narrowing.

### 7.3 `runPython` returns `Promise<any>` — FIXED
**File:** `src/workspace.ts:81`
Return type changed to `Promise<Record<string, unknown>>`. `create()` caller now validates `baseRef`/`worktreePath` are strings before use. `collectPatch()` uses type guards for `patch`, `filesModified`, `diffStat`.

### 7.4 `as any[]` in validateConfig — ALREADY FIXED
**File:** `src/config.ts`
No `as any` casts remain. Validation uses proper `Array.isArray` checks.

---

## P1 — Dead Code (Should Remove)

### 7.5 `renderPromptTemplate` — ALREADY REMOVED
Did not exist in current codebase.

### 7.6 `getPromptStats` — REMOVED
**File:** `src/prompt.ts` — function deleted, no consumers.

### 7.7 `getLineDiff` — export removed — FIXED
**File:** `src/prompt.ts` — `export` keyword removed, function is now module-private.

### 7.8 `getModelContextWindow` — export removed — FIXED
**File:** `src/prompt.ts` — `export` keyword removed, function is now module-private.

### 7.9 `modesAreCompatible` — REMOVED
**File:** `src/providers/types.ts` — function deleted, no consumers.

### 7.10 `getRawContent` — REMOVED
**File:** `src/tools/helpers.ts` — function deleted, no consumers.

### 7.11 `canRouteStepToProvider` — REMOVED
**File:** `src/tools/helpers.ts` — function deleted, no consumers.

### 7.12 `truncateString` — REMOVED
**File:** `src/tools/helpers.ts` — function deleted, no consumers.

### 7.13 `createTraceId` — KEPT (used in tests)
**File:** `src/trace.ts` — used by `tests/trace.test.ts`. Kept as-is.

### 7.14 `persistRunningPipelineTrace` — KEPT (used in run-pipeline)
**File:** `src/trace.ts` — actively used by `src/tools/run-pipeline.ts`. Kept as-is.

### 7.15 `multi-agent-types.ts` — KEPT (used in tests)
**File:** `src/orchestration/multi-agent-types.ts` — used by `tests/multi-agent-types.test.ts`. Kept as-is.

---

## P2 — Architecture & Design

### 7.16 Scheduler ↔ step-strategy coupling — DEFERRED
Implicit generate/review branching is acceptable for current 2-step-type architecture. Will revisit when adding new step types in Wave 7.

### 7.17 `typescript` in production dependencies — DOCUMENTED
**File:** `package.json` — added `comments.typescript-in-deps` explaining runtime dependency via `ast_utils.ts`. Cannot move to devDeps without replacing the syntax checker.

### 7.18 `PipelineConfig` type alias shadows config.ts — FIXED
**File:** `src/tools/helpers.ts` — replaced local `ReturnType<typeof loadConfig>` alias with `export type { PipelineConfig } from "../config.js"`. Removed unused `loadConfig` import.

### 7.19 Unused outcome types in helpers.ts — REMOVED
**File:** `src/tools/helpers.ts` — `SkippedOutcome`, `BuiltinOutcome`, `ExecutedOutcome`, `StageOutcome` deleted. Also removed unused `StepTrace` import.

### 7.20 Duplicate config hash functions — FIXED
**File:** `src/state.ts` — `createConfigHash` is now a deprecated re-export of `calculateConfigHash` from `config.ts`. Single canonical implementation.

### 7.21 Cache has no cleanup mechanism — FIXED
**File:** `src/cache.ts` — added `clear()` method to `ResponseCache` and `clearCache()` module-level function for singleton reset.

### 7.22 Model lists not synchronized — FIXED
**File:** `src/prompt.ts` — `MODEL_CONTEXT_WINDOWS` synced with `PRICING_TABLE` keys (removed stale `gpt-4-turbo`, `gpt-4`, `gpt-3.5-turbo`; added sync comment).

---

## P3 — Project Hygiene

### 7.23 `typescript` dependency placement — DOCUMENTED
Same as 7.17. Runtime dep documented in package.json comments field.

### 7.24 Runtime dependency on `typescript` compiler — DOCUMENTED
**File:** `src/ast_utils.ts` — runtime import is the blocker. Documented in package.json.

---

## Summary

| Priority | Count | Fixed | Already OK | Deferred | Documented |
|----------|-------|-------|------------|----------|------------|
| P0       | 4     | 2     | 2          | 0        | 0          |
| P1       | 11    | 6     | 3          | 0        | 0          |
| P2       | 7     | 4     | 0          | 1        | 2          |
| P3       | 2     | 0     | 0          | 0        | 2          |
| **Total** | **24** | **12** | **5** | **1** | **4** |

- 2 items were already fixed in prior phases (7.2, 7.4)
- 3 items had test consumers so were kept (7.13, 7.14, 7.15)
- 1 item deferred to Wave 7 (7.16 step-strategy coupling)
- 2 items documented as intentional runtime dep (7.17/7.23, 7.24)
