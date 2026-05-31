import { LLMProvider, LLMRequest, LLMResponse, ProviderMode } from "./types.js";
import { logger } from "../core/logger.js";

/** Whether this provider name represents a "lite" / lower-tier mock. */
function isLiteTier(name: string): boolean {
  return name === "openai-lite" || /[-_]lite$/i.test(name) || /^mock-b$/i.test(name);
}

export class MockProvider implements LLMProvider {
  name: string;
  mode: ProviderMode = "text";

  constructor(name: string) {
    this.name = name;
  }

  async execute(req: LLMRequest): Promise<LLMResponse> {
    const stepName = req.stepName || "unknown";
    logger.info("mock-provider", `Executing step: ${stepName}`, { provider: this.name });
    const lite = isLiteTier(this.name);

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

    if (stepName === "implement" || stepName === "fix") {
      if (lite) {
        // Lite tier: smaller output, fewer tokens
        return {
          kind: "text",
          model: "mock-lite",
          content: "Implementation (lite):\n```typescript\nexport function process(data: number[]): number[] {\n  return data.map(x => x * 2);\n}\n```",
          code: "export function process(data: number[]): number[] {\n  return data.map(x => x * 2);\n}",
          explanation: "Compact implementation.",
          usage: { promptTokens: 320, completionTokens: 68 },
        };
      }
      // Full tier: richer output with validation, more tokens
      return {
        kind: "text",
        model: "mock-full",
        content: "Implementation (full):\n```typescript\nexport function process(data: number[]): number[] {\n  if (!Array.isArray(data)) throw new TypeError('Expected array');\n  return data.map((x) => x * 2);\n}\n```",
        code: "export function process(data: number[]): number[] {\n  if (!Array.isArray(data)) throw new TypeError('Expected array');\n  return data.map((x) => x * 2);\n}",
        explanation: "Typed implementation with input validation.",
        usage: { promptTokens: 320, completionTokens: 142 },
      };
    }

    if (stepName === "refactor") {
      if (lite) {
        // Lite tier: valid syntax but untyped — syntax check passes, review catches it
        return {
          kind: "text",
          model: "mock-lite",
          content: "Refactored (lite):\n```typescript\nexport class MathProcessor {\n  async process(a, b) {\n    await new Promise(r => setTimeout(r, 100));\n    return (a * b) + (a / b);\n  }\n}\n```",
          code: "export class MathProcessor {\n  async process(a, b) {\n    await new Promise(r => setTimeout(r, 100));\n    return (a * b) + (a / b);\n  }\n}",
          explanation: "Async refactor without type annotations.",
        };
      }
      // Full tier: properly typed
      return {
        kind: "text",
        model: "mock-full",
        content: "Refactored (full):\n```typescript\nexport class MathProcessor {\n  async process(a: number, b: number): Promise<number> {\n    await new Promise(r => setTimeout(r, 100));\n    return (a * b) + (a / b);\n  }\n}\n```",
        code: "export class MathProcessor {\n  async process(a: number, b: number): Promise<number> {\n    await new Promise(r => setTimeout(r, 100));\n    return (a * b) + (a / b);\n  }\n}",
        explanation: "Typed async/await with 100ms delay.",
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

    if (/review|audit|verdict/i.test(stepName)) {
      return {
        kind: "text",
        model: lite ? "mock-reviewer-lite" : "mock-reviewer-full",
        content: "VERDICT: APPROVED",
        code: "",
        explanation: "Implementation approved.",
        usage: { promptTokens: 480, completionTokens: lite ? 28 : 32 },
      };
    }

    return {
      kind: "text",
      model: "mock",
      content: "VERDICT: APPROVED",
      code: "",
      explanation: "Step completed.",
      usage: { promptTokens: 200, completionTokens: 25 },
    };
  }
}
