# Race Mode: Running Multiple LLMs on the Same Task

When you ask a single LLM to refactor a function, you get one answer. It might be good. It might miss an edge case. You have no way to know without reading it carefully yourself.

Race mode runs multiple LLMs on the same pipeline step simultaneously, then picks or merges the best result. The rest of this document explains what that actually means in practice, where the idea comes from, and how the implementation handles the details that make it work reliably.

---

## Why one answer isn't enough

Code generation has an asymmetric error profile. Most of the time, any decent model gets the straightforward parts right. The failures are concentrated in the places where the task is underspecified, where two approaches are both defensible, or where a model's training data overrepresents a pattern that doesn't fit your codebase.

The problem is that you can't tell from a single response whether you're looking at a straightforward case or an edge case. The confidence level in the output doesn't correlate well with whether the output is actually correct.

Running multiple models changes this. If Codex and Gemini both produce structurally similar refactors, you have much stronger evidence that the approach is reasonable. If they diverge significantly — one adds error handling, one doesn't; one changes the interface signature, one doesn't — that divergence itself is useful information. It tells you there's a decision point worth thinking about.

This is not a new idea. It shows up in ensemble methods in classical ML, in CI/CD matrix jobs that run tests across multiple environments, and more recently in academic work on LLM output quality. The [Mixture-of-Agents paper](https://arxiv.org/abs/2406.04692) from Together AI (2024) demonstrated that having multiple LLMs generate candidates and then synthesizing the results consistently outperforms any individual model. The mechanism here is simpler than MoA — we're selecting or merging rather than synthesizing — but the motivation is the same.

---

## How it's configured

Race mode is enabled by putting multiple providers in a pipeline step as an array:

```json
{
  "pipeline": {
    "refactor": [["openai-pro", "openai-lite"], "analyze"]
  }
}
```

The inner array `["openai-pro", "openai-lite"]` tells the pipeline to run both providers in parallel for the `refactor` step, wait for results, then resolve them using one of three strategies.

A more complete config with explicit strategy and budget:

```json
{
  "providers": {
    "openai-pro": { "type": "openai", "model": "gpt-4o" },
    "gemini-pro":  { "type": "openai", "model": "gemini-2.5-pro", "baseUrl": "..." }
  },
  "pipeline": {
    "implement": [["openai-pro", "gemini-pro"]],
    "review":    ["openai-pro", "implement"]
  },
  "orchestration": {
    "raceBudgetUSD": 0.10,
    "raceEarlyTermination": true,
    "raceResolution": "auto-merge"
  },
  "runtime": {
    "raceFinalize": "defer"
  }
}
```

---

## What happens when the race runs

All providers in the race step start simultaneously. They get the same prompt, the same context, the same task description. Each one runs independently in its own git worktree — an isolated copy of the repository at the same base commit.

The execution layer watches for results as they arrive. When the first viable response comes back, it checks `raceEarlyTermination`. If that's true (the default), it sends an abort signal to the remaining providers. They may or may not stop immediately depending on how far along they are, but the point is to avoid paying for responses you don't need once you already have a winner.

After all providers have either responded or been aborted, the pipeline has a set of candidate outputs. What happens next depends on the resolution strategy.

---

## Resolution strategies

### pick-winner

The default. One output is selected; the others are discarded.

Selection criteria, in order:
1. Eliminate failed responses (API errors, timeouts, refused requests)
2. For text-mode responses, eliminate outputs with invalid TypeScript/JavaScript syntax
3. Among remaining candidates, take the first

This is conservative. It makes no claim about which output is semantically better — just that it compiled and didn't error. For most cases, this is sufficient, because the real quality gate is the `review` step that follows.

### auto-merge

When providers touched different files, their changes can be combined automatically. Provider A refactored `auth.ts`, provider B added error handling to `api.ts` — these are non-overlapping and can be merged without conflict.

The implementation checks for file-level conflicts before attempting a merge. If any file appears in more than one candidate's `filesModified`, auto-merge falls back to pick-winner rather than attempting a three-way merge.

### llm-merge

When you want to combine overlapping changes and are willing to spend another LLM call to do it. The merge candidates are sent to a third provider with a prompt asking it to synthesize a coherent implementation. This is the most expensive option and produces the most integrated result.

The prompt sent for llm-merge looks like this:

```
Merge the following parallel outputs into one coherent implementation.
Preserve all non-overlapping file changes. If two candidates edit the same file, prefer the more complete version.
Return only the merged code or unified diff in a fenced code block.

Task: <original task description>

### openai-pro
<candidate 1 output>

### gemini-pro
<candidate 2 output>
```

---

## The `defer` vs `auto-pick` decision

After the race step completes, the pipeline can do one of two things:

**`raceFinalize: "defer"`** (default) — the pipeline pauses and surfaces both candidates to you via `runoff_race_apply`. You look at them, pick the one you want (or abort), and the pipeline continues. The losing candidates' worktrees are cleaned up.

**`raceFinalize: "auto-pick"`** — the pipeline applies the winner automatically (using `raceWinnerIndex` from the resolution step) and continues without interruption. Useful for CI pipelines where human review isn't part of the flow.

The `defer` mode is what makes race useful for interactive development. You can see what each model actually produced, diffed against the base commit, before any changes land in your repo. The review step's feedback is available in the trace, so you can make an informed choice.

---

## Cost and what it actually spends

Running two providers costs roughly twice as much as running one. Race mode does two things to limit this:

**Early termination**: once the first viable result arrives, remaining providers are aborted. In practice, fast providers (especially smaller models) often complete 20–40% faster than larger ones. If you're racing a fast lite model against a pro model, the lite model frequently finishes first. If its output passes the syntax check, the pro model is aborted before it finishes generating. You pay for the lite model plus whatever fraction of the pro model's generation completed.

**Budget cap**: `raceBudgetUSD` sets a ceiling on what a single race step can cost. If the combined cost of running providers hits this limit, remaining providers are aborted regardless of whether a winner has been found yet.

Both of these are tracked per-race using a local cost accumulator, separate from the pipeline-wide `costBudgetUSD`. This means you can set a tight race budget without affecting the overall pipeline budget limit.

---

## Workspace isolation during a race

Each provider in a race runs in its own git worktree — a separate directory pointing at the same repository but checked out independently. This matters because agent-mode providers (Codex, Gemini CLI) actually execute code and write files during the pipeline step. Without isolation, concurrent writes from two providers would corrupt each other's state.

The worktrees are created at race start and cleaned up after the winner is applied (or the race is aborted). The winner's worktree has its changes applied to the main repo via `git apply --3way`. The losers' worktrees are deleted.

If you're using defer mode and inspect the candidates before picking, both worktrees exist during that window. The `runoff_race_apply` response includes the working paths, so you can examine them directly if needed.

---

## When to use it

Race mode is worth the extra cost in two situations:

**High-stakes steps** — a refactor that touches core business logic, a migration that's hard to test, code that will be read more than written. The extra provider call is cheap compared to the cost of a review cycle catching a subtle error.

**Disagreement as a signal** — when you're not sure whether there's a correct answer. If you're refactoring an API and aren't certain whether the new interface should be synchronous or async, watching what two different models decide (independently, with the same context) is a fast way to get a second opinion without asking anyone.

It's probably not worth it for routine boilerplate, small mechanical changes, or any step where you already know exactly what the output should look like. Race mode is a quality tool, not a speed tool.

---

## Example: two models diverge on error handling

Given a pipeline config with `["openai-pro", "gemini-pro"]` racing on an `implement` step:

```
Task: Add retry logic to the fetch_user() function when the API returns a 429.
```

Hypothetical scenario (simplified for illustration):

**openai-pro** produces:
```python
def fetch_user(user_id: str, max_retries: int = 3) -> User:
    for attempt in range(max_retries):
        resp = api.get(f"/users/{user_id}")
        if resp.status_code == 429:
            time.sleep(2 ** attempt)
            continue
        resp.raise_for_status()
        return User(**resp.json())
    raise RetryExhausted(f"fetch_user failed after {max_retries} retries")
```

**gemini-pro** produces:
```python
def fetch_user(user_id: str) -> User:
    resp = api.get_with_retry(f"/users/{user_id}", retry_on=[429])
    resp.raise_for_status()
    return User(**resp.json())
```

The first version implements retry inline. The second delegates to an existing `api.get_with_retry` helper. Both are valid. The divergence tells you something: there's an `api.get_with_retry` in the codebase, and Gemini found it while OpenAI didn't.

In defer mode, you'd see both diffs side by side and pick the second one — or send both to llm-merge to get a version that uses the helper but also controls the retry count.

This is the practical value of race mode: not that one model is always better, but that running two gives you information that running one doesn't.

---

## Related configuration

```jsonc
{
  "orchestration": {
    // Max USD for a single race step. Null = no per-race limit.
    "raceBudgetUSD": 0.10,

    // Abort losing providers after first viable winner (default: true).
    // Set false to always collect all outputs before resolving.
    "raceEarlyTermination": true,

    // How to pick between candidates:
    // "pick-winner"  — select one (default)
    // "auto-merge"   — merge if non-overlapping, else pick-winner
    // "llm-merge"    — use a third LLM call to synthesize
    "raceResolution": "pick-winner"
  },
  "runtime": {
    // "defer"     — pause and surface candidates via runoff_race_apply (default)
    // "auto-pick" — apply winner immediately without pausing
    "raceFinalize": "defer"
  }
}
```

Full schema: [`src/core/config.ts`](../../src/core/config.ts)
