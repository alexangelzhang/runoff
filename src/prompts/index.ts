/**
 * Prompt loader: reads .md files from this directory.
 * Results are cached in a module-level Map (equivalent to functools.cache).
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const _DIR = dirname(fileURLToPath(import.meta.url));
const _cache = new Map<string, string>();

function load(filename: string): string {
  if (!_cache.has(filename)) {
    _cache.set(filename, readFileSync(join(_DIR, filename), "utf-8").trimEnd());
  }
  return _cache.get(filename)!;
}

export const GENERATE_SYSTEM_PROMPT = () => load("generate_system.md");
export const REVIEW_SYSTEM_PROMPT = () => load("review_system.md");
export const OPENAI_SYSTEM_PROMPT = () => load("openai_system.md");
