# Windows installer downloads

`https://app.webyar.ai/downloads/Webyar-Setup.exe` (latest) and
`https://app.webyar.ai/downloads/Webyar-Setup-<version>.exe` are served from the
production host, not from the frontend image: an ~90 MB binary does not belong
in git or in every frontend build, and the file must survive redeploys.

On the host (analyticsme.site):

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
