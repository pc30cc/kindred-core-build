# Email Inbox architecture: read live, keep content on the device

Status: **required** for every mailbox integration (Gmail now; Yahoo and any
custom provider when they are next touched), on all five clients: web,
Windows, macOS, iOS and Android.

This design limits what we hold of a user's mail. It does **not** replace
Google's OAuth app verification or the annual CASA security assessment that
restricted Gmail scopes (`gmail.modify`) require for a production app: mail
still passes through our API on its way to the user.

## Rules

1. **The provider is the source of truth.** Gmail (or Yahoo, …) holds the mail.
   Read/unread and starred are provider labels, changed at the provider.
2. **No email content on our servers.** No subject, body, snippet, address
   list, attachment or reply text in the database, object storage, job
   payloads, caches or logs. Allowed server state: the connection
   (`channel_integrations`), the encrypted refresh token (`plugin_secrets`),
   the sync cursor (`metadata.gmail_history_id`, watch expiry), and minimal
   assignment metadata if a feature needs it (ids only).
3. **No AI on mail.** Nothing reads mailbox content for AI, knowledge, search
   indexing or automation. Replies are written and sent by a person.
4. **Device cache first.** Clients show what they cached, then refresh.
   Lists are paginated; a thread body is fetched when it is opened; an
   attachment is downloaded only when the user asks for it.
5. **No polling, no full-mailbox downloads.** One provider watch per connected
   mailbox; provider pushes are coalesced; changes are read incrementally from
   the provider's cursor (Gmail `historyId`). An expired cursor recovers with a
   bounded, paginated reload of page one, not a full resync.
6. **One request, many callers.** Identical concurrent reads share one
   provider call (single-flight), and every caller is authorized first. Tabs
   and windows on one device share one fetch.
7. **Change signals carry no content.** Realtime events and push
   notifications say "mailbox changed" / "new email" and nothing else: no
   sender, subject or snippet.
8. **Bounded, isolated device caches.** Keyed by user + workspace + mailbox;
   capped in size and age; cleared on sign-out, on disconnect and when the
   server reports the mailbox is no longer connected (access revoked).
9. **Watch renewal is scheduled and staggered**, under the cluster-wide ticker
   lease. Shared coordination (Redis) is added only if the multi-server setup
   actually needs it.

Providers without push or incremental sync (Yahoo IMAP today) use bounded,
adaptive polling only while a client needs fresh data, and follow rules 2–8.

## Gmail — how it works now

| Concern | Where |
| --- | --- |
| Live reads (list, thread, attachment), label writes, `/changes`, send | `server/services/email/gmailLive.ts` |
| Routing a workspace to the live path | `server/services/email/inbox.ts` (`liveGmail`) |
| API | `server/routes/emailInbox.ts` — `GET threads?page_token=` (older apps: `before`/`nextBefore` carry the same token), `GET threads/:id`, `GET changes?since=`, `GET attachments/p<partId>~<messageId>/file`, `POST send` with `inline_attachments` |
| Pub/Sub push → coalesced, content-free signal | `server/routes/gmailPush.ts` → `server/services/email/gmailChangeNotifier.ts` |
| Watch renewal | `server/services/channels/gmail/watchRenewalTicker.ts` |
| Retired import | Worker `gmail_sync_inbox` is a no-op; `/internal/channels/gmail/upsert-thread-message` and `/attachment-ingest` answer 410 |
| Mailbox picker | `GET mailboxes`; `?provider=` on every route (see *More than one mailbox* below) |

Flow:

1. **Connect:** OAuth stores the refresh token and starts `users.watch`
   (`INBOX`). Nothing is imported.
2. **List:** `threads.list` (25 per page) + `threads.get?format=metadata` per
   row. The response carries `nextPageToken` and a `historyId` cursor.
3. **Open:** `threads.get?format=full` (drafts are left out). Attachments are
   named by their MIME part id (Gmail's attachmentId changes on every read)
   and listed with `url` = `downloadPath` = a signed-in API path; bytes are
   streamed from Gmail on request, never stored.
4. **Change:** Google pushes → Core waits 2 s per mailbox to coalesce →
   reads added-message ids from `history.list` (ids only) → advances
   `gmail_history_id` → publishes `email_mailbox_changed` on
   `ws:<workspace>:inbox` → sends a content-free push if there is new mail.
5. **Refresh:** an open client calls `GET /changes?since=<its cursor>`; if
   threads changed (or `reset`), it reloads page one. Cached bodies stay valid
   while the thread's message count and last-message time are unchanged.
6. **Send:** `messages.send` inside the `/send` request. Attachments travel
   inline (base64, 20 MB total) and are not stored. Apps that stage first
   (`POST /attachments`) get their bytes back as an `inline:` key and return
   it with `/send`; nothing is written in between.
7. **Errors:** a revoked grant (invalid_grant, 401, missing scope) answers
   409 `email_not_connected` and marks the integration errored, so every app
   shows it disconnected and drops its cache. Quota/rate limits answer 429
   `email_rate_limited`. A non-Gmail id (an old UUID) answers 404.
8. **Push:** content-free, `data.threadId` = the newest new mail's Gmail
   thread id, `data.provider` = `gmail`, `dedupeKey` from the history cursor
   (no uuid row exists).

## More than one mailbox (Gmail and Yahoo connected together)

A workspace may have a connected Gmail and a connected Yahoo at once.

- **Pick one:** every `/api/email-inbox/:workspaceId/*` route (POSTs
  included) takes an optional query parameter `provider=gmail|yahoo`. Named,
  only that mailbox is used: not connected → the usual
  `email_not_connected` (409), and `GET threads` answers an empty list; a
  Yahoo list is then limited to that mailbox's own rows. Any other non-empty
  value → 400 `invalid_provider`. Without it, nothing changes: Gmail first,
  then Yahoo.
- **List them:** `GET /api/email-inbox/:workspaceId/mailboxes` →
  `{ "mailboxes": [{ "provider": "gmail", "address": "me@gmail.com",
  "status": "connected", "unread": 12 }, { "provider": "yahoo", … }] }` —
  connected mailboxes only, Gmail first; `address` is what the plugin's
  connection endpoint reports. `unread` = unread INBOX threads: Gmail's own
  INBOX label counter (`users.labels.get`, single-flight per mailbox), Yahoo's
  unread `email_threads` rows of that mailbox. `null` when it cannot be read
  just now; a Gmail grant found revoked is marked errored and left out.
- **Push:** email notifications carry `data.provider` (`gmail` | `yahoo`)
  next to `data.threadId`, so an app opens the thread in the right mailbox.
- **Yahoo realtime:** when the Yahoo poll stores a *new* inbound message,
  Core publishes the same content-free `email_mailbox_changed` on
  `ws:<workspace>:inbox`, with `provider: "yahoo"` and `history_id: null`
  (coalesced per mailbox, 2 s). Both providers' events also carry `at` (the
  ISO time it was published — no content), so clients that de-duplicate by
  payload do not merge two signals into one. Re-deliveries publish nothing. Yahoo has no
  incremental `/changes` (`?provider=yahoo` answers `reset: true`): a client
  reloads page one. Clients showing one mailbox ignore events whose
  `provider` is another one's (the web's live Gmail sync does).

## Folders

Apps draw a mailbox's folder menu (the ☰ of a mail client) from the server;
the names are the same for every mailbox (`server/services/email/folders.ts`).

- **The menu:** `GET /api/email-inbox/:workspaceId/folders[?provider=]` →
  `{ "folders": [{ "id": "inbox", "kind": "system", "name": null,
  "unread": 7, "total": null }, …, { "id": "label:Label_10", "kind": "label",
  "name": "Clients", "unread": 1, "total": null }] }`. Counts only, never
  mail; `Cache-Control: no-store`; no mailbox connected → 409
  `email_not_connected`.
  - Gmail: `inbox`, `starred`, `important`, `sent`, `drafts`, `all`, `spam`,
    `trash`, then the user's labels by name (`users.labels.list`, labels
    hidden from Gmail's label list left out). Counts are Gmail's own
    (`users.labels.get`): unread for Inbox, Spam and each label (the first 40
    labels), `total` for Drafts. A count that cannot be read is `null`.
  - Yahoo (table-backed): `inbox` (its unread count), `starred`, `sent` — the
    channel worker fills the table from the inbox and from what is sent here.
- **A folder's threads:** `GET threads?folder=<id>` (with `unread=true` and
  `starred=true` still narrowing it). Absent or empty is `inbox`, as before.
  Anything that is not a system folder or `label:[A-Za-z0-9_-]{1,100}` → 400
  `invalid_folder`; a folder the mailbox does not have (Yahoo `spam`, …) →
  400 `unsupported_folder`.
  - Gmail lists the folder's label (`all` is no label; `spam` and `trash` set
    `includeSpamTrash`). Rows in `sent` and `drafts` name the recipients
    (`participants` = the To of the latest sent message or draft), as mail
    clients do there.
  - Yahoo `sent` is the threads with an outbound message (the newest 500
    outbound messages are scanned); `starred` is `is_starred`.
- **A thread from a folder:** `GET threads/:id?folder=<id>`. Gmail shows the
  messages that folder holds: `spam` and `trash` only those, `drafts` the
  thread with its draft (`deliveryStatus: "draft"`, `direction: "outbound"`),
  every other folder the thread without drafts, spam or trash — as before.
  A thread with nothing in that folder is 404 there.

## Clients

### Web (done)

- `src/lib/emailCache.ts`: IndexedDB, scoped `userId|workspaceId|mailbox`,
  7-day max age, 300 entries per scope (LRU). Web Locks give cross-tab
  single-flight: a tab takes `email:<key>`, re-checks IndexedDB, and only
  fetches if nothing fresh is there. `BroadcastChannel` tells other tabs to
  refresh or drop. Cleared on sign-out (`AuthContext`), on disconnect, and on
  `email_not_connected`.
- `src/hooks/useEmailInbox.ts`: list = infinite query with the cached page as
  placeholder; thread = cache hit without a request when the version matches;
  `useEmailMailboxSync` = one realtime subscription, one leader tab calls
  `/changes`; changed threads lose their cached body. Without an open
  realtime connection, the same ids-only `/changes` check runs once a minute
  while the page is visible. A fetch that started before a clear never writes
  back. The Yahoo inbox keeps its server polling and no device cache.

### Android

- The reader (`feature/email/EmailReader.kt`) is one white page in a
  WebView with JavaScript off. Each mail's own `<style>` is scoped to its
  box (`MailCss`: `html`/`body` become the box, `@media` kept, `@import`
  dropped), and the mail reflows to the phone: its desktop widths are let go
  of where they are written (a table 300px or wider becomes 100%, cells lose
  fixed widths, boxes of 100px or more take the width they are given,
  `min-width` goes; pictures keep theirs), nothing is wider than its column,
  and long words break. Anything still wider scrolls sideways inside the
  mail's own box — never off the page, where in a right-to-left page it could
  not be reached.
- The ☰ in the mail list opens the folder menu (`GET folders`, re-read each
  time it opens) with the mailboxes on top when there are two; the list,
  paging and a thread opened from it carry `folder=`.

### Windows, macOS, iOS (to do)

The API keeps the same response shapes, so the apps keep reading and replying
with text. Each app must now also:

| | Cache | Change signal | Background |
| --- | --- | --- | --- |
| Windows (`windows-native`) | SQLite (`LocalStore.cs`), shared across windows | realtime `email_mailbox_changed` | none |
| macOS (`macos/Webyar`) | SQLite (`LocalStore.swift`), shared across windows | realtime | none |
| iOS (`ios/Webyar`) | local store in `Core/Cache` | realtime in foreground; APNs alert (no content) | no reliance on silent push |
| Android (`android/`) | Room | realtime in foreground; FCM (no content) | WorkManager only for required work |

and: key the body cache on the thread version; clear the cache on sign-out,
disconnect and `email_not_connected`; treat thread ids as opaque strings
(Gmail ids are not UUIDs). Paging (`before`/`nextBefore`), attachment
staging and attachment `url` keep working unchanged in the meantime.

## Verification checklist

- Opening, listing and replying in a Gmail inbox writes no row to
  `email_threads`, `email_messages`, `email_attachments` or `channel_jobs`.
- Reopening a thread whose version is unchanged makes no `/threads/:id` request.
- With several tabs open, one mailbox change produces one `/changes` request
  and one `/threads` request.
- Push notifications for email show no sender, subject or snippet.

## Purging old data

Rows imported before this change (Gmail `email_threads`, `email_messages`,
`email_attachments`, and queued `gmail_*` jobs carrying reply bodies) are not
removed automatically. Deleting them is a deliberate, irreversible step for an
operator to take. Attachment files they reference live in object storage under
the keys in `email_attachments.storage_key`.
