import assert from "node:assert/strict";
import test from "node:test";
import {
  computeComplexityScore,
  estimateComplexity,
  findUpgradedProvider,
  getProviderTier,
  inferTaskType,
  routeProvider,
  type RouteRule,
} from "../src/routing/router.ts";

// --- computeComplexityScore ---

test("computeComplexityScore: trivial prompt scores low", () => {
  const score = computeComplexityScore("hello world");
  assert.ok(score < 15, `Expected low score, got ${score}`);
});

test("computeComplexityScore: long prompt with high-complexity keywords scores high", () => {
  const prompt = "请设计一个分布式微服务架构，需要考虑高可用、缓存策略和消息队列。" +
    "系统必须支持并发处理和事务一致性。".repeat(10);
  const score = computeComplexityScore(prompt);
  assert.ok(score >= 45, `Expected high score (>=45), got ${score}`);
});

test("computeComplexityScore: medium keywords produce medium score", () => {
  const prompt = "实现一个API接口，创建一个服务组件来处理请求";
  const score = computeComplexityScore(prompt);
  assert.ok(score >= 8 && score < 45, `Expected medium range, got ${score}`);
});

test("computeComplexityScore: low keywords reduce score", () => {
  const withLow = computeComplexityScore("hello world example demo test");
  const withoutLow = computeComplexityScore("process data transform");
  assert.ok(withLow <= withoutLow, `Low keywords should reduce score: ${withLow} vs ${withoutLow}`);
});

test("computeComplexityScore: code blocks add points", () => {
  const withBlocks = computeComplexityScore("fix this:\n```js\nconst x = 1;\n```\n```js\nconst y = 2;\n```");
  const withoutBlocks = computeComplexityScore("fix this: const x = 1; const y = 2;");
  assert.ok(withBlocks > withoutBlocks, `Code blocks should add points: ${withBlocks} vs ${withoutBlocks}`);
});

test("computeComplexityScore: requirements density adds points", () => {
  const prompt = "- 必须支持并发\n- 需要缓存\n1. must handle errors\n2. should log";
  const score = computeComplexityScore(prompt);
  // Requirements alone should contribute some points
  assert.ok(score > 0, `Requirements should add points, got ${score}`);
});

test("computeComplexityScore: score clamped to 0-100", () => {
  const low = computeComplexityScore("hello world example demo test simple 简单 示例");
  assert.ok(low >= 0, `Score should not go below 0, got ${low}`);

  const high = computeComplexityScore(
    "设计模式 架构设计 重构 性能优化 并发 多线程 分布式 微服务 安全 加密 认证 授权 " +
    "数据库设计 索引优化 缓存策略 消息队列 事务 一致性 高可用 容灾 " +
    "必须 需要 要求 must should shall require " +
    "```code```\n```code```\n```code```\n" +
    "x".repeat(3000)
  );
  assert.ok(high <= 100, `Score should not exceed 100, got ${high}`);
});

test("computeComplexityScore: frequency matters — multiple high keywords score more", () => {
  const one = computeComplexityScore("设计模式");
  const three = computeComplexityScore("设计模式 架构设计 重构");
  assert.ok(three > one, `3 high keywords should score more than 1: ${three} vs ${one}`);
});

// --- estimateComplexity ---

test("estimateComplexity: low score maps to low complexity", () => {
  const hints = estimateComplexity("hello world");
  assert.equal(hints.complexity, "low");
  assert.equal(hints.modelTier, "lite");
});

test("estimateComplexity: high score maps to high complexity", () => {
  const prompt = "设计一个分布式微服务架构，需要高可用和缓存策略".repeat(5);
  const hints = estimateComplexity(prompt);
  assert.equal(hints.complexity, "high");
  assert.equal(hints.modelTier, "full");
});

// --- routeProvider ---

test("routeProvider: matches rule by complexity", () => {
  const rules: RouteRule[] = [
    { complexity: "high", provider: "codex" },
    { complexity: "low", provider: "gemini" },
  ];
  const result = routeProvider("hello world", rules, "default");
  assert.equal(result, "gemini");
});

test("routeProvider: falls back to default when no rule matches", () => {
  const rules: RouteRule[] = [
    { complexity: "high", provider: "codex" },
  ];
  const result = routeProvider("hello world", rules, "fallback-provider");
  assert.equal(result, "fallback-provider");
});

test("routeProvider: respects canUseProvider filter", () => {
  const rules: RouteRule[] = [
    { complexity: "low", provider: "blocked" },
    { complexity: "low", provider: "allowed" },
  ];
  const result = routeProvider("hello world", rules, "default", (p) => p !== "blocked");
  // "blocked" matches complexity but is filtered out; no second low rule matches since find() returns first match
  // Actually both rules have complexity "low", find() returns first matching — "blocked" is filtered, then "allowed" matches
  assert.equal(result, "allowed");
});

test("routeProvider: empty rules returns default", () => {
  const result = routeProvider("anything", [], "my-default");
  assert.equal(result, "my-default");
});

// --- inferTaskType / taskType bias (Phase 5.1) ---

test("inferTaskType: step name review wins", () => {
  assert.equal(inferTaskType("implement feature X", "review"), "review");
});

test("estimateComplexity: review step caps score → low tier", () => {
  const prompt = "设计一个分布式微服务架构，需要高可用".repeat(5);
  const hints = estimateComplexity(prompt, { stepName: "review" });
  assert.equal(hints.taskType, "review");
  assert.equal(hints.complexity, "low");
  assert.equal(hints.modelTier, "lite");
});

// --- declarative tier (Phase 5.3) ---

test("getProviderTier: config tier overrides name heuristics", () => {
  assert.equal(getProviderTier("fast-mini", { "fast-mini": { type: "mock", tier: "full" } }), "full");
  assert.equal(getProviderTier("big-pro", { "big-pro": { type: "mock", tier: "lite" } }), "lite");
});

test("findUpgradedProvider: uses declared tier not name", () => {
  const providers = {
    cheap: { type: "mock" as const, tier: "lite" as const },
    strong: { type: "mock" as const, tier: "full" as const },
  };
  assert.equal(findUpgradedProvider("cheap", ["cheap", "strong"], providers), "strong");
});
