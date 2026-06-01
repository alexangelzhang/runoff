#!/bin/zsh
# Usage: ./watcher.sh <provider-name>
# Example: ./watcher.sh codex
#          ./watcher.sh gemini
#
# Task files are created by the TS CLIProvider (atomic tmp+rename). Results are written by
# task_runner.py via atomic JSON write. This script only claims tasks and spawns the runner.

set -uo pipefail

PROVIDER="${1:?Usage: $0 <provider-name>}"
export RUNOFF_HOME="${RUNOFF_HOME:-$HOME/.runoff}"
TASKS_DIR="$RUNOFF_HOME/tasks"
MAX_CONCURRENT="${RUNOFF_MAX_CONCURRENT:-2}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TASK_RUNNER="$SCRIPT_DIR/../python/task_runner.py"

mkdir -p "$TASKS_DIR"

PROVIDER_UPPER=$(echo "$PROVIDER" | tr '[:lower:]' '[:upper:]')

echo "\033[0;36m╔══════════════════════════════════════╗\033[0m"
echo "\033[0;36m║  ${PROVIDER_UPPER} WATCHER\033[0m"
echo "\033[0;36m╚══════════════════════════════════════╝\033[0m"
echo "\033[2mWatching: $TASKS_DIR/${PROVIDER}.*.task.json\033[0m"
echo ""

setopt NULL_GLOB 2>/dev/null  # zsh: don't error on no-match globs
unsetopt BG_NICE 2>/dev/null || true

while true; do
  for TASK_FILE in "$TASKS_DIR"/${PROVIDER}.*.task.json; do
    [ -f "$TASK_FILE" ] || continue

    ACTIVE_JOBS="$(jobs -pr | wc -l | tr -d " ")"
    if [ "${ACTIVE_JOBS:-0}" -ge "$MAX_CONCURRENT" ]; then
      break
    fi

    RESULT_FILE="${TASK_FILE%.task.json}.result.json"
    if [ -f "$RESULT_FILE" ]; then
      continue
    fi

    CLAIM_FILE="${TASK_FILE}.claimed"
    if ! ( set -o noclobber; : > "$CLAIM_FILE" ) 2>/dev/null; then
      continue
    fi

    LOG_FILE="${TASK_FILE%.task.json}.run.log"
    (
      python3 "$TASK_RUNNER" "$TASK_FILE" "$RESULT_FILE" > "$LOG_FILE" 2>&1
      rm -f "$CLAIM_FILE"
    ) &

    echo "\033[2mStarted task $TASK_FILE in background (log: $LOG_FILE)\033[0m"
    echo ""
  done

  jobs >/dev/null 2>&1

  sleep 0.1
done
