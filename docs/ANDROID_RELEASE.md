# Releasing the Android app

Everything here is about the difference between a build that runs and a build
that can be *published*. They are not the same thing, and the gap is mostly
made of things that fail late.

## Two apps from one source

`android/` builds two apps, one per brand, from the same code. They are the
two product flavors of `app/build.gradle.kts`, and they install side by side
on one phone:

| | WebYar (`webyar`) | RESPOK (`respok`) |
|---|---|---|
| Edition | Iranian, webyar.ai | International, respok.app |
| Package (applicationId) | `com.webyar.ai` | `com.respok.app` |
| Launcher name | Webyar | RESPOK |
| First request (bootstrap API) | `https://api.webyar.ai` | `https://api.respok.app` |
| Language before anyone picks one | Persian | English |
| Persian dates | Jalali (`fa-IR-u-ca-persian`) | Gregorian in Persian digits (`fa-IR-u-ca-gregory`) |
| API origins the platform may move it to | any https host, as before | only `respok.app` and its subdomains |
| Icons, launch colours, launcher name | `src/webyar/res` (the WebYar brand kit, turquoise) | `src/respok/res` (RESPOK's Thread icon, Signal on Ink) |
| Copy that names the product | `src/webyar/.../i18n/BrandCopy.kt` (+ generated `StringsBrand.kt`) | `src/respok/.../i18n/BrandCopy.kt` |
| Launcher entry | `com.webyar.ai.MainActivity` (an `<activity-alias>`, `src/webyar/AndroidManifest.xml`) | `com.platform.app.MainActivity` (`src/respok/AndroidManifest.xml`) |
| Release key | `WEBYAR_*` | `RESPOK_*` |
| Version | `-Pwebyar.version…` / `WEBYAR_VERSION_…` | `-Prespok.version…` / `RESPOK_VERSION_…` |
| Website APK | `app.webyar.ai/downloads/Webyar-Android.apk` | `app.respok.app/downloads/RESPOK-Android.apk` |

**RESPOK's APK contains nothing that names WebYar** — no class, package,
resource name or value, manifest entry, string, asset, file name or dex
string — and no WebYar art. So the code's package (`namespace`) is
`com.platform.app`, named after neither brand, and `src/main` is
brand-neutral: everything WebYar-specific is in its flavor block of
`app/build.gradle.kts` or in `src/webyar` (icons, launcher name, brand
colours, the copy that names the product, the launcher alias). On a RESPOK
phone the activity is `com.respok.app/com.platform.app.MainActivity`.

`android/tools/check-brand-neutral.sh` proves it: with no argument it checks
the sources (every file under `src/main`, `src/respok`, `src/debug`,
`src/release`, the build scripts outside WebYar's flavor block, the ProGuard
rules and the baseline profile module); given APKs, it reads every entry name
and every entry's bytes (UTF-8 and UTF-16, nested archives too) for WebYar's
name in any spelling (Latin, Persian, its domains), and fails on any entry
byte-identical to a file of `src/webyar`. CI runs it on the sources first, on
RESPOK's debug APK on every run, and on RESPOK's minified APKs when those are
built. WebYar's APK is not checked: it is WebYar.

The brand constants are read through `core/AppBrand.kt`; copy that names the
product through `i18n/BrandStr.kt`, which returns the flavor's own
`BrandCopy`. The strings generator (`scripts/android/strings-from-ios.mjs`)
writes every iOS line that names WebYar into `src/webyar/.../StringsBrand.kt`
rather than the shared `Strings.kt`.

### Names on the phone (per flavor)

What an installed app keeps on the phone is named per flavor
(`buildConfigField`s in `app/build.gradle.kts`, read through `AppBrand`):

| | WebYar (exactly as shipped, never change) | RESPOK |
|---|---|---|
| DataStore (session token, language, API origin) | `webyar` | `settings` |
| Keystore alias (session key) | `com.webyar.ai.session` | `app.session` |
| Cache database | `webyar-cache.db` | `cache.db` |
| Firebase client prefs | `webyar.firebase` | `push.firebase` |
| Promotions prefs | `webyar.promotions` | `promotions` |
| Messages channel (and the manifest's FCM default) | `webyar_messages` | `messages` |
| Calls channel | `webyar_calls` | `calls` |
| Call notification actions | `com.webyar.ai.call.ANSWER` / `SHOW` / `DECLINE` | `app.call.ANSWER` / `SHOW` / `DECLINE` |
| Log tags | `Webyar.<Area>`, `WebyarApi` | `RESPOK.<Area>`, `RESPOKApi` |
| Launcher component | `com.webyar.ai.MainActivity` (alias) | `com.platform.app.MainActivity` |

WebYar's values are the ones every installed copy already uses: renaming one
would sign every operator out (DataStore, Keystore alias), drop their cache,
or leave their notification settings on a channel nothing posts to; the
launcher alias keeps home-screen icons and pinned shortcuts (a launcher keeps
them by component name). The daily cache job is enqueued with
`ExistingPeriodicWorkPolicy.UPDATE`, so the job an installed phone already has
(stored by the worker's old class name) is rewritten to the renamed class.

The server names the messages channel in every push: `platform_settings`'
`android_channel_id`, per edition (`server/services/push/platformSettings.ts`):
Iran sends what is stored (`webyar_messages`), the International edition sends
`messages`, and replaces a stored value that names WebYar (a database cloned
from WebYar's) with it.

**RESPOK 1.0.1** (released 2026-10-10, before this split) used WebYar's names
for all of these. A phone that updates from it signs in once more, starts a
fresh cache, gets new notification channels (the old ones stay in the
system's settings until the app is reinstalled) and loses a home-screen
shortcut pinned with that build (the app-drawer icon stays). That is
deliberate: reading the old names would put WebYar's name back into RESPOK's
APK.

Every Gradle task names its brand: `assembleWebyarRelease`,
`bundleRespokRelease`, `testRespokDebugUnitTest`. The unflavored names from
before (`bundleRelease`, `testDebugUnitTest`, `lintDebug`, `installDebug`) no
longer exist; aggregates such as `assembleRelease` build both.

## The one artifact Play accepts

A new app cannot be uploaded to Play as an APK. It has to be an **App
Bundle** — `.aab` — and Play builds the per-device APKs itself.

```sh
./gradlew :app:bundleWebyarRelease -Pwebyar.versionCode=26 -Pwebyar.versionName=1.5
# → app/build/outputs/bundle/webyarRelease/app-webyar-release.aab

./gradlew :app:bundleRespokRelease -Prespok.versionCode=1 -Prespok.versionName=1.0.0
# → app/build/outputs/bundle/respokRelease/app-respok-release.aab
```

`assemble<Brand>Release` still exists and still produces the five split APKs
(`app/build/outputs/apk/<brand>/release/app-<brand>-<abi>-release.apk` and
`app-<brand>-universal-release.apk`). Those are for sideloading, for the
website, for handing somebody a build to try, and for CI. They are not what
goes to Play.

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
WebYar  versionCode  -Pwebyar.versionCode  or  WEBYAR_VERSION_CODE   (default 1)
        versionName  -Pwebyar.versionName  or  WEBYAR_VERSION_NAME   (default 0.1.0)
RESPOK  versionCode  -Prespok.versionCode  or  RESPOK_VERSION_CODE   (default 1)
        versionName  -Prespok.versionName  or  RESPOK_VERSION_NAME   (default 1.0.0)
```

Play refuses a `versionCode` it has already seen and it never forgets one, so
this cannot live only in `build.gradle.kts`: a hotfix would mean editing
source to ship, and two releases cut from one commit would collide. Pass it
from whatever drives the release.

The property wins over the environment variable, which is the order somebody
debugging a wrong version number expects. Each brand reads only its own names
(Super Admin's build command passes the flavor's own: `-Prespok.versionCode`
for RESPOK); RESPOK's build no longer falls back to the `webyar.` ones.

WebYar's numbers continue from what phones already have: 1.4 is
`versionCode` 25, and anything at or below that is refused as a downgrade.
RESPOK is a new app and starts at 1.

## The signing keys

**This is the part that cannot be undone.** Play — and every phone that has
the app — ties each app's identity to one key for as long as the app exists.

- Lose it → you can never update the app again. Not "with difficulty": never.
  The remedy is a new listing, a new package name, and none of the installs.
- Leak it → somebody else can sign an update to your app.

Each brand has its own key, and the build signs each brand only with its own:
the key is chosen by the flavor, never by the `release` build type (a build
type's key would win over both flavors' and sign RESPOK with WebYar's, or the
other way round; the build refuses that configuration).

**WebYar's key already exists and must never change.** Every WebYar release so
far was signed with it (made by this script, so `webyar-release.jks` with
alias `webyar` unless chosen otherwise; the releases so far were built and
signed on the owner's Mac); a WebYar APK signed with anything else cannot
update a phone that has WebYar installed. Never make a second one.

RESPOK's is made once, the same way:

```sh
cd android && ./tools/make-release-keystore.sh respok    # → respok-release.jks, alias respok
```

The script prompts for the password rather than taking it as an argument —
arguments are visible to every process on the machine (`ps`) and shell history
keeps them for years. It refuses to overwrite an existing keystore, and asks
twice before making a WebYar one.

Then, in the shell that runs Gradle, from a password manager and never from a
file in the repository:

```sh
# WebYar
export WEBYAR_KEYSTORE="$PWD/webyar-release.jks"
export WEBYAR_KEYSTORE_PASSWORD='…'
export WEBYAR_KEY_ALIAS='webyar'
export WEBYAR_KEY_PASSWORD='…'

# RESPOK
export RESPOK_KEYSTORE="$PWD/respok-release.jks"
export RESPOK_KEYSTORE_PASSWORD='…'
export RESPOK_KEY_ALIAS='respok'
export RESPOK_KEY_PASSWORD='…'
```

A brand's release build with its four not set produces an **unsigned**
artifact (`…-release-unsigned.apk`). That is deliberate: an unsigned file
cannot be installed by accident, whereas one signed with a key from the
repository can be installed by anybody who has ever cloned it. `*.jks`,
`*.keystore`, `*.p12` and `keystore.properties` are in `.gitignore` so the file
cannot be committed by mistake.

### Check what you are about to upload

```sh
$ANDROID_HOME/build-tools/*/apksigner verify --print-certs \
    app/build/outputs/apk/webyar/release/app-webyar-universal-release.apk
$ANDROID_HOME/build-tools/*/apksigner verify --print-certs \
    app/build/outputs/apk/respok/release/app-respok-universal-release.apk
```

An unsigned artifact says so here, and the two must print two different
certificates: WebYar's the same as every earlier WebYar release, RESPOK's its
own. Finding that out from Play's rejection email — or from phones refusing
the update — is the slow way.

## The APKs on the websites

Until the apps are on Play, operators install them from their brand's site:
the **universal** release APK (`app-<brand>-universal-release.apk`, every ABI
in one file, so nobody has to know which one their phone needs), signed with
that brand's release key.

| | File in the repository | Served at |
|---|---|---|
| WebYar | `public/downloads/Webyar-Android.apk` + `Webyar-Android.json` | `https://app.webyar.ai/downloads/Webyar-Android.apk` |
| RESPOK | `public/downloads/RESPOK-Android.apk` + `RESPOK-Android.json` | `https://app.respok.app/downloads/RESPOK-Android.apk` |

Each ships with the site: a new version is that file and its sidecar
(`versionName`, `versionCode`, `sha256`, `sizeBytes`, `releasedAt`) replaced,
merged and deployed. Super Admin → Mobile App → Android shows each edition's
own sidecar (`server/services/mobileApp/androidRelease.ts`), and each site
answers 404 for the other brand's file names. The landing page links to
exactly `/downloads/Webyar-Android.apk` on app.webyar.ai, so that path stays.
Details: `deploy/app-downloads/README.md`.

Build WebYar with a `versionCode` above the last one published (1.4 is 25), or
phones that have it will refuse the file as a downgrade.

Push does not depend on the build. A published APK carries no Firebase
project: it reads the one set in **Super Admin → Mobile App → Android →
Identity** on its own platform (WebYar's for WebYar, RESPOK's for RESPOK, where
the Firebase Android app must be registered for `com.respok.app`), keeps it
and starts Firebase with it at every launch after (`core/push/PushConfig.kt`).
Until that is set — and until that server has its FCM service account,
`FIREBASE_SERVICE_ACCOUNT_JSON` — the app works while open and is silent when
closed. A build made with `WEBYAR_FIREBASE_*` (WebYar) or `RESPOK_FIREBASE_*`
(RESPOK) values uses that project instead, whatever Super Admin says: for a
developer's own Firebase project, not for a release. Each brand reads only its
own names, so WebYar's exported in a shell never reaches RESPOK's build.

## Icons

The launcher icons come from the brand kits, not from a script:

- WebYar: the WebYar brand kit's `app-icon/android/res` — the adaptive icon
  (vector background, foreground and monochrome layers in `res/drawable`,
  `mipmap-anydpi-v26`) and the legacy `ic_launcher`/`ic_launcher_round` PNGs in
  five densities — in `src/webyar/res`; its Play icon is
  `src/webyar/ic_launcher-playstore.png`.
- RESPOK: the RESPOK kit's Thread icon, Signal colourway
  (`Thread/2-App-Icons/signal/android/res`), in `src/respok/res`, which must
  cover every density and both adaptive XMLs (`src/main/res` has no launcher
  icon at all); its Play icon is `src/respok/ic_launcher-playstore.png`.

A new kit is copied over the same files. `scripts/android/icon-from-ios.py`,
which drew the old icon from the iOS one, is retired.
`src/test/apps/mobileBrands.android.test.ts` checks the RESPOK set is
complete.

## Before you press publish

| | |
|---|---|
| `./gradlew :app:testWebyarDebugUnitTest :app:testRespokDebugUnitTest` | unit and Robolectric tests, both brands |
| `./gradlew :app:lintWebyarDebug :app:lintRespokDebug` | zero errors, warnings reviewed |
| `./gradlew :app:assembleWebyarMinified :app:assembleRespokMinified` | R8's output, installable, **run it** |
| `tools/check-brand-neutral.sh app/build/outputs/apk/respok/release/*.apk` | RESPOK's APK names WebYar nowhere |
| `./gradlew :app:bundleWebyarRelease` / `:app:bundleRespokRelease` | the artifact itself |

`assemble<Brand>Minified` exists because R8 is the difference between the app
that was tested and the app that ships: it renames, inlines and deletes, and a
missing keep rule shows up as an inbox of blank rows rather than as a crash.
It is minified exactly like release and signed with the debug key, so it can
actually be installed and looked at (`com.webyar.ai.minified`,
`com.respok.app.minified`).

## What is still open

- **The app has never run on a physical phone.** Everything on device so far
  was the emulator. A real handset is the one test that catches what an
  emulator cannot: a vendor's keyboard, a notch, a battery optimiser that
  kills the socket, a locale the emulator does not ship.
- RESPOK's release key does not exist yet (`make-release-keystore.sh respok`),
  and its first signed APK has not been built.
- RESPOK's platform must hold its own values for the app: Super Admin →
  Mobile App → Android on respok.app (package `com.respok.app`, default
  language English, its Firebase app), and `platform_domains.api_base_url`
  `https://api.respok.app` — a RESPOK build never moves off respok.app,
  whatever that says.
- There is no Play listing yet for either app: title, description,
  screenshots, privacy policy URL, content rating and a data-safety
  declaration are all required before the first upload is accepted, and none
  of them are code.
