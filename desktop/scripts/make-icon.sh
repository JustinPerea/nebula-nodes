#!/bin/sh
# Build the Nebula app icon from the Nebula mark (frontend/public/favicon.svg).
#
# Uses only macOS built-ins: sips rasterizes the SVG at each size and
# iconutil packs the .iconset into an .icns. Writes:
#   desktop/build/icon.icns  bundle icon for `npm run package`
#   desktop/build/icon.png   1024 px PNG for the Dock icon in `npm run start`
# Both are committed, so packaging never needs this script. Re-run it only
# when the favicon changes:  cd desktop && npm run make-icon
#
# The mark is a full-bleed rounded square. macOS app icons sit inside a
# 1024 canvas with roughly 100 px of transparent margin (an 824 px body), so
# the SVG viewBox is widened by 100/824 of its size on each side instead of
# rendering edge to edge, which would look oversized next to other Dock icons.
set -eu

DESKTOP_DIR=$(cd "$(dirname "$0")/.." && pwd)
SOURCE="$DESKTOP_DIR/../frontend/public/favicon.svg"
OUT_DIR="$DESKTOP_DIR/build"

[ "$(uname)" = "Darwin" ] || { echo "make-icon: macOS only (needs sips and iconutil)" >&2; exit 1; }
[ -f "$SOURCE" ] || { echo "make-icon: missing $SOURCE" >&2; exit 1; }
head -1 "$SOURCE" | grep -q 'viewBox="0 0 200 200" width="200" height="200"' || {
  echo "make-icon: expected the favicon to open with viewBox=\"0 0 200 200\" width=\"200\" height=\"200\"; update this script" >&2
  exit 1
}

WORK=$(mktemp -d "${TMPDIR:-/tmp}/nebula-icon.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
ICONSET="$WORK/Nebula.iconset"
mkdir -p "$ICONSET" "$OUT_DIR"

# 200 * 100/824 = 24.2718 units of margin per side; 200 + 2 * 24.2718 = 248.5437.
render() { # $1 = pixel size, $2 = output png
  sed -E "1s#viewBox=\"0 0 200 200\" width=\"200\" height=\"200\"#viewBox=\"-24.2718 -24.2718 248.5437 248.5437\" width=\"$1\" height=\"$1\"#" \
    "$SOURCE" > "$WORK/mark-$1.svg"
  sips -s format png "$WORK/mark-$1.svg" --out "$2" >/dev/null
  actual=$(sips -g pixelWidth "$2" | awk '/pixelWidth/ {print $2}')
  [ "$actual" = "$1" ] || { echo "make-icon: sips rendered ${actual}px, wanted $1px" >&2; exit 1; }
}

for size in 16 32 128 256 512; do
  render "$size" "$ICONSET/icon_${size}x${size}.png"
  render $((size * 2)) "$ICONSET/icon_${size}x${size}@2x.png"
done

iconutil -c icns "$ICONSET" -o "$OUT_DIR/icon.icns"
cp "$ICONSET/icon_512x512@2x.png" "$OUT_DIR/icon.png"
echo "make-icon: wrote $OUT_DIR/icon.icns and $OUT_DIR/icon.png"
