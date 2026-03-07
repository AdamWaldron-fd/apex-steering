#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

echo "=== Checking prerequisites ==="
for cmd in cargo wasm-pack node npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd"
    exit 1
  fi
done
echo "  Node $(node --version)"
echo "  cargo $(cargo --version 2>/dev/null | cut -d' ' -f2)"
echo "  wasm-pack $(wasm-pack --version 2>/dev/null | cut -d' ' -f2)"

echo ""
echo "=== Building WASM crates ==="
"$ROOT/scripts/build-wasm.sh"

echo ""
echo "=== Installing npm dependencies ==="
cd "$ROOT"
npm install

echo ""
echo "=== Building main-steering ==="
npm run build:main

echo ""
echo "=== Bootstrap complete ==="
