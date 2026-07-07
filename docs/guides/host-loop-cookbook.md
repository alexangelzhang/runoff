# Host Loop Cookbook

> Run recurring agent workflows with runoff as the **harness** and your MCP host as the **scheduler**.
> Vocabulary: [harness-vs-loop.md](harness-vs-loop.md).

runoff does not ship a cron daemon. The loop lives in the host: Cursor rules, Claude Code `/loop`, GitHub Actions, or systemd calling `runoff_run_pipeline` on a cadence.

Optional **context gathering** across repo, CI, chat, and tickets can live in [MFS](https://github.com/zilliztech/mfs) before each tick — see [mfs-context-layer.md](mfs-context-layer.md). runoff remains the **delivery harness**; MFS is not required.

## Minimal loop anatomy

```text
1. Scheduler fires (cron, Action, host /loop)
2. Host gathers context (STATE.md + optional MFS search→cat, or gh/CI paste)
3. runoff_run_pipeline(workDir, spec=summaries+refs+task)
4. Host reads PipelineResult.observation.status + loopAction + nextHint
5. Host updates STATE.md / notifies human / schedules next tick
```

## Scaffold a loop-ready repo

From the runoff checkout:

```bash
npm run pipeline:init -- --work-dir /path/to/your-repo --profile pr-babysitter
# or: daily-triage | ci-sweeper | feature | bugfix | mock
```

Creates:

| File | Purpose |
|------|---------|
| `pipeline.config.json` | Harness DAG (steps, providers, governance) |
| `AGENTS.md` | Build/test commands + loop non-goals (loop profiles) |
| `STATE.md` | Human-readable loop memory spine (loop profiles) |
| `PIPELINE.md` | Pointer to doctor / config edit |

Verify readiness:

```bash
npm run pipeline:doctor -- --config /path/to/your-repo/pipeline.config.json
```

Target **L1** (report-only) first, then **L2** (assisted fixes). See [harness-vs-loop.md](harness-vs-loop.md#readiness-levels-l1--l3).

## Pattern → profile mapping

| Loop pattern | Init profile | Default level | Suggested cadence |
|--------------|--------------|---------------|-------------------|
| [Daily Triage](https://github.com/cobusgreyling/loop-engineering/blob/main/patterns/daily-triage.md) | `daily-triage` | L1 report | 1d–2h |
| [PR Babysitter](https://github.com/cobusgreyling/loop-engineering/blob/main/patterns/pr-babysitter.md) | `pr-babysitter` | L2 assisted | 5–15m |
| PR Babysitter + provider race | `race-pr-babysitter` | L2 + judge | 5–15m |
| [CI Sweeper](https://github.com/cobusgreyling/loop-engineering/blob/main/patterns/ci-sweeper.md) | `ci-sweeper` | L2 cautious | 5–15m |

Example configs: [`examples/configs/`](../../examples/configs/).

## Optional: MFS context layer

When triage pulls from many silos (repo + CI artifacts + Slack + Jira), use [MFS](https://github.com/zilliztech/mfs) on the host **before** `runoff_run_pipeline`:

1. **`mfs-ingest`** — `mfs add` repo, `STATE.md`, connectors (once).
2. **`mfs-find`** — `mfs search "…"` then `mfs cat <uri>` for exact lines.
3. **Inject into prompt** — short excerpts + URI refs only (never raw search dumps).

Full contract, templates, and anti-patterns: **[mfs-context-layer.md](mfs-context-layer.md)**.

```text
/loop 15m PR babysitter:
1. Read STATE.md.
2. Use mfs-find for watchlist-related context; cat evidence.
3. Call runoff_run_pipeline with excerpt+URI prompt (see mfs-context-layer.md).
4. Honor observation.loopAction; update STATE.md.
```

Skip MFS for L1 / single-repo loops — `gh` + manual paste is enough.

## MCP host loop (Cursor / Claude Desktop)

Register runoff MCP (see [mcp-host-setup.md](mcp-host-setup.md)), then each tick:

```json
{
  "tool": "runoff_run_pipeline",
  "arguments": {
    "workDir": "/path/to/repo",
    "prompt": "PR Babysitter tick. Context:\n<paste gh pr list + CI summary>\nPrior STATE:\n<paste STATE.md>\nIf watchlist empty, triage only and exit.",
    "configPath": "/path/to/repo/pipeline.config.json"
  }
}
```

**Read the response in this order** ([observability.md](../features/observability.md)):

1. `observation.status` — `approved` | `failed` | `awaiting_approval` | `awaiting_judge` | …
2. `observation.nextHint` — what the host should do next
3. `observation.coverageGaps` — missing evidence; do not auto-merge if non-empty
4. `observation.loopAction` — `continue` | `stop_loop` | `escalate_human` (machine-readable loop control)
5. `checkpointFile` / run id — for resume

### Pause / resume branches

| `observation.status` | Host action |
|----------------------|-------------|
| `awaiting_approval` | Surface diff to human; resume with approval token (see [host-resume-ux.md](host-resume-ux.md)) |
| `awaiting_judge` | Call `runoff_race_apply` or `runoff_race_abort` after human picks winner (race-pr-babysitter fix step) |
| `failed` | Append to STATE.md; if `loopAction=stop_loop`, do not reschedule until reviewed |
| `approved` | Update STATE.md; optional git merge / PR comment (host-side) |

## Claude Code / Codex slash-loop style

Equivalent to loop-engineering starters — host owns the schedule string:

```text
/loop 15m PR babysitter tick:
1. Read STATE.md and gh pr list for this repo.
2. Call runoff_run_pipeline with combined context.
3. If observation.status is awaiting_approval, stop and notify me.
4. Otherwise update STATE.md with last action + timestamp.
5. If watchlist is empty, exit early (no fix steps).
```

Week 1: add **"triage only — no repo writes"** to the prompt while using `daily-triage` profile.

## GitHub Actions (event-driven)

Trigger on CI failure instead of blind polling:

```yaml
name: runoff-ci-sweeper
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]

jobs:
  triage:
    if: ${{ github.event.workflow_run.conclusion == 'failure' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm ci
        working-directory: path/to/runoff-checkout
      - name: Run harness
        env:
          RUNOFF_HOME: ${{ runner.temp }}/runoff
        run: |
          npx tsx scripts/ts/dev/pipeline-cli.ts run \
            --work-dir "${{ github.workspace }}" \
            --config "${{ github.workspace }}/pipeline.config.json" \
            --prompt "CI Sweeper: workflow ${{ github.event.workflow_run.name }} failed at ${{ github.event.workflow_run.html_url }}. Triage and propose minimal fix if actionable."
        working-directory: path/to/runoff-checkout
      - name: Upload observation
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: runoff-observation
          path: "${{ env.RUNOFF_HOME }}/traces/"
```

Adjust `path/to/runoff-checkout` and wire real CLI providers in `pipeline.config.json` before L2.

## Cost and kill switch

| Guard | Config / practice |
|-------|-------------------|
| Per-run USD cap | `runtime.costBudgetUSD` |
| Per-step retry cap | `retry.maxRounds` |
| Same-step loop cap | `runtime.governance.maxStepExecutionsPerStep` |
| Early exit | Host prompt: skip pipeline when STATE watchlist empty |
| Historical spend | `runoff_query_traces` with `aggregate: true` |
| Projected loop spend | `npm run pipeline:cost -- --config pipeline.config.json --cadence 15m` |

## STATE.md discipline

Loop-engineering uses `STATE.md` as the human-readable spine. runoff's machine-readable spine is **RunStore + Observation**; keep both:

- **STATE.md** — priorities, human overrides, "noise ignored"
- **Observation** — status, evidence refs, `nextHint` for the host's next tool call

Prune merged/resolved items every run. Escalate when the same PR appears 3+ days without progress.

## Phased rollout checklist

- [ ] `pipeline init --profile <pattern>` + doctor ≥ L1
- [ ] Week 1: report-only prompts (daily-triage or triage step only)
- [ ] Week 2: enable fix steps; `governance.approvalMode: defer`
- [ ] Week 3+: tighten denylist rules; set `costBudgetUSD`; measure trace spend

## Related

- [mfs-context-layer.md](mfs-context-layer.md) — optional MFS + runoff loop integration
- [harness-vs-loop.md](harness-vs-loop.md)
- [mock-to-real-cli.md](mock-to-real-cli.md)
- [host-resume-ux.md](host-resume-ux.md)
- [governance-config.md](../architecture/governance-config.md)
