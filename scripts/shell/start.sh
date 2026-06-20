#!/bin/bash
# Launch runoff with Ghostty split panes
# Usage: ./start.sh
#
# This script prints instructions for Ghostty native splits.
# Open 3 panes in Ghostty and run the commands shown.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
WATCHER="$SCRIPT_DIR/watcher.sh"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

echo -e "${CYAN}╔══════════════════════════════════════════════════╗${RESET}"
echo -e "${CYAN}║       LLM Pipeline - Ghostty Split Setup        ║${RESET}"
echo -e "${CYAN}╚══════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "${BOLD}Step 1:${RESET} In Ghostty, create 2 splits (3 panes total):"
echo -e "  ${DIM}Cmd+D       → split right (Codex pane)${RESET}"
echo -e "  ${DIM}Cmd+Shift+D → split down  (Gemini pane)${RESET}"
echo ""
echo -e "${BOLD}Step 2:${RESET} Run these commands in each pane:"
echo ""
echo -e "  ${GREEN}Pane 1 (Claude):${RESET}  ${DIM}claude  # your normal Claude Code session${RESET}"
echo -e "  ${GREEN}Pane 2 (Codex):${RESET}   ${YELLOW}$WATCHER codex${RESET}"
echo -e "  ${GREEN}Pane 3 (Gemini):${RESET}  ${YELLOW}$WATCHER gemini${RESET}"
echo ""
echo -e "${BOLD}Step 3:${RESET} In Claude Code, use ${CYAN}/dev-pipeline${RESET} or call ${CYAN}runoff_run_step${RESET}"
echo -e "  Tasks will flow visually between the panes!"
echo ""
echo -e "${DIM}Config: $PROJECT_DIR/pipeline.config.json${RESET}"
echo -e "${DIM}Tasks dir: ~/.runoff/tasks/${RESET}"
echo ""

# Quick launch option: start watchers in current terminal
if [ "${1:-}" = "--codex" ]; then
  exec "$WATCHER" codex
elif [ "${1:-}" = "--gemini" ]; then
  exec "$WATCHER" gemini
fi
