#!/bin/bash
# Replace /Applications/eyeREST.app with an app from this folder (needs sudo).
#   ./install.sh            installs the patched eyeREST.app
#   ./install.sh restore    reinstalls the original from eyeREST.app.orig
set -euo pipefail
cd "$(dirname "$0")"

APP="eyeREST.app"
[ "${1:-}" = restore ] && APP="eyeREST.app.orig"
[ -d "$APP" ] || { echo "No $APP here; run ./patch.sh first"; exit 1; }

osascript -e 'quit app "eyeREST"' 2>/dev/null || true
pkill -x eyerest 2>/dev/null || true
sudo rm -rf /Applications/eyeREST.app
sudo ditto "$APP" /Applications/eyeREST.app
open /Applications/eyeREST.app
echo "Installed $APP to /Applications/eyeREST.app"
