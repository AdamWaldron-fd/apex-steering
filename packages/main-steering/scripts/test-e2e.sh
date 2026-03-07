#!/usr/bin/env bash
# ─── End-to-end tests for apex-main-steering ─────────────────────────────────
#
# Starts the server, exercises all endpoints with curl, validates responses.
# Usage: ./scripts/test-e2e.sh [--port PORT]

set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${1:-0}"
if [ "$PORT" = "--port" ]; then
  PORT="${2:-4444}"
elif [ "$PORT" = "0" ]; then
  PORT=4444
fi

PASS=0
FAIL=0
TOTAL=0

pass() { PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); TOTAL=$((TOTAL + 1)); echo "  ✗ $1"; echo "    $2"; }

assert_status() {
  local expected="$1" actual="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$label"
  else
    fail "$label" "expected HTTP $expected, got $actual"
  fi
}

assert_json_field() {
  local json="$1" field="$2" expected="$3" label="$4"
  local actual
  actual=$(echo "$json" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ const v=JSON.parse(d); const keys='$field'.split('.'); let r=v; for(const k of keys) r=r[k]; console.log(typeof r==='object'?JSON.stringify(r):r); })")
  if [ "$actual" = "$expected" ]; then
    pass "$label"
  else
    fail "$label" "expected $field=$expected, got $actual"
  fi
}

assert_json_has() {
  local json="$1" field="$2" label="$3"
  local has
  has=$(echo "$json" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ const v=JSON.parse(d); console.log('$field' in v ? 'yes' : 'no'); })")
  if [ "$has" = "yes" ]; then
    pass "$label"
  else
    fail "$label" "field '$field' not found in response"
  fi
}

# ─── Start server ────────────────────────────────────────────────────────────

echo "Starting apex-main-steering on port $PORT..."
npx tsx src/server.ts --port "$PORT" &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for server to be ready
for i in $(seq 1 30); do
  if curl -s "http://localhost:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

echo
echo "=== Health Check ==="
RESP=$(curl -s -w "\n%{http_code}" "http://localhost:$PORT/health")
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "200" "$STATUS" "GET /health returns 200"
assert_json_field "$BODY" "status" "ok" "health status is ok"
assert_json_field "$BODY" "engine" "apex-main-steering" "health engine name"

echo
echo "=== Session Init ==="
RESP=$(curl -s -w "\n%{http_code}" "http://localhost:$PORT/session/init?cdns=cdn-a,cdn-b&min_bitrate=783322&max_bitrate=4530860&duration=596")
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "200" "$STATUS" "GET /session/init returns 200"
assert_json_has "$BODY" "priorities" "response has priorities"
assert_json_has "$BODY" "throughput_map" "response has throughput_map"
assert_json_field "$BODY" "min_bitrate" "783322" "min_bitrate matches"
assert_json_field "$BODY" "max_bitrate" "4530860" "max_bitrate matches"
assert_json_field "$BODY" "duration" "596" "duration matches"
assert_json_field "$BODY" "position" "0" "position is 0"
assert_json_has "$BODY" "timestamp" "response has timestamp"
assert_json_has "$BODY" "override_gen" "response has override_gen"

# Missing cdns param
RESP=$(curl -s -w "\n%{http_code}" "http://localhost:$PORT/session/init")
STATUS=$(echo "$RESP" | tail -1)
assert_status "400" "$STATUS" "GET /session/init without cdns returns 400"

echo
echo "=== Fleet Registration ==="
# Register all 4 platform types
for PLATFORM in akamai cloudfront cloudflare fastly; do
  RESP=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:$PORT/fleet/register" \
    -H "Content-Type: application/json" \
    -d "{\"platform\":\"$PLATFORM\",\"control_url\":\"https://$PLATFORM.example.com/control\",\"region\":\"us-east\"}")
  STATUS=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | sed '$d')
  assert_status "201" "$STATUS" "register $PLATFORM returns 201"
  assert_json_field "$BODY" "platform" "$PLATFORM" "$PLATFORM platform matches"
done

# Invalid platform
RESP=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:$PORT/fleet/register" \
  -H "Content-Type: application/json" \
  -d '{"platform":"azure","control_url":"https://example.com/control"}')
STATUS=$(echo "$RESP" | tail -1)
assert_status "400" "$STATUS" "register invalid platform returns 400"

echo
echo "=== Fleet Deregistration ==="
# Register then delete
REG_BODY=$(curl -s -X POST "http://localhost:$PORT/fleet/register" \
  -H "Content-Type: application/json" \
  -d '{"platform":"akamai","control_url":"https://temp.example.com/control"}')
INST_ID=$(echo "$REG_BODY" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).id))")

RESP=$(curl -s -w "\n%{http_code}" -X DELETE "http://localhost:$PORT/fleet/$INST_ID")
STATUS=$(echo "$RESP" | tail -1)
assert_status "200" "$STATUS" "DELETE /fleet/:id returns 200"

RESP=$(curl -s -w "\n%{http_code}" -X DELETE "http://localhost:$PORT/fleet/nonexistent-id")
STATUS=$(echo "$RESP" | tail -1)
assert_status "404" "$STATUS" "DELETE /fleet/:id unknown returns 404"

echo
echo "=== Control Commands ==="
RESP=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:$PORT/priorities" \
  -H "Content-Type: application/json" \
  -d '{"priorities":["cdn-b","cdn-a"],"ttl_override":15}')
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "200" "$STATUS" "POST /priorities returns 200"
assert_json_field "$BODY" "generation" "1" "generation is 1"

RESP=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:$PORT/exclude" \
  -H "Content-Type: application/json" \
  -d '{"pathway":"cdn-c"}')
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "200" "$STATUS" "POST /exclude returns 200"
assert_json_field "$BODY" "generation" "2" "generation is 2"

RESP=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:$PORT/clear" \
  -H "Content-Type: application/json" \
  -d '{}')
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "200" "$STATUS" "POST /clear returns 200"
assert_json_field "$BODY" "generation" "3" "generation is 3"

# Validation errors
RESP=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:$PORT/priorities" \
  -H "Content-Type: application/json" \
  -d '{"priorities":[]}')
STATUS=$(echo "$RESP" | tail -1)
assert_status "400" "$STATUS" "POST /priorities empty array returns 400"

RESP=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:$PORT/exclude" \
  -H "Content-Type: application/json" \
  -d '{}')
STATUS=$(echo "$RESP" | tail -1)
assert_status "400" "$STATUS" "POST /exclude missing pathway returns 400"

echo
echo "=== Status ==="
RESP=$(curl -s -w "\n%{http_code}" "http://localhost:$PORT/status")
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "200" "$STATUS" "GET /status returns 200"
assert_json_field "$BODY" "generation" "3" "status generation is 3"
assert_json_has "$BODY" "cdn_providers" "status has cdn_providers"
assert_json_has "$BODY" "fleet" "status has fleet"
assert_json_has "$BODY" "contracts" "status has contracts"
assert_json_has "$BODY" "contract_usage" "status has contract_usage"

RESP=$(curl -s -w "\n%{http_code}" "http://localhost:$PORT/status/contracts")
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "200" "$STATUS" "GET /status/contracts returns 200"
assert_json_has "$BODY" "contracts" "contracts endpoint has contracts"
assert_json_has "$BODY" "usage" "contracts endpoint has usage"

echo
echo "=== Region-Scoped Commands ==="
RESP=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:$PORT/priorities" \
  -H "Content-Type: application/json" \
  -d '{"priorities":["cdn-a","cdn-b"],"region":"us-east"}')
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "200" "$STATUS" "POST /priorities with region returns 200"
assert_json_field "$BODY" "generation" "4" "region-scoped priorities generation is 4"

RESP=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:$PORT/exclude" \
  -H "Content-Type: application/json" \
  -d '{"pathway":"cdn-c","region":"eu-west"}')
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "200" "$STATUS" "POST /exclude with region returns 200"
assert_json_field "$BODY" "generation" "5" "region-scoped exclude generation is 5"

RESP=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:$PORT/clear" \
  -H "Content-Type: application/json" \
  -d '{"region":"ap-south"}')
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "200" "$STATUS" "POST /clear with region returns 200"
assert_json_field "$BODY" "generation" "6" "region-scoped clear generation is 6"

echo
echo "=== Session Init Validation ==="
# With all params
RESP=$(curl -s -w "\n%{http_code}" "http://localhost:$PORT/session/init?cdns=cdn-a&min_bitrate=100&max_bitrate=200&duration=30")
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "200" "$STATUS" "session/init with single CDN returns 200"
assert_json_field "$BODY" "min_bitrate" "100" "min_bitrate 100"
assert_json_field "$BODY" "max_bitrate" "200" "max_bitrate 200"
assert_json_field "$BODY" "duration" "30" "duration 30"
assert_json_field "$BODY" "position" "0" "position 0"

# Without optional params (defaults to 0)
RESP=$(curl -s -w "\n%{http_code}" "http://localhost:$PORT/session/init?cdns=cdn-a,cdn-b")
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "200" "$STATUS" "session/init without optional params returns 200"
assert_json_field "$BODY" "min_bitrate" "0" "defaults min_bitrate to 0"
assert_json_field "$BODY" "max_bitrate" "0" "defaults max_bitrate to 0"
assert_json_field "$BODY" "duration" "0" "defaults duration to 0"

# With region param
RESP=$(curl -s -w "\n%{http_code}" "http://localhost:$PORT/session/init?cdns=cdn-a,cdn-b&region=us-east")
STATUS=$(echo "$RESP" | tail -1)
assert_status "200" "$STATUS" "session/init with region returns 200"

# override_gen reflects current generation
RESP=$(curl -s -w "\n%{http_code}" "http://localhost:$PORT/session/init?cdns=cdn-a")
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_json_field "$BODY" "override_gen" "6" "override_gen reflects current generation"

echo
echo "=== Final Health Check ==="
RESP=$(curl -s -w "\n%{http_code}" "http://localhost:$PORT/health")
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "200" "$STATUS" "final health check returns 200"
assert_json_field "$BODY" "generation" "6" "final generation is 6"

# ─── Summary ─────────────────────────────────────────────────────────────────

echo
echo "═══════════════════════════════════════════════════"
echo "  E2E Results: $PASS passed, $FAIL failed (of $TOTAL)"
echo "═══════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
