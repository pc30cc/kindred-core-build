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

## Production database connection (since 2026-10-05, verified)

The production backend and six workers on the Coolify at `analyticsme.site`
run `DATABASE_MODE=postgres-only` against the hosted Supabase project's
PostgreSQL, as login role `webyar_app` through the session pooler (port 5432).
Switched 2026-10-05 (`687e6fe`); the AI billing decimal fix (`6960097`, #266)
is on 29, 30, 28, 18, 24 and 19 since 2026-10-06. The older second backend
(Coolify app 10) still uses Supabase REST.
Connection budget: the pooler admits 15 connections (measured); pools are
backend 3 and 1 per worker (9 steady, measured), and Coolify runs at most 2
queued deployments at once, each running old and new containers side by side,
so the bound is 9 + 3 + 1 = 13 (calculated; measured peaks 13 and 12). Keep
`steady + the two largest pools <= 13` when changing a pool, and deploy these
apps only through Coolify's queue (a push, the Deploy button or the kit's
`deploy.php`), never its API create-and-deploy endpoints or MCP `Deploy` tool.
Production functional test passed 2026-10-06 (28/28: login, visitor message
and operator reply delivered live once over Centrifugo, duplicate replays,
attachment round trip and access rules) with an owner-authorized test account
(its credentials file was removed afterwards; to rerun, recreate the root-only
`/root/webyar-test-account.env`, run the kit's `functional_test.mjs` and clean
up with `functional_cleanup.mjs`).
Never change `PLATFORM_SIGNING_SECRET` or `PLUGIN_SECRETS_MASTER_KEY`;
`DATABASE_URL` and `DATABASE_MODE` are set and removed together. Do not run
`migrate-database.sh`, a baseline or `move-data.sh` against production.
Runbook, measured state and exact rollback commands:
`docs/operations/PRODUCTION_DATABASE_MODE.md`; the rollback kit (snapshot,
scripts, credential) is root-only on the server in
`/root/webyar-rollout/20261005-postgres-only/`. Coolify's hourly Docker
cleanup deletes images no container uses, so `rb` makes Coolify rebuild a
rollback commit whose image is gone. Every rollback commit was rebuilt and
start-checked in isolation on 2026-10-06 (not a production rollback); the
images are kept as files in the kit's `rebuild/images/` and
`rebuild/rollback_load.sh A|B`, run just before the `rb` lines, makes Coolify
reuse them instead of building.
