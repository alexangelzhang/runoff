/**
 * Control plane factory — memory (dev) vs file-backed (durable, Gate 2).
 */

import { join } from "node:path";
import { getControlPlaneDir } from "../core/paths.js";
import type { PipelineConfig } from "../core/config.js";
import { InMemoryMessageBus, type MessageBus } from "./bus.js";
import { FileMessageBus } from "./durable-bus.js";
import { InMemoryEventLog, type EventLog } from "./event-log.js";
import { FileEventLog } from "./durable-event-log.js";
import { InMemoryRunStore, type RunStore } from "./run-store.js";
import { FileRunStore } from "./durable-run-store.js";

export type ControlPlaneMode = "memory" | "file";

export interface ControlPlane {
  mode: ControlPlaneMode;
  runStore: RunStore;
  eventLog: EventLog;
  messageBus: MessageBus;
}

export function resolveControlPlaneMode(config: PipelineConfig): ControlPlaneMode {
  const env = process.env.RUNOFF_CONTROL_PLANE;
  if (env === "file" || env === "durable") return "file";
  if (env === "memory") return "memory";
  return config.runtime?.controlPlane === "file" ? "file" : "memory";
}

export function createControlPlane(
  config: PipelineConfig,
  baseDir?: string,
): ControlPlane {
  const mode = resolveControlPlaneMode(config);
  if (mode === "memory") {
    return {
      mode,
      runStore: new InMemoryRunStore(),
      eventLog: new InMemoryEventLog(),
      messageBus: new InMemoryMessageBus(),
    };
  }

  const root = baseDir ?? getControlPlaneDir();
  return {
    mode,
    runStore: new FileRunStore(join(root, "runs")),
    eventLog: new FileEventLog(join(root, "events.jsonl"), join(root, "events-meta.json")),
    messageBus: new FileMessageBus(join(root, "messages.jsonl")),
  };
}
