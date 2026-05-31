#!/bin/bash
# llm-pipeline Watcher Health Probe (Wave 3)

TASKS_DIR="$(cd "$(dirname "$0")/../tasks" && pwd)"
HEARTBEAT_FILE="$TASKS_DIR/heartbeat.txt"

echo "Checking llm-pipeline watcher health..."

# 1. Check if process is running
PID=$(pgrep -f "python3.*task_runner.py")
if [ -z "$PID" ]; then
  echo "ERROR: task_runner.py process not found!"
  exit 1
fi
echo "✓ task_runner.py is running (PID: $PID)"

# 2. Check heartbeat freshness
if [ ! -f "$HEARTBEAT_FILE" ]; then
  echo "ERROR: Heartbeat file not found at $HEARTBEAT_FILE"
  exit 1
fi

LAST_HEARTBEAT=$(cat "$HEARTBEAT_FILE")
CURRENT_TIME=$(python3 -c "import time; print(time.time())")
DIFF=$(python3 -c "print($CURRENT_TIME - $LAST_HEARTBEAT)")

# Threshold: 60 seconds
if (( $(echo "$DIFF > 60" | bc -l) )); then
  echo "ERROR: Watcher is STALE. Last heartbeat was $DIFF seconds ago."
  exit 1
fi

echo "✓ Heartbeat is fresh (Last update: ${DIFF}s ago)"
echo "HEALTH STATUS: OK"
exit 0
