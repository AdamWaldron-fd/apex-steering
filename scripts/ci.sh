#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

echo "=== Rust tests ==="
cd "$ROOT"
cargo test --workspace

echo ""
echo "=== WASM builds ==="
"$ROOT/scripts/build-wasm.sh"

echo ""
echo "=== Main-steering build + tests ==="
cd "$ROOT"
npm run build:main
npm run test:main

echo ""
echo "=== E2E tests ==="
npm run test:e2e
