#!/usr/bin/env bash
# test-device.sh — Run all tests on RDK X5 device
# Usage: ./scripts/test-device.sh [--all | --go | --rust | --python | --e2e]
set -euo pipefail
cd "$(dirname "$0")/.."

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
FAIL=0

run_section() {
  echo -e "\n${YELLOW}=== $1 ===${NC}"
}

report() {
  if [ $1 -eq 0 ]; then
    echo -e "${GREEN}PASS${NC}: $2"
  else
    echo -e "${RED}FAIL${NC}: $2"
    FAIL=1
  fi
}

# --- Go tests (including CGO-dependent packages) ---
test_go() {
  run_section "Go: all packages (CGO enabled)"
  cd src/streaming_server

  echo "--- gofmt ---"
  unformatted=$(gofmt -l .)
  if [ -n "$unformatted" ]; then
    echo "$unformatted"
    report 1 "gofmt"
  else
    report 0 "gofmt"
  fi

  echo "--- go vet ---"
  go vet ./... 2>&1 && report 0 "go vet" || report 1 "go vet"

  echo "--- go test (unit — webmonitor) ---"
  go test ./internal/webmonitor/ -v -count=1 2>&1 && report 0 "go test webmonitor" || report 1 "go test webmonitor"

  cd ../..
}

# --- Go E2E tests (requires running server) ---
test_go_e2e() {
  run_section "Go: E2E (requires running server on :8080)"
  cd src/streaming_server

  if curl -sf http://localhost:8080/api/status > /dev/null 2>&1; then
    SPEC_BASE_URL=http://localhost:8080 go test ./internal/flaskcompat/ -v -count=1 -run "TestFlaskCompat" 2>&1 && \
      report 0 "go e2e flaskcompat" || report 1 "go e2e flaskcompat"
  else
    echo -e "${YELLOW}SKIP${NC}: server not running on :8080"
  fi

  cd ../..
}

# --- Rust tests ---
test_rust() {
  run_section "Rust: fmt + clippy + test"
  cd src/ai-pyramid

  echo "--- cargo fmt ---"
  cargo fmt -- --check 2>&1 && report 0 "cargo fmt" || report 1 "cargo fmt"

  echo "--- cargo clippy ---"
  cargo clippy -- -D warnings 2>&1 && report 0 "cargo clippy" || report 1 "cargo clippy"

  echo "--- cargo test ---"
  cargo test --workspace 2>&1 && report 0 "cargo test (56 tests)" || report 1 "cargo test"

  cd ../..
}

# --- Python tests ---
test_python() {
  run_section "Python: pyright + device tests"

  echo "--- pyright ---"
  uv run pyright src/common src/mock 2>&1 && report 0 "pyright" || report 1 "pyright"

  if [ -f src/capture/test_integration.py ]; then
    echo "--- capture integration test ---"
    uv run python src/capture/test_integration.py 2>&1 && \
      report 0 "capture integration" || report 1 "capture integration"
  fi
}

# --- Mermaid validation ---
test_docs() {
  run_section "Docs: mermaid validation"
  PUPPETEER_CONFIG=/tmp/puppeteer-config.json
  if [ ! -f "$PUPPETEER_CONFIG" ]; then
    echo '{"executablePath":"/home/sunrise/.cache/ms-playwright/chromium-1208/chrome-linux/chrome","args":["--no-sandbox","--disable-gpu"]}' > "$PUPPETEER_CONFIG"
  fi

  DOC_FAIL=0
  for file in $(find docs src -name '*.md' \( -path '*/docs/*' -o -name 'CLAUDE.md' \) | sort); do
    rm -f /tmp/mermaid_block_*.mmd
    awk '/^```mermaid$/{flag=1; block++; next} /^```$/{if(flag) flag=0; next} flag{print > "/tmp/mermaid_block_" block ".mmd"}' "$file"
    BLOCK=0
    for mmd in /tmp/mermaid_block_*.mmd; do
      [ -f "$mmd" ] || continue
      BLOCK=$((BLOCK+1))
      if bunx @mermaid-js/mermaid-cli -i "$mmd" -o /tmp/mermaid_out.svg -p "$PUPPETEER_CONFIG" > /dev/null 2>&1; then
        echo "  OK: $file #$BLOCK"
      else
        echo -e "  ${RED}FAIL${NC}: $file #$BLOCK"
        DOC_FAIL=1
      fi
      rm -f "$mmd" /tmp/mermaid_out.svg
    done
  done
  report $DOC_FAIL "mermaid"
}

# --- Main ---
MODE="${1:---all}"

case "$MODE" in
  --go)     test_go ;;
  --rust)   test_rust ;;
  --python) test_python ;;
  --e2e)    test_go_e2e ;;
  --docs)   test_docs ;;
  --all)
    test_go
    test_rust
    test_python
    test_docs
    test_go_e2e
    ;;
  *)
    echo "Usage: $0 [--all | --go | --rust | --python | --e2e | --docs]"
    exit 1
    ;;
esac

echo ""
if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}All tests passed${NC}"
else
  echo -e "${RED}Some tests failed${NC}"
  exit 1
fi
