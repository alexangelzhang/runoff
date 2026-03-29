/**
 * Pure topological staging for pipeline steps (no config loading, no cache).
 * Used by {@link getDagStages} and {@link validateConfig} cycle checks.
 */
export function computePipelineStages(
  pipeline: Record<string, [string | string[], ...string[]]>
): string[][] {
  const stages: string[][] = [];
  const visited = new Set<string>();
  const allSteps = Object.keys(pipeline);

  while (visited.size < allSteps.length) {
    const currentStage: string[] = [];
    for (const step of allSteps) {
      if (visited.has(step)) continue;

      const [, ...deps] = pipeline[step];
      if (deps.every((dep) => visited.has(dep))) {
        currentStage.push(step);
      }
    }

    if (currentStage.length === 0) {
      throw new Error("Circular dependency detected in pipeline configuration");
    }

    for (const step of currentStage) visited.add(step);
    stages.push(currentStage);
  }

  return stages;
}
