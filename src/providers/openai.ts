import OpenAI from "openai";
import { LLMProvider, LLMRequest, LLMResponse, ProviderMode, parseCodeFromResponse } from "./types.js";

export class OpenAIProvider implements LLMProvider {
  name = "openai";
  mode: ProviderMode = "text";
  private client: OpenAI;
  private model: string;

  constructor(model?: string) {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.model = model ?? process.env.OPENAI_MODEL ?? "gpt-4o";
  }

  async execute(req: LLMRequest): Promise<LLMResponse> {
    const systemPrompt = `You are an expert software engineer. Generate clean, production-ready code based on the specification provided.
Rules:
- Output ONLY the code in a single fenced code block, followed by a brief explanation
- Use the specified language, or infer the best one from context
- Follow best practices: proper error handling, clear naming, minimal complexity
- To suggest follow-up tasks, use <NEXT_STEPS>[{"name": "...", "provider": "...", "dependsOn": []}]</NEXT_STE_STEPS>
- To provide architectural insights, use <INSIGHTS>{"key": "value"}</INSIGHTS>`;

    const userPrompt = [
      `## Specification\n${req.prompt}`,
      req.language ? `## Language\n${req.language}` : "",
      req.context ? `## Existing Code Context\n\`\`\`\n${req.context}\n\`\`\`` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 8192,
      },
      { timeout: 300_000 }
    );

    const raw = response.choices[0]?.message?.content ?? "";
    const { code, explanation } = parseCodeFromResponse(raw);
    const usage = response.usage ? { promptTokens: response.usage.prompt_tokens, completionTokens: response.usage.completion_tokens } : undefined;

    // Wave 6/2: Metadata Extraction
    let insights: Record<string, string> | undefined;
    let nextSteps: any[] | undefined;

    const insightsMatch = raw.match(/<INSIGHTS>([\s\S]*?)<\/INSIGHTS>/);
    if (insightsMatch) {
      try { insights = JSON.parse(insightsMatch[1]); } catch (e) { console.warn("Failed to parse insights JSON"); }
    }

    const nextStepsMatch = raw.match(/<NEXT_STEPS>([\s\S]*?)<\/NEXT_STEPS>/);
    if (nextStepsMatch) {
      try { nextSteps = JSON.parse(nextStepsMatch[1]); } catch (e) { console.warn("Failed to parse nextSteps JSON"); }
    }

    return { 
      kind: "text", content: raw, code, explanation, 
      model: response.model, usage, 
      insights, nextSteps 
    };
  }
}
