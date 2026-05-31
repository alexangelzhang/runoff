import { LLMProvider, LLMRequest, LLMResponse, ProviderMode } from "./types.js";
import { logger } from "../core/logger.js";

export class MockProvider implements LLMProvider {
  name: string;
  mode: ProviderMode = "text";

  constructor(name: string) {
    this.name = name;
  }

  async execute(req: LLMRequest): Promise<LLMResponse> {
    const stepName = req.stepName || "unknown";
    logger.info("mock-provider", `Executing step: ${stepName}`, { provider: this.name });

    if (stepName === "orchestrator-plan") {
      const steps = (req.prompt.match(/Available steps: ([^\n]+)/)?.[1] ?? "implement,review")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const json = JSON.stringify({
        steps: steps.length >= 2 ? [steps[0], steps[1]] : steps,
        maxRounds: 4,
      });
      return {
        kind: "text",
        model: "mock-planner",
        content: json,
        code: "",
        explanation: "Orchestrator plan",
      };
    }

    if (stepName === "orchestrator-reflect") {
      const steps = (req.prompt.match(/Available steps: ([^\n]+)/)?.[1] ?? "implement,review")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const implement = steps.find((s) => !/review|audit|verdict/i.test(s)) ?? steps[0];
      const review = steps.find((s) => /review|audit|verdict/i.test(s)) ?? steps[1];
      const ordered =
        implement && review && implement !== review
          ? [implement, review]
          : steps.length >= 2
            ? [steps[0], steps[1]]
            : steps;
      const json = JSON.stringify({ steps: ordered, maxRounds: 4 });
      return {
        kind: "text",
        model: "mock-reflect",
        content: json,
        code: "",
        explanation: "Orchestrator reflect re-plan",
      };
    }

    if (stepName === "analyze") {
      return {
        kind: "text",
        model: "mock-planner",
        content: "I've analyzed the code. It needs to be async.\n<NEXT_STEPS>[{\"name\": \"verify_async\", \"provider\": \"mock-pro\"}]</NEXT_STEPS>\n<INSIGHTS>{\"strategy\": \"async-refactor\"}</INSIGHTS>",
        code: "",
        explanation: "Refactor plan created.",
        nextSteps: [{ name: "verify_async", provider: "mock-pro" }],
        insights: { "strategy": "async-refactor" }
      };
    }

    if (stepName === "refactor") {
      if (this.name === "openai-lite") {
        // Simulate a failure or bad syntax for Race selection
        return {
          kind: "text",
          model: "mock-lite",
          content: "Refactored with an intentional syntax error.\nexport class MathProcessor { async process(a, b) { return a+b; } ", // Missing final bracket
          code: "export class MathProcessor { async process(a, b) { return a+b; } ",
          explanation: "Incomplete refactor.",
          failed: false
        };
      }
      // Pro model: Perfect refactor
      return {
        kind: "text",
        model: "mock-pro",
        content: "Refactored correctly.\n```typescript\nexport class MathProcessor {\n  async process(a: number, b: number): Promise<number> {\n    await new Promise(r => setTimeout(r, 100));\n    return (a * b) + (a / b);\n  }\n}\n```",
        code: "export class MathProcessor {\n  async process(a: number, b: number): Promise<number> {\n    await new Promise(r => setTimeout(r, 100));\n    return (a * b) + (a / b);\n  }\n}",
        explanation: "Implemented async/await with 100ms delay."
      };
    }

    if (stepName.includes(":race-merge")) {
      return {
        kind: "agent",
        model: "mock-merge",
        summary: "LLM stage merge (mock)",
        changes: "+merged\n",
        filesModified: ["merged.ts"],
        diffStat: "1 file",
        failed: false,
      };
    }

    if (stepName === "verify_async") {
      return {
        kind: "text",
        model: "mock-pro",
        content: "All checks passed. Async verified.",
        code: "",
        explanation: "Dynamic step executed successfully."
      };
    }

    if (stepName === "dream-enrich") {
      const traceMatch = req.prompt.match(/"traceId"\s*:\s*"([^"]+)"/);
      const traceId = traceMatch?.[1] ?? "unknown-trace";
      const json = JSON.stringify({
        proposals: [
          {
            action: "ADD",
            category: "trace_summary",
            content: "Mock dream summary: pipeline completed with lessons learned.",
            evidenceTraceId: traceId,
          },
        ],
      });
      return {
        kind: "text",
        model: "mock-dream",
        content: json,
        code: "",
        explanation: "Dream enrich (mock)",
      };
    }

    return {
      kind: "text",
      model: "mock",
      content: "VERDICT: APPROVED",
      code: "",
      explanation: "Step completed."
    };
  }
}
