#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# mSpace smoke tests
#
# Verifies credentials, the allowed-host-address list, and every endpoint you
# have configured.
#
# Only the services with a URL set in your environment are tested — an unset
# endpoint means that API is not enabled on your application, so there is
# nothing to test. Configure them in .env; see templates/.env.example.
#
# Usage:
#   cp templates/.env.example .env && $EDITOR .env
#   ./scripts/smoke-test.sh                 # safe tests only
#   ./scripts/smoke-test.sh --with-sms      # also sends a real SMS
#   ./scripts/smoke-test.sh --with-charge   # also starts a REAL charge (sends an OTP)
#   ./scripts/smoke-test.sh --with-lbs      # also locates a subscriber
#
# RUN THIS FROM THE SERVER THAT WILL CALL mSPACE. Running it from a laptop tests
# the laptop's IP, which is not what you put in Allowed Host Address, and E1303
# will tell you nothing useful.
#
# Credentials come from the environment. Never paste them into this file.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

[ -f .env ] && set -a && . ./.env && set +a

: "${MSPACE_APP_ID:?Set MSPACE_APP_ID (see templates/.env.example)}"
: "${MSPACE_PASSWORD:?Set MSPACE_PASSWORD (see templates/.env.example)}"

# A number in your application's Whitelisted Numbers list.
TEST_MSISDN="${TEST_MSISDN:-94702725777}"

WITH_SMS=false; WITH_CHARGE=false; WITH_LBS=false
for arg in "$@"; do
  case "$arg" in
    --with-sms) WITH_SMS=true ;;
    --with-charge) WITH_CHARGE=true ;;
    --with-lbs) WITH_LBS=true ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[0;33m'; DIM=$'\033[2m'; NC=$'\033[0m'
PASS=0; FAIL=0; SKIP=0

skip() { printf '%-30s%s\n' "$1" "${DIM}$2${NC}"; SKIP=$((SKIP+1)); }

# call <name> <url> <json-body> [extra-success-code]
call() {
  local name="$1" url="$2" body="$3" extra="${4:-}"
  printf '%-30s' "$name"
  local response
  response=$(curl -sS --max-time 20 -X POST "$url" \
    -H 'Content-Type: application/json;charset=utf-8' --data "$body" 2>&1)

  if [ -z "$response" ]; then
    echo "${RED}NO RESPONSE${NC}  (network, firewall, or TLS chain problem)"
    FAIL=$((FAIL+1)); return
  fi

  local code
  code=$(printf '%s' "$response" | grep -o '"statusCode"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([SEP][0-9]*\)"/\1/')

  if [ -n "$extra" ] && [ "$code" = "$extra" ]; then
    echo "${GREEN}${code} OK${NC}  ${DIM}(documented success for this call)${NC}"
    PASS=$((PASS+1)); return
  fi

  case "$code" in
    S1000) echo "${GREEN}S1000 OK${NC}"; PASS=$((PASS+1)) ;;
    S1001) echo "${GREEN}S1001${NC}  No subscribers found (a success)"; PASS=$((PASS+1)) ;;
    P1003) echo "${GREEN}P1003${NC}  OTP sent — nothing charged yet"; PASS=$((PASS+1)) ;;
    E1303) echo "${RED}E1303${NC}  This IP is not in Allowed Host Address on the application"; FAIL=$((FAIL+1)) ;;
    E1313) echo "${RED}E1313${NC}  Auth failure — check MSPACE_APP_ID / MSPACE_PASSWORD"; FAIL=$((FAIL+1)) ;;
    E1309) echo "${YELLOW}E1309${NC}  Service not provisioned — remove this URL from your .env"; FAIL=$((FAIL+1)) ;;
    E1104) echo "${YELLOW}E1104${NC}  Application is not in Active or Limited Production status"; FAIL=$((FAIL+1)) ;;
    E1343) echo "${YELLOW}E1343${NC}  $TEST_MSISDN is not in Whitelisted Numbers"; FAIL=$((FAIL+1)) ;;
    "")    echo "${RED}NO statusCode${NC}"; echo "${DIM}  $response${NC}"; FAIL=$((FAIL+1)) ;;
    *)     echo "${RED}${code}${NC}"; echo "${DIM}  $response${NC}"; FAIL=$((FAIL+1)) ;;
  esac
}

creds="\"applicationId\":\"$MSPACE_APP_ID\",\"password\":\"$MSPACE_PASSWORD\""

echo
echo "mSpace smoke test"
echo "  app id     $MSPACE_APP_ID"
echo "  password   ***redacted***"
echo "  ${DIM}Run this on the server that will call mSpace: its egress IP is what must be${NC}"
echo "  ${DIM}listed under Allowed Host Address on the application record.${NC}"
echo

# ── Subscription ────────────────────────────────────────────────────────────
echo "── Subscription ────────────────────────────────"
if [ -n "${MSPACE_SUBSCRIPTION_QUERY_BASE_URL:-}" ]; then
  call "Query Base (base size)" "$MSPACE_SUBSCRIPTION_QUERY_BASE_URL" "{$creds}"
else
  skip "Query Base (base size)" "MSPACE_SUBSCRIPTION_QUERY_BASE_URL not set"
fi

if [ -n "${MSPACE_SUBSCRIPTION_STATUS_URL:-}" ]; then
  call "Subscriber Status" "$MSPACE_SUBSCRIPTION_STATUS_URL" \
    "{$creds,\"subscriberId\":\"tel:$TEST_MSISDN\"}"
else
  skip "Subscriber Status" "MSPACE_SUBSCRIPTION_STATUS_URL not set"
fi

if [ -n "${MSPACE_SUBSCRIPTION_CHARGING_INFO_URL:-}" ]; then
  call "Subscriber Charging Info" "$MSPACE_SUBSCRIPTION_CHARGING_INFO_URL" \
    "{$creds,\"subscriberIds\":[\"tel:$TEST_MSISDN\"]}"
else
  skip "Subscriber Charging Info" "MSPACE_SUBSCRIPTION_CHARGING_INFO_URL not set"
fi

if [ -n "${MSPACE_SUBSCRIPTION_LIST_URL:-}" ]; then
  call "Subscriber List (page 1)" "$MSPACE_SUBSCRIPTION_LIST_URL" \
    "{$creds,\"version\":\"1.0\",\"requestPage\":1}" "S1001"
else
  skip "Subscriber List (page 1)" "MSPACE_SUBSCRIPTION_LIST_URL not set"
fi

if [ -n "${MSPACE_SUBSCRIPTION_SEND_URL:-}" ]; then
  call "Register (opt-in)" "$MSPACE_SUBSCRIPTION_SEND_URL" \
    "{$creds,\"subscriberId\":\"tel:$TEST_MSISDN\",\"action\":\"1\"}"
  call "Unregister (opt-out)" "$MSPACE_SUBSCRIPTION_SEND_URL" \
    "{$creds,\"subscriberId\":\"tel:$TEST_MSISDN\",\"action\":\"0\"}"
else
  skip "Register / Unregister" "MSPACE_SUBSCRIPTION_SEND_URL not set"
fi

# ── CaaS ────────────────────────────────────────────────────────────────────
echo
echo "── CaaS ────────────────────────────────────────"
if [ -z "${MSPACE_CAAS_DEBIT_URL:-}" ]; then
  skip "CaaS OTP Generation" "MSPACE_CAAS_DEBIT_URL not set"
elif [ "$WITH_CHARGE" != true ]; then
  skip "CaaS OTP Generation" "skipped (--with-charge to run — starts a real charge)"
else
  echo "${YELLOW}  ⚠  This starts a REAL charge against $TEST_MSISDN and sends them an OTP.${NC}"
  echo "${YELLOW}     Money moves only when that OTP is verified — see references/05-caas.md.${NC}"
  TRX_ID=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
  echo "${DIM}  externalTrxId: $TRX_ID  (persist this before charging, in real code)${NC}"
  call "CaaS OTP Generation (LKR 1)" "$MSPACE_CAAS_DEBIT_URL" \
    "{$creds,\"externalTrxId\":\"$TRX_ID\",\"subscriberId\":\"tel:$TEST_MSISDN\",\"paymentInstrumentName\":\"Mobile Account\",\"amount\":\"1.00\",\"currency\":\"LKR\"}" \
    "P1003"
  echo "${DIM}  Take requestCorrelator from the response above, collect the OTP from the${NC}"
  echo "${DIM}  subscriber, then POST it to \$MSPACE_CAAS_OTP_VERIFY_URL as referenceNo.${NC}"
fi

if [ -z "${MSPACE_CAAS_OTP_VERIFY_URL:-}" ]; then
  skip "CaaS OTP Verification" "MSPACE_CAAS_OTP_VERIFY_URL not set"
else
  skip "CaaS OTP Verification" "needs a live requestCorrelator and a real OTP — run it by hand"
fi

# ── SMS ─────────────────────────────────────────────────────────────────────
echo
echo "── SMS ─────────────────────────────────────────"
if [ -z "${MSPACE_SMS_SEND_URL:-}" ]; then
  skip "SMS Send" "MSPACE_SMS_SEND_URL not set"
elif [ "$WITH_SMS" != true ]; then
  skip "SMS Send" "skipped (--with-sms to run — sends a real SMS)"
else
  call "SMS Send" "$MSPACE_SMS_SEND_URL" \
    "{$creds,\"version\":\"1.0\",\"message\":\"mSpace smoke test\",\"destinationAddresses\":[\"tel:$TEST_MSISDN\"]}"
fi

# ── LBS ─────────────────────────────────────────────────────────────────────
echo
echo "── LBS ─────────────────────────────────────────"
if [ -z "${MSPACE_LBS_REQUEST_URL:-}" ]; then
  skip "Request Location" "MSPACE_LBS_REQUEST_URL not set"
elif [ "$WITH_LBS" != true ]; then
  skip "Request Location" "skipped (--with-lbs to run — requires consent)"
else
  call "Request Location" "$MSPACE_LBS_REQUEST_URL" \
    "{$creds,\"requesterId\":\"tel:$TEST_MSISDN\",\"subscriberId\":\"tel:$TEST_MSISDN\",\"serviceType\":\"IMMEDIATE\"}"
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo
echo "───────────────────────────────────────────────"
echo "  ${GREEN}passed ${PASS}${NC}   ${RED}failed ${FAIL}${NC}   ${DIM}skipped ${SKIP}${NC}"
if [ "$PASS" -eq 0 ] && [ "$FAIL" -eq 0 ]; then
  echo "  ${YELLOW}Nothing ran — no service endpoints are configured in .env.${NC}"
fi
echo
[ "$FAIL" -eq 0 ] || exit 1
