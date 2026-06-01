#!/usr/bin/env bash
# Start/stop a local OpenTelemetry Collector for runoff OTLP/HTTP smoke tests.
#
# Does NOT require Docker. Resolution order (mode=auto):
#   1. Already listening on RUNOFF_OTEL_PORT (default 4318)
#   2. otelcol-contrib / otelcol on PATH (e.g. brew install opentelemetry-collector)
#   3. ~/.runoff/bin/otelcol-contrib (from a prior download)
#   4. Download official binary when RUNOFF_OTEL_DOWNLOAD=1
#   5. Docker Compose (only if docker is available and earlier steps failed)
#
# Corporate / shared collector (no local install):
#   export OTEL_EXPORTER_OTLP_ENDPOINT=https://your-collector:4318
#   export RUNOFF_OTEL_SKIP_START=1
#   npm run verify:otel-collector
#
# Usage:
#   bash scripts/shell/otel-collector.sh start|stop|status|ensure

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG="${RUNOFF_OTEL_CONFIG:-$ROOT/config/otel-collector-config.yaml}"
COLLECTOR_VERSION="${RUNOFF_OTEL_COLLECTOR_VERSION:-0.120.0}"
HOST="${RUNOFF_OTEL_HOST:-127.0.0.1}"
PORT="${RUNOFF_OTEL_PORT:-4318}"
ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://${HOST}:${PORT}}"
MODE_FILE="${RUNOFF_HOME:-$HOME/.runoff}/otel-collector.mode"
PID_FILE="${RUNOFF_HOME:-$HOME/.runoff}/otel-collector.pid"
LOG_FILE="${RUNOFF_HOME:-$HOME/.runoff}/otel-collector.log"
BIN_DIR="${RUNOFF_HOME:-$HOME/.runoff}/bin"
REQUIRED="${RUNOFF_OTEL_COLLECTOR_REQUIRED:-0}"
START_MODE="${RUNOFF_OTEL_START_MODE:-auto}"

mkdir -p "$(dirname "$MODE_FILE")" "$BIN_DIR"

# Parse host/port from OTEL_EXPORTER_OTLP_ENDPOINT for probes (corporate collectors).
apply_endpoint_host_port() {
  local ep="${OTEL_EXPORTER_OTLP_ENDPOINT:-$ENDPOINT}"
  if [[ "$ep" =~ ^https?://([^:/]+)(:([0-9]+))? ]]; then
    HOST="${BASH_REMATCH[1]}"
    if [[ -n "${BASH_REMATCH[3]:-}" ]]; then
      PORT="${BASH_REMATCH[3]}"
    elif [[ "$ep" == https://* ]]; then
      PORT="443"
    fi
  fi
}

apply_endpoint_host_port

die() {
  echo "otel-collector: $*" >&2
  exit 1
}

fail_if_required() {
  if [[ "$REQUIRED" == "1" ]]; then
    die "$1"
  fi
  echo "otel-collector: SKIP — $1"
  exit 0
}

probe_port() {
  if command -v nc &>/dev/null; then
    nc -z "$HOST" "$PORT" 2>/dev/null
    return $?
  fi
  if command -v curl &>/dev/null; then
    curl -sf --max-time 2 "http://${HOST}:${PORT}/" -o /dev/null 2>/dev/null \
      || curl -sf --max-time 2 -X POST "http://${HOST}:${PORT}/v1/traces" \
        -H 'content-type: application/json' -d '{}' -o /dev/null 2>/dev/null
    return $?
  fi
  (echo >/dev/tcp/"$HOST"/"$PORT") 2>/dev/null
}

wait_for_ready() {
  local i
  for i in $(seq 1 40); do
    if probe_port; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

resolve_collector_bin() {
  local name
  if [[ -n "${RUNOFF_OTEL_BIN:-}" && -x "${RUNOFF_OTEL_BIN}" ]]; then
    echo "${RUNOFF_OTEL_BIN}"
    return 0
  fi
  for name in otelcol-contrib otelcol; do
    if command -v "$name" &>/dev/null; then
      command -v "$name"
      return 0
    fi
  done
  if [[ -x "$BIN_DIR/otelcol-contrib" ]]; then
    echo "$BIN_DIR/otelcol-contrib"
    return 0
  fi
  return 1
}

reclaim_port_if_needed() {
  [[ "${RUNOFF_OTEL_RECLAIM_PORT:-0}" == "1" ]] || return 0
  if ! probe_port; then
    return 0
  fi
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  echo "otel-collector: reclaiming port ${PORT} (stale listener)"
  if command -v lsof &>/dev/null; then
    lsof -ti :"${PORT}" 2>/dev/null | xargs kill -9 2>/dev/null || true
  elif command -v fuser &>/dev/null; then
    fuser -k "${PORT}/tcp" 2>/dev/null || true
  fi
  sleep 0.5
}

download_collector_bin() {
  local os arch asset url tmp bin
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) die "unsupported OS for auto-download: $(uname -s). Install otelcol-contrib via package manager or set OTEL_EXPORTER_OTLP_ENDPOINT to an existing collector." ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=amd64 ;;
    *) die "unsupported CPU arch for auto-download: $(uname -m)" ;;
  esac

  asset="otelcol-contrib_${COLLECTOR_VERSION}_${os}_${arch}"
  url="${RUNOFF_OTEL_DOWNLOAD_URL:-https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${COLLECTOR_VERSION}/${asset}.tar.gz}"

  if ! command -v curl &>/dev/null; then
    die "curl required to download collector (or install otelcol-contrib manually)"
  fi

  echo "otel-collector: downloading ${asset} …"
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL "$url" -o "$tmp/archive.tar.gz"
  tar -xzf "$tmp/archive.tar.gz" -C "$tmp"
  bin="$(find "$tmp" -name otelcol-contrib -type f | head -1)"
  if [[ -z "$bin" ]]; then
    rm -rf "$tmp"
    die "otelcol-contrib not found inside release archive"
  fi
  cp "$bin" "$BIN_DIR/otelcol-contrib"
  rm -rf "$tmp"
  chmod +x "$BIN_DIR/otelcol-contrib"
  echo "otel-collector: installed $BIN_DIR/otelcol-contrib"
}

start_native() {
  local bin
  if ! bin="$(resolve_collector_bin)"; then
    if [[ "${RUNOFF_OTEL_DOWNLOAD:-0}" == "1" ]]; then
      download_collector_bin
      bin="$(resolve_collector_bin)" || die "download succeeded but binary missing"
    else
      return 1
    fi
  fi
  if [[ ! -f "$CONFIG" ]]; then
    die "config not found: $CONFIG"
  fi

  echo "native" >"$MODE_FILE"
  nohup "$bin" --config="$CONFIG" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  echo "otel-collector: started native pid=$(cat "$PID_FILE") log=$LOG_FILE"

  if ! wait_for_ready; then
    die "collector did not become ready on ${HOST}:${PORT} (see $LOG_FILE)"
  fi
  echo "otel-collector: listening on http://${HOST}:${PORT} (OTLP/HTTP)"
}

start_docker() {
  if ! command -v docker &>/dev/null; then
    return 1
  fi
  if ! docker info &>/dev/null 2>&1; then
    return 1
  fi
  echo "docker" >"$MODE_FILE"
  docker compose -f "$ROOT/docker-compose.observability.yml" up -d --wait
  echo "otel-collector: started via docker compose"
  wait_for_ready || die "docker collector not ready on ${HOST}:${PORT}"
}

stop_native() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 0.5
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
}

stop_docker() {
  if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
    docker compose -f "$ROOT/docker-compose.observability.yml" down 2>/dev/null || true
  fi
}

cmd_start() {
  apply_endpoint_host_port

  if [[ "${RUNOFF_OTEL_SKIP_START:-0}" == "1" ]]; then
    echo "otel-collector: RUNOFF_OTEL_SKIP_START=1 — assuming external collector at $ENDPOINT"
    if probe_port; then
      echo "otel-collector: port ${PORT} reachable"
      return 0
    fi
    fail_if_required "external collector not reachable on ${HOST}:${PORT}"
    return 0
  fi

  if probe_port; then
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "otel-collector: already listening on ${HOST}:${PORT} (managed pid $(cat "$PID_FILE"))"
      return 0
    fi
    reclaim_port_if_needed
    if probe_port; then
      echo "otel-collector: already listening on ${HOST}:${PORT}"
      return 0
    fi
  fi

  case "$START_MODE" in
    native)
      start_native || fail_if_required "native start failed (install otelcol-contrib or set RUNOFF_OTEL_DOWNLOAD=1)"
      ;;
    docker)
      start_docker || fail_if_required "docker start failed"
      ;;
    auto)
      if start_native; then
        :
      elif start_docker; then
        :
      elif [[ "${RUNOFF_OTEL_DOWNLOAD:-0}" == "1" ]]; then
        start_native || fail_if_required "auto start failed after download"
      else
        fail_if_required "no collector on PATH and RUNOFF_OTEL_DOWNLOAD not set. Options: brew install opentelemetry-collector; RUNOFF_OTEL_DOWNLOAD=1 npm run otel-collector:start; docker compose -f docker-compose.observability.yml up -d; or point OTEL_EXPORTER_OTLP_ENDPOINT at an existing collector with RUNOFF_OTEL_SKIP_START=1"
      fi
      ;;
    *)
      die "unknown RUNOFF_OTEL_START_MODE=$START_MODE (use auto|native|docker)"
      ;;
  esac
}

cmd_stop() {
  local mode=""
  if [[ -f "$MODE_FILE" ]]; then
    mode="$(cat "$MODE_FILE")"
  fi
  if [[ "$mode" == "docker" ]]; then
    stop_docker
  else
    stop_native
  fi
  stop_docker
  rm -f "$MODE_FILE"
  echo "otel-collector: stopped"
}

cmd_status() {
  local mode="unknown"
  if [[ -f "$MODE_FILE" ]]; then
    mode="$(cat "$MODE_FILE")"
  fi
  echo "endpoint: $ENDPOINT"
  echo "config:   $CONFIG"
  echo "home:     ${RUNOFF_HOME:-$HOME/.runoff}"
  if probe_port; then
    echo "status:   listening on ${HOST}:${PORT}"
  else
    echo "status:   not listening on ${HOST}:${PORT}"
  fi
  if [[ -f "$PID_FILE" ]]; then
    echo "pid:      $(cat "$PID_FILE") (mode=$mode)"
  fi
  if [[ -f "$LOG_FILE" ]]; then
    echo "log:      $LOG_FILE"
  fi
  resolve_collector_bin && echo "binary:   $(resolve_collector_bin)" || echo "binary:   (not installed)"
}

cmd_ensure() {
  cmd_start
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    start) cmd_start ;;
    stop) cmd_stop ;;
    status) cmd_status ;;
    ensure|"") cmd_ensure ;;
    *)
      echo "Usage: $0 {start|stop|status|ensure}"
      exit 1
      ;;
  esac
}

main "$@"
