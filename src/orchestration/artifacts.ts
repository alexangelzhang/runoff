/**
 * Typed Artifacts (Wave 7.5).
 *
 * Structured data types for the core pipeline chain, replacing `unknown` payloads.
 * Each artifact has a discriminant `kind` field for type-safe dispatch.
 */

// --- Artifact Kinds ---

export type ArtifactKind = "plan" | "code" | "diff" | "review" | "verdict" | "patch";

// --- Base ---

interface ArtifactBase {
  /** Stable within a step result; used by observations and trace postmortems. */
  artifactId?: string;
  kind: ArtifactKind;
  /** Agent that produced this artifact. */
  producedBy?: string;
  /** Timestamp of creation. */
  createdAt: number;
}

// --- Plan Artifact ---

/** Output of a planning/analysis step. */
export interface PlanArtifact extends ArtifactBase {
  kind: "plan";
  /** High-level plan or analysis summary. */
  summary: string;
  /** Ordered list of planned actions. */
  steps?: string[];
  /** Identified targets (files, functions, etc.). */
  targets?: string[];
}

// --- Code Artifact ---

/** Output of a text-mode code generation step. */
export interface CodeArtifact extends ArtifactBase {
  kind: "code";
  /** Generated source code. */
  code: string;
  /** Natural language explanation. */
  explanation: string;
  /** Language of the generated code. */
  language?: string;
}

// --- Diff Artifact ---

/** Output of an agent-mode step that produces file changes. */
export interface DiffArtifact extends ArtifactBase {
  kind: "diff";
  /** Git diff output. */
  changes: string;
  /** Summary of what was changed. */
  summary: string;
  /** List of modified file paths. */
  filesModified: string[];
  /** Git diff --stat output. */
  diffStat: string;
}

// --- Review Artifact ---

/** Output of a review step (before verdict parsing). */
export interface ReviewArtifact extends ArtifactBase {
  kind: "review";
  /** Full review text. */
  reviewText: string;
  /** Specific issues found. */
  issues?: string[];
  /** Suggestions for improvement. */
  suggestions?: string[];
}

// --- Verdict Artifact ---

/** Parsed verdict from a review. */
export interface VerdictArtifact extends ArtifactBase {
  kind: "verdict";
  approved: boolean;
  /** Structured feedback (reason for approval or rejection). */
  feedback: string;
  /** Original review text the verdict was parsed from. */
  sourceReview?: string;
}

// --- Patch Artifact ---

/** Binary patch ready for application to source repo. */
export interface PatchArtifact extends ArtifactBase {
  kind: "patch";
  /** Base64-encoded binary patch. */
  patchBase64: string;
  /** Base ref the patch was generated against. */
  baseRef: string;
  /** Files included in the patch. */
  filesModified: string[];
  /** Diff stat summary. */
  diffStat: string;
}

// --- Discriminated Union ---

export type Artifact =
  | PlanArtifact
  | CodeArtifact
  | DiffArtifact
  | ReviewArtifact
  | VerdictArtifact
  | PatchArtifact;

// --- Type Guards ---

export function isPlanArtifact(a: Artifact): a is PlanArtifact { return a.kind === "plan"; }
export function isCodeArtifact(a: Artifact): a is CodeArtifact { return a.kind === "code"; }
export function isDiffArtifact(a: Artifact): a is DiffArtifact { return a.kind === "diff"; }
export function isReviewArtifact(a: Artifact): a is ReviewArtifact { return a.kind === "review"; }
export function isVerdictArtifact(a: Artifact): a is VerdictArtifact { return a.kind === "verdict"; }
export function isPatchArtifact(a: Artifact): a is PatchArtifact { return a.kind === "patch"; }

// --- Factory Helpers ---

export function createPlanArtifact(summary: string, opts?: Partial<Omit<PlanArtifact, "kind">>): PlanArtifact {
  return { kind: "plan", summary, createdAt: Date.now(), ...opts };
}

export function createCodeArtifact(code: string, explanation: string, opts?: Partial<Omit<CodeArtifact, "kind">>): CodeArtifact {
  return { kind: "code", code, explanation, createdAt: Date.now(), ...opts };
}

export function createDiffArtifact(changes: string, summary: string, filesModified: string[], diffStat: string, opts?: Partial<Omit<DiffArtifact, "kind">>): DiffArtifact {
  return { kind: "diff", changes, summary, filesModified, diffStat, createdAt: Date.now(), ...opts };
}

export function createReviewArtifact(
  reviewText: string,
  opts?: Partial<Omit<ReviewArtifact, "kind" | "reviewText">>,
): ReviewArtifact {
  return { kind: "review", reviewText, createdAt: Date.now(), ...opts };
}

export function createVerdictArtifact(approved: boolean, feedback: string, opts?: Partial<Omit<VerdictArtifact, "kind">>): VerdictArtifact {
  return { kind: "verdict", approved, feedback, createdAt: Date.now(), ...opts };
}

export function createPatchArtifact(patchBase64: string, baseRef: string, filesModified: string[], diffStat: string, opts?: Partial<Omit<PatchArtifact, "kind">>): PatchArtifact {
  return { kind: "patch", patchBase64, baseRef, filesModified, diffStat, createdAt: Date.now(), ...opts };
}

export function assignArtifactIds(stepName: string, artifacts: Artifact[]): Artifact[] {
  return artifacts.map((artifact, index) => ({
    ...artifact,
    artifactId: artifact.artifactId ?? `${stepName}:${artifact.kind}:${index}`,
  }));
}
