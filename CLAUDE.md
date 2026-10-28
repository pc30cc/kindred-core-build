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

## Before building an Android release

WebYar 1.6 (`versionCode` 27) is on Cafe Bazaar (since 2026-10-15) and the
site; RESPOK 1.0.2 (`versionCode` 3) is on the site only. Read
`docs/ANDROID_RELEASE.md` → "Before the next release" first: the next WebYar
build is the first from the brand-neutral sources and must keep
`com.webyar.ai`, be signed with `~/dev/webyar-release.jks` and use a
`versionCode` above Bazaar's.

## Widget templates (chat widget and call center widget)

Any new or changed widget design (template, skin, theme, fonts) follows
`docs/operations/WIDGET_TEMPLATE_RULES.md`, and the procedure is the project
skill `widget-template` (`.claude/skills/widget-template/SKILL.md`). In short:
no font bytes or `@font-face` in template stylesheets (faces only in the
document-level fonts stylesheet, woff2 with `unicode-range`), no network or
storage in renderers, only hashed file names without `?v=`, the size budgets
in `src/test/widget/templateRules.test.ts`, which checks every template in
`shared/widgetTemplates.ts`. Never raise a budget without the owner's say.

WebYar's chat widget has three templates: `default` (the original look; it
may change since 2026-10-21 (owner), but keeps its look and the budgets),
`t1` and `t2` (the 2026-10 designs, see
`docs/chat-widget-handoff/IMPLEMENTATION_NOTES.md`). Ids are neutral; the
names people see live in the Super Admin's catalog (migration 275), and a
template is worn only once the Super Admin enables it. Persian text in the
widget is IRANSans only (owner). Core behaviour only t1/t2 use lives in the
lazy `public/widget/runtime-ext.js`, gated on the renderer's `features`, so
`default` visitors never download it. The rating card follows the closed line
in every template (the template's `csat` option, on by default; t2's five
faces, stars in `default` and `t1`). Its flow is Core's
(`public/widget/runtime.js`, `ctx.rating`), so `default` rates without the
lazy modules, and a renderer only draws `view.csat`.

The call center widget (`public/call-widget`) wears the 2026-10 handoff
designs: template `default` is WebYar's (skin `presentation-default.css`),
`intl` is RESPOK's (`presentation-intl.css`, over the same renderer). A page
load is the loader, the registry, the engine, the core
(`presentation-default.js`, which draws the launcher), `runtime.css`, the skin
and the fonts stylesheet; the panel (`presentation-default-panel.js` and
`.css`) loads on the visitor's first intent (rules doc, "Call widget panel").
Its budgets are `BUDGETS.call` in the same test. The
pixel gate is `e2e/callWidgetScreens.spec.ts` (Tier A, both brands, against
the handoff's boards). Decisions, deviations and rollout:
`docs/call-widget-handoff/IMPLEMENTATION_NOTES.md`. Members join a call room
as `operator:<opaque reference>` (or `admin:`, `internal:`) with their profile
name only (`server/services/calls/operatorIdentity.ts`): never put a
user id or an e-mail in a LiveKit identity, name or metadata (the visitor
sees them). The desktop apps' side of that is
`docs/call-widget-handoff/desktop-transfer-handover.patch`, for their next
release.

## Avatars: a silhouette or the workspace mark, never a letter (owner, 2026-10-24)

An operator or team member without a photo shows the platform's person
silhouette, and a workspace without a logo shows the workspace (storefront)
mark: never initials or a first letter, on every surface (chat widget, call
widget, web panel, the native apps) and in every new design or change. The
two glyphs live once in `shared/avatarGlyphs.ts`; the guards are
`src/test/widget/avatarGlyphs.test.ts`, `src/test/layout/noLetterAvatars.test.tsx`
and `src/test/native/avatarGlyphs.test.ts`. Visitors and contacts in the
operator panel keep their own look.

## The knowledge base on the owner's Mac (owner, 2026-10-24)

`~/Desktop/WebYar-RESPOK/knowledge-base` on `rass-MacBook-Pro-7.local` (inside
the iCloud folder `WebYar-RESPOK`) is the project's lasting memory: the
owner's decisions (`00-decisions/DECISIONS.md`), the roadmap (`01-roadmap`),
research, evaluations, designs with their screenshots, reports, security
fixes and the deploy log. After every step (a decision, a design, a PR merged
and deployed) update it, in Persian for the owner. Text goes through Desktop
Commander's `write_file`; images go through a temporary commit on your
designated branch (only while no PR is open from it) that the Mac fetches
(`git -C ~/Desktop/WebYar-RESPOK/code/kindred-core-build fetch --depth 1 origin <branch>`,
then `git archive FETCH_HEAD knowledge-base | tar -x -C ~/Desktop/WebYar-RESPOK/`),
after which the branch is reset. Never write a secret there.

## Chat routing

Who may receive and answer chats is `shared/chatRoles.ts` only: the owner and
the team roles receive chats (each with a "Receive chats" switch, on by
default), staff never do, an admin may open the Inbox and supervise. A new
chat goes to the visitor's previous operator when they can take it
(last-agent routing), else to the chosen department's available operators,
else the whole team, by the workspace's mode (Auto: least busy; Round robin;
Manual: the queue), never past a member's maximum of open chats. The routing
ticker (`server/services/chatRoutingTicker.ts`, every 30 s, leased) hands out
waiting chats and the first-response timeouts. A quiet conversation of any
chat channel (the widget, Telegram, Bale, WhatsApp, Instagram, X and
platform support; owner, 2026-10-26: "everywhere"; the Email inbox has no
status and is not affected) closes on its own after the workspace's window
(1-48 h; the Super Admin's switch and default, 24 h;
`server/services/conversationIdleCloseTicker.ts`, migrations 284 to
287), never while the team owes an answer and never for the App Review
account (`apple@webyar.ai`: its workspace `ws_appreview` and the support
threads it requests; owner, 2026-10-26). Only the widget tells the visitor
(«گفتگو به پایان رسید» and the rating); every other channel closes silently,
and platform support shows its own end. A customer message within the grace
of a close (60 s on the widget, 600 s on the channels and support) brings
that conversation back; later, it starts a new one. The web
panel's Inbox has a «بسته‌شده» (Closed) box beside «حل‌شده»: every closed
conversation, the AI-held ones the timer closed included (owner, 2026-10-26;
not in the native apps, whose Resolved lists closed ones too). How it works,
every setting and the rollout: `docs/operations/CHAT_ROUTING.md`.

## The iOS app in Xcode on the Mac

`~/dev/kcb-ios-preview` is the copy of the iOS app (`ios/Webyar`)
open in the owner's Xcode. A LaunchAgent (`ai.webyar.xcode-sync`, script
`~/dev/webyar-xcode-sync.sh`, log `~/dev/webyar-xcode-sync.log`) moves it to
the latest `origin/main` every 3 minutes and regenerates the Xcode project, so
whatever is merged shows up there on its own. It skips the update while a
tracked file there has local edits. Do not check other branches out in that
folder: build and test a PR in a separate worktree (e.g. `~/dev/kcbi-pr`).
Turn the sync off with `launchctl bootout gui/$(id -u)/ai.webyar.xcode-sync`.

## Production server: `host.respok.app` (since 2026-10-28)

WebYar and RESPOK run on `host.respok.app` (public IP `5.39.70.213`, an OVH
dedicated server: 128 GB RAM, 878 GB RAID1 `/dev/md3`; Desktop Commander
device `3dcd7c30-0d1a-4bbf-ab08-565c4e0a905c`, listed as `host`), under its
own Coolify (4.5.0 on 2026-10-28; it updates itself nightly). Its dashboard
has no domain: `http://5.39.70.213:8000`. The owner moved everything there
from `vps-50cc1602` on 2026-10-28 06:04-06:43 UTC (a cold copy with the same
Coolify uuids and app ids, about 4 minutes down; its report is
`/root/migration-20261028/migration-report.json`).

`vps-50cc1602` (`192.99.68.134`, device `7b4d1a32-e6fe-475e-a178-9fc2a16a7097`)
is the old box: its 44 containers are stopped with restart `no` and its
timers and bot disabled, its data kept as a rollback copy until the owner
retires it. Do not start, deploy or change anything there. Its `/root` (the
migration folders, `billing-v2-backup`, the move kit, the drill logs) was
copied to `/root/from-vps-50cc1602/` on the new box; the `/root/...` paths in
the ledger below are there now. The old Coolify on `analyticsme.site` is not
used for WebYar either (owner, 2026-10-08): do not touch it.

Coolify project "WebYar App" (repo `pc30cc/kindred-core-build`, branch
`main`, GitHub App "CustomerCore"):
- 24 WebYar Fronted (`app.webyar.ai`), 25 WebYar Express Backend
  (`api.webyar.ai`): auto-deploy on every push to `main`.
- 26 WooCommerce Worker (`WORKER_KIND=commerce-sync`): auto-deploy off,
  like the apps below: queue it (and RESPOK's 39) by hand when a change to
  the commerce sync (`server/services/commerce`, `worker/commerce-sync`)
  needs it.
- 15 Centrifugo, 16 LiveKit, 17 Intelligence Worker, 18 Source Sync
  Worker, 19 Plugins Channels (`channels.webyar.ai`), 20 Channels-Worker,
  21 AI Runtime (`ai.webyar.ai`), 22 Regression AI Worker, 23 Seo-Crawler:
  auto-deploy off, so a push does not update them; queue them by hand when a
  change needs them.
- LiveKit (WebYar 16, `docker-compose.livekit.yml`; RESPOK 41, the host
  script `/data/respok/livekit/start.sh`) has `LIVEKIT_NODE_IP=auto`: it finds
  the host's public IPv4 on every start (`deploy/livekit/README.md` §3), so a
  server move needs only the DNS of `livekit.*` and `turn.*` changed. Their
  ports (7881/7882 tcp, 3478/3479 and 50000-50500 udp) are reserved from the
  kernel's ephemeral range (`/etc/sysctl.d/60-livekit-reserved-ports.conf`):
  without it a restart can fail with "address already in use" when an
  outgoing DNS query holds one of them.
- Coolify builds two apps at a time, so after a merge the whole set (with
  RESPOK's) takes about 15 minutes. A deploy that has not appeared yet is
  usually still queued: look at `application_deployment_queues` in the
  `coolify-db` container before assuming it failed.

The same server also runs:
- RESPOK, a second rebranded copy of this repo (Coolify projects "RESPOK" and
  "RESPOK App", apps 28-41, `*.respok.app`) with its own database
  `respok-postgres` (`k6pnithcamskd4trrpo6jabv`). Its apps 32 (backend),
  33 (frontend) and 40 (DB Migrator) also auto-deploy on every push to
  `main`; 39 (WooCommerce, `commerce-sync`) does not, like WebYar's 26.
  Never point a WebYar app at RESPOK's database or the other way round.
- Commerce test shops: `whmcs.webyar.ai` is the `webyar-whmcs-test` stack
  here (`/opt/webyar-whmcs-test/`; on 2026-10-28 its Cloudflare origin, and
  `limer.tr`'s, still named the old box, so both answered 521 until the owner
  changes them). `p.webyar.ai` (WooCommerce) and
  `open.webyar.ai` (OpenCart) did not move here: since 2026-10-07 they
  answer 503 and 523 (seen 2026-10-22), so WebYar's WooCommerce connection
  to `p.webyar.ai` reads offline (`commerce_invalid_response`). That is the
  shop, not the sync; bringing them back is the owner's call.
- The landing pages: app 1 `webyar.ai` (repo `pc30cc/webyarlanding`), app 27
  LimerLanding `limer.tr` (repo `pc30cc/lart`), app 28 RESPOK Landing.
- The desktop downloads of both brands (since 2026-10-09): container
  `app-downloads` (nginx, outside Coolify), Traefik file
  `/data/coolify/proxy/dynamic/app-downloads.yaml`, files in
  `/data/app-downloads/{webyar,respok}`, mirrored every 5 minutes from each
  brand's release repos by the timer `app-downloads-sync`. It serves
  `app.webyar.ai/downloads/Webyar-Setup.exe` and its zip `Webyar-Windows.zip`,
  `Webyar-Mac.dmg` and `Webyar-Mac.zip`, `Webyar-Android.zip` (the zip of the
  frontend's own `Webyar-Android.apk`), plus `windows/` (the Windows apps'
  update feed), and the same as `RESPOK-*` on `app.respok.app`. See
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

Client IP: Cloudflare is in front of the app/api hosts, but the origin is
also reachable directly. The backends believe `cf-connecting-ip` only when the
hop Traefik saw is a Cloudflare address (`server/utils/clientIp.ts`, which is
also `req.ip`). Never give coolify-proxy (Traefik) `forwardedHeaders.insecure`
or private ranges in `forwardedHeaders.trustedIPs`, and keep
`TRUSTED_PROXY_IPS` unset. Details: `docs/operations/WIDGET_CONFIG_CACHE.md`,
"Client IP".

### Disk

The root disk is 878G (RAID1, Docker included), 53G used (7%) on 2026-10-28.
A deploy round after a merge adds about 12 GB of build cache plus the new
images, a LimerLanding deploy about 5 GB. The old box's 72G disk is what the
thresholds below were tuned for (68% to 91% per round there); they carried
over unchanged. A full disk stops Postgres too.

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
  manual cleanups on the old box: `/root/from-vps-50cc1602/disk-cleanup-20261008.log`.

### Database

- Coolify database `webyar-postgres` (uuid `oqzy9q4ovntam9jgf7nxzqun`,
  `pgvector/pgvector:pg17`: PostgreSQL 17.11, pgvector 0.8.7), database
  `webyar`. It is on the `coolify` network only and has no public port.
- The backend (25) and the workers 17, 18, 20, 22, 23 and 26 run
  `DATABASE_MODE=postgres-only` as `webyar_app`
  (`oqzy9q4ovntam9jgf7nxzqun:5432/webyar`, `sslmode=disable`). `webyar_app`
  is NOINHERIT, member of `service_role`; `webyar_backup` is read-only.
- Backups: Coolify dumps `webyar` daily at 02:13 UTC and keeps 14 copies in
  `/data/coolify/backups/databases/root-team-0/webyar-postgres-oqzy9q4ovntam9jgf7nxzqun/`
  (on the server's own disk; Coolify has no S3 storage). The off-site copy is
  Super Admin → Database → Backup, on since 2026-10-28 on both brands: daily
  at 03:00 UTC to the storage pool's `bunny_storage`
  (`bunny://webyar/backups/database/…`, RESPOK's `bunny://respok/…`),
  encrypted under `PLUGIN_SECRETS_MASTER_KEY`, 30 days kept (`pg_dump` from
  the backend as `webyar_backup` via `BACKUP_DATABASE_URL`). The first run of
  each was downloaded back and decrypted; `/root/webyar-move/db-backup.mts`
  does check, apply, run and verify from inside a backend container. Without
  that key the off-site copies cannot be read, so it must exist somewhere
  other than this server. See `docs/operations/DATABASE_BACKUPS.md`.
- Migrations:
  - WebYar's database is never migrated automatically. Apply new files by hand
    on the production server (`host.respok.app` since 2026-10-28), before
    merging the code that needs them:
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
    Simple billing, applied by hand to WebYar before each merge (RESPOK's
    migrator applied them on push): `259_simple_billing_accounts.sql`
    (2026-10-10 13:10 UTC), `260_email_templates_per_edition.sql` (13:40),
    `261_simple_billing_renewals.sql` (19:50), `262_simple_billing_card.sql`
    (2026-10-11 04:15), `263_billing_purge_ledger.sql` (19:13),
    `264_simple_billing_ai_packs.sql` (21:22), `265_billing_computed_locks.sql`
    (23:32; its three indexes were built CONCURRENTLY beforehand),
    `266_simple_billing_admin.sql` (2026-10-12 00:38),
    `267_billing_v2_retire.sql` (02:48; the move found nothing to credit and
    no needs_review on either database), `268_billing_v2_archive.sql` (07:43),
    `269_billing_revenue_archive.sql` and
    `270_billing_admin_adjust_rate_limit.sql` (09:33). Full `pg_dump -Fc`
    copies taken before 267 and before 268: `/root/billing-v2-backup/` on
    `vps-50cc1602`, now `/root/from-vps-50cc1602/billing-v2-backup/` on the
    new box. Then `271_plan_storage_mb_ai_credit.sql` (2026-10-16
    08:33 UTC), `272_plan_storage_gb_removed.sql` (09:51),
    `273_sms_provider_telnyx.sql` (11:09), `274_billing_card_transfer.sql`
    (19:23), `275_widget_template_catalog.sql` (2026-10-17 22:07; a dump of
    `widget_settings` and `kb_article_feedback` taken just before it:
    `/root/webyar-migrate-275/pre-275-tables.dump`) and
    `276_widget_chat_features.sql` (2026-10-18 17:29; its header's
    `CREATE INDEX CONCURRENTLY` was run first; a dump of
    `knowledge_base_articles` and `email_templates` plus a schema dump taken
    just before it: `/root/webyar-migrate-276/`) and
    `277_call_widget_design.sql` (2026-10-20 05:24; a dump of
    `call_center_settings` and its schema taken just before it:
    `/root/webyar-migrate-277/`).
    Chat routing and widget fixes (PR #351), all applied 2026-10-22 10:18 UTC
    in one run, after their header indexes were built CONCURRENTLY
    (`conversations_open_assignee_idx`, `conversations_contact_recent_idx`,
    `widget_smart_events_ws_created_idx`) and a dry run of the ten files
    inside one `BEGIN … ROLLBACK`: `278_chat_routing_distribution.sql`,
    `278b_chat_routing_member_release.sql`, `279_widget_offline_mode_values.sql`,
    `279b_widget_primary_color_brand.sql`, `280_widget_visitor_forms.sql`,
    `280a_widget_kb_search_fold.sql`, `280b_widget_queue_per_department.sql`,
    `281_widget_visitor_privacy.sql`, `282_operator_manual_away.sql`,
    `282b_operator_presence_sources.sql`. A dump of the tables they touch
    and a schema dump taken just before: `/root/webyar-migrate-278/`. 281
    seeds its visitor retention policies disabled, and its delete keeps
    migration 171's fence (`retention_cleanup_not_ready`) until the owner
    lifts it in a reviewed migration of its own.
    Then `283_offline_message_template_phone.sql` (2026-10-22 11:30 UTC,
    once the backend of PR #351 was live, per `docs/operations/CHAT_ROUTING.md`
    step 8; it updated the platform's six `offline_message_received`
    templates; a dump of `email_templates` taken just before it:
    `/root/webyar-migrate-283/pre-283-email_templates.dump`).
    Then `284_conversation_inactivity_close.sql`, applied by hand before the
    merge of the inactivity close (2026-10-26 08:58 UTC; its header index
    `conversations_live_updated_idx` built CONCURRENTLY first, at about
    08:54, and a dry run inside `BEGIN … ROLLBACK`; a dump of the tables it
    touches and a schema dump taken just before, and the backlog dry run's
    dump, log and CSV: `/root/webyar-migrate-284/`). It closes nothing and
    leaves the Super Admin's inactivity switch off while live conversations
    exist; the backlog is closed once, by hand, after the owner reviewed its
    list (`database/backfill/284_inactivity_backlog_close.sql`, steps in
    `docs/operations/CHAT_ROUTING.md`, "Rollout of 284"), whose commit turns
    the switch on. Done after the owner's go: WebYar's backlog commit at
    2026-10-26 11:21 UTC closed the 33 reviewed conversations silently (0
    skipped) and turned the switch on; RESPOK (nothing due) had its switch
    turned on at 11:21. Then `285_inactivity_close_app_review_workspace.sql`
    (the App Review workspace `ws_appreview` is never closed for quiet;
    applied by hand before its merge, 2026-10-26 11:51 UTC; a schema dump
    and the dry run in `/root/webyar-migrate-285/`; no App Review
    conversation had been closed). Then
    `286_inactivity_close_every_channel.sql` (every chat channel closes for
    quiet, silently but the widget; the App Review verdict is `exempt` and
    covers that account's support threads; a media-only message counts as a
    turn; applied by hand once the merge's backend (PR #362) was live, since
    it needs that backend and the backend does not need it, as 283 was:
    2026-10-26 23:23 UTC; a schema dump, the dry run's by-channel counts and
    the checks in `/root/webyar-migrate-286/`; no new gate: the switch was
    already on, and the timer's first pass, at 23:24, closed the 6 the dry
    run listed (1 Telegram, 5 resolved platform support threads), silently
    (no line written), and nothing of the App Review account; RESPOK's
    migrator applied it at 23:25, with nothing due there; steps in
    `docs/operations/CHAT_ROUTING.md`, "Rollout of 286"). Then
    `287_inactivity_close_prechat_wait_assigned.sql` (a pre-chat wait
    counts only while nobody holds the conversation; applied by hand before
    its merge, 2026-10-27 09:00 UTC; a schema dump and the dry run's verdicts
    of the rows carrying `routing_pending` in `/root/webyar-migrate-287/`; it
    writes no data; the dry run moved only the test workspace's probe (held,
    answered, quiet) from `routing` to `due`, and the WebYar workspace's 2
    flagged conversations, both assigned, read `needs_reply` on both sides;
    RESPOK, which had no flagged conversation in its dry run
    (`/root/respok-migrate-287/`), by its migrator on push; steps in
    `docs/operations/CHAT_ROUTING.md`, "Rollout of 287").
  - Since 269, deleted payments and ledger rows are copied to the append-only
    `billing_revenue_archive` and `billing_ledger_archive` (revenue reports
    include them). Never drop, empty or untrigger them; a CI rule forbids it.
  - Since 268 (`268_billing_v2_archive.sql`) the billing v2 tables live,
    intact, in the schema `billing_v2_archive` (no app role can read them;
    `webyar_backup` can). Never drop or empty that schema: it holds financial
    records, and a CI rule forbids it. Restore a table with
    `ALTER TABLE billing_v2_archive.<t> SET SCHEMA public` by hand.
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
- 2026-10-28 06:04-06:43 UTC: both brands moved from `vps-50cc1602` to
  `host.respok.app` (`5.39.70.213`), same Coolify uuids and app ids. After it,
  the same day: LiveKit's address became automatic (PR #365), the migration's
  plaintext dumps were deleted on both boxes, root's `authorized_keys` on the
  new box was cut back to Coolify's own key, the Intelligence workers (17, 34)
  were rebuilt from `main`, and the off-site backup to Bunny was turned on.
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
