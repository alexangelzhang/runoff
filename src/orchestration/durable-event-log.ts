/**
 * Append-only file EventLog (Gate 2.2).
 */

import { existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendJsonl, atomicWriteJson, readJsonFile, readJsonl } from "./durable-io.js";
import type { EventLog, EventLogEntry, EventLogQuery } from "./event-log.js";
import type { OrchestrationEvent } from "./multi-agent-types.js";
import { enrichEventLogEntry } from "./event-log-span.js";

interface EventLogMeta {
  nextSeq: number;
}

export class FileEventLog implements EventLog {
  private readonly logPath: string;
  private readonly metaPath: string;
  private entries: EventLogEntry[] = [];
  private nextSeq = 1;

  constructor(logPath: string, metaPath?: string) {
    this.logPath = logPath;
    this.metaPath = metaPath ?? join(dirname(logPath), "events-meta.json");
    this.reload();
  }

  private reload(): void {
    this.entries = readJsonl<EventLogEntry>(this.logPath);
    const meta = readJsonFile<EventLogMeta>(this.metaPath);
    if (meta?.nextSeq && meta.nextSeq > 0) {
      this.nextSeq = meta.nextSeq;
    } else if (this.entries.length > 0) {
      this.nextSeq = Math.max(...this.entries.map((e) => e.seq)) + 1;
    } else {
      this.nextSeq = 1;
    }
  }

  private persistMeta(): void {
    atomicWriteJson(this.metaPath, { nextSeq: this.nextSeq } satisfies EventLogMeta);
  }

  append(runId: string, event: OrchestrationEvent): number {
    const seq = this.nextSeq++;
    const entry = enrichEventLogEntry(seq, Date.now(), runId, event);
    this.entries.push(entry);
    appendJsonl(this.logPath, entry);
    this.persistMeta();
    return seq;
  }

  query(q: EventLogQuery): EventLogEntry[] {
    let results = [...this.entries];
    if (q.runId) results = results.filter((e) => e.runId === q.runId);
    if (q.eventType) results = results.filter((e) => e.event.type === q.eventType);
    const afterSeq = q.afterSeq;
    if (afterSeq !== undefined) results = results.filter((e) => e.seq >= afterSeq);
    const since = q.since;
    if (since !== undefined) results = results.filter((e) => e.timestamp >= since);
    results.sort((a, b) => a.seq - b.seq);
    if (q.limit) results = results.slice(0, q.limit);
    return results;
  }

  replay(runId: string, afterSeq?: number): EventLogEntry[] {
    return this.entries
      .filter((e) => e.runId === runId && (afterSeq === undefined || e.seq > afterSeq))
      .sort((a, b) => a.seq - b.seq);
  }

  get length(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
    this.nextSeq = 1;
    if (existsSync(this.logPath)) unlinkSync(this.logPath);
    if (existsSync(this.metaPath)) unlinkSync(this.metaPath);
  }
}
