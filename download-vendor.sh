#!/usr/bin/env bash
# download-vendor.sh — Download and vendorize external frontend assets.
# Run this script to populate the vendor/ directory.
# To upgrade a dependency, update the version variable below and re-run.
set -euo pipefail

# ── Versions ────────────────────────────────────────────────────────────────
CODEMIRROR_VERSION="5.65.18"
MARKED_VERSION="15.0.7"  # check https://www.jsdelivr.com/package/npm/marked

# Google Fonts — update the URL parameters to change font weights/variants.
GOOGLE_FONTS_URL="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..900;1,9..144,300..900&family=Lora:ital,wght@0,400..700;1,400..700&display=swap"

# ── Setup ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$SCRIPT_DIR/vendor"

mkdir -p \
    "$VENDOR/codemirror/theme" \
    "$VENDOR/codemirror/mode/xml" \
    "$VENDOR/codemirror/mode/markdown" \
    "$VENDOR/fonts"

download() {
    local url="$1"
    local dest="$2"
    echo "  Downloading $(basename "$dest")..."
    curl -fsSL "$url" -o "$dest"
}

# ── CodeMirror ───────────────────────────────────────────────────────────────
echo "CodeMirror $CODEMIRROR_VERSION"
CM_BASE="https://cdnjs.cloudflare.com/ajax/libs/codemirror/$CODEMIRROR_VERSION"
download "$CM_BASE/codemirror.min.css"               "$VENDOR/codemirror/codemirror.min.css"
download "$CM_BASE/theme/dracula.min.css"             "$VENDOR/codemirror/theme/dracula.min.css"
download "$CM_BASE/codemirror.min.js"                 "$VENDOR/codemirror/codemirror.min.js"
download "$CM_BASE/mode/xml/xml.min.js"               "$VENDOR/codemirror/mode/xml/xml.min.js"
download "$CM_BASE/mode/markdown/markdown.min.js"     "$VENDOR/codemirror/mode/markdown/markdown.min.js"

# ── marked.js ────────────────────────────────────────────────────────────────
echo "marked $MARKED_VERSION"
download "https://cdn.jsdelivr.net/npm/marked@$MARKED_VERSION/marked.min.js" "$VENDOR/marked.min.js"

# ── Google Fonts ──────────────────────────────────────────────────────────────
# Use a modern browser UA so the API returns woff2 (smallest/best format).
echo "Google Fonts (Fraunces + Lora)"
FONTS_CSS=$(curl -fsSL -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36" "$GOOGLE_FONTS_URL")

# Download each woff2 file referenced in the CSS; replace remote URLs with local ones.
LOCAL_CSS="$FONTS_CSS"
while IFS= read -r font_url; do
    filename=$(echo "$font_url" | md5sum | cut -d' ' -f1).woff2
    echo "  Downloading font $filename..."
    curl -fsSL "$font_url" -o "$VENDOR/fonts/$filename"
    LOCAL_CSS="${LOCAL_CSS//$font_url/./$filename}"
done < <(echo "$FONTS_CSS" | grep -oP 'https://fonts\.gstatic\.com[^)]+')

echo "$LOCAL_CSS" > "$VENDOR/fonts/fonts.css"

echo ""
echo "Done. Vendor assets written to: $VENDOR"
