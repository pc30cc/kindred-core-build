#!/bin/zsh
# Publishes a Webyar for Mac update from this Mac to pc30cc/mac-os, the
# public repository the installed apps update from:
#
#   appcast.xml                    Sparkle's feed (SUFeedURL, and the default
#                                  appcast in Super Admin → macOS app)
#   releases/<version>/Webyar-<version>.zip   what Sparkle downloads
#   releases/<version>/Webyar-<version>.dmg   what a person downloads
#   releases/<version>/item.xml    this version's appcast entry
#
#   scripts/release-local.sh <version> <build> [stable|beta] ["release notes"]
#   e.g. scripts/release-local.sh 1.0.1 2 stable "Faster inbox, fixes."
#
# The build number must grow with every release: Sparkle compares it.
# Updates are signed with the EdDSA key generate_keys keeps in this Mac's
# Keychain; its public half is SPARKLE_PUBLIC_KEY in project.yml. The app is
# signed ad hoc (no Developer ID here), so a person opening the DMG for the
# first time right-clicks → Open once; updates through Sparkle need nothing.
# A Developer ID build with notarization is the CI's job (mac-v* tags).
set -euo pipefail

VERSION="${1:?version, e.g. 1.0.1}"
BUILD="${2:?build number, e.g. 2 — must grow with every release}"
CHANNEL="${3:-stable}"
NOTES="${4:-}"
[[ "$VERSION" =~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' ]] || { echo "version must look like 1.0.1"; exit 1; }
[[ "$BUILD" =~ '^[0-9]+$' ]] || { echo "build must be a number"; exit 1; }
[[ "$CHANNEL" == stable || "$CHANNEL" == beta ]] || { echo "channel is stable or beta"; exit 1; }

FEED_DIR="${WEBYAR_FEED_DIR:-$HOME/dev/mac-os}"

cd "$(dirname "$0")/.."
command -v xcodegen >/dev/null || { echo "brew install xcodegen"; exit 1; }

# 1. Build — Release, ad hoc, without the hardened runtime (see install-local.sh).
xcodegen -q
xcodebuild -project Webyar.xcodeproj -scheme Webyar -configuration Release \
  -derivedDataPath build/release ENABLE_HARDENED_RUNTIME=NO CODE_SIGN_IDENTITY=- \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" \
  build -quiet
APP="build/release/Build/Products/Release/Webyar.app"
built=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist")
[[ "$built" == "$VERSION" ]] || { echo "built $built, expected $VERSION"; exit 1; }
key=$(/usr/libexec/PlistBuddy -c "Print :SUPublicEDKey" "$APP/Contents/Info.plist" 2>/dev/null || true)
[[ -n "$key" ]] || { echo "SUPublicEDKey is empty: the installed apps could not verify this update"; exit 1; }

# 2. Package — a zip for Sparkle, a DMG for people.
OUT="build/release/out/$VERSION"
rm -rf "$OUT" && mkdir -p "$OUT/dmg"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/Webyar-$VERSION.zip"
ditto "$APP" "$OUT/dmg/Webyar.app"
ln -s /Applications "$OUT/dmg/Applications"
hdiutil create -quiet -volname "Webyar $VERSION" -srcfolder "$OUT/dmg" -ov -format UDZO "$OUT/Webyar-$VERSION.dmg"
rm -rf "$OUT/dmg"

# 3. Sign the update with the Keychain's EdDSA key.
SPARKLE_BIN=$(find build/release/SourcePackages -path '*artifacts/sparkle/Sparkle/bin' -type d | head -1)
[[ -n "$SPARKLE_BIN" ]] || { echo "Sparkle tools not found"; exit 1; }
SIG=$("$SPARKLE_BIN/sign_update" "$OUT/Webyar-$VERSION.zip")   # sparkle:edSignature="…" length="…"

# 4. Publish to the feed repository.
FEED_DIR="$FEED_DIR" scripts/publish-feed.sh "$VERSION" "$BUILD" "$CHANNEL" \
  "$OUT/Webyar-$VERSION.zip" "$OUT/Webyar-$VERSION.dmg" "$SIG" "$NOTES"
echo "Next: Super Admin → macOS app → Updates: set the latest version to $VERSION, and the DMG link to"
echo "  https://raw.githubusercontent.com/pc30cc/mac-os/main/releases/$VERSION/Webyar-$VERSION.dmg"
