#!/usr/bin/env bash
# ============================================================
#  PayDeck - Service Status & Health Inspector
#  Dynamically inspects live state according to active config
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
BASE_URL="$CONFIG_BASE_URL"
PID_FILE="$CONFIG_PID_FILE"
LOG_FILE="$CONFIG_LOG_FILE"
DB_FILE="$CONFIG_DATABASE_PATH"

echo -e "\n${BLU}${BOLD}======================================================${RST}"
echo -e "${BLU}${BOLD}             PayDeck Service Status                   ${RST}"
echo -e "${BLU}${BOLD}======================================================${RST}\n"

IS_RUNNING=0
PID=""

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    IS_RUNNING=1
  fi
fi

if [[ $IS_RUNNING -eq 0 ]] && command -v lsof >/dev/null 2>&1; then
  PORT_PID="$(lsof -ti :"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
  if [[ -n "$PORT_PID" ]]; then
    IS_RUNNING=1
    PID="$PORT_PID"
  fi
fi

if [[ $IS_RUNNING -eq 1 ]]; then
  echo -e "  ${BOLD}Process Status:${RST}  ${GRN}● RUNNING${RST} (PID: ${PID})"
else
  echo -e "  ${BOLD}Process Status:${RST}  ${RED}○ STOPPED${RST}"
  echo -e "\n  ${CYN}To start PayDeck:${RST} ./scripts/start_all.sh\n"
  exit 1
fi

echo -e "  ${BOLD}Port:${RST}            ${PORT}"
echo -e "  ${BOLD}Base URL:${RST}        ${BASE_URL}"

# Query /health endpoint
HEALTH_RAW=$(curl -s -m 3 "${BASE_URL}/health" 2>/dev/null || echo "")

if [[ -n "$HEALTH_RAW" ]]; then
  echo -e "  ${BOLD}Health Check:${RST}    ${GRN}✓ 200 OK${RST}"
  echo -e "  ${BOLD}Health Data:${RST}     ${HEALTH_RAW}"
else
  echo -e "  ${BOLD}Health Check:${RST}    ${RED}✗ FAILED / NO RESPONSE${RST}"
fi

# Endpoint Probes
echo -e "\n${BOLD}Endpoint Probes:${RST}"

check_endpoint() {
  local label="$1"
  local url="$2"
  local expected="${3:-200}"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" -m 2 "$url" 2>/dev/null || echo "000")
  if [[ "$status" == "$expected" ]]; then
    echo -e "  ${GRN}✓${RST} ${label} (${url}) → ${GRN}HTTP ${status}${RST}"
  elif [[ "$status" == "000" ]]; then
    echo -e "  ${RED}✗${RST} ${label} (${url}) → ${RED}Connection Refused${RST}"
  else
    echo -e "  ${YLW}!${RST} ${label} (${url}) → ${YLW}HTTP ${status}${RST} (expected ${expected})"
  fi
}

check_endpoint "Landing Page    " "${BASE_URL}/" 200
check_endpoint "Admin Dashboard " "${BASE_URL}/admin" 200
check_endpoint "OpenAPI Schema  " "${BASE_URL}/v1/openapi.json" 200
check_endpoint "Cloud Me Route  " "${BASE_URL}/v1/cloud/me" 401

# Storage and Logs
echo -e "\n${BOLD}Storage & Logs:${RST}"
if [[ -f "$DB_FILE" ]]; then
  DB_SIZE=$(du -h "$DB_FILE" 2>/dev/null | cut -f1)
  echo -e "  ${BOLD}SQLite DB:${RST}       ${DB_FILE} (${DB_SIZE})"
else
  echo -e "  ${BOLD}SQLite DB:${RST}       ${DB_FILE} ${YLW}(file not created yet)${RST}"
fi

if [[ -f "$LOG_FILE" ]]; then
  LOG_SIZE=$(du -h "$LOG_FILE" 2>/dev/null | cut -f1)
  echo -e "  ${BOLD}Log File:${RST}        ${LOG_FILE} (${LOG_SIZE})"
  echo -e "\n${BOLD}Recent Logs (last 5 lines):${RST}"
  echo -e "${CYN}------------------------------------------------------${RST}"
  tail -n 5 "$LOG_FILE" 2>/dev/null || true
  echo -e "${CYN}------------------------------------------------------${RST}"
else
  echo -e "  ${BOLD}Log File:${RST}        ${LOG_FILE} (empty/not created)"
fi

echo -e "\n  ${CYN}Useful Commands:${RST}"
echo -e "    • ./scripts/stop_all.sh     Stop PayDeck"
echo -e "    • ./scripts/restart_all.sh  Restart PayDeck"
echo -e "    • ./scripts/logs.sh         Tail live logs"
echo -e "    • ./scripts/smoke-test.sh   Run 58 full E2E curl tests\n"
