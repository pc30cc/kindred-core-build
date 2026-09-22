#!/usr/bin/env bash
#
# Creates the release signing key for the Webyar operator app.
#
# Run this ONCE, on a machine you control, and then guard what it produces.
# Play ties an app's identity to this key for as long as the app exists: lose
# it and you cannot update the app ever again, under any circumstances, and
# the only way forward is a new listing with a new package name and none of
# the installs. Leak it and somebody else can sign an update to your app.
#
# The password is read from the terminal, never from an argument and never
# written anywhere. Arguments are visible to every process on the machine
# (`ps`), and shell history keeps them for years.
set -euo pipefail

KEYSTORE="${1:-webyar-release.jks}"
ALIAS="${WEBYAR_KEY_ALIAS:-webyar}"
# 10,000 days ≈ 27 years. Play requires a key valid past 2033, and a key that
# expires is a key you have to replace with all the same pain as losing it.
DAYS=10000

if [[ -e "$KEYSTORE" ]]; then
  echo "refusing to overwrite an existing keystore: $KEYSTORE" >&2
  echo "if you really mean to start over, move the old one aside first." >&2
  exit 1
fi

command -v keytool >/dev/null 2>&1 || {
  echo "keytool is not on PATH — it ships with the JDK." >&2
  echo "try: export PATH=\"\$JAVA_HOME/bin:\$PATH\"" >&2
  exit 1
}

cat <<'WARN'
About to create a release signing key.

  • Keep the file AND the password. Either one alone is useless.
  • Back both up somewhere that survives this machine dying.
  • Never commit the file; never put the password in a script.

WARN

read -r -p "Organisation name (CN), e.g. Webyar: " CN
: "${CN:?a name is required}"

# -storepass is deliberately absent: keytool prompts, and the prompt does not
# echo, land in history, or appear in `ps`.
keytool -genkeypair \
  -keystore "$KEYSTORE" \
  -alias "$ALIAS" \
  -keyalg RSA \
  -keysize 4096 \
  -validity "$DAYS" \
  -dname "CN=$CN" \
  -storetype PKCS12

chmod 600 "$KEYSTORE"

cat <<EOF

Created $KEYSTORE (alias: $ALIAS, RSA 4096, valid $DAYS days).

To build a signed bundle, set these in the shell that runs Gradle — from a
password manager, not from a file in the repository:

  export WEBYAR_KEYSTORE="\$PWD/$KEYSTORE"
  export WEBYAR_KEYSTORE_PASSWORD='…'
  export WEBYAR_KEY_ALIAS='$ALIAS'
  export WEBYAR_KEY_PASSWORD='…'   # same as the store password unless you chose otherwise

  ./gradlew :app:bundleRelease -Pwebyar.versionCode=2 -Pwebyar.versionName=1.0.1

Verify what you are about to upload really is signed with this key:

  \$ANDROID_HOME/build-tools/*/apksigner verify --print-certs \\
      app/build/outputs/apk/release/app-arm64-v8a-release.apk

Back up $KEYSTORE now, before you build anything with it.
EOF
