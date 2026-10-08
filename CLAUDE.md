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

## Production database (self-hosted PostgreSQL since 2026-10-07, verified)

The production backend and six workers on the Coolify at `analyticsme.site`
(apps 29, 30, 21, 18, 24, 27, 19) run `DATABASE_MODE=postgres-only` against
WebYar's own PostgreSQL 17 + pgvector on the same server:
- Coolify database `webyar-postgres` (uuid `oqzy9q4ovntam9jgf7nxzqun`),
  database `webyar`, login role `webyar_app` (member of `service_role`).
- It is reached over the `coolify` network
  (`oqzy9q4ovntam9jgf7nxzqun:5432`, `sslmode=disable`) and has no public port.
- Coolify backs it up daily at 02:13 UTC and keeps 14 dumps on the server
  only; there is no off-site copy yet.
- Super Admin → Database → Backup also backs it up (`pg_dump` from app 29 as
  the read-only role `webyar_backup`, via `BACKUP_DATABASE_URL`; local copies
  in the bind volume `/data/webyar/db-backups`; storage/FTP copies encrypted
  with `PLUGIN_SECRETS_MASTER_KEY`). See `docs/operations/DATABASE_BACKUPS.md`.
- Only `DATABASE_URL` changed in the move: secrets, pools and names are as
  before.
- The migration ledger `public._schema_migrations` is complete (the chain at
  `fa0e79d`, 250 files, plus `252_email_sender_placeholders_cleared.sql` and
  `253_workspace_panel_theme.sql`, applied 2026-10-08).
  Apply new migrations from the server with `scripts/migrate-database.sh`
  against `webyar`. The database container runs on `vps-50cc1602`, not on
  the Coolify host `analyticsme.site`; there, as `postgres`, inside the
  container: `docker exec -e DATABASE_URL=postgresql://postgres@/webyar
  oqzy9q4ovntam9jgf7nxzqun bash <copied scripts/migrate-database.sh>`.
- Kit, measured cutover, backups and rollback:
  `/root/webyar-rollout/20261007-selfhosted/README.md` (root only).
- Runbook: `docs/operations/PRODUCTION_DATABASE_MODE.md`.

The hosted Supabase project `bdycuenbjztkgnaqonfm` still holds WebYar's data
as of the cutover snapshot (2026-10-07 05:41:03 UTC). It is the fallback and
receives no writes. Do not write to it, pause it or delete it.
Going back to it loses everything written since, unless that data is moved
back first, which needs Supabase's `postgres` role.

App 10 (an older backend deployment) used to run the same background
tickers on Supabase over REST. The owner stopped it on 2026-10-07. Do not
start it again unless it is pointed at the self-hosted database.

Deploy these apps only through Coolify's queue (a push, the Deploy button or
the kit's `deploy.php`), never its API create-and-deploy endpoints or MCP
`Deploy` tool. To stop an app for maintenance, use Coolify's
`StopApplication` with `dockerCleanup=false, removeContainers=false` (the
kit's `apps.php`). The defaults remove the container and prune its image.
While the backend is stopped, `https://api.webyar.ai` answers 503 (Coolify's
catch-all), so plugin events and webhooks are retried.

Never change `PLATFORM_SIGNING_SECRET` or `PLUGIN_SECRETS_MASTER_KEY`;
`DATABASE_URL` and `DATABASE_MODE` are set and removed together.

History, kept for reference:
- 2026-10-05 to 2026-10-07: Supabase's session pooler, pooler cap 15. The
  2026-10-05 kit `/root/webyar-rollout/20261005-postgres-only/` holds the
  rollback to Supabase REST and the rebuilt rollback images.
- The 2026-10-06 rehearsal (stopped database `webyar-rehearsal-pg17`, volume
  kept) found that the session pooler ignores `PGOPTIONS` and URL `options`.
  When running a tool against Supabase, set the role by statement.
- Production functional test passed 2026-10-06 (28/28) with an
  owner-authorized test account, before the move. To rerun, recreate the
  root-only `/root/webyar-test-account.env` and use the 2026-10-05 kit's
  `functional_test.mjs` / `functional_cleanup.mjs`.
