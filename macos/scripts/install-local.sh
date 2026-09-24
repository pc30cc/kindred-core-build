#!/bin/zsh
# Builds a Release copy on this Mac and installs it in ~/Applications.
#
# Signed ad hoc and without the hardened runtime: under the hardened runtime
# an ad hoc app may not load LiveKit's vendor-signed WebRTC framework. The
# Developer ID build in CI (.github/workflows/macos.yml) keeps the hardened
# runtime, as notarization requires.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v xcodegen >/dev/null || { echo "brew install xcodegen"; exit 1; }
xcodegen -q
xcodebuild -project Webyar.xcodeproj -scheme Webyar -configuration Release \
  -derivedDataPath build/local ENABLE_HARDENED_RUNTIME=NO CODE_SIGN_IDENTITY=- \
  build -quiet
osascript -e 'quit app id "com.webyar.mac"' 2>/dev/null || true
mkdir -p ~/Applications
rm -rf ~/Applications/Webyar.app
ditto build/local/Build/Products/Release/Webyar.app ~/Applications/Webyar.app
open ~/Applications/Webyar.app
echo "Installed ~/Applications/Webyar.app"
