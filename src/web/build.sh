#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${SCRIPT_DIR}/../../build/web"

mkdir -p "$OUT_DIR"

# Clean old hashed JS files
rm -f "$OUT_DIR"/main-*.js

# Build JS with content hash in filename
OUTPUT=$(bun build "$SCRIPT_DIR/src/main.tsx" --outdir "$OUT_DIR" --minify --entry-naming '[name]-[hash].[ext]' 2>&1)
echo "$OUTPUT"

# Extract generated filename (e.g. app-2hfzt605.js)
APP_JS=$(echo "$OUTPUT" | grep -oP 'main-[a-z0-9]+\.js')
if [[ -z "$APP_JS" ]]; then
  echo "ERROR: Could not determine output JS filename" >&2
  exit 1
fi

# Copy CSS and compute hash for cache busting
cp "$SCRIPT_DIR/src/styles/monitor.css" "$OUT_DIR/monitor.css"
CSS_HASH=$(md5sum "$OUT_DIR/monitor.css" | cut -c1-8)

# Generate index.html from template with hashed filenames
sed -e "s/{{APP_JS}}/$APP_JS/" \
    -e "s/{{CSS_HASH}}/$CSS_HASH/" \
    "$SCRIPT_DIR/index.html" > "$OUT_DIR/index.html"

echo "Built: $APP_JS (CSS hash: $CSS_HASH)"
