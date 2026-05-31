/**
 * Minimal structured logger for pipeline observability.
 * Outputs JSON-tagged lines with timestamp, level, component, and message.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, component: string, msg: string, extra?: Record<string, unknown>): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    component,
    msg,
    ...extra,
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stderr.write(line + "\n");
  }
}

export const logger = {
  debug: (component: string, msg: string, extra?: Record<string, unknown>) => emit("debug", component, msg, extra),
  info:  (component: string, msg: string, extra?: Record<string, unknown>) => emit("info", component, msg, extra),
  warn:  (component: string, msg: string, extra?: Record<string, unknown>) => emit("warn", component, msg, extra),
  error: (component: string, msg: string, extra?: Record<string, unknown>) => emit("error", component, msg, extra),
};
