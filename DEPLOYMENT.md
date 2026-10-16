# Deployment, Widget Manifest, and Cache Audit

> **Documentation only.** No build, deploy, manifest, or asset
> behavior has been changed. This file describes the system **as it
> exists today** and lists operational risks that operators should be
> aware of.

---

## 1. Deployment topology (current)

The codebase supports three concrete topologies. All three are
exercised in production today.

### 1.1 Split production deploy (recommended; documented in `COOLIFY_DEPLOY.md`)

```text
Browser ── https://example.com ───────► Frontend (nginx, Dockerfile.frontend)
Browser ── https://api.example.com ───► Backend  (Express, Dockerfile.server)
         │
         └── widget-manifest.json fetched server→server over HTTP

Workers       (Dockerfile.worker, one container per WORKER_KIND)
Centrifugo    (own service; docker-compose.centrifugo.yml)
LiveKit       (own service; deploy/livekit/)
```

Workspace invitations require a dedicated `WORKER_KIND=invitations` container.
Configure distinct 32-byte `INVITATION_LINK_SECRET` and
`INVITATION_OTP_PEPPER` values, `INVITATION_LINK_KEY_VERSION`, optional old
keys in `INVITATION_LINK_SECRET_RING`, and an authoritative
`SELF_HOST_SEAT_LIMIT` (unless billing mode is explicitly unlimited).

Invitation schema rollout is intentionally two-phase: apply the normal
`database/migrations/` chain first; after every API/UI replica uses v5.1, run
`database/cutover/080_workspace_invitations_v51_fence.sql`. Verify and retain
the rollback window, then run `081_workspace_invitations_v51_contract.sql`.
The fence drops the legacy plaintext default, revokes v1 pending records and
erases legacy token values; the contract irreversibly removes legacy columns.

The frontend serves `/widget/...` static assets; the backend reads
`widget-manifest.json` over HTTP via `WIDGET_ASSET_BASE_URL` /
`WIDGET_MANIFEST_URL`.

### 1.2 Combined / single-host deploy

`Dockerfile` (root) bundles frontend and backend together. The backend
can read the manifest from local disk; `WIDGET_ASSET_BASE_URL` is not
required.

### 1.3 Local development

`docker-compose.yaml` builds frontend (`Dockerfile.frontend`) and
backend (`Dockerfile.server`) and exposes them on `:80` and `:3001`
respectively. Workers, Centrifugo, and LiveKit are run separately.

---

## 2. Frontend build output

`npm run build` runs:

1. `vite build` — produces the SPA into `dist/`.
2. `node scripts/widget-hash.js` — copies `public/widget/*` into
   `dist/widget/` with content-hashed filenames and writes
   `dist/widget/widget-manifest.json`.
3. `node scripts/call-widget-hash.js` — the call widget's own step
   (§6): content-hashed copies of `public/call-widget/*`, their names
   written into `dist/call-widget/l.js`.

Hashed files (8-char MD5 prefix):

- `runtime.js`
- `runtime.css`
- `runtime-chat.js`
- `runtime-kb.js`
- `runtime-call.js`
- `runtime-rt-centrifugo.js`
- `runtime-rt-supabase.js`
- `runtime-rt-resolver.js`
- `vendor/livekit-client.umd.min.js`

Stable / never hashed:

- `loader.js` — the visitor's `<script>` tag points at this and must
  remain at a stable URL.
- `call-widget/l.js` — the call widget's loader, also at a stable URL
  (its own build step and cache policy: §6).

The hash script enforces several **fail-loud** invariants. The build
exits non-zero if:

- The source directory is missing.
- `widget-manifest.json` is missing after writing.
- `runtime-call.js` is missing from the manifest or build output.
- The self-hosted LiveKit vendor bundle is missing.

These are intentional. A "successful" build with a missing widget
asset would only be discovered by visitors at runtime.

---

## 3. Backend manifest resolution

Implemented in `server/services/widget/manifest.ts`. Strategy in
order:

1. **Local filesystem search** — works for combined / dev deploys.
2. **HTTP fetch** from `WIDGET_MANIFEST_URL` or
   `${WIDGET_ASSET_BASE_URL}/widget/widget-manifest.json` — required
   for split deploys where the backend cannot see nginx's filesystem.
3. **Fallback** — return the unhashed asset names with
   `loaderVersion: 'unresolved'`.

Cache TTL is intentionally short (`CACHE_TTL_MS = 2_000`). The remote
fetch is conditional (`If-None-Match`) — a 304 is cheap. This trades
a small number of cheap round trips for near-zero staleness after a
CDN purge.

If the HTTP fetch fails, the previous good manifest is kept rather
than regressing to the fallback.

### 3.1 Diagnostics

Health endpoint:

```sh
GET /api/health/widget
```

Returns `getManifestDiagnostics()`. Operators verify after every
deploy:

- `manifest.source` should start with `remote:` (split) or `fs:`
  (combined). `unresolved` means the manifest was not located.
- `loaderVersion` should be a real hash; `'unresolved'` is a deploy
  bug.

The widget-config response (`/api/widget/config`) refuses to
silently fall back to unhashed URLs; the loader, in turn, **refuses**
to load anything but the configured hashed URLs (`public/widget/loader.js`
contains a deliberate strict block on this — falling back to
`/widget/runtime.js` would pin a year-old runtime via long-lived CDN
cache headers and was the documented "old style sometimes appears"
regression).

---

## 4. Cache invalidation contract

1. The visitor `<script>` tag points at the **stable** `loader.js`
   URL, served with **short** cache headers.
2. `loader.js` calls `/api/widget/config` and receives **hashed
   URLs** for everything else.
3. Hashed assets are served with **immutable, 1-year** cache headers.
   Renaming the hash is the cache-invalidation mechanism.
4. After a deploy, the new hashed URLs flow into bootstrap responses
   automatically (subject to the 2 s manifest cache + any CDN cache
   in front of `/api/widget/config`).
5. The `manifest-invalidate` deploy hook (called via
   `invalidateManifestCache()` in `server/index.ts`) is the
   recommended belt-and-braces step.

### Stale-asset failure modes (and why they happen)

| Symptom | Likely cause |
|---|---|
| Visitors see old widget after a CSS/JS edit | Backend manifest cache (or its upstream CDN) still returning the old hash. Wait 2 s + purge `/api/widget/config` at the CDN. |
| `/api/health/widget` shows `loaderVersion: unresolved` | Split deploy missing `WIDGET_ASSET_BASE_URL` / `WIDGET_MANIFEST_URL`, or the URL is wrong / unreachable. |
| Visitor browser keeps old hash forever | Loader was served with too-long cache headers, **or** the CDN ignored cache-bust query parameters. The hashed-asset contract relies on the loader being short-cached. |
| Operator panel preview still shows the old template after switching | The admin preview thumbnails are static React mocks. They are not the runtime. The runtime change requires a frontend rebuild + manifest refresh. |
| New widget template registered in DB but visitor still falls back to default | The deployed runtime bundle is older than the slug. The visitor's browser must download a new hashed `runtime.js` that registers the slug. Until rebuild + redeploy, runtime falls back to `default`. |

---

## 5. Split frontend/backend assumptions

Operators running split deployments must additionally:

- Ensure `CORS_ORIGINS` on the backend includes the frontend origin.
- Ensure `WIDGET_ASSET_BASE_URL` (or `WIDGET_MANIFEST_URL`) is set on
  the backend and resolvable from the backend container's network.
- Ensure the frontend is reachable from the public internet (the
  hashed runtime assets are loaded by the **visitor's browser**, not
  by the backend).
- Rebuild the frontend image whenever any `VITE_*` build arg
  changes — Vite env vars are baked at build time.
- Re-trigger backend manifest cache invalidation after a frontend-only
  redeploy (or rely on the 2 s TTL).

---

## 6. Call-widget asset serving

The call widget (`public/call-widget/`) has its own build step,
`scripts/call-widget-hash.js`, run by `npm run build` after
`widget-hash.js`:

- `runtime.js`, `runtime.css` and every `presentation-*.js|css` are
  minified and written twice: as `<name>.<sha256/12>.<ext>` and under
  their fixed name (the same bytes). Level-9 `.gz` copies of the hashed
  files serve nginx's `gzip_static`.
  `dist/call-widget/call-widget-manifest.json` lists them.
- Those names, and two files the chat widget's build already hashes
  (`dist/widget/widget-manifest.json`: the fonts stylesheet and
  `vendor/livekit-client.umd.min.<hash>.js`, the same SDK bytes, so both
  widgets share one cache entry), are written INTO `l.js` (an esbuild
  `define`). `l.js` and the files it names ship in the same
  frontend image, so a loader never names another deploy's file, and
  nothing about them comes from the backend.

nginx (`location ^~ /call-widget/` in `nginx.conf.template`):

| Path | Cache |
|---|---|
| `<name>.<12 hex>.js` / `.css` | `public, max-age=31536000, immutable`; a name this image does not have is a `no-store` 404 (`@missing_widget_asset`) |
| `l.js` and the fixed names | `no-cache, must-revalidate` (the browser revalidates on every use: ETag, 304) + `CDN-Cache-Control` / `Cloudflare-CDN-Cache-Control: no-store` |
| `vendor/livekit-client.umd.min.js` (fixed name) | a year, as before (older loaders, and the fallback below); a miss is a `no-store` 404 |

**No CDN purge is needed after a call-widget change**: `l.js` is never
reused without revalidation and every file it names is
content-addressed. (It used to be the opposite: every file `no-store`
plus a per-load `&t=` token, and a purge after each edit.)

How a page loads it:

- A built `l.js` starts the registry, the presentation and the runtime
  at once (ordered `async = false` scripts), in parallel with the
  bootstrap, and mounts when both are in. A returning visitor has them
  cached: a page view costs the `l.js` revalidation and the bootstrap.
- Stylesheets go only into the widget's shadow root; the host stays
  hidden until both have loaded (10 s at most). Font faces come from the
  build's fonts stylesheet (else the bootstrap's `font_style_url`),
  linked once per page as `#gs-presentation-fonts`.
- A hashed script that is not there (a stale `l.js`, or the other
  container during a rolling deploy) makes `l.js` load all three again by
  their fixed names with `?v=<assets_version>&t=<now>`; a missing hashed
  stylesheet, or the hashed LiveKit SDK, is retried once by its fixed
  name.
- A bootstrap answered with a rate limit (429), a server error (5xx) or
  not at all is asked again once, after its `Retry-After` (at most 10 s;
  2 s when it names none) plus up to half a second; then the loader gives
  up quietly, as before.
- When the bootstrap says the widget is off (disabled, unknown
  workspace, site not allowed; not a 5xx or 429), `l.js` remembers it in
  the site's `localStorage` (`ccw_off:<workspace>:<api base>`) and next
  time downloads nothing until the bootstrap says it is on again.

The fixed names stay for older loaders still on customers' pages or in
their caches, the operator preview (Call Center settings) and the
fallback above.

The backend image also serves the raw `public/call-widget/`
(`Dockerfile.server`) for old snippets that point at the API origin. That
`l.js` has no build names: it waits for the bootstrap and loads the fixed
names with `?v=<assets_version>`, a hash of those files in the same image
(`CALL_WIDGET_ASSETS_VERSION`), served `no-cache` by `server/index.ts`.

The bootstrap, `/api/call-widget/bootstrap` (log prefix
`[call-widget]`), runs on every page view, so:

- Its workspace-level part (settings, platform switches, provider,
  recording, departments, ringback, avatar, edition, template, credit) is
  kept per process for 30 s (`server/services/callCenter/bootstrapCache.ts`),
  keyed by the workspace only (never by anything else the request
  carries; the URLs built from the loader's asset origin are made per
  request): concurrent misses share one load, at most 5000 workspaces,
  failures not kept. A key that names no workspace is kept 10 s in its own
  1000-entry map, so made-up ids cannot push real workspaces out. A call-center settings save, a
  platform call-center settings change and the admin cache invalidation
  drop it in that process at once; other processes see a change within
  30 s.
- After a full visitor pass it sets `dvccp`, a signed, HttpOnly,
  Partitioned, 60-second cookie scoped to the bootstrap path
  (`server/services/callCenter/presenceTicket.ts`). While it holds for
  the same visitor cookie and network, the next bootstraps skip the
  visitor queries (an identified visitor's contact is read by key). The
  Online Visitors row is still refreshed by the next full pass, at most a
  minute later, as before.
- A page view never creates a `call_center_settings` row.
- Preflights carry `Access-Control-Max-Age: 7200`.

---

## 7. Multi-deployment compatibility risks

Below are concrete risks observed in the current implementation.
None of them are bugs to fix as part of this audit — they are
operational notes.

1. **Two manifest sources of truth.** Filesystem and HTTP. If both
   resolve in a misconfigured combined-then-split migration the
   filesystem path will win and may be stale. Mitigation: in split
   deploys, ensure the backend container does **not** ship the
   frontend's `dist/widget/` directory.
2. **Loader cache horizon.** `loader.js` is intentionally cached
   short, but if a CDN/proxy front of the frontend overrides the
   `Cache-Control` header, the cache horizon for fixing widget bugs
   becomes the override. Audit nginx/CDN policy for `/widget/loader.js`.
3. **Hash collisions on tiny edits.** The 8-char MD5 prefix has a
   1 in ~4 billion collision rate per file pair. In practice this is
   not a real risk for this codebase's edit cadence, but the
   manifest's `loaderVersion` (full content hash of `loader.js`) is
   the secondary fingerprint for diagnostics.
4. **Vendor SDK upgrades.** The self-hosted LiveKit bundle
   (`vendor/livekit-client.umd.min.js`) must be present in the build
   — `widget-hash.js` aborts the build if it is missing. CDN
   fallbacks are explicitly forbidden by architecture rules.
5. **Migrations split between two directories.** Operators bringing
   up a new self-host environment must apply
   `database/migrations/00X_*.sql` (numbered, ordered) **and** any
   incremental `supabase/migrations/<timestamp>_*.sql` produced
   afterwards. Skipping either leaves the schema partial.
6. **Worker isolation.** All worker kinds share one container image.
   A bug in one kind's code can ship to all kinds simultaneously.
   Operators should run one Coolify service per kind so a single bad
   loop cannot starve the others.
7. **Cloudflare caching of `/api/widget/config`.** If a CDN sits in
   front of the API, the 2 s server-side TTL is moot — visitors will
   see whichever response the CDN cached. Either set a `Cache-Control`
   on `/api/widget/config` that the CDN respects, or purge that path
   in the deploy hook.

---

## 8. Compatibility-safe recommendations (documentation-level)

These do not change code. They are operator-level checklists.

### Pre-deploy

- [ ] `npm run build` ran cleanly (no `[widget-hash] FATAL ...` lines).
- [ ] `dist/widget/widget-manifest.json` exists and lists every
      hashed asset.
- [ ] In split deploys, the backend env has `WIDGET_ASSET_BASE_URL`
      or `WIDGET_MANIFEST_URL` set and the URL is reachable from
      inside the backend container.
- [ ] `CORS_ORIGINS` lists every frontend origin.

### Post-deploy

- [ ] `curl https://api.example.com/api/health/widget` shows
      `manifest.source` starting with `remote:` or `fs:` and
      `loaderVersion` is a real hash.
- [ ] CDN paths `/widget/loader.js` and `/api/widget/config` are
      either uncached or were purged.
- [ ] `curl -sI https://<app>/call-widget/l.js` shows
      `Cache-Control: no-cache, must-revalidate`, and the hashed names in
      it (`dist/call-widget/call-widget-manifest.json`) answer 200 with
      `immutable`. No CDN purge is needed for the call widget (§6).
- [ ] If a widget template slug was added, the new hashed
      `runtime.js` is reachable at the URL returned by
      `/api/widget/config`.

### When debugging "old widget shows up"

1. Check `/api/health/widget` first.
2. Compare the hash returned by `/api/widget/config` to what the
   visitor's browser loaded (DevTools → Network).
3. Check the CDN cache state for both the loader and the bootstrap
   API.
4. Confirm the frontend image was rebuilt (Vite envs are baked).
5. Confirm the backend manifest cache (TTL 2 s) is not pinned by an
   upstream CDN cache.

---

## 9. Confirmation

No deployment script, build script, manifest reader, runtime asset,
route, or env var was modified by this audit. The behavior described
above is the behavior already implemented in:

- `scripts/widget-hash.js`
- `server/services/widget/manifest.ts`
- `server/routes/widget.ts`
- `server/routes/health.ts`
- `server/index.ts`
- `public/widget/loader.js`
- `public/widget/runtime.js`
- `public/call-widget/l.js`
- `Dockerfile`, `Dockerfile.frontend`, `Dockerfile.server`,
  `Dockerfile.worker`, `docker-compose.yaml`