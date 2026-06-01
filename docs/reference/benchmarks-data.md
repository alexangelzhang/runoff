# Benchmark Results

> Generated: 2026-05-31 — mock providers, deterministic outputs, zero API cost.
> Repeat with: `npm run benchmark`

## Setup

| Config | Providers | Pipeline |
|--------|-----------|---------|
| single | mock-a (full tier) | implement → review |
| race   | mock-a + mock-b (full + lite, parallel) | implement (race, auto-pick) → review |

**mock-a (full tier):** typed implementation with validation, ~142 completion tokens per implement step.
**mock-b (lite tier):** compact implementation, ~68 completion tokens per implement step.
**Race resolution:** `pick-winner` selects mock-a (higher token count = richer output); review approves on round 1.
**What this measures:** token cost overhead of running two providers vs one.

## Results (10 tasks × 2 variants)

```
task                                           variant   status     rnd  tokens  ms
───────────────────────────────────────────────────────────────────────────────────────
Add a typed retry() helper with exponential b… single   approved     1     974     51
Add a typed retry() helper with exponential b… race     approved     1    1824     48
Implement a parseCSV() function that handles … single   approved     1     974     46
Implement a parseCSV() function that handles … race     approved     1    1824     44
Add input validation to the user registration… single   approved     1     974     53
Add input validation to the user registration… race     approved     1    1824     50
Refactor the database connection pool to use … single   approved     1     974     54
Refactor the database connection pool to use … race     approved     1    1824     50
Fix the off-by-one error in the pagination lo… single   approved     1     974     54
Fix the off-by-one error in the pagination lo… race     approved     1    1824     52
Add TypeScript types to the legacy JavaScript… single   approved     1     974     43
Add TypeScript types to the legacy JavaScript… race     approved     1    1824     41
Implement rate limiting middleware for the AP… single   approved     1     974     40
Implement rate limiting middleware for the AP… race     approved     1    1824     39
Add error handling to the file upload handler  single   approved     1     974     63
Add error handling to the file upload handler  race     approved     1    1824     61
Refactor the nested callback chain to use Pro… single   approved     1     974     67
Refactor the nested callback chain to use Pro… race     approved     1    1824     65
Add a caching layer to the expensive computat… single   approved     1     974     61
Add a caching layer to the expensive computat… race     approved     1    1824     59
```

## Summary

| Metric | single-model | race (auto-pick) |
|--------|:------------:|:----------------:|
| Approved rate | 100% | 100% |
| Avg tokens / run | 974 | 1824 |
| Avg rounds | 1 | 1 |
| Avg latency (ms) | 53 | 51 |

## Interpretation

These results measure the **token cost overhead** of race mode against single-model.

In this scenario, both configs produce identical outcomes (100% approved, 1 round). The difference is token spend:
- Race spends ~87% more tokens per task (1824 vs 974 avg), because it runs two providers in parallel.
- Early termination reduces the premium: the lite-tier provider is aborted once the full-tier result arrives, so you pay for partial generation, not a complete second run.

**What mock benchmarks cannot measure** is the more important case: real models making different choices on the same prompt. The value of race mode is not raw token efficiency — it's *candidate diversity*. When two models agree, you have stronger evidence. When they diverge, the divergence is itself information (one model found an existing helper; the other didn't). This requires running real providers against real codebases.

The token cost ceiling is configurable: `orchestration.raceBudgetUSD` caps per-step spend, and `raceEarlyTermination: true` (default) aborts losers as soon as a viable winner arrives.

## Notes

- Mock outputs are deterministic; results are reproducible across runs.
- Token counts reflect mock responses, not real LLM usage.
- For real-provider data, run: `npm run smoke:real` (requires API keys).
- Experiment data persisted to: `~/.llm-pipeline/experiments.jsonl`

---

## Real-provider race: claude-opus vs claude-sonnet (2026-06-01)

**Task:** Add error handling to 3 functions in `src/lib/tauri.ts` of a real Tauri/React project.  
**Config:** `raceEarlyTermination: false`, `raceFinalize: defer` (manual pick)

### What each model produced

**claude-sonnet** — converted arrow functions to `async/await + try/catch`:
```diff
-export const searchMemory = (
+export const searchMemory = async (
   query: string,
   topK = 10
-): Promise<SearchResult[]> =>
-  invoke<SearchResult[]>("search_memory", { query, topK });
+): Promise<SearchResult[]> => {
+  try {
+    return await invoke<SearchResult[]>("search_memory", { query, topK });
+  } catch (e) {
+    throw new Error(`searchMemory failed: ${e}`);
+  }
+};
```

A prior run of the same task (different Claude Code session) used `.catch()` chaining instead, keeping the original arrow-function style.

Two approaches, both correct, different tradeoffs:

| | `.catch()` chain | `async/await + try/catch` |
|---|---|---|
| Lines added | +2 per function | +6 per function |
| Style | Keeps original arrow function | Rewrites to named async function |
| `async` on signature | No | Yes |

This is the kind of choice race mode surfaces. With `raceFinalize: defer`, you see both diffs before any code lands in your repo.

**Winner selected:** claude-sonnet — `async/await` style preferred for this codebase.

---

## Real-provider race round 2: same task, models agree (2026-06-01)

**Task:** Add error handling to `drillDownSource`, `getTopic`, `getGlobal` in the same file.

Both opus and sonnet produced **identical diffs** — same `async/await + try/catch` structure, same error message format.

This is the other half of the story: when the task is unambiguous, race candidates converge. Agreement across two independent model runs is stronger evidence than a single output. You can apply either with confidence.

**Winner selected:** claude-opus (candidate 0, arrived first).

---

## Real-provider race round 3: claude-code vs opencode (DeepSeek) + Gemini review (2026-06-01)

**Task:** Wrap the `runSearch` function in `src/components/MemorySearch.tsx` with `useCallback`.  
**Config:** claude-code (implement) × opencode/DeepSeek (implement) race, gemini (review, text mode)

### Results

**claude-code** produced a clean, minimal diff:
```diff
-import { useEffect, useRef, useState } from "react";
+import { useCallback, useEffect, useRef, useState } from "react";

-  async function runSearch(q: string, topK: number) {
+  const runSearch = useCallback(async (q: string, topK: number) => {
     ...
-  }
+  }, []);
```

**opencode (DeepSeek)** produced no changes. DeepSeek v4 did not modify the file.

**Gemini review** verdict: `NEEDS_REVISION` — the `useCallback` with an empty dependency array `[]` may suppress the linter's exhaustive-deps rule if `runSearch` references state values that should be deps.

### What this shows

Three different outcomes in a single race:
1. claude-code identified and applied the correct transformation
2. opencode/DeepSeek produced no output (model declined or misunderstood the task)
3. Gemini flagged a real correctness concern the implement step missed — empty `[]` in `useCallback` when the function closes over `setIsLoading`, `setError`, etc.

**Winner selected:** claude-code (candidate 0). The Gemini feedback is valid but the change itself is still correct — `setIsLoading` and `setError` are stable React state setters and safe to omit from deps.

### Key takeaway for this race combination

Gemini in `mode: "text"` works as a reviewer via stdin pipe (`--yolo` flag, no `-p` needed for v0.44+). opencode runs via `subprocess.run(capture_output=True)` without PTY and writes files correctly. Claude Code + OpenCode + Gemini is a functional three-provider pipeline.

---

## Real-provider race round 4: claude-code vs opencode/DeepSeek — genuine divergence (2026-06-01)

**Task:** Create `src/utils/format.ts` with three utility functions: `formatFileSize`, `formatRelativeTime`, `truncateText`.  
**Note:** Task was "write from scratch" — no existing file to find, so opencode's project-context issue didn't apply.

### What each model produced

**claude-code** — compact, no JSDoc, `string`-only input:
```typescript
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  // ...
}

export function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds} seconds ago`;
  // if-chain...
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}
```

**opencode/DeepSeek** — JSDoc, `string | Date` input, `intervals` array, edge cases:
```typescript
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${sizes[i]}`;
}

export function formatRelativeTime(dateInput: string | Date): string {
  // intervals array: year, month, week, day, hour, minute
  // also handles future dates ("2 hours from now")
}

export function truncateText(text: string, maxLength: number): string {
  if (maxLength <= 3) return text.slice(0, maxLength);  // edge case
  return text.slice(0, maxLength - 3) + '...';
}
```

### Key differences

| Dimension | claude-code | DeepSeek |
|-----------|-------------|---------|
| `formatRelativeTime` input type | `string` only | `string \| Date` |
| `formatFileSize` precision | `.toFixed(1)` | `.toFixed(2)` + bounds check |
| `truncateText` edge case | not handled | `maxLength <= 3` guard |
| Future dates | not supported | "2 hours from now" |
| Week unit | not included | included |
| Code style | compact, no JSDoc | verbose, full JSDoc |

### Why this matters

Both implementations are correct. DeepSeek's is more defensive and API-rich; claude-code's is simpler and covers the specified requirements exactly. Neither is wrong — this is a genuine design choice. With `raceFinalize: defer`, you would see both diffs and pick based on your codebase's convention (verbose+documented vs compact+minimal).

**Winner selected:** DeepSeek/opencode (landed in working tree via `git apply`; claude-code's version also available in worktree for comparison).

### Infrastructure note

`git apply --3way` fails for brand-new files (no 3-way base). The patch still applies cleanly without `--3way`. Fixed in task_runner + workspace_manager.

---

## Real-provider race round 5: claude-code vs gemini-acp (2026-06-01)

**First race using Gemini CLI v0.45.0 ACP mode** — agent-write via JSON-RPC stdio, no PTY.

**Task:** Extract four pure utility functions from `src/components/SourcePanel.tsx` into a new `src/utils/source-utils.ts`.

### What each model produced

**claude-code** — complete implementation:
- Created `src/utils/source-utils.ts` with all four exported functions + `BADGE_COLORS` constant
- Updated `SourcePanel.tsx` to import from the new file
- Result: compiles and works correctly

**gemini-acp (Gemini 2.5 Pro via ACP)** — incomplete:
- Updated `SourcePanel.tsx` to remove the functions and add the import line
- Did **not** create `src/utils/source-utils.ts`
- Result: broken state — TypeScript would error because the import target doesn't exist

### Why this matters

This is the scenario race mode is designed for. Without race, you would have applied Gemini's incomplete output and discovered the compile error only at build time. With `raceFinalize: defer`, both diffs are visible before any code lands.

Gemini's output is "plausible but wrong" — it understood the task conceptually (remove from SourcePanel, add import) but missed half the work (create the target file). Claude Code completed both sides.

**Winner selected:** claude-code (candidate 0).

### ACP infrastructure note

Gemini's `workspacePath` showed as `n/a` in the checkpoint because ACP does not commit changes — files are modified unstaged. The diff was visible via `git diff HEAD` in the worktree. The race apply mechanism fell back to direct file copy after `git apply --3way` found a conflict with the already-written import stub.

This is an infrastructure gap to fix: ACP delegate should commit its changes (or at least stage them) so the normal worktree-based apply path works cleanly.

**Fixed in subsequent commit**: `_run_delegate_acp()` now runs `git add -A && git commit` after session/prompt completes. See Round 6 below.

---

## Real-provider race round 6: claude-code vs gemini-acp — Gemini wins with stricter typing (2026-06-01)

**First race where both ACP candidates have `workspacePath`** (after the ACP commit fix).

**Task:** Add `SupportedSourceType = 'obsidian' | 'github' | 'notion'` type alias to `src/utils/source-utils.ts` and use it in `badgeColor`'s signature.

### What each model produced

**claude-code** — minimal change, keeps `BADGE_COLORS` loosely typed:
```diff
+export type SupportedSourceType = 'obsidian' | 'github' | 'notion';

-export function badgeColor(sourceType: string): string {
+export function badgeColor(sourceType: SupportedSourceType): string {
```

**gemini-acp (Gemini 2.5 Pro)** — more thorough, tightens the whole chain:
```diff
+export type SupportedSourceType = "obsidian" | "github" | "notion";

-const BADGE_COLORS: Record<string, string> = {
+const BADGE_COLORS: Record<SupportedSourceType, string> = {

-export function badgeColor(sourceType: string): string {
-  return BADGE_COLORS[sourceType.toLowerCase()] ?? "#888";
+export function badgeColor(sourceType: SupportedSourceType): string {
+  return BADGE_COLORS[sourceType] ?? "#888";
```

### Key differences

| | claude-code | gemini-acp |
|---|---|---|
| `BADGE_COLORS` key type | `string` (unchanged) | `SupportedSourceType` (tightened) |
| `.toLowerCase()` | kept | **removed** (redundant once type is exact) |
| Quote style | single | double |

Gemini identified that once `sourceType` is typed as `SupportedSourceType`, the `.toLowerCase()` call is both unnecessary and potentially incorrect (it would allow `"Obsidian"` but the literal type doesn't include it). Claude Code's change was correct but incomplete.

### Why this matters

This is the scenario race mode exists for: both outputs compile and pass a quick review, but one is strictly better. With `raceFinalize: defer` you see both diffs in your terminal before either lands in your repo.

**Winner selected:** gemini-acp (candidate 1).

### Infrastructure note

This is the first race where the ACP commit fix was active. Both `claude-code` and `gemini-acp` show `workspacePath` in the checkpoint, and the winner was applied via the normal worktree path (`appliedVia: "workspace"`) — no manual file copy required.
