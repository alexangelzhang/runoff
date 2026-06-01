#!/usr/bin/env npx tsx
/**
 * Print or install MCP host configuration for runoff.
 *
 *   npm run setup:mcp
 *   npm run setup:mcp -- --host cursor
 *   npm run setup:mcp -- --install --host claude-code
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getRepoRoot } from "../../../src/core/paths.js";

type McpHost = "cursor" | "claude-desktop" | "claude-code" | "generic";

function parseArgv(argv: string[]): { host: McpHost; install: boolean; help: boolean } {
  let host: McpHost = "generic";
  let install = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--install") install = true;
    else if (a === "--host") {
      const v = argv[++i];
      if (!v) throw new Error("--host requires a value");
      if (!["cursor", "claude-desktop", "claude-code", "generic"].includes(v)) {
        throw new Error(`Unknown host: ${v}`);
      }
      host = v as McpHost;
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return { host, install, help };
}

function mcpEntry(repoRoot: string): { command: string; args: string[]; cwd: string } {
  const entry = join(repoRoot, "src/index.ts");
  return {
    command: "npx",
    args: ["tsx", entry],
    cwd: repoRoot,
  };
}

function printJson(host: McpHost, entry: ReturnType<typeof mcpEntry>): void {
  const block = {
    mcpServers: {
      "runoff": {
        command: entry.command,
        args: entry.args,
        cwd: entry.cwd,
      },
    },
  };

  console.log(`=== runoff MCP (${host}) ===\n`);
  console.log(JSON.stringify(block, null, 2));
  console.log("");

  switch (host) {
    case "cursor":
      console.log("Cursor: Settings → MCP → Add server → paste command/args/cwd from above.");
      console.log("Docs: docs/guides/mcp-host-setup.md");
      break;
    case "claude-desktop":
      console.log("Claude Desktop: merge into claude_desktop_config.json → mcpServers.");
      console.log("macOS: ~/Library/Application Support/Claude/claude_desktop_config.json");
      break;
    case "claude-code":
      console.log("Claude Code: run with --install or: claude mcp add runoff -- <command> <args...>");
      break;
    default:
      console.log("Register in your MCP host using the JSON above. See docs/guides/mcp-host-setup.md");
  }
}

function tryClaudeCodeInstall(repoRoot: string, entry: ReturnType<typeof mcpEntry>): boolean {
  try {
    execFileSync("which", ["claude"], { stdio: "ignore" });
  } catch {
    console.log("Claude Code CLI not found — use printed JSON in Cursor / Claude Desktop.\n");
    return false;
  }

  const distEntry = join(repoRoot, "dist/index.js");
  const useDist = existsSync(distEntry);
  if (!useDist) {
    console.log("Building dist/ for claude mcp add…");
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  }

  const cmd = useDist ? "node" : entry.command;
  const args = useDist ? [distEntry] : entry.args;
  console.log(`Running: claude mcp add runoff -- ${cmd} ${args.join(" ")}`);
  execFileSync("claude", ["mcp", "add", "runoff", "--", cmd, ...args], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  console.log("\nDone. Restart Claude Code if needed.");
  return true;
}

function main(): void {
  const { host, install, help } = parseArgv(process.argv.slice(2));
  if (help) {
    console.log(`Usage: npm run setup:mcp [-- --host cursor|claude-desktop|claude-code|generic] [--install]

--install   Only claude-code: runs claude mcp add (falls back to JSON if CLI missing)
`);
    return;
  }

  const repoRoot = getRepoRoot();
  const entry = mcpEntry(repoRoot);

  if (install && host === "claude-code") {
    if (tryClaudeCodeInstall(repoRoot, entry)) return;
  } else if (install) {
    console.log(`--install is only automated for claude-code today (${host}: use printed JSON).\n`);
  }

  printJson(host, entry);
}

main();
