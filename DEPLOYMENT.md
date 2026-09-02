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
- All files under `public/call-widget/` (separate widget; see §6).

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

The call widget under `public/call-widget/` is **not** part of the
widget-hash manifest. Its files (`l.js`, `runtime.js`, `runtime.css`,
`vendor/livekit-client.umd.min.js`) are copied as-is to the static
output and served by nginx.

Cache invalidation for the call widget relies on a query string
cache-bust appended at fetch time inside `public/call-widget/l.js`.
This is **less robust** than the chat widget's content-hash strategy:
a CDN configured to ignore query strings would defeat it.

Operational implication: when editing call-widget runtime files,
operators should additionally purge the CDN path
`/call-widget/runtime.js` and `/call-widget/runtime.css`.

The call widget's bootstrap endpoint is `/api/call-widget/bootstrap`;
log prefix is `[call-widget]`.

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
- [ ] When call-widget files were edited, CDN paths
      `/call-widget/*.js` and `/call-widget/*.css` were purged.
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