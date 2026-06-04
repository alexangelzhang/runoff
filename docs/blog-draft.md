# I stopped letting AI review its own code

*Posted to dev.to / personal blog*

---

There's a flaw in almost every AI coding workflow I've seen, including my own for the first six months: I was using the same model to write code and verify it.

Claude writes the function. Claude reviews the function. Claude decides whether the tests are sufficient.

It feels reasonable. Claude is good at code review. But there's a structural problem I kept running into before I could name it.

---

## The blind spot problem

I had Claude add input validation to an API endpoint. It wrote clean, idiomatic TypeScript. I asked it to review the diff. It approved it. Tests passed. I shipped it.

Two days later a colleague pointed out that the validation silently accepted empty strings — which the original spec explicitly prohibited. Claude had written the validator, approved it, and neither caught the gap.

When I went back and asked Claude *why* it missed it, the answer was essentially: "I interpreted the requirement as non-null rather than non-empty, which is a reasonable reading."

That's exactly the problem. A model that wrote subtly wrong code doesn't just fail to catch the bug — it *actively defends* its interpretation. It doesn't have independent judgment about its own output. It has motivated reasoning.

Human code review works because reviewers bring different priors. A senior engineer who didn't write the code asks different questions than the person who did. They notice different things. They haven't already committed to an interpretation.

The same principle applies to LLMs. The model that wrote your function and the model that reviews it shouldn't share weights.

---

## What I tried first

The obvious fix is to use a second model for review. Have Claude write, have GPT-5 or Codex review.

This helps. It's not a complete solution.

The problem is that most orchestration setups run these models sequentially on the same output. Claude produces a diff. You pipe that diff to Codex and ask it to review. Codex can catch logical errors that Claude missed.

But now you have a different problem: Codex is reviewing someone else's implementation choices. It might flag valid decisions as bugs, or miss problems that are specific to how Claude structured the code. You end up with noisy reviews and unclear signal about which model actually produces better output for *your* use case.

I wanted something different. I wanted to know: **for this specific task, in this specific codebase, which model writes better code?**

---

## Racing instead of reviewing

The answer I landed on was running both models on the same task simultaneously.

Give Claude Code and Codex the identical prompt. Let them each produce a full implementation in parallel, isolated git worktrees so they can't interfere with each other. Then compare the two outputs side by side and pick.

```
$ npx runoff run \
    --prompt "Add formatRelativeTime() to src/utils/format.ts" \
    --config pipeline.config.json

Running race: claude-code vs opencode/DeepSeek...

  candidate 0  (claude-code)      +27 lines
    formatRelativeTime(isoString: string)
    handles: seconds, minutes, hours, days
    no future date support

  candidate 1  (opencode/DeepSeek) +60 lines
    formatRelativeTime(dateInput: string | Date)
    handles: seconds, minutes, hours, days, weeks
    future dates ("2 hours from now")
    edge cases: null, invalid date, DST boundary

Pipeline paused — awaiting judge decision.

$ npx runoff race apply --session abc123 --winner 1
✓ Merged candidate 1. Worktree 0 cleaned up.
```

The race pause is intentional. I don't want the system to automatically pick a winner. The whole point is that *I* decide, because I know what matters for my codebase. Does the function need to handle `Date` objects? Is future-date support worth the extra complexity? Only I know.

This is the key insight: **the race is not trying to determine which model is objectively better. It's trying to surface the trade-offs so a human can make an informed decision.**

---

## What I learned from running 50+ races

After a few weeks of this workflow, some patterns emerged.

**Model strengths are task-specific and codebase-specific.** In my TypeScript API codebase, Claude Code consistently produces more idiomatic code that matches my existing style. But for Go utility functions and data processing scripts, Codex/DeepSeek tends to produce more comprehensive implementations that handle more edge cases. Neither is universally better.

**The races that surprised me most were the most valuable.** When I expected Claude to win and Codex produced a clearly superior implementation, that was information I wouldn't have gotten from a single-model workflow. And vice versa.

**Prompt phrasing interacts with model strengths in unexpected ways.** "Add validation" produces very different relative results from "Add validation to reject empty strings, null, and strings over 255 characters." The same models, different specs, different winner.

**Over time, I started to predict which model would win on which type of task.** That meta-knowledge is now more valuable to me than any individual race outcome.

---

## The memory angle

The pattern I noticed — "Codex tends to be more thorough on utility functions, Claude tends to match my style better on API handlers" — is the kind of thing I wanted the system to learn and use.

That's what the Dream system in runoff does. Every race you run produces a trace. When you pick a winner, the system records which provider won, what kind of task it was, which files were involved. Over time it builds a pattern library from your actual picks.

When you start a new race, runoff retrieves relevant past patterns: "In similar utility function tasks involving `src/utils/`, you've picked Codex 7 out of 9 times." That doesn't determine the race outcome — you still see both diffs and decide — but it gives you context from your own history.

The retrieval uses a multi-strategy approach (semantic similarity, keyword matching, file-path graph hops, entity matching) fused with a weighted ranking that the system tunes based on which patterns actually correlated with your picks. After enough races, the system knows which retrieval strategy works best for your codebase.

It's a slow accumulation. After 10 races you have weak signal. After 50 you have something useful. After 100 you have a surprisingly good model of your own taste.

---

## How this compares to other approaches

**vs. single-model review:** The fundamental limitation is the shared-weights problem. A model reviewing its own code has motivated reasoning. Racing gives you genuinely independent assessments.

**vs. Vibe Kanban / parallel agent dashboards:** These tools run different agents on different tasks in parallel to increase throughput. That's a different problem — scale and speed. runoff runs different agents on the *same* task to improve quality. The goals are orthogonal.

**vs. Cadence's role-split approach:** Cadence uses different models for different SDLC phases: Claude writes, Codex reviews, Gemini sits on the architectural council. This is smart — it breaks the shared-weights problem at the phase level. The difference is that runoff compares *outputs* from the same phase rather than *roles* in different phases. You learn which model produces better first-pass implementations for your specific task types, not just which model is better at review in general.

**vs. manually running both models:** You can absolutely do this by hand — open Claude Code in one terminal, Codex in another, give them the same prompt, compare the diffs yourself. runoff automates the isolation (separate worktrees, no cross-contamination), the parallel execution, the diff surfacing, the trace logging, and the pattern accumulation. The workflow is the same; the overhead is much lower.

---

## The practical setup

runoff works as an MCP server, so it integrates with Claude Code, Cursor, and Claude Desktop without leaving your IDE:

```json
{
  "mcpServers": {
    "runoff": {
      "command": "npx",
      "args": ["runoff", "mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

A race config is just an array in your pipeline JSON:

```json
{
  "pipeline": {
    "implement": [["claude-code", "opencode"]],
    "review":    ["claude-code", "implement"]
  }
}
```

The `[["claude-code", "opencode"]]` syntax means "run both in parallel and pause for a judge decision." A single string would run that provider sequentially. The pipeline continues after you pick.

---

## What I don't know yet

A few open questions I'm still working through:

**Does the accumulated pattern memory actually help?** Anecdotally yes — I've noticed that retrieval surfaces relevant context when I start a new race. But I haven't run a controlled experiment comparing race outcomes with and without pattern retrieval.

**What's the right race cadence?** I don't race every task — that would double my token spend and slow things down. I race tasks where I have genuine uncertainty about the implementation approach, or where I've been burned by a model's blind spots before. Finding the right selection criteria is still intuition more than system.

**Does this work at team scale?** The current setup is single-user. Pattern memory is per-machine. I haven't thought through what it would look like to share race history across a team, or whether team patterns would be useful or just noisy.

---

## Try it

```bash
npx runoff init --work-dir /path/to/your/repo
npx runoff run --prompt "your task here"
```

The `init` command generates a `pipeline.config.json` for your repo. The demo mode (`npm run demo`) runs with mock providers if you want to see the race mechanics before connecting real backends.

Source: [github.com/alexangelzhang/runoff](https://github.com/alexangelzhang/runoff)

If you've built something similar or have a different take on the shared-weights problem, I'd be interested to hear it.
