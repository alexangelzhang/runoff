#!/bin/bash
# Setup script for llm-pipeline MCP server in Claude Code
# Usage: bash setup.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== llm-pipeline MCP Server Setup ==="
echo ""

# Build if needed
if [ ! -d "$SCRIPT_DIR/dist" ]; then
  echo "Building project..."
  cd "$SCRIPT_DIR" && npm run build
fi

# Optional: source .env if exists (for API-based providers)
ENV_ARGS=""
if [ -f "$SCRIPT_DIR/.env" ]; then
  source "$SCRIPT_DIR/.env"
  [ -n "$OPENAI_API_KEY" ] && [ "$OPENAI_API_KEY" != "sk-xxx" ] && ENV_ARGS="$ENV_ARGS -e OPENAI_API_KEY=$OPENAI_API_KEY"
  [ -n "$OPENAI_MODEL" ] && ENV_ARGS="$ENV_ARGS -e OPENAI_MODEL=$OPENAI_MODEL"
fi

# Register MCP server in Claude Code
echo "Registering MCP server in Claude Code..."
claude mcp add llm-pipeline $ENV_ARGS -- node "$SCRIPT_DIR/dist/index.js"

echo ""
echo "Done! MCP server 'llm-pipeline' registered."
echo ""
echo "Tools:"
echo "  - llm_run_step    : Execute a pipeline step (generate/review)"
echo "  - llm_show_config : Show current pipeline configuration"
echo ""
echo "Config: $SCRIPT_DIR/pipeline.config.json"
echo "  Default: Codex CLI generates code, Claude reviews."
echo "  Edit to switch providers (gemini, openai, etc.)"
echo ""
echo "Restart Claude Code to activate."
