# TileServer GL — Self-Host on Coolify (World Lite)

Serve your own OpenStreetMap raster/vector tiles. No API keys, no rate limits,
no third-party tracking. Works as the `tileserver_selfhosted` provider in the
Visitors map.

This setup ships with **World Lite auto-bootstrap**: on first start an init
container downloads a small (~80 MB) world-coverage `.mbtiles` into the
persistent volume so the map works immediately, with zero manual upload.

---

## What you get

- `tileserver-init` — runs once, downloads World Lite if `/data/region.mbtiles` is missing
- `tileserver` — `maptiler/tileserver-gl-light` serving tiles on port **8080** (internal)
- `tileserver-proxy` — Caddy reverse proxy on port **80** (Coolify-routed)
- Raster endpoint: `https://tiles.example.com/styles/basic-preview/{z}/{x}/{y}.png`
- Vector endpoint: `https://tiles.example.com/data/v3/{z}/{x}/{y}.pbf`
- Health endpoint: `https://tiles.example.com/health`

---

## Architecture at a glance

| Concern | Where it lives |
|---|---|
| Tile server image | `maptiler/tileserver-gl-light:latest` (no data baked in) |
| Tile data | Persistent Docker volume `tileserver-data` mounted at `/data` |
| Default file path | `/data/region.mbtiles` |
| Container port | `8080` (proxied to `:80` by Caddy) |
| First-start bootstrap | `tileserver-init` Alpine container, runs `curl` once |

The image and the data are intentionally decoupled: you can swap the dataset
by replacing the file in the volume — no rebuild, no redeploy, no provider
config change.

---

## 1. Deploy to Coolify

| Setting | Value |
|---|---|
| **Deploy type** | Docker Compose |
| **Compose file** | `deploy/tileserver/docker-compose.yml` |
| **Domain** | `tiles.example.com` → routed to `tileserver-proxy` service |
| **Internal port** | `80` (proxy) |
| **Persistent volume** | Mount to `/data` on the `tileserver` service |

### Optional environment variables

| Variable | Default | Purpose |
|---|---|---|
| `WORLD_LITE_URL` | OpenMapTiles `planet_z0-z7.mbtiles` (~80 MB) | Source URL for first-run download |
| `WORLD_LITE_FILE` | `region.mbtiles` | Target filename inside `/data` |

Set these in Coolify → Service → Environment Variables if you want a different
default dataset (e.g. a country extract URL).

---

## 2. First-start behavior

```
tileserver-init starts
 ├─ /data/region.mbtiles exists?
 │    ├─ YES → log "skipping" → exit 0
 │    └─ NO  → curl WORLD_LITE_URL → /data/region.mbtiles.part
 │             rename to region.mbtiles → exit 0
 └─ tileserver starts only after init exits successfully
```

Subsequent restarts are a no-op for the init container — it just confirms the
file is there and exits in <1s.

---

## 3. DNS

| Record | Name | Value |
|---|---|---|
| A | `tiles` | Your Coolify server IP |

Coolify auto-issues TLS via Let's Encrypt.

---

## 4. Configure the app (Admin → Providers → Map Tiles)

After Coolify reports the stack as healthy:

| Field | Value |
|---|---|
| **Provider** | TileServer (self-hosted) |
| **Tile URL** | `https://tiles.example.com/styles/basic-preview/{z}/{x}/{y}.png` |
| **Attribution** | `&copy; OpenStreetMap contributors &copy; OpenMapTiles` |
| **Max zoom** | `7` (matches World Lite). Raise after upgrading the dataset. |
| **Health URL** *(optional)* | `https://tiles.example.com/health` |

Save. The Visitors map switches over immediately and the fallback badge
disappears.

---

## 5. Verify

```bash
# 1. Health endpoint
curl -fsSL https://tiles.example.com/health
# → {"status":"ok"}

# 2. Confirm the bootstrap landed the file
docker exec <tileserver-container> ls -lh /data
# → -rw-r--r-- ... 80M ... region.mbtiles

# 3. Sample tile (zoom 0, world view)
curl -I https://tiles.example.com/styles/basic-preview/0/0/0.png
# → HTTP/2 200, content-type: image/png

# 4. List served datasets
curl -s https://tiles.example.com/data.json | jq
```

Then open the Visitors page — markers should render on YOUR tiles.

---

## 6. Upgrading from World Lite to a larger dataset

Because the provider only knows about a URL pattern, swapping the underlying
data is a pure filesystem operation:

### Option A — replace in place (simplest)

```bash
# On the Coolify host:
docker cp ./turkey.mbtiles <tileserver-container>:/data/region.mbtiles
docker restart <tileserver-container>
```

### Option B — let the init container handle it

1. Empty the volume: `docker exec <init-container> rm /data/region.mbtiles`
2. Update `WORLD_LITE_URL` in Coolify to point at your new `.mbtiles` URL
3. Redeploy — the init container downloads the new file once.

### Option C — use a different filename

1. Drop e.g. `planet.mbtiles` into the volume.
2. Edit `deploy/tileserver/config.example.json` to reference it (or rely on
   `tileserver-gl-light --serveAllStyles` autodetection — `data.json` will
   list every `.mbtiles` in `/data`).
3. Update **Tile URL** in Admin → Providers to use the new style id.

After any swap, raise **Max zoom** in Admin → Providers to match the new file.

---

## 7. Resource sizing

| Dataset | RAM | Disk |
|---|---|---|
| World Lite (z0–z7, default) | 256 MB | 100 MB |
| Country extract (z0–z14) | 512 MB | 1–5 GB |
| Continent (z0–z14) | 1 GB | 30–60 GB |
| Planet (z0–z14) | 2 GB+ | 80+ GB |

`tileserver-gl-light` is read-only and stateless — horizontal scaling works
fine behind Coolify's reverse proxy if you ever need it.

---

## 8. Troubleshooting

**Init container fails to download.** Check `docker logs <init-container>`.
Most likely the upstream URL changed — set `WORLD_LITE_URL` to a known-good
mirror (any `.mbtiles` URL works) and redeploy.

**`Cannot GET /styles/...`**. The volume is empty. Confirm with
`docker exec <tileserver> ls /data`. If empty, restart the stack so the init
runs again, or upload a file manually.

**Tiles render as blank squares above zoom 7.** That's expected for World
Lite — it only contains z0–z7. Either lower the **Max zoom** setting or
upgrade the dataset (section 6).
