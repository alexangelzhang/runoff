/**
 * Persistent Agent Memory (OpenSpace-inspired Feature 3).
 *
 * File-backed AgentMemory that persists to ~/.runoff/memory/.
 * Enables cross-run knowledge sharing — patterns and lessons survive restarts.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPipelineHomeDir } from "../core/paths.js";
import type { AgentMemory, MemoryEntry, MemoryQuery, MemoryScope } from "./memory.js";
import {
  attachEmbeddingMetadata,
  rankEntriesBySemanticQuery,
} from "./memory-embedding.js";
import { decayedRelevance } from "./memory-decay.js";
import { mergeMemoryEntries, type MemoryMergeOptions } from "./memory-merge.js";
import { redactMetadata, redactSecrets } from "./memory-redaction.js";

function getMemoryDir(): string {
  return join(getPipelineHomeDir(), "memory");
}

function entryPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

/**
 * File-backed AgentMemory. Each entry is a separate JSON file in ~/.runoff/memory/.
 * Loads all entries on construction, writes on every mutation.
 */
export class PersistentAgentMemory implements AgentMemory {
  private entries = new Map<string, MemoryEntry>();
  private nextId: number;
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? getMemoryDir();
    mkdirSync(this.dir, { recursive: true });
    this.loadAll();
    // Derive nextId from existing entries
    let maxId = 0;
    for (const id of this.entries.keys()) {
      const num = parseInt(id.replace("mem-", ""), 10);
      if (!isNaN(num) && num > maxId) maxId = num;
    }
    this.nextId = maxId + 1;
  }

  private loadAll(): void {
    if (!existsSync(this.dir)) return;
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = readFileSync(join(this.dir, file), "utf-8");
        const entry = JSON.parse(raw) as MemoryEntry;
        this.entries.set(entry.id, entry);
      } catch {
        // Skip corrupt files
      }
    }
  }

  private persist(entry: MemoryEntry): void {
    const tmp = entryPath(this.dir, entry.id) + `.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry, null, 2));
    renameSync(tmp, entryPath(this.dir, entry.id));
  }

  private removeFile(id: string): void {
    const p = entryPath(this.dir, id);
    if (existsSync(p)) unlinkSync(p);
  }

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
    this.persist(full);
    return full;
  }

  retrieve(query: MemoryQuery): MemoryEntry[] {
    const now = Date.now();
    let results = [...this.entries.values()];

    if (!query.includeExpired) {
      results = results.filter((e) => !e.ttlMs || now - e.createdAt < e.ttlMs);
    }
    if (query.agentId) {
      results = results.filter((e) => e.agentId === query.agentId);
    }
    if (query.category) {
      results = results.filter((e) => e.category === query.category);
    }
    if (query.scope) {
      results = results.filter((e) => this.scopeMatches(e.scope, query.scope!));
    }
    if (query.textSearch) {
      const lower = query.textSearch.toLowerCase();
      results = results.filter((e) => e.content.toLowerCase().includes(lower));
    }
    if (query.minRelevance !== undefined) {
      results = results.filter((e) => {
        const base = e.relevance ?? 0;
        const ageMs = now - e.createdAt;
        return decayedRelevance(base, ageMs) >= query.minRelevance!;
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

    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    // Update lastAccessedAt and persist
    for (const e of results) {
      e.lastAccessedAt = now;
      this.persist(e);
    }

    return results;
  }

  forget(id: string): boolean {
    if (!this.entries.has(id)) return false;
    this.entries.delete(id);
    this.removeFile(id);
    return true;
  }

  forgetByScope(scope: Partial<MemoryScope>): number {
    let count = 0;
    for (const [id, entry] of this.entries) {
      if (this.scopeMatches(entry.scope, scope)) {
        this.entries.delete(id);
        this.removeFile(id);
        count++;
      }
    }
    return count;
  }

  updateRelevance(id: string, relevance: number): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.relevance = Math.max(0, Math.min(1, relevance));
    this.persist(entry);
    return true;
  }

  patchMetadata(id: string, metadata: Record<string, unknown>): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.metadata = { ...entry.metadata, ...metadata };
    this.persist(entry);
    return true;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    for (const id of this.entries.keys()) {
      this.removeFile(id);
    }
    this.entries.clear();
    this.nextId = 1;
  }

  /** Phase 8.1.2: merge same-category entries with similar content. */
  compact(options?: MemoryMergeOptions): number {
    const { entries, removedIds } = mergeMemoryEntries([...this.entries.values()], options);
    for (const id of removedIds) {
      this.entries.delete(id);
      this.removeFile(id);
    }
    for (const e of entries) {
      this.entries.set(e.id, e);
      this.persist(e);
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
