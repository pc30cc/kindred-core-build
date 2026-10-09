# Sourced by the scripts in this folder: the brand they build and publish.
#
#   BRAND=Webyar (default)  the `Webyar` target, Webyar.app, feed pc30cc/mac-os
#   BRAND=Respok            the `Respok` target, RESPOK.app, feed pc30cc/respok-releases (mac/)
#
# The two apps share every source file (project.yml); only these differ.
BRAND="${BRAND:-Webyar}"
case "$BRAND" in
  Webyar|webyar)
    BRAND=Webyar
    SCHEME=Webyar             # the Xcode target and scheme
    APP_NAME=Webyar           # Webyar.app, its executable
    FILE_PREFIX=Webyar        # Webyar-<version>.zip / .dmg, Webyar-Mac.zip on the site
    BUNDLE_ID=com.webyar.mac
    FEED_REPO=pc30cc/mac-os   # appcast.xml and releases/<version>/ at the repository's root
    FEED_SUBDIR=
    FEED_TITLE="Webyar for Mac"
    ;;
  Respok|respok|RESPOK)
    BRAND=Respok
    SCHEME=Respok
    APP_NAME=RESPOK
    FILE_PREFIX=RESPOK
    BUNDLE_ID=com.respok.mac
    FEED_REPO=pc30cc/respok-releases   # mac/appcast.xml and mac/releases/<version>/
    FEED_SUBDIR=mac
    FEED_TITLE="RESPOK for Mac"
    ;;
  *) echo "BRAND is Webyar or Respok, not $BRAND"; exit 1 ;;
esac
# Where the installed apps read the feed: Super Admin → macOS app → appcast on each platform.
FEED_RAW="https://raw.githubusercontent.com/$FEED_REPO/main${FEED_SUBDIR:+/$FEED_SUBDIR}"
