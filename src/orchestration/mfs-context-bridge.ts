/**
 * Optional thin bridge to the external `mfs` CLI — search/cat with bounded output
 * aligned to runoff context-contract (refs + excerpts, no raw hit dumps).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ContextEvidenceRef } from "../core/state.js";
import {
  compactSearchHitList,
  dedupeContextRefs,
  extractContextRefs,
  parseContextRef,
} from "./context-contract.js";

export const DEFAULT_MFS_COMMAND = "mfs";
export const DEFAULT_MFS_SEARCH_TOP_K = 5;
export const DEFAULT_MFS_EXCERPT_CHARS = 8_000;
export const DEFAULT_MFS_SNIPPET_CHARS = 240;

export type QueryContextMode = "search" | "cat";

export interface MfsCliProbe {
  available: boolean;
  command: string;
  version?: string;
  error?: string;
}

export interface QueryContextHit {
  ref: string;
  snippet?: string;
  score?: number;
}

export interface QueryContextResult {
  mode: QueryContextMode;
  mfsAvailable: boolean;
  contextRefs: ContextEvidenceRef[];
  hits?: QueryContextHit[];
  excerpt?: string;
  excerptChars?: number;
  truncated?: boolean;
  promptBlock: string;
  rawOmitted: boolean;
  command?: string[];
  error?: string;
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n\n[truncated to ${maxChars} chars per runoff context contract]`,
    truncated: true,
  };
}

export function detectMfsCli(command = DEFAULT_MFS_COMMAND): MfsCliProbe {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
  } catch {
    return { available: false, command, error: `${command} not found on PATH` };
  }
  try {
    const version = execFileSync(command, ["--version"], { encoding: "utf-8" }).trim().split("\n")[0];
    return { available: true, command, version };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { available: true, command, error: message };
  }
}

export function runMfsCli(
  args: string[],
  options?: { command?: string; cwd?: string; timeoutMs?: number },
): { ok: boolean; stdout: string; stderr: string; exitCode: number | null; command: string[] } {
  const command = options?.command ?? DEFAULT_MFS_COMMAND;
  const fullCommand = [command, ...args];
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    cwd: options?.cwd,
    timeout: options?.timeoutMs ?? 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status,
    command: fullCommand,
  };
}

export function parseMfsSearchOutput(stdout: string): QueryContextHit[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  const compacted = compactSearchHitList(trimmed);
  if (compacted) {
    return compacted.refs.map((ref) => ({ ref: ref.ref }));
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const rows = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null
        ? ((parsed as Record<string, unknown>).hits ??
          (parsed as Record<string, unknown>).results ??
          [])
        : [];
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row) => {
      if (!row || typeof row !== "object") return [];
      const record = row as Record<string, unknown>;
      const ref =
        (typeof record.uri === "string" && record.uri) ||
        (typeof record.path === "string" && record.path) ||
        (typeof record.ref === "string" && record.ref) ||
        (typeof record.file === "string" && record.file);
      if (!ref) return [];
      const snippet =
        typeof record.snippet === "string"
          ? record.snippet
          : typeof record.text === "string"
            ? record.text
            : undefined;
      const score = typeof record.score === "number" ? record.score : undefined;
      return [{ ref, snippet, score }];
    });
  } catch {
    // Text output: [N] path or uri lines
    return trimmed
      .split("\n")
      .map((line) => line.trim())
      .flatMap((line) => {
        const bracket = line.match(/^\[\d+\]\s+(.+)$/);
        const ref = bracket?.[1]?.trim() ?? line;
        if (!ref || ref.startsWith("#")) return [];
        return [{ ref }];
      });
  }
}

function buildSearchPromptBlock(hits: QueryContextHit[], contextRefs: ContextEvidenceRef[]): string {
  const lines = [
    "## MFS search (bounded — use contextRefs for mfs cat)",
    "",
  ];
  for (const hit of hits) {
    const snippet = hit.snippet ? truncateText(hit.snippet, DEFAULT_MFS_SNIPPET_CHARS).text : undefined;
    lines.push(`- ${hit.ref}${hit.score !== undefined ? ` (score=${hit.score.toFixed(3)})` : ""}`);
    if (snippet) lines.push(`  excerpt: ${snippet.replace(/\n/g, " ")}`);
  }
  if (contextRefs.length) {
    lines.push("", "Refs:", ...contextRefs.map((ref) => `- ${ref.ref}`));
  }
  return lines.join("\n");
}

function buildCatPromptBlock(uri: string, excerpt: string, truncated: boolean): string {
  return [
    "## MFS cat (bounded excerpt)",
    "",
    `Ref: ${uri}`,
    truncated ? "(truncated)" : "",
    "",
    excerpt,
  ]
    .filter(Boolean)
    .join("\n");
}

export function queryMfsContext(input: {
  mode: QueryContextMode;
  query?: string;
  uri?: string;
  scope?: string;
  all?: boolean;
  topK?: number;
  range?: string;
  skim?: boolean;
  mfsCommand?: string;
  cwd?: string;
  maxExcerptChars?: number;
}): QueryContextResult {
  const probe = detectMfsCli(input.mfsCommand);
  const maxExcerptChars = input.maxExcerptChars ?? DEFAULT_MFS_EXCERPT_CHARS;

  if (!probe.available) {
    return {
      mode: input.mode,
      mfsAvailable: false,
      contextRefs: [],
      promptBlock: "",
      rawOmitted: true,
      error: probe.error ?? `${probe.command} not available`,
    };
  }

  if (input.mode === "search") {
    if (!input.query?.trim()) {
      return {
        mode: "search",
        mfsAvailable: true,
        contextRefs: [],
        promptBlock: "",
        rawOmitted: true,
        error: "query is required for mode=search",
      };
    }
    const args = ["search", input.query.trim(), "--json", "--top-k", String(input.topK ?? DEFAULT_MFS_SEARCH_TOP_K)];
    if (input.all) args.push("--all");
    else if (input.scope?.trim()) args.push(input.scope.trim());
    else args.push(".");

    const ran = runMfsCli(args, { command: probe.command, cwd: input.cwd });
    if (!ran.ok) {
      return {
        mode: "search",
        mfsAvailable: true,
        contextRefs: [],
        promptBlock: "",
        rawOmitted: true,
        command: ran.command,
        error: ran.stderr.trim() || `mfs search exited ${ran.exitCode}`,
      };
    }

    const hits = parseMfsSearchOutput(ran.stdout).slice(0, input.topK ?? DEFAULT_MFS_SEARCH_TOP_K);
    const contextRefs = dedupeContextRefs(hits.map((hit) => parseContextRef(hit.ref)));
    return {
      mode: "search",
      mfsAvailable: true,
      hits,
      contextRefs,
      promptBlock: buildSearchPromptBlock(hits, contextRefs),
      rawOmitted: true,
      command: ran.command,
    };
  }

  const uri = input.uri?.trim();
  if (!uri) {
    return {
      mode: "cat",
      mfsAvailable: true,
      contextRefs: [],
      promptBlock: "",
      rawOmitted: true,
      error: "uri is required for mode=cat",
    };
  }

  const args = ["cat"];
  if (input.range?.trim()) args.push("-n", input.range.trim());
  else if (input.skim !== false) args.push("--skim");
  args.push(uri);

  const ran = runMfsCli(args, { command: probe.command, cwd: input.cwd });
  if (!ran.ok) {
    return {
      mode: "cat",
      mfsAvailable: true,
      contextRefs: [parseContextRef(uri)],
      promptBlock: "",
      rawOmitted: true,
      command: ran.command,
      error: ran.stderr.trim() || `mfs cat exited ${ran.exitCode}`,
    };
  }

  const bounded = truncateText(ran.stdout.trim(), maxExcerptChars);
  const contextRefs = dedupeContextRefs([parseContextRef(uri), ...extractContextRefs(bounded.text)]);
  return {
    mode: "cat",
    mfsAvailable: true,
    contextRefs,
    excerpt: bounded.text,
    excerptChars: bounded.text.length,
    truncated: bounded.truncated,
    promptBlock: buildCatPromptBlock(uri, bounded.text, bounded.truncated),
    rawOmitted: true,
    command: ran.command,
  };
}

export function readLocalContextExcerpt(
  ref: string,
  options?: { workDir?: string; maxChars?: number },
): { excerpt?: string; excerptChars?: number; truncated?: boolean; error?: string } {
  const maxChars = options?.maxChars ?? DEFAULT_MFS_EXCERPT_CHARS;
  const pathPart = ref.replace(/^file:\/\//, "");
  const lineRangeMatch = pathPart.match(/^(.+?):(\d+)(?:-(\d+))?$/);
  const filePath = lineRangeMatch?.[1] ?? pathPart;
  const abs = isAbsolute(filePath) ? filePath : join(options?.workDir ?? process.cwd(), filePath);
  if (!existsSync(abs)) return { error: `file not found: ${abs}` };
  const content = readFileSync(abs, "utf-8");
  let excerpt = content;
  if (lineRangeMatch) {
    const start = Math.max(0, Number(lineRangeMatch[2]) - 1);
    const end = lineRangeMatch[3] ? Number(lineRangeMatch[3]) : start + 40;
    excerpt = content.split("\n").slice(start, end).join("\n");
  }
  const bounded = truncateText(excerpt, maxChars);
  return {
    excerpt: bounded.text,
    excerptChars: bounded.text.length,
    truncated: bounded.truncated,
  };
}

export function isMfsOrFileUri(ref: string): boolean {
  return /^(?:file|mfs):\/\//.test(ref.trim());
}
