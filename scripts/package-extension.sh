#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
CRX_NAME="argo-wf-notifier-extension.crx"
ZIP_NAME="argo-wf-notifier-extension.zip"
CRX_PATH="$DIST_DIR/$CRX_NAME"
ZIP_PATH="$DIST_DIR/$ZIP_NAME"
KEY_PATH="${CRX_KEY_PATH:-$ROOT_DIR/.crx-key.pem}"

mkdir -p "$DIST_DIR"
rm -f "$CRX_PATH" "$ZIP_PATH"

if [[ -n "${CRX_PRIVATE_KEY_B64:-}" ]]; then
  node -e 'const fs=require("node:fs"); fs.writeFileSync(process.argv[1], Buffer.from(process.env.CRX_PRIVATE_KEY_B64, "base64"));' "$KEY_PATH"
elif [[ -n "${CRX_PRIVATE_KEY:-}" ]]; then
  printf '%s' "${CRX_PRIVATE_KEY}" > "$KEY_PATH"
fi

(
  cd "$ROOT_DIR"
  npx crx3 -p "$KEY_PATH" -o "$CRX_PATH" -z "$ZIP_PATH" -- manifest.json src icons sounds
)

echo "Packed extension at: $CRX_PATH"
echo "Extension zip at: $ZIP_PATH"
