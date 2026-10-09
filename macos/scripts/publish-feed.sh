#!/bin/zsh
# Adds one version to a brand's Mac update feed and pushes it: the zip and
# DMG under releases/<version>/, that version's appcast entry, and
# appcast.xml rebuilt from every entry, newest build first. WebYar's feed is
# pc30cc/mac-os (at its root), RESPOK's is pc30cc/respok-releases (under
# mac/); see brand.sh. Shared by release-local.sh (ad hoc, from a Mac) and
# the CI's release (.github/workflows/macos.yml), so the feed has one shape
# either way.
#
#   BRAND=<Webyar|Respok> FEED_DIR=<clone of the feed repository> publish-feed.sh \
#     <version> <build> <stable|beta> <zip> <dmg> '<sign_update output>' [notes]
set -euo pipefail
source "${0:A:h}/brand.sh"

VERSION="$1"; BUILD="$2"; CHANNEL="$3"; ZIP="$4"; DMG="$5"; SIG="$6"; NOTES="${7:-}"
FEED_DIR="${FEED_DIR:?FEED_DIR: a clone of $FEED_REPO}"
RAW="$FEED_RAW"
[[ "$SIG" == *edSignature=* ]] || { echo "not a sign_update signature: $SIG"; exit 1; }

if [[ ! -d "$FEED_DIR/.git" ]]; then git clone "https://github.com/$FEED_REPO" "$FEED_DIR"; fi
git -C "$FEED_DIR" pull -q --rebase origin main 2>/dev/null || true
ROOT="$FEED_DIR${FEED_SUBDIR:+/$FEED_SUBDIR}"
DEST="$ROOT/releases/$VERSION"
mkdir -p "$DEST"
cp "$ZIP" "$DEST/$FILE_PREFIX-$VERSION.zip"
cp "$DMG" "$DEST/$FILE_PREFIX-$VERSION.dmg"

escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
{
  echo "    <item>"
  echo "      <title>$APP_NAME $VERSION</title>"
  echo "      <pubDate>$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')</pubDate>"
  echo "      <sparkle:version>$BUILD</sparkle:version>"
  echo "      <sparkle:shortVersionString>$VERSION</sparkle:shortVersionString>"
  echo "      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>"
  if [[ "$CHANNEL" == beta ]]; then echo "      <sparkle:channel>beta</sparkle:channel>"; fi
  if [[ -n "$NOTES" ]]; then echo "      <description>$(print -r -- "$NOTES" | escape)</description>"; fi
  echo "      <enclosure url=\"$RAW/releases/$VERSION/$FILE_PREFIX-$VERSION.zip\" type=\"application/octet-stream\" $SIG />"
  echo "    </item>"
} > "$DEST/item.xml"
print -r -- "$BUILD" > "$DEST/build"

{
  echo '<?xml version="1.0" encoding="utf-8"?>'
  echo '<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">'
  echo '  <channel>'
  echo "    <title>$FEED_TITLE</title>"
  echo "    <link>$RAW/appcast.xml</link>"
  for d in $(for b in "$ROOT"/releases/*/build; do print -r -- "$(cat "$b") ${b:h}"; done | sort -rn | cut -d' ' -f2-); do
    cat "$d/item.xml"
  done
  echo '  </channel>'
  echo '</rss>'
} > "$ROOT/appcast.xml"
xmllint --noout "$ROOT/appcast.xml"

PREFIX="${FEED_SUBDIR:+$FEED_SUBDIR/}"
git -C "$FEED_DIR" add "${PREFIX}appcast.xml" "${PREFIX}releases/$VERSION"
git -C "$FEED_DIR" commit -q -m "$FEED_TITLE $VERSION ($BUILD, $CHANNEL)"
git -C "$FEED_DIR" push -q origin HEAD:main

echo "Published $APP_NAME $VERSION ($BUILD, $CHANNEL)"
echo "  appcast  $RAW/appcast.xml"
echo "  DMG      $RAW/releases/$VERSION/$FILE_PREFIX-$VERSION.dmg"
