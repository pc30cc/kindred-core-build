# App downloads: both brands' installers, their zips and the update feeds

Each brand's site serves its own desktop apps, from the production host
(`vps-50cc1602`), not from the frontend image: a ~90 MB binary does not belong
in git or in every frontend build, and the files must survive redeploys.

People download each app as it is or as a zip: the installer (`Webyar-Setup.exe`)
or the zip that holds it (`Webyar-Windows.zip`), the DMG (`Webyar-Mac.dmg`) or
its zip (`Webyar-Mac.zip`), and the Android APK's zip (`Webyar-Android.zip`;
the APK itself is the frontend's, below). The same for RESPOK, named `RESPOK-*`.

| | WebYar | RESPOK |
| --- | --- | --- |
| Windows installer (newest) | `https://app.webyar.ai/downloads/Webyar-Setup.exe` | `https://app.respok.app/downloads/RESPOK-Setup.exe` |
| Windows zip (newest) | `https://app.webyar.ai/downloads/Webyar-Windows.zip` | `https://app.respok.app/downloads/RESPOK-Windows.zip` |
| Windows (a version) | `…/Webyar-Setup-<version>.exe`, `…/Webyar-Windows-<version>.zip` | `…/RESPOK-Setup-<version>.exe`, `…/RESPOK-Windows-<version>.zip` |
| Windows update feed (Velopack) | `https://app.webyar.ai/downloads/windows` | `https://app.respok.app/downloads/windows` |
| Mac DMG (newest) | `https://app.webyar.ai/downloads/Webyar-Mac.dmg` | `https://app.respok.app/downloads/RESPOK-Mac.dmg` |
| Mac zip (newest) | `https://app.webyar.ai/downloads/Webyar-Mac.zip` | `https://app.respok.app/downloads/RESPOK-Mac.zip` |
| Mac (a version) | `…/Webyar-Mac-<version>.dmg`, `…/Webyar-Mac-<version>.zip` | `…/RESPOK-Mac-<version>.dmg`, `…/RESPOK-Mac-<version>.zip` |
| Android zip (newest) | `https://app.webyar.ai/downloads/Webyar-Android.zip` | `https://app.respok.app/downloads/RESPOK-Android.zip` |
| Published by CI to | `pc30cc/webyar-desktop-releases` (Windows), `pc30cc/mac-os` (Mac) | `pc30cc/respok-releases` (Windows releases; Mac under `mac/`) |
| Files on the host | `/data/app-downloads/webyar/` | `/data/app-downloads/respok/` |

A link with a version works while that version is kept (below).

The installed Windows apps update from their own site's feed (they trust only
their own brand's feed and releases repository: `windows-native/src/Webyar.Core/Config/Brand.cs`).
The Mac apps update with Sparkle from their brand's appcast, which Super Admin →
macOS app names on each platform.

## How a release gets here

1. A merge to `main` that changes the Windows app (`windows-native/`) or the
   Mac app (`macos/`) builds both brands in CI and publishes them, with the same
   version, to each brand's repository (`.github/workflows/desktop-native.yml`,
   `.github/workflows/macos.yml`).
2. Every 5 minutes `sync-downloads.sh` (systemd timer `app-downloads-sync`)
   copies what is new onto the host, per brand:
   - the newest installer as `<Prefix>-Setup-<version>.exe` and zipped as
     `<Prefix>-Windows-<version>.zip` (it holds `<Prefix>-Setup.exe`), and
     moves the `<Prefix>-Setup.exe` and `<Prefix>-Windows.zip` symlinks to them;
   - the Velopack update feed into `<brand>/windows/`: the packages of the
     newest two releases first (the newest one's index names only its own full
     package and delta; the one before stays for apps halfway through an
     update), then `releases.win.json` and `RELEASES`. If any package fails to
     download, the index is left as it was, so it never names a missing file.
     Packages outside those two releases are removed;
   - the DMG of the newest stable Mac version in the brand's appcast, as
     `<Prefix>-Mac-<version>.dmg` and zipped as `<Prefix>-Mac-<version>.zip`
     (it holds `<Prefix>-Mac.dmg`), with the `<Prefix>-Mac.dmg` and
     `<Prefix>-Mac.zip` symlinks;
   - the APK the brand's own site serves (`https://<site>/downloads/<Prefix>-Android.apk`),
     checked against the size and sha256 in its sidecar `.json`, zipped as
     `<Prefix>-Android-<versionName>-<versionCode>.zip` (it holds
     `<Prefix>-Android.apk`), with the `<Prefix>-Android.zip` symlink. A new APK
     is zipped within 5 minutes of its frontend deploy.

   Each file is written whole under a temporary name, then renamed, so a
   download never gets half a file. Of each kind, the symlink's target and the
   two newest others are kept. A run with nothing new downloads nothing.

One brand failing (no release yet, GitHub unreachable) never stops the other.

## On the host

- Files: `/data/app-downloads/{webyar,respok}/`, the script itself at
  `/data/app-downloads/sync-downloads.sh`.
- Server: container `app-downloads` (`nginx:alpine`, network `coolify`, alias
  `app-downloads`, restart `unless-stopped`) with `nginx.conf` from this folder
  mounted as `/etc/nginx/conf.d/default.conf` and `/data/app-downloads` at
  `/data` (read-only). It picks the brand's folder by host name.
- Routing: `traefik-app-downloads.yaml` from this folder lives at
  `/data/coolify/proxy/dynamic/app-downloads.yaml`. It matches only each
  brand's own installer, DMG, zips and update feed on its own
  host; everything else under `/downloads/` (the plugins, the Android APK)
  reaches the frontend.

Install (or reinstall) everything:

    mkdir -p /data/app-downloads/webyar /data/app-downloads/respok
    cp sync-downloads.sh nginx.conf /data/app-downloads/ && chmod +x /data/app-downloads/sync-downloads.sh
    docker run -d --name app-downloads --restart unless-stopped \
      --network coolify --network-alias app-downloads \
      -v /data/app-downloads:/data:ro \
      -v /data/app-downloads/nginx.conf:/etc/nginx/conf.d/default.conf:ro \
      nginx:alpine
    cp traefik-app-downloads.yaml /data/coolify/proxy/dynamic/app-downloads.yaml
    cp app-downloads-sync.service app-downloads-sync.timer /etc/systemd/system/
    systemctl daemon-reload && systemctl enable --now app-downloads-sync.timer

Run it now instead of waiting: `systemctl start app-downloads-sync`; its
output is in `journalctl -u app-downloads-sync`.

Check:

    curl -sI https://app.webyar.ai/downloads/Webyar-Windows.zip | head -3
    curl -sI https://app.respok.app/downloads/RESPOK-Windows.zip | head -3
    curl -sI https://app.respok.app/downloads/RESPOK-Setup.exe | head -3
    curl -sI https://app.webyar.ai/downloads/Webyar-Android.zip | head -3
    curl -s https://app.respok.app/downloads/windows/releases.win.json | head -c 200

Things learnt running it:

- After changing `nginx.conf`, restart the container (`docker restart
  app-downloads`): the file is bind-mounted, and a container keeps the copy
  it started with once the file is rewritten in place of the old one, so
  `nginx -s reload` alone can keep serving the old rules.
- Cloudflare caches a 404 for a few minutes: a new file name asked for before
  its route is in place answers 404 for a short while afterwards.
- A 404 that carries this container's `Content-Disposition` header means the
  routing works and the file (or its symlink) is missing; a 404 without it
  means Traefik never sent the request here.
- The disk is shared with Docker (see CLAUDE.md, Disk): each brand keeps about
  300-400 MB here.
- RESPOK's Mac zip appears once a RESPOK Mac version is published (the appcast
  `pc30cc/respok-releases/mac/appcast.xml` exists); until then
  `RESPOK-Mac.zip` answers 404 and the sync logs `respok: no appcast`.

## The Android apps

Each brand's APK is **not** served from this container. It ships with the
site: `public/downloads/Webyar-Android.apk` and
`public/downloads/RESPOK-Android.apk` in the repository, beside the plugin
zips, each with its `.json` sidecar (the version Super Admin shows for that
edition), and the frontend image serves them from `/downloads/` (no caching, a
hard 404 rather than the SPA page — see `nginx.conf.template`). The Traefik
rules above leave each brand's own `.apk` alone for that reason, and send the
other brand's (`/downloads/Webyar-*` on app.respok.app, `/downloads/RESPOK-*` on
app.webyar.ai) here, where it answers 404. The frontend Dockerfiles fail the
build if WebYar's APK is missing.

| | WebYar | RESPOK |
| --- | --- | --- |
| APK | `https://app.webyar.ai/downloads/Webyar-Android.apk` | `https://app.respok.app/downloads/RESPOK-Android.apk` |
| Package | `com.webyar.ai` | `com.respok.app` |
| Release key | `webyar-release.jks` (never another: phones only update with it) | `respok-release.jks` |

An APK is the universal release build (every ABI) of its flavor, signed with
its brand's release key — see `docs/ANDROID_RELEASE.md`. A phone installs the
`.apk` itself; the mirror above also offers it zipped (`<Prefix>-Android.zip`),
from this container. Publish a new
version: replace the brand's APK and sidecar with the new build, merge, and let
the frontend deploy. Keep the file names: WebYar's landing page links to
exactly `Webyar-Android.apk`.

The iOS apps (WebYar `com.webyar.ai`, RESPOK `com.respok.app`) are distributed
through the App Store, not from here.

## History

On 2026-10-09 the downloads became zips (`<Prefix>-Windows.zip`,
`<Prefix>-Mac.zip`) and the installer and DMG links redirected to them. Since
2026-10-10 both are offered again: the installer and the DMG as they are, and
each zipped, plus the Android APK's zip.

Until 2026-10-07 the WebYar-only mirror (`webyar-downloads`, from
`deploy/windows-downloads/`) ran on the old server (`analyticsme.site`). It did
not move with the apps, so from the move until this mirror was installed on
`vps-50cc1602`, `app.webyar.ai/downloads/Webyar-Setup.exe`, `Webyar-Mac.dmg`
and the Windows update feed answered 404.
