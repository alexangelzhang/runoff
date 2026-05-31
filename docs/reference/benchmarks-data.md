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
- Experiment data persisted to: `/var/folders/pb/q1dmxgb513xccz8nhv7s55nm0000gn/T/llm-pipeline-bench-GWWUVN/experiments.jsonl`
