/**
 * Candidate: unified result model for pipeline step output.
 * Replaces the text-centric lastCode/lastOutputIsAgent split with a single
 * structured object that works for both text and agent providers.
 */

export interface VerdictResult {
  approved: boolean;
  feedback: string;
}

export interface Candidate {
  /** Session workspace path (agent mode) */
  workspace?: string;
  /** Generated code (text mode) */
  code?: string;
  /** Git diff / changes (agent mode) */
  changes?: string;
  /** Files modified by agent */
  filesModified?: string[];
  /** Git diff stat summary */
  diffStat?: string;
  /** Agent execution summary / explanation */
  summary?: string;
  /** External verification output (tests, linter, compiler) */
  verifyResults?: string;
  /** Review verdict from review step */
  reviewVerdict?: VerdictResult;
  /** Whether the output came from an agent provider */
  isAgent?: boolean;
}

/** Get the primary content from a candidate (code or changes, respecting isAgent). */
export function getCandidateContent(c: Candidate): string {
  if (c.isAgent) return c.changes || c.code || "";
  return c.code || c.changes || "";
}

/** Get a display label for the candidate content type. */
export function getCandidateContentLabel(c: Candidate): string {
  return c.isAgent ? "Changes" : "Code";
}

/** Create an empty candidate. */
export function emptyCandidate(): Candidate {
  return {};
}
