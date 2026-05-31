/**
 * In-process registry for multi-provider race sessions (llm_race_apply / abort).
 * Lives under src/ so core execution (scheduler) does not depend on MCP tools/.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getRaceSessionsDir } from "../core/paths.js";

export interface RaceCandidateSnapshot {
  providerName: string;
  workspacePath?: string;
  workspaceRepoRoot?: string;
  workspaceBaseRef?: string;
  workspaceSharedLockKey?: string;
  patchText?: string;
  filesModified?: string[];
  diffStat?: string;
}

export interface RaceSession {
  traceId: string;
  sessionId?: string;
  applyTargetPath: string;
  candidates: RaceCandidateSnapshot[];
  createdAt: number;
}

export const raceSessions = new Map<string, RaceSession>();

const RACE_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getRaceSessionFile(traceId: string): string {
  return join(getRaceSessionsDir(), `${traceId}.race.json`);
}

function parseRaceSession(raw: string): RaceSession | undefined {
  try {
    const parsed = JSON.parse(raw) as RaceSession;
    if (!parsed || typeof parsed !== "object") return undefined;
    if (typeof parsed.traceId !== "string") return undefined;
    if (typeof parsed.applyTargetPath !== "string") return undefined;
    if (!Array.isArray(parsed.candidates)) return undefined;
    if (typeof parsed.createdAt !== "number") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function persistRaceSession(session: RaceSession): void {
  const dir = getRaceSessionsDir();
  mkdirSync(dir, { recursive: true });
  const file = getRaceSessionFile(session.traceId);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(session, null, 2));
  renameSync(tmp, file);
}

function loadRaceSessionFromDisk(traceId: string): RaceSession | undefined {
  const file = getRaceSessionFile(traceId);
  if (!existsSync(file)) return undefined;
  return parseRaceSession(readFileSync(file, "utf-8"));
}

export function saveRaceSession(session: RaceSession): RaceSession {
  raceSessions.set(session.traceId, session);
  persistRaceSession(session);
  return session;
}

export function getRaceSession(traceId: string): RaceSession | undefined {
  const inMemory = raceSessions.get(traceId);
  if (inMemory) return inMemory;
  const persisted = loadRaceSessionFromDisk(traceId);
  if (persisted) {
    raceSessions.set(traceId, persisted);
  }
  return persisted;
}

export function deleteRaceSession(traceId: string): void {
  raceSessions.delete(traceId);
  const file = getRaceSessionFile(traceId);
  if (existsSync(file)) {
    try {
      unlinkSync(file);
    } catch {
      // best-effort cleanup
    }
  }
}

export function cleanupStaleRaceSessions(): void {
  const now = Date.now();

  for (const [id, session] of [...raceSessions.entries()]) {
    if (now - session.createdAt > RACE_SESSION_TTL_MS) {
      deleteRaceSession(id);
    }
  }

  const dir = getRaceSessionsDir();
  if (!existsSync(dir)) return;

  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".race.json")) continue;
    const traceId = entry.slice(0, -".race.json".length);
    const session = loadRaceSessionFromDisk(traceId);
    if (session && now - session.createdAt <= RACE_SESSION_TTL_MS) continue;
    deleteRaceSession(traceId);
  }
}
