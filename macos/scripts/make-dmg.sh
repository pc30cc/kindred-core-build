#!/bin/zsh
# The installer people download from the website: one Universal app (Apple
# Silicon and Intel, macOS 14 or later) in a DMG whose window shows the app,
# an arrow and the Applications folder over the brand's own background.
#
#   [BRAND=Respok] scripts/make-dmg.sh <version> <build>      e.g. scripts/make-dmg.sh 1.0.2 3
#
# Signed ad hoc: without a Developer ID certificate macOS asks once, on first
# open, to allow it (the window says how). With one in the keychain, pass
# WEBYAR_SIGN="Developer ID Application", WEBYAR_TEAM_ID=<team> and
# WEBYAR_NOTARY_PROFILE=<profile> to sign, notarize and staple instead.
set -euo pipefail

VERSION="${1:?version, e.g. 1.0.2}"
BUILD="${2:?build number, e.g. 3}"
SIGN="${WEBYAR_SIGN:--}"
source "${0:A:h}/brand.sh"
cd "$(dirname "$0")/.."
command -v xcodegen >/dev/null || { echo "brew install xcodegen"; exit 1; }

# 1. A Universal Release build.
xcodegen -q
if [[ "$SIGN" == "-" ]]; then
  SIGNING=(ENABLE_HARDENED_RUNTIME=NO CODE_SIGN_IDENTITY=-)
else
  SIGNING=(CODE_SIGN_IDENTITY="$SIGN" DEVELOPMENT_TEAM="${WEBYAR_TEAM_ID:-}" OTHER_CODE_SIGN_FLAGS=--timestamp)
fi
xcodebuild -project Webyar.xcodeproj -scheme "$SCHEME" -configuration Release \
  -derivedDataPath build/universal ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" "${SIGNING[@]}" \
  build -quiet
APP="build/universal/Build/Products/Release/$APP_NAME.app"
archs=$(lipo -archs "$APP/Contents/MacOS/$APP_NAME")
if [[ "$SIGN" != "-" ]]; then
  # A plain build re-signs Sparkle.framework but not the helpers inside it, which keep
  # Sparkle's own ad hoc signature and fail notarization. Sign them as Sparkle documents
  # (innermost first), then the framework and the app again, keeping the app's entitlements.
  SP="$APP/Contents/Frameworks/Sparkle.framework"
  CS=(codesign -f -s "$SIGN" -o runtime --timestamp)
  "${CS[@]}" "$SP/Versions/B/XPCServices/Installer.xpc"
  "${CS[@]}" --preserve-metadata=entitlements "$SP/Versions/B/XPCServices/Downloader.xpc"
  "${CS[@]}" "$SP/Versions/B/Autoupdate"
  "${CS[@]}" "$SP/Versions/B/Updater.app"
  "${CS[@]}" "$SP"
  "${CS[@]}" --preserve-metadata=entitlements,requirements,flags "$APP"
fi
[[ "$archs" == *arm64* && "$archs" == *x86_64* ]] || { echo "not universal: $archs"; exit 1; }
codesign --verify --deep --strict "$APP"

# 2. The window's background, at 1x and 2x in one TIFF.
OUT="build/dmg/$BRAND"
rm -rf "$OUT" && mkdir -p "$OUT"
BRAND="$BRAND" swift scripts/dmg/background.swift "$OUT"
tiffutil -cathidpicheck "$OUT/background.png" "$OUT/background@2x.png" -out "$OUT/background.tiff" >/dev/null

# 3. The DMG (dmgbuild writes the window layout without driving Finder).
# In a venv of its own under build/: nothing is installed into the Mac's Python.
PY="build/dmgenv/bin/python3"
[[ -x "$PY" ]] || python3 -m venv build/dmgenv
"$PY" -c "import dmgbuild" 2>/dev/null || "$PY" -m pip install --quiet dmgbuild
DMG="$OUT/$FILE_PREFIX-$VERSION.dmg"
ICON=()
[[ -f "$APP/Contents/Resources/AppIcon.icns" ]] && ICON=(-D icon="$APP/Contents/Resources/AppIcon.icns")
"$PY" -m dmgbuild -s scripts/dmg/settings.py \
  -D app="$APP" -D background="$OUT/background.tiff" "${ICON[@]}" \
  "$APP_NAME $VERSION" "$DMG"

if [[ "$SIGN" != "-" ]]; then
  codesign --sign "$SIGN" --timestamp "$DMG"
  xcrun notarytool submit "$DMG" --keychain-profile "${WEBYAR_NOTARY_PROFILE:?notary keychain profile}" --wait
  xcrun stapler staple "$DMG"
fi
echo "$DMG ($archs)"
