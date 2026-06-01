---
layout: home

hero:
  name: "runoff"
  text: "Run two coding agents on the same task. Pick the winner."
  tagline: Multi-step code-change pipelines — race mode, git worktree isolation, local traces. MCP server + CLI.
  actions:
    - theme: brand
      text: Get started
      link: /guides/getting-started-30min
    - theme: alt
      text: See real races →
      link: /reference/race-showcase
    - theme: alt
      text: GitHub
      link: https://github.com/alexangelzhang/runoff

features:
  - icon: "🏁"
    title: Race mode
    details: Put two providers in an array. They run in parallel, each in its own git worktree. The pipeline pauses — you see both diffs and pick the winner before any code lands.
    link: /features/race-mode
    linkText: How race mode works
  - icon: "🔧"
    title: Config-first DAG
    details: pipeline.config.json defines your steps — implement, review, retry. No Python graph boilerplate. Compiles to an agent graph at runtime.
    link: /guides/getting-started-30min
    linkText: 30-minute guide
  - icon: "🔌"
    title: Host-agnostic
    details: MCP server for Cursor, Claude Desktop, Claude Code. Swap coding agents via config — Codex, Gemini, OpenCode, Claude Code. The pipeline layer stays the same.
    link: /guides/coding-agent-backends
    linkText: Coding agent backends
  - icon: "📊"
    title: Local observability
    details: "Traces and experiment logs at ~/.runoff/ — no LangSmith account needed. Query with MCP tools or inspect directly."
    link: /features/observability
    linkText: Observability docs
---

## Install

```bash
npx runoff init --work-dir /path/to/your/repo
```

Or clone for development:

```bash
git clone https://github.com/alexangelzhang/runoff.git && cd runoff
npm install && npm run demo
```

## Race mode in 60 seconds

```json
{
  "pipeline": {
    "implement": [["claude-code", "opencode"]],
    "review":    ["claude-code", "implement"]
  }
}
```

```
candidate 0  (claude-code)      formatRelativeTime(isoString: string)
candidate 1  (opencode/DeepSeek)  formatRelativeTime(dateInput: string | Date)
                                  + future dates, week unit, edge guards

npx runoff race apply --session abc123 --winner 1
```

→ [6 real races with diffs](/reference/race-showcase)

## Why not LangGraph / CrewAI / AutoGen?

Those are great for conversational multi-agent loops. runoff is for **repo-native code changes**: git worktrees, cross-process locks, patch apply, local traces. The output is a git diff, not a chat message.

→ [Full comparison](/reference/differentiation)
