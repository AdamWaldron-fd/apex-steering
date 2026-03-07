#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

RUN_E2E=false
for arg in "$@"; do
  case "$arg" in
    --e2e) RUN_E2E=true ;;
    --all) RUN_E2E=true ;;
  esac
done

echo "=== apex-main-steering test runner ==="
echo

echo "--- Building TypeScript ---"
npm run build
echo

echo "--- Running unit + integration tests ---"
npm test
echo

if [ "$RUN_E2E" = true ]; then
  echo "--- Running E2E HTTP tests ---"
  ./scripts/test-e2e.sh
  echo
fi

echo "=== All checks passed ==="
