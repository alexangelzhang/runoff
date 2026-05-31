#!/usr/bin/env bash
# Remove ephemeral trace dirs created by unit tests (gitignored).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
count=0
while IFS= read -r -d '' dir; do
  rm -rf "$dir"
  count=$((count + 1))
done < <(find "$ROOT/tests" -maxdepth 1 -type d -name '.tmp-traces-*' -print0 2>/dev/null)
echo "Removed ${count} tests/.tmp-traces-* director(ies)."
