/**
 * Smart routing: estimate prompt complexity and route to the best provider.
 * Wave 6: Improved complexity evaluation with decoupled regex matching.
 */

import { aggregateTraceStats, TraceStats } from "../observability/trace.js";
import { getTracesDir } from "../core/paths.js";

import type { ProviderConfig } from "../core/config.js";

export type Complexity = "low" | "medium" | "high";
export type ModelTier = "lite" | "full";
export type TaskType = "general" | "implement" | "review" | "refactor" | "architecture";

export interface TaskHints {
  complexity: Complexity;
  reasoningEffort: "low" | "medium" | "high";
  modelTier: ModelTier;
  score: number;
  taskType: TaskType;
}

export interface EstimateComplexityOptions {
  stepName?: string;
  taskType?: TaskType;
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
  /编写|create|build/i,
  /接口|API|interface/i,
  /类|模块|组件|class|module|component/i,
  /服务|中间件|service|middleware/i,
  /处理|handler|controller/i,
  /解析|校验|parser|validator/i
];

const complexityCache = new Map<string, number>();
const MAX_CACHE_SIZE = 100;

let _statsCache: { data: TraceStats; expireAt: number; tracesDir: string } | null = null;
const STATS_TTL_MS = 60 * 1000;

function getCachedStats(): TraceStats {
  const now = Date.now();
  const tracesDir = getTracesDir();
  if (_statsCache && _statsCache.expireAt > now && _statsCache.tracesDir === tracesDir) return _statsCache.data;
  const stats = aggregateTraceStats();
  _statsCache = { data: stats, expireAt: now + STATS_TTL_MS, tracesDir };
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
    if (pattern.test(prompt)) score += 5;
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

/** Infer task type from step name + prompt (Phase 5.1 second dimension). */
export function inferTaskType(prompt: string, stepName?: string): TaskType {
  if (stepName && /review|audit|verdict|judge/i.test(stepName)) return "review";
  if (stepName && /refactor|migrate/i.test(stepName)) return "refactor";
  if (stepName && /arch|design|plan/i.test(stepName)) return "architecture";
  if (/审查|评审|review|verdict|audit/i.test(prompt)) return "review";
  if (/重构|refactor|migrate/i.test(prompt)) return "refactor";
  if (/架构|architect|design pattern|分布式|微服务/i.test(prompt)) return "architecture";
  if (/实现|implement|编写|develop|create|build/i.test(prompt)) return "implement";
  return "general";
}

// Bias thresholds relative to the tier boundaries (low < MEDIUM_THRESHOLD <= medium < HIGH_THRESHOLD <= high).
// "review" is capped below medium so it always routes to the lite tier by default.
// "architecture" is floored above high so it always gets the full model.
const SCORE_MEDIUM_THRESHOLD = 10;
const SCORE_HIGH_THRESHOLD = 25;
const BIAS_REVIEW_MAX = SCORE_MEDIUM_THRESHOLD - 1;   // 9: force low → lite tier
const BIAS_ARCHITECTURE_MIN = SCORE_HIGH_THRESHOLD + 3; // 28: force high → full tier
const BIAS_REFACTOR_MIN = SCORE_MEDIUM_THRESHOLD + 5;   // 15: at least medium
const BIAS_IMPLEMENT_MIN = SCORE_MEDIUM_THRESHOLD - 2;  // 8: slight nudge above low

export function applyTaskTypeBias(score: number, taskType: TaskType): number {
  switch (taskType) {
    case "review":
      return Math.min(score, BIAS_REVIEW_MAX);
    case "architecture":
      return Math.max(score, BIAS_ARCHITECTURE_MIN);
    case "refactor":
      return Math.max(score, BIAS_REFACTOR_MIN);
    case "implement":
      return Math.max(score, BIAS_IMPLEMENT_MIN);
    default:
      return score;
  }
}

export function estimateComplexity(prompt: string, options?: EstimateComplexityOptions): TaskHints {
  const taskType = options?.taskType ?? inferTaskType(prompt, options?.stepName);
  const rawScore = computeComplexityScore(prompt);
  const score = Math.max(0, Math.min(100, applyTaskTypeBias(rawScore, taskType)));

  if (score >= 25) {
    return { complexity: "high", reasoningEffort: "high", modelTier: "full", score, taskType };
  }
  if (score >= 10) {
    return { complexity: "medium", reasoningEffort: "medium", modelTier: "full", score, taskType };
  }
  return { complexity: "low", reasoningEffort: "low", modelTier: "lite", score, taskType };
}

export interface RouteRule {
  complexity?: Complexity;
  pattern?: string;
  provider: string;
}

export interface RouteProviderOptions {
  stepName?: string;
  taskType?: TaskType;
}

export function scoreProviderCandidates(
  candidates: RouteRule[],
  stats: TraceStats,
  hints: TaskHints,
  providers?: Record<string, ProviderConfig>,
): Array<{ provider: string; score: number }> {
  return candidates.map((c) => {
    const pStat = stats.providerStats[c.provider];
    const failureRate = pStat?.failureRate ?? 0.5;
    const successRate = pStat?.successRate ?? 0.5;
    const volume = pStat?.stepCount ?? 0;
    const latencyMs = pStat?.durationP95Ms ?? pStat?.avgDurationMs;
    const latencyPenalty = latencyMs ? Math.min(latencyMs / 60_000, 0.2) : 0;
    const taskBoost = hints.taskType === "review" && getProviderTier(c.provider, providers) === "full" ? 0.05 : 0;
    const score =
      (1 - failureRate) * 0.5 + successRate * 0.35 + Math.min(volume / 20, 0.1) + taskBoost - latencyPenalty;
    return { provider: c.provider, score };
  });
}

export function routeProvider(
  prompt: string,
  rules: RouteRule[],
  defaultProvider: string,
  canUseProvider: (provider: string) => boolean = () => true,
  options?: RouteProviderOptions,
): string {
  const stats = getCachedStats();

  for (const rule of rules) {
    if (rule.pattern && canUseProvider(rule.provider)) {
      try {
        if (new RegExp(rule.pattern, "i").test(prompt)) return rule.provider;
      } catch {
        /* invalid regex */
      }
    }
  }

  const hints = estimateComplexity(prompt, {
    stepName: options?.stepName,
    taskType: options?.taskType,
  });
  const candidates = rules.filter((r) => r.complexity === hints.complexity && canUseProvider(r.provider));

  if (candidates.length === 0) return defaultProvider;
  if (candidates.length === 1) return candidates[0].provider;

  const scored = scoreProviderCandidates(candidates, stats, hints);
  scored.sort((a, b) => b.score - a.score);
  return scored[0]!.provider;
}

/**
 * Wave 6: Identify if a provider is premium.
 */
export function getProviderTier(
  providerName: string,
  providers?: Record<string, ProviderConfig>,
): ModelTier {
  const declared = providers?.[providerName]?.tier;
  if (declared === "lite" || declared === "full") return declared;

  const p = providerName.toLowerCase();
  if (p.includes("mini") || p.includes("flash") || p.includes("haiku") || p.includes("lite")) {
    return "lite";
  }
  if (p.includes("gpt-4") || p.includes("sonnet") || p.includes("pro") || p.includes("o1")) {
    return "full";
  }
  return "full";
}

/**
 * Wave 6: Find a more powerful provider for the same task.
 */
export function findUpgradedProvider(
  currentProvider: string,
  availableProviders: string[],
  providers?: Record<string, ProviderConfig>,
): string {
  const currentTier = getProviderTier(currentProvider, providers);
  if (currentTier === "full") {
    const others = availableProviders.filter(
      (p) => p !== currentProvider && getProviderTier(p, providers) === "full",
    );
    return others.length > 0 ? others[0]! : currentProvider;
  }
  const full = availableProviders.filter((p) => getProviderTier(p, providers) === "full");
  return full.length > 0 ? full[0]! : currentProvider;
}
