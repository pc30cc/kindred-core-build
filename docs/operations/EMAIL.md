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
migrations 289 (suppressions), 289b (the outbox) and 289g (the offline
notice's switch, the outbox's supersede rank, a quota's use given back).

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
  `tls_servername`, `tls_ca` (the PEM a self-signed server certificate is
  checked against: our relay's, below), `events_token`. `resend`: `api_key`,
  `webhook_secret`.
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
3. The template of the running edition is filled in (the caller's own text
   when the row is missing; no edition, no mail: `edition_unavailable`).
4. The provider must be ready (an adapter, its required fields, a valid From).
5. The layout around it, with the brand as it is now (below, "The layout").
6. One message: From as name and address, quoted by the adapter; a text part
   always (derived from the content, links kept, when the template has none);
   `Reply-To` from `reply_to`; `Auto-Submitted: auto-generated`; and, when the
   caller gives one, the one-click unsubscribe pair (below).
7. The adapter sends within its timeouts: SMTP connect 10 s, greeting 10 s,
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

## The layout (since 2026-10-30)

Every platform mail wears one layout, in code (`server/services/email/layout.ts`,
the "brand band" design the owner chose): a band in the brand's colour with
the logo, a white card rising out of it, the logos' chat-bubble tail on the
card, the button, the code box, the details and the callouts, one saffron
(WebYar) or signal (RESPOK) dash above the title, and the footer under the
card. The email core wraps a mail in it when it sends it, so a queued mail
wears the brand as it is then:

- a template row's content, a caller's own text when the row is missing (a
  caller's whole document gives its body), and a request with no template
  (the Super Admin provider test is the template `email_test` now);
- not a row that is a whole document of its own (it holds `<html`): a Super
  Admin's hand-made full design goes as it is, the unsubscribe line before
  its `</body>`.

**What a row holds.** Only the content, in this vocabulary; anything else
passes through as it is (but for what a mail may not send, below), and an
inline `style` of the author's wins over ours:

| Element | Role |
| --- | --- |
| `div.preheader` (first, optional) | the hidden inbox preview |
| `h1` (one) | the title |
| `p`, `p.note` | a paragraph; small muted text |
| `p.action > a` | the button (exactly one link; anything else stays a paragraph) |
| `div.code` | a one-time code: left to right, a Latin face |
| `table.details > tr > th + td` | a key/value summary (`td dir="ltr"` for a phone or a card) |
| `blockquote` | a customer's own words |
| `div.warning`, `div.notice` | callouts |
| `hr`, `strong`, `a`, `br` | separators and inline text |
| `div.transcript > div.msg.msg-visitor\|msg-agent > div.meta + div.bubble` | a chat transcript |

Inside a transcript or a details table, what is not a message or a row (an
older mail's `<p>` lines, a caption, a note of the Super Admin's) is kept, in
a row of its own or above the rows. A visitor's message keeps its lines: its
sender turns each line break into `<br>` (HTML folds a bare one, and Outlook
ignores `white-space`), which the derived text part reads back as a line.

**What a mail may not send** (`contentProblems` in `layout.ts`, the design
panel's deliverability rules): anything that runs code, loads a page or takes
input (`script`, `iframe`, `object`, `embed`, `form`, `input`, `button`,
`select`, `textarea`, `link`, `meta`, `base`, inline `svg` and `math`, and
`on…` handlers); anything hidden but the one preheader; a background image;
more than two images, or one without its width, height and alt text; a link
or an image off the brand's own hosts (the panel's and the site's, with their
subdomains), a mailto other than the support address included; and a content
over 40 KB. A placeholder the sender fills (`href="{action_url}"`) passes; the
filled value is checked when the mail goes. At send time the core drops the
first group whatever the row says (a form or a button keeps its words) and
logs the rest as `[email] <slug> (<edition>, <locale>): <codes>`, once per
template in a process and never the content, so a row edited by hand can be
fixed in Super Admin. A "Send me a test" is not logged there: its text need
not be the stored row's, and it would use up that row's one line. Super Admin sees the same list while editing, as
warnings under Branding → Email templates' preview (`templateContentProblems`
in `index.ts`: the same rules, against the same brand hosts); a save is not
refused for them. Every row 291
writes passes them on both brands. The content's comments end where a
browser ends them, and one that never ends is dropped, so nothing in a row can
hide the footer and its unsubscribe line.

**What the core adds at send time.** `{brand}` (the platform's name in the
template's language), `{year}` (the Persian year in a Persian mail of the
Iranian edition) and `{support_email}`, under the caller's values; the
caller's words for the template's own language (`localizedData`) over them.
The layout reads the logo from `resolveBrandAssets`
(`server/services/platformBrandAssets.ts`, the one place the project reads a
logo; PNGs, the dark variant on the band, the light one on a paper plate when
there is no dark one), the app's address (`platform_domains.app_base_url`),
the legal line (the language's `footer_company_text`, else © the year and
`legal_company_display_name`, else © the year and the brand) and the line
saying why the mail came, by its category, in fa, en and tr. A notification's
unsubscribe line takes that line's place, inside the footer.

**Language, not brand.** Direction and fonts follow the mail's language: a
Persian mail is right to left in IRANSans in both editions, English and
Turkish are Figtree (the widget's font files, `/widget/fonts/` on the app's
host). Outlook gets Tahoma or Segoe UI (it shows Times for a web font).

**Dark mode.** Apple Mail, iOS Mail and the Outlook apps get the dark palette
by `prefers-color-scheme`, Outlook.com by its `data-ogsc`/`data-ogsb` hooks;
Gmail inverts by itself, and the band and the dash hold their colour there.
An author's element with its own background keeps its own text colour; an
author's colour alone gets the dark colour on a dark card.

**The text part** is the row's `text_body` when it has one, else the content
as text (no preheader, images by their alt text, links with their targets, a
details row as "Label: value") and the footer's lines.

**Super Admin → Branding → Email templates** lists every template from one
catalog (`server/services/email/templateCatalog.ts`): the mails the platform
sends, with the placeholders each sender fills, then the ones nothing sends
any more ("No longer sent"); a language the edition does not offer is shown
read-only. A sent mail's template is edited, never deleted or switched off
(`409 template_in_use`). The preview renders through the same path
(`renderEmailForPreview` in `server/services/email/index.ts`: the same fill,
layout and brand), filled with the catalog's sample values in the edition's
way, light or dark, at a desktop or phone width, with its text part. "Send me
a test" sends the text being edited through `sendEmail` (its `template`
field) to the signed-in Super Admin's own verified address, as platform mail,
10 in ten minutes and 50 a day per admin. Super Admin → Verification shows the
`verification_code` template through the same preview.

**Looking at it.** `scripts/email/render-all-templates.mts` renders every row
of a database (`--database`), the seeds of a fresh chain (`--fresh`), or a
samples file (`--samples`) through the real core into HTML, text, shots
(desktop and mobile, light and dark) and contact sheets, with the brand hosts
served from `public/`. `--no-web-fonts` and `--gmail-invert` add the renders
Gmail and Outlook show (no web fonts; Gmail's forced dark). A development
tool: it sends nothing and only reads a database.

## The outbox: retries

`server/services/email/outbox.ts`, table `public.email_outbox` (289b).

- `sendEmailWithRetry`: one attempt now; if it failed in a way that can pass
  (`timeout`, `connection`, a provider's own error), the same mail is queued.
  Reset and verification links use it; a link is never sent after it expires,
  and a newer link of the same kind cancels the older queued one.
- A mail can name what replaces it (`supersedeKey`) and, when the order of
  queueing is not the order things happened in, a rank (`supersedeRank`,
  289g): the highest rank under a key is the one sent. The offline-message
  summary is ranked by its count, so of a burst's summaries the one with the
  most messages goes, whichever reached the queue last.
- `enqueueEmail`: the mail is queued and sent in the background. Receipts,
  plan mails, the trial's end and AI packs use it, each with a dedupe key (the
  ledger row), so the same mail is never sent twice.
- The worker runs inside the backend under a lease per row, and retries after
  1, 5, 15 and 60 minutes, then every 3 hours, for up to 24 hours. Each
  attempt goes through `sendEmail`, so each is logged and each checks the
  suppression list. A permanent failure is never retried. Invitations keep
  their own outbox (the invitation worker), on the same schedule.
- A mail the provider took stays taken: if the row's `sent` cannot be
  written (a database hiccup at that moment), the write is retried, and if
  it still fails the row is left to its lease rather than put back in the
  queue; only a lease that runs out before anything is written sends it
  again (at least once).
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
  The HTTP server keeps answering while they drain and closes last (its
  drain is registered `last`): Traefik routes to the old container until it
  exits, so a listener closed first answered those requests with 502. A new
  loop registers there, never with `process.on('SIGTERM')` of its own.
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
  Do it when a person says they fixed their mailbox. Refusals of our sending
  (5.7.x) are not suppressed (below), so a DNS or relay fault leaves nothing
  to take off.

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
  | Hard bounce about the mailbox or its domain (5.2.x: disabled, full; 5.4.4: no mail route), or one without a status (Resend's `Permanent`, SendGrid's `bounce`, SendGrid's dropped `Bounced Address`) | 30 days |
  | Hard bounce about our sending, not the address (5.7.x: IP reputation, SPF, DKIM, DMARC, a policy; 5.0.0, 5.3.x to 5.6.x) | nothing; the console names the statuses, and the relay's watcher alerts Telegram |
  | Complaint (Resend `email.complained`, SendGrid `spamreport` or dropped `Spam Reporting Address`) | for good |
  | Soft bounce (4.x.x, Resend `Transient`, SendGrid `blocked`), deferral, delivery | nothing |

  The rule is `isSuppressible` in `emailEvents.ts`, the same for every
  provider; the relay's watcher applies it too, and leaves those refusals
  out of its reports.

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
DMARC, the relay's IP reputation), not the address, so it suppresses
nothing: a new IP refused by Gmail or Outlook, or one DKIM mistake, must not
keep every reset and receipt from those addresses for 30 days after it is
fixed. Each one is named on the backend's console and, for the relay, in the
watcher's log and its Telegram alert (the first at once), by recipient
domain and status, never by address. When it comes: check the mail's
`Authentication-Results` at a Gmail address (above, "DNS"), the relay's DKIM
key and the IP's standing (Google Postmaster Tools, Microsoft SNDS), then
send again; the mail that was refused is not resent by itself.

**What still reaches nobody.** Postfix's bounce notices go to the envelope
sender, `noreply@<domain>`, at iCloud, where nobody reads them; the watcher
reads Postfix's log instead. Mail Postfix defers (4.x.x) is retried by Postfix
for 5 days; the platform learns nothing of it, and only the watcher's optional
Telegram alert says so.

## Headers and unsubscribe

Every message carries `Auto-Submitted: auto-generated` (an auto-responder must
not answer it), a text part, and `Reply-To` when `reply_to` is set. Mail a
person subscribed to (operator notifications, product updates, and the
owners' and admins' notice of a visitor's offline message) is sent with
`category` `notification` or `marketing` and a `listUnsubscribe` URL: the
message then carries `List-Unsubscribe: <https://…>[, <mailto:…>]` and
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), which Gmail and
Yahoo show as an unsubscribe button. A URL that is not https is left out.
The same link is in a line under the mail's text, which opens a page that
asks first; the one click turns that one type off in the person's own
switches (`user_email_notification_prefs`, Settings → Notifications).
The offline-message notice has no platform switch (it is the workspace's own
mail), only each recipient's (`offline_messages`, 289g), and the workspace's
reply-to address, which stands in when no owner or admin has an address,
gets no link: it is a setting, not a subscription.
Transactional mail (resets, codes, receipts, invitations) carries none: a
person cannot opt out of it.

## The relay

`deploy/mail-relay/` is the service as production runs it, with the deploy
and rotation steps. In short: Postfix on the `coolify` network, port 587, SASL
PLAIN per brand, STARTTLS with the relay's own certificate and no AUTH before
it, senders `@webyar.ai` and `@respok.app` only, DKIM selector `mx2026`,
IPv4 only.

**STARTTLS between the backends and the relay.** Every Coolify application
on the host joins the coolify Docker network, so in clear the SASL password
and every mail (reset links, codes, invitation tokens) can be read by any
container there that can watch it. The relay offers STARTTLS with a
certificate of its own, self-signed for `mail-relay` (CN and SAN), made once
on the host into `deploy/mail-relay/tls/`, mounted read-only and never
committed; the backends check it against that same certificate, saved as
the smtp provider's `tls_ca`. Production's hop stays plain until this is
rolled out, without a mail outage, in this order (the commands are in
`deploy/mail-relay/README.md`, "TLS"):

0. Save each brand's smtp provider with `encryption` `none`. Today's rows have
   none set, which is `auto`: it would take the STARTTLS the relay starts to
   offer and refuse the self-signed certificate, and every mail would fail.
1. Deploy the relay with TLS offered but not yet required
   (`RELAY_TLS_AUTH_ONLY=no` in its `.env`).
2. Save each brand's smtp provider with `encryption` `starttls`,
   `tls_servername` `mail-relay` and `tls_ca` the certificate's PEM.
3. Test: the form's Test, then one real mail, and the relay's log shows TLS
   before the sign-in.
4. Turn on `smtpd_tls_auth_only` (remove `RELAY_TLS_AUTH_ONLY` from `.env`;
   the compose's default is `yes`) and test again.

Until step 4 a client may still sign in without TLS; after it, a provider
saved with `encryption` `none` can no longer send through the relay.

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
`289b_email_outbox.sql` and, per package, `289c_*.sql` to `289g_*.sql` (the
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
   (`deploy/mail-relay/README.md`), roll out the relay's STARTTLS ("The
   relay", above), and, on RESPOK, run the receipt re-send tool (dry run,
   then `--apply` after the owner's go).

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
