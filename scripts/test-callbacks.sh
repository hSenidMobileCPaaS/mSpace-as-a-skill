#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# mSpace callback handler tests
#
# Posts real mSpace callback payloads at your own endpoints. No mSpace account
# or connectivity needed — the payloads are fully specified, so you can build
# and test the inbound half of the integration before provisioning.
#
# Usage:
#   ./scripts/test-callbacks.sh [base-url]
#   ./scripts/test-callbacks.sh http://localhost:3000
#
# Every handler must answer HTTP 200 with:
#   {"statusCode":"S1000","statusDetail":"Success"}
# ...including for malformed and wrong-application payloads. Anything the
# platform cannot parse comes back to you as E1607 on the outbound path.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

BASE="${1:-http://localhost:3000}"
APP_ID="${MSPACE_APP_ID:-APP_000029}"

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; DIM=$'\033[2m'; NC=$'\033[0m'
PASS=0; FAIL=0

# check <name> <path> <body>
check() {
  local name="$1" path="$2" body="$3"
  printf '%-42s' "$name"
  local out status response
  out=$(curl -sS --max-time 10 -w '\n%{http_code}' -X POST "$BASE$path" \
    -H 'Content-Type: application/json' --data "$body" 2>&1)
  status=$(printf '%s' "$out" | tail -1)
  response=$(printf '%s' "$out" | sed '$d')

  if [ "$status" != "200" ]; then
    echo "${RED}HTTP $status${NC}  (must always be 200 — a non-2xx triggers redelivery)"
    FAIL=$((FAIL+1)); return
  fi
  if printf '%s' "$response" | grep -q '"S1000"'; then
    echo "${GREEN}200 S1000${NC}"; PASS=$((PASS+1))
  else
    echo "${RED}200 but no S1000${NC}"; echo "${DIM}  $response${NC}"; FAIL=$((FAIL+1))
  fi
}

echo
echo "Callback tests against $BASE"
echo

echo "── Valid payloads ──────────────────────────────────────"

check "SMS Receive (MO)" /api/mspace/sms/receive \
  "{\"version\":\"1.0\",\"applicationId\":\"$APP_ID\",\"sourceAddress\":\"tel:94702725777\",\"message\":\"MYAPP hello\",\"requestId\":\"22607072011552911\",\"encoding\":\"0\"}"

check "Delivery report (DELIVERED)" /api/mspace/sms/report \
  '{"destinationAddress":"tel:94702725777","timeStamp":"20120113082110","requestId":"MSG_000111","deliveryStatus":"DELIVERED"}'

check "Delivery report (SMPP spelling)" /api/mspace/sms/report \
  '{"destinationAddress":"tel:94702725777","timeStamp":"1201130821","requestId":"MSG_000112","deliveryStatus":"DELIVRD"}'

check "USSD mo-init" /api/mspace/ussd/receive \
  "{\"version\":\"1.0\",\"applicationId\":\"$APP_ID\",\"message\":\"*141#\",\"requestId\":\"1330933229901\",\"sessionId\":\"1330929317043\",\"ussdOperation\":\"mo-init\",\"sourceAddress\":\"tel:94702725777\",\"vlrAddress\":\"tel:94702725777\",\"encoding\":\"440\"}"

check "USSD mo-cont" /api/mspace/ussd/receive \
  "{\"version\":\"1.0\",\"applicationId\":\"$APP_ID\",\"message\":\"1\",\"requestId\":\"1330933229902\",\"sessionId\":\"1330929317043\",\"ussdOperation\":\"mo-cont\",\"sourceAddress\":\"tel:94702725777\",\"encoding\":\"440\"}"

check "Subscription REGISTERED" /api/mspace/subscription/notification \
  "{\"timeStamp\":\"20120113082110\",\"version\":\"1.0\",\"applicationId\":\"$APP_ID\",\"subscriberId\":\"tel:94716177301\",\"frequency\":\"monthly\",\"status\":\"REGISTERED\"}"

check "Subscription UNREGISTERED" /api/mspace/subscription/notification \
  "{\"timeStamp\":\"20120113082111\",\"version\":\"1.0\",\"applicationId\":\"$APP_ID\",\"subscriberId\":\"tel:94716177301\",\"frequency\":\"monthly\",\"status\":\"UNREGISTERED\"}"

check "Charging notification (paid)" /api/mspace/charging/notification \
  '{"timeStamp":"2026-10-02T14:59:00+05:30","version":"1.0","externalTrxId":"256091234","internalTrxId":"125100214570415","referenceId":"12526","currency":"LKR","TotalAmount":"5.00","paidAmount":"5.00","balanceDue":"0.00","statusCode":"S1000","statusDetail":"Request was Successfully processed, Due amount fully paid."}'

check "Charging notification (failed)" /api/mspace/charging/notification \
  '{"timeStamp":"2026-10-02T15:01:00+05:30","version":"1.0","externalTrxId":"256091235","internalTrxId":"125100214570416","referenceId":"12527","currency":"LKR","TotalAmount":"5.00","paidAmount":"0.00","balanceDue":"5.00","statusCode":"E1405","statusDetail":"Charging request timed out, No payments done"}'

echo
echo "── Hostile payloads (must still return 200 S1000) ───────"

check "Malformed JSON" /api/mspace/ussd/receive \
  '{not valid json'

check "Empty body" /api/mspace/sms/receive \
  ''

check "Wrong applicationId" /api/mspace/sms/receive \
  '{"version":"1.0","applicationId":"APP_999999","sourceAddress":"tel:94702725777","message":"x","requestId":"r1","encoding":"0"}'

check "Missing required fields" /api/mspace/ussd/receive \
  '{"applicationId":"'"$APP_ID"'"}'

check "Oversized message" /api/mspace/sms/receive \
  "{\"version\":\"1.0\",\"applicationId\":\"$APP_ID\",\"sourceAddress\":\"tel:94702725777\",\"message\":\"$(printf 'A%.0s' {1..5000})\",\"requestId\":\"r2\",\"encoding\":\"0\"}"

echo
echo "── Idempotency (the test people skip) ───────────────────"
echo "${DIM}  Same payload twice. Both must return 200 S1000, and your handler${NC}"
echo "${DIM}  must process it ONCE. Verify in your logs or database.${NC}"

DUP='{"timeStamp":"2026-10-02T14:59:00+05:30","version":"1.0","externalTrxId":"dup-test-001","internalTrxId":"999","referenceId":"1","currency":"LKR","TotalAmount":"5.00","paidAmount":"5.00","balanceDue":"0.00","statusCode":"S1000","statusDetail":"Request was Successfully processed, Due amount fully paid."}'
check "Charging notification (1st)" /api/mspace/charging/notification "$DUP"
check "Charging notification (2nd)" /api/mspace/charging/notification "$DUP"

echo
echo "────────────────────────────────────────────────────────"
echo "  ${GREEN}passed ${PASS}${NC}   ${RED}failed ${FAIL}${NC}"
echo
[ "$FAIL" -eq 0 ] || exit 1
