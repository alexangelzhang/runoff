#!/usr/bin/env bash
# Fail-fast prerequisite check for llm-pipeline (Node, Python, Git).
set -euo pipefail

fail=0

need_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "MISSING: $1 — $2"
    fail=1
  else
    echo "OK: $1 ($(${1} --version 2>/dev/null | head -1 || echo present))"
  fi
}

echo "=== llm-pipeline prerequisites ==="

need_cmd node "Install Node.js 20+ (https://nodejs.org/)"
need_cmd python3 "Install Python 3 (https://www.python.org/)"
need_cmd git "Install Git (https://git-scm.com/)"

if command -v node &>/dev/null; then
  major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
  if [ "${major}" -lt 20 ] 2>/dev/null; then
    echo "WARN: Node ${major}.x detected; Node 20+ recommended"
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Fix the items above, then: npm install && npm run demo"
  exit 1
fi

echo ""
echo "All prerequisites satisfied."
