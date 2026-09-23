#!/usr/bin/env bash
# ============================================================
#  PayDeck E2E Smoke Test Runner
#  Usage: bash scripts/smoke-test.sh
#  Brings up the server, runs rigorous curl tests, tears down,
#  and prints a full PASS/FAIL summary report.
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/load-config.sh"

# ─── Config ──────────────────────────────────────────────────
PORT="${PORT:-$CONFIG_PORT}"
HOST="${CONFIG_BASE_URL}"
ADMIN_TOKEN="${BILLING_ADMIN_TOKEN:-$CONFIG_ADMIN_TOKEN}"
SERVER_PID=""
PASS=0
FAIL=0
TOTAL=0
RESULTS=()

# Unique run ID so repeated runs don't collide on slug UNIQUE constraints
RUN_ID="$(date +%s | tail -c 6)"
PROD_SLUG="smoke-prod-${RUN_ID}"

# Colors
RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[1;33m'
BLU='\033[0;34m'
CYN='\033[0;36m'
BOLD='\033[1m'
RST='\033[0m'

# ─── Helpers ─────────────────────────────────────────────────

log_header() { echo -e "\n${BLU}${BOLD}═══ $1 ═══${RST}"; }
log_info()   { echo -e "${CYN}  ➜  $1${RST}"; }

assert() {
  local name="$1"
  local actual="$2"
  local expected="$3"
  TOTAL=$((TOTAL + 1))
  if [[ "$actual" == "$expected" ]]; then
    PASS=$((PASS + 1))
    RESULTS+=("${GRN}  ✓ PASS${RST}  $name")
    echo -e "${GRN}  ✓ PASS${RST}  $name  (HTTP ${actual})"
  else
    FAIL=$((FAIL + 1))
    RESULTS+=("${RED}  ✗ FAIL${RST}  $name  [expected ${expected}, got ${actual}]")
    echo -e "${RED}  ✗ FAIL${RST}  $name  [expected HTTP ${expected}, got HTTP ${actual}]"
  fi
}

assert_contains() {
  local name="$1"
  local body="$2"
  local needle="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$body" | grep -q "$needle" 2>/dev/null; then
    PASS=$((PASS + 1))
    RESULTS+=("${GRN}  ✓ PASS${RST}  $name")
    echo -e "${GRN}  ✓ PASS${RST}  $name  (contains: '${needle}')"
  else
    FAIL=$((FAIL + 1))
    RESULTS+=("${RED}  ✗ FAIL${RST}  $name  [body missing '${needle}']")
    echo -e "${RED}  ✗ FAIL${RST}  $name  [body missing '${needle}']"
    echo -e "          Body: ${body:0:200}"
  fi
}

# Make a curl call, output "STATUS_CODE\tBODY"
call() {
  local method="${1:-GET}"
  local path="$2"
  local data="${3:-}"
  local extra_headers="${4:-}"
  local url="${HOST}${path}"

  local args=(-s -w "\n__STATUS__%{http_code}" -X "$method" -H "Content-Type: application/json")
  [[ -n "$extra_headers" ]] && args+=(-H "$extra_headers")
  [[ -n "$data" ]] && args+=(-d "$data")

  local raw
  raw=$(curl "${args[@]}" "$url" 2>/dev/null)
  local body status
  body=$(echo "$raw" | sed '$d')
  status=$(echo "$raw" | tail -1 | sed 's/__STATUS__//')
  echo "${status}|${body}"
}

call_admin() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  call "$method" "$path" "$data" "X-Admin-Token: ${ADMIN_TOKEN}"
}

# Extract field from JSON (very light, works without jq)
json_get() {
  echo "$1" | grep -o "\"${2}\":\"[^\"]*\"" | head -1 | sed "s/\"${2}\":\"//;s/\"//"
}
json_get_num() {
  echo "$1" | grep -o "\"${2}\":[0-9]*" | head -1 | sed "s/\"${2}\"://"
}

# ─── Server Lifecycle ────────────────────────────────────────

start_server() {
  log_header "Starting PayDeck Server"
  ALLOW_DEV_CHARGE=1 \
  PORT=$PORT \
  BILLING_ADMIN_TOKEN=$ADMIN_TOKEN \
  npx tsx src/entrypoints/node.ts &>/tmp/paydeck-server.log &
  SERVER_PID=$!
  log_info "Server PID: $SERVER_PID"

  # Wait up to 8s for server to be ready
  local attempts=0
  until curl -sf "${HOST}/health" > /dev/null 2>&1; do
    sleep 0.5
    attempts=$((attempts + 1))
    if [[ $attempts -ge 16 ]]; then
      echo -e "${RED}Server failed to start. Log:${RST}"
      cat /tmp/paydeck-server.log
      exit 1
    fi
  done
  echo -e "${GRN}  ✓ Server ready at ${HOST}${RST}"
}

stop_server() {
  log_header "Stopping PayDeck Server"
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    echo -e "${GRN}  ✓ Server stopped (PID $SERVER_PID)${RST}"
  fi
}

# ─── Test Suites ─────────────────────────────────────────────

test_health_and_static() {
  log_header "1 · Health & Static Routes"

  local r; r=$(call GET /health)
  local status="${r%%|*}"; local body="${r#*|}"
  assert "GET /health returns 200" "$status" "200"
  assert_contains "Health body has ok:true" "$body" '"ok"'
  assert_contains "Health body has paydeck service" "$body" "paydeck"

  r=$(call GET /robots.txt); status="${r%%|*}"
  assert "GET /robots.txt returns 200" "$status" "200"

  r=$(call GET /sitemap.xml); status="${r%%|*}"
  assert "GET /sitemap.xml returns 200" "$status" "200"

  r=$(call GET /); status="${r%%|*}"
  assert "GET / (landing page) returns 200" "$status" "200"

  r=$(call GET /admin); status="${r%%|*}"
  assert "GET /admin returns 200" "$status" "200"
}

test_admin_products() {
  log_header "2 · Admin: Products, Plans & API Keys"

  # Create product
  local r; r=$(call_admin POST /v1/admin/products "{\"name\":\"SmokeTest Product\",\"slug\":\"${PROD_SLUG}\",\"rate_limit_per_hour\":500}")
  local status="${r%%|*}"; local body="${r#*|}"
  assert "POST /v1/admin/products → 201" "$status" "201"
  assert_contains "Product created with id" "$body" '"id"'

  # List products
  r=$(call_admin GET /v1/admin/products); status="${r%%|*}"; body="${r#*|}"
  assert "GET /v1/admin/products → 200" "$status" "200"
  assert_contains "Products list has results" "$body" '"products"'

  # Create plan on product
  r=$(call_admin POST "/v1/admin/products/${PROD_SLUG}/plans" \
    '{"name":"Monthly Plan","slug":"monthly","amount_paise":1999,"currency":"INR","interval":"month"}')
  status="${r%%|*}"; body="${r#*|}"
  assert "POST /v1/admin/products/:slug/plans → 201" "$status" "201"
  assert_contains "Plan created" "$body" '"slug"'

  # Mint API key
  r=$(call_admin POST "/v1/admin/products/${PROD_SLUG}/keys" '{"name":"Smoke Key"}')
  status="${r%%|*}"; body="${r#*|}"
  assert "POST /v1/admin/products/:slug/keys → 201" "$status" "201"
  assert_contains "API key minted" "$body" '"key"'

  # Extract the live API key for billing tests
  SMOKE_API_KEY=$(json_get "$body" "key")
  log_info "Live API key: ${SMOKE_API_KEY:0:20}..."
}

test_validation_errors() {
  log_header "3 · Validation & Error Envelope"

  # Missing auth
  local r; r=$(call POST /v1/orders '{"amount_paise":100}')
  local status="${r%%|*}"
  assert "POST /v1/orders without auth → 401" "$status" "401"

  # Invalid body
  r=$(call POST /v1/orders '{}' "Authorization: Bearer bad-key")
  status="${r%%|*}"
  assert "POST /v1/orders with bad key → 401" "$status" "401"

  # Admin routes without token
  r=$(call GET /v1/admin/products); status="${r%%|*}"
  assert "GET /v1/admin/products without token → 401" "$status" "401"
}

test_billing_orders() {
  log_header "4 · Billing: Order Creation & Payment Verification"

  if [[ -z "${SMOKE_API_KEY:-}" ]]; then
    log_info "Skipping billing tests – no API key minted"
    return
  fi

  # Create order
  local r; r=$(call POST /v1/orders \
    '{"amount_paise":500,"currency":"INR","receipt":"smoke-001"}' \
    "Authorization: Bearer ${SMOKE_API_KEY}")
  local status="${r%%|*}"; local body="${r#*|}"
  assert "POST /v1/orders → 201" "$status" "201"
  assert_contains "Order has id" "$body" '"id"'
  assert_contains "Order has status" "$body" '"status"'

  SMOKE_ORDER_ID=$(json_get "$body" "id")

  # Get payment by id
  if [[ -n "${SMOKE_ORDER_ID:-}" ]]; then
    r=$(call GET "/v1/payments/${SMOKE_ORDER_ID}" "" "Authorization: Bearer ${SMOKE_API_KEY}")
    status="${r%%|*}"
    assert "GET /v1/payments/:id → 200" "$status" "200"
  fi

  # List payments
  r=$(call GET /v1/payments "" "Authorization: Bearer ${SMOKE_API_KEY}")
  status="${r%%|*}"; body="${r#*|}"
  assert "GET /v1/payments → 200" "$status" "200"
  assert_contains "Payments list has payments array" "$body" '"payments"'

  # Verify with wrong sig using a valid API key → 400 (or 404 if no gateway configured in dev mode)
  r=$(call POST /v1/verify \
    '{"razorpay_order_id":"ord_bad","razorpay_payment_id":"pay_bad","razorpay_signature":"badsig"}' \
    "Authorization: Bearer ${SMOKE_API_KEY}")
  status="${r%%|*}"
  if [[ "$status" == "400" || "$status" == "404" || "$status" == "422" ]]; then
    PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1))
    RESULTS+=("${GRN}  ✓ PASS${RST}  POST /v1/verify with bad sig → error (${status})")
    echo -e "${GRN}  ✓ PASS${RST}  POST /v1/verify with bad sig → error (HTTP ${status})"
  else
    PASS=$((PASS + 0)); FAIL=$((FAIL + 1)); TOTAL=$((TOTAL + 1))
    RESULTS+=("${RED}  ✗ FAIL${RST}  POST /v1/verify with bad sig [expected 4xx, got ${status}]")
    echo -e "${RED}  ✗ FAIL${RST}  POST /v1/verify with bad sig [expected 4xx error, got ${status}]"
  fi
}

test_customers() {
  log_header "5 · Customers"

  if [[ -z "${SMOKE_API_KEY:-}" ]]; then
    log_info "Skipping customer tests – no API key minted"
    return
  fi

  local r; r=$(call POST /v1/customers \
    '{"email":"smoke@test.com","name":"Smoke User","external_user_id":"ext-001"}' \
    "Authorization: Bearer ${SMOKE_API_KEY}")
  local status="${r%%|*}"; local body="${r#*|}"
  # 201 on creation, 200 on idempotent find (same email already exists)
  if [[ "$status" == "200" || "$status" == "201" ]]; then
    PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1))
    RESULTS+=("${GRN}  ✓ PASS${RST}  POST /v1/customers → ${status} (created or found)")
    echo -e "${GRN}  ✓ PASS${RST}  POST /v1/customers → ${status} (created or found)"
  else
    FAIL=$((FAIL + 1)); TOTAL=$((TOTAL + 1))
    RESULTS+=("${RED}  ✗ FAIL${RST}  POST /v1/customers [expected 200/201, got ${status}]")
    echo -e "${RED}  ✗ FAIL${RST}  POST /v1/customers [expected 200/201, got ${status}]"
  fi
  assert_contains "Customer has id" "$body" '"id"'

  r=$(call GET /v1/customers "" "Authorization: Bearer ${SMOKE_API_KEY}")
  status="${r%%|*}"
  assert "GET /v1/customers → 200" "$status" "200"
}

test_cloud_saas() {
  log_header "6 · PayDeck Cloud SaaS (Signup, Login, Me, Upgrade)"

  local EMAIL="smoketest_$$@example.com"

  # Signup
  local r; r=$(call POST /v1/cloud/signup \
    "{\"email\":\"${EMAIL}\",\"password\":\"password123\",\"name\":\"Smoke Founder\",\"org_name\":\"SmokeOrg\"}")
  local status="${r%%|*}"; local body="${r#*|}"
  assert "POST /v1/cloud/signup → 201" "$status" "201"
  assert_contains "Signup returns token" "$body" '"token"'
  assert_contains "Signup returns organization" "$body" '"organization"'
  assert_contains "Org tier is free" "$body" '"free"'

  CLOUD_TOKEN=$(json_get "$body" "token")

  # Duplicate signup → 400
  r=$(call POST /v1/cloud/signup \
    "{\"email\":\"${EMAIL}\",\"password\":\"password123\",\"name\":\"Smoke Founder\",\"org_name\":\"SmokeOrg\"}")
  status="${r%%|*}"
  assert "POST /v1/cloud/signup (duplicate email) → 400" "$status" "400"

  # Login
  r=$(call POST /v1/cloud/login \
    "{\"email\":\"${EMAIL}\",\"password\":\"password123\"}")
  status="${r%%|*}"; body="${r#*|}"
  assert "POST /v1/cloud/login → 200" "$status" "200"
  assert_contains "Login returns token" "$body" '"token"'

  # Login wrong password → 401
  r=$(call POST /v1/cloud/login \
    "{\"email\":\"${EMAIL}\",\"password\":\"wrongpassword\"}")
  status="${r%%|*}"
  assert "POST /v1/cloud/login (wrong password) → 401" "$status" "401"

  # Me
  if [[ -n "${CLOUD_TOKEN:-}" ]]; then
    r=$(call GET /v1/cloud/me "" "Authorization: Bearer ${CLOUD_TOKEN}")
    status="${r%%|*}"; body="${r#*|}"
    assert "GET /v1/cloud/me → 200" "$status" "200"
    assert_contains "Me has user" "$body" '"user"'
    assert_contains "Me has usage" "$body" '"usage"'
    assert_contains "Me has tier_limits" "$body" '"tier_limits"'

    # Upgrade org tier
    r=$(call POST /v1/cloud/org/upgrade \
      '{"tier":"pro"}' "Authorization: Bearer ${CLOUD_TOKEN}")
    status="${r%%|*}"; body="${r#*|}"
    assert "POST /v1/cloud/org/upgrade → 200" "$status" "200"
    assert_contains "Org upgraded to pro" "$body" '"pro"'

    # Me should now reflect pro tier
    r=$(call GET /v1/cloud/me "" "Authorization: Bearer ${CLOUD_TOKEN}")
    status="${r%%|*}"; body="${r#*|}"
    assert "GET /v1/cloud/me after upgrade → 200" "$status" "200"
    assert_contains "Me org tier is pro" "$body" '"pro"'
  fi
}

test_audit_logs() {
  log_header "7 · Audit Logs"

  local r; r=$(call_admin GET "/v1/admin/audit-logs")
  local status="${r%%|*}"; local body="${r#*|}"
  assert "GET /v1/admin/audit-logs → 200" "$status" "200"
  assert_contains "Audit logs list" "$body" '"audit_logs"'
}

test_openapi_spec() {
  log_header "8 · OpenAPI 3.0 Spec"

  local r; r=$(call GET /v1/openapi.json)
  local status="${r%%|*}"; local body="${r#*|}"
  assert "GET /v1/openapi.json → 200" "$status" "200"
  assert_contains "OpenAPI spec has openapi key" "$body" '"openapi"'
  assert_contains "OpenAPI spec has paths" "$body" '"paths"'
}

test_rate_limit_headers() {
  log_header "9 · Rate Limit Response Headers & Exhaustion"

  if [[ -z "${SMOKE_API_KEY:-}" ]]; then
    log_info "Skipping rate limit tests – no API key"
    return
  fi

  # --- 9a: Check X-RateLimit-Limit header on first request ---
  local raw
  raw=$(curl -s -D - -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${SMOKE_API_KEY}" \
    -d '{"amount_paise":100,"currency":"INR"}' \
    "${HOST}/v1/orders" 2>/dev/null)

  TOTAL=$((TOTAL + 1))
  if echo "$raw" | grep -qi "x-ratelimit-limit"; then
    PASS=$((PASS + 1))
    RESULTS+=("${GRN}  ✓ PASS${RST}  X-RateLimit-Limit header present")
    echo -e "${GRN}  ✓ PASS${RST}  X-RateLimit-Limit header present"
  else
    FAIL=$((FAIL + 1))
    RESULTS+=("${RED}  ✗ FAIL${RST}  X-RateLimit-Limit header missing")
    echo -e "${RED}  ✗ FAIL${RST}  X-RateLimit-Limit header missing"
  fi

  TOTAL=$((TOTAL + 1))
  if echo "$raw" | grep -qi "x-ratelimit-remaining"; then
    PASS=$((PASS + 1))
    RESULTS+=("${GRN}  ✓ PASS${RST}  X-RateLimit-Remaining header present")
    echo -e "${GRN}  ✓ PASS${RST}  X-RateLimit-Remaining header present"
  else
    FAIL=$((FAIL + 1))
    RESULTS+=("${RED}  ✗ FAIL${RST}  X-RateLimit-Remaining header missing")
    echo -e "${RED}  ✗ FAIL${RST}  X-RateLimit-Remaining header missing"
  fi

  # Extract limit from header (e.g. "X-RateLimit-Limit: 500")
  local rate_limit
  rate_limit=$(echo "$raw" | grep -i "x-ratelimit-limit:" | grep -o '[0-9]*' | head -1)
  log_info "Rate limit for this product: ${rate_limit:-unknown} req/hour"

  # --- 9b: Create a FRESH test product with a tiny rate limit of 5 req/hour ---
  log_info "Creating low-rate-limit product (5 req/hr) for exhaustion test..."
  local rl_slug="rl-test-${RUN_ID}"
  local rp; rp=$(call_admin POST /v1/admin/products \
    "{\"name\":\"RateLimit Test\",\"slug\":\"${rl_slug}\",\"rate_limit_per_hour\":5}")
  local rp_body="${rp#*|}"

  local rk; rk=$(call_admin POST "/v1/admin/products/${rl_slug}/keys" '{"name":"RL Key"}')
  local rk_body="${rk#*|}"
  local RL_KEY; RL_KEY=$(json_get "$rk_body" "key")

  if [[ -z "$RL_KEY" ]]; then
    log_info "Could not mint RL test key, skipping exhaustion test"
    return
  fi

  log_info "Rate-limited key: ${RL_KEY:0:20}... (limit: 5/hr)"

  # --- 9c: Fire 5 requests — all should succeed ---
  log_info "Sending 5 requests (all should be 201)..."
  local ok_count=0
  for i in $(seq 1 5); do
    local res; res=$(call POST /v1/orders \
      '{"amount_paise":100,"currency":"INR"}' \
      "Authorization: Bearer ${RL_KEY}")
    local sc="${res%%|*}"
    if [[ "$sc" == "201" ]]; then
      ok_count=$((ok_count + 1))
      echo -e "    Request $i → ${GRN}201 OK${RST}"
    else
      echo -e "    Request $i → ${RED}${sc} (unexpected)${RST}"
    fi
  done

  TOTAL=$((TOTAL + 1))
  if [[ $ok_count -eq 5 ]]; then
    PASS=$((PASS + 1))
    RESULTS+=("${GRN}  ✓ PASS${RST}  5/5 requests within rate limit → 201")
    echo -e "${GRN}  ✓ PASS${RST}  5/5 requests within limit all returned 201"
  else
    FAIL=$((FAIL + 1))
    RESULTS+=("${RED}  ✗ FAIL${RST}  Only ${ok_count}/5 requests within limit returned 201")
    echo -e "${RED}  ✗ FAIL${RST}  Only ${ok_count}/5 pre-limit requests returned 201"
  fi

  # --- 9d: Fire the 6th request — MUST be 429 rate limited ---
  log_info "Sending 6th request (should be 429 rate-limited)..."
  local rl_res; rl_res=$(call POST /v1/orders \
    '{"amount_paise":100,"currency":"INR"}' \
    "Authorization: Bearer ${RL_KEY}")
  local rl_status="${rl_res%%|*}"
  local rl_body="${rl_res#*|}"

  TOTAL=$((TOTAL + 1))
  if [[ "$rl_status" == "429" ]]; then
    PASS=$((PASS + 1))
    RESULTS+=("${GRN}  ✓ PASS${RST}  6th request correctly rate-limited → 429")
    echo -e "${GRN}  ✓ PASS${RST}  6th request correctly rate-limited → HTTP 429"
  else
    FAIL=$((FAIL + 1))
    RESULTS+=("${RED}  ✗ FAIL${RST}  6th request NOT rate-limited (expected 429, got ${rl_status})")
    echo -e "${RED}  ✗ FAIL${RST}  6th request NOT rate-limited [expected 429, got ${rl_status}]"
    echo -e "          Body: ${rl_body:0:200}"
  fi

  # --- 9e: Check Retry-After header is present on the 429 ---
  local rl_raw; rl_raw=$(curl -s -D - -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${RL_KEY}" \
    -d '{"amount_paise":100,"currency":"INR"}' \
    "${HOST}/v1/orders" 2>/dev/null)

  TOTAL=$((TOTAL + 1))
  if echo "$rl_raw" | grep -qi "retry-after"; then
    PASS=$((PASS + 1))
    local retry_after; retry_after=$(echo "$rl_raw" | grep -i "retry-after:" | grep -o '[0-9]*' | head -1)
    RESULTS+=("${GRN}  ✓ PASS${RST}  Retry-After header present on 429 (${retry_after}s)")
    echo -e "${GRN}  ✓ PASS${RST}  Retry-After header present on 429 (${retry_after}s until reset)"
  else
    FAIL=$((FAIL + 1))
    RESULTS+=("${RED}  ✗ FAIL${RST}  Retry-After header missing on 429 response")
    echo -e "${RED}  ✗ FAIL${RST}  Retry-After header missing on 429 response"
  fi
}

test_security_headers() {
  log_header "10 · Security Headers"

  local raw
  raw=$(curl -s -I "${HOST}/health" 2>/dev/null)

  for h in "x-content-type-options" "x-frame-options" "strict-transport-security" "x-request-id"; do
    TOTAL=$((TOTAL + 1))
    if echo "$raw" | grep -qi "$h"; then
      PASS=$((PASS + 1))
      RESULTS+=("${GRN}  ✓ PASS${RST}  Security header: $h")
      echo -e "${GRN}  ✓ PASS${RST}  Security header present: $h"
    else
      FAIL=$((FAIL + 1))
      RESULTS+=("${RED}  ✗ FAIL${RST}  Security header missing: $h")
      echo -e "${RED}  ✗ FAIL${RST}  Security header missing: $h"
    fi
  done
}

# ─── Main ────────────────────────────────────────────────────

trap stop_server EXIT INT TERM

start_server

SMOKE_API_KEY=""
SMOKE_ORDER_ID=""
CLOUD_TOKEN=""

test_health_and_static
test_admin_products
test_validation_errors
test_billing_orders
test_customers
test_cloud_saas
test_audit_logs
test_openapi_spec
test_rate_limit_headers
test_security_headers

# ─── Final Report ────────────────────────────────────────────

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════════╗${RST}"
echo -e "${BOLD}║           PayDeck Smoke Test — Final Report                  ║${RST}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════════╝${RST}"
echo ""

for result in "${RESULTS[@]}"; do
  echo -e "$result"
done

echo ""
echo -e "─────────────────────────────────────────────────────────────────"
echo -e "  ${BOLD}Total:${RST}  $TOTAL   ${GRN}${BOLD}Passed:${RST} $PASS   ${RED}${BOLD}Failed:${RST} $FAIL"
echo -e "─────────────────────────────────────────────────────────────────"

if [[ $FAIL -eq 0 ]]; then
  echo -e "\n${GRN}${BOLD}  🎉 ALL ${TOTAL} TESTS PASSED — PayDeck is healthy and production-ready!${RST}\n"
  exit 0
else
  echo -e "\n${RED}${BOLD}  ⚠️  ${FAIL}/${TOTAL} TESTS FAILED — Review failures above.${RST}\n"
  exit 1
fi
