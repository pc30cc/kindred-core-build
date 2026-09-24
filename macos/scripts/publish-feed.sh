#!/bin/zsh
# Adds one version to the Webyar for Mac update feed (pc30cc/mac-os) and
# pushes it: the zip and DMG under releases/<version>/, that version's
# appcast entry, and appcast.xml rebuilt from every entry, newest build first.
# Shared by release-local.sh (ad hoc, from a Mac) and the CI's mac-v* tag
# release (Developer ID, notarized), so the feed has one shape either way.
#
#   FEED_DIR=<clone of pc30cc/mac-os> publish-feed.sh \
#     <version> <build> <stable|beta> <zip> <dmg> '<sign_update output>' [notes]
set -euo pipefail

VERSION="$1"; BUILD="$2"; CHANNEL="$3"; ZIP="$4"; DMG="$5"; SIG="$6"; NOTES="${7:-}"
FEED_DIR="${FEED_DIR:?FEED_DIR: a clone of pc30cc/mac-os}"
RAW="https://raw.githubusercontent.com/pc30cc/mac-os/main"
[[ "$SIG" == *edSignature=* ]] || { echo "not a sign_update signature: $SIG"; exit 1; }

if [[ ! -d "$FEED_DIR/.git" ]]; then git clone https://github.com/pc30cc/mac-os "$FEED_DIR"; fi
git -C "$FEED_DIR" pull -q --rebase origin main
DEST="$FEED_DIR/releases/$VERSION"
mkdir -p "$DEST"
cp "$ZIP" "$DEST/Webyar-$VERSION.zip"
cp "$DMG" "$DEST/Webyar-$VERSION.dmg"

escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
{
  echo "    <item>"
  echo "      <title>Webyar $VERSION</title>"
  echo "      <pubDate>$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')</pubDate>"
  echo "      <sparkle:version>$BUILD</sparkle:version>"
  echo "      <sparkle:shortVersionString>$VERSION</sparkle:shortVersionString>"
  echo "      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>"
  if [[ "$CHANNEL" == beta ]]; then echo "      <sparkle:channel>beta</sparkle:channel>"; fi
  if [[ -n "$NOTES" ]]; then echo "      <description>$(print -r -- "$NOTES" | escape)</description>"; fi
  echo "      <enclosure url=\"$RAW/releases/$VERSION/Webyar-$VERSION.zip\" type=\"application/octet-stream\" $SIG />"
  echo "    </item>"
} > "$DEST/item.xml"
print -r -- "$BUILD" > "$DEST/build"

{
  echo '<?xml version="1.0" encoding="utf-8"?>'
  echo '<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">'
  echo '  <channel>'
  echo '    <title>Webyar for Mac</title>'
  echo "    <link>$RAW/appcast.xml</link>"
  for d in $(for b in "$FEED_DIR"/releases/*/build; do print -r -- "$(cat "$b") ${b:h}"; done | sort -rn | cut -d' ' -f2-); do
    cat "$d/item.xml"
  done
  echo '  </channel>'
  echo '</rss>'
} > "$FEED_DIR/appcast.xml"
xmllint --noout "$FEED_DIR/appcast.xml"

git -C "$FEED_DIR" add appcast.xml "releases/$VERSION"
git -C "$FEED_DIR" commit -q -m "Webyar for Mac $VERSION ($BUILD, $CHANNEL)"
git -C "$FEED_DIR" push -q origin HEAD:main

echo "Published Webyar $VERSION ($BUILD, $CHANNEL)"
echo "  appcast  $RAW/appcast.xml"
echo "  DMG      $RAW/releases/$VERSION/Webyar-$VERSION.dmg"
