import assert from "node:assert/strict";
import test from "node:test";
import { executeProviderRace, resolveRaceBudgetUSD } from "../src/runtime/race-execution.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/providers/types.ts";

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

class TimedMockProvider implements LLMProvider {
  readonly name: string;
  readonly delayMs: number;
  readonly code: string;

  constructor(name: string, delayMs: number, code: string) {
    this.name = name;
    this.delayMs = delayMs;
    this.code = code;
  }

  async execute(req: LLMRequest): Promise<LLMResponse> {
    await delay(this.delayMs, req.signal);
    return {
      kind: "text",
      model: this.name,
      content: "ok",
      code: this.code,
      explanation: "",
    };
  }
}

test("executeProviderRace: early termination aborts slower racers", async () => {
  const fast = new TimedMockProvider("fast", 20, "export const ok = 1;");
  const slow = new TimedMockProvider("slow", 500, "export const ok = 1;");

  const started = Date.now();
  const outcomes = await executeProviderRace({
    providers: [fast, slow],
    stepName: "race",
    earlyTermination: true,
    buildRequest: () => ({ prompt: "race" }),
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 400, `expected early stop, took ${elapsed}ms`);
  const fastOutcome = outcomes.find((o) => o.provider.name === "fast");
  const slowOutcome = outcomes.find((o) => o.provider.name === "slow");
  assert.notEqual(fastOutcome?.resp.failed, true);
  assert.ok(slowOutcome?.resp.failed === true || slowOutcome?.abortedEarly === true);
});

test("resolveRaceBudgetUSD: prefers explicit race budget", () => {
  assert.equal(resolveRaceBudgetUSD(2.5, 100), 2.5);
  assert.equal(resolveRaceBudgetUSD(undefined, 100), 100);
});

test("executeProviderRace: pre-aborted parent signal yields failed stub", async () => {
  const controller = new AbortController();
  controller.abort();
  const provider = new TimedMockProvider("only", 10, "export const ok = 1;");
  const outcomes = await executeProviderRace({
    providers: [provider],
    stepName: "race",
    parentSignal: controller.signal,
    buildRequest: () => ({ prompt: "race" }),
  });
  assert.equal(outcomes[0]?.resp.failed, true);
});
