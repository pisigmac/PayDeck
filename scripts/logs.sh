#!/usr/bin/env bash
# ============================================================
#  PayDeck - Tail Application Logs
#  Usage: ./scripts/logs.sh [-f] [-n 50]
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="$ROOT_DIR/logs/paydeck.log"

if [[ ! -f "$LOG_FILE" ]]; then
  echo "Log file does not exist yet at: $LOG_FILE"
  echo "Start PayDeck first using ./scripts/start_all.sh"
  exit 1
fi

if [[ $# -eq 0 ]]; then
  echo "Tailing $LOG_FILE (Press Ctrl+C to exit)..."
  tail -f -n 50 "$LOG_FILE"
else
  tail "$@" "$LOG_FILE"
fi
