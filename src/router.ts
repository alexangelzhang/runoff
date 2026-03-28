/**
 * Smart routing: estimate prompt complexity and route to the best provider.
 * Wave 6: Improved complexity evaluation with decoupled regex matching.
 */

import { aggregateTraceStats, TraceStats } from "./trace.js";

export type Complexity = "low" | "medium" | "high";
export type ModelTier = "lite" | "full";

export interface TaskHints {
  complexity: Complexity;
  reasoningEffort: "low" | "medium" | "high";
  modelTier: ModelTier;
  score: number;
}

const HIGH_COMPLEXITY_PATTERNS = [
  /设计模式|design.?pattern/i,
  /架构设计|architect/i,
  /重构|refactor/i,
  /性能优化|performance.?optim/i,
  /并发|多线程|concurren/i,
  /分布式|distribut/i,
  /微服务|microservice/i,
  /安全|加密|认证|授权|security|encrypt|auth/i,
  /数据库设计|index.?optim|database.?design/i,
  /缓存策略|cache.?strat/i,
  /消息队列|message.?queue/i,
  /事务|一致性|transaction|consistency/i,
  /高可用|容灾|high.?availab/i
];

const MEDIUM_COMPLEXITY_PATTERNS = [
  /实现|develop|implement/i,
  /编写|编写|create|build/i,
  /接口|API|interface/i,
  /类|模块|组件|class|module|component/i,
  /服务|中间件|service|middleware/i,
  /处理|handler|controller/i,
  /解析|校验|parser|validator/i
];

const complexityCache = new Map<string, number>();
const MAX_CACHE_SIZE = 100;

let _statsCache: { data: TraceStats; expireAt: number } | null = null;
const STATS_TTL_MS = 60 * 1000;

function getCachedStats(): TraceStats {
  const now = Date.now();
  if (_statsCache && _statsCache.expireAt > now) return _statsCache.data;
  const stats = aggregateTraceStats();
  _statsCache = { data: stats, expireAt: now + STATS_TTL_MS };
  return stats;
}

export function computeComplexityScore(prompt: string): number {
  if (complexityCache.has(prompt)) return complexityCache.get(prompt)!;
  
  let score = 0;
  const len = prompt.length;
  // Base length score
  if (len > 2000) score += 30; else if (len > 800) score += 15; else if (len > 300) score += 5;

  // Semantic keyword score (Decoupled)
  for (const pattern of HIGH_COMPLEXITY_PATTERNS) {
    if (pattern.test(prompt)) score += 25;
  }
  for (const pattern of MEDIUM_COMPLEXITY_PATTERNS) {
    if (pattern.test(prompt)) score += 10;
  }

  // Structural score
  const codeBlocks = (prompt.match(/```/g) || []).length / 2;
  const requirements = (prompt.match(/^[\s]*[-*•\d+.)]\s/gm) || []).length;
  score += (codeBlocks * 10) + (requirements * 2);

  const finalScore = Math.max(0, Math.min(100, score));
  if (complexityCache.size >= MAX_CACHE_SIZE) {
    complexityCache.delete(complexityCache.keys().next().value!);
  }
  complexityCache.set(prompt, finalScore);
  return finalScore;
}

export function estimateComplexity(prompt: string): TaskHints {
  const score = computeComplexityScore(prompt);
  // Tier thresholds (Sensitive to core high-value keywords)
  if (score >= 25) return { complexity: "high", reasoningEffort: "high", modelTier: "full", score };
  if (score >= 10) return { complexity: "medium", reasoningEffort: "medium", modelTier: "full", score };
  return { complexity: "low", reasoningEffort: "low", modelTier: "lite", score };
}

export interface RouteRule {
  complexity?: Complexity;
  pattern?: string;
  provider: string;
}

export function routeProvider(
  prompt: string,
  rules: RouteRule[],
  defaultProvider: string,
  canUseProvider: (provider: string) => boolean = () => true,
): string {
  const stats = getCachedStats();

  // 1. Regex Pattern Matching (Explicit User Rules)
  for (const rule of rules) {
    if (rule.pattern && canUseProvider(rule.provider)) {
      try {
        if (new RegExp(rule.pattern, "i").test(prompt)) return rule.provider;
      } catch (e) {}
    }
  }

  // 2. Intelligent Routing (Dynamic Biasing)
  const hints = estimateComplexity(prompt);
  const candidates = rules.filter((r) => r.complexity === hints.complexity && canUseProvider(r.provider));
  
  if (candidates.length === 0) return defaultProvider;
  if (candidates.length === 1) return candidates[0].provider;

  // Use historical trace data to pick the most reliable winner
  const scored = candidates.map((c) => {
    const pStat = stats.providerStats[c.provider];
    const failureRatio = stats.totalTraces > 0 ? stats.failedCount / stats.totalTraces : 0;
    const successRate = pStat && pStat.stepCount > 0 ? (pStat.stepCount - (stats.failedCount / stats.totalTraces * pStat.stepCount)) / pStat.stepCount : 1.0;
    return { provider: c.provider, successRate };
  });

  scored.sort((a, b) => b.successRate - a.successRate);
  return scored[0].provider;
}

/**
 * Wave 6: Identify if a provider is premium.
 */
export function getProviderTier(providerName: string): ModelTier {
  const p = providerName.toLowerCase();
  if (p.includes("mini") || p.includes("flash") || p.includes("haiku") || p.includes("lite")) return "lite";
  if (p.includes("gpt-4") || p.includes("sonnet") || p.includes("pro") || p.includes("o1")) return "full";
  return "full"; // Default to full for reliability
}

/**
 * Wave 6: Find a more powerful provider for the same task.
 */
export function findUpgradedProvider(currentProvider: string, availableProviders: string[]): string {
  const currentTier = getProviderTier(currentProvider);
  if (currentTier === "full") {
    // Already full, but maybe try a different brand?
    const others = availableProviders.filter(p => p !== currentProvider && getProviderTier(p) === "full");
    return others.length > 0 ? others[0] : currentProvider;
  }
  // Currently lite, find first full
  const full = availableProviders.filter(p => getProviderTier(p) === "full");
  return full.length > 0 ? full[0] : currentProvider;
}
