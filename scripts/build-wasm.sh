#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

echo "=== Building manifest-updater WASM (nodejs target) ==="
cd "$ROOT/crates/manifest-updater"
wasm-pack build --target nodejs --release --out-dir pkg-node
echo "  pkg-node/apex_manifest_updater_bg.wasm: $(wc -c < pkg-node/apex_manifest_updater_bg.wasm | tr -d ' ') bytes"

echo ""
echo "=== Building edge-steering WASM (bundler target) ==="
cd "$ROOT/crates/edge-steering"
wasm-pack build --target bundler --release
echo "  pkg/apex_edge_steering_bg.wasm: $(wc -c < pkg/apex_edge_steering_bg.wasm | tr -d ' ') bytes"

echo ""
echo "=== WASM builds complete ==="
