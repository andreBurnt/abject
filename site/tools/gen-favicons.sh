#!/usr/bin/env bash
# Regenerate the raster icons from public/favicon.svg.
#
# Browsers request /favicon.ico and /apple-touch-icon*.png by convention even
# when the HTML only advertises an SVG icon, so the rasters ship alongside it
# rather than being generated at build time. They change about as often as the
# logo does, which is to say almost never, so they live in public/ and this
# script exists for the day the SVG changes.
#
#   ./tools/gen-favicons.sh      (from the site/ directory)
#
# Needs inkscape (renders the SVG text correctly) and ImageMagick.

set -euo pipefail

cd "$(dirname "$0")/.."
SRC=public/favicon.svg
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

for tool in inkscape magick; do
    command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done

for size in 16 32 48 180; do
    inkscape -w "$size" -h "$size" "$SRC" -o "$TMP/icon-$size.png" >/dev/null 2>&1
done

magick "$TMP/icon-16.png" "$TMP/icon-32.png" "$TMP/icon-48.png" public/favicon.ico
cp "$TMP/icon-180.png" public/apple-touch-icon.png
cp "$TMP/icon-180.png" public/apple-touch-icon-precomposed.png

echo "regenerated from $SRC:"
ls -la public/favicon.ico public/apple-touch-icon.png public/apple-touch-icon-precomposed.png
