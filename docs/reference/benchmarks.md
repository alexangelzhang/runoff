# Benchmarks

## Why there's no SWE-bench number here

SWE-bench measures whether an agent can resolve GitHub issues end-to-end — find the right files, write the fix, pass the tests — using a single model call or agent loop. It's a useful benchmark for that task.

llm-pipeline is infrastructure for building and running those loops, not a model or an agent itself. Asking for its SWE-bench score is like asking for the SWE-bench score of GitHub Actions.

What can be measured:

**Pipeline mechanics:**
- Does the DAG execute steps in dependency order? → `tests/unit/pipeline-runner.test.ts` (~50 cases)
- Does race mode abort losers after the first winner? → `tests/unit/race-execution.test.ts`
- Does git apply succeed after a race? → `tests/e2e/gate3-orchestrator.e2e.test.ts`
- Does checkpoint + resume preserve state across restarts? → state tests

**Real provider smoke:**
- Each release runs `npm run smoke:real:pre-release` against the configured CLI backends
- Results logged in `~/.llm-pipeline/traces/` and checked against `docs/reference/supported-backends.md`
- Nightly CI: `.github/workflows/real-provider-smoke-nightly.yml`

These tests verify that the pipeline layer does what it says. The quality of the code produced by a specific agent running inside the pipeline depends on that agent — Codex, Gemini, Claude Code — not on llm-pipeline.

---

## What race mode can demonstrate

The case for race mode isn't "model A scores 3% higher than model B on SWE-bench." It's that running two models on the same task gives you information that running one doesn't.

Concrete situations where this has mattered:

**Model A adds the feature inline; model B calls an existing helper.** If your codebase already has a `retry_with_backoff()` utility, the model that finds it produces a better result. Which model finds it depends on the task and the codebase — it's not predictable ahead of time.

**Model A uses the deprecated API; model B uses the current one.** Training data cutoffs differ across models. One may be up-to-date on your framework's latest idioms, the other may not.

**Both models make the same change.** When two models independently produce similar output, you have stronger evidence that the approach is reasonable. The agreement is more informative than the output itself.

The right way to evaluate race mode for your specific use case is to run it on 5–10 representative tasks from your codebase, look at the candidates that were produced, and decide whether having the choice was worth the extra cost. There's no substitute for this.

---

## Industry comparison reference

For a strategic comparison of llm-pipeline against LangGraph, CrewAI, AutoGen, and OpenHands:

→ [**differentiation.md**](differentiation.md) — feature matrix + architecture rationale  
→ [**industry-benchmark.md**](industry-benchmark.md) — pinned commit-level audit against 5 frameworks
