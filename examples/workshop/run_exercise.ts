import { runPipelineMode } from "../../src/tools/run-pipeline.js";

async function main() {
  console.log("🚀 Starting Multi-Agent Orchestration Exercise...");
  console.log("Target: examples/workshop/math_processor.ts (Sync -> Async Refactor)");
  
  const prompt = `Refactor MathProcessor.process in examples/workshop/math_processor.ts to be async with a 100ms delay.
First, in the ANALYZE step, you MUST identify that this is a breaking change and suggest a follow-up task named "verify_async" using the "cli" provider.
Use the <NEXT_STEPS>[{"name": "verify_async", "provider": "cli"}]</NEXT_STEPS> format and provide <INSIGHTS> about the change.`;

  try {
    const result = await runPipelineMode({
      prompt,
      language: "typescript",
      workDir: process.cwd(),
      maxRounds: 3
    });
    
    console.log("\n✅ Exercise Completed!");
    console.log("Final Status:", result.status);
    console.log("Rounds Taken:", result.rounds);
    console.log("Trace ID:", result.traceId);
    console.log("\nStep Results:");
    console.log(JSON.stringify(result.stepResults, null, 2));
  } catch (err) {
    console.error("\n❌ Exercise Failed:", err);
    process.exit(1);
  }
}

main();
