#!/usr/bin/env bash
# Resync the vendored SMI contract from freshify-authz main.
set -euo pipefail
VENDOR_DIR="$(cd "$(dirname "$0")/.." && pwd)/src/vendor"
TMPFILE="$(mktemp)"
gh api repos/freshifyv2/freshify-authz/contents/src/smi.ts --jq '.content' | base64 -d > "$TMPFILE"
head -n 13 "$VENDOR_DIR/smi.ts" > "$VENDOR_DIR/smi.ts.new"
tail -n +12 "$TMPFILE" >> "$VENDOR_DIR/smi.ts.new"
mv "$VENDOR_DIR/smi.ts.new" "$VENDOR_DIR/smi.ts"
rm "$TMPFILE"
echo "SMI resynced. Run 'npm run typecheck' to verify."
