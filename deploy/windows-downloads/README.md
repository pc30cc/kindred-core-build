# Desktop installer downloads (Windows and macOS)

Served from the production host, not from the frontend image: large binaries do
not belong in git or in every frontend build, and the files must survive
redeploys.

| | Latest | A given version |
|---|---|---|
| Windows | `https://app.webyar.ai/downloads/Webyar-Setup.exe` | `…/Webyar-Setup-<version>.exe` |
| macOS | `https://app.webyar.ai/downloads/Webyar-Mac.dmg` | `…/Webyar-Mac-<version>.dmg` |

On the host (analyticsme.site):

- Files: `/data/webyar-downloads/files/`. `Webyar-Setup.exe` and
  `Webyar-Mac.dmg` are symlinks to the current `Webyar-Setup-<version>.exe` and
  `Webyar-Mac-<version>.dmg`.
- Server: container `webyar-downloads` (`nginx:alpine`, network `coolify`,
  restart `unless-stopped`) with `nginx.conf` from this folder mounted as
  `/etc/nginx/conf.d/default.conf` and the files directory at `/data` (read-only).
- Routing: `traefik-webyar-downloads.yaml` from this folder lives at
  `/data/coolify/proxy/dynamic/webyar-downloads.yaml`. It matches only
  `/downloads/Webyar-Setup*.exe` and `/downloads/Webyar-Mac*.dmg`; everything
  else under `/downloads/` (the WooCommerce plugin) still reaches the frontend.
- After changing `nginx.conf`, restart the container (`docker restart
  webyar-downloads`): the file is bind-mounted, and a container keeps the file
  it started with once the path is rewritten, so `nginx -s reload` alone can
  keep serving the old rules.
- Cloudflare caches a 404 for a few minutes: a new file name requested before
  its file is in place answers 404 for a short while afterwards.

Recreate the container:

    docker run -d --name webyar-downloads --restart unless-stopped \
      --network coolify --network-alias webyar-downloads \
      -v /data/webyar-downloads/files:/data:ro \
      -v /data/webyar-downloads/nginx.conf:/etc/nginx/conf.d/default.conf:ro \
      nginx:alpine

Publish a new version:

- Windows: copy `Webyar-Setup.exe` from `windows-native/releases/` to
  `/data/webyar-downloads/files/Webyar-Setup-<version>.exe`, then
  `ln -sf Webyar-Setup-<version>.exe /data/webyar-downloads/files/Webyar-Setup.exe`.
- macOS: build the DMG on a Mac (`macos/scripts/make-dmg.sh <version> <build>`),
  copy it to `/data/webyar-downloads/files/Webyar-Mac-<version>.dmg`, then
  `ln -sf Webyar-Mac-<version>.dmg /data/webyar-downloads/files/Webyar-Mac.dmg`.
