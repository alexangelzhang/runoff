/**
 * Agent Memory System (Wave 7.10).
 *
 * Multi-layered memory beyond session-level globalKnowledge:
 * - Working memory: current session candidate + knowledge (already exists)
 * - Short-term memory: recent N session trace summaries
 * - Long-term memory: persistent experience store (patterns, lessons, preferences)
 *
 * Reference: LangGraph Memory Store, CrewAI Long-term Memory.
 */

import type { AgentId } from "./multi-agent-types.js";
import {
  attachEmbeddingMetadata,
  rankEntriesBySemanticQuery,
} from "./memory-embedding.js";
import { decayedRelevance } from "./memory-decay.js";
import { mergeMemoryEntries, type MemoryMergeOptions } from "./memory-merge.js";
import { redactMetadata, redactSecrets } from "./memory-redaction.js";

// --- Memory Entry ---

export interface MemoryEntry {
  id: string;
  /** Which agent created this memory. */
  agentId: AgentId;
  /** Memory scope for isolation. */
  scope: MemoryScope;
  /** Category for retrieval. */
  category: MemoryCategory;
  /** The memory content. */
  content: string;
  /** Structured metadata for filtering. */
  metadata?: Record<string, unknown>;
  /** Relevance score (0-1, higher = more relevant). */
  relevance?: number;
  /** When this memory was created. */
  createdAt: number;
  /** When this memory was last accessed. */
  lastAccessedAt: number;
  /** TTL in milliseconds. Undefined = no expiry. */
  ttlMs?: number;
}

// --- Memory Scope ---

export interface MemoryScope {
  /** Tenant/org isolation. */
  tenant?: string;
  /** Project-level isolation. */
  project?: string;
  /** Repository-level isolation. */
  repo?: string;
  /** User-level isolation. */
  user?: string;
}

// --- Memory Category ---

export type MemoryCategory =
  | "pattern"       // Successful code patterns
  | "lesson"        // Lessons from failures
  | "preference"    // User/project preferences
  | "context"       // Contextual information
  | "trace_summary" // Summarized trace from past sessions
  | (string & {});  // Extensible

// --- Memory Query ---

export interface MemoryQuery {
  /** Filter by agent. */
  agentId?: AgentId;
  /** Filter by scope (partial match). */
  scope?: Partial<MemoryScope>;
  /** Filter by category. */
  category?: MemoryCategory;
  /** Text search in content. */
  textSearch?: string;
  /** Phase 8.1.3: semantic retrieval via local embedding cosine similarity. */
  semanticQuery?: string;
  /** Minimum cosine similarity for semanticQuery (default 0.35). */
  minSemanticSimilarity?: number;
  /** Minimum relevance score. */
  minRelevance?: number;
  /** Maximum number of results. */
  limit?: number;
  /** Include expired entries. */
  includeExpired?: boolean;
}

// --- Agent Memory Interface ---

export interface AgentMemory {
  /** Store a new memory entry. */
  store(entry: Omit<MemoryEntry, "id" | "createdAt" | "lastAccessedAt">): MemoryEntry;
  /** Retrieve memories matching a query. */
  retrieve(query: MemoryQuery): MemoryEntry[];
  /** Forget (delete) a specific memory. */
  forget(id: string): boolean;
  /** Forget all memories matching a scope. */
  forgetByScope(scope: Partial<MemoryScope>): number;
  /** Update relevance score for a memory. */
  updateRelevance(id: string, relevance: number): boolean;
  /** Merge metadata fields (Phase 8.1.5 pattern links). */
  patchMetadata(id: string, metadata: Record<string, unknown>): boolean;
  /** Total number of memories. */
  readonly size: number;
  /** Clear all memories. */
  clear(): void;
}

// --- In-Memory Implementation ---

export class InMemoryAgentMemory implements AgentMemory {
  private entries = new Map<string, MemoryEntry>();
  private nextId = 1;

  store(entry: Omit<MemoryEntry, "id" | "createdAt" | "lastAccessedAt">): MemoryEntry {
    const now = Date.now();
    const safeContent = redactSecrets(entry.content);
    const full: MemoryEntry = {
      ...entry,
      content: safeContent,
      id: `mem-${this.nextId++}`,
      createdAt: now,
      lastAccessedAt: now,
      metadata: attachEmbeddingMetadata(redactMetadata(entry.metadata), safeContent),
    };
    this.entries.set(full.id, full);
    return full;
  }

  retrieve(query: MemoryQuery): MemoryEntry[] {
    const now = Date.now();
    let results = [...this.entries.values()];

    // Filter expired
    if (!query.includeExpired) {
      results = results.filter(
        (e) => !e.ttlMs || now - e.createdAt < e.ttlMs
      );
    }

    // Filter by agent
    if (query.agentId) {
      results = results.filter((e) => e.agentId === query.agentId);
    }

    // Filter by category
    if (query.category) {
      results = results.filter((e) => e.category === query.category);
    }

    // Filter by scope (partial match)
    if (query.scope) {
      results = results.filter((e) => this.scopeMatches(e.scope, query.scope!));
    }

    // Filter by text search
    if (query.textSearch) {
      const lower = query.textSearch.toLowerCase();
      results = results.filter((e) => e.content.toLowerCase().includes(lower));
    }

    // Filter by minimum relevance (decayed)
    if (query.minRelevance !== undefined) {
      results = results.filter((e) => {
        const rel = decayedRelevance(e.relevance ?? 0, now - e.createdAt);
        return rel >= query.minRelevance!;
      });
    }

    if (query.semanticQuery) {
      results = rankEntriesBySemanticQuery(results, query.semanticQuery, {
        minSimilarity: query.minSemanticSimilarity,
        nowMs: now,
      });
    } else {
      results.sort((a, b) => {
        const relA = decayedRelevance(a.relevance ?? 0, now - a.createdAt);
        const relB = decayedRelevance(b.relevance ?? 0, now - b.createdAt);
        if (relB !== relA) return relB - relA;
        return b.lastAccessedAt - a.lastAccessedAt;
      });
    }

    // Apply limit
    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    // Update lastAccessedAt for retrieved entries
    for (const e of results) {
      e.lastAccessedAt = now;
    }

    return results;
  }

  forget(id: string): boolean {
    return this.entries.delete(id);
  }

  forgetByScope(scope: Partial<MemoryScope>): number {
    let count = 0;
    for (const [id, entry] of this.entries) {
      if (this.scopeMatches(entry.scope, scope)) {
        this.entries.delete(id);
        count++;
      }
    }
    return count;
  }

  updateRelevance(id: string, relevance: number): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.relevance = Math.max(0, Math.min(1, relevance));
    return true;
  }

  patchMetadata(id: string, metadata: Record<string, unknown>): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.metadata = { ...entry.metadata, ...metadata };
    return true;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.nextId = 1;
  }

  /** Phase 8.1.2: merge same-category entries with similar content. */
  compact(options?: MemoryMergeOptions): number {
    const { entries, removedIds } = mergeMemoryEntries([...this.entries.values()], options);
    for (const id of removedIds) {
      this.entries.delete(id);
    }
    for (const e of entries) {
      this.entries.set(e.id, e);
    }
    return removedIds.length;
  }

  private scopeMatches(entryScope: MemoryScope, queryScope: Partial<MemoryScope>): boolean {
    if (queryScope.tenant && entryScope.tenant !== queryScope.tenant) return false;
    if (queryScope.project && entryScope.project !== queryScope.project) return false;
    if (queryScope.repo && entryScope.repo !== queryScope.repo) return false;
    if (queryScope.user && entryScope.user !== queryScope.user) return false;
    return true;
  }
}
