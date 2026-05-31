/**
 * Bridge LLM step outcomes → typed Artifacts (Gate 2.7).
 */

import type { LLMResponse } from "../providers/types.js";
import { isAgentResponse, isTextResponse } from "../providers/types.js";
import type { Artifact } from "./artifacts.js";
import {
  createCodeArtifact,
  createDiffArtifact,
  createReviewArtifact,
  createVerdictArtifact,
} from "./artifacts.js";

export function artifactsFromStepResponse(
  response: LLMResponse,
  opts: {
    stepName: string;
    producedBy?: string;
    verdict?: { approved: boolean; feedback: string };
    reviewText?: string;
  },
): Artifact[] {
  if (response.failed) return [];

  const by = opts.producedBy ?? opts.stepName;
  const artifacts: Artifact[] = [];

  if (isTextResponse(response)) {
    artifacts.push(
      createCodeArtifact(response.code, response.explanation ?? "", {
        producedBy: by,
        language: opts.stepName,
      }),
    );
  } else if (isAgentResponse(response)) {
    artifacts.push(
      createDiffArtifact(
        response.changes ?? "",
        response.summary ?? "",
        response.filesModified ?? [],
        response.diffStat ?? "",
        { producedBy: by },
      ),
    );
  }

  if (opts.reviewText) {
    artifacts.push(createReviewArtifact(opts.reviewText, { producedBy: by }));
  }

  if (opts.verdict) {
    artifacts.push(
      createVerdictArtifact(opts.verdict.approved, opts.verdict.feedback, {
        producedBy: by,
        sourceReview: opts.reviewText,
      }),
    );
  }

  return artifacts;
}
