# What packages A and E built (already on the base branch)

## Package A — commits 6d1ef5ff3 Email core: one provider registry, timeouts, headers, suppressions, encrypted provider config

### Notes for the other packages

NEW AND CHANGED EXPORTS
- server/services/email/index.ts
  - Keeps sendEmail, sendPlatformEmail, isEmailProviderConfigured, resolveEmailScope and interpolate.
  - Re-exports these types from ./providers/types.ts: EmailCategory, EmailErrorCode, OutboundMessage, ProviderConfig, SendResult.
  - Adds isTransientEmailFailure(r) and htmlToText(html).
  - EmailRequest and PlatformEmailRequest gain category and listUnsubscribe {url, mailto?}. A URL that is not https is dropped with a console warning.
  - SendResult adds errorCode, permanent and queuedRetry, plus an extension, serverMessageId (the relay's queue id, also written to email_logs metadata).
  - SendResult.error is always "<errorCode>: <short reason>" and is safe to return to a workspace.
- Caller semantics:
  - No provider row: provider 'stub', errorCode 'unconfigured', permanent. Callers that test provider==='stub' keep working.
  - A provider with no adapter, or missing required fields: provider = its name, errorCode 'unconfigured', permanent.
  - An invalid or suppressed recipient: provider 'none', permanent.
  - The provider row cannot be read: provider 'none', 'provider_error', transient.
  - EDITION_UNAVAILABLE is now errorCode 'edition_unavailable' (transient).
  - A missing template with no fallback content: 'template_missing'.
  - Packages B and E should branch on errorCode/permanent rather than provider==='stub'.
  - sendEmail now writes an email_logs row for every outcome once workspaceId is valid, including invalid_recipient, suppressed and unconfigured.
- providers/index.ts (the registry): getEmailAdapter(name), effectiveEmailProviderConfig(provider) (database wins, environment fills a blank), emailProviderProblems, emailProviderReadiness(provider|null) -> 'unconfigured'|'configured'|'invalid', describeEmailProviderProblem.
- providers/types.ts: the EmailAdapter interface {name, send(config, message), verify?(config)}, emailFailure, httpFailure, fetchFailure, formatMailbox, timeoutSignal, HTTP_TIMEOUT_MS and EMAIL_ERROR_CODES.
- The old sendViaResend, sendViaSendGrid and sendViaSMTP exports are gone. Each adapter file exports resendAdapter, sendgridAdapter or smtpAdapter. smtp.ts also exports SMTP_TIMEOUTS and classifySmtpError; resend.ts keeps isResendSendResponse.
  - A test that mocks a provider module must return {resendAdapter: {name: 'resend', send: async (cfg, message) => SendResult}}.
- providerConfigStore.ts: implements the contract, plus isEmailProviderKey, loadEmailProviderConfig (status 'ok', 'none' or 'error') and decodeEmailProviderRow.
  - readEmailProviderForAdmin throws 'email_provider_read_failed: …' on a database error.
  - writeEmailProviderConfig error codes: unknown_key, unknown_provider, unknown_field, invalid_field, missing_field, encryption_unavailable, storage_error (with a field where it applies).
  - A write accepts exactly EMAIL_PROVIDER_COMMON_FIELDS plus EMAIL_PROVIDER_FIELDS[provider]. The legacy aliases smtp_username, smtp_password and smtp_secure are folded into today's names.
  - An absent non-secret field is cleared. A blank secret keeps the stored value, but only for the same provider.
  - There is no way to clear an optional secret except switching provider or saving 'disabled'.
  - The stored shape is {provider_name, config: {non-secrets}, secrets: {field: AES-GCM envelope}}. The envelope carries no fingerprint, because an unsalted hash of a password is a guessing oracle.
  - Every change writes an audit row to audit_logs: action 'admin.email_provider.changed', workspace_id null, new_value {key, provider_name, changed_fields}. So migration 289 adds no audit table.
- suppressions.ts: the contract's functions, plus suppressionKey.
  - suppressEmailAddress throws on an invalid address, reason or source, or on a database error. It calls the RPC email_suppression_record.
  - isEmailSuppressed fails open: a failed lookup lets the mail go.
- shared/emailProviders.ts: the contract's exports, plus EMAIL_PROVIDER_COMMON_FIELDS, EMAIL_PROVIDER_FIELDS, EMAIL_PROVIDER_REQUIRED_FIELDS, EMAIL_PROVIDER_ENV_FALLBACKS, isEmailProviderAdapter, smtpEncryptionMode, canonicalEmailProviderConfig, parseEmailAddress, withEmailProviderEnvFallbacks and emailProviderConfigProblems. These are safe for the browser form (D) to import.
- redactLogMetadata.ts:
  - buildEmailLogMetadata takes a third argument {serverMessageId, category}.
  - New redactEmailLogSubject and redactEmailLogError.
  - redactEmailLogRows now also rewrites an older row's raw error_message as a generic 'provider_error: …', and masks the code in the subject of rows whose templateData had a code key.

WIRING LEFT TO OTHERS
- D (Super Admin):
  - adminManagement GET/PUT/DELETE /runtime-config/:key still reads and writes the email rows raw. GET returns plaintext legacy secrets, or encrypted envelopes after a store write. PUT bypasses validation and encryption.
  - Route default_email_provider and notification_email_provider through readEmailProviderForAdmin and writeEmailProviderConfig instead (actor = adminUser id).
  - Build the form from the shared field lists: an encryption select, reply_to, tls_servername, secretKeysSet shown as 'set'. Hide vendors that have no adapter. Wire Test to verifyEmailProvider.
- D/C: adminNotificationEmail.ts provider_configured only checks that the row exists. It should be emailProviderReadiness(await readEmailProviderConfig(config, 'notification_email_provider')) === 'configured'. Its PROVIDERS constant should be EMAIL_PROVIDER_ADAPTERS.
- C: the notification dispatcher should pass category 'notification' (product updates: 'marketing') and listUnsubscribe {url: an https one-click endpoint, mailto?}. C also owns the ticker in-flight guard.
- B: route `to` validation can reuse parseEmailAddress. Routes may now return result.error as is.
- E: the outbox uses isTransientEmailFailure and permanent, and sets queuedRetry.
- F: channels/mail/yahoo/client.ts still has no SMTP timeouts. Reuse SMTP_TIMEOUTS.
- G:
  - Bounce and complaint webhooks feed suppressEmailAddress. The config fields already exist: Resend webhook_secret, SendGrid webhook_public_key, SMTP events_token (each secret one is in the secret lists).
  - Docs, and noting that the env vars now only fill blanks.
  - Drop @types/nodemailer from package.json and server/package.json (nodemailer 10 ships its own types). Not done here because A does not own those files.

ROLLOUT
1. Apply 289_email_suppressions.sql by hand on WebYar before the merge, per the CLAUDE.md steps (dry run inside BEGIN … ROLLBACK). RESPOK's migrator applies it on push.
   - The code also runs without it: suppression lookups warn and suppress nothing.
   - The in-process PostgREST engine reloads its schema cache on a miss.
2. Production rows read unchanged. smtp_pass is encrypted the first time the row is saved through writeEmailProviderConfig, which needs PLUGIN_SECRETS_MASTER_KEY; it is already set on the backends.
   - The 14 local Coolify dumps keep the plaintext until they age out.
3. To stop SASL and message bodies crossing the coolify network in clear: enable STARTTLS on mail-relay with a certificate for its name, then set encryption=starttls (and tls_servername if the certificate names another host). The code is ready.
4. Optionally set reply_to in the provider config to a mailbox someone reads.
5. Leftover RESEND_API_KEY, SENDGRID_API_KEY or SMTP_* in the backend env no longer override the database. Removing them is still advisable.

### Left to other packages (from its not_fixed)

- platform:F4: Partly fixed. Package A's half is done: the suppression list (migration 289 and suppressions.ts) is checked on every send for every provider, and the relay's queue id is stored as serverMessageId in email_logs metadata. Feeding bounces and complaints into suppressEmailAddress (provider webhooks, the relay's DSN/log watcher) and choosing a readable bounce mailbox belong to package G and the rollout.
- runtimes:F12: Same as platform:F4: the suppression list and serverMessageId are in place. The bounce feed and the relay's documentation (deploy/mail-relay, CLAUDE.md) belong to package G.
- config:M4: Partly fixed. from_email and reply_to must now be one valid address, checked on write, in readiness and on send. Whether the relay accepts the sender's domain is the relay's own policy, which code cannot know without hard-coding domains. A refusal now shows as a permanent 'rejected' (5xx) with its code in email_logs. Resend's verify() checks that the From domain is verified. SMTP verify() cannot test MAIL FROM without sending a message.
- platform:F17: Info only. From composition is unchanged (name plus address, now quoted correctly). A transporter per send is kept at about 30 mails a month, and it is now closed in a finally block. The EHLO name is deliberately left alone: today's relay accepts it, and changing it could trip HELO restrictions. nodemailer's 5-minute DNS cache cannot be turned off, so after a relay is recreated a send to the stale address now fails within 10 s as a transient error that can be retried, instead of hanging.
- runtimes:F3: Partly fixed. The platform SMTP adapter now has timeouts (10/10/30 s plus DNS 10 s) and closes its transport in finally. channels/mail/yahoo/client.ts also creates a transport without timeouts; that file belongs to package F, which can reuse SMTP_TIMEOUTS.
- notifications:N11: Partly fixed. SMTP timeouts are done. The notification ticker's in-flight guard (ticker.ts) belongs to package C. Pooling is deliberately left out at this volume.
- runtimes:F11: Info only, no code change needed: only the backend reaches mail-relay. A future dedicated invitations worker must join the relay's Docker network (note for package G's docs).
- notifications:N16: Info only. The one caveat, operator_product_update's text part being raw HTML, is template content owned by package C. The core now derives a text part only when a template has none.

## Package E — commits 9094c7f8e Email outbox: retries for transactional mail, late link revocation, invitation and billing fixes

### Notes for the other packages

NEW AND CHANGED EXPORTS

server/services/email/outbox.ts (CONTRACT section 5):
- The contract names, unchanged:
  - enqueueEmail(config, request, opts) -> { queued, id?, error? }
  - sendEmailWithRetry(config, request, opts) -> SendResult (queuedRetry: true when a retry was queued)
- Extensions:
  - EnqueueEmailResult gains `duplicate`. A dedupe key that is already queued, or was sent in the last 7 days, returns `{queued: true, duplicate: true, id}`, so a caller that only checks `queued` never sends twice.
  - enqueueEmail errors: invalid_request, invalid_recipient, expired, outbox_unavailable.
  - Options beyond dedupeKey/maxAttempts/notBefore:
    - expiresAt: never sent after this time.
    - supersedeKey: a newer mail with this key cancels older pending ones.
    - afterSent: a closed action, today only `{action: 'revoke_earlier_tokens', table: 'auth_reset_tokens' | 'auth_verify_tokens', userId, issuedAt}`.
  - Also exported: emailRetryDelayMs(attempts), EMAIL_RETRY_WINDOW_MS, drainEmailOutbox(config, {runMaintenance?}), wakeEmailOutbox(), start/stop/shutdownEmailOutboxWorker, getEmailOutboxWorkerStatus, and the types EmailOutboxOptions, EmailAfterSent, EnqueueEmailResult.
- outbox.ts imports only sendEmail from email/index.js (its retry test is inlined), and the database through getServiceClient (server/supabase.js). The many widget tests that mock email/index.js with a sendEmail-only factory keep working.
- Tests that capture mail by mocking sendEmail must now call drainEmailOutbox(config) before asserting on queued mails. The billing pg suites do this.

Other modules:
- server/services/jobs/processShutdown.ts (new): onProcessShutdown(name, drain) and runShutdownDrains(timeoutMs).
  - It is the one SIGTERM/SIGINT handler: drains run together, bounded by SHUTDOWN_TIMEOUT_MS (25 s), then process.exit(0).
  - Every in-process loop that needs a graceful drain should register here, not call process.on('SIGTERM') itself. A listener of its own replaces Node's exit.
  - The invitation worker, the outbox and the HTTP server (server/index.ts) register.
- auth-email.ts:
  - issueVerificationEmail and issueRecoveryEmail return AuthEmailResult `{success, queued?, error?}`.
  - A transient failure that was queued is `success: true, queued: true`.
  - The routes need no change. Package B may show "it may take a few minutes" when queued.
- billing/account/notify.ts:
  - sendBillingEmail options gain `queue` and `dedupeKey`. It returns `{sent, queued?, error?}`.
  - New billingMailKey(slug, workspaceId, ...parts) returns undefined when a part is blank.
  - Test mocks of notify.js need billingMailKey.
- billing/account/index.ts: updateBillingProfile throws AccountBillingError('INVALID_INVOICE_EMAIL', 400, {field}). The i18n key is billing.account.errors.INVALID_INVOICE_EMAIL in en, fa and tr. The route schema is unchanged (B owns it).
- invitations/notificationTemplates.ts: renderInviterFallback(locale).
- New billing/account/receiptResend.ts: planReceiptResend and applyReceiptResend.
- New server/scripts/resendFailedBillingReceipts.ts.
- worker/index.ts: new WORKER_KIND `email-outbox`.
  - Such a container must be on mail-relay's Docker network, with EMAIL_OUTBOX_INPROC=0 set on the backend.
  - By default the outbox runs inside the backend, and no Coolify change is needed.

WHICH MAIL GOES WHERE
- Inline attempt, then a queued retry: reset and verification links. Delivery is limited by the link's expiry.
- Enqueued:
  - receipt (key: ledger id)
  - plan activated, renewed, plan changed, card renewed (key: the ledger row when the result has one; a prepaid period's start has none and stays its own mail)
  - expired (key: plan + expired_at)
  - change scheduled (no key; its notice mark dedupes)
  - AI pack (key: pack ledger id)
  - trial ended (key: trial_end)
- Unchanged: the notices that already retry on their own, so they are not retried twice: renewal reminder, trial ending, card failed/removed, locked-data deletion.
- Invitation e-mail jobs:
  - Transient failures follow the outbox schedule; 8 attempts now span about 10 hours instead of about 1 hour.
  - Unconfigured or permanent failures end the job at once.
  - OTP and SMS keep their short backoff.

WIRING LEFT TO OTHERS
- B:
  - Move notifyOfflineCapture (widget.ts) to enqueueEmail with a per-message, per-recipient dedupeKey.
  - Invitation creation limits (platform:M6's last point) are route-side.
  - account.ts and auth-email routes may read `queued`.
- C: the dispatcher items of notifications:N6. It may reuse emailRetryDelayMs.
- G (docs):
  - The outbox, its schedule and the new worker kind.
  - The rule that SIGTERM drains through processShutdown.ts.
  - The receipt re-send tool.
  - A pending outbox row holds a sealed request for at most 24 hours plus 7 days. Privacy erasure does not touch email_outbox; rows are purged 7 days after a final state.
- Not mine, seen while validating: genericVerificationAdminSettings.pg.test.ts "a real platform Super Admin can read the overview" times out at 5 s on package A's commit too.

ROLLOUT
1. WebYar: apply 289b_email_outbox.sql by hand before the merge, per the CLAUDE.md steps (dry run inside BEGIN ... ROLLBACK, then psql as postgres with lock_timeout 5s). RESPOK's migrator applies it on push.
   - It creates one table, six indexes and one function. It writes no data.
   - The code also runs without it: enqueueing fails, billing mails are then sent inline as before, and sendEmailWithRetry simply does not queue. The order is safe either way.
2. PLUGIN_SECRETS_MASTER_KEY (already set on both backends) seals queued payloads. Never change it: a queued row sealed under another key fails as payload_unreadable.
3. After the merge, on RESPOK, inside the backend container:
   - Dry run first: `npx tsx scripts/resendFailedBillingReceipts.ts --since=2026-10-09 --until=2026-10-16`.
   - Then the same command with --apply, after the owner's go. It goes to the workspace's billing recipient today.
4. Update the CLAUDE.md migration ledger once 289b is applied.

SUMMARY OF FILES
- /home/user/kindred-core-build/server/services/email/outbox.ts
- /home/user/kindred-core-build/database/migrations/289b_email_outbox.sql
- /home/user/kindred-core-build/server/services/jobs/processShutdown.ts
- /home/user/kindred-core-build/server/services/auth-email.ts
- /home/user/kindred-core-build/server/services/invitations/worker.ts
- /home/user/kindred-core-build/server/services/billing/account/notify.ts
- /home/user/kindred-core-build/server/services/billing/account/receiptResend.ts
- /home/user/kindred-core-build/server/scripts/resendFailedBillingReceipts.ts

### Left to other packages (from its not_fixed)

- platform:F3 (offline notice): Package B owns the offline-message notice (notifyOfflineCapture in server/routes/widget.ts), so it still makes one attempt. Every other mail kind in F3 is fixed: reset and verification (auth-email.ts, which also covers signup in auth.ts:441), the receipt, the plan mails, the AI pack mail and billing_trial_ended. B should call enqueueEmail(config, request, { dedupeKey: `offline_message:<message id>:<recipient user id>` }).
- notifications:N6: Partly fixed. Package E's parts are done: billing_trial_ended and the plan and receipt mails are queued with retries, and billing_change_scheduled gives its mark back when its mail neither went nor was queued. The dispatcher's parts belong to package C: 'sending' rows never reclaimed, a short retry budget, quiet-hours deferrals using up an attempt, and a thrown error failing the job at once. The offline notice belongs to package B.
- notifications:N17: Info only (what was lost during RESPOK's outage). For receipts, the new operator tool rebuilds and re-sends them. Lost plan, trial and pack mails described the account as it was then, so re-sending them is the owner's call. Failed notification jobs are package C's (dispatcher.ts). Failed invitations are re-sent from the members page.
- runtimes:F5 (non-receipt mails): Receipts are rebuilt exactly from the ledger and payments and re-sent once (server/scripts/resendFailedBillingReceipts.ts, dry run first). The other billing mails in the window are only counted in the dry run, not re-sent: billing_plan_activated, renewed, expired, trial and pack. Each told the customer the plan state of that day, which has changed since, so sending them now would be misleading. Invitations: the owner uses the resend action. Notification jobs: package C's queue. The production row counts were not checked; that needs a read of RESPOK's email_logs.
