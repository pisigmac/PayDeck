#!/usr/bin/env bash
# ============================================================
#  PayDeck - Dynamic Config Loader
#  Sources configuration from paydeck.yaml / config.yaml / .env
# ============================================================

set -euo pipefail

SCRIPT_LOADER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_DIR="$(cd "$SCRIPT_LOADER_DIR/.." && pwd)"

# Load .env files if present
if [[ -f "$REPO_ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT_DIR/.env"
  set +a
fi
if [[ -f "$REPO_ROOT_DIR/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT_DIR/.env.local"
  set +a
fi

# Find active YAML config file
YAML_CONFIG_FILE=""
if [[ -f "$REPO_ROOT_DIR/paydeck.yaml" ]]; then
  YAML_CONFIG_FILE="$REPO_ROOT_DIR/paydeck.yaml"
elif [[ -f "$REPO_ROOT_DIR/config.yaml" ]]; then
  YAML_CONFIG_FILE="$REPO_ROOT_DIR/config.yaml"
elif [[ -f "$REPO_ROOT_DIR/paydeck.example.yaml" ]]; then
  YAML_CONFIG_FILE="$REPO_ROOT_DIR/paydeck.example.yaml"
fi

# Helper to read simple YAML keys without external dependencies
read_yaml_val() {
  local key="$1"
  local file="$2"
  if [[ -f "$file" ]]; then
    grep -E "^\s*${key}:" "$file" 2>/dev/null | head -n 1 | sed -E "s/^\s*${key}:\s*[\"']?([^\"'#]*)[\"']?.*$/\1/" | tr -d ' \r\t' || echo ""
  fi
}

# Extract values from YAML if available
YAML_PORT="$(read_yaml_val "port" "$YAML_CONFIG_FILE")"
YAML_HOST="$(read_yaml_val "host" "$YAML_CONFIG_FILE")"
YAML_ADMIN_TOKEN="$(read_yaml_val "token" "$YAML_CONFIG_FILE")"
YAML_ALLOW_DEV="$(read_yaml_val "allow_dev_charge" "$YAML_CONFIG_FILE")"
YAML_DB_PATH="$(read_yaml_val "path" "$YAML_CONFIG_FILE")"

# Priority: Environment Variables -> YAML Config -> sensible dynamic fallbacks
export CONFIG_PORT="${PORT:-${YAML_PORT:-8787}}"
export CONFIG_HOST="${HOST:-${YAML_HOST:-0.0.0.0}}"
export CONFIG_ADMIN_TOKEN="${BILLING_ADMIN_TOKEN:-${YAML_ADMIN_TOKEN:-change-me-admin-token}}"

# Resolve dev charge boolean
if [[ -n "${ALLOW_DEV_CHARGE:-}" ]]; then
  export CONFIG_ALLOW_DEV_CHARGE="$ALLOW_DEV_CHARGE"
elif [[ "$YAML_ALLOW_DEV" == "true" || "$YAML_ALLOW_DEV" == "1" ]]; then
  export CONFIG_ALLOW_DEV_CHARGE="1"
else
  export CONFIG_ALLOW_DEV_CHARGE="0"
fi

# Resolve DB path relative to root
if [[ -n "${DATABASE_PATH:-}" ]]; then
  export CONFIG_DATABASE_PATH="$DATABASE_PATH"
elif [[ -n "$YAML_DB_PATH" ]]; then
  if [[ "$YAML_DB_PATH" = /* ]]; then
    export CONFIG_DATABASE_PATH="$YAML_DB_PATH"
  else
    export CONFIG_DATABASE_PATH="$REPO_ROOT_DIR/${YAML_DB_PATH#./}"
  fi
else
  export CONFIG_DATABASE_PATH="$REPO_ROOT_DIR/data/paydeck.db"
fi

# Target host resolution for client HTTP probes
if [[ "$CONFIG_HOST" == "0.0.0.0" || "$CONFIG_HOST" == "::" || -z "$CONFIG_HOST" ]]; then
  export CONFIG_PROBE_HOST="127.0.0.1"
else
  export CONFIG_PROBE_HOST="$CONFIG_HOST"
fi

export CONFIG_BASE_URL="http://${CONFIG_PROBE_HOST}:${CONFIG_PORT}"
export CONFIG_PID_FILE="$REPO_ROOT_DIR/data/paydeck.pid"
export CONFIG_LOG_DIR="$REPO_ROOT_DIR/logs"
export CONFIG_LOG_FILE="$CONFIG_LOG_DIR/paydeck.log"
