// ============================================
// EMAIL EVENTS: bounces and complaints, fed back into the suppression list
// ============================================
//
// A provider that accepts a mail has not delivered it: the recipient's
// server can still refuse it (an unknown mailbox, a full one, a policy), and
// a recipient can still mark it as spam. Each provider reports that on its
// own channel, and every report ends in the same place, the suppression list
// (server/services/email/suppressions.ts), which sendEmail checks before any
// provider is called:
//
//   POST /api/email-events/resend    Resend's webhook, signed by Svix with
//                                    resend.webhook_secret
//   POST /api/email-events/sendgrid  SendGrid's signed Event Webhook (ECDSA,
//                                    sendgrid.webhook_public_key)
//   POST /api/email-events/relay     our own relay's bounce watcher
//                                    (deploy/mail-relay), signed with the smtp
//                                    config's events_token
//
// A route answers only while its provider is the one the platform sends
// through (the default or the notification provider) and has its secret
// set; otherwise it is 404, as if it did not exist. Every report is checked
// against its signature and a timestamp window before anything is read from
// it, so a replayed or forged one changes nothing.
//
// What is suppressed, for every provider alike (record(), isSuppressible):
//   - a hard bounce whose status is 5.1.x (the address does not exist):
//     permanently;
//   - a hard bounce about the mailbox (5.2.x: disabled, full) or the
//     recipient's domain (5.4.4: no mail route to it), or one the provider
//     reports without a status: for 30 days, since those can clear;
//   - a hard bounce about our sending, not the address (5.7.x: the sending
//     IP's reputation, SPF, DKIM, DMARC, a policy; 5.0.0 and 5.3.x to 5.6.x:
//     the receiving system, a route, the protocol, the content): nothing.
//     The console names their statuses, and the relay's watcher alerts
//     Telegram. Suppressing them would keep every reset and receipt from
//     each address a block touched for 30 days, long after its cause (a new
//     IP, one DKIM mistake) is fixed;
//   - a complaint: permanently;
//   - a soft bounce (4.x.x, a deferral): nothing; the provider retries it.
//
// Mounted before express.json(): each signature covers the exact bytes sent.
// Nothing here logs a secret, a signature or a body; the console gets counts
// and reasons.

import express, { Router, type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature, type KeyObject } from 'node:crypto';
import type { ServerConfig } from '../config.js';
import { EMAIL_PROVIDER_KEYS, loadEmailProviderConfig } from '../services/email/providerConfigStore.js';
import { suppressEmailAddress, suppressionKey } from '../services/email/suppressions.js';
import type { ProviderConfig } from '../services/email/providers/types.js';

export const emailEventsRouter = Router();

/** A report older (or further ahead) than this is refused as a replay. */
export const EMAIL_EVENT_TOLERANCE_MS = 5 * 60_000;

/** How long a bounce that is not 5.1.x keeps an address off the list. */
export const TEMPORARY_SUPPRESSION_MS = 30 * 24 * 60 * 60_000;

/** One provider's batch holds at most this many events (SendGrid batches). */
const MAX_EVENTS = 1000;

/**
 * Far above any provider's real delivery rate from one address (a relay or
 * a provider posts a few reports a day at today's volume); providers retry
 * a 429, so nothing genuine is lost.
 */
const emailEventsRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `email-events:${req.ip ? ipKeyGenerator(req.ip) : 'unknown'}`,
  handler: (_req, res) => {
    res.status(429).json({ error: 'rate_limited' });
  },
});

/** One report, as every provider's is read: who, and what happened. */
export interface EmailEvent {
  address: string;
  kind: 'hard_bounce' | 'complaint';
  /** The enhanced status code (5.1.1), when the report gives one. */
  status?: string;
  /** A short, provider-neutral reason for the Super Admin's list. */
  detail: string;
}

/** The enhanced status code (RFC 3463) in a text, if any: 5.1.1, 4.2.2, … */
export function enhancedStatus(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  return /\b([245]\.\d{1,3}\.\d{1,3})\b/.exec(text)?.[1];
}

/**
 * Whether an event puts its address on the list at all. A complaint does, and
 * so does a hard bounce about the address: 5.1.x the address itself, 5.2.x
 * its mailbox, 5.4.4 a domain with no mail route, or no status at all (the
 * provider's own word that the address bounced: Resend's Permanent,
 * SendGrid's bounce or dropped "Bounced Address"). Any other status is the
 * receiving server refusing our sending, which says nothing about the
 * address; SendGrid's `blocked` and Resend's Transient, the same thing in
 * those providers' words, are skipped by their parsers already.
 */
export function isSuppressible(event: EmailEvent): boolean {
  if (event.kind === 'complaint' || !event.status) return true;
  return /^5\.[12]\./.test(event.status) || event.status === '5.4.4';
}

/**
 * How long an event keeps its address suppressed: null for good, or the
 * moment it ends.
 */
export function suppressionExpiry(event: EmailEvent, now = Date.now()): Date | null {
  if (event.kind === 'complaint') return null;
  if (event.status && /^5\.1\./.test(event.status)) return null;
  return new Date(now + TEMPORARY_SUPPRESSION_MS);
}

// ─── Replays ───────────────────────────────────────────────────────

/**
 * Reports already taken within the tolerance window, so one delivered twice
 * (a provider's retry after a lost answer, or a replay) counts once. A
 * replay older than the window is refused by its timestamp anyway, so the
 * memory only has to cover the window, and it is bounded.
 */
const seenReports = new Map<string, number>();
const MAX_SEEN = 5000;

function alreadySeen(id: string, now = Date.now()): boolean {
  const expiry = seenReports.get(id);
  return expiry !== undefined && expiry > now;
}

/**
 * Marked only once the report is recorded: one that failed is delivered
 * again by its provider and must not then be taken for a duplicate.
 */
function markSeen(id: string, now = Date.now()): void {
  for (const [key, expiry] of seenReports) {
    if (expiry > now && seenReports.size < MAX_SEEN) break;
    seenReports.delete(key);
  }
  seenReports.set(id, now + 2 * EMAIL_EVENT_TOLERANCE_MS);
}

/** For tests. */
export function resetEmailEventReplayCache(): void {
  seenReports.clear();
}

/** A timestamp in seconds (or milliseconds) within the tolerance window. */
function withinWindow(raw: unknown, now = Date.now()): boolean {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return false;
  const ms = n > 1e12 ? n : n * 1000;
  return Math.abs(now - ms) <= EMAIL_EVENT_TOLERANCE_MS;
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function header(req: Request, name: string): string {
  const value = req.headers[name];
  return typeof value === 'string' ? value.trim() : '';
}

// ─── Which configuration a route answers for ──────────────────────

/**
 * The configurations, among the default and the notification provider, of
 * this provider that carry `field`. Two of them when both rows name the
 * same provider with different secrets; a report signed by either is taken.
 * A row that cannot be read counts as absent: the provider retries a 404.
 */
async function configsWith(config: ServerConfig, provider: string, field: string): Promise<ProviderConfig[]> {
  const out: ProviderConfig[] = [];
  for (const key of EMAIL_PROVIDER_KEYS) {
    const loaded = await loadEmailProviderConfig(config, key);
    if (loaded.status === 'error') {
      console.warn(`[email-events] ${key} lookup failed:`, loaded.message);
      continue;
    }
    if (loaded.status !== 'ok' || loaded.provider.provider_name !== provider) continue;
    const value = loaded.provider.config[field];
    if (typeof value === 'string' && value.trim()) out.push(loaded.provider);
  }
  return out;
}

function stringField(cfg: ProviderConfig, field: string): string {
  const value = cfg.config[field];
  return typeof value === 'string' ? value.trim() : '';
}

// ─── Recording ─────────────────────────────────────────────────────

/**
 * Writes each event to the suppression list. A database failure answers
 * 500, so the provider delivers the report again; an address that is not
 * one plain address is skipped (nothing could ever be sent to it anyway),
 * and so is a refusal of our sending (isSuppressible), whose statuses the
 * console counts.
 */
async function record(
  config: ServerConfig,
  res: Response,
  source: string,
  reportId: string,
  events: EmailEvent[],
): Promise<void> {
  let recorded = 0;
  const refusals = new Map<string, number>();
  for (const event of events) {
    if (!suppressionKey(event.address)) continue;
    if (!isSuppressible(event)) {
      const status = event.status ?? 'unknown';
      refusals.set(status, (refusals.get(status) ?? 0) + 1);
      continue;
    }
    try {
      await suppressEmailAddress(config, {
        address: event.address,
        reason: event.kind,
        detail: event.detail,
        source,
        expiresAt: suppressionExpiry(event),
      });
      recorded += 1;
    } catch (err) {
      console.error(`[email-events] ${source}: recording failed:`, err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: 'record_failed' });
      return;
    }
  }
  markSeen(reportId);
  if (recorded > 0) console.info(`[email-events] ${source}: ${recorded} suppression event(s) recorded`);
  if (refusals.size > 0) {
    const statuses = [...refusals].map(([status, n]) => `${status} ×${n}`).join(', ');
    console.warn(
      `[email-events] ${source}: refusals of our sending, not of the address, left off the suppression list (${statuses}): `
      + 'check the sender\'s reputation, SPF, DKIM and DMARC',
    );
  }
  res.json({ ok: true, recorded });
}

function getConfig(req: Request): ServerConfig {
  return (req as unknown as { serverConfig: ServerConfig }).serverConfig;
}

function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, max = 120): string {
  return typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ').trim().slice(0, max) : '';
}

const rawBody = express.raw({ type: '*/*', limit: '2mb' });

// ─── Resend (Svix) ────────────────────────────────────────────────

/**
 * Svix's scheme: HMAC-SHA256 over `<id>.<timestamp>.<body>` with the
 * secret's bytes (the base64 after `whsec_`); the header lists one or more
 * `v1,<base64>` signatures, any of which may match (a secret being rotated).
 */
export function verifySvixSignature(
  secret: string,
  headers: { id: string; timestamp: string; signature: string },
  body: Buffer,
  now = Date.now(),
): boolean {
  if (!headers.id || !headers.signature || !withinWindow(headers.timestamp, now)) return false;
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');
  if (key.length === 0) return false;
  const expected = createHmac('sha256', key)
    .update(`${headers.id}.${headers.timestamp}.`)
    .update(body)
    .digest();
  return headers.signature.split(/\s+/).some((entry) => {
    const [version, sig] = entry.split(',', 2);
    return version === 'v1' && !!sig && safeEqual(Buffer.from(sig, 'base64'), expected);
  });
}

/**
 * The events in a Resend report. `email.bounced` carries SES's bounce:
 * type Permanent is a hard bounce (Transient and Undetermined are not), and
 * a subType of NoEmail means the mailbox does not exist, the 5.1.1 of a
 * report that names no code.
 */
export function resendEvents(payload: unknown): EmailEvent[] {
  const body = asRecord(payload);
  const data = asRecord(body.data);
  const recipients = (Array.isArray(data.to) ? data.to : [data.to]).filter((to): to is string => typeof to === 'string');
  if (body.type === 'email.complained') {
    return recipients.map((address) => ({ address, kind: 'complaint', detail: 'resend: complaint' }));
  }
  if (body.type !== 'email.bounced') return [];
  const bounce = asRecord(data.bounce);
  if (text(bounce.type).toLowerCase() !== 'permanent') return [];
  const subType = text(bounce.subType, 40);
  const status = enhancedStatus(bounce.message) ?? (subType.toLowerCase() === 'noemail' ? '5.1.1' : undefined);
  const detail = ['resend:', status, subType].filter(Boolean).join(' ');
  return recipients.map((address) => ({ address, kind: 'hard_bounce', status, detail }));
}

emailEventsRouter.post('/resend', emailEventsRateLimiter, rawBody, async (req, res) => {
  const config = getConfig(req);
  const configs = await configsWith(config, 'resend', 'webhook_secret');
  if (configs.length === 0) return res.status(404).json({ error: 'not_found' });

  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const headers = {
    id: header(req, 'svix-id'),
    timestamp: header(req, 'svix-timestamp'),
    signature: header(req, 'svix-signature'),
  };
  if (!configs.some((cfg) => verifySvixSignature(stringField(cfg, 'webhook_secret'), headers, body))) {
    console.warn('[email-events] resend: report refused (signature or timestamp)');
    return res.status(401).json({ error: 'invalid_signature' });
  }
  const reportId = `resend:${headers.id}`;
  if (alreadySeen(reportId)) return res.json({ ok: true, duplicate: true });

  const payload = parseJson(body);
  if (payload === undefined) return res.status(400).json({ error: 'invalid_body' });
  return record(config, res, 'resend_webhook', reportId, resendEvents(payload));
});

// ─── SendGrid (signed Event Webhook) ──────────────────────────────

/**
 * The public key SendGrid shows for a signed Event Webhook: base64 DER
 * (SubjectPublicKeyInfo, P-256). A PEM is taken as well.
 */
function sendgridKey(value: string): KeyObject | null {
  try {
    if (value.includes('BEGIN PUBLIC KEY')) return createPublicKey(value);
    return createPublicKey({ key: Buffer.from(value.replace(/\s+/g, ''), 'base64'), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/** ECDSA-SHA256 (DER signature, base64) over `<timestamp><body>`. */
export function verifySendgridSignature(
  publicKey: string,
  headers: { signature: string; timestamp: string },
  body: Buffer,
  now = Date.now(),
): boolean {
  if (!headers.signature || !withinWindow(headers.timestamp, now)) return false;
  const key = sendgridKey(publicKey);
  if (!key) return false;
  try {
    return verifySignature(
      'sha256',
      Buffer.concat([Buffer.from(headers.timestamp, 'utf8'), body]),
      key,
      Buffer.from(headers.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * The events in a SendGrid batch:
 *   - `bounce` of type `bounce` is a hard bounce; type `blocked` is a
 *     temporary refusal, a soft one;
 *   - `dropped` is SendGrid refusing to send because of its own list: an
 *     invalid address is a 5.1.x, a bounced one a hard bounce, a spam
 *     reporter a complaint; other reasons (an unsubscribe in SendGrid's own
 *     groups, a size limit) are not about the address's deliverability;
 *   - `spamreport` is a complaint.
 */
export function sendgridEvents(payload: unknown): EmailEvent[] {
  if (!Array.isArray(payload)) return [];
  const out: EmailEvent[] = [];
  for (const item of payload.slice(0, MAX_EVENTS)) {
    const ev = asRecord(item);
    const address = typeof ev.email === 'string' ? ev.email : '';
    if (!address) continue;
    if (ev.event === 'spamreport') {
      out.push({ address, kind: 'complaint', detail: 'sendgrid: spam report' });
    } else if (ev.event === 'bounce') {
      if (ev.type !== undefined && ev.type !== 'bounce') continue;
      const status = enhancedStatus(ev.status) ?? enhancedStatus(ev.reason);
      if (status && !status.startsWith('5.')) continue;
      out.push({ address, kind: 'hard_bounce', status, detail: ['sendgrid: bounce', status].filter(Boolean).join(' ') });
    } else if (ev.event === 'dropped') {
      const reason = text(ev.reason, 60).toLowerCase();
      if (reason.includes('spam')) {
        out.push({ address, kind: 'complaint', detail: 'sendgrid: dropped, spam reporting address' });
      } else if (reason.includes('invalid')) {
        out.push({ address, kind: 'hard_bounce', status: '5.1.3', detail: 'sendgrid: dropped, invalid address' });
      } else if (reason.includes('bounced')) {
        out.push({ address, kind: 'hard_bounce', detail: 'sendgrid: dropped, bounced address' });
      }
    }
  }
  return out;
}

emailEventsRouter.post('/sendgrid', emailEventsRateLimiter, rawBody, async (req, res) => {
  const config = getConfig(req);
  const configs = await configsWith(config, 'sendgrid', 'webhook_public_key');
  if (configs.length === 0) return res.status(404).json({ error: 'not_found' });

  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const headers = {
    signature: header(req, 'x-twilio-email-event-webhook-signature'),
    timestamp: header(req, 'x-twilio-email-event-webhook-timestamp'),
  };
  if (!configs.some((cfg) => verifySendgridSignature(stringField(cfg, 'webhook_public_key'), headers, body))) {
    console.warn('[email-events] sendgrid: report refused (signature or timestamp)');
    return res.status(401).json({ error: 'invalid_signature' });
  }
  const reportId = `sendgrid:${headers.signature}`;
  if (alreadySeen(reportId)) return res.json({ ok: true, duplicate: true });

  const payload = parseJson(body);
  if (payload === undefined) return res.status(400).json({ error: 'invalid_body' });
  return record(config, res, 'sendgrid_webhook', reportId, sendgridEvents(payload));
});

// ─── Our relay (deploy/mail-relay, bounce-watcher) ────────────────

/**
 * HMAC-SHA256, hex, over `<timestamp>.<body>` with the smtp config's
 * events_token, sent as `X-Relay-Signature: v1=<hex>` beside
 * `X-Relay-Timestamp` (seconds). The token itself never crosses the wire,
 * and the timestamp it covers makes a captured report useless after the
 * window. The comparison is constant-time.
 */
export function signRelayReport(token: string, timestamp: string, body: Buffer | string): string {
  return `v1=${createHmac('sha256', token).update(`${timestamp}.`).update(body).digest('hex')}`;
}

export function verifyRelaySignature(
  token: string,
  headers: { signature: string; timestamp: string },
  body: Buffer,
  now = Date.now(),
): boolean {
  if (!token || !headers.signature || !withinWindow(headers.timestamp, now)) return false;
  const expected = Buffer.from(signRelayReport(token, headers.timestamp, body));
  return safeEqual(Buffer.from(headers.signature), expected);
}

/**
 * The watcher's report: `{ events: [{ type: 'bounce', recipient, status,
 * detail?, queue_id? }] }`. Postfix's `status=bounced` is a permanent
 * failure, so its dsn is 5.x.x; a 4.x.x is a deferral, and is skipped here
 * too, whatever the watcher sends. Which of the rest suppress is record()'s
 * rule, the same as for every provider: the watcher leaves out the
 * refusals of our sending itself, and a watcher of an older version that
 * sends them changes nothing.
 */
export function relayEvents(payload: unknown): EmailEvent[] {
  const events = asRecord(payload).events;
  if (!Array.isArray(events)) return [];
  const out: EmailEvent[] = [];
  for (const item of events.slice(0, MAX_EVENTS)) {
    const ev = asRecord(item);
    if (ev.type !== 'bounce' || typeof ev.recipient !== 'string') continue;
    const status = enhancedStatus(ev.status);
    if (!status || !status.startsWith('5.')) continue;
    const reason = text(ev.detail, 200);
    out.push({
      address: ev.recipient,
      kind: 'hard_bounce',
      status,
      detail: `relay: ${status}${reason ? ` ${reason}` : ''}`,
    });
  }
  return out;
}

emailEventsRouter.post('/relay', emailEventsRateLimiter, rawBody, async (req, res) => {
  const config = getConfig(req);
  const configs = await configsWith(config, 'smtp', 'events_token');
  if (configs.length === 0) return res.status(404).json({ error: 'not_found' });

  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const headers = {
    signature: header(req, 'x-relay-signature'),
    timestamp: header(req, 'x-relay-timestamp'),
  };
  if (!configs.some((cfg) => verifyRelaySignature(stringField(cfg, 'events_token'), headers, body))) {
    console.warn('[email-events] relay: report refused (signature or timestamp)');
    return res.status(401).json({ error: 'invalid_signature' });
  }
  const reportId = `relay:${headers.signature}`;
  if (alreadySeen(reportId)) return res.json({ ok: true, duplicate: true });

  const payload = parseJson(body);
  if (payload === undefined) return res.status(400).json({ error: 'invalid_body' });
  return record(config, res, 'relay', reportId, relayEvents(payload));
});
