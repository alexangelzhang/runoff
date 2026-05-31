#!/bin/bash
# Optional: register llm-pipeline MCP server in Claude Code CLI.
# Preferred quick start: npm install && npm run demo
# Docs: docs/coding-agent-backends.md, docs/differentiation.md

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== llm-pipeline setup ==="
echo ""
echo "Quick start (no API keys):"
echo "  cd $SCRIPT_DIR && npm install && npm run demo"
echo ""
echo "MCP server (stdio, uses tsx — no build required):"
echo "  npm run dev"
echo ""
echo "Run on your git repo without IDE:"
echo "  npm run pipeline:run -- --prompt '...' --work-dir /path/to/repo --config $SCRIPT_DIR/examples/cli.config.json"
echo ""

if ! command -v claude &>/dev/null; then
  echo "Claude Code CLI not found — skip 'claude mcp add'. Use README MCP JSON in Cursor / Claude Desktop instead."
  exit 0
fi

if [ ! -d "$SCRIPT_DIR/dist" ]; then
  echo "Building dist/ for claude mcp add (optional)..."
  (cd "$SCRIPT_DIR" && npm run build)
fi

ENV_ARGS=""
if [ -f "$SCRIPT_DIR/.env" ]; then
  # shellcheck disable=SC1090
  source "$SCRIPT_DIR/.env"
  [ -n "$OPENAI_API_KEY" ] && [ "$OPENAI_API_KEY" != "sk-xxx" ] && ENV_ARGS="$ENV_ARGS -e OPENAI_API_KEY=$OPENAI_API_KEY"
fi

echo "Registering MCP server in Claude Code..."
claude mcp add llm-pipeline $ENV_ARGS -- node "$SCRIPT_DIR/dist/index.js"

echo ""
echo "Done. Restart Claude Code if needed."
echo "Config template: examples/cli.config.json → copy to your target repo as pipeline.config.json"
