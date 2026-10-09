#!/bin/zsh
# Publishes a Mac update from this Mac to the brand's feed repository, the
# public repository the installed apps update from (BRAND=Webyar, the
# default: pc30cc/mac-os; BRAND=Respok: pc30cc/respok-releases under mac/;
# see brand.sh). Run it once per brand to release both:
#
#   appcast.xml                    Sparkle's feed — the default appcast in
#                                  Super Admin → macOS app, which tells the apps
#   releases/<version>/Webyar-<version>.zip   what Sparkle downloads
#   releases/<version>/Webyar-<version>.dmg   what a person downloads
#   releases/<version>/item.xml    this version's appcast entry
#
#   [BRAND=Respok] scripts/release-local.sh <version> <build> [stable|beta] ["release notes"]
#   e.g. scripts/release-local.sh 1.0.1 2 stable "Faster inbox, fixes."
#
# Merges to main already publish both brands from CI (.github/workflows/macos.yml);
# this is for a release from a Mac.
#
# The build number must grow with every release: Sparkle compares it.
# Updates are signed with the EdDSA key generate_keys keeps in this Mac's
# Keychain; its public half is SPARKLE_PUBLIC_KEY in project.yml. The app is
# signed ad hoc (no Developer ID here), so a person opening the DMG for the
# first time right-clicks → Open once; updates through Sparkle need nothing.
# A Developer ID build with notarization is the CI's job (every merge to main).
# The CI numbers its builds 100 + run number: a local release needs a higher one.
set -euo pipefail

VERSION="${1:?version, e.g. 1.0.1}"
BUILD="${2:?build number, e.g. 2 — must grow with every release}"
CHANNEL="${3:-stable}"
NOTES="${4:-}"
[[ "$VERSION" =~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' ]] || { echo "version must look like 1.0.1"; exit 1; }
[[ "$BUILD" =~ '^[0-9]+$' ]] || { echo "build must be a number"; exit 1; }
[[ "$CHANNEL" == stable || "$CHANNEL" == beta ]] || { echo "channel is stable or beta"; exit 1; }

source "${0:A:h}/brand.sh"
if [[ "$BRAND" == Webyar ]]; then FEED_DIR="${WEBYAR_FEED_DIR:-$HOME/dev/mac-os}"; else FEED_DIR="${RESPOK_FEED_DIR:-$HOME/dev/respok-releases}"; fi

cd "$(dirname "$0")/.."
command -v xcodegen >/dev/null || { echo "brew install xcodegen"; exit 1; }

# 1. Build — Release, ad hoc, without the hardened runtime (see install-local.sh).
xcodegen -q
xcodebuild -project Webyar.xcodeproj -scheme "$SCHEME" -configuration Release \
  -derivedDataPath build/release ENABLE_HARDENED_RUNTIME=NO CODE_SIGN_IDENTITY=- \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" \
  build -quiet
APP="build/release/Build/Products/Release/$APP_NAME.app"
built=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist")
[[ "$built" == "$VERSION" ]] || { echo "built $built, expected $VERSION"; exit 1; }
key=$(/usr/libexec/PlistBuddy -c "Print :SUPublicEDKey" "$APP/Contents/Info.plist" 2>/dev/null || true)
[[ -n "$key" ]] || { echo "SUPublicEDKey is empty: the installed apps could not verify this update"; exit 1; }

# 2. Package — a zip for Sparkle, a DMG for people.
OUT="build/release/out/$BRAND/$VERSION"
rm -rf "$OUT" && mkdir -p "$OUT/dmg"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/$FILE_PREFIX-$VERSION.zip"
ditto "$APP" "$OUT/dmg/$APP_NAME.app"
ln -s /Applications "$OUT/dmg/Applications"
hdiutil create -quiet -volname "$APP_NAME $VERSION" -srcfolder "$OUT/dmg" -ov -format UDZO "$OUT/$FILE_PREFIX-$VERSION.dmg"
rm -rf "$OUT/dmg"

# 3. Sign the update with the Keychain's EdDSA key.
SPARKLE_BIN=$(find build/release/SourcePackages -path '*artifacts/sparkle/Sparkle/bin' -type d | head -1)
[[ -n "$SPARKLE_BIN" ]] || { echo "Sparkle tools not found"; exit 1; }
SIG=$("$SPARKLE_BIN/sign_update" "$OUT/$FILE_PREFIX-$VERSION.zip")   # sparkle:edSignature="…" length="…"

# 4. Publish to the feed repository.
BRAND="$BRAND" FEED_DIR="$FEED_DIR" scripts/publish-feed.sh "$VERSION" "$BUILD" "$CHANNEL" \
  "$OUT/$FILE_PREFIX-$VERSION.zip" "$OUT/$FILE_PREFIX-$VERSION.dmg" "$SIG" "$NOTES"
echo "Next: Super Admin → macOS app → Updates on the $BRAND platform: set the latest version to $VERSION."
echo "The site's download (/downloads/$FILE_PREFIX-Mac.zip) follows the feed by itself (deploy/app-downloads)."
