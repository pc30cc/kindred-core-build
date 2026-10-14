# Super Admin widget bridge

A dedicated inbox at `/<workspace>/inbox/widget-bridge` exchanges text with a
chat widget on another site. Super Admin → **Workspaces → Widget bridge inbox**
opens `/admin/widget-bridge`, where the admin chooses one of their own
workspaces, saves default name/email/phone, enables the bridge and adds a
public HTTPS site. A site becomes a contact named after its domain unless the
admin supplies a name. The admin writes the first and subsequent messages in
the inbox; adding a URL does **not** send an unsolicited initial message.

The inbox is only a display/composer. A standalone browser worker opens the
remote widget, completes configured pre-chat fields, sends queued messages and
records replies in the same thread. No AI auto-replies, crawl, bulk outreach,
CAPTCHA solving or paid discovery API are involved.

## Independence from WebYar and RESPOK

**No migration runs against either application's database.** The four tables
in `deploy/widget-bridge/schema.sql` must be installed in a **new database**:

- `widget_bridge_settings`: switches, allowed providers and default identity;
- `widget_bridge_contacts`: site identity/configuration and encrypted browser state;
- `widget_bridge_messages`: incoming text and the outbound queue;
- `widget_bridge_batches`: ordered site lists, shared message and batch state.

These tables have no foreign keys or triggers pointing to app records. Site
contacts live here, not in the main app's Contacts table. Both backends and
their separate workers use the same bridge database with distinct
`WIDGET_BRIDGE_APP_ID` values (`webyar` / `respok`). All API access is partitioned
by application, signed-in admin and owned workspace. Sharing a database does
not grant one brand access to the other's inboxes. Account/workspace IDs from
the main databases are opaque scope identifiers only.

The bridge pool is lazy and capped at two connections per process. A missing
or failed bridge database returns 503 only from bridge endpoints, never from
normal inbox/auth/channel endpoints. There is no browser dependency in the
normal worker image, and `WORKER_KIND=all` does not start this worker. The
existing authentication/admin guards remain in place, and a **read-only**
lookup verifies `workspaces.owner_id`. No bridge records are stored in the
app database; customer workspaces and ordinary members
cannot read, configure or send bridge messages even by direct API calls.

## Provisioning (separate, opt-in deployment)

1. In the current production Coolify, create a PostgreSQL 15+ database named
   `widget_bridge`, with a dedicated login that owns its tables and is not a
   member of any app/service role. Do not reuse `webyar_app`, `postgres` or
   RESPOK's application login. Keep it on the private network with no public
   port, and configure backups separately. No production provisioning has
   been performed by this PR.
2. Apply `deploy/widget-bridge/schema.sql` **as that login in that database**.
   First verify `SELECT current_database(), current_user` and dry-run inside
   a transaction. The file includes BEGIN/COMMIT, so replace its final COMMIT
   with ROLLBACK for the dry-run. This file is intentionally outside
   `database/migrations` / `supabase/migrations`; neither brand's migrator
   should run it.
3. Add these env vars to each backend and its new dedicated worker:

   | Variable | Value |
   | --- | --- |
   | `WIDGET_BRIDGE_ENABLED` | `1` (unset / any other value disables the feature) |
   | `WIDGET_BRIDGE_DATABASE_URL` | URL of the **new bridge database** |
   | `WIDGET_BRIDGE_APP_ID` | `webyar` for WebYar; `respok` for RESPOK |
   | `WIDGET_BRIDGE_ENCRYPTION_KEY` | Dedicated random 32-byte hex/base64 key, same on both workers/backends |
   | `WIDGET_BRIDGE_DATABASE_ROLE` | `none` (default; connect as the dedicated table owner) |
   | `WIDGET_BRIDGE_DATABASE_SSL` | `disable` on the private network, or `verify-full` for remote TLS |
   | `WIDGET_BRIDGE_DATABASE_SSL_CA` | CA PEM/file when required |
   | `WIDGET_BRIDGE_SESSION_MS` | `600000` default; minimum session before rotating for waiting sites |

   `PLATFORM_SIGNING_SECRET` and `PLUGIN_SECRETS_MASTER_KEY` are unchanged. The
   dedicated worker needs neither an app `DATABASE_URL` nor app credentials.
   The backends keep their existing app env vars. Identical main/bridge database
   host/port/name combinations are rejected. Separate logins/permissions are
   the authoritative isolation, including when DNS aliases refer to the same
   PostgreSQL cluster. Do not grant the bridge role access to app tables.
4. Create **two new isolated worker services** in Coolify using
   `Dockerfile.widget-bridge`, with the respective app IDs. Do not replace or
   restart the channels, AI or crawl workers. Deploy only through Coolify's
   normal queue, as required by `CLAUDE.md`. The image has its own minimal,
   locked runtime dependency manifest, separate from the app's npm install.
5. Run the worker as its non-root `bridge` user. Chromium sandbox is explicitly
   enabled and must stay enabled. Supply a seccomp profile permitting Chromium
   user namespaces (Playwright's [official Docker profile](https://github.com/microsoft/playwright/blob/main/utils/docker/seccomp_profile.json)),
   an init process, and adequate `/dev/shm`. Do not use a privileged container,
   host filesystem mounts, Docker socket or `--no-sandbox`. Start with 1 CPU /
   1 GB RAM per worker, then measure actual site usage. If the host cannot run
   the browser sandbox, fix that deployment prerequisite; the worker fails
   closed while the main applications keep running.
6. Queue the backend deployments, then open the admin page to save default
   details and enable a site. Check the worker's health, contact connection
   status and message delivery state. Test against a site/widget you control:
   send from the bridge, reply in the remote operator panel, then check that
   the reply arrives once. Disabling and deleting the connection are required
   acceptance checks before adding other sites.

## Provider selection and ordered batches

The Super Admin selects allowed provider types in the bridge settings. Both
manual and batch sends enforce this allowlist in the worker before opening a
widget or filling its identity. A custom adapter must be enabled explicitly
in the allowlist. Saving settings fences old sessions and cancels existing
batches and unsent messages.

Paste one HTTPS website per line and a shared message (up to 2,000 characters).
The UI adds HTTPS to bare domains. A batch accepts up to 500 unique URLs, keeps
first-occurrence order, removes fragments and exact URL duplicates, and stores
its message, site list and progress in `widget_bridge_batches` in the dedicated
database. Existing enabled bridge contacts retain their provider/selectors;
disabled or deleting contacts are skipped. New contacts are named after their
host and use automatic detection. No ordinary app contacts are created.

Only one running or paused batch is accepted per app/owner/workspace, enforced by a
partial unique index. The outbox gates later batch positions on all preceding
attempts reaching a terminal result, including across workers and restarts.
Browser setup failures finish the current attempt and immediately pause the batch for review.
Unknown delivery is not retried. Active sessions yield browser capacity when
the next batch site is waiting. This is ordered **submission**, not a guarantee
that remote operators will receive/read messages in that same order.

Settings include **sites per round (1–50, default 1)** and **minimum interval
between attempts (5–3600 seconds, default 30)**. These are copied into each
batch so its policy is stable. Even a 50-site round submits one site at a time;
the worker uses one browser context, never 50 parallel pages. Keep one worker
instance per app when you want that per-app browser limit.

After the approved round finishes, the batch pauses for review. The Super Admin
uses **Approve and continue** to authorize the next round. Failed/uncertain
attempts pause immediately, even within a round; approval then permits the
remaining unattempted sites, not a retry of the failed message. A versioned
review token rejects stale/repeated approval requests. The database enforces
both the approved position and cooldown at claim, prepare and dispatch. Approval
does not bypass an unfinished cooldown. Successful widget submission is not an
operator read receipt; the admin reviews outcomes before continuing.

The panel shows totals and per-site results and can stop the batch. Stopping
fences affected sessions, cancels pending messages and marks in-flight sends
uncertain. It cannot withdraw a message whose external send has started.
Contacts and replies remain available in this module's paginated inbox.
The module's purge operation removes batches together with settings, contacts,
messages and encrypted sessions, scoped to the selected app/owner/workspace.
Applying `schema.sql` again upgrades an existing dedicated bridge database;
it must never be run against either main application database.

## Widget coverage and limits

Automatic adapters currently cover **WebYar/RESPOK**, **Crisp**, **Goftino** and **Raychat
versions exposing the visitor `sendMessage` SDK**. WebYar
supports open shadow DOM / iframes, pre-chat identity and the real
`/api/widget/message` acceptance receipt. Crisp uses its published
[`$crisp` SDK](https://docs.crisp.chat/guides/chatbox-sdks/web-sdk/dollar-crisp/)
for visitor sends, identity, and incoming/outgoing events. Raychat uses its
[published visitor SDK](https://raychat.io/documentation) and requires both an
accepted send result and the visitor-send event. Message text is
never treated as an AI instruction.

Goftino uses its published `setUser` and `open` methods for identity and opening,
then fills the real visitor textarea inside `#goftino_w` and clicks its send
button. It never calls the display-only `Goftino.sendMessage`. The matching
`goftino_sendMessage` visitor event confirms the submission; a rendered bubble
alone does not. This event is not a delivery/read receipt from an operator.
Operator replies arrive through `goftino_getMessage`; non-text events are ignored.
Default DOM selectors were inspected in the live widget on the official docs
page. Browser fixtures verify the visitor form/event contract; a live two-party
acceptance test on a site you control is still required before production use.
Selector overrides allow site-specific pre-chat fields and submit buttons;
unknown mandatory questions pause the connection rather than being answered.
The widget's textarea maxlength is enforced without silently truncating a message.
Goftino's published events do not promise stable message IDs or an offline history
API. Replies without IDs get distinct arrival IDs; replay deduplication and
backfill of replies received while the worker was offline are not guaranteed.

Other widgets (older Raychat versions, Tawk, Chatwoot, etc.) use the custom scoped DOM
adapter after their selectors are configured and tested for the particular
site. This is **not a promise of universal provider support**. A custom adapter
requires a widget root, composer and separate incoming/outgoing text selectors;
it can also select an iframe, launcher, start-chat action, name/email/phone
fields and a details-submit button. No arbitrary script is accepted. Stable
message ID attributes are recommended: fallback text + occurrence IDs assume
a stable rendered history and cannot guarantee deduplication if a widget
virtualizes/reorders/removes its history. A custom send is confirmed only when
a new outgoing bubble appears; it does not prove delivery/read by an operator.
WebYar additionally requires a server message ID. Do not implement Goftino
outbound sends using `Goftino.sendMessage`: its [developer documentation](https://www.goftino.com/docs)
states that this is display-only and does not become a real conversation
message. Likewise, never use Raychat's display-only `sendOfflineMessage` as an
outbound transport.

Only text is bridged. Attachments, OTP/CAPTCHA, consent checkboxes, custom
required questions and login-gated widgets require further adapters/manual
intervention; the worker reports a safe error instead of guessing or bypassing
them. Missing required identity, unsupported widgets, ambiguous configuration
and blocked composers pause the site connection for manual re-enabling,
instead of repeatedly submitting a pre-chat/verification form. Closed shadow roots are unsupported. Sites with no supported widget
report `unsupported_widget`. Some sites block browser automation.

Each contact has its own browser context and encrypted cookies/localStorage /
IndexedDB snapshot; session data is never returned to the browser. No browser
trace, screenshot or plaintext cookie file is persisted. Storage state is saved
before outbound dispatch and periodically only when changed. A context does
not share identity/cookies with another site contact. Browser subresources,
redirects, iframe requests and WebSockets use an HTTPS-only CONNECT proxy that
validates all DNS answers and connects to the validated public IP (no second
lookup). Private/metadata/loopback addresses and non-443 ports are blocked.

Each worker uses one browser context at a time; additional enabled sites wait
and rotate fairly. Active sessions remain open when no other enabled site is
waiting, rather than needlessly creating a receive gap every ten minutes.
Provider events are received while a session is active.
WebYar/custom adapters read rendered history after reconnect; Crisp/Raychat SDK
adapters receive operator events, so offline or rotation gaps are not
guaranteed to be backfilled. Raychat events lacking a stable ID receive a
unique arrival ID; duplicate provider event replays without IDs cannot be
deduplicated reliably. This limitation must be resolved with a tested
history adapter before promising continuous capture across many sites. No
live third-party site was messaged by the automated tests.

## Delivery, shutdown and deletion

- Client-generated UUIDs make API retries idempotent. A different body cannot
  reuse the same UUID. Workers lease contacts and fence all writes/dispatches
  against connection generation, owner and lease expiry.
- The queue is `queued → preparing → dispatching → sent`. Failure before
  dispatch is `failed`; a crash or unconfirmed result after dispatch is
  `uncertain`, with **no automatic retry**. Exactly-once delivery to arbitrary
  third-party widgets is impossible without their own idempotency support.
- Saving settings or toggling a connection fences the old session and cancels
  unsent messages. A previously dispatched action may still finish remotely;
  it cannot be withdrawn. The UI states this explicitly.
- Disable keeps bridge history. Delete a site fences it, clears its saved
  session and waits until its browser lease closes before cascading deletion
  of its bridge messages. Expired deletions can complete even when the worker
  is stopped (the contact list also reaps expired rows).
- “Delete this inbox’s bridge data” removes only the current app/admin/workspace
  settings, batches, contacts, sessions and messages, after active leases close. Other
  bridge inboxes and all main app records remain untouched.
- To remove the entire feature, unset `WIDGET_BRIDGE_ENABLED` on both backends,
  stop the two dedicated workers through Coolify with container cleanup off,
  remove the bridge env vars, and then archive/delete **only the dedicated
  bridge database** if its data is no longer needed. No rollback SQL is needed
  on either application's database. Unsetting the flag also hides the inbox
  link; the admin page reports that the optional feature is unavailable.

## Verification

`npm test -- src/test/widgetBridge` runs PostgreSQL (PGlite) API/worker tests
and network/encryption/validation checks. `npx playwright test
e2e/widgetBridge.spec.ts` runs controlled browser fixtures covering shadow DOM,
identity, server rejection, two-way messages, Crisp/Raychat events and iframe scoping.
These tests create only disposable in-memory database state; production schemas
and third-party inboxes are untouched.

## Removing the code

Keep this feature in its own PR/merge commit. After disabling both backends and
stopping both dedicated workers, revert that feature merge in a new PR and run
typecheck, tests and build before deployment. This removes the integration
points together with the module; deleting only a folder would leave imports.
No core-database rollback is involved. For a later manual removal, the complete
integration inventory is:

- `server/routes/admin.ts`: bridge router import and mount.
- `src/App.tsx`: two lazy page imports and their bridge routes.
- `src/components/layout/AppSidebar.tsx`: bridge settings hook and inbox link.
- `src/components/layout/AdminSidebar.tsx`: bridge navigation item and title handling.
- `src/pages/admin/WorkspacesPage.tsx`: bridge settings link.
- `src/i18n/locales/{en,fa,tr}.ts`: bridge dictionary import/property.
- Delete feature-owned files: `server/routes/adminWidgetBridge.ts`,
  `server/services/widgetBridge/`, `worker/widget-bridge/`,
  `shared/widgetBridge.ts`, `shared/widgetBridgeTargets.ts`, `src/features/widget-bridge/`,
  `src/pages/admin/WidgetBridgePage.tsx`, `src/pages/app/WidgetBridgeInboxPage.tsx`,
  `src/i18n/widgetBridge.ts`, `src/test/widgetBridge/`, `e2e/widgetBridge.spec.ts`,
  `Dockerfile.widget-bridge` and `deploy/widget-bridge/`.
- Remove the PGlite dev dependency only if no remaining tests use it, then
  regenerate both npm and Bun lockfiles with the project's pinned tools.

The standalone worker is not registered in the main worker dispatcher. Missing
bridge configuration/database is confined to this module's endpoints and does
not prevent the main app from booting. Preserve or delete the separate bridge
database independently after stopping both applications' bridge workers.

## Provider websites and live Goftino check

The module rejects individual contacts/messages for `goftino.com`, `raychat.io`,
`crisp.chat`, `webyar.ai`, `respok.app` and their subdomains. Batch imports retain
these rows as skipped with `provider_site_blocked`, without creating contacts or
messages. The same policy fences previously stored contacts and the worker's
actual top-level page (including redirects). Embedded provider iframes, scripts
and APIs on a customer website remain available. The module-owned list lives in
`shared/widgetBridgeTargets.ts`; extend it when adding another supported provider
or a provider-owned domain. It is not an exhaustive registry of all vendors.

Detection moves the pointer without clicking to wake interaction-gated widgets.
A user-authorized browser check on 2026-10-14 at `https://www.tayebatstore.ir/`
confirmed this lazy-loading behavior and the Goftino iframe/composer. One clearly
marked Persian test message was submitted through the real composer and remained
visible after reload and reopening the chat. No identity fields were required.
This verifies the real site's visitor chat path, not deployment of this worker,
operator receipt/read status, or replies arriving in the application's inbox.
The dedicated worker and separate database still require deployment.


## Reusing the live conversation bridge

`SessionRelay` prepares identity/listeners once and forwards subsequent outbound
text and inbound operator messages through the same adapter and browser page.
It does not navigate for each reply, append text, or create another visitor.
A second authorized live browser message containing exactly `سلام` was sent to
the same Tayebat conversation and displayed successfully without reloading.
The initial longer test had already been sent before that wording instruction.

This is a live browser-backed relay, not a browser-free Goftino transport. A
worker still has one live site at a time: batch advancement, fair rotation,
restart or a broken session can require reopening a site with encrypted saved
visitor state. Replies during disconnected intervals are not guaranteed to be
backfilled by SDK adapters. A browser-free integration would need a supported
provider transport with authorized credentials. Goftino's public server API
(https://api.goftino.com/) requires the destination account's `goftino-key`,
including `send_message_from_user` and Webhook configuration; a public widget
ID alone does not grant that access. No such credential is available for the
third-party test store, and this PR does not pretend to provide that transport.
