# App downloads: both brands' desktop installers and update feeds

Each brand's site serves its own desktop apps, from the production host
(`vps-50cc1602`), not from the frontend image: a ~90 MB binary does not belong
in git or in every frontend build, and the files must survive redeploys.

People download zips: the Windows one holds the installer (`Webyar-Setup.exe`,
`RESPOK-Setup.exe`), the Mac one the DMG (`Webyar-Mac.dmg`, `RESPOK-Mac.dmg`).

| | WebYar | RESPOK |
| --- | --- | --- |
| Windows (newest) | `https://app.webyar.ai/downloads/Webyar-Windows.zip` | `https://app.respok.app/downloads/RESPOK-Windows.zip` |
| Windows (a version) | `…/downloads/Webyar-Windows-<version>.zip` | `…/downloads/RESPOK-Windows-<version>.zip` |
| Windows update feed (Velopack) | `https://app.webyar.ai/downloads/windows` | `https://app.respok.app/downloads/windows` |
| Mac (newest) | `https://app.webyar.ai/downloads/Webyar-Mac.zip` | `https://app.respok.app/downloads/RESPOK-Mac.zip` |
| Mac (a version) | `…/downloads/Webyar-Mac-<version>.zip` | `…/downloads/RESPOK-Mac-<version>.zip` |
| Published by CI to | `pc30cc/webyar-desktop-releases` (Windows), `pc30cc/mac-os` (Mac) | `pc30cc/respok-releases` (Windows releases; Mac under `mac/`) |
| Files on the host | `/data/app-downloads/webyar/` | `/data/app-downloads/respok/` |

The links of before, to the installer and the DMG themselves
(`<Prefix>-Setup.exe`, `<Prefix>-Mac.dmg`), answer a redirect (302) to the newest
zip, so links already given out (sites, Super Admin, docs) keep working. A link
with a version (`<Prefix>-Setup-<version>.exe`, `<Prefix>-Mac-<version>.dmg`)
redirects to that version's zip, which exists only while it is kept (below): at
the switch only each brand's newest version was zipped.

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
   - the newest installer, zipped as `<Prefix>-Windows-<version>.zip` (it holds
     `<Prefix>-Setup.exe`), and moves the `<Prefix>-Windows.zip` symlink to it;
   - the Velopack update feed into `<brand>/windows/`: the packages of the
     newest two releases first (the newest one's index names only its own full
     package and delta; the one before stays for apps halfway through an
     update), then `releases.win.json` and `RELEASES`. If any package fails to
     download, the index is left as it was, so it never names a missing file.
     Packages outside those two releases are removed;
   - the DMG of the newest stable Mac version in the brand's appcast, zipped as
     `<Prefix>-Mac-<version>.zip` (it holds `<Prefix>-Mac.dmg`), with the
     `<Prefix>-Mac.zip` symlink.

   Each zip is written whole under a hidden name, then renamed, so a download
   never gets half a zip. Of the zips, the symlink's target and the two newest
   others are kept. A run with nothing new downloads nothing (a version whose
   zip is there is not fetched again).

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
  brand's own zips, old installer and DMG links, and update feed on its own
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
    curl -sI https://app.respok.app/downloads/RESPOK-Setup.exe | grep -i location   # → the zip
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

## The Android app

`https://app.webyar.ai/downloads/Webyar-Android.apk` is **not** served from
this container. It ships with the site: the file is
`public/downloads/Webyar-Android.apk` in the repository, beside the plugin
zips, and the frontend image serves it from `/downloads/` (no caching, a hard
404 rather than the SPA page — see `nginx.conf.template`). The Traefik rules
above leave `.apk` alone for that reason; the frontend Dockerfiles fail the
build if the file is missing.

The APK is the universal release build (every ABI), signed with the release
key — see `docs/ANDROID_RELEASE.md`. Publish a new version: replace
`public/downloads/Webyar-Android.apk` with the new build, merge, and let the
frontend deploy. Keep the file name: the site's download page (webyar.ai →
admin → «برنامه‌ها و دانلود» → Android) links to exactly this path.

There is no RESPOK Android or iOS build yet: the mobile apps are WebYar's only.

## History

On 2026-10-09 the downloads became zips (`<Prefix>-Windows.zip`,
`<Prefix>-Mac.zip`); before, the site served `<Prefix>-Setup.exe` and
`<Prefix>-Mac.dmg` as they are, and those links now redirect to the zips.

Until 2026-10-07 the WebYar-only mirror (`webyar-downloads`, from
`deploy/windows-downloads/`) ran on the old server (`analyticsme.site`). It did
not move with the apps, so from the move until this mirror was installed on
`vps-50cc1602`, `app.webyar.ai/downloads/Webyar-Setup.exe`, `Webyar-Mac.dmg`
and the Windows update feed answered 404.
