/**
 * In-process registry for multi-provider race sessions (llm_race_apply / abort).
 * Lives under src/ so core execution (scheduler) does not depend on MCP tools/.
 */

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
  applyTargetPath: string;
  candidates: RaceCandidateSnapshot[];
  createdAt: number;
}

export const raceSessions = new Map<string, RaceSession>();

const RACE_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function cleanupStaleRaceSessions(): void {
  const now = Date.now();
  for (const [id, session] of raceSessions) {
    if (now - session.createdAt > RACE_SESSION_TTL_MS) {
      raceSessions.delete(id);
    }
  }
}
