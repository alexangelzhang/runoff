# Show HN Draft

> Status: ready — post after repo goes public  
> URL to update before posting: https://github.com/alexangelzhang/runoff

## Title

Show HN: runoff – run two coding agents on the same task, pick the winner

## Body

I built runoff, an MCP server + CLI that runs two coding agents on the same task in parallel — each in its own git worktree — then pauses for you to pick the winner before any code lands in your repo.

The core idea: instead of trusting one model's output blindly, you get to see two independent attempts at the same spec and choose. Sometimes they agree (which is itself useful signal — stronger confidence than a single run). Sometimes they diverge in interesting ways.

**6 real races I ran while building this:**

- Round 4: claude-code wrote a compact `formatRelativeTime(isoString: string)`. DeepSeek wrote one that accepts `string | Date`, handles future dates ("2 hours from now"), and guards `maxLength <= 3`. Neither is wrong — it's a design choice. I'd have never seen the tradeoff without race mode.

- Round 5: Gemini was given "extract these functions into a new module." It updated the import in the original file but never created the target file. claude-code did both. Without the race, I'd have applied Gemini's output and gotten a TypeScript compile error.

- Round 6: claude-code added the type alias and updated the function signature. Gemini also tightened `BADGE_COLORS: Record<SupportedSourceType, string>` and removed a now-redundant `.toLowerCase()` call — the kind of secondary inference a human reviewer would catch. Gemini won.

Full diffs for all 6 rounds: https://github.com/alexangelzhang/runoff/blob/main/docs/reference/race-showcase.md

**How it works:**

```json
{
  "pipeline": {
    "implement": [["claude-code", "opencode"]],
    "review":    ["claude-code", "implement"]
  }
}
```

Two providers run in parallel, each writing to an isolated git worktree. The pipeline pauses at `awaiting_judge`. You see both diffs:

```
candidate 0  (claude-code)   +27 lines
candidate 1  (opencode/DeepSeek)  +60 lines, wider API, JSDoc

npx runoff race apply --session abc123 --winner 1
```

Works as an MCP server (Cursor, Claude Desktop, Claude Code) or standalone CLI. Providers are swappable via config — Codex, Gemini CLI (ACP mode), OpenCode, or any stdin-accepting CLI.

**Why this isn't LangGraph / CrewAI / AutoGen:**  
Those are great for conversational multi-agent loops. runoff is specifically for repo-native code changes: git worktrees, cross-process locks, patch apply, local traces. The output is a git diff, not a chat message.

GitHub: https://github.com/alexangelzhang/runoff  
npx: `npx runoff init --work-dir /path/to/repo`

---

## Pre-post checklist

- [ ] repo 改成 public（Settings → Danger Zone → Change visibility）
- [ ] GitHub Actions secrets 设置（`RUNOFF_REAL_*`、`OPENAI_API_KEY`、`GEMINI_API_KEY`）
- [ ] 确认 `npx runoff init` 能从 npm 安装（需先 `npm publish`）
- [ ] race-showcase.md 链接可以公开访问
- [ ] README CI badge 显示绿色
