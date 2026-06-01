# Race Mode: Real-World Examples

> 6 races across real codebases. Real providers. Real design decisions.  
> This page documents what actually happened — not what mock benchmarks predict.

---

## Summary

| # | Providers | Task type | Outcome |
|---|-----------|-----------|---------|
| [1](#round-1-same-task-different-style) | claude-code vs claude-code (two sessions) | Error handling | Two valid approaches, different style |
| [2](#round-2-both-models-agree) | claude-opus vs claude-sonnet | Error handling | Identical output — strong confidence |
| [3](#round-3-one-model-produces-nothing) | claude-code vs opencode/DeepSeek + Gemini review | useCallback wrap | One model no-op; reviewer catches bug |
| [4](#round-4-genuine-design-divergence) | claude-code vs opencode/DeepSeek | New utility file | Compact vs defensive+JSDoc |
| [5](#round-5-gemini-acp-misses-half-the-task) | claude-code vs gemini-acp | Extract to module | One model produces broken state |
| [6](#round-6-gemini-wins-stricter-typing) | claude-code vs gemini-acp | Add type alias | Gemini catches unnecessary `.toLowerCase()` |

---

## Round 1: Same task, different style

**Task:** Add error handling to 3 functions in `src/lib/tauri.ts`.  
**Config:** `raceFinalize: defer` (manual pick)

Two independent Claude Code sessions given the same task produced different implementations:

**Session A** — `.catch()` chaining, keeps original arrow function:
```diff
-export const searchMemory = (query: string, topK = 10): Promise<SearchResult[]> =>
-  invoke<SearchResult[]>("search_memory", { query, topK });
+export const searchMemory = (query: string, topK = 10): Promise<SearchResult[]> =>
+  invoke<SearchResult[]>("search_memory", { query, topK })
+    .catch((e) => { throw new Error(`searchMemory failed: ${e}`); });
```

**Session B** — `async/await + try/catch`, rewrites to named async function:
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

| | `.catch()` chain | `async/await + try/catch` |
|---|---|---|
| Lines added | +2 per function | +6 per function |
| Style | Preserves original arrow function | Rewrites to named async function |
| `async` on signature | No | Yes |

Both are correct. The right choice depends on codebase convention. Without race mode, you get one — whichever session ran first.

**Winner selected:** Session B (`async/await` style preferred for this codebase).

---

## Round 2: Both models agree

**Task:** Add error handling to `drillDownSource`, `getTopic`, `getGlobal` in the same file.  
**Providers:** claude-opus vs claude-sonnet

Both models produced **identical diffs** — same `async/await + try/catch` structure, same error message format, same line count.

When two independent models produce identical output, you have stronger evidence that the approach is unambiguous. Agreement is more informative than the output alone: you can apply either candidate with confidence.

**Winner selected:** claude-opus (arrived first).

---

## Round 3: One model produces nothing; reviewer catches a bug

**Task:** Wrap `runSearch` in `src/components/MemorySearch.tsx` with `useCallback`.  
**Providers:** claude-code vs opencode/DeepSeek (implement), gemini (review, text mode)

**claude-code** — correct, minimal:
```diff
-import { useEffect, useRef, useState } from "react";
+import { useCallback, useEffect, useRef, useState } from "react";

-  async function runSearch(q: string, topK: number) {
+  const runSearch = useCallback(async (q: string, topK: number) => {
     ...
-  }
+  }, []);
```

**opencode/DeepSeek** — produced no changes. The model did not modify the file.

**Gemini review** verdict: `NEEDS_REVISION` — the `useCallback` with an empty dependency array `[]` may suppress the linter's exhaustive-deps rule if `runSearch` closes over state that should be listed as deps.

Three outcomes from a single race run:
1. claude-code applied the correct transformation
2. opencode/DeepSeek declined (no output)
3. Gemini flagged a real correctness concern the implement step missed

The Gemini feedback is valid — though `setIsLoading` and `setError` are stable React state setters, the empty `[]` is worth documenting. Without race mode running a separate reviewer, this would have merged silently.

**Winner selected:** claude-code (candidate 0).

---

## Round 4: Genuine design divergence

**Task:** Create `src/utils/format.ts` with `formatFileSize`, `formatRelativeTime`, `truncateText`.  
**Providers:** claude-code vs opencode/DeepSeek

**claude-code** — compact, `string`-only inputs, covers specified requirements exactly:
```typescript
export function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds} seconds ago`;
  // if-chain for minutes, hours, days
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}
```

**opencode/DeepSeek** — JSDoc, `string | Date` input, intervals array, edge cases:
```typescript
export function formatRelativeTime(dateInput: string | Date): string {
  // intervals array: year, month, week, day, hour, minute
  // handles future dates: "2 hours from now"
}

export function truncateText(text: string, maxLength: number): string {
  if (maxLength <= 3) return text.slice(0, maxLength);  // edge case guard
  return text.slice(0, maxLength - 3) + '...';
}
```

| Dimension | claude-code | opencode/DeepSeek |
|-----------|:-----------:|:-----------------:|
| `formatRelativeTime` input | `string` | `string \| Date` |
| Future dates | — | ✅ "2 hours from now" |
| Week unit | — | ✅ included |
| `truncateText` edge case (`maxLength <= 3`) | — | ✅ guarded |
| JSDoc | — | ✅ full |
| `formatFileSize` byte boundary | `.toFixed(1)` | `.toFixed(2)` + zero check |

Neither is wrong. DeepSeek is more defensive and API-rich; claude-code is simpler and matches the spec exactly. The right choice depends on whether this utility will be called by external consumers (where the wider API surface is valuable) or internal code only (where the simpler version is easier to maintain).

**Winner selected:** opencode/DeepSeek.

---

## Round 5: One model produces broken state

**Task:** Extract four functions from `src/components/SourcePanel.tsx` into `src/utils/source-utils.ts`.  
**Providers:** claude-code vs gemini-acp (Gemini 2.5 Pro via ACP)

**claude-code** — complete:
- Created `src/utils/source-utils.ts` with all four exported functions + `BADGE_COLORS` constant
- Updated `SourcePanel.tsx` to import from the new module
- Result: compiles correctly

**gemini-acp** — incomplete:
- Updated `SourcePanel.tsx` (removed the functions, added the import line)
- Did **not** create `src/utils/source-utils.ts`
- Result: broken — TypeScript would error because the import target doesn't exist

Gemini's output is "plausible-looking but wrong" — it understood the task conceptually but missed creating the target file. Without `raceFinalize: defer`, you would have applied this output and discovered the compile error at build time.

**Winner selected:** claude-code (candidate 0).

---

## Round 6: Gemini wins with stricter typing

**Task:** Add `SupportedSourceType = 'obsidian' | 'github' | 'notion'` type alias to `src/utils/source-utils.ts` and use it in `badgeColor`'s signature.  
**Providers:** claude-code vs gemini-acp (Gemini 2.5 Pro)

**claude-code** — minimal, correct:
```diff
+export type SupportedSourceType = 'obsidian' | 'github' | 'notion';

-export function badgeColor(sourceType: string): string {
+export function badgeColor(sourceType: SupportedSourceType): string {
```

**gemini-acp** — more thorough, tightens the whole chain:
```diff
+export type SupportedSourceType = "obsidian" | "github" | "notion";

-const BADGE_COLORS: Record<string, string> = {
+const BADGE_COLORS: Record<SupportedSourceType, string> = {

-export function badgeColor(sourceType: string): string {
-  return BADGE_COLORS[sourceType.toLowerCase()] ?? "#888";
+export function badgeColor(sourceType: SupportedSourceType): string {
+  return BADGE_COLORS[sourceType] ?? "#888";
```

| | claude-code | gemini-acp |
|---|---|---|
| `BADGE_COLORS` key type | `string` (unchanged) | `SupportedSourceType` ✅ |
| `.toLowerCase()` | kept | removed — redundant once type is exact |

Gemini identified that once `sourceType` is typed as `SupportedSourceType`, `.toLowerCase()` is both unnecessary and potentially incorrect (it would accept `"Obsidian"` as valid input at runtime, but the literal type rejects it at compile time — an inconsistency). Claude Code's change was correct but incomplete.

Both compile. One is strictly better.

**Winner selected:** gemini-acp (candidate 1).

---

## What these 6 races show

**Race mode is not about which model scores higher in aggregate.** It's about the specific task in front of you, right now, in your codebase.

The pattern across these 6 rounds:

| Scenario | Frequency | What race gives you |
|----------|:---------:|---------------------|
| Models diverge on design | 3/6 | An explicit choice you'd otherwise miss |
| Models agree | 1/6 | Stronger confidence in the output |
| One model fails or is incomplete | 2/6 | The other candidate as a safety net |

In 2 out of 6 runs, applying the first candidate without seeing the second would have produced either suboptimal code (Round 4, 6) or broken code (Round 5). That's 33% of runs where the second candidate was material.

The token cost overhead of race mode is ~87% on top of a single run (1824 vs 974 avg tokens, per mock benchmark). On real providers with early termination, the overhead is lower — the losing provider is aborted once a viable winner arrives.

---

## Running your own race

```json
{
  "pipeline": {
    "implement": [["claude-code", "opencode"]],
    "review": ["claude-code", "implement"]
  },
  "runtime": {
    "raceFinalize": "defer"
  }
}
```

```bash
npx runoff run --prompt "your task" --work-dir /path/to/repo
# pipeline pauses at awaiting_judge
npx runoff race apply --session <id> --winner 0
```

Full mechanics: [race-mode.md](../features/race-mode.md)
