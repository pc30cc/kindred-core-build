# App downloads (Windows installer and update feed, Mac DMG; the Android APK ships with the site)

`https://app.webyar.ai/downloads/Webyar-Setup.exe` (latest) and
`https://app.webyar.ai/downloads/Webyar-Setup-<version>.exe` are served from the
production host, not from the frontend image: an ~90 MB binary does not belong
in git or in every frontend build, and the file must survive redeploys.

On the host (analyticsme.site — reached over SSH by its own IP; the name is
behind Cloudflare):

- Files: `/data/webyar-downloads/files/`. `Webyar-Setup.exe` is a symlink to
  the current `Webyar-Setup-<version>.exe`.
- Server: container `webyar-downloads` (`nginx:alpine`, network `coolify`,
  restart `unless-stopped`) with `nginx.conf` from this folder mounted as
  `/etc/nginx/conf.d/default.conf` and the files directory at `/data` (read-only).
- Routing: `traefik-webyar-downloads.yaml` from this folder lives at
  `/data/coolify/proxy/dynamic/webyar-downloads.yaml`. It matches only
  `/downloads/Webyar-Setup*.exe`, `/downloads/Webyar-Mac*.dmg` and the update
  feed under `/downloads/windows/`; everything
  else under `/downloads/` (the plugins, the Android APK) reaches the frontend.

Recreate the container:

    docker run -d --name webyar-downloads --restart unless-stopped \
      --network coolify --network-alias webyar-downloads \
      -v /data/webyar-downloads/files:/data:ro \
      -v /data/webyar-downloads/nginx.conf:/etc/nginx/conf.d/default.conf:ro \
      nginx:alpine

Publishing is automatic. CI builds each release and uploads it to
`github.com/pc30cc/webyar-desktop-releases` (it has no way into this host);
`sync-windows.sh` from this folder, run every 5 minutes by the systemd timer
`webyar-windows-sync`, copies every new release here:

- `Webyar-Setup-<version>.exe`, and moves the `Webyar-Setup.exe` symlink to it;
- the Velopack update feed into `files/windows/` — the `.nupkg` packages first,
  then `releases.win.json` and `RELEASES`, so the index never names a missing
  file. The installed apps (2.6.1 and later) update from
  `https://app.webyar.ai/downloads/windows`; the newest 12 packages are kept.

Install or reinstall the mirror on the host:

    cp sync-windows.sh /data/webyar-downloads/ && chmod +x /data/webyar-downloads/sync-windows.sh
    cp webyar-windows-sync.service webyar-windows-sync.timer /etc/systemd/system/
    systemctl daemon-reload && systemctl enable --now webyar-windows-sync.timer

Run it now instead of waiting: `systemctl start webyar-windows-sync`; its
output is in `journalctl -u webyar-windows-sync`.

## The Android app

`https://app.webyar.ai/downloads/Webyar-Android.apk` is **not** served from
this container. It ships with the site: the file is
`public/downloads/Webyar-Android.apk` in the repository, beside the plugin
zips, and the frontend image serves it from `/downloads/` (no caching, a hard
404 rather than the SPA page — see `nginx.conf.template`). The Traefik rule
above leaves `.apk` alone for that reason; the frontend Dockerfiles fail the
build if the file is missing.

The APK is the universal release build (every ABI), signed with the release
key — see `docs/ANDROID_RELEASE.md`. Publish a new version: replace
`public/downloads/Webyar-Android.apk` with the new build, merge, and let the
frontend deploy. Keep the file name: the site's download page (webyar.ai →
admin → «برنامه‌ها و دانلود» → Android) links to exactly this path.

It is about 58 MB, under GitHub's 100 MB limit for one file; every version
adds that much to the repository's history.

## The Mac app

`https://app.webyar.ai/downloads/Webyar-Mac.dmg` (latest) and
`https://app.webyar.ai/downloads/Webyar-Mac-<version>.dmg` come from the same
container and folder; `nginx.conf` and the Traefik rule above carry the
`Webyar-Mac*.dmg` route. The DMG is one Universal app (Apple Silicon and Intel,
macOS 14+), built on a Mac with `macos/scripts/make-dmg.sh <version> <build>`.
Publish it:

    v=1.0.2
    host=<the server's own IP>
    scp Webyar-Mac-$v.dmg root@$host:/data/webyar-downloads/files/
    ssh root@$host "cd /data/webyar-downloads/files && ln -sf Webyar-Mac-$v.dmg Webyar-Mac.dmg"

By IP, not by name: `analyticsme.site` resolves to Cloudflare, which does not
carry SSH, so `ssh root@analyticsme.site` only ever times out.

Two things learnt putting it up:

- After changing `nginx.conf`, restart the container (`docker restart
  webyar-downloads`): the file is bind-mounted, and a container keeps the copy
  it started with once the file is rewritten in place of the old one, so
  `nginx -s reload` alone can keep serving the old rules.
- Cloudflare caches a 404 for a few minutes: a new file name asked for before
  its route is in place answers 404 for a short while afterwards.
- A 404 that carries this container's `Content-Disposition` header means the
  routing works and the file (or its symlink) is missing; a 404 without it
  means Traefik never sent the request here.
