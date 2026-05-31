#!/usr/bin/env bash
# Refresh docs/benchmark-pins.json with latest GitHub main SHAs.
# Usage: ./scripts/refresh-benchmark-pins.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/docs/benchmark-pins.json"
TODAY="$(date -u +%Y-%m-%d)"

fetch_sha() {
  local repo="$1"
  curl -fsSL "https://api.github.com/repos/${repo}/commits/main" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['sha'])"
}

fetch_date() {
  local repo="$1"
  curl -fsSL "https://api.github.com/repos/${repo}/commits/main" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['commit']['author']['date'])"
}

LP_REF="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo "unknown")"

OPENAI_SHA="$(fetch_sha openai/openai-agents-python)"
LANGGRAPH_SHA="$(fetch_sha langchain-ai/langgraph)"
ADK_SHA="$(fetch_sha google/adk-python)"
CREW_SHA="$(fetch_sha crewAIInc/crewAI)"
DEER_SHA="$(fetch_sha bytedance/deer-flow)"

cat > "$OUT" <<EOF
{
  "auditedAt": "${TODAY}",
  "auditor": "scripts/refresh-benchmark-pins.sh",
  "llmPipeline": {
    "repo": "local",
    "ref": "${LP_REF}",
    "note": "Workspace HEAD at refresh time"
  },
  "frameworks": [
    {
      "id": "openai-agents-sdk",
      "repo": "openai/openai-agents-python",
      "ref": "${OPENAI_SHA}",
      "refDate": "$(fetch_date openai/openai-agents-python)"
    },
    {
      "id": "langgraph",
      "repo": "langchain-ai/langgraph",
      "ref": "${LANGGRAPH_SHA}",
      "refDate": "$(fetch_date langchain-ai/langgraph)"
    },
    {
      "id": "google-adk",
      "repo": "google/adk-python",
      "ref": "${ADK_SHA}",
      "refDate": "$(fetch_date google/adk-python)"
    },
    {
      "id": "crewai",
      "repo": "crewAIInc/crewAI",
      "ref": "${CREW_SHA}",
      "refDate": "$(fetch_date crewAIInc/crewAI)"
    },
    {
      "id": "deer-flow",
      "repo": "bytedance/deer-flow",
      "ref": "${DEER_SHA}",
      "refDate": "$(fetch_date bytedance/deer-flow)"
    }
  ]
}
EOF

echo "Wrote $OUT"
