# App downloads (Windows installer, Android APK, Mac DMG)

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
  `/downloads/Webyar-Setup*.exe`; everything else under `/downloads/` (the
  WooCommerce plugin) still reaches the frontend.

Recreate the container:

    docker run -d --name webyar-downloads --restart unless-stopped \
      --network coolify --network-alias webyar-downloads \
      -v /data/webyar-downloads/files:/data:ro \
      -v /data/webyar-downloads/nginx.conf:/etc/nginx/conf.d/default.conf:ro \
      nginx:alpine

Publish a new version: copy `Webyar-Setup.exe` from `windows-native/releases/`
to `/data/webyar-downloads/files/Webyar-Setup-<version>.exe`, then
`ln -sf Webyar-Setup-<version>.exe /data/webyar-downloads/files/Webyar-Setup.exe`.

## The Android app

`https://app.webyar.ai/downloads/Webyar-Android.apk` (latest) and
`https://app.webyar.ai/downloads/Webyar-Android-<version>.apk` come from the same
container and folder. `nginx.conf` and the Traefik rule above already carry the
`Webyar-Android*.apk` route; after updating either on the host:
`docker restart webyar-downloads` (not only `nginx -s reload` — see the Mac
section below; Traefik rereads its dynamic folder by itself).

The APK is the universal release build (every ABI), signed with the release
key — see `docs/ANDROID_RELEASE.md`. Publish a new version:

    v=1.0.1
    host=<the server's own IP>
    scp Webyar-Android-$v.apk root@$host:/data/webyar-downloads/files/
    ssh root@$host "cd /data/webyar-downloads/files && chmod 644 Webyar-Android-$v.apk && ln -sf Webyar-Android-$v.apk Webyar-Android.apk"

By IP, not by name: `analyticsme.site` resolves to Cloudflare, which does not
carry SSH, so `ssh root@analyticsme.site` only ever times out.

Until the file is there, the link answers 404 **with** the `Content-Disposition`
header above. That header is this container's, so a 404 carrying it means the
routing works and the file (or the `Webyar-Android.apk` symlink) is missing;
a 404 without it means Traefik never sent the request here.

The site's download page (webyar.ai → admin → «برنامه‌ها و دانلود» → Android)
points at `https://app.webyar.ai/downloads/Webyar-Android.apk`, so a new
version needs only the symlink moved.

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

Two things learnt putting it up:

- After changing `nginx.conf`, restart the container (`docker restart
  webyar-downloads`): the file is bind-mounted, and a container keeps the copy
  it started with once the file is rewritten in place of the old one, so
  `nginx -s reload` alone can keep serving the old rules.
- Cloudflare caches a 404 for a few minutes: a new file name asked for before
  its route is in place answers 404 for a short while afterwards.
