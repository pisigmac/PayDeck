#!/usr/bin/env bash
# ============================================================
#  PayDeck - Start All Services
#  Loads all server/database settings dynamically from config
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

PID_FILE="$CONFIG_PID_FILE"
LOG_FILE="$CONFIG_LOG_FILE"

mkdir -p "$ROOT_DIR/data" "$CONFIG_LOG_DIR"

echo -e "\n${BLU}${BOLD}======================================================${RST}"
echo -e "${BLU}${BOLD}             Starting PayDeck Services               ${RST}"
echo -e "${BLU}${BOLD}======================================================${RST}\n"

# Check if already running via PID file
if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo -e "${YLW}⚠️  PayDeck is already running with PID ${OLD_PID}.${RST}"
    if curl -sf "${CONFIG_BASE_URL}/health" >/dev/null 2>&1; then
      echo -e "${GRN}✓ Health check passed at ${CONFIG_BASE_URL}/health${RST}"
    else
      echo -e "${YLW}! Process exists but health check not responding on port ${CONFIG_PORT}.${RST}"
    fi
    exit 0
  else
    rm -f "$PID_FILE"
  fi
fi

# Check if port is already occupied
if command -v lsof >/dev/null 2>&1; then
  PORT_PID="$(lsof -ti :"$CONFIG_PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
  if [[ -n "$PORT_PID" ]]; then
    echo -e "${RED}❌ Port ${CONFIG_PORT} is already in use by process PID ${PORT_PID}.${RST}"
    echo -e "   Please run ${CYN}./scripts/stop_all.sh${RST} or terminate process ${PORT_PID} first."
    exit 1
  fi
fi

echo -e "${CYN}➜ Starting PayDeck server on ${CONFIG_HOST}:${CONFIG_PORT}...${RST}"

# Export environment from active config
export PORT="$CONFIG_PORT"
export HOST="$CONFIG_HOST"
export BILLING_ADMIN_TOKEN="$CONFIG_ADMIN_TOKEN"
export ALLOW_DEV_CHARGE="$CONFIG_ALLOW_DEV_CHARGE"
export DATABASE_PATH="$CONFIG_DATABASE_PATH"

# Launch process in background detached from shell session
if command -v setsid >/dev/null 2>&1; then
  setsid npx tsx src/entrypoints/node.ts </dev/null >> "$LOG_FILE" 2>&1 &
  SERVER_PID=$!
else
  nohup npx tsx src/entrypoints/node.ts </dev/null >> "$LOG_FILE" 2>&1 &
  SERVER_PID=$!
  disown "$SERVER_PID" 2>/dev/null || true
fi
echo "$SERVER_PID" > "$PID_FILE"

echo -e "${CYN}➜ PayDeck server process spawned (PID: ${SERVER_PID})${RST}"
echo -e "${CYN}➜ Awaiting service readiness on ${CONFIG_BASE_URL}/health...${RST}"

# Wait for server readiness
ATTEMPTS=0
MAX_ATTEMPTS=20
READY=0

while [[ $ATTEMPTS -lt $MAX_ATTEMPTS ]]; do
  if curl -sf "${CONFIG_BASE_URL}/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  # If process died unexpectedly, abort early
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    break
  fi
  sleep 0.5
  ATTEMPTS=$((ATTEMPTS + 1))
done

if [[ $READY -eq 1 ]]; then
  if command -v lsof >/dev/null 2>&1; then
    LISTEN_PID="$(lsof -ti :"$CONFIG_PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
    if [[ -n "$LISTEN_PID" ]]; then
      echo "$LISTEN_PID" > "$PID_FILE"
      SERVER_PID="$LISTEN_PID"
    fi
  fi
  echo -e "\n${GRN}${BOLD}✓ PayDeck services started successfully!${RST}\n"
  echo -e "  ${BOLD}PID:${RST}             ${SERVER_PID}"
  echo -e "  ${BOLD}API Server:${RST}      ${CONFIG_BASE_URL}"
  echo -e "  ${BOLD}Health Check:${RST}    ${CONFIG_BASE_URL}/health"
  echo -e "  ${BOLD}Landing Page:${RST}    ${CONFIG_BASE_URL}/"
  echo -e "  ${BOLD}Admin Dashboard:${RST} ${CONFIG_BASE_URL}/admin"
  echo -e "  ${BOLD}OpenAPI Spec:${RST}    ${CONFIG_BASE_URL}/v1/openapi.json"
  echo -e "  ${BOLD}Log File:${RST}        ${LOG_FILE}"
  echo -e "  ${BOLD}Database:${RST}        ${CONFIG_DATABASE_PATH}"
  echo ""
  echo -e "  ${CYN}To check status:${RST} ./scripts/status.sh"
  echo -e "  ${CYN}To view logs:${RST}    ./scripts/logs.sh"
  echo -e "  ${CYN}To stop:${RST}         ./scripts/stop_all.sh\n"
  exit 0
else
  echo -e "\n${RED}${BOLD}❌ Failed to start PayDeck server.${RST}"
  echo -e "   Check log output below or at ${LOG_FILE}:\n"
  tail -n 20 "$LOG_FILE" 2>/dev/null || true
  rm -f "$PID_FILE"
  exit 1
fi
