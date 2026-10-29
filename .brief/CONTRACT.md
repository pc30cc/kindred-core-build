# Email: shared contract for every package

The owner's rule (2026-10-29): email is **provider-driven**. The platform sends
through whichever provider the Super Admin picks (our own SMTP relay today,
Resend, SendGrid, or a provider added later), and switching is a setting, never
a code change. Every fix below must work the same for every adapter, and nothing
may special-case one provider outside its adapter file.

Package A implements sections 1-4 first. Package E implements section 5 on top of A.
Packages B, C, D, F and G start from a branch that already contains A and E,
and must use these names exactly. A package may extend this contract only in
its own files; if it needs a change to another package's module, it describes
the change in its result (`notes_for_merge`).

## 1. `server/services/email/index.ts` (A)

```ts
export type EmailCategory = 'transactional' | 'notification' | 'marketing';
export type EmailErrorCode =
  | 'unconfigured' | 'invalid_recipient' | 'suppressed' | 'timeout' | 'connection'
  | 'auth' | 'rejected' | 'provider_error' | 'template_missing' | 'edition_unavailable';

// EmailRequest and PlatformEmailRequest keep every existing field and gain:
category?: EmailCategory;                          // default 'transactional'
listUnsubscribe?: { url: string; mailto?: string }; // adds List-Unsubscribe: <url>[, <mailto:...>]
                                                     // and List-Unsubscribe-Post: List-Unsubscribe=One-Click

// SendResult keeps its fields and gains:
errorCode?: EmailErrorCode;
permanent?: boolean;   // true = retrying the same message cannot succeed
queuedRetry?: boolean; // set by section 5's sendEmailWithRetry when a retry was queued

export function isTransientEmailFailure(r: SendResult): boolean; // !r.success && !r.permanent
```

Rules sendEmail and sendPlatformEmail enforce for every provider:
- `to` is exactly one address (no comma, semicolon, angle brackets or whitespace,
  a plain local@domain shape, at most 254 characters). Otherwise
  `{ success: false, errorCode: 'invalid_recipient', permanent: true }`.
- A suppressed recipient (section 2) is not sent:
  `{ success: false, errorCode: 'suppressed', permanent: true }`.
- `email_logs.error_message` holds only `"<errorCode>: <short reason>"`. The raw
  provider text goes to the server console and never to a workspace.
- Every message carries `Auto-Submitted: auto-generated`. Reply-To is the provider
  config's `reply_to` when set. A text part is always present: when the template
  has none, it is derived from the HTML, with link URLs kept.
- From is built from `{ name, address }` and quoted correctly by each adapter.
- Every adapter has timeouts. SMTP: connect 10 s, greeting 10 s, socket 30 s.
  HTTP APIs: 15 s. A timeout is `errorCode: 'timeout'` and transient.

Adapters live behind one registry, `server/services/email/providers/index.ts`.
`sendEmail`, `sendPlatformEmail`, readiness and the config store all dispatch
through it. Each adapter has the shape
`send(config: ProviderConfig, message: OutboundMessage): Promise<SendResult>`,
with an optional `verify(config)`, where:

```ts
interface OutboundMessage {
  from: { name: string; address: string };
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers: Record<string, string>;
}
```

## 2. `server/services/email/suppressions.ts` (A)

```ts
export async function suppressEmailAddress(config: ServerConfig, input: {
  address: string; reason: 'hard_bounce' | 'complaint' | 'manual';
  detail?: string; source: string; expiresAt?: Date | null }): Promise<void>;   // upsert, bumps bounce_count/last_seen_at
export async function unsuppressEmailAddress(config: ServerConfig, address: string): Promise<boolean>;
export async function isEmailSuppressed(config: ServerConfig, address: string): Promise<boolean>; // ignores expired rows
export async function listEmailSuppressions(config: ServerConfig, opts: { search?: string; limit?: number; offset?: number }):
  Promise<{ rows: Array<{ address: string; reason: string; detail: string | null; source: string; bounce_count: number;
                         first_seen_at: string; last_seen_at: string; expires_at: string | null }>; total: number }>;
```

The table is `public.email_suppressions` (address lower-case primary key),
created in `database/migrations/289_email_suppressions.sql`.

## 3. `server/services/email/providerConfigStore.ts` (A)

```ts
export const EMAIL_PROVIDER_KEYS = ['default_email_provider', 'notification_email_provider'] as const;
export type EmailProviderKey = typeof EMAIL_PROVIDER_KEYS[number];
export async function readEmailProviderConfig(config: ServerConfig, key: EmailProviderKey): Promise<ProviderConfig | null>;
  // decrypts, merges config + secrets; also reads today's legacy rows (secrets in plain text under "config")
export async function readEmailProviderForAdmin(config: ServerConfig, key: EmailProviderKey):
  Promise<{ provider_name: string | null; config: Record<string, unknown>; secretKeysSet: string[] }>;
  // never returns a secret value
export async function writeEmailProviderConfig(config: ServerConfig, key: EmailProviderKey,
  input: { provider_name: string; config: Record<string, unknown> }, actor: { userId: string }):
  Promise<{ ok: true } | { ok: false; error: string; field?: string }>;
  // validates against the registry and the required fields; a secret field that is blank or absent keeps the stored value;
  // encrypts secrets with server/lib/pluginCrypto.ts (PLUGIN_SECRETS_MASTER_KEY) and refuses to store a new secret when the key is missing;
  // provider_name 'disabled' clears the row; writes an audit row (who, when, provider, which fields changed, never values)
export async function verifyEmailProvider(config: ServerConfig, key: EmailProviderKey): Promise<{ ok: boolean; detail: string }>;
  // connects and authenticates without sending (SMTP: transporter.verify(); Resend and SendGrid: an authenticated read)
```

## 4. `shared/emailProviders.ts` (A)

```ts
export const EMAIL_PROVIDER_ADAPTERS = ['resend', 'sendgrid', 'smtp'] as const;
export type EmailProviderAdapter = typeof EMAIL_PROVIDER_ADAPTERS[number];
export const EMAIL_PROVIDER_SECRET_FIELDS: Record<EmailProviderAdapter, readonly string[]> =
  { resend: ['api_key', 'webhook_secret'], sendgrid: ['api_key'], smtp: ['smtp_pass', 'events_token'] };
export const SMTP_ENCRYPTION_MODES = ['auto', 'none', 'starttls', 'ssl'] as const;
  // auto = today's behaviour (STARTTLS when offered); a legacy smtp_secure: true reads as 'starttls'; port 465 with auto reads as 'ssl'
```

Config fields:
- **Common:** `from_email` (required), `from_name`, `reply_to`.
- **smtp:** `smtp_host`, `smtp_port`, `smtp_user`, `smtp_pass`, `encryption`, `tls_servername`, `events_token`.
- **resend:** `api_key`, `webhook_secret`.
- **sendgrid:** `api_key`, `webhook_public_key` (not a secret).

Database config wins. An environment variable (`SMTP_*`, `RESEND_API_KEY`, `SENDGRID_API_KEY`) only fills a blank.

## 5. `server/services/email/outbox.ts` (E)

```ts
export async function enqueueEmail(config: ServerConfig, request: EmailRequest,
  opts?: { dedupeKey?: string; maxAttempts?: number; notBefore?: Date }): Promise<{ queued: boolean; id?: string; error?: string }>;
export async function sendEmailWithRetry(config: ServerConfig, request: EmailRequest,
  opts?: { dedupeKey?: string }): Promise<SendResult>;
  // one inline attempt; on a transient failure queues a retry and returns that result with queuedRetry: true
```

The outbox worker runs inside the backend under a lease, like the invitation outbox.
- It retries transient failures with backoff (1, 5, 15 and 60 minutes, then every 3 hours, up to 24 hours).
- Each attempt goes through sendEmail, so each attempt is logged.
- Permanent failures are never retried.

The table is `public.email_outbox`, created in `database/migrations/289b_email_outbox.sql`.
The payload never keeps a secret longer than the mail needs: rows are purged 7 days after a final state.

## Migrations

Each package that needs one uses its own reserved file:

| Package | File |
|---|---|
| A | `289_email_suppressions.sql` |
| E | `289b_email_outbox.sql` |
| C | `289c_*.sql` |
| B | `289d_*.sql` |
| D | `289e_*.sql` |
| F | `289f_*.sql` |

Rules:
- Every statement is idempotent.
- RLS is on, and access is service_role only, as in recent migrations.
- No data is destroyed.
- The header comment says what the file does and how it is rolled out. WebYar is applied by hand before the merge; RESPOK by its migrator on push.
- The CI rules in `src/test/ci/migration*.test.ts` and `definerExecuteAllowList` / `aclFunctionManifest` must pass.
