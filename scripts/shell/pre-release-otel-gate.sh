#!/usr/bin/env bash
# Pre-release OTel collector gate — single entry used by real-provider-smoke-pre-release.yml.
#
# Resolves:
#   - Persistent binary cache on Actions runners (RUNNER_TOOL_CACHE)
#   - Optional org collector URL (no local start): vars.LLM_PIPELINE_OTEL_ENDPOINT
#   - Stale process / port cleanup before start
#
# Requires: npm ci already run in repo root.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Persistent home on self-hosted / GitHub Actions (binary survives across workflow runs).
if [[ -n "${RUNNER_TOOL_CACHE:-}" ]]; then
  export LLM_PIPELINE_HOME="${LLM_PIPELINE_OTEL_CACHE_DIR:-$RUNNER_TOOL_CACHE/llm-pipeline-otel}"
else
  export LLM_PIPELINE_HOME="${LLM_PIPELINE_OTEL_CACHE_DIR:-${LLM_PIPELINE_HOME:-$HOME/.llm-pipeline}/pre-release-otel}"
fi
mkdir -p "$LLM_PIPELINE_HOME/bin"

export LLM_PIPELINE_OTEL_DOWNLOAD="${LLM_PIPELINE_OTEL_DOWNLOAD:-1}"
export LLM_PIPELINE_OTEL_COLLECTOR_REQUIRED="${LLM_PIPELINE_OTEL_COLLECTOR_REQUIRED:-1}"
export LLM_PIPELINE_OTEL_RECLAIM_PORT="${LLM_PIPELINE_OTEL_RECLAIM_PORT:-1}"

# Repository variable: corporate / shared collector (offline-friendly, no GitHub download).
if [[ -n "${LLM_PIPELINE_OTEL_ENDPOINT:-}" ]]; then
  export OTEL_EXPORTER_OTLP_ENDPOINT="${LLM_PIPELINE_OTEL_ENDPOINT}"
  export LLM_PIPELINE_OTEL_SKIP_START="1"
  echo "pre-release-otel: using external collector at $OTEL_EXPORTER_OTLP_ENDPOINT"
else
  export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://127.0.0.1:4318}"
  export LLM_PIPELINE_OTEL_SKIP_START="${LLM_PIPELINE_OTEL_SKIP_START:-0}"
fi

echo "pre-release-otel: LLM_PIPELINE_HOME=$LLM_PIPELINE_HOME"

precheck() {
  if [[ "${LLM_PIPELINE_OTEL_SKIP_START:-0}" == "1" ]]; then
    if ! command -v curl &>/dev/null; then
      echo "pre-release-otel: WARN — curl missing; TCP probe may be limited" >&2
    fi
    return 0
  fi
  if resolve_collector_bin_precheck; then
    echo "pre-release-otel: collector binary already available"
    return 0
  fi
  if [[ -x "$LLM_PIPELINE_HOME/bin/otelcol-contrib" ]]; then
    echo "pre-release-otel: cached binary at $LLM_PIPELINE_HOME/bin/otelcol-contrib"
    return 0
  fi
  if [[ "${LLM_PIPELINE_OTEL_DOWNLOAD:-0}" == "1" ]] && command -v curl &>/dev/null; then
    echo "pre-release-otel: will download otelcol-contrib on first start"
    return 0
  fi
  echo "pre-release-otel: FAIL — no collector binary, curl, or LLM_PIPELINE_OTEL_ENDPOINT" >&2
  echo "  Fix: set repository variable LLM_PIPELINE_OTEL_ENDPOINT, or install otelcol-contrib on runner, or ensure curl for download." >&2
  echo "  See docs/operations/observability-collector-local.md and docs/operations/real-provider-smoke-runner-checklist.md" >&2
  exit 1
}

resolve_collector_bin_precheck() {
  local name
  [[ -n "${LLM_PIPELINE_OTEL_BIN:-}" && -x "${LLM_PIPELINE_OTEL_BIN}" ]] && return 0
  [[ -x "$LLM_PIPELINE_HOME/bin/otelcol-contrib" ]] && return 0
  for name in otelcol-contrib otelcol; do
    command -v "$name" &>/dev/null && return 0
  done
  return 1
}

on_fail() {
  echo "pre-release-otel: gate failed — collector status:" >&2
  bash "$ROOT/scripts/shell/otel-collector.sh" status >&2 || true
  if [[ -f "$LLM_PIPELINE_HOME/otel-collector.log" ]]; then
    echo "pre-release-otel: last 40 lines of log:" >&2
    tail -n 40 "$LLM_PIPELINE_HOME/otel-collector.log" >&2 || true
  fi
}

trap on_fail ERR

precheck

bash "$ROOT/scripts/shell/otel-collector.sh" stop || true

bash "$ROOT/scripts/shell/otel-collector.sh" start

npm run verify:otel-collector

bash "$ROOT/scripts/shell/otel-collector.sh" stop

echo "pre-release-otel: OK"
