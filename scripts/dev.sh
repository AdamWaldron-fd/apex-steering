#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

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

trap "kill $MAIN_PID $EDGE_PID $SANDBOX_PID 2>/dev/null" EXIT

echo ""
echo "  Main steering:  http://localhost:4444"
echo "  Edge steering:  http://localhost:3077"
echo "  Sandbox:        http://localhost:5555"
echo ""
echo "  Press Ctrl+C to stop all services."
wait
