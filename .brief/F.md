# Findings for package F

(From the 2026-10-29 audit of origin/main 1df282b80; line numbers refer to that commit.)

### channel:CH-3 [verifier: confirmed, severity medium] Yahoo replies are sent with a different Message-ID than the one stored, so the customer's answer to a new email opens a separate thread

Evidence (mapper): Read: Core generates and stores the id as external_message_id (inbox.ts:666-669,715,755). For a new thread it also uses it as external_thread_id (inbox.ts:736). The comment at inbox.ts:659-665 says the Yahoo send is 'told to force it via messageId'. The worker builds the send without `messageId` (worker/channels/index.ts:794-805), although YahooOutboundMessage supports it (channels/mail/yahoo/client.ts:342,364). The Gmail legacy path does pass it (index.ts:640). nodemailer therefore generates its own Message-ID. Inbound threading uses References[0] || In-Reply-To || Message-ID (internalChannels.ts:830-832). Inferred: the customer's reply to a newly composed email carries nodemailer's id, matches no external_thread_id, and creates a new thread (internalChannels.ts:906-924). Later operator replies cite an id that never existed on the wire (inbox.ts:709-711).

Impact: Conversations split in the Email Inbox for Yahoo-connected workspaces, and recipients' mail clients can mis-thread. No mail is lost.

Suggested fix (mapper): Pass `messageId: payload.message_id ? String(payload.message_id) : undefined` in worker/channels/index.ts:794-805, as the Gmail case does.

Verifier: Read: Core makes and stores its own Message-ID (server/services/email/inbox.ts:666-669, 715, 755) and uses it as external_thread_id for a new thread (inbox.ts:736). The comment at inbox.ts:659-665 says Yahoo is told to force it. The worker builds the send without `messageId` (worker/channels/index.ts:794-805) and throws away the id that comes back (`void result`, index.ts:806). The adapter supports it (channels/mail/yahoo/client.ts:342, 364), and the legacy Gmail path does pass it (index.ts:640). Inbound threading is References[0] || In-Reply-To || Message-ID (server/routes/internalChannels.ts:830-832), and an unknown id inserts a new thread (internalChannels.ts:910-927). So a customer's reply to a mail composed new in the Inbox (References[0] = nodemailer's id) lands in a new thread. Replies inside a thread the customer started keep References[0] = their own root and stay together. Nothing is lost.

Verifier's corrected statement: (none)

### channel:CH-4 [verifier: partly, severity medium] A Yahoo reply can go out several times when Core does not accept the 'sent' report

Evidence (mapper): Read: in worker/channels/index.ts:794-812 the SMTP send happens first, then coreCall('/yahoo/outbound-result', 'sent'). If that call fails, the catch (813-821) reports 'failed', which overwrites the row even though the mail went out, and rethrows. coreCall marks 401/404/503 as infrastructure errors (index.ts:350-357); those jobs are requeued without penalty (index.ts:1025-1033), so they repeat for as long as Core answers that way. Other errors are retried up to max_attempts 8 (server/services/channels/jobs.ts:123). Each run calls sendViaYahooSmtp again. Inferred: Core answers 503 while it is deploying or stopped, if the worker reaches it through the proxy (CORE_INTERNAL_BASE_URL is not visible to me).

Impact: The customer receives the same reply two or more times, and the Inbox shows 'failed' for a reply that was delivered.

Suggested fix (mapper): Make the job idempotent. Once SMTP accepts the mail, record that fact before reporting (for example a 'smtp_accepted' marker in the job payload/row checked at job start, or retry only the report). Never resend after a successful SMTP handoff.

Verifier: Read: worker/channels/index.ts:794-812 sends over SMTP first, then calls coreCall('/yahoo/outbound-result','sent'). If that call fails, the catch at 813-821 posts 'failed' and rethrows. Core's yahoo/outbound-result updates the row with no check (internalChannels.ts:1081-1087), unlike the chat route that keeps 'sent' (internalChannels.ts:394-399). One detail is wrong. For 401/404/503 (marked infrastructure, index.ts:350-357), the job is released (1025-1033) and coreAuthReady goes false. ensureCoreAuthReady (index.ts:234-258, re-checked every 15 s, index.ts:107) then stops all claims until /ready passes. So that branch re-sends about once after Core returns, not 'for as long as Core answers that way'. The worse branch is a report that fails without 401/404/503: a refused connection or DNS error (fetch throws, so not marked infrastructure, and coreAuthReady stays true), or a Core 500. That branch goes through failChannelJob with backoff 5 s, 10 s, 20 s... (server/services/channels/jobs.ts:196-199) up to max_attempts 8 (jobs.ts:123). Each try re-sends the mail.

Verifier's corrected statement: A Yahoo reply is sent again each time the job runs after SMTP has already accepted it. If Core answers 401/404/503, the worker pauses before claiming anything (readiness gate) and re-sends about once after Core is back. If the report fails any other way (network error, timeout, Core 500), the job is retried with backoff up to 8 attempts, and every attempt re-sends the mail. Either way the row reads 'failed' until a later attempt reports 'sent'.

### channel:CH-5 [verifier: confirmed, severity low] The Yahoo compose path trusts a storageKey supplied by the client, so any storage object can be read or attached

Evidence (mapper): Read: the send schema takes `attachments[].storageKey: z.string()` (emailInbox.ts:307-312) and forwards it verbatim (emailInbox.ts:371-376). composeReply inserts email_attachments with that storage_key (inbox.ts:776-785). GET /:ws/attachments/:id/file then reads it with downloadFile(..., { allowLegacyKey: true }) (inbox.ts:356). With allowLegacyKey, enforceOwnerScope skips the workspace-scope check and only runs assertSafeStorageKey (server/services/storage/index.ts:139-158, used by downloadForOwner 1491-1504). Separately, getFileUrl auto-accepts legacy 'email-attachments/<uuid>/' keys of any workspace (storage/index.ts:144-148; keys.ts:337), and the worker fetches that URL and attaches the file to the outgoing mail (worker/channels/index.ts:775-792). Preconditions: a connected Yahoo mailbox, membership, and knowledge of a full key (canonical keys include a random UUID, keys.ts:123-126). Whether this reaches other tenants depends on whether workspaces share one storage config. Inferred from the shared Bunny pool, not confirmed.

Impact: A member who learns a storage key can download that object, or mail it out from their mailbox. Bounded by how unguessable the keys are.

Suggested fix (mapper): In composeReply, accept only keys that the same workspace staged: require the canonical workspace/<ws>/attachments/email/ prefix (assertOwnerScopedKey), or keep a staging table keyed by id. Drop allowLegacyKey from getAttachmentFile for rows created by compose.

Verifier: The mechanism reproduces. sendSchema takes `attachments[].storageKey: z.string()` (server/routes/emailInbox.ts:307-312) and forwards it on the Yahoo path (emailInbox.ts:371-376). composeReply stores it (inbox.ts:776-785), and getAttachmentFile reads it with allowLegacyKey: true (inbox.ts:356). With that flag, enforceOwnerScope skips the owner prefix and checks only assertSafeStorageKey (server/services/storage/index.ts:139-158, 1491-1504; keys.ts:229-250). So any safe key under the workspace's resolved storage can be downloaded. The attach-and-send path uses getFileUrl without the flag (inbox.ts:789). That accepts only the workspace's own keys or the known legacy patterns, and the legacy email-attachments/<uuid>/ pattern does not check the workspace (keys.ts:337, 359-361). I lower the severity: Bunny URLs are unsigned public CDN paths (storage/index.ts:355-361), so for the shared Bunny pool anyone who knows a key can already fetch the object from the CDN. The route adds little unless the storage is private. Keys hold a random UUID (keys.ts:123-126). Whether production uses a private zone is not visible to me.

Verifier's corrected statement: (none)

### channel:CH-6 [verifier: confirmed, severity medium] Yahoo outbound attachments are dropped without any error when their URL cannot be fetched

Evidence (mapper): Read: Core passes `url: await getFileUrl(...).catch(() => null)` (inbox.ts:786-790). The worker skips a null or non-http URL (index.ts:779), and only logs a failed fetch (index.ts:780-791; the fetch has no timeout). It then sends the mail and reports 'sent' (index.ts:794-812), while the email_attachments rows still list the files (inbox.ts:776-785). I cannot confirm whether production storage URLs are publicly fetchable.

Impact: The customer gets the reply without the file, while the operator's thread shows it as sent with the attachment.

Suggested fix (mapper): Pass a storage key (or a signed internal fetch) instead of a public URL, and fail the job if an attachment cannot be read. Add a timeout to the fetch.

Verifier: Read: Core passes `url: await getFileUrl(...).catch(() => null)` (inbox.ts:786-790). getFileUrl returns null on a scope error or missing config (storage/index.ts:1515-1524), and local storage with no public URL returns a relative '/storage/...' path (storage/index.ts:647-652). The worker skips any non-http URL without a word (worker/channels/index.ts:779). It only logs a failed fetch (780-791), with no explicit timeout. It then sends and reports 'sent' (794-812), while the email_attachments rows still list the files (inbox.ts:776-785). The customer gets the mail without the file, and the operator sees no error. How often fetches fail in production is not visible to me.

Verifier's corrected statement: (none)

### channel:CH-7 [verifier: confirmed, severity low] Yahoo compose has no idempotency, and a queue failure leaves a stuck 'queued' row

Evidence (mapper): Read: client_request_id is honoured only on the Gmail live path (emailInbox.ts:313-314,355-357). composeReply inserts the 'queued' message row (inbox.ts:750-773) before enqueueChannelJob, which throws on an insert error (jobs.ts:114-127), and nothing rolls the row back (inbox.ts:808-826). The web keeps the same request id across retries (EmailInboxPage.tsx:399-409), which only Gmail uses.

Impact: A retry after a 500 or timeout creates a second row and job, so the reply can be sent twice. The orphan row shows 'queued' forever.

Suggested fix (mapper): Honour client_request_id for Yahoo too (a unique column on email_messages), and enqueue in the same transaction as the row, or delete the row on enqueue failure.

Verifier: Read: client_request_id is used only on the Gmail live path (emailInbox.ts:313-314, 355-357; gmailLive.ts:543-571). composeReply inserts the thread and 'queued' message rows, then the attachment rows (each insert can throw, inbox.ts:785), then enqueueChannelJob, which throws on an insert error (server/services/channels/jobs.ts:114-127). Nothing rolls back or cleans up (inbox.ts:729-828). I found no sweeper for queued email_messages (grep for delivery_status 'queued' finds only inbox.ts:128, 769). The web keeps one request id across retries (src/pages/app/email/EmailInboxPage.tsx:399-428), but Yahoo ignores it, so a retry after a 500 or timeout creates a second row and job.

Verifier's corrected statement: (none)

### channel:CH-8 [verifier: confirmed, severity low] Mailbox replies carry a bare From address with no display name

Evidence (mapper): Read: Gmail live passes `from: { email: fromEmail }` (gmailLive.ts:597) and formatAddress prints just the address (channels/mail/gmail/client.ts:438-443). The Yahoo worker never passes fromName (worker/channels/index.ts:794-805; supported at yahoo/client.ts:354). Unverified whether Gmail or Yahoo add the account's name on send.

Impact: The recipient may see 'support@shop.com' instead of 'Shop Support', which looks less trustworthy. Alignment itself is fine: From is the mailbox that authenticates.

Suggested fix (mapper): Send the connected account's display name (from the userinfo at connect, or a workspace setting) as the From name.

Verifier: Read: Gmail live sends `from: { email: fromEmail }` (gmailLive.ts:597), and formatAddress prints the bare address when there is no name (channels/mail/gmail/client.ts:438-443). The Yahoo worker never passes fromName (worker/channels/index.ts:794-805), although client.ts:354 supports it. I could not verify whether Gmail or Yahoo add the account's display name on their side. Alignment is fine: From is the authenticated mailbox.

Verifier's corrected statement: (none)

### channel:CH-12 [verifier: confirmed, severity info] The web Inbox never names a mailbox; large Gmail attachments are unverified

Evidence (mapper): Read: src/lib/emailInbox-api.ts:107-191 sends no ?provider=, so with both Gmail and Yahoo connected the web always serves and replies through Gmail (inbox.ts:167-173). Gmail live accepts up to 20 MB of inline attachments (emailInbox.ts:41,353-354), base64 inside a JSON `raw` to the non-upload messages/send URI (client.ts:778-782) with a 20 s timeout (client.ts:32). Whether Gmail accepts payloads that large on that URI is unverified.

Impact: A Yahoo mailbox is unreachable from the web when Gmail is also connected. Large attachments may fail on Gmail.

Suggested fix (mapper): Pass the chosen provider from the web. Test a 15-20 MB send, or use the /upload/ URI for large messages.

Verifier: Read: src/lib/emailInbox-api.ts:108-191 never sends ?provider=, and resolveConnectedIntegration tries Gmail first (inbox.ts:167-173), so the web cannot reach a Yahoo mailbox when Gmail is also connected. The native clients do pass a mailbox (e.g. android ApiClient.kt:1282 mailboxQuery). Gmail live accepts up to 20 MB inline (emailInbox.ts:41, 353-354). The JSON body limit is 50 MB (server/middleware/bodyParsers.ts:36), so the request itself is accepted. The mail goes base64url inside JSON `raw` to the non-upload messages/send URI (channels/mail/gmail/client.ts:772-782) with a 20 s abort (client.ts:32, 68-69). Whether Gmail accepts payloads that large on that URI is unverified.

Verifier's corrected statement: (none)

### channel:M3 [found by the verifier, severity low] Gmail live replay guard is dropped exactly when our own 20 s timeout fires, so a retry can send twice

Evidence: Read: sendGmail keeps the replay entry only while the promise has not rejected (`result.catch(() => recentSends.delete(replayKey))`, server/services/email/gmailLive.ts:563-568). The Gmail call aborts after 20 s (channels/mail/gmail/client.ts:32, 68-69), even if Google has already accepted a large send. The web then retries with the same client_request_id (src/pages/app/email/EmailInboxPage.tsx:399-428), and that retry sends again. The map is per process (gmailLive.ts:543-544), so every backend deploy clears it. Inferred: a slow 15-20 MB send is the likely trigger.

### channel:M4 [found by the verifier, severity low] Yahoo outbound can be re-sent after a worker restart or lease expiry (no at-most-once guard)

Evidence: Read: jobs carry a 120 s lease (worker/channels/index.ts:93) with no extension anywhere in the worker. The header says a lost lease is re-claimed (index.ts:15). Jobs run one after another (index.ts:1014-1017), and the attachment fetch has no explicit timeout (index.ts:781). A Channels-worker redeploy between the SMTP handoff (index.ts:794) and completeChannelJob (index.ts:1018) makes the job run again and re-send. So does a job that outlives its lease, if more than one replica runs; how many replicas production runs is not visible to me.

### channel:M5 [found by the verifier, severity info] When a mail job runs out of retries, the worker posts a malformed report to the chat outbound-result route

Evidence: Read: isOutboundMessageJob matches yahoo_outbound_message and gmail_outbound_message (worker/channels/index.ts:436-438). On exhaustion the worker reports payload.message_id, which for mail jobs is the RFC Message-ID string '<hex.ts@domain>' (server/services/email/inbox.ts:795), to /internal/channels/outbound-result (index.ts:1054-1063, 449-457). That route requires a UUID and a known bot provider (server/routes/internalChannels.ts:351-357; shared/channels/botProviders.ts:15), so it answers 400 and the worker logs an error each time. This is harmless because the handler already wrote 'failed' through /yahoo/outbound-result.

### channel:M6 [found by the verifier, severity info] Yahoo inbound reads INBOX only, so customer replies that Yahoo files as spam never reach the Email Inbox

Evidence: Read: pollYahooInbox locks and searches only 'INBOX' (channels/mail/yahoo/client.ts:285-299). A Yahoo mailbox shows only Inbox/Starred/Sent (TABLE_FOLDERS, server/services/email/inbox.ts:574). Nothing here depends on Resend.

### runtimes:F2 [verifier: confirmed, severity medium] Yahoo outbound ignores the Message-ID Core stored, so new Yahoo threads split on reply

Evidence (mapper): Read in code: composeReply generates the Message-ID, stores it as email_messages.external_message_id, and for Yahoo also as the new thread's external_thread_id (server/services/email/inbox.ts:660-669, 715, 736, 755). It sends the same value as payload.message_id (:793-806). sendViaYahooSmtp supports forcing it (channels/mail/yahoo/client.ts:336-341, 365). The worker's call at worker/channels/index.ts:794-805 does not pass messageId: payload.message_id, unlike the Gmail branch at :640, so nodemailer picks its own Message-ID. Inbound Yahoo threading keys on references[0] || in_reply_to || message-id (server/routes/internalChannels.ts:830-832, lookup at :869-880).

Impact: Inferred from that code: a customer reply to a new message composed in the Email Inbox references nodemailer's id, matches no thread, and opens a new thread. The outbound row's stored id never matches a real header. Replies within an existing thread still match, because References carries the thread root. This affects only workspaces with a Yahoo mailbox connected. Not related to mail-relay.

Suggested fix (mapper): At worker/channels/index.ts:794-805 add `messageId: payload.message_id ? String(payload.message_id) : undefined`, as the Gmail branch does, and add a test.

Verifier: Reproduced. inbox.ts:665-668 generates the Message-ID. It is stored as external_message_id (:741) and, for Yahoo, as the new thread's external_thread_id (:732). It is sent as payload.message_id (:794-796). channels/mail/yahoo/client.ts:365 forces msg.messageId when given. The Yahoo branch (worker/channels/index.ts:794-805) omits messageId, while the Gmail branch passes it (:640). Inbound threading keys on references[0] || in_reply_to || message-id (internalChannels.ts:830-832, lookup :869-875). A customer reply to a Core-composed new Yahoo thread therefore carries nodemailer's id and matches no thread. The Yahoo poller reads only INBOX (yahoo/client.ts:285), so the sent copy is never synced to fix this. The client's returned messageId is also discarded (`void result`, :806). This only affects workspaces with Yahoo connected, and has nothing to do with mail-relay.

Verifier's corrected statement: (none)

### runtimes:M3 [found by the verifier, severity low] Channels-worker mailbox sends (Gmail/Yahoo) are at-least-once under one batch-wide 120 s lease with no per-job extension

Evidence: Read in code. processBatch claims up to 10 jobs with one LEASE_SECONDS=120 lease (worker/channels/index.ts:92-93, 1009-1016) and runs them sequentially. The worker heartbeat is a liveness row, not a lease extension (:1096-1106, 1121-1126). Attachment fetches (`fetch(url)` with no timeout, :616 and :779) and the Yahoo SMTP send (no timeouts, yahoo/client.ts:346-351) can stretch a batch past 120 s. claim_channel_jobs re-claims 'running' jobs whose claim expired (048_plugin_platform_and_channels.sql, WHERE status IN ('pending','running') AND claim_expires_at <= now()). completeChannelJob is claim-token guarded (server/services/channels/jobs.ts:235-247). Inferred: with two worker instances (for example an overlapping container during a redeploy), or after a kill between the send and completeChannelJob, the customer's reply is sent twice. With one instance and no crash, no duplicate.
