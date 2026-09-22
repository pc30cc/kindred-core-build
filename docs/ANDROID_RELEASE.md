# Releasing the Android app

Everything here is about the difference between a build that runs and a build
that can be *published*. They are not the same thing, and the gap is mostly
made of things that fail late.

## The one artifact Play accepts

A new app cannot be uploaded to Play as an APK. It has to be an **App
Bundle** — `.aab` — and Play builds the per-device APKs itself.

```sh
./gradlew :app:bundleRelease -Pwebyar.versionCode=2 -Pwebyar.versionName=1.0.1
# → app/build/outputs/bundle/release/app-release.aab
```

`assembleRelease` still exists and still produces the five split APKs. Those
are for sideloading, for handing somebody a build to try, and for CI. They are
not what goes to Play.

### Why the two cannot both be configured

`splits.abi` makes five APKs; a bundle does its own ABI splitting. AGP refuses
to do both, and it refuses *loudly and late* — `buildReleasePreBundle` finds
five shrunk-resource files where it expects one and fails
([issuetracker 402800800](https://issuetracker.google.com/402800800)). So
`splits.abi.isEnable` is off whenever the requested task is a `bundle*` one.
Nothing to remember; it just works out.

A bundle is also the better artifact: Play sends a device exactly the native
code it can run, where five APKs make a person choose, and choosing wrong
means an app that installs and then cannot start a call.

## Version numbers

```
versionCode  -Pwebyar.versionCode  or  WEBYAR_VERSION_CODE   (default 1)
versionName  -Pwebyar.versionName  or  WEBYAR_VERSION_NAME   (default 0.1.0)
```

Play refuses a `versionCode` it has already seen and it never forgets one, so
this cannot live only in `build.gradle.kts`: a hotfix would mean editing
source to ship, and two releases cut from one commit would collide. Pass it
from whatever drives the release.

The property wins over the environment variable, which is the order somebody
debugging a wrong version number expects.

## The signing key

**This is the part that cannot be undone.** Play ties the app's identity to
one key for as long as the app exists.

- Lose it → you can never update the app again. Not "with difficulty": never.
  The remedy is a new listing, a new package name, and none of the installs.
- Leak it → somebody else can sign an update to your app.

Create it once:

```sh
cd android && ./tools/make-release-keystore.sh
```

The script prompts for the password rather than taking it as an argument —
arguments are visible to every process on the machine (`ps`) and shell history
keeps them for years. It refuses to overwrite an existing keystore.

Then, in the shell that runs Gradle, from a password manager and never from a
file in the repository:

```sh
export WEBYAR_KEYSTORE="$PWD/webyar-release.jks"
export WEBYAR_KEYSTORE_PASSWORD='…'
export WEBYAR_KEY_ALIAS='webyar'
export WEBYAR_KEY_PASSWORD='…'
```

A release build with none of these set produces an **unsigned** artifact. That
is deliberate: an unsigned file cannot be installed by accident, whereas one
signed with a key from the repository can be installed by anybody who has ever
cloned it. `*.jks`, `*.keystore`, `*.p12` and `keystore.properties` are in
`.gitignore` so the file cannot be committed by mistake.

### Check what you are about to upload

```sh
$ANDROID_HOME/build-tools/*/apksigner verify --print-certs \
    app/build/outputs/apk/release/app-arm64-v8a-release.apk
```

An unsigned artifact says so here. Finding that out from Play's rejection
email is the slow way.

## Before you press publish

| | |
|---|---|
| `./gradlew :app:testDebugUnitTest` | unit and Robolectric tests |
| `./gradlew :app:lintDebug` | zero errors, warnings reviewed |
| `./gradlew :app:assembleMinified` | R8's output, installable, **run it** |
| `./gradlew :app:bundleRelease` | the artifact itself |

`assembleMinified` exists because R8 is the difference between the app that
was tested and the app that ships: it renames, inlines and deletes, and a
missing keep rule shows up as an inbox of blank rows rather than as a crash.
It is minified exactly like release and signed with the debug key, so it can
actually be installed and looked at.

## What is still open

- **The app has never run on a physical phone.** Everything on device so far
  was the emulator. A real handset is the one test that catches what an
  emulator cannot: a vendor's keyboard, a notch, a battery optimiser that
  kills the socket, a locale the emulator does not ship.
- `versionCode`/`versionName` still default to `1`/`0.1.0`. Whoever cuts the
  first release decides what they should be.
- There is no Play listing yet: title, description, screenshots, privacy
  policy URL, content rating and a data-safety declaration are all required
  before the first upload is accepted, and none of them are code.
