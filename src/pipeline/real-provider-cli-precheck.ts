import { accessSync, constants, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeDelegateArgv } from "../providers/delegate-argv.js";

export type CliPrecheckIssue = {
  envVar: string;
  severity: "error" | "warn";
  message: string;
};

function parseArgvJson(envVar: string): string[] | null {
  const raw = process.env[envVar];
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((x) => typeof x === "string")) {
      return null;
    }
    return parsed as string[];
  } catch {
    return null;
  }
}

function resolveExecutable(cmd: string): string | null {
  if (cmd.includes("/") || cmd.includes("\\")) {
    return existsSync(cmd) ? cmd : null;
  }
  try {
    const out = execFileSync("which", [cmd], { encoding: "utf-8" }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Codex npm wrapper may exist while vendor binary is missing (ENOENT at runtime). */
function codexVendorMissing(wrapperPath: string): string | null {
  const base = dirname(wrapperPath);
  const candidates = [
    join(base, "vendor", "aarch64-apple-darwin", "codex", "codex"),
    join(base, "vendor", "x86_64-apple-darwin", "codex", "codex"),
    join(base, "vendor", "aarch64-unknown-linux-gnu", "codex", "codex"),
    join(base, "vendor", "x86_64-unknown-linux-gnu", "codex", "codex"),
  ];
  for (const p of candidates) {
    try {
      accessSync(p, constants.X_OK);
      return null;
    } catch {
      /* try next */
    }
  }
  return `Codex wrapper found at ${wrapperPath} but vendor binary is missing — reinstall @openai/codex (npm i -g @openai/codex@latest)`;
}

function isCodexArgv(argv: string[]): boolean {
  const cmd = argv[0] ?? "";
  const base = cmd.split(/[/\\]/).pop() ?? cmd;
  return base === "codex" || base.includes("codex");
}

function isGeminiArgv(argv: string[]): boolean {
  const cmd = argv[0] ?? "";
  const base = cmd.split(/[/\\]/).pop() ?? cmd;
  return base === "gemini" || base.startsWith("gemini.");
}

/** Apply Gemini headless flags to env JSON before smoke (mutates process.env). */
export function applyRealProviderArgvDefaults(): void {
  const gemini = parseArgvJson("LLM_PIPELINE_REAL_GEMINI_ARGV_JSON");
  if (gemini) {
    process.env.LLM_PIPELINE_REAL_GEMINI_ARGV_JSON = JSON.stringify(normalizeDelegateArgv(gemini));
  }
}

export function precheckRealProviderCliEnv(): CliPrecheckIssue[] {
  const issues: CliPrecheckIssue[] = [];
  for (const envVar of ["LLM_PIPELINE_REAL_CODEX_ARGV_JSON", "LLM_PIPELINE_REAL_GEMINI_ARGV_JSON"] as const) {
    const argv = parseArgvJson(envVar);
    if (!argv) continue;

    const resolved = resolveExecutable(argv[0]!);
    if (!resolved) {
      issues.push({
        envVar,
        severity: "error",
        message: `Cannot resolve executable for argv[0]="${argv[0]}" (${envVar})`,
      });
      continue;
    }

    if (isCodexArgv(argv)) {
      const vendorMsg = codexVendorMissing(resolved);
      if (vendorMsg) {
        issues.push({ envVar, severity: "error", message: vendorMsg });
      }
    }

    if (isGeminiArgv(argv)) {
      // Gemini CLI v0.44+ reads stdin without -p. normalizeDelegateArgv is now a no-op.
      const hasYolo = argv.includes("-y") || argv.includes("--yolo") || argv.some(a => a.includes("yolo"));
      if (!hasYolo) {
        issues.push({
          envVar,
          severity: "warn",
          message:
            'Gemini argv should include "--yolo" or "--approval-mode yolo" for headless use (Gemini CLI 0.44+).',
        });
      }
    }
  }
  return issues;
}

export function formatPrecheckIssues(issues: CliPrecheckIssue[]): string {
  return issues.map((i) => `[${i.severity}] ${i.envVar}: ${i.message}`).join("\n");
}
