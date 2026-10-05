#!/bin/sh
# Render apple/App/Assets.xcassets/AppIcon.appiconset from the ContextMint
# Bridge icon masters in chrischall/nullnet-design-system. The masters are the
# source of truth (CLAUDE.md §Icons): this copies them and downscales, it never
# draws. To change the icon, change it in the design system, then re-run:
#
#   apple/tools/make-app-icons.sh <dir holding the two masters>
#
# where the directory holds, from the design system's system/assets/:
#   contextmint-bridge-icon-1024.png        iOS: opaque sRGB, square corners
#                                           (iOS applies its own mask; an
#                                           icon with alpha is rejected by
#                                           App Store Connect after upload)
#   contextmint-bridge-icon-macos-1024.png  macOS: the tile on Apple's grid,
#                                           transparent margin
#
# Then update the two SHA-256 pins in tests/apple-project.test.ts. macOS only
# (sips ships with it).
set -eu

SRC=${1:?usage: make-app-icons.sh <dir with the design-system masters>}
HERE=$(cd "$(dirname "$0")" && pwd)
SET="$HERE/../App/Assets.xcassets/AppIcon.appiconset"
IOS="$SRC/contextmint-bridge-icon-1024.png"
MAC="$SRC/contextmint-bridge-icon-macos-1024.png"
for f in "$IOS" "$MAC"; do
  [ -f "$f" ] || { echo "error: $f is missing" >&2; exit 1; }
done

rm -rf "$SET"
mkdir -p "$SET"
cp "$IOS" "$SET/icon-ios-1024.png"
cp "$MAC" "$SET/icon_512x512@2x.png"
for points in 16 32 128 256 512; do
  for scale in 1 2; do
    px=$((points * scale))
    name="icon_${points}x${points}"
    [ "$scale" -eq 2 ] && name="${name}@2x"
    [ "$px" -eq 1024 ] && continue
    sips -z "$px" "$px" "$MAC" --out "$SET/$name.png" >/dev/null
  done
done

cat > "$SET/Contents.json" <<'JSON'
{
  "images" : [
    { "filename" : "icon-ios-1024.png", "idiom" : "universal", "platform" : "ios", "size" : "1024x1024" },
    { "filename" : "icon_16x16.png", "idiom" : "mac", "scale" : "1x", "size" : "16x16" },
    { "filename" : "icon_16x16@2x.png", "idiom" : "mac", "scale" : "2x", "size" : "16x16" },
    { "filename" : "icon_32x32.png", "idiom" : "mac", "scale" : "1x", "size" : "32x32" },
    { "filename" : "icon_32x32@2x.png", "idiom" : "mac", "scale" : "2x", "size" : "32x32" },
    { "filename" : "icon_128x128.png", "idiom" : "mac", "scale" : "1x", "size" : "128x128" },
    { "filename" : "icon_128x128@2x.png", "idiom" : "mac", "scale" : "2x", "size" : "128x128" },
    { "filename" : "icon_256x256.png", "idiom" : "mac", "scale" : "1x", "size" : "256x256" },
    { "filename" : "icon_256x256@2x.png", "idiom" : "mac", "scale" : "2x", "size" : "256x256" },
    { "filename" : "icon_512x512.png", "idiom" : "mac", "scale" : "1x", "size" : "512x512" },
    { "filename" : "icon_512x512@2x.png", "idiom" : "mac", "scale" : "2x", "size" : "512x512" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
JSON
echo "Wrote $SET"
