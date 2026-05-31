/**
 * Pipeline context composition — narrow facade for merging user context with hook-injected pattern context.
 */

/** Merge pattern-cache context into the user context string. */
export function composeEffectivePipelineContext(
  context: string | undefined,
  patternContext: string,
): string | undefined {
  if (!patternContext) return context;
  return context ? `${context}\n\n${patternContext}` : patternContext;
}
