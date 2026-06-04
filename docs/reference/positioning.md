# runoff Positioning

> Evidence basis: competitive analysis via AnySearch (2026-06), page extracts of Vibe Kanban / projd / Cadence, npm download data.
> This document is opinionated. Update when the market shifts.

---

## The one-sentence bet

**"3 AIs compete to write your code. You pick the winner. The system learns your taste."**

Everything else is implementation detail.

---

## What the market proved (2026-06)

| Claim we had | Reality | Action |
|---|---|---|
| "race mode has no direct competitor" | False — projd, Vibe Kanban, Cadence all do parallel/worktree | Stop leading with worktree or parallel as differentiators |
| "pipeline-as-code is our unique position" | False — Cadence has YAML pipeline, 16+ providers, better storytelling | Don't compete on "declarative config" alone |
| "we're early in a blue ocean" | False — Vibe Kanban has 26.8k ★, is the category leader | Accept red ocean, carve a niche |
| "same-task race + learn from picks has no competitor" | **True** | All-in on this atom |

**The only unoccupied position:** same-task race **×** human judge **×** learn from judgements (Dream/Dreamify).
No tier-1 competitor does all three. This is the moat.

---

## The positioning stack

```
AUDIENCE:   quality-obsessed engineers who don't trust a single AI's output
PROBLEM:    no way to know which provider writes better code for YOUR codebase/taste
SOLUTION:   run N providers on the same task, you pick, system remembers your picks
PROOF:      race mechanic (src/tools/race.ts) + Dream evidence-grounded memory
CONTRAST:   Vibe Kanban runs parallel tasks (fast), runoff races the same task (quality)
```

---

## What to CUT (stop mentioning as primary selling points)

These are real features but **not differentiators** — competitors have them too. Mention in feature docs, not in the pitch.

| Feature | Why cut from pitch | Where to mention instead |
|---|---|---|
| Git worktree isolation | Vibe Kanban, projd, Cadence all have it | `coding-agent-backends.md` |
| Parallel agent execution | Every tier-1 tool does this | Setup docs |
| Declarative JSON config | projd has JSON, Cadence has YAML | `architecture/structure.md` |
| MCP server | Good, but secondary to the race story | Getting-started guide |
| Multi-provider support | Cadence has 16+, we have 4 | Technical comparison |
| Local trace (no LangSmith) | Legitimate, but not the hook | Observability doc |

---

## What to ALL-IN on

### 1. Same-task race (the core atom)
Every marketing surface should lead with this.

**What it means:** Give runoff one prompt. It spins up two git worktrees, runs two different providers on the identical task, pauses, shows you both diffs, you pick. Not "different agents on different tasks" — the exact same task, two competitors.

**Why this matters (the story to tell):**
> A model that wrote subtly broken code is statistically the worst model to catch the bug in it — they share the same blind spots. The only fix is competition: same task, different models, you decide.
> (Cadence has a version of this insight for role-split; runoff's version is for output quality comparison.)

**Where it lives in code:** `src/tools/race.ts`, `llm_race_apply` / `llm_race_abort` MCP tools.

### 2. Learn from your picks (the retention hook)
This is what makes runoff a compounding tool, not a one-shot script.

**What it means:** Every time you pick a winner, the Dream/Dreamify system records the trace, extracts patterns (which provider won on what kind of task, under what context), decays stale patterns, and surfaces relevant past wins when you start a new race. The retrieval is multi-strategy (semantic + BM25 + graph hop) fused with RRF.

**Why this matters (the story to tell):**
> After 50 races, runoff knows that Codex beats Claude on Go refactors for your repo, and Claude wins on TypeScript API design. You didn't configure this — the system learned it from your picks.

**Where it lives in code:** `src/dream/`, `src/dreamify/`, `dreamify-scorer.ts` (evalBonus feeds human picks back into retrieval weight optimization).

**Current state (honest):** The evidence-grounded learning loop is architecturally complete. The tuner grid search does not yet include the 4-way fusion weights (semantic/BM25/graph/entity) — those are hardcoded. This is P1: adding them to `DreamifyRetrievalParams` closes the loop fully.

### 3. Auditable, evidence-grounded memory (the trust differentiator)
Every memory entry in runoff traces back to a specific pipeline run (`evidenceTraceId`). You can ask "why does runoff prefer Codex for this?" and the answer is a link to actual run traces — not a black-box embedding score.

**Contrast with Ruflo/similar tools:** Ruflo's "self-learning" is similarity-based (embedding drift, no evidence). runoff's memory is trace-grounded (each lesson = a real run outcome). This is auditable; theirs is not.

---

## How to tell the story (external comms)

### The one-liner
> "Run 3 AIs on the same code task. Pick the winner. The system remembers your taste."

### The 3-sentence pitch
> Most AI coding tools run one model and hope it gets it right. runoff runs two or three providers on the same task in parallel isolated worktrees, pauses for you to pick the best diff, and learns from your choices over time. After enough races, it knows which AI writes better code for your specific codebase and style.

### The contrast sentence (vs Vibe Kanban, the category leader)
> Vibe Kanban runs different agents on different tasks in parallel — that's fast. runoff runs different agents on the **same** task — that's quality.

### The contrast sentence (vs Cadence)
> Cadence uses different models for different SDLC roles (write/review/triage) — smart division of labor. runoff uses different models for the **same** role and lets you judge — direct quality comparison.

### What NOT to say
- ❌ "Another parallel agent tool" — sounds like Vibe Kanban
- ❌ "Pipeline as code" — sounds like Cadence
- ❌ "Worktree isolation" — table stakes, everyone has it
- ❌ "MCP-first" — good feature, not the hook
- ❌ "Self-learning AI" — too vague, sounds like Ruflo's unverified claims

---

## Target audience (narrow to win)

**Primary:** Individual engineers and small teams who:
- Already use Claude Code or Codex CLI
- Have been burned by an AI confidently writing subtly wrong code
- Care more about output quality than throughput
- Are comfortable with CLI tools and JSON config

**Not (yet):** Enterprise teams, teams that want a GUI dashboard, teams optimizing for speed over quality.

**Size:** Small. This is intentional. A 1k-star precision tool serving 500 quality-obsessed engineers beats a 500-star "yet another parallel agent" tool serving confused users.

---

## Executable checklist: next 30 days

### README / docs (no code required)
- [ ] **README first paragraph:** replace current description with the one-liner above
- [ ] **Add a 30-second GIF** to README showing: prompt → two worktrees running → pause → pick winner → merged. This single visual communicates race better than any paragraph.
- [ ] **Add "vs Vibe Kanban in one sentence"** contrast to README — most visitors will have heard of it
- [ ] Update `differentiation.md` slogan options to reflect the new positioning (done: file updated)

### Cold start (one-time)
- [ ] **Write one blog post:** "I stopped trusting a single AI to review its own code" — tell the single-model blind-spot story, position race as the answer. Post to dev.to or personal blog.
- [ ] **Show HN post** when README + GIF are ready. Title: "runoff – run 3 AIs on the same coding task, pick the winner"
- [ ] Search for `runoff` on npm and verify the package is findable with relevant keywords

### Code (highest ROI, closes the learning loop)
- [ ] **P1: Add fusion weights to `DreamifyRetrievalParams`** — add `semanticWeight`, `bm25Weight`, `graphWeight`, `entityWeight` to the grid axes so the tuner can data-drive them instead of using hardcoded values. This is the one code change that makes "learn from your picks" fully closed-loop.
- [ ] **P0 (surface the evidence trail):** When returning race results, include which past patterns matched and which evidenceTraceId they came from. Makes the "auditable memory" claim visible to users, not just an internal property.

---

## What success looks like at L2 (1k ★)

- 10–20 engineers who use runoff weekly and would miss it if it disappeared
- The phrase "same-task race" associated with runoff in at least one popular blog or HN thread
- `dreamify-tuner` has run enough real picks to produce measurably better retrieval than the hardcoded weights
- Someone other than the author has filed a GitHub issue

**Not:** 10k stars, enterprise contracts, or feature parity with Vibe Kanban. Those are L3/L4 goals that require a team.

---

## Related docs

- [`differentiation.md`](differentiation.md) — competitive comparison tables (updated 2026-06)
- [`race-showcase.md`](race-showcase.md) — race mode worked examples
- [`OPEN_SOURCE.md`](OPEN_SOURCE.md) — release checklist
