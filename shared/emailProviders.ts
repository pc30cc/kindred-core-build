/**
 * The platform's email providers, as data every side reads.
 *
 * Email is provider-driven (owner, 2026-10-29): the platform sends through
 * whichever provider the Super Admin picks (our own SMTP relay today, Resend,
 * SendGrid, or one added later), and switching is a setting, never a code
 * change. So what a provider needs is stated once, here: the adapters the
 * server has (server/services/email/providers/index.ts holds one for each
 * name below), the fields each reads, which of them are secrets (stored
 * encrypted, never sent back to a browser), and which a send cannot go
 * without. The Super Admin form, the config store, readiness and the send
 * path all read these lists, so they cannot disagree about what
 * "configured" means.
 *
 * Adding a provider is one adapter file, one name in the registry and its
 * lines here; nothing else in the platform names a provider.
 */

export const EMAIL_PROVIDER_ADAPTERS = ['resend', 'sendgrid', 'smtp'] as const;
export type EmailProviderAdapter = typeof EMAIL_PROVIDER_ADAPTERS[number];

export function isEmailProviderAdapter(name: unknown): name is EmailProviderAdapter {
  return typeof name === 'string' && (EMAIL_PROVIDER_ADAPTERS as readonly string[]).includes(name);
}

/** Fields every provider reads: who the mail is from, and where replies go. */
export const EMAIL_PROVIDER_COMMON_FIELDS = ['from_email', 'from_name', 'reply_to'] as const;

/** The fields of each provider's own, beside the common ones. */
export const EMAIL_PROVIDER_FIELDS: Record<EmailProviderAdapter, readonly string[]> = {
  resend: ['api_key', 'webhook_secret'],
  sendgrid: ['api_key', 'webhook_public_key'],
  smtp: ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'encryption', 'tls_servername', 'tls_ca', 'events_token'],
};

/**
 * Fields longer than the usual limit (2048 characters): a CA certificate in
 * PEM is about 1.2 to 2 KB, and a chain of them more.
 */
export const EMAIL_PROVIDER_FIELD_MAX_LENGTH: Readonly<Record<string, number>> = {
  tls_ca: 32 * 1024,
};

/** The SMTP port when none is set. */
export const SMTP_DEFAULT_PORT = 587;

/**
 * Credentials. They are stored encrypted, read back only by the server, and a
 * blank one in a save keeps what is stored. A SendGrid webhook public key is
 * public by definition, so it is an ordinary field.
 */
export const EMAIL_PROVIDER_SECRET_FIELDS: Record<EmailProviderAdapter, readonly string[]> = {
  resend: ['api_key', 'webhook_secret'],
  sendgrid: ['api_key'],
  smtp: ['smtp_pass', 'events_token'],
};

/** What a send cannot go without, beside `from_email`, which every provider needs. */
export const EMAIL_PROVIDER_REQUIRED_FIELDS: Record<EmailProviderAdapter, readonly string[]> = {
  resend: ['api_key'],
  sendgrid: ['api_key'],
  smtp: ['smtp_host'],
};

/**
 * The environment variables that may stand in for a field. The database
 * wins: a variable only fills a field the Super Admin left blank, for every
 * provider alike. (Resend's and SendGrid's keys used to win over the
 * database, so a leftover key in a backend's environment would have
 * silently overridden the one typed in the Super Admin.)
 */
export const EMAIL_PROVIDER_ENV_FALLBACKS: Record<EmailProviderAdapter, Readonly<Record<string, string>>> = {
  resend: { api_key: 'RESEND_API_KEY' },
  sendgrid: { api_key: 'SENDGRID_API_KEY' },
  smtp: { smtp_host: 'SMTP_HOST', smtp_port: 'SMTP_PORT', smtp_user: 'SMTP_USER', smtp_pass: 'SMTP_PASS' },
};

/**
 * The fields that say where a secret is sent, for a secret whose
 * destination is part of the config (an SMTP password goes to the host the
 * config names, as that user; Resend's and SendGrid's keys only ever go to
 * their own API). Such a secret belongs to that destination:
 *
 *   - a save that changes one of these fields does not keep the stored
 *     secret: it must be typed again (a save that still signs in is refused
 *     without it), so a stored relay password can never be handed to a host
 *     a later save names, by the Test button or by the next mail;
 *   - its environment variable fills it only when the config sends it
 *     where the environment would: the first field (the host) must be its
 *     variable's value, and each other field too when its variable is set.
 */
export const EMAIL_PROVIDER_SECRET_DESTINATION: Record<EmailProviderAdapter, Readonly<Record<string, readonly string[]>>> = {
  resend: {},
  sendgrid: {},
  smtp: { smtp_pass: ['smtp_host', 'smtp_port', 'smtp_user'] },
};

/** One destination field, comparable: a host's case does not matter, and a blank port is the default one. */
function destinationValue(field: string, cfg: Record<string, unknown>): string {
  const value = text(cfg[field]);
  if (field === 'smtp_host') return value.toLowerCase();
  if (field === 'smtp_port') return value || String(SMTP_DEFAULT_PORT);
  return value;
}

/** Where `secret` would be sent under `cfg`, as one comparable string (empty for a secret with no destination fields). */
export function emailProviderSecretDestination(name: string, secret: string, cfg: Record<string, unknown>): string {
  if (!isEmailProviderAdapter(name)) return '';
  return (EMAIL_PROVIDER_SECRET_DESTINATION[name][secret] ?? []).map((field) => destinationValue(field, cfg)).join('\n');
}

/**
 * How an SMTP connection is protected:
 *   auto      today's behaviour: implicit TLS on port 465, otherwise STARTTLS
 *             when the server offers it and plain text when it does not;
 *   none      never TLS, even when offered;
 *   starttls  STARTTLS required: a server that does not offer it is refused;
 *   ssl       implicit TLS from the first byte.
 */
export const SMTP_ENCRYPTION_MODES = ['auto', 'none', 'starttls', 'ssl'] as const;
export type SmtpEncryptionMode = typeof SMTP_ENCRYPTION_MODES[number];

function isSmtpEncryptionMode(value: unknown): value is SmtpEncryptionMode {
  return typeof value === 'string' && (SMTP_ENCRYPTION_MODES as readonly string[]).includes(value);
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** The old form's "Use TLS" switch stored a string ('true') or a boolean. */
function legacySwitchOn(value: unknown): boolean {
  return value === true || (typeof value === 'string' && ['true', '1', 'on', 'yes'].includes(value.trim().toLowerCase()));
}

/**
 * The SMTP protection a stored config asks for. `encryption` decides when it
 * is one of the modes. The old form's `smtp_secure` switch, which no code
 * ever read, reads as STARTTLS required (what the switch said it did), or as
 * implicit TLS on port 465, where STARTTLS cannot happen. With neither, the
 * mode is `auto`, and `auto` on port 465 is implicit TLS, as it always was.
 */
export function smtpEncryptionMode(cfg: Record<string, unknown>): SmtpEncryptionMode {
  const port = Number.parseInt(text(cfg.smtp_port), 10);
  const stored = text(cfg.encryption).toLowerCase();
  const mode: SmtpEncryptionMode = isSmtpEncryptionMode(stored)
    ? stored
    : legacySwitchOn(cfg.smtp_secure) ? 'starttls' : 'auto';
  if (port === 465 && (mode === 'auto' || mode === 'starttls')) return 'ssl';
  return mode;
}

/**
 * A stored config in today's field names. Older rows and forms used
 * `smtp_username` / `smtp_password` (read by the old adapter) and the
 * `smtp_secure` switch; each folds into its current name when that one is
 * blank, and the old key goes. Nothing else changes, so a row written today
 * reads exactly as it did.
 */
export function canonicalEmailProviderConfig(name: string, cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cfg };
  if (name === 'smtp') {
    for (const [legacy, current] of [['smtp_username', 'smtp_user'], ['smtp_password', 'smtp_pass']] as const) {
      if (legacy in out) {
        if (!text(out[current]) && text(out[legacy])) out[current] = out[legacy];
        delete out[legacy];
      }
    }
    if ('smtp_secure' in out) {
      if (!text(out.encryption) && legacySwitchOn(out.smtp_secure)) {
        out.encryption = Number.parseInt(text(out.smtp_port), 10) === 465 ? 'ssl' : 'starttls';
      }
      delete out.smtp_secure;
    }
  }
  return out;
}

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]*?)-----END CERTIFICATE-----/g;

/**
 * The certificates of an SMTP config's `tls_ca` (the CA the server's
 * certificate is checked against, for a relay with a private CA), each as
 * PEM wants it, 64 characters a line; null when the text is blank or holds
 * anything but certificates. A PEM pasted into a one-line input arrives with
 * its line breaks gone, and this puts them back. Anything else is refused
 * rather than stored, since this field is not a secret: a private key pasted
 * here by mistake must not be kept in clear.
 */
export function pemCertificates(value: unknown): string[] | null {
  const s = text(value);
  const certificates: string[] = [];
  let last = 0;
  for (const m of s.matchAll(PEM_CERTIFICATE)) {
    if (s.slice(last, m.index).trim()) return null;
    const body = m[1].replace(/\s+/g, '');
    if (!body || body.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
    certificates.push(`-----BEGIN CERTIFICATE-----\n${(body.match(/.{1,64}/g) as string[]).join('\n')}\n-----END CERTIFICATE-----\n`);
    last = (m.index as number) + m[0].length;
  }
  return certificates.length && !s.slice(last).trim() ? certificates : null;
}

/** Characters a local part may hold without quoting (RFC 5322 atext, dot-separated). */
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^(?!-)[\p{L}\p{N}-]{1,63}(?<!-)$/u;

/**
 * Exactly one plain address (local@domain, at most 254 characters), or null.
 * No display name, no angle brackets, no comma, semicolon or whitespace, no
 * quoted local part: a `to` is handed to SMTP's RCPT TO, and a string that a
 * mail library would split into several recipients must never get there.
 * Surrounding whitespace is ignored.
 */
export function parseEmailAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const address = value.trim();
  if (!address || address.length > 254) return null;
  const at = address.lastIndexOf('@');
  if (at <= 0 || address.indexOf('@') !== at) return null;
  const local = address.slice(0, at);
  const labels = address.slice(at + 1).split('.');
  if (local.length > 64 || !LOCAL_PART.test(local)) return null;
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) return null;
  if (/^\d+$/.test(labels[labels.length - 1])) return null;
  return address;
}

/**
 * A config value as the send path reads it: the stored one, else its
 * environment variable. A secret with a destination (EMAIL_PROVIDER_SECRET_
 * DESTINATION) takes its variable only when the config sends it where the
 * environment would: SMTP_PASS is the password of SMTP_HOST, never of a
 * host the Super Admin typed.
 */
export function withEmailProviderEnvFallbacks(
  name: string,
  cfg: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cfg };
  if (!isEmailProviderAdapter(name)) return out;
  const fallbacks = Object.entries(EMAIL_PROVIDER_ENV_FALLBACKS[name]);
  const bound = EMAIL_PROVIDER_SECRET_DESTINATION[name];
  const fromEnv = (variable: string) => {
    const value = env[variable];
    return typeof value === 'string' ? value.trim() : '';
  };
  for (const [field, variable] of fallbacks) {
    if (field in bound) continue;
    if (!text(out[field]) && fromEnv(variable)) out[field] = fromEnv(variable);
  }
  const envOf = (field: string) => fromEnv(EMAIL_PROVIDER_ENV_FALLBACKS[name][field] ?? '');
  const envOnly: Record<string, unknown> = Object.fromEntries(fallbacks.map(([field]) => [field, envOf(field)]));
  const sameAsEnv = (field: string) => destinationValue(field, out) === destinationValue(field, envOnly);
  for (const [field, variable] of fallbacks) {
    if (!(field in bound) || text(out[field]) || !fromEnv(variable)) continue;
    const [where, ...rest] = bound[field];
    if (envOf(where) && sameAsEnv(where) && rest.every((other) => !envOf(other) || sameAsEnv(other))) {
      out[field] = fromEnv(variable);
    }
  }
  return out;
}

export interface EmailProviderConfigProblem {
  field: string;
  problem: 'missing' | 'invalid';
}

/**
 * What stops this config from sending, field by field; empty when it can
 * send. `cfg` is the config as the send path reads it (canonical names; pass
 * the environment to let a variable fill a blank). Only presence and shape
 * are checked, never whether a credential is right: that is the provider's
 * test (verify).
 */
export function emailProviderConfigProblems(
  name: string,
  cfg: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>> = {},
): EmailProviderConfigProblem[] {
  if (!isEmailProviderAdapter(name)) return [{ field: 'provider_name', problem: 'invalid' }];
  const value = withEmailProviderEnvFallbacks(name, cfg, env);
  const problems: EmailProviderConfigProblem[] = [];
  const has = (field: string) => text(value[field]) !== '';

  if (!has('from_email')) problems.push({ field: 'from_email', problem: 'missing' });
  else if (!parseEmailAddress(value.from_email)) problems.push({ field: 'from_email', problem: 'invalid' });
  if (has('reply_to') && !parseEmailAddress(value.reply_to)) problems.push({ field: 'reply_to', problem: 'invalid' });
  if (/[\r\n]/.test(text(value.from_name))) problems.push({ field: 'from_name', problem: 'invalid' });

  for (const field of EMAIL_PROVIDER_REQUIRED_FIELDS[name]) {
    if (!has(field)) problems.push({ field, problem: 'missing' });
  }

  if (name === 'smtp') {
    // A host name or an address, never a URL (`smtp://…` holds a slash).
    if (has('smtp_host') && /[\s/]/.test(text(value.smtp_host))) {
      problems.push({ field: 'smtp_host', problem: 'invalid' });
    }
    if (has('smtp_port')) {
      const port = Number(text(value.smtp_port));
      if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push({ field: 'smtp_port', problem: 'invalid' });
    }
    if (has('encryption') && !isSmtpEncryptionMode(text(value.encryption).toLowerCase())) {
      problems.push({ field: 'encryption', problem: 'invalid' });
    }
    if (has('tls_servername') && /[\s/:]/.test(text(value.tls_servername))) {
      problems.push({ field: 'tls_servername', problem: 'invalid' });
    }
    if (has('tls_ca') && !pemCertificates(value.tls_ca)) problems.push({ field: 'tls_ca', problem: 'invalid' });
    // A user name without its password cannot sign in, and the relay
    // refuses mail from a client that has not.
    if (has('smtp_user') && !has('smtp_pass')) problems.push({ field: 'smtp_pass', problem: 'missing' });
  }
  return problems;
}
