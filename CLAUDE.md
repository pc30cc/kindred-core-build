# Notes for Claude Code sessions

## Running the Android app for someone to see (Mac)

The owner's MacBook Pro is reachable through Desktop Commander as
`rass-MacBook-Pro-7.local`. To put the app on its screen, use the launcher
that is known to show a picture there:

```sh
~/dev/webyar-emulator.command
```

It starts `Webyar_API36` with `-gpu swiftshader_indirect` (flag, not
`config.ini`), waits for boot and opens `com.webyar.ai`. Do not use
`Webyar_API37` (SurfaceFlinger crash-loop) or `-gpu host` (black window), and
keep `hw.display1.*` at 0 in the AVD (a second display halves the phone).
Build from a separate worktree (`~/dev/kcb-ui-preview`), never from the
owner's checkout in `~/dev/kindred-core-build`, which is on their own branch.

Why each of those holds, with measurements: `docs/ANDROID_LOCAL_DEV.md`.

## The iOS app in Xcode on the Mac

`~/dev/kcb-ios-preview` is the copy of the iOS app (`ios/Webyar`)
open in the owner's Xcode. A LaunchAgent (`ai.webyar.xcode-sync`, script
`~/dev/webyar-xcode-sync.sh`, log `~/dev/webyar-xcode-sync.log`) moves it to
the latest `origin/main` every 3 minutes and regenerates the Xcode project, so
whatever is merged shows up there on its own. It skips the update while a
tracked file there has local edits. Do not check other branches out in that
folder: build and test a PR in a separate worktree (e.g. `~/dev/kcbi-pr`).
Turn the sync off with `launchctl bootout gui/$(id -u)/ai.webyar.xcode-sync`.

## Production server: `vps-50cc1602` (since 2026-10-07, verified 2026-10-08)

WebYar runs on `vps-50cc1602` (public IP `192.99.68.134`, Desktop Commander
device `47ef9de3-8e34-4b08-89c6-f38ab1b6aabc`), under that server's own
Coolify 4.4.1. Its dashboard has no domain: `http://192.99.68.134:8000`.
The old Coolify on `analyticsme.site` is no longer used for WebYar (owner,
2026-10-08): do not deploy, start, stop or change anything there.

Coolify project "WebYar App" (repo `pc30cc/kindred-core-build`, branch
`main`, GitHub App "CustomerCore"):
- 24 WebYar Fronted (`app.webyar.ai`), 25 WebYar Express Backend
  (`api.webyar.ai`), 26 WooCommerce Worker: auto-deploy on every push to
  `main`.
- 15 Centrifugo, 16 LiveKit, 17 Intelligence Worker, 18 Source Sync
  Worker, 19 Plugins Channels (`channels.webyar.ai`), 20 Channels-Worker,
  21 AI Runtime (`ai.webyar.ai`), 22 Regression AI Worker, 23 Seo-Crawler:
  auto-deploy off, so a push does not update them; queue them by hand when a
  change needs them.
- Coolify builds two apps at a time, so after a merge the whole set (with
  RESPOK's) takes about 15 minutes. A deploy that has not appeared yet is
  usually still queued: look at `application_deployment_queues` in the
  `coolify-db` container before assuming it failed.

The same server also runs:
- RESPOK, a second rebranded copy of this repo (Coolify projects "RESPOK" and
  "RESPOK App", apps 28-41, `*.respok.app`) with its own database
  `respok-postgres` (`k6pnithcamskd4trrpo6jabv`). Its apps 32 (backend),
  33 (frontend), 39 (WooCommerce) and 40 (DB Migrator) also auto-deploy on
  every push to `main`. Never point a WebYar app at RESPOK's database or the
  other way round.
- The landing pages: app 1 `webyar.ai` (repo `pc30cc/webyarlanding`), app 27
  LimerLanding `limer.tr` (repo `pc30cc/lart`), app 28 RESPOK Landing.
- The desktop downloads of both brands (since 2026-10-09): container
  `app-downloads` (nginx, outside Coolify), Traefik file
  `/data/coolify/proxy/dynamic/app-downloads.yaml`, files in
  `/data/app-downloads/{webyar,respok}`, mirrored every 5 minutes from each
  brand's release repos by the timer `app-downloads-sync`. It serves zips:
  `app.webyar.ai/downloads/Webyar-Windows.zip` (the installer) and
  `Webyar-Mac.zip` (the DMG), plus `windows/` (the Windows apps' update feed),
  and the same as `RESPOK-*` on `app.respok.app`. The old `-Setup.exe` and
  `-Mac.dmg` links redirect to the zips (since 2026-10-09). See
  `deploy/app-downloads/README.md`. RESPOK's overlay
  section 5b keeps its app settings (feeds, bundle ids) RESPOK's
  (`/root/respok/overlay-apps-test.sh` proves it).

### Deploying and stopping

Deploy only through Coolify's queue: a push, the Deploy button, or the move
kit's `/root/webyar-move/deploy.php` (`DEPLOY_UUID`, `DEPLOY_COMMIT`;
`ROLLBACK=1` reuses the existing image). Never use Coolify's API
create-and-deploy endpoints or the MCP `Deploy` tool. To stop an app for
maintenance, use Coolify's `StopApplication` with `dockerCleanup=false,
removeContainers=false`; the defaults remove the container (`docker rm -f`)
and queue Coolify's Docker cleanup, which prunes build cache, unused images
and older app images. This server has no helper script for it yet. The kit's
`db_action.php` stop removes the database container (the volume stays).
While the backend is stopped, `https://api.webyar.ai` answers 503 (Coolify's
catch-all), so plugin events and webhooks are retried.

Never change `PLATFORM_SIGNING_SECRET` or `PLUGIN_SECRETS_MASTER_KEY`;
`DATABASE_URL` and `DATABASE_MODE` are set and removed together.

### Disk

The root disk (72G, Docker included) holds about 50G after a cleanup. A
deploy round after a merge adds about 12 GB of build cache plus the new images
(68% to 91% on 2026-10-08), a LimerLanding deploy about 5 GB. `/` has no
reserved blocks, so a full disk stops Postgres too.

- Coolify's Docker cleanup (server `localhost` → Docker Cleanup) checks every
  5 minutes (`*/5 * * * *`, force off, threshold 75%; since 2026-10-08, before
  that forced once a day at 00:00). At 75% or more it removes the build cache,
  unused images that belong to no app, and each app's images beyond the 2
  newest. Containers are named `<uuid>-<timestamp>`, which Coolify's check for
  the running image does not match, so 2 means the running image and one
  before it: a `ROLLBACK=1` further back rebuilds from git. Runs are listed in
  `docker_cleanup_executions` (coolify-db); a failed run alerts Telegram.
- Keep "delete unused volumes/networks" off; that keeps the database volumes
  safe.
- `webyar-whmcs-test:php83` was built on this server and cannot be pulled. If
  its container is removed, the next cleanup deletes it, so stop that stack
  with `docker compose stop`, not `down` (its Dockerfile is in
  `/opt/webyar-whmcs-test/`).
- Telegram's high-disk alert (Sentinel, checked every minute) fires above 80%,
  at most once a day until usage drops to 75%. Keep the cleanup threshold below
  it, or every deploy round alerts before the cleanup runs. Changes and
  manual cleanups: `/root/disk-cleanup-20261008.log`.

### Database

- Coolify database `webyar-postgres` (uuid `oqzy9q4ovntam9jgf7nxzqun`,
  `pgvector/pgvector:pg17`: PostgreSQL 17.11, pgvector 0.8.7), database
  `webyar`. It is on the `coolify` network only and has no public port.
- The backend (25) and the workers 17, 18, 20, 22, 23 and 26 run
  `DATABASE_MODE=postgres-only` as `webyar_app`
  (`oqzy9q4ovntam9jgf7nxzqun:5432/webyar`, `sslmode=disable`). `webyar_app`
  is NOINHERIT, member of `service_role`; `webyar_backup` is read-only.
- Backups: Coolify dumps `webyar` daily at 02:13 UTC and keeps 14 copies in
  `/data/coolify/backups/databases/root-team-0/webyar-postgres-oqzy9q4ovntam9jgf7nxzqun/`.
  There is no off-site copy (no S3 storage in Coolify). Super Admin →
  Database → Backup also backs it up (`pg_dump` from the backend as
  `webyar_backup` via `BACKUP_DATABASE_URL`, local copies in the bind volume
  `/data/webyar/db-backups`); see `docs/operations/DATABASE_BACKUPS.md`.
- Migrations:
  - WebYar's database is never migrated automatically. Apply new files by hand
    on `vps-50cc1602`, before merging the code that needs them:
    1. Put `scripts/migrate-database.sh` and the new files in a folder with
       the repo's layout (`scripts/`, `database/migrations/`), e.g.
       `/root/webyar-migrate-253/`.
    2. Dry-run the SQL inside `BEGIN ... ROLLBACK`.
    3. Copy the folder into the container (the host folder is not visible
       there, and the script reads `../database/migrations` next to itself):
       `docker cp /root/webyar-migrate-253 oqzy9q4ovntam9jgf7nxzqun:/tmp/m253`.
    4. Run it as `postgres`:
       `docker exec -e DATABASE_URL=postgresql://postgres@/webyar -e PGOPTIONS='-c lock_timeout=5s' oqzy9q4ovntam9jgf7nxzqun bash /tmp/m253/scripts/migrate-database.sh`,
       then remove `/tmp/m253` from the container.
  - The ledger `public._schema_migrations` is complete: the chain at
    `fa0e79d` (250 files), plus `252_email_sender_placeholders_cleared.sql`,
    `253_workspace_panel_theme.sql` (2026-10-08 07:08 UTC),
    `254_workspace_panel_theme_options.sql` (2026-10-08 13:27 UTC),
    `255_billing_v2_renewal_currency.sql` (2026-10-08 21:42 UTC),
    `256_billing_v2_notification_currency.sql` (2026-10-08 22:15 UTC),
    `257_app_settings_per_edition.sql` (2026-10-09 16:11 UTC) and
    `258_app_review_status_per_edition.sql` (2026-10-09 17:06 UTC). Both were
    also applied by hand to RESPOK's database, whose overlay section 5b/5c now
    touches only its `international` rows.
  - RESPOK's database is migrated automatically: its DB Migrator (app 40)
    runs `scripts/migrate-database.sh` on every push to `main`, then
    `/data/respok/migrator/overlay.sql`. Since 2026-10-08 the overlay is a
    guard only: it replaces a value only while it is WebYar's (its name or
    domains, Persian/Rial defaults) or missing. It never resets what the
    Super Admin sets (plans and their visibility, logos, texts, site mode,
    languages); it used to, on every deploy. Before changing it, dry-run it
    with its `COMMIT;` turned into `ROLLBACK;`
    (`/root/respok/overlay-guard-test.sh` proves both directions).
  - The database has no public port, so `deploy-migrations.yml` cannot reach
    it; keep the `DATABASE_URL` Actions secret unset.
- The move kit (import, cutover log, `deploy.php`, `db_action.php`,
  `verify.sh`) is `/root/webyar-move/`. `docs/operations/PRODUCTION_DATABASE_MODE.md`
  was written before the move: its Coolify app ids and `/root/webyar-rollout/`
  kit paths refer to the old server.

The hosted Supabase project `bdycuenbjztkgnaqonfm` still holds WebYar's data
as of the cutover snapshot (2026-10-07 05:41:03 UTC). It is the fallback and
receives no writes; no running container refers to it. Do not write to it,
pause it or delete it. Going back to it loses everything written since,
unless that data is moved back first, which needs Supabase's `postgres` role.

History, kept for reference:
- 2026-10-07 05:41 UTC: WebYar's data moved from Supabase to the self-hosted
  `webyar-postgres` (then on the old server).
- 2026-10-07 14:12-14:24 UTC: the apps and the database moved to
  `vps-50cc1602` with the same Coolify uuids (`/root/webyar-move/cutover_new.log`).
  App ids changed: the backend is now 25, not 29.
- 2026-10-07 21:37-23:30 UTC: RESPOK was cloned from WebYar's databases and
  deployed (`/root/respok/`).
- 2026-10-05 to 2026-10-07: Supabase's session pooler, pooler cap 15. The
  2026-10-06 rehearsal found that the session pooler ignores `PGOPTIONS` and
  URL `options`. When running a tool against Supabase, set the role by
  statement.
- Production functional test passed 2026-10-06 (28/28) with an
  owner-authorized test account, before the move.
