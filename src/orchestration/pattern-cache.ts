/**
 * Pattern Cache (OpenSpace-inspired Feature 1).
 *
 * Extracts successful pipeline execution patterns from traces and stores them
 * as reusable memory entries. On subsequent similar tasks, matching patterns
 * are retrieved and injected as few-shot context to reduce token consumption.
 *
 * Flow: PipelineTrace → extractPattern() → AgentMemory.store()
 *       New prompt → matchPatterns() → AgentMemory.retrieve() → inject as context
 */

import { createHash } from "node:crypto";
import type { PipelineTrace, StepTrace } from "../observability/trace.js";
import type { AgentMemory, MemoryEntry, MemoryScope } from "./memory.js";
import { agentId } from "./multi-agent-types.js";
import { getLinkedPatterns, linkPatternByFiles } from "./pattern-links.js";
import { isLayeredAgentMemory } from "../memory/memory-backend-status.js";
import { LayeredAgentMemory } from "./http-memory-client.js";
import { loadConfig } from "../core/config.js";
import { resolveDreamifyRetrieval } from "../dreamify/dreamify-params.js";
import { matchPatternEntriesWithParams } from "../dreamify/dreamify-match.js";

export interface AssociativeContextOptions {
  /** When true and memory is layered, semantic match uses retrieveMerged (default true). */
  hybridRetrieve?: boolean;
  /** Max ms to wait for remote merge before local-only fallback (default 800). */
  timeoutMs?: number;
}

const DEFAULT_HYBRID_TIMEOUT_MS = 800;

function dreamifyParams() {
  try {
    return resolveDreamifyRetrieval(loadConfig());
  } catch {
    return resolveDreamifyRetrieval();
  }
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("memory retrieve timeout")), timeoutMs);
      }),
    ]);
  } catch {
    return fallback();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// --- Pattern Entry ---

export interface ExecutionPattern {
  /** Hash of the normalized prompt for deduplication. */
  promptHash: string;
  /** Original prompt (truncated for storage). */
  promptSummary: string;
  /** Winning provider chain (ordered step providers). */
  providerChain: string[];
  /** Total tokens consumed by this run. */
  totalTokens: number;
  /** Total duration in ms. */
  totalDurationMs: number;
  /** Number of rounds to approval. */
  rounds: number;
  /** Key step parameters that led to success. */
  stepHints: StepHint[];
  /** When this pattern was captured. */
  capturedAt: string;
}

export interface StepHint {
  name: string;
  provider: string;
  /** Whether the step used agent mode. */
  isAgent: boolean;
  /** Files modified (for context matching). */
  filesModified: string[];
}

// --- Pattern extraction ---

const MAX_PROMPT_SUMMARY = 200;

function normalizePrompt(prompt: string): string {
  return prompt.toLowerCase().replace(/\s+/g, " ").trim();
}

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(normalizePrompt(prompt)).digest("hex").slice(0, 16);
}

/**
 * Extract a reusable pattern from a successful pipeline trace.
 * Returns null if the trace is not suitable (failed, no steps, etc.).
 */
export function extractPattern(trace: PipelineTrace): ExecutionPattern | null {
  if (trace.finalStatus !== "approved") return null;
  if (trace.steps.length === 0) return null;

  const stepHints: StepHint[] = trace.steps
    .filter((s) => !s.error)
    .map((s) => ({
      name: s.name,
      provider: s.provider,
      isAgent: s.isAgent ?? false,
      filesModified: s.filesModified ?? [],
    }));

  const totalTokens = trace.totalUsage
    ? trace.totalUsage.promptTokens + trace.totalUsage.completionTokens
    : trace.steps.reduce((sum, s) => {
        if (!s.usage) return sum;
        return sum + s.usage.promptTokens + s.usage.completionTokens;
      }, 0);

  return {
    promptHash: hashPrompt(trace.prompt),
    promptSummary: trace.prompt.slice(0, MAX_PROMPT_SUMMARY),
    providerChain: trace.steps.map((s) => s.provider),
    totalTokens,
    totalDurationMs: trace.totalDurationMs,
    rounds: trace.totalRounds,
    stepHints,
    capturedAt: trace.timestamp,
  };
}

// --- Pattern Cache (backed by AgentMemory) ---

const PATTERN_AGENT_ID = agentId("pattern-cache");
const DEFAULT_SCOPE: MemoryScope = { project: "default" };

export class PatternCache {
  constructor(
    private memory: AgentMemory,
    private scope: MemoryScope = DEFAULT_SCOPE,
  ) {}

  /**
   * Store a pattern from a successful trace.
   * Deduplicates by promptHash — newer pattern replaces older one.
   */
  storeFromTrace(trace: PipelineTrace): MemoryEntry | null {
    const pattern = extractPattern(trace);
    if (!pattern) return null;

    // Deduplicate: remove existing pattern with same promptHash
    const existing = this.memory.retrieve({
      agentId: PATTERN_AGENT_ID,
      category: "pattern",
      scope: this.scope,
      textSearch: `promptHash:${pattern.promptHash}`,
    });
    for (const e of existing) {
      this.memory.forget(e.id);
    }

    const stored = this.memory.store({
      agentId: PATTERN_AGENT_ID,
      scope: this.scope,
      category: "pattern",
      content: `promptHash:${pattern.promptHash}\n${pattern.promptSummary}`,
      metadata: pattern as unknown as Record<string, unknown>,
      relevance: 1.0,
      ttlMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    });

    if ("compact" in this.memory && typeof this.memory.compact === "function") {
      this.memory.compact({ minSimilarity: 0.85 });
    }

    linkPatternByFiles(
      this.memory,
      this.scope,
      stored,
      pattern,
      dreamifyParams().fileLinkMinOverlap,
    );

    return stored;
  }

  /**
   * Find patterns matching a new prompt.
   * Uses exact promptHash match first, then falls back to text similarity.
   */
  /**
   * Phase 8.1.7 — Match patterns plus file-linked associates for few-shot injection.
   */
  buildAssociativeContext(prompt: string, limit?: number): string {
    const p = dreamifyParams();
    const effectiveLimit = limit ?? p.patternLimit;
    const primary = this.matchPatternEntries(prompt, effectiveLimit);
    return this.formatAssociativeFromEntries(primary, effectiveLimit);
  }

  /** M1: hybrid local + remote semantic match with timeout fallback. */
  async buildAssociativeContextAsync(
    prompt: string,
    limit?: number,
    options?: AssociativeContextOptions,
  ): Promise<string> {
    const p = dreamifyParams();
    const effectiveLimit = limit ?? p.patternLimit;
    const primary = await this.matchPatternEntriesAsync(prompt, effectiveLimit, options);
    return this.formatAssociativeFromEntries(primary, effectiveLimit);
  }

  private formatAssociativeFromEntries(entries: MemoryEntry[], limit: number): string {
    if (entries.length === 0) return "";

    const patterns: ExecutionPattern[] = [];
    const seen = new Set<string>();

    const addPattern = (p: ExecutionPattern | null) => {
      if (!p || seen.has(p.promptHash)) return;
      seen.add(p.promptHash);
      patterns.push(p);
    };

    for (const entry of entries) {
      const p = entry.metadata as unknown as ExecutionPattern;
      addPattern(p);
      for (const linked of getLinkedPatterns(this.memory, entry, this.scope)) {
        addPattern(linked);
      }
    }

    return this.formatAsContext(patterns.slice(0, limit * 2));
  }

  /** Retrieve pattern memory entries for a prompt (hash → semantic → keyword). */
  async matchPatternEntriesAsync(
    prompt: string,
    limit?: number,
    options?: AssociativeContextOptions,
  ): Promise<MemoryEntry[]> {
    const p = dreamifyParams();
    const effectiveLimit = limit ?? p.patternLimit;
    const exact = this.matchExactPatternEntries(prompt, effectiveLimit);
    if (exact.length > 0) return exact;

    const timeoutMs = options?.timeoutMs ?? DEFAULT_HYBRID_TIMEOUT_MS;
    const hybrid = options?.hybridRetrieve === true && isLayeredAgentMemory(this.memory);

    if (hybrid) {
      const layered = this.memory as LayeredAgentMemory;
      const query = {
        agentId: PATTERN_AGENT_ID,
        category: "pattern" as const,
        scope: this.scope,
        semanticQuery: prompt,
        minSemanticSimilarity: p.minSemanticSimilarity,
        limit: effectiveLimit,
      };
      const semantic = await raceWithTimeout(
        layered.retrieveMerged(query),
        timeoutMs,
        () => this.memory.retrieve(query),
      );
      if (semantic.length > 0) return semantic;
    }

    return matchPatternEntriesWithParams(this.memory, this.scope, prompt, p);
  }

  matchPatternEntries(prompt: string, limit?: number): MemoryEntry[] {
    const p = dreamifyParams();
    const effectiveLimit = limit ?? p.patternLimit;
    return matchPatternEntriesWithParams(this.memory, this.scope, prompt, p).slice(0, effectiveLimit);
  }

  private matchExactPatternEntries(prompt: string, limit: number): MemoryEntry[] {
    const hash = hashPrompt(prompt);
    return this.memory.retrieve({
      agentId: PATTERN_AGENT_ID,
      category: "pattern",
      scope: this.scope,
      textSearch: `promptHash:${hash}`,
      limit,
    });
  }

  matchPatterns(prompt: string, limit?: number): ExecutionPattern[] {
    return this.matchPatternEntries(prompt, limit).map(
      (e) => e.metadata as unknown as ExecutionPattern,
    );
  }

  /**
   * Format matched patterns as context string for prompt injection.
   */
  formatAsContext(patterns: ExecutionPattern[], linkedFromEntry?: MemoryEntry): string {
    if (patterns.length === 0) return "";

    const lines = ["[Prior successful patterns for similar tasks]"];
    const seen = new Set<string>();
    const appendPattern = (p: ExecutionPattern) => {
      const key = p.promptHash;
      if (seen.has(key)) return;
      seen.add(key);
      lines.push(`- Provider chain: ${p.providerChain.join(" → ")}`);
      lines.push(`  Rounds: ${p.rounds}, Tokens: ${p.totalTokens}, Duration: ${p.totalDurationMs}ms`);
      if (p.stepHints.length > 0) {
        const files = p.stepHints.flatMap((h) => h.filesModified).filter(Boolean);
        if (files.length > 0) {
          lines.push(`  Files touched: ${files.slice(0, 10).join(", ")}`);
        }
      }
    };

    for (const p of patterns) appendPattern(p);

    if (linkedFromEntry) {
      for (const linked of getLinkedPatterns(this.memory, linkedFromEntry, this.scope)) {
        appendPattern(linked);
      }
    }

    return lines.join("\n");
  }

  /** Number of stored patterns. */
  get size(): number {
    return this.memory.retrieve({
      agentId: PATTERN_AGENT_ID,
      category: "pattern",
      scope: this.scope,
      limit: 10000,
    }).length;
  }

  /** Clear all patterns. */
  clear(): void {
    this.memory.forgetByScope(this.scope);
  }
}
