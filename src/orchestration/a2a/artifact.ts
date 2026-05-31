/**
 * A2A Artifact (Wave 7.9).
 *
 * Result exchange format for inter-agent communication.
 * Reference: Google Agent2Agent Protocol — Artifact.
 *
 * A2A artifacts are the "currency" exchanged between agents:
 * code, diffs, reports, structured data, or binary blobs.
 */

// --- Artifact Part ---

export type A2AArtifactPart =
  | { type: "text"; text: string; mimeType?: string }
  | { type: "data"; data: Record<string, unknown>; mimeType?: string }
  | { type: "file"; uri: string; mimeType: string; name?: string };

// --- Artifact ---

export interface A2AArtifact {
  /** Unique artifact identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Description of what this artifact contains. */
  description?: string;
  /** Parts that make up this artifact. */
  parts: A2AArtifactPart[];
  /** Metadata. */
  metadata?: Record<string, unknown>;
  /** When this artifact was created. */
  createdAt: number;
}

// --- Factory Helpers ---

let nextArtifactId = 1;

export function createTextArtifact(name: string, text: string, mimeType = "text/plain"): A2AArtifact {
  return {
    id: `a2a-art-${nextArtifactId++}`,
    name,
    parts: [{ type: "text", text, mimeType }],
    createdAt: Date.now(),
  };
}

export function createCodeArtifact(name: string, code: string, language: string): A2AArtifact {
  return {
    id: `a2a-art-${nextArtifactId++}`,
    name,
    parts: [{ type: "text", text: code, mimeType: `text/x-${language}` }],
    metadata: { language },
    createdAt: Date.now(),
  };
}

export function createDataArtifact(name: string, data: Record<string, unknown>): A2AArtifact {
  return {
    id: `a2a-art-${nextArtifactId++}`,
    name,
    parts: [{ type: "data", data, mimeType: "application/json" }],
    createdAt: Date.now(),
  };
}

export function createFileArtifact(name: string, uri: string, mimeType: string): A2AArtifact {
  return {
    id: `a2a-art-${nextArtifactId++}`,
    name,
    parts: [{ type: "file", uri, mimeType, name }],
    createdAt: Date.now(),
  };
}

/** Reset the artifact ID counter (for testing). */
export function resetArtifactIdCounter(): void {
  nextArtifactId = 1;
}
