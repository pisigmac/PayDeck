#!/usr/bin/env bash
# ============================================================
#  PayDeck - Restart All Services
#  Usage: ./scripts/restart_all.sh or ./restart_all.sh
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

echo "Restarting PayDeck..."
"$SCRIPT_DIR/stop_all.sh"
sleep 1
"$SCRIPT_DIR/start_all.sh"
