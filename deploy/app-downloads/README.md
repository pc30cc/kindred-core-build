# App downloads: both brands' desktop installers and update feeds

Each brand's site serves its own desktop apps, from the production host
(`vps-50cc1602`), not from the frontend image: a ~90 MB binary does not belong
in git or in every frontend build, and the files must survive redeploys.

| | WebYar | RESPOK |
| --- | --- | --- |
| Windows installer (newest) | `https://app.webyar.ai/downloads/Webyar-Setup.exe` | `https://app.respok.app/downloads/RESPOK-Setup.exe` |
| Windows installer (a version) | `…/downloads/Webyar-Setup-<version>.exe` | `…/downloads/RESPOK-Setup-<version>.exe` |
| Windows update feed (Velopack) | `https://app.webyar.ai/downloads/windows` | `https://app.respok.app/downloads/windows` |
| Mac DMG (newest) | `https://app.webyar.ai/downloads/Webyar-Mac.dmg` | `https://app.respok.app/downloads/RESPOK-Mac.dmg` |
| Mac DMG (a version) | `…/downloads/Webyar-Mac-<version>.dmg` | `…/downloads/RESPOK-Mac-<version>.dmg` |
| Published by CI to | `pc30cc/webyar-desktop-releases` (Windows), `pc30cc/mac-os` (Mac) | `pc30cc/respok-releases` (Windows releases; Mac under `mac/`) |
| Files on the host | `/data/app-downloads/webyar/` | `/data/app-downloads/respok/` |

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
   - the newest installer as `<Prefix>-Setup-<version>.exe`, and moves the
     `<Prefix>-Setup.exe` symlink to it (the newest 3 are kept);
   - the Velopack update feed into `<brand>/windows/`: the `.nupkg` packages
     first, then `releases.win.json` and `RELEASES`, so the index never names a
     missing file (the newest 6 packages are kept);
   - the newest stable Mac version from the brand's appcast, as
     `<Prefix>-Mac-<version>.dmg` with the `<Prefix>-Mac.dmg` symlink (the
     newest 3 are kept).

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
  brand's own installer, DMG and update feed on its own host; everything else
  under `/downloads/` (the plugins, the Android APK) reaches the frontend.

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

    curl -sI https://app.webyar.ai/downloads/Webyar-Setup.exe | head -3
    curl -sI https://app.respok.app/downloads/RESPOK-Setup.exe | head -3
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
- The disk is shared with Docker (see CLAUDE.md, Disk): both brands together
  keep about 2 GB here.

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

Until 2026-10-07 the WebYar-only mirror (`webyar-downloads`, from
`deploy/windows-downloads/`) ran on the old server (`analyticsme.site`). It did
not move with the apps, so from the move until this mirror was installed on
`vps-50cc1602`, `app.webyar.ai/downloads/Webyar-Setup.exe`, `Webyar-Mac.dmg`
and the Windows update feed answered 404.
