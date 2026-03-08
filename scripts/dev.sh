#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo ""
echo "  apex-steering dev"
echo "  ─────────────────"
echo "  Starting services..."
echo ""

# Start main-steering
cd "$ROOT/packages/main-steering"
npx tsx src/server.ts --port 4444 &
MAIN_PID=$!

# Start edge-steering
cd "$ROOT/crates/edge-steering"
node scripts/server.mjs --port 3077 &
EDGE_PID=$!

# Start sandbox
cd "$ROOT/e2e"
npx tsx src/sandbox/server.ts &
SANDBOX_PID=$!

cleanup() {
  kill $MAIN_PID $EDGE_PID $SANDBOX_PID 2>/dev/null
  # Wait briefly then force-kill any stragglers
  sleep 1
  kill -9 $MAIN_PID $EDGE_PID $SANDBOX_PID 2>/dev/null
}
trap cleanup EXIT

# Wait for servers to start
sleep 2

echo ""
echo "  ✓ All services running"
echo ""
echo "  ┌──────────────────────────────────────────────┐"
echo "  │                                              │"
echo "  │   Open http://localhost:5555                 │"
echo "  │                                              │"
echo "  └──────────────────────────────────────────────┘"
echo ""
echo "  Services:"
echo "    main-steering  :4444  (control plane)"
echo "    edge-steering  :3077  (edge / data plane)"
echo "    sandbox        :5555  (dashboard + proxy)"
echo ""
echo "  Press Ctrl+C to stop all services."
wait
