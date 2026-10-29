# mail-relay: the platform's outgoing mail

Since 2026-10-29 15:11 UTC both brands send every platform mail (resets,
codes, invitations, receipts, notifications) through our own Postfix relay on
`host.respok.app`, instead of Resend: `app_runtime_config.default_email_provider`
is `smtp` on both databases, host `mail-relay`, port 587. How the platform
sends, the suppression list, the bounce feed, DNS and the way back to Resend:
[`docs/operations/EMAIL.md`](../../docs/operations/EMAIL.md).

| | |
| --- | --- |
| Container | `mail-relay` (`boky/postfix:5.1.0`, pinned by digest), hostname `mail.respok.app` |
| Network | `coolify` (external), where the backends reach it as `mail-relay:587`; no port is published on the host |
| Sign-in | SASL PLAIN, one user per brand (`noreply@webyar.ai`, `noreply@respok.app`), from `.env` (`SMTPD_SASL_USERS`) |
| Encryption | none on the coolify network (`smtpd_tls_security_level none`); outward, STARTTLS when the receiving server offers it (`smtp_tls_security_level may`) |
| Senders | `@webyar.ai` and `@respok.app` only (`ALLOWED_SENDER_DOMAINS`, `check_sender_access …,reject`) |
| DKIM | selector `mx2026`, keys generated on first start into `./dkim` (`DKIM_AUTOGENERATE`) |
| Limits | IPv4 only (the host's `5.39.70.213`, PTR `mail.respok.app`), messages up to 25 MiB |
| Receiving | never: both domains' MX is iCloud |
| Bounce watcher | `mail-relay-bounce-watcher`, reads Postfix's log and reports hard bounces to each brand's backend |

The files here are the service as production runs it. `.env` (the secrets)
and `dkim/` (the DKIM private keys) exist only on the host, next to the
compose file; both are git-ignored here. Never commit or paste them.

## Deploy

The relay is not a Coolify application: it is a plain compose project on the
host, outside Coolify's queue, like `app-downloads`.

1. Find the folder production's relay was started from, and the volume its
   queue is on:

   ```sh
   docker inspect mail-relay --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'
   docker inspect mail-relay --format '{{ range .Mounts }}{{ .Name }} {{ .Source }} -> {{ .Destination }}{{ "\n" }}{{ end }}'
   ```

   Copy `docker-compose.yml`, `.gitignore` and `bounce-watcher/` from this
   folder into it. Keep its `.env` and `dkim/`. If the queue
   (`/var/spool/postfix`) is on a volume not named `mail-relay_spool`, set
   `SPOOL_VOLUME` in `.env` to that name, or mail waiting in the queue is
   left behind.
2. Add to `.env` what `.env.example` lists and it lacks (the two events
   tokens; Telegram optional). Each events token is the same value as the
   `events_token` field of that brand's Super Admin → Email provider (smtp).
   Generate one per brand: `openssl rand -hex 32`.
3. Check, then start:

   ```sh
   docker compose config --quiet
   docker compose pull mail-relay && docker compose build bounce-watcher
   docker compose up -d
   ```

   The relay restarts (a few seconds; a backend's send in that moment fails as
   a timeout or connection error and the email outbox retries it).
4. Verify:

   ```sh
   docker exec mail-relay postconf maillog_file smtpd_sender_restrictions
   docker exec mail-relay tail -n 5 /var/log/postfix/mail.log
   docker logs --tail 5 mail-relay-bounce-watcher
   ```

   The watcher's first line names the brands it reports for. Then send one
   mail (Super Admin → Email provider → Test, or a password reset) and see its
   `status=sent` line in the log.

Postfix's log is now the file `/var/log/postfix/mail.log` on the `maillog`
volume, not `docker logs mail-relay` (which keeps only the container's own
start-up lines). Read it with `docker exec mail-relay tail -f /var/log/postfix/mail.log`.
At about 30 mails a month it grows a few kB a month; rotate it when wanted
with `docker exec mail-relay postfix logrotate`: the watcher finishes the old
file and continues with the new one.

## The bounce watcher

`bounce-watcher/watcher.mjs`, plain Node 24 with no dependencies:

- reads `mail.log` from where it stopped (its position, the open queue ids
  and the reports not yet delivered are in `/state/bounce-watcher.json`, on
  the `mail-relay_watcher-state` volume; on its very first start it begins at
  the end of the log);
- matches each queue id with its sender (`qmgr … from=<…>`), and a recipient's
  `dsn=5.x.x, status=bounced` with that sender's brand;
- posts the hard bounces to `https://api.<brand domain>/api/email-events/relay`,
  signed with that brand's token (`X-Relay-Timestamp`, and
  `X-Relay-Signature: v1=<HMAC-SHA256(token, "<timestamp>.<body>")>`); the
  token itself is never sent;
- retries a report the backend did not take after 30 s, doubling up to an
  hour, for 3 days; a 400 is dropped (logged);
- with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` set, reports deferred
  deliveries (at most once per `ALERT_INTERVAL_MINUTES`, by count and
  recipient domain) and a queue of `QUEUE_ALERT_THRESHOLD` messages or more.
  Unset, there are no alerts.

The backend answers 404 until that brand's `events_token` is saved, and the
watcher keeps retrying, so the order of the two steps does not matter within
3 days. It never logs a token or an address.

Deferrals (4.x.x) are Postfix's to retry (up to 5 days, then a bounce
notice to `noreply@` at iCloud, which nobody reads); the platform learns
nothing of them, only Telegram does.

## Rotation

**A SASL password** (one brand at a time; that brand's mail waits in the
email outbox for the minute in between):

1. `openssl rand -base64 24`, put it in `SMTPD_SASL_USERS` in `.env`, then
   `docker compose up -d mail-relay`.
2. At once, in that brand's Super Admin → Email provider, type it as the
   password and save (it is stored encrypted). Press Test.
3. Mail that failed in between is retried by the outbox within minutes.

**An events token**: generate it, save it in that brand's Super Admin → Email
provider (`events_token`), then put it in `.env` and
`docker compose up -d bounce-watcher`. Reports signed with the old one get a
401 in between and are retried.

**The DKIM key** (selector `mx2026`; rotate by introducing a new selector,
never by replacing this one's key in place, which breaks every mail in flight
and every receiver's cached key):

1. Back up `dkim/`. Generate the new keys for a new selector (e.g. `mx2027`)
   for both domains with the image's own `opendkim-genkey`, under the file
   names boky/postfix's README (for the pinned version) gives for keys in
   `/etc/opendkim/keys`, and publish each domain's `mx2027._domainkey` TXT
   record. Wait until both resolve (`dig +short TXT mx2027._domainkey.webyar.ai`).
2. Set `DKIM_SELECTOR` in the compose file to the new one and
   `docker compose up -d mail-relay`. Check a sent mail's
   `DKIM-Signature: … s=mx2027` and `dkim=pass` at the receiver.
3. Remove the old `mx2026._domainkey` records a week later.

**The image**: change the tag and digest together, after reading the image's
release notes, and deploy as above.

## If the relay is down

Backends' sends fail as `connection` or `timeout` (transient): reset and
verification links are retried by the email outbox for as long as the link
is valid, receipts and plan mails for 24 hours. To send through Resend
meanwhile, switch the provider in the Super Admin
([`docs/operations/EMAIL.md`](../../docs/operations/EMAIL.md), "Back to Resend").
