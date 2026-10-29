# Findings for package G

(From the 2026-10-29 audit of origin/main 1df282b80; line numbers refer to that commit.)

### config:CFG-14 [verifier: confirmed, severity low] Docs and runbook do not describe the new relay; env-var docs are the only email setup docs

Evidence (mapper): Read in docs. README.md:80 says 'Resend, SendGrid, SMTP (configured via env or DB)', and README.md:207-208 lists the env vars. COOLIFY_DEPLOY.md:83-88 lists RESEND_API_KEY, SENDGRID_API_KEY and SMTP_* as the email settings. server/.env.example:111-122 and .env.docker.example:79-84 do the same. docs/EMAIL_SURFACE_SPLIT.md:32 still names 'EmailPage test send → POST /api/email/send', which is retired with 410 (its own line 42; email.ts:38-41). docs/GOTRUE_OFF_STATIC_AUDIT.md:141 says '2 email providers (Resend, SendGrid)', which is historical. CLAUDE.md's production section has no mention of mail-relay, its SASL users, the DKIM selector mx2026, or that default_email_provider is smtp on both brands since 2026-10-29 (grep 'mail'/'smtp'/'resend' finds nothing relevant). No doc was found that says Resend is the live provider.

Impact: The next operator has no runbook for the relay (where its credentials live, how to rotate the password, DKIM and SPF, why STARTTLS is absent) and may try to configure email through env vars, which leftover-precedence rules make risky (CFG-12).

Suggested fix (mapper): Add a CLAUDE.md and docs/operations entry for mail-relay and the stored provider value. Mark the env vars as fallback only and fix EMAIL_SURFACE_SPLIT.md line 32.

Verifier: Read in docs. README.md:80 and :207-208 and COOLIFY_DEPLOY.md:83 describe email only through env vars. EMAIL_SURFACE_SPLIT.md:32 still maps src/providers/email/api.ts to the retired POST /api/email/send, while api.ts actually calls /api/email/send-channel (src/providers/email/api.ts:24), so the line is stale on both counts. GOTRUE_OFF_STATIC_AUDIT.md:141 is historical. A grep for mail-relay / mx2026 finds nothing in docs or CLAUDE.md. No doc says Resend is the live provider.

Verifier's corrected statement: (none)

### config:CFG-17 [verifier: confirmed, severity info] smtp_pass is stored in plaintext in app_runtime_config

Evidence (mapper): Read in code. The value is written as-is by adminManagement.ts:1233-1236; no encryption helper is applied to runtime-config secrets. PLUGIN_SECRETS_MASTER_KEY is used only by plugins, GSC and backups (grep). From CLAUDE.md, not code: the local Coolify daily dumps are not encrypted, while the off-site Bunny copies are.

Impact: The relay password, and the old Resend key in older dumps, sit in clear in the database and the 14 local daily dumps on the server.

Suggested fix (mapper): Consider encrypting provider secrets at rest under PLUGIN_SECRETS_MASTER_KEY, together with the CFG-1 redaction.

Verifier: Read in code. The PUT stores body.value as is (adminManagement.ts:1231-1236). The PLUGIN_SECRETS_MASTER_KEY users are plugins, GSC, the gmail/yahoo channel OAuth and backups (grep: server/services/plugins/secrets.ts, seo/gsc, channels/{gmail,yahoo}/oauth.ts, backup/*); runtime config is not among them. The list in the finding misses the channel OAuth users, but its conclusion holds. That the local dumps are unencrypted comes from CLAUDE.md, not from code.

Verifier's corrected statement: (none)

### platform:F4 [verifier: confirmed, severity medium] 'sent' now means 'queued by our Postfix': no bounce handling, no suppression, DSNs go to an unread iCloud mailbox

Evidence (mapper): Read in code: sendViaSMTP reports success once the relay accepts DATA (smtp.ts:36-48). That becomes email_logs status 'sent' (index.ts:527) and invitation 'provider_accepted' (worker.ts:342-345, 407-410). No envelope or Return-Path is set, so MAIL FROM = From address = noreply@<domain> (nodemailer mime-node getEnvelope, dist/cjs/mime-node/index.js:1025-1029). A repo-wide search found no bounce, complaint, webhook or suppression handling and no Resend webhook consumer, so no code stops working. Inferred (product knowledge, not in this repo): Resend kept its own suppression list of hard-bounced and complained recipients; that protection is gone. Per the given facts, mail for these domains is received at iCloud, so later DSNs land there.

Impact: Delivery failures after the relay accepts the mail (Gmail/Outlook rejections, unknown users) are invisible in the app, and the same bad addresses keep getting mail. That hurts the new IP's and domain's reputation and hides problems such as SPF/PTR/DKIM misconfiguration.

Suggested fix (mapper): Monitor the Postfix log or queue on the relay (deferred/bounced counts to Telegram). Give the bounce address a mailbox someone reads, or a VERP/bounce-processing address. Keep a suppression table that sendEmail checks before sending. Store nodemailer 10.2's info.serverMessageId (the Postfix queue id) in email_logs so log lines can be matched.

Verifier: smtp.ts:36-48 reports success once sendMail resolves. That becomes email_logs 'sent' (index.ts:527) and invitation 'provider_accepted' (worker.ts:342-345, 407-410). No envelope is set, so MAIL FROM is the From address (nodemailer mime-node getEnvelope). A search of server/, src/, shared/, worker/ and channels/ found no webhook, bounce, complaint or suppression handling; outside the two dispatch switches and readiness.ts:76, nothing references 'resend' (index.ts:421, 491). Two points are inference, not code: that Resend kept a suppression list, and that DSNs reach an iCloud mailbox (whether noreply@ exists there is unknown; if it does not, DSNs are lost entirely).

Verifier's corrected statement: (none)

### runtimes:F12 [verifier: confirmed, severity info] 'sent' means the relay accepted it; nothing feeds bounces back, and the relay is not described in the repo

Evidence (mapper): Read in code: smtp.ts:44-48 reports success as soon as sendMail resolves. sendEmail logs status 'sent' (index.ts:527), and invitations record 'provider_accepted' (worker.ts:333-337, 403-407). The envelope sender is the From address, nodemailer's default (inferred), so bounces go to noreply@<domain> at iCloud (MX per the brief). A grep for mail-relay, postfix and mx2026 finds nothing in deploy/, docs/ or CLAUDE.md.

Impact: Deferred or bounced mail (SPF/DKIM problems, a full Postfix queue, Gmail throttling the single IPv4) is invisible in email_logs and in the invitation state. A server move or rebuild has no repo record of the relay's container, SASL users, sender policy or DKIM selector.

Suggested fix (mapper): Monitor the Postfix queue and logs (e.g. Telegram alerts on deferrals or bounces). Decide whether noreply@ should exist on iCloud for bounces. Add deploy/mail-relay/README.md with the compose file, network, auth and DKIM setup, and a CLAUDE.md line.

Verifier: smtp.ts:44-48 reports success when sendMail resolves. index.ts:527 logs 'sent', and invitations record 'provider_accepted' (worker.ts:333-337, 403-407). A repo grep for mail-relay, postfix and mx2026 finds only the SMTP form's description text (src/features/providers/schemas.ts:83, 'Postfix') and an old .lovable plan file: no deploy/ or docs/ record of the relay. That the envelope sender equals the From address, so bounces go to noreply@ at iCloud, is nodemailer default behaviour and is inferred.

Verifier's corrected statement: (none)

### runtimes:F14 [verifier: confirmed, severity info] Resend and SendGrid keys in env override the Super Admin config; nothing tests the SMTP path

Evidence (mapper): Read in code: resend.ts:31 `process.env.RESEND_API_KEY || cfg.api_key` and sendgrid.ts:14 put env first, while smtp.ts:17-20 puts config first. COOLIFY_DEPLOY.md:83 and README.md:207 still document RESEND_API_KEY. The only test touching smtp.ts mocks it (src/test/security/emailLogSecretRedaction.test.ts:53-54), so nodemailer 10.2.1 is never exercised in CI.

Impact: No effect while provider_name is smtp. If the provider is ever switched back to Resend while an old RESEND_API_KEY stays in a backend env (not verifiable), that env key wins silently. An SMTP regression would only show in production.

Suggested fix (mapper): Remove RESEND_API_KEY and SENDGRID_API_KEY from the backend envs if present, and update the docs. Add a unit test of sendViaSMTP against a stub SMTP server (or nodemailer's stream transport) asserting the from, envelope and text part.

Verifier: resend.ts:31 and sendgrid.ts:14 put the env key ahead of the config, while smtp.ts:17-20 puts config first. COOLIFY_DEPLOY.md:83-88 and README.md:207-208 still document RESEND_API_KEY and SENDGRID_API_KEY. The only test touching smtp.ts mocks it out (src/test/security/emailLogSecretRedaction.test.ts:52-55, 'SMTP is not exercised here'), and no other test file references providers/smtp, sendViaSMTP or nodemailer. Whether backend envs still hold those keys is not verifiable.

Verifier's corrected statement: (none)

### channel:CH-10 [verifier: confirmed, severity info] The provider switch has no effect on the Email Inbox, and nothing inbound assumed Resend

Evidence (mapper): Read: inbox.ts, gmailLive.ts, the worker's yahoo_* cases and internalChannels.ts never read app_runtime_config or call sendEmail. Outbound goes through Gmail's API or Yahoo's SMTP with the customer's OAuth (paths above). Inbound is Gmail Pub/Sub (gmailPush.ts:70-119) or a Yahoo IMAP poll (worker/channels/index.ts:670-760). A grep for svix, bounce, 'email.delivered' or Resend webhooks across server/channels/worker finds no inbound or bounce handler. Resend appears only in the platform provider switch (index.ts:491-493, providers/resend.ts). Nothing processes bounces: before the switch Resend kept them on its side; now they go to the envelope sender noreply@ (iCloud). Inferred: nodemailer uses the From address as MAIL FROM by default.

Impact: Operators' replies keep working unchanged. Bounces of platform mail are not seen anywhere.

Suggested fix (mapper): None needed for the Inbox.

Verifier: Read: inbox.ts, gmailLive.ts, the worker's yahoo_* and gmail_* cases (worker/channels/index.ts:591-824) and internalChannels.ts never call sendEmail or read default_email_provider. A grep across server/, channels/ and worker/ for svix, bounce, Resend webhooks or email.delivered finds no inbound or bounce handler; the only 'bounce' hits are unrelated (alertEvaluator debounce, a billing redirect). Inbound mail is Gmail Pub/Sub, OIDC-verified (server/routes/gmailPush.ts:41-119), or the Yahoo IMAP poll (worker/channels/index.ts:670-760). That bounces now go to the From address (nodemailer uses it as MAIL FROM by default) is from nodemailer's documentation, not run here.

Verifier's corrected statement: (none)

### channel:CH-11 [verifier: confirmed, severity info] Dead or stale email-channel client code and docs that still describe Resend or the old route

Evidence (mapper): Read: src/providers/email/api.ts (registered with '__default__', which authorizeWorkspaceAccess would reject as not a UUID, workspaceAuth.ts:171-174; useEmailProvider has no consumer); src/providers/bootstrap.ts:107-128 description 'Resend/SendGrid/SMTP'; sendChannelEmail.ts has no production caller; docs/EMAIL_SURFACE_SPLIT.md:32 says api.ts calls /api/email/send; the inbox.ts:659-665 comment is wrong (see CH-3). POST /api/email/test-send (email.ts:43-70) has no caller in src and tells a manager 'Your workspace email provider is configured correctly', although workspaces have no provider.

Impact: Misleads the next change, and keeps an attack surface (CH-1) alive with no user.

Suggested fix (mapper): Remove api.ts and its registration, sendChannelEmail.ts and the send-channel route, and correct the docs and comments.

Verifier: Read: src/providers/bootstrap.ts:110 registers createApiEmailProvider('__default__'), with descriptions that still name Resend/SendGrid/SMTP (bootstrap.ts:108-109, 125). '__default__' would fail the UUID check (featureGating's gate or workspaceAuth.ts:171-174). useEmailProvider (ProviderContext.tsx:98) has no consumer. docs/EMAIL_SURFACE_SPLIT.md:32 still says api.ts calls /api/email/send, and the inbox.ts:659-665 comment is wrong (see CH-3). /api/email/test-send (email.ts:43-70) has no caller in src or the native apps. A small correction: its 'Your workspace email provider is configured correctly' text is only the fallback used when the 'email_test' template is missing (email.ts:53-63).

Verifier's corrected statement: (none)

### notifications:N3 [verifier: confirmed, severity medium] No bounce or complaint handling, no List-Unsubscribe, no unsubscribe link

Evidence (mapper): Read in code: searching server/ and shared/ for bounce/complaint/suppression/List-Unsubscribe/unsubscribe finds no mail code. sendViaSMTP passes only from/to/subject/html/text (providers/smtp.ts:36-42), and EmailRequest has no headers field (email/index.ts:39-79). An email_logs row 'sent' only means the relay accepted the mail (index.ts:521-533). The templates have no unsubscribe link (migration 206:166-247); opting out needs a signed-in PATCH /api/notifications/email (routes/notificationEmail.ts:81-121), and with no row the default is yes (queue.ts:101). The locked-data deletion countdown starts once the relay accepts the notice (locks/retention.ts:335-341). Inferred (nodemailer default, not verified in this tree): the envelope sender is the From address, so delivery-failure notices go to noreply@<domain>, whose MX is iCloud, and nothing in the app reads them.

Impact: Addresses that hard-bounce keep getting mail: a digest every window, an offline notice for every capture, hourly billing retries. Complaints are invisible. Gmail and Yahoo expect one-click List-Unsubscribe (RFC 8058) on subscribed or marketing mail (announcements, digests, weekly summaries) from bulk senders (Gmail: about 5,000/day); below that it still counts toward reputation. Data deletion can go ahead on a notice that bounced.

Suggested fix (mapper): Let sendViaSMTP take headers. Add List-Unsubscribe (an https one-click URL with a signed token that flips user_email_notification_prefs) and List-Unsubscribe-Post to the notification types, plus a footer link. Route the relay's bounces to something that writes a suppression list, and check that list in sendEmail.

Verifier: No mail code anywhere handles List-Unsubscribe, bounces, complaints or suppression (grep over server/shared/channels/worker/ai-runtime). There is no provider webhook route. sendViaSMTP passes only from/to/subject/html/text (providers/smtp.ts:36-42), and EmailRequest has no headers field (email/index.ts:39-79). The 'sent' row in email_logs means the relay accepted the message (index.ts:521-533). Operators can opt out only through PATCH /api/notifications/email while signed in (routes/notificationEmail.ts:79-121), and no row means yes (queue.ts:156-171). The locked-data notice counts toward the deadline once sendBillingEmail succeeds (retention.ts:325-354). That the envelope sender is the From address is nodemailer's default; I did not verify it in this tree.

Verifier's corrected statement: (none)
