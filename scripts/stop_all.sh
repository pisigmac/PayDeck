#!/usr/bin/env bash
# ============================================================
#  PayDeck - Stop All Services
#  Dynamically determines port and PID file from active config
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/load-config.sh"

# Colors
RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[1;33m'
BLU='\033[0;34m'
CYN='\033[0;36m'
BOLD='\033[1m'
RST='\033[0m'

PORT="$CONFIG_PORT"
PID_FILE="$CONFIG_PID_FILE"

echo -e "\n${BLU}${BOLD}======================================================${RST}"
echo -e "${BLU}${BOLD}             Stopping PayDeck Services               ${RST}"
echo -e "${BLU}${BOLD}======================================================${RST}\n"

STOPPED=0

# Check PID file
if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    echo -e "${CYN}➜ Sending SIGTERM to PayDeck process (PID: ${PID})...${RST}"
    kill "$PID" 2>/dev/null || true
    
    # Wait for graceful shutdown
    WAIT_SEC=0
    while kill -0 "$PID" 2>/dev/null && [[ $WAIT_SEC -lt 8 ]]; do
      sleep 0.5
      WAIT_SEC=$((WAIT_SEC + 1))
    done

    # Force kill if still running
    if kill -0 "$PID" 2>/dev/null; then
      echo -e "${YLW}➜ Process did not exit gracefully, sending SIGKILL...${RST}"
      kill -9 "$PID" 2>/dev/null || true
      sleep 0.5
    fi

    echo -e "${GRN}✓ Process ${PID} terminated.${RST}"
    STOPPED=1
  fi
  rm -f "$PID_FILE"
fi

# Also check if any remaining process is listening on the configured port
if command -v lsof >/dev/null 2>&1; then
  REMAINING_PID="$(lsof -ti :"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
  if [[ -n "$REMAINING_PID" ]]; then
    echo -e "${YLW}➜ Found remaining process on port ${PORT} (PID: ${REMAINING_PID}), stopping...${RST}"
    kill "$REMAINING_PID" 2>/dev/null || true
    sleep 1
    if kill -0 "$REMAINING_PID" 2>/dev/null; then
      kill -9 "$REMAINING_PID" 2>/dev/null || true
    fi
    STOPPED=1
  fi
fi

if [[ $STOPPED -eq 1 ]]; then
  echo -e "\n${GRN}${BOLD}✓ All PayDeck services have been stopped successfully.${RST}\n"
else
  echo -e "${YLW}ℹ️  No active PayDeck services found running on port ${PORT}.${RST}\n"
fi
