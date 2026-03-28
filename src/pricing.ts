/**
 * LLM Pricing Engine — estimates cost based on token usage and model pricing.
 *
 * Pricing data is embedded as a static table. Rates are in USD per 1M tokens.
 * Supports input/output price differentiation and cached-input discounts.
 */

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  /** Discounted input rate when prompt caching is active */
  cachedInputPer1M?: number;
}

/** Prices in USD per 1M tokens. Updated 2026-03. */
const PRICING_TABLE: Record<string, ModelPricing> = {
  // OpenAI
  "gpt-4o":       { inputPer1M: 2.50, outputPer1M: 10.00, cachedInputPer1M: 1.25 },
  "gpt-4o-mini":  { inputPer1M: 0.15, outputPer1M: 0.60,  cachedInputPer1M: 0.075 },
  "o1":           { inputPer1M: 15.00, outputPer1M: 60.00, cachedInputPer1M: 7.50 },
  "o1-mini":      { inputPer1M: 1.10, outputPer1M: 4.40,  cachedInputPer1M: 0.55 },
  "o3-mini":      { inputPer1M: 1.10, outputPer1M: 4.40,  cachedInputPer1M: 0.55 },
  // Anthropic
  "claude-3.5-sonnet": { inputPer1M: 3.00, outputPer1M: 15.00, cachedInputPer1M: 0.30 },
  "claude-3-opus":     { inputPer1M: 15.00, outputPer1M: 75.00, cachedInputPer1M: 1.50 },
  "claude-4-sonnet":   { inputPer1M: 3.00, outputPer1M: 15.00, cachedInputPer1M: 0.30 },
  // Google
  "gemini-2.0-flash":  { inputPer1M: 0.10, outputPer1M: 0.40 },
  "gemini-2.5-pro":    { inputPer1M: 1.25, outputPer1M: 10.00 },
  // Fallback for CLI providers with unknown models
  "default":     { inputPer1M: 1.00, outputPer1M: 3.00 },
};

function findPricing(model: string): ModelPricing {
  const normalized = model.toLowerCase();
  for (const [key, pricing] of Object.entries(PRICING_TABLE)) {
    if (key === "default") continue;
    if (normalized.includes(key)) return pricing;
  }
  return PRICING_TABLE["default"];
}

export interface UsageRecord {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
}

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cachedDiscount: number;
  totalCost: number;
}

/**
 * Calculate estimated cost for a single API call.
 */
export function estimateCost(model: string, usage: UsageRecord): CostBreakdown {
  const pricing = findPricing(model);

  const cachedTokens = usage.cachedTokens ?? 0;
  const uncachedInputTokens = Math.max(0, usage.promptTokens - cachedTokens);

  const uncachedInputCost = (uncachedInputTokens / 1_000_000) * pricing.inputPer1M;
  const cachedInputCost = pricing.cachedInputPer1M
    ? (cachedTokens / 1_000_000) * pricing.cachedInputPer1M
    : (cachedTokens / 1_000_000) * pricing.inputPer1M;
  const inputCost = uncachedInputCost + cachedInputCost;
  const outputCost = (usage.completionTokens / 1_000_000) * pricing.outputPer1M;

  const fullInputCost = (usage.promptTokens / 1_000_000) * pricing.inputPer1M;
  const cachedDiscount = fullInputCost - (uncachedInputCost + cachedInputCost);

  return {
    inputCost,
    outputCost,
    cachedDiscount: Math.max(0, cachedDiscount),
    totalCost: inputCost + outputCost,
  };
}

/**
 * Accumulator for pipeline-wide cost tracking.
 */
export class CostTracker {
  private records: Array<{
    step: string;
    provider: string;
    model: string;
    usage: UsageRecord;
    cost: CostBreakdown;
  }> = [];

  addCall(step: string, provider: string, model: string, usage: UsageRecord): void {
    const cost = estimateCost(model, usage);
    this.records.push({ step, provider, model, usage, cost });
  }

  getTotalCost(): number {
    return this.records.reduce((sum, r) => sum + r.cost.totalCost, 0);
  }

  getTotalTokens(): { promptTokens: number; completionTokens: number } {
    return this.records.reduce(
      (acc, r) => ({
        promptTokens: acc.promptTokens + r.usage.promptTokens,
        completionTokens: acc.completionTokens + r.usage.completionTokens,
      }),
      { promptTokens: 0, completionTokens: 0 }
    );
  }

  getSummary(): {
    totalCostUSD: number;
    totalTokens: number;
    cachedSavingsUSD: number;
    breakdown: Array<{
      step: string;
      provider: string;
      model: string;
      tokens: number;
      costUSD: number;
    }>;
  } {
    const totalCostUSD = this.getTotalCost();
    const tokens = this.getTotalTokens();
    const cachedSavingsUSD = this.records.reduce((sum, r) => sum + r.cost.cachedDiscount, 0);

    return {
      totalCostUSD: Math.round(totalCostUSD * 1_000_000) / 1_000_000,
      totalTokens: tokens.promptTokens + tokens.completionTokens,
      cachedSavingsUSD: Math.round(cachedSavingsUSD * 1_000_000) / 1_000_000,
      breakdown: this.records.map((r) => ({
        step: r.step,
        provider: r.provider,
        model: r.model,
        tokens: r.usage.promptTokens + r.usage.completionTokens,
        costUSD: Math.round(r.cost.totalCost * 1_000_000) / 1_000_000,
      })),
    };
  }
}
