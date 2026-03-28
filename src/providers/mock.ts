import { LLMProvider, LLMRequest, LLMResponse, ProviderMode } from "./types.js";

export class MockProvider implements LLMProvider {
  name: string;
  mode: ProviderMode = "text";

  constructor(name: string) {
    this.name = name;
  }

  async execute(req: LLMRequest): Promise<LLMResponse> {
    const stepName = req.stepName || "unknown";
    console.log(`[MockProvider:${this.name}] Executing step: ${stepName}`);

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

    if (stepName === "verify_async") {
      return {
        kind: "text",
        model: "mock-pro",
        content: "All checks passed. Async verified.",
        code: "",
        explanation: "Dynamic step executed successfully."
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
