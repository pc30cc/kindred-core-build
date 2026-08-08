# MaxMind GeoLite2 — Self-Hosted Setup

This project uses a **local** GeoLite2-City `.mmdb` file for IP→geo lookups.
No external geo API call is made at runtime by default.

## 1. Get a free MaxMind license
1. Sign up at https://www.maxmind.com/en/geolite2/signup
2. Generate a **License Key** in: Account → Manage License Keys
3. Note your **Account ID** + **License Key**

## 2. Mount a volume on the server (Coolify)
Add a persistent volume to the **server** service:
```
/app/data  →  geoip-data
```

## 3. First-time download (one-shot)
SSH into the host (or run as a Coolify post-deploy job):
```bash
docker run --rm \
  -e GEOIPUPDATE_ACCOUNT_ID=YOUR_ACCOUNT_ID \
  -e GEOIPUPDATE_LICENSE_KEY=YOUR_LICENSE_KEY \
  -e GEOIPUPDATE_EDITION_IDS=GeoLite2-City \
  -v geoip-data:/usr/share/GeoIP \
  maxmindinc/geoipupdate:latest
```
The file lands at `/usr/share/GeoIP/GeoLite2-City.mmdb` inside the volume.

## 4. Configure the path in the admin UI
Open **/admin/map-geo → MaxMind Local** and set:
- **DB path**: `/app/data/GeoLite2-City.mmdb`
- **Auto-reload**: on (re-reads the file when mtime changes — no restart needed)

Verify with **/admin/map-geo → Diagnostics → Test resolve** using IP `8.8.8.8`.

## 5. Optional: weekly auto-update via host cron
Add to the host crontab (or as a Coolify scheduled task):
```cron
0 4 * * 1  docker run --rm \
  -e GEOIPUPDATE_ACCOUNT_ID=$ID \
  -e GEOIPUPDATE_LICENSE_KEY=$KEY \
  -e GEOIPUPDATE_EDITION_IDS=GeoLite2-City \
  -v geoip-data:/usr/share/GeoIP \
  maxmindinc/geoipupdate:latest
```
With `auto_reload: true`, the running app picks up the new file automatically.

## 6. Map tiles (separate from geo)
Tiles are configured in the **same admin page** under the **Tiles** tab.
Until you enter a `tile_url`, the Visitors map shows a "Tiles not configured"
placeholder grid (no external network call). Suggested options:
- Self-hosted TileServer GL / OpenMapTiles → enter your `https://tiles.example.com/{z}/{x}/{y}.png`
- A commercial provider (MapTiler / Mapbox / Stadia) — paste their tile URL template

## Verification checklist
- `/api/admin/map-geo/health` → `maxmind_local.ok = true`
- `/api/admin/map-geo/test-resolve` (POST, body `{"ip":"8.8.8.8"}`) → returns city/lat/lng
- Visitors page shows markers for active sessions
- `geo_ip_cache` table fills up over time (purge expired via Diagnostics)

---

## 7. Coolify: persistent volume (required)

The backend service must have a persistent volume mounted at `/app/data`:

- Coolify → your backend service → **Storages** → *Add volume*
  - Name: `geoip-data`
  - Destination path: `/app/data`

`docker-compose.yml` / `docker-compose.yaml` already declare the same mount for
local runs (`geoip-data:/app/data`). Without the volume the database is lost on
every redeploy and Map & Geo reports **degraded**.

## 8. Built-in auto-update (alternative to the geoipupdate sidecar)

Super Admin → **Map & Geo → Updates**:

- **Mode**: `auto`
- **Account ID** / **License key**: from your MaxMind account
- **Edition**: `GeoLite2-City`
- **Interval**: hours (minimum 24 — MaxMind publishes twice a week)

The updater is safe by construction:

- one replica at a time (DB-backed lease — the others skip),
- download → extract → **validate** → `rename()` into place (atomic),
- a failed or corrupt download never replaces a healthy database,
- credentials are redacted from every log line and from `last_error`.

Use **Run update now** for a manual run; the result and last status are shown in
the diagnostics panel on the same page.

## 9. Reading the diagnostics panel

`Map & Geo → MaxMind Local` shows: path, file exists, readable, usable, size,
last modified, database build date, edition, auto-update state, last run and
last error. If `enabled = on` but the file is missing, the page shows a
**degraded** banner — geo keeps working on the fallback chain
(external provider → CF country → centroid) while you fix the mount.
