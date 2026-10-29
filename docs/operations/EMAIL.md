# Email: how the platform sends mail

How every platform mail (a password reset, a code, an invitation, a receipt,
an operator notification, a transcript) leaves the platform, how failures are
retried, how bounces and complaints come back, the relay's DNS, and how to roll
the database side out or go back to Resend.

Not covered here: the Email Inbox channel (a workspace's own Gmail or Yahoo
mailbox), which never uses the platform's provider; see
[`docs/EMAIL_SURFACE_SPLIT.md`](../EMAIL_SURFACE_SPLIT.md).

Code: `server/services/email/index.ts` (sendEmail, sendPlatformEmail),
`server/services/email/providers/` (the registry and one adapter per
provider), `server/services/email/providerConfigStore.ts` (the setting),
`shared/emailProviders.ts` (the fields of each provider),
`server/services/email/suppressions.ts` (the suppression list),
`server/services/email/outbox.ts` (the retries),
`server/routes/emailEvents.ts` (bounces and complaints),
`deploy/mail-relay/` (our relay and its bounce watcher). The SQL is in
migrations 289 (suppressions) and 289b (the outbox).

## Production today (2026-10-29)

- Both brands send through our own Postfix relay, `mail-relay` on
  `host.respok.app` (`deploy/mail-relay/README.md`), since 2026-10-29
  15:11 UTC: `default_email_provider` is `smtp`, host `mail-relay`, port 587,
  user and From `noreply@webyar.ai` (WebYar) or `noreply@respok.app`
  (RESPOK). Before that it was Resend.
- No `notification_email_provider` row: operator notifications use the
  default provider too.
- About 30 mails a month. The relay's IP (`5.39.70.213`) sent its first mail
  that day, so its reputation is new.

## How the platform sends

**One registry, any provider.** Every mail goes through `sendEmail` (a
workspace's mail) or `sendPlatformEmail` (the platform's own), and both
dispatch through one registry, `server/services/email/providers/index.ts`,
to the adapter named by the setting: `resend`, `sendgrid` or `smtp` today. A
new provider is one adapter file and one line in `shared/emailProviders.ts`;
nothing outside its adapter may special-case a provider.

**The setting.** `app_runtime_config.default_email_provider` (every mail) and,
optionally, `notification_email_provider` (operator notifications, when
Super Admin → Notifications points them elsewhere). The Super Admin edits them
in Super Admin → Providers → Email; switching provider is that setting, never
a code change or a deploy. The stored shape is

```json
{ "provider_name": "smtp",
  "config":  { "from_email": "noreply@<domain>", "from_name": "…", "smtp_host": "mail-relay", "smtp_port": "587", "…": "…" },
  "secrets": { "smtp_pass": { "algorithm": "…", "nonce": "…", "ciphertext": "…", "auth_tag": "…" } } }
```

- Secrets (`api_key`, `webhook_secret`, `smtp_pass`, `events_token`) are
  encrypted with `PLUGIN_SECRETS_MASTER_KEY` the first time the row is saved
  through the store, and never returned to a browser (the form only learns
  which are set; a blank secret in a save keeps the stored one). The rows
  written before 2026-10-29 carry them in plain text under `config`; they
  keep working, and are encrypted on their next save. The 14 local daily
  dumps keep the plain text until they age out.
- Fields: every provider has `from_email` (required), `from_name` and
  `reply_to` (where replies go; unset, they go to the From address, whose
  mailbox at iCloud nobody reads). `smtp`: `smtp_host`, `smtp_port`,
  `smtp_user`, `smtp_pass`, `encryption` (`auto`, `none`, `starttls`, `ssl`),
  `tls_servername`, `events_token`. `resend`: `api_key`, `webhook_secret`.
  `sendgrid`: `api_key`, `webhook_public_key`.
- **The database wins.** `RESEND_API_KEY`, `SENDGRID_API_KEY` and `SMTP_HOST`,
  `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` only fill a field the Super Admin left
  blank (before 2026-10-29 Resend's and SendGrid's keys in the environment
  overrode the database). Do not configure mail through them; remove leftovers
  from the backends' environments. `SMTP_TLS_REJECT_UNAUTHORIZED=false` still
  turns off the certificate check of an SMTP server (only for a test server).
- **Test** in the form connects and signs in without sending anything
  (`verifyEmailProvider`).

**Every send, whatever the provider** (`deliver` in `index.ts`):

1. `to` must be exactly one plain address, at most 254 characters, else
   `invalid_recipient`.
2. A suppressed address (below) is not mailed: `suppressed`.
3. The template of the running edition is filled in.
4. The provider must be ready (an adapter, its required fields, a valid From).
5. One message: From as name and address, quoted by the adapter; a text part
   always (derived from the HTML, links kept, when the template has none);
   `Reply-To` from `reply_to`; `Auto-Submitted: auto-generated`; and, when the
   caller gives one, the one-click unsubscribe pair (below).
6. The adapter sends within its timeouts: SMTP connect 10 s, greeting 10 s,
   socket 30 s; HTTP APIs 15 s. A timeout is transient.

Every outcome is a row in `email_logs` (once the workspace is known), with
`error_message` only `"<errorCode>: <short reason>"`: the provider's own text
goes to the backend's console, never to a workspace. The codes:
`unconfigured`, `invalid_recipient`, `suppressed`, `timeout`, `connection`,
`auth`, `rejected`, `provider_error`, `template_missing`,
`edition_unavailable`. Each result says whether it is `permanent` (a retry of
the same mail cannot succeed). For the relay, `metadata.serverMessageId` is
Postfix's queue id, the key to its log lines.

`sent` means the provider accepted the mail, not that it was delivered: with
the relay, Postfix accepted it into its queue. A later refusal by the
recipient's server comes back as a bounce (below).

## The outbox: retries

`server/services/email/outbox.ts`, table `public.email_outbox` (289b).

- `sendEmailWithRetry`: one attempt now; if it failed in a way that can pass
  (`timeout`, `connection`, a provider's own error), the same mail is queued.
  Reset and verification links use it; a link is never sent after it expires,
  and a newer link of the same kind cancels the older queued one.
- `enqueueEmail`: the mail is queued and sent in the background. Receipts,
  plan mails, the trial's end and AI packs use it, each with a dedupe key (the
  ledger row), so the same mail is never sent twice.
- The worker runs inside the backend under a lease per row, and retries after
  1, 5, 15 and 60 minutes, then every 3 hours, for up to 24 hours. Each
  attempt goes through `sendEmail`, so each is logged and each checks the
  suppression list. A permanent failure is never retried. Invitations keep
  their own outbox (the invitation worker), on the same schedule.
- A queued row can hold a live link, so its payload is sealed with
  `PLUGIN_SECRETS_MASTER_KEY` and emptied the moment the row is final; final
  rows are deleted after 7 days. A pending row lives at most 24 hours (plus
  those 7 days). Privacy erasure does not touch the outbox; the purge does.
  Never change that key: a row sealed under another one fails as
  `payload_unreadable`.
- `WORKER_KIND=email-outbox` runs the worker in its own container instead.
  It must then be on mail-relay's Docker network (`coolify`), and the backend
  must have `EMAIL_OUTBOX_INPROC=0`. The same holds for any future container
  that sends mail: only containers on that network reach the relay. Today
  nothing needs this.
- On SIGTERM every in-process loop drains through
  `server/services/jobs/processShutdown.ts` (`onProcessShutdown`), bounded at
  25 s; an attempt still in flight then is abandoned and its lease reclaimed.
  A new loop registers there, never with `process.on('SIGTERM')` of its own.
- Re-sending receipts a provider lost (RESPOK's of 2026-10-09 to 10-15, 36
  mails refused by Resend with 403): `server/scripts/resendFailedBillingReceipts.ts`,
  inside the backend container, dry run first, `--apply` after the owner's
  go (steps in the script's header).

## The suppression list

`public.email_suppressions` (289), `server/services/email/suppressions.ts`.
An address on it (lower-case) is not mailed by any provider, until its
`expires_at` if it has one. A hosted provider keeps such a list of its own;
our relay does not, and mailing an address that bounces, again and again, is
what costs a new IP and domain their reputation (and with it the resets and
codes that share them).

- Fed by: the bounce and complaint reports below (`source` `resend_webhook`,
  `sendgrid_webhook` or `relay`), or a Super Admin by hand (`manual`).
- A row counts each event (`bounce_count`, `last_seen_at`); a stronger reason
  is never weakened by a weaker one, and a suppression without an end never
  gets one.
- A lookup that fails lets the mail go: losing a reset because the list could
  not be read is the worse failure.
- To take an address off: the Super Admin's suppression list
  (`unsuppressEmailAddress`), or by hand on the database as `postgres`:
  `DELETE FROM public.email_suppressions WHERE address = lower('<address>');`.
  Do it when a person says they fixed their mailbox, or after a run of 5.7.x
  policy bounces that were the relay's fault (below).

## Bounces and complaints

`server/routes/emailEvents.ts`, mounted at `/api/email-events` before
`express.json()` (each signature covers the raw bytes), rate-limited per IP
(120 a minute).

| Route | Who calls it | Trust | Turned on by |
| --- | --- | --- | --- |
| `POST /api/email-events/resend` | Resend's webhook (Svix) | `svix-id`, `svix-timestamp`, `svix-signature`: HMAC-SHA256 with `webhook_secret` | provider `resend` with `webhook_secret` set |
| `POST /api/email-events/sendgrid` | SendGrid's signed Event Webhook | `X-Twilio-Email-Event-Webhook-Signature` and `-Timestamp`: ECDSA P-256 with `webhook_public_key` | provider `sendgrid` with `webhook_public_key` set |
| `POST /api/email-events/relay` | our bounce watcher (`deploy/mail-relay`) | `X-Relay-Timestamp` and `X-Relay-Signature: v1=<HMAC-SHA256(events_token, "<ts>.<body>")>`, constant-time compare | provider `smtp` with `events_token` set |

- A route answers 404 unless its provider is the default or the notification
  provider with its secret set. Switching provider closes the old route and
  opens the new one.
- A report outside a 5-minute window, or with a wrong signature, is refused
  (401) before anything is read from it; one delivered twice within the
  window counts once. A failed database write answers 500, so the sender
  retries it.
- What is suppressed:

  | Report | Suppression |
  | --- | --- |
  | Hard bounce with status 5.1.x (no such address; Resend's `NoEmail`, SendGrid's dropped `Invalid`) | for good |
  | Any other hard bounce (5.x.x: mailbox disabled, too large, policy; SendGrid's dropped `Bounced Address`) | 30 days |
  | Complaint (Resend `email.complained`, SendGrid `spamreport` or dropped `Spam Reporting Address`) | for good |
  | Soft bounce (4.x.x, Resend `Transient`, SendGrid `blocked`), deferral, delivery | nothing |

- The console gets counts and reasons, never a secret, a signature or a body.

Setting each one up:

- **Our relay**: generate a token per brand (`openssl rand -hex 32`), save it
  as `events_token` in that brand's Super Admin → Providers → Email (smtp),
  and put the same value in the relay host's `.env`
  (`EVENTS_TOKEN_WEBYAR_AI`, `EVENTS_TOKEN_RESPOK_APP`); see
  `deploy/mail-relay/README.md`.
- **Resend**: in Resend → Webhooks add
  `https://api.<brand domain>/api/email-events/resend` with the events
  `email.bounced` and `email.complained`, and save its signing secret
  (`whsec_…`) as `webhook_secret`.
- **SendGrid**: in Settings → Mail Settings → Event Webhook, URL
  `https://api.<brand domain>/api/email-events/sendgrid`, events Bounced,
  Dropped and Spam Reports, Signed Event Webhook on; save its verification key
  (base64) as `webhook_public_key`.

**Policy bounces.** A 5.7.x is the receiver refusing the sender (SPF, DKIM,
DMARC, reputation), not the address; it is still suppressed for 30 days, like
any hard bounce. If a run of them follows a DNS or relay fault (Gmail's
5.7.26, for example), fix the cause, then take those addresses off the list.

**What still reaches nobody.** Postfix's bounce notices go to the envelope
sender, `noreply@<domain>`, at iCloud, where nobody reads them; the watcher
reads Postfix's log instead. Mail Postfix defers (4.x.x) is retried by Postfix
for 5 days; the platform learns nothing of it, and only the watcher's optional
Telegram alert says so.

## Headers and unsubscribe

Every message carries `Auto-Submitted: auto-generated` (an auto-responder must
not answer it), a text part, and `Reply-To` when `reply_to` is set. Mail a
person subscribed to (operator notifications, product updates) is sent with
`category` `notification` or `marketing` and a `listUnsubscribe` URL: the
message then carries `List-Unsubscribe: <https://…>[, <mailto:…>]` and
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), which Gmail and
Yahoo show as an unsubscribe button. A URL that is not https is left out.
Transactional mail (resets, codes, receipts, invitations) carries none: a
person cannot opt out of it.

## The relay

`deploy/mail-relay/` is the service as production runs it, with the deploy
and rotation steps. In short: Postfix on the `coolify` network, port 587, SASL
PLAIN per brand, no STARTTLS on that hop, senders `@webyar.ai` and
`@respok.app` only, DKIM selector `mx2026`, IPv4 only.

**STARTTLS** is off between the backends and the relay: the password and the
mail cross the coolify Docker network (one host, no other tenant) in clear. To
turn it on: give the relay a certificate for its name and enable
`smtpd_tls_security_level=may` (or `encrypt`), then set the provider's
`encryption` to `starttls` (and `tls_servername` when the certificate names
another host). The code is ready.

**DNS** (both domains unless noted; Cloudflare):

| Name | Type | Value | Why |
| --- | --- | --- | --- |
| `webyar.ai`, `respok.app` | TXT (SPF) | `v=spf1 ip4:5.39.70.213 include:icloud.com …` (the record's existing `all` term kept) | the relay's IP, and iCloud, which also sends as these domains |
| `mx2026._domainkey.webyar.ai`, `mx2026._domainkey.respok.app` | TXT | the domain's `mx2026` public key, from the `.txt` file next to its private key in `dkim/` on the relay host | DKIM |
| `_dmarc.webyar.ai`, `_dmarc.respok.app` | TXT | `v=DMARC1; p=none` for now | report only while the new IP proves itself; move to `quarantine` once SPF and DKIM pass for every source |
| `mail.respok.app` | A | `5.39.70.213` | the relay's name (its HELO) |
| `5.39.70.213` | PTR (at OVH) | `mail.respok.app` | a receiver checks that the IP's name points back to it |
| `mail.respok.app` | TXT (SPF) | `v=spf1 a -all` | SPF for the HELO name, which is checked when the envelope sender is empty (bounce notices) |

**Receiving stays on iCloud**: the MX of both domains is iCloud, and the relay
never receives mail. A reply to a platform mail goes to its `Reply-To` (set
it to a mailbox someone reads) or to `noreply@`, at iCloud.

Check a change with a mail to a Gmail address: Show original must read
`SPF: PASS`, `DKIM: 'PASS' with domain <domain>` and `DMARC: PASS`.

## Rollout of 289, 289b and the later 289 files

The email work of 2026-10-29 comes with `289_email_suppressions.sql`,
`289b_email_outbox.sql` and, per package, `289c_*.sql` to `289f_*.sql` (the
migration script applies them in C-locale order: 289, 289b, 289c, …). Each is
idempotent and the code runs without it (no suppressions, no queue), so the
order of code and SQL is safe either way; still:

1. **WebYar**, by hand on `host.respok.app`, **before the merge**, per
   CLAUDE.md (Database → Migrations): put `scripts/migrate-database.sh` and
   the new files in `/root/webyar-migrate-289/` with the repo's layout, take a
   schema dump, dry-run every new file in one `BEGIN … ROLLBACK`, copy the
   folder into `oqzy9q4ovntam9jgf7nxzqun`, run the script as `postgres` with
   `PGOPTIONS='-c lock_timeout=5s'`, and remove it from the container. A file
   whose header says it needs the new backend first (as 283 and 286 did) is
   applied right after the deploy instead.
2. **RESPOK**: its DB Migrator (app 40) applies them on the push to `main`.
3. Add the files to the ledger in CLAUDE.md once applied.
4. After the deploy: save each brand's email provider once in the Super Admin
   (this encrypts `smtp_pass`), set the `events_token` and start the watcher
   (`deploy/mail-relay/README.md`), and, on RESPOK, run the receipt re-send
   tool (dry run, then `--apply` after the owner's go).

## Back to Resend

The suppression list, the outbox and every rule above stay as they are; only
the setting changes.

1. In Resend, check that both domains still read Verified (RESPOK's receipts
   of 2026-10-09 to 10-15 were refused with 403), and that the API key exists.
2. Super Admin → Providers → Email: provider Resend, the API key, From
   `noreply@<domain>`, the From name; save, then Test. From that moment every
   mail goes through Resend. The relay's SMTP fields are dropped with the
   switch (save `smtp` again to come back; its password is in the relay's
   `.env`).
3. Turn on Resend's bounce feed (above, "Setting each one up"): webhook to
   `/api/email-events/resend`, its secret as `webhook_secret`.
4. The relay's route now answers 404; the watcher retries for 3 days, then
   drops what it had. Leave the relay running (it costs nothing) or stop it
   with `docker compose stop` in its folder.
5. Mail queued in the outbox before the switch is sent through Resend on its
   next attempt.
