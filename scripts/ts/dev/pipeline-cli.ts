#!/usr/bin/env npx tsx
/**
 * Run llm-pipeline without an MCP host (Claude Code, Codex, Cursor, etc. still work as cli providers).
 *
 *   pipeline run --prompt "..." --work-dir /path/to/git/repo [--config pipeline.config.json]
 */

import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { clearConfigCache } from "../../../src/core/config.js";
import { executePipelineRun } from "../../../src/orchestration/pipeline-mcp-run.js";
import { getPipelineHomeDir } from "../../../src/core/paths.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function printHelp(): void {
  console.log(`llm-pipeline CLI — run code pipelines without an IDE host

Usage:
  npx tsx scripts/ts/dev/pipeline-cli.ts run --prompt <text> --work-dir <git-repo> [options]

Options:
  --config <path>   pipeline.config.json (default: ./pipeline.config.json in work-dir)
  --max-rounds <n>  override retry.maxRounds
  --home <path>     LLM_PIPELINE_HOME (default: ~/.llm-pipeline)

Examples:
  cd my-repo && npx tsx ../llm-pipeline/scripts/ts/dev/pipeline-cli.ts run \\
    --prompt "Add tests for hello()" --work-dir .

  npm run pipeline:run -- --prompt "Refactor auth" --work-dir /path/to/repo \\
    --config /path/to/examples/cli.config.json

Docs:
  docs/coding-agent-backends.md  — Codex, Gemini, Claude Code, OpenCode
  docs/differentiation.md        — vs LangGraph, CrewAI, AutoGen, OpenHands
`);
}

function parseArgs(argv: string[]): {
  command: string;
  prompt?: string;
  workDir?: string;
  config?: string;
  maxRounds?: number;
  home?: string;
} {
  const out: ReturnType<typeof parseArgs> = { command: argv[0] ?? "help" };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    if (a === "--prompt") out.prompt = next();
    else if (a === "--work-dir") out.workDir = next();
    else if (a === "--config") out.config = next();
    else if (a === "--max-rounds") out.maxRounds = Number(next());
    else if (a === "--home") out.home = next();
    else if (a === "--help" || a === "-h") out.command = "help";
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

async function cmdRun(args: ReturnType<typeof parseArgs>): Promise<void> {
  if (!args.prompt?.trim()) throw new Error("--prompt is required");
  if (!args.workDir?.trim()) throw new Error("--work-dir is required (must be a git repo for agent-write)");

  const workDir = resolve(args.workDir);
  if (!existsSync(workDir)) throw new Error(`work-dir not found: ${workDir}`);

  if (args.home) {
    process.env.LLM_PIPELINE_HOME = resolve(args.home);
  }

  const configPath = resolve(args.config ?? join(workDir, "pipeline.config.json"));
  if (!existsSync(configPath)) {
    throw new Error(
      `Config not found: ${configPath}\nCopy examples/cli.config.json from the llm-pipeline repo and edit providers.`,
    );
  }

  const runDir = mkdtempSync(join(tmpdir(), "llm-pipeline-cli-cwd-"));
  cpSync(configPath, join(runDir, "pipeline.config.json"));
  process.chdir(runDir);
  clearConfigCache();

  console.log("llm-pipeline run");
  console.log(`  work-dir:  ${workDir}`);
  console.log(`  config:    ${configPath}`);
  console.log(`  data home: ${getPipelineHomeDir()}\n`);

  const result = await executePipelineRun({
    prompt: args.prompt,
    workDir,
    maxRounds: args.maxRounds,
  });

  console.log("\nResult:");
  console.log(`  status:   ${result.status}`);
  console.log(`  traceId:  ${result.traceId ?? "(none)"}`);
  console.log(`  session:  ${result.sessionId ?? "(none)"}`);
  if (result.status === "awaiting_judge") {
    console.log("\nRace paused — use MCP llm_race_apply / llm_race_abort or resume with sessionId.");
  }
  process.exit(result.status === "approved" ? 0 : 1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help" || args.command === "--help") {
    printHelp();
    return;
  }
  if (args.command === "run") {
    await cmdRun(args);
    return;
  }
  printHelp();
  process.exit(args.command ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
