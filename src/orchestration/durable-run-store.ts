/**
 * File-backed RunStore (Gate 2.1 — kill → restart → resume).
 */

import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, ensureDir, readJsonFile, safePathSegment } from "./durable-io.js";
import type { RunState, RunStatus, RunStore } from "./run-store.js";

export class FileRunStore implements RunStore {
  private readonly runsDir: string;

  constructor(runsDir: string) {
    this.runsDir = runsDir;
    ensureDir(runsDir);
  }

  private runPath(runId: string): string {
    return join(this.runsDir, `${safePathSegment(runId)}.json`);
  }

  save(run: RunState): void {
    const next = { ...run, updatedAt: Date.now() };
    atomicWriteJson(this.runPath(run.runId), next);
  }

  load(runId: string): RunState | undefined {
    const data = readJsonFile<RunState>(this.runPath(runId));
    return data ? { ...data } : undefined;
  }

  list(filter?: { status?: RunStatus; sessionId?: string }): RunState[] {
    if (!existsSync(this.runsDir)) return [];
    let results: RunState[] = [];
    for (const file of readdirSync(this.runsDir)) {
      if (!file.endsWith(".json")) continue;
      const data = readJsonFile<RunState>(join(this.runsDir, file));
      if (data) results.push({ ...data });
    }
    if (filter?.status) results = results.filter((r) => r.status === filter.status);
    if (filter?.sessionId) results = results.filter((r) => r.sessionId === filter.sessionId);
    return results;
  }

  delete(runId: string): boolean {
    const path = this.runPath(runId);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }

  get size(): number {
    if (!existsSync(this.runsDir)) return 0;
    return readdirSync(this.runsDir).filter((f) => f.endsWith(".json")).length;
  }

  clear(): void {
    if (!existsSync(this.runsDir)) return;
    for (const file of readdirSync(this.runsDir)) {
      if (file.endsWith(".json")) unlinkSync(join(this.runsDir, file));
    }
  }
}
