/**
 * Pipeline Hooks — wires experiment-log, experiment-judge, event-log,
 * CostTracker (per-step), and pattern-cache into the pipeline lifecycle.
 *
 * Three hooks: onPipelineStart, onStepComplete, onPipelineEnd.
 * run-pipeline.ts calls these at the appropriate points (~10 lines added).
 */

import type { PipelineConfig } from "../core/config.js";
import { calculateConfigHash } from "../core/config.js";
import { estimateCost } from "../routing/pricing.js";
import type { PipelineTrace, StepTrace } from "../observability/trace.js";
import { loadTraceById, updateTrace } from "../observability/trace.js";
import type { PipelineCostAccumulator } from "../routing/pricing.js";
import type { AgentMemory } from "../orchestration/memory.js";
import { PatternCache, hashPrompt } from "../orchestration/pattern-cache.js";
import type { EventLog } from "../orchestration/event-log.js";
import { createControlPlane } from "../orchestration/control-plane.js";
import { OrchestrationEventEmitter, type EventListener } from "../orchestration/events.js";
import { enrichTraceWithEventLog } from "../orchestration/replay.js";
import { agentId } from "../orchestration/multi-agent-types.js";
import { appendExperimentEntry, entryFromTrace, queryExperiments } from "../observability/experiment-log.js";
import { judgeExperiment } from "../orchestration/experiment-judge.js";
import { logger } from "../core/logger.js";
import {
  createTraceExporterFromConfig,
  InMemoryTraceExporter,
  type TraceExporter,
} from "../observability/trace-exporter.js";
import { feedbackRelevanceFromTrace } from "../orchestration/memory-relevance.js";
import { getPipelineMemory, resetPipelineMemoryRegistry } from "../memory/pipeline-memory.js";
import {
  enqueuePipelineMemoryFormation,
  flushPipelineMemoryFormationQueue,
  resetPipelineMemoryFormationQueue,
  resolveMemoryFormationOptions,
  runPipelineMemoryFormationNow,
} from "../memory/pipeline-memory-formation-queue.js";

/** Reset pipeline memory registry (for tests). */
export function resetSharedMemory(): void {
  resetPipelineMemoryRegistry();
  resetPipelineMemoryFormationQueue();
}

export { flushPipelineMemoryFormationQueue };

/** Test hook: local file memory backing all pipeline runs. */
export function getPipelineSharedMemory(): AgentMemory {
  return getPipelineMemory();
}

let _otelExporter: TraceExporter | null = null;
let _otelExporterConfigHash: string | undefined;

/** OTel exporter used when `runtime.otelExport` is enabled (tests). */
export function getPipelineOtelExporter(): TraceExporter | null {
  return _otelExporter;
}

/** Narrow to in-memory payloads when tests use default memory exporter. */
export function getPipelineOtelMemoryExporter(): InMemoryTraceExporter | null {
  return _otelExporter instanceof InMemoryTraceExporter ? _otelExporter : null;
}

export function resetPipelineOtelExporter(): void {
  _otelExporter = null;
  _otelExporterConfigHash = undefined;
}

// --- Context types ---

export interface PipelineStartContext {
  prompt: string;
  config: PipelineConfig;
  traceId: string;
  sessionId: string;
}

export interface StepCompleteContext {
  stepTrace: StepTrace;
  stepName: string;
  provider: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
}

export interface PipelineEndContext {
  trace: PipelineTrace;
  costTracker: PipelineCostAccumulator;
  config?: PipelineConfig;
  /** When set, merges orchestration replay into trace if not already present. */
  eventLog?: EventLog;
  runId?: string;
  /** Final orchestrator blackboard — persisted on trace for Dream promotion. */
  globalKnowledge?: Record<string, string>;
  /** Non-fatal warnings surfaced to MCP/CLI callers. */
  warnings?: string[];
}

/** Fields persisted at pipeline end — single list to avoid enrichment drift. */
function buildTraceEndPatch(
  trace: PipelineTrace,
  sessionId: string,
): Parameters<typeof updateTrace>[1] {
  return {
    sessionId,
    experiment: trace.experiment,
    costSummary: trace.costSummary,
    orchestrationEvents: trace.orchestrationEvents,
    handoffs: trace.handoffs,
    approvals: trace.approvals,
    globalKnowledge: trace.globalKnowledge,
  };
}

function pushWarning(ctx: PipelineEndContext, message: string): void {
  if (!ctx.warnings) ctx.warnings = [];
  ctx.warnings.push(message);
}

export interface PipelineStartResult {
  patternContext: string;
}

// --- PipelineHooks ---

const PIPELINE_AGENT = agentId("pipeline");

export class PipelineHooks {
  private memory: AgentMemory;
  private patternCache: PatternCache;
  private emitter: OrchestrationEventEmitter;
  private experimentId: string;
  private variant: string;
  private prompt: string = "";
  private readonly sessionId: string;
  private readonly config: PipelineConfig;

  constructor(
    config: PipelineConfig,
    traceId: string,
    sessionId: string,
    eventLog?: EventLog,
  ) {
    this.config = config;
    this.sessionId = sessionId;
    this.memory = getPipelineMemory(config, sessionId);
    this.patternCache = new PatternCache(this.memory, { project: "default" });
    const log = eventLog ?? createControlPlane(config).eventLog;
    this.emitter = new OrchestrationEventEmitter(log, traceId);
    this.experimentId = "";
    this.variant = calculateConfigHash(config);
  }

  /** Subscribe to orchestration events (same stream as EventLog append). Returns unsubscribe. */
  addEventListener(listener: EventListener): () => void {
    this.emitter.addListener(listener);
    return () => this.emitter.removeListener(listener);
  }

  async onPipelineStart(ctx: PipelineStartContext): Promise<PipelineStartResult> {
    this.prompt = ctx.prompt;
    this.experimentId = hashPrompt(ctx.prompt);

    let patternContext = "";
    try {
      const orch = ctx.config.orchestration;
      const hybridRetrieve = orch?.memoryHybridRetrieve === true;
      const timeoutMs = orch?.memoryHybridRetrieveTimeoutMs ?? 800;
      patternContext = await this.patternCache.buildAssociativeContextAsync(ctx.prompt, 3, {
        hybridRetrieve,
        timeoutMs,
      });
    } catch {
      // Non-critical — don't break pipeline if pattern matching fails
    }

    try {
      this.emitter.stepStarted(PIPELINE_AGENT, ctx.traceId);
    } catch {
      // Non-critical
    }

    return { patternContext };
  }

  onStepComplete(ctx: StepCompleteContext): void {
    try {
      const cost = estimateCost(ctx.model, ctx.usage);
      ctx.stepTrace.cost = {
        inputCost: cost.inputCost,
        outputCost: cost.outputCost,
        cachedDiscount: cost.cachedDiscount,
        totalCost: cost.totalCost,
      };
    } catch {
      // Non-critical
    }

    try {
      this.emitter.stepFinished(
        PIPELINE_AGENT,
        ctx.stepName,
        !ctx.stepTrace.error,
        ctx.stepTrace.durationMs,
        {
          spanId: ctx.stepTrace.spanId,
          parentSpanId: ctx.stepTrace.parentSpanId,
        },
      );
    } catch {
      // Non-critical
    }
  }

  async onPipelineFailed(ctx: PipelineEndContext): Promise<void> {
    await this.finishPipelineTrace(ctx, { judgeBaseline: false });
  }

  async onPipelineEnd(ctx: PipelineEndContext): Promise<void> {
    await this.finishPipelineTrace(ctx, { judgeBaseline: true });
  }

  private async finishPipelineTrace(
    ctx: PipelineEndContext,
    options: { judgeBaseline: boolean },
  ): Promise<void> {
    let { trace } = ctx;
    if (ctx.eventLog && ctx.runId && !trace.orchestrationEvents?.length) {
      try {
        trace = enrichTraceWithEventLog(trace, ctx.eventLog, ctx.runId);
      } catch {
        // non-critical
      }
    }

    const summary = ctx.costTracker.getSummary();
    trace.costSummary = {
      totalCostUSD: summary.totalCostUSD,
      totalTokens: summary.totalTokens,
      breakdown: summary.breakdown,
    };

    trace.experiment = {
      experimentId: this.experimentId,
      variant: this.variant,
      tags: [],
    };

    try {
      const entry = entryFromTrace(trace);
      if (entry) {
        const history = queryExperiments({ experimentId: this.experimentId });
        const baselineEntry = options.judgeBaseline
          ? history.find((e) => e.status === "approved")
          : undefined;

        if (baselineEntry && trace.finalStatus === "approved") {
          const baselineTrace = loadTraceById(baselineEntry.traceId);
          if (baselineTrace) {
            const result = judgeExperiment(baselineTrace, trace);
            entry.verdict = result.verdict;
            entry.judgeScores = result.scores;
            entry.description = [
              ...result.reasons,
              `scores: correctness=${result.scores.correctness.toFixed(2)} overall=${result.scores.overall.toFixed(2)}`,
            ].join("; ");
          }
        }

        appendExperimentEntry(entry);
      }
    } catch (err: unknown) {
      logger.warn("pipeline-hooks", `Experiment log failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const cfg = ctx.config ?? this.config;
    const formationOpts = resolveMemoryFormationOptions(cfg);
    const formationJob = {
      config: cfg,
      sessionId: this.sessionId,
      trace,
      autoCompact: formationOpts.autoCompact,
      hotPathForget: formationOpts.hotPathForget,
    };
    if (formationOpts.async) {
      enqueuePipelineMemoryFormation(formationJob);
    } else {
      try {
        await runPipelineMemoryFormationNow(formationJob);
      } catch {
        // Non-critical
      }
    }

    trace.sessionId = this.sessionId;
    if (ctx.globalKnowledge && Object.keys(ctx.globalKnowledge).length > 0) {
      trace.globalKnowledge = ctx.globalKnowledge;
    }
    const traceUpdated = updateTrace(trace.id, buildTraceEndPatch(trace, this.sessionId));
    if (!traceUpdated) {
      const msg = `Failed to persist trace enrichment for ${trace.id}`;
      logger.warn("pipeline-hooks", msg);
      pushWarning(ctx, msg);
    }

    if (cfg.runtime?.otelExport) {
      try {
        const cfgHash = calculateConfigHash(cfg);
        if (!_otelExporter || _otelExporterConfigHash !== cfgHash) {
          _otelExporter = createTraceExporterFromConfig(cfg);
          _otelExporterConfigHash = cfgHash;
        }
        if (_otelExporter) {
          await _otelExporter.export(trace).catch((err: unknown) => {
            logger.warn(
              "pipeline-hooks",
              `OTel export failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
      } catch (err: unknown) {
        logger.warn(
          "pipeline-hooks",
          `OTel export setup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    try {
      this.emitter.agentDisposed(PIPELINE_AGENT);
    } catch {
      // Non-critical
    }
  }
}
