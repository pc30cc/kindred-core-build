# TileServer GL — Self-Host on Coolify

Serve your own OpenStreetMap raster/vector tiles. No API keys, no rate limits,
no third-party tracking. Works as the `tileserver_selfhosted` provider in the
Visitors map.

---

## What you get

- A Docker service running [`maptiler/tileserver-gl`](https://github.com/maptiler/tileserver-gl)
- Raster tile endpoint: `https://tiles.example.com/styles/basic/{z}/{x}/{y}.png`
- Vector tile endpoint: `https://tiles.example.com/data/v3/{z}/{x}/{y}.pbf`
- Health check: `https://tiles.example.com/health`

---

## 1. Get an MBTiles file

TileServer GL needs a `.mbtiles` file (vector tiles). Two options:

### Option A — Free OpenMapTiles planet extract (recommended)

Download a country/region extract from <https://data.maptiler.com/downloads/planet/>
(free tier requires signup) **or** use the openly-licensed mirror:

```bash
# Example: Turkey extract (~250 MB)
wget https://download.openmaptiles.com/turkey.mbtiles -O ./tiles/region.mbtiles
```

### Option B — Generate your own with Planetiler (fully free)

```bash
docker run -e JAVA_TOOL_OPTIONS="-Xmx4g" \
  -v "$(pwd)/tiles:/data" \
  ghcr.io/onthegomap/planetiler:latest \
  --download --area=turkey
# Output: tiles/output.mbtiles
```

Place the final file at `deploy/tileserver/tiles/region.mbtiles`.

---

## 2. Deploy to Coolify

| Setting | Value |
|---|---|
| **Deploy type** | Docker Compose |
| **Compose file** | `deploy/tileserver/docker-compose.yml` |
| **Domain** | `tiles.example.com` |
| **Internal port** | `8080` |
| **Health check path** | `/health` |

### Persistent storage

Mount a Coolify persistent volume to `/data` so your `.mbtiles` file survives
rebuilds. Upload your `region.mbtiles` into that volume (Coolify → Storages →
Upload), or bake it into a custom image.

### Environment variables

None required. Optional:

| Variable | Default | Purpose |
|---|---|---|
| `MBTILES_FILE` | `region.mbtiles` | Filename inside `/data` |

---

## 3. DNS

| Record | Name | Value |
|---|---|---|
| A | `tiles` | Your Coolify server IP |

Coolify auto-issues TLS via Let's Encrypt.

---

## 4. Configure the app

1. Open **Admin → Providers → Map Tiles** (or **Workspace → Settings → Providers**).
2. Select provider: **TileServer (self-hosted)**.
3. Fill in:
   - **Tile URL**: `https://tiles.example.com/styles/basic/{z}/{x}/{y}.png`
   - **Attribution**: `&copy; OpenStreetMap contributors &copy; OpenMapTiles`
   - **Max zoom**: `19`
   - **Health URL** *(optional)*: `https://tiles.example.com/health`
4. Save. The Visitors map switches over immediately.

---

## 5. Verify

```bash
# Health
curl -fsSL https://tiles.example.com/health
# → {"status":"ok"}

# Sample tile (zoom 0, world)
curl -I https://tiles.example.com/styles/basic/0/0/0.png
# → HTTP/2 200, content-type: image/png
```

Then check the Visitors page — markers should render on YOUR tiles. The
fallback badge in the corner should disappear (`health_status: healthy`).

---

## 6. Resource sizing

| Region size | RAM | Disk |
|---|---|---|
| City / small country | 512 MB | 1–2 GB |
| Country | 1 GB | 5–10 GB |
| Continent | 2 GB | 30–60 GB |
| Planet | 4 GB+ | 80+ GB |

TileServer GL is read-only and stateless — horizontal scaling works fine
behind Coolify's reverse proxy if you ever need it.