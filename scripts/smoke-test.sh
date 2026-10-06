#!/usr/bin/env bash
# Post-deployment smoke test. Exits non-zero if any check fails.
#
# Usage: scripts/smoke-test.sh <base-url> [admin-url]
#   EKS:            scripts/smoke-test.sh https://abc.com
#   docker-compose: scripts/smoke-test.sh http://localhost:8080 http://localhost:8081/admin/
#
# Side effect: registers one test user (smoke-<timestamp>@example.com) per run.
set -uo pipefail

BASE="${1:?Usage: $0 <base-url> [admin-url]}"
BASE="${BASE%/}"
ADMIN="${2:-$BASE/admin/}"
EMAIL="smoke-$(date +%s)@example.com"
PASSWORD="Smoke-$(date +%s)-pw"

failures=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; failures=$((failures + 1)); }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$1"; }

# request <method> <url> [json-body] [token] -> sets $status and $body
request() {
  local args=(-s -o /tmp/smoke-body.$$ -w '%{http_code}' -X "$1" --max-time 15)
  [[ -n "${3:-}" ]] && args+=(-H 'Content-Type: application/json' -d "$3")
  [[ -n "${4:-}" ]] && args+=(-H "Authorization: Bearer $4")
  status=$(curl "${args[@]}" "$2" || echo 000)
  body=$(cat /tmp/smoke-body.$$ 2>/dev/null || true)
  snippet=$(tr -s '\n\t ' ' ' <<<"${body:0:150}") # one-line excerpt for failure messages
}
expect() { # expect <description> <expected-status>
  if [[ "$status" == "$2" ]]; then pass "$1 ($status)"; else fail "$1: expected $2, got $status $snippet"; fi
}

echo "Smoke testing $BASE"

echo "Frontends"
request GET "$BASE/";   expect "storefront loads" 200
[[ "$body" == *'<div id="root">'* ]] || fail "storefront HTML missing app root"
request GET "$ADMIN";   expect "admin panel loads" 200

echo "Public API"
request GET "$BASE/api/products"; expect "list products" 200
request GET "$BASE/api/products/000000000000000000000000"; expect "unknown product is 404" 404

echo "Auth"
request POST "$BASE/api/users/register" "{\"name\":\"Smoke Test\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
expect "register" 201
request POST "$BASE/api/users/login" "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
expect "login" 200
TOKEN=$(sed -nE 's/.*"token":"([^"]+)".*/\1/p' <<<"$body")
[[ -n "$TOKEN" ]] || fail "login response has no token"
request POST "$BASE/api/users/login" "{\"email\":\"$EMAIL\",\"password\":\"wrong-password\"}"
expect "wrong password rejected" 401

echo "Authenticated API"
request GET "$BASE/api/users/me" "" "$TOKEN"; expect "current user" 200
request GET "$BASE/api/users/me";             expect "no token rejected" 401
request POST "$BASE/api/products" '{"name":"x","price":1,"stock":1}' "$TOKEN"
expect "non-admin cannot create product" 403

echo "Orders"
request GET "$BASE/api/orders" "" "$TOKEN"
case "$status" in
  200) pass "list orders (200)" ;;
  503) warn "orders API unavailable (503); expected if order-service is not deployed" ;;
  *)   fail "list orders: expected 200, got $status $snippet" ;;
esac

rm -f /tmp/smoke-body.$$
echo
if ((failures > 0)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "All checks passed"
