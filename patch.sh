#!/bin/bash
# Build a patched copy of eyeREST next to this script.
#   ./patch.sh [source app]        (default: /Applications/eyeREST.app)
# Then install it with ./install.sh
set -euo pipefail
cd "$(dirname "$0")"

SRC="${1:-/Applications/eyeREST.app}"
OUT="eyeREST.app"
BIN="$OUT/Contents/MacOS/eyerest"

[ -d "$SRC" ] || { echo "No app at $SRC"; exit 1; }
if otool -arch arm64 -L "$SRC/Contents/MacOS/eyerest" | grep -q libfsaux; then
    echo "$SRC is already patched; pass an unpatched copy (e.g. eyeREST.app.orig)"; exit 1
fi

if [ "$(cd "$SRC" && pwd -P)" != "$(pwd -P)/eyeREST.app.orig" ]; then
    echo "==> Backing up original to eyeREST.app.orig"
    rm -rf eyeREST.app.orig && ditto "$SRC" eyeREST.app.orig
fi

echo "==> Compiling libfsaux.dylib"
clang -arch arm64 -arch x86_64 -mmacosx-version-min=10.13 -dynamiclib -fobjc-arc \
    -framework AppKit -framework WebKit -framework ServiceManagement -install_name @executable_path/libfsaux.dylib \
    -o libfsaux.dylib fsaux.m

echo "==> Building patched $OUT"
rm -rf "$OUT" && ditto "$SRC" "$OUT" && chmod -R u+w "$OUT"
codesign --remove-signature "$BIN"
python3 insert_dylib.py "$BIN" @executable_path/libfsaux.dylib
cp libfsaux.dylib "$OUT/Contents/MacOS/"
cp fsaux-inject.js "$OUT/Contents/Resources/"
mkdir -p "$OUT/Contents/Library/LaunchAgents"
cp com.vinlemon.eyeREST.fsaux-autostart.plist "$OUT/Contents/Library/LaunchAgents/"
plutil -replace LSUIElement -bool YES "$OUT/Contents/Info.plist"
rm -rf "$OUT/Contents/_MASReceipt"

echo "==> Ad-hoc signing"
codesign -f -s - "$OUT/Contents/MacOS/libfsaux.dylib"
codesign -f -s - --entitlements ents.plist "$OUT"
codesign -vv "$OUT"

echo "Done. Install with: ./install.sh"
