// ============================================
// EMAIL OUTBOX: transactional mail a relay hiccup must not lose
// ============================================
//
// sendEmail makes one attempt. That is right for a mail somebody is looking
// at the screen for, and wrong as the only attempt: a relay restarted by a
// redeploy, a provider's brief outage or a timeout used to lose a payment
// receipt, a plan mail or a reset link for good, while the user was told it
// had been sent. This is the second chance, the same for every provider:
//
//   - sendEmailWithRetry: one attempt now; if it failed in a way that can
//     pass, the same mail is queued for another. For a mail the user is
//     waiting for (a reset link, a verification link).
//   - enqueueEmail: the mail is queued and sent from here, in the
//     background. For a mail nobody is waiting for (a receipt, a plan mail),
//     so a slow provider never holds up the request that caused it.
//
// The worker runs inside the backend, the one process that reaches the
// relay, under a lease per row like the invitation outbox: each attempt goes
// through sendEmail (so each attempt is logged in email_logs, and every rule
// of the send — one plain address, the suppression list, the provider's own
// timeouts — holds for it), a failure that can pass is tried again after 1,
// 5, 15 and 60 minutes and then every 3 hours, for up to 24 hours, and a
// failure that cannot (a refused address, a suppressed one, a missing
// setting, a refused sign-in) is never tried again. Delivery is at least
// once: a worker that dies between the provider's acceptance and its own
// record lets the lease run out, and the row is sent again.
//
// A queued mail can carry a credential (a reset link's token), so the stored
// request is sealed with PLUGIN_SECRETS_MASTER_KEY and dropped the moment the
// row is final (the table's own check keeps every final row's payload NULL);
// final rows go entirely after 7 days. The table is public.email_outbox,
// migration 289b.

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import {
  PLUGIN_SECRET_ALGORITHM,
  decryptPluginSecret,
  encryptPluginSecret,
  isPluginCryptoConfigured,
} from '../../lib/pluginCrypto.js';
import { IdleBackoff, IntervalGate } from '../jobs/idleBackoff.js';
import { onProcessShutdown } from '../jobs/processShutdown.js';
import { parseEmailAddress } from '../../../shared/emailProviders.js';
import { sendEmail, type EmailRequest, type SendResult } from './index.js';

/**
 * isTransientEmailFailure's reading (index.ts), kept here so this module
 * needs nothing of the email service but sendEmail: a failure may pass on a
 * retry unless the service marked it permanent.
 */
function retryable(result: SendResult): boolean {
  return !result.success && result.permanent !== true;
}

// ─── The schedule ─────────────────────────────────────────────────────────

/** The wait after each failed attempt, in minutes: the last one repeats. */
const RETRY_DELAYS_MINUTES = [1, 5, 15, 60, 180] as const;

/** How long a mail is tried for, from its first attempt. */
export const EMAIL_RETRY_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The attempts the schedule fits in its window (at 0, 1, 6, 21 and 81
 * minutes, then every 3 hours up to the 1,341st): a cap for the count, so a
 * row can never be tried more often than the schedule says, whatever its
 * clock reads.
 */
const DEFAULT_MAX_ATTEMPTS = 12;

/** Final rows are kept this long (for a look at what happened), then deleted. */
const KEEP_FINAL_MS = 7 * 24 * 60 * 60_000;

/**
 * The wait before the next attempt, after `attempts` attempts have failed (1
 * after the first). Exported for the invitation worker, whose e-mail
 * invitations follow the same schedule.
 */
export function emailRetryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(Math.floor(attempts), 1), RETRY_DELAYS_MINUTES.length) - 1;
  return RETRY_DELAYS_MINUTES[index] * 60_000;
}

// ─── What a caller may ask for ────────────────────────────────────────────

/**
 * What follows the hand-over of a mail to the provider, for a mail whose
 * sending changes something else. A closed list on purpose: a row names one
 * of these, never code or a table of its own choosing.
 *
 * `revoke_earlier_tokens`: the user's earlier unused links of this kind
 * (issued before `issuedAt`) stop working. A new reset or verification link
 * used to revoke the old ones before it was sent, so a failed send left the
 * user with no working link at all; now they are revoked only once the new
 * one has reached the provider, inline or from the queue.
 */
export type EmailAfterSent = {
  action: 'revoke_earlier_tokens';
  table: 'auth_reset_tokens' | 'auth_verify_tokens';
  userId: string;
  /** ISO time the new link was issued; only links issued before it are revoked. */
  issuedAt: string;
};

const REVOCABLE_TOKEN_TABLES = new Set(['auth_reset_tokens', 'auth_verify_tokens']);

export interface EmailOutboxOptions {
  /**
   * One mail per key: a second enqueue with a key already queued (or sent in
   * the last 7 days) queues nothing and reports the first. The key names the
   * THING the mail is about ("billing_payment_receipt:<ledger id>"), so a
   * replayed event cannot mail twice.
   */
  dedupeKey?: string;
  /** Attempts at most (1 to 50; default: what the schedule fits in 24 hours). */
  maxAttempts?: number;
  /** Not before this time (default: now). */
  notBefore?: Date;
  /**
   * Not after this time: a mail whose link expires is worth nothing later.
   * The 24-hour window applies as well, whichever ends first.
   */
  expiresAt?: Date;
  /**
   * A newer mail with this key makes an older one still waiting pointless
   * (a fresh reset link over the one before): queuing or sending the newer
   * one cancels the older.
   */
  supersedeKey?: string;
  /** What follows the hand-over to the provider; see EmailAfterSent. */
  afterSent?: EmailAfterSent;
}

export interface EnqueueEmailResult {
  /** True when the mail is in the queue: queued now, or already (`duplicate`). */
  queued: boolean;
  id?: string;
  /** The dedupe key was already queued; nothing new was. */
  duplicate?: boolean;
  /** Why not: invalid_request, invalid_recipient, expired, outbox_unavailable. */
  error?: string;
}

// ─── Storage ──────────────────────────────────────────────────────────────

function client(config: ServerConfig) {
  return getServiceClient(config);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINAL_STATUSES = ['sent', 'failed', 'expired', 'cancelled'] as const;
type FinalStatus = (typeof FINAL_STATUSES)[number];

interface SealedEnvelope {
  algorithm: string;
  key_version: number;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
}

type StoredPayload = { v: 1; sealed: SealedEnvelope } | { v: 1; plain: EmailRequest };

let warnedUnsealed = false;

/**
 * The request as it is stored: sealed when the backend has its key (it
 * always has in production). Without one (a development install) it is kept
 * as it is, and the console says so once; either way it is dropped when the
 * row is final. The envelope's fingerprint (an unsalted hash of the plain
 * text) is left out, as in the provider config store.
 */
function sealRequest(config: ServerConfig, request: EmailRequest): StoredPayload {
  const key = config.pluginSecretsMasterKey;
  if (isPluginCryptoConfigured(key)) {
    const { algorithm, key_version, nonce, ciphertext, auth_tag } = encryptPluginSecret(JSON.stringify(request), key);
    return { v: 1, sealed: { algorithm, key_version, nonce, ciphertext, auth_tag } };
  }
  if (!warnedUnsealed) {
    warnedUnsealed = true;
    console.warn('[email-outbox] PLUGIN_SECRETS_MASTER_KEY is not set: queued mail is stored unsealed until it is sent');
  }
  return { v: 1, plain: request };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stored request read back, or null when it cannot be (another key, a damaged row). */
function openRequest(config: ServerConfig, stored: unknown): EmailRequest | null {
  if (!isRecord(stored) || stored.v !== 1) return null;
  let request: unknown = stored.plain;
  if (isRecord(stored.sealed)) {
    const sealed = stored.sealed as unknown as SealedEnvelope;
    if (sealed.algorithm !== PLUGIN_SECRET_ALGORITHM) return null;
    try {
      request = JSON.parse(decryptPluginSecret(sealed, config.pluginSecretsMasterKey));
    } catch {
      return null;
    }
  }
  if (!isRecord(request) || typeof request.to !== 'string') return null;
  if (request.workspaceId !== null && typeof request.workspaceId !== 'string') return null;
  return request as unknown as EmailRequest;
}

function parseAfterSent(value: unknown): EmailAfterSent | null {
  if (!isRecord(value) || value.action !== 'revoke_earlier_tokens') return null;
  const { table, userId, issuedAt } = value;
  if (typeof table !== 'string' || !REVOCABLE_TOKEN_TABLES.has(table)) return null;
  if (typeof userId !== 'string' || !UUID.test(userId)) return null;
  // The database's own timestamp of the new link, compared by the database.
  if (typeof issuedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ][\d:.]+(Z|[+-][\d:]+)?$/.test(issuedAt)) return null;
  return { action: 'revoke_earlier_tokens', table: table as EmailAfterSent['table'], userId, issuedAt };
}

function cleanKey(value: string | undefined): string | null {
  const key = typeof value === 'string' ? value.trim() : '';
  return key ? key.slice(0, 200) : null;
}

/** A failed attempt as the row keeps it: our code and our "<errorCode>: <reason>", one short line. */
function failureOf(result: SendResult): { errorCode: string; error: string } {
  const errorCode = result.errorCode ?? 'provider_error';
  const error = result.error ? String(result.error).replace(/[\r\n]+/g, ' ').slice(0, 300) : `${errorCode}: the attempt failed`;
  return { errorCode, error };
}

/**
 * Cancels the mails still waiting under `key` that were queued before
 * `before` (and are not `exceptId`): a newer one carries what they would
 * have. Only `pending` rows: one being sent right now is let finish.
 */
async function cancelSuperseded(config: ServerConfig, key: string, before: string, exceptId?: string): Promise<void> {
  const now = new Date().toISOString();
  let query = client(config)
    .from('email_outbox')
    .update({
      status: 'cancelled',
      payload: null,
      finished_at: now,
      updated_at: now,
      last_error_code: 'superseded',
      last_error: 'superseded: a newer mail of the same kind replaced it',
    })
    .eq('supersede_key', key)
    .eq('status', 'pending')
    .lt('created_at', before);
  if (exceptId) query = query.neq('id', exceptId);
  const { error } = await query;
  if (error) console.warn('[email-outbox] superseded mail not cancelled:', error.message);
}

/** What follows a hand-over: the after-sent action, then the older mails it supersedes. */
async function afterHandOver(
  config: ServerConfig,
  afterSent: unknown,
  supersedeKey: string | null,
  before: string,
  exceptId?: string,
): Promise<void> {
  const action = parseAfterSent(afterSent);
  if (action) {
    const { error } = await client(config)
      .from(action.table)
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', action.userId)
      .is('used_at', null)
      .is('revoked_at', null)
      .lt('created_at', action.issuedAt);
    if (error) console.warn(`[email-outbox] earlier links in ${action.table} not revoked:`, error.message);
  }
  if (supersedeKey) await cancelSuperseded(config, supersedeKey, before, exceptId);
}

async function insertRow(
  config: ServerConfig,
  request: EmailRequest,
  opts: EmailOutboxOptions,
  first: { attempts: number; startedAt: Date; nextAttemptAt: Date; lastFailure?: SendResult },
): Promise<EnqueueEmailResult> {
  const workspaceId = request.workspaceId;
  if (!(workspaceId === null || (typeof workspaceId === 'string' && UUID.test(workspaceId)))) {
    return { queued: false, error: 'invalid_request' };
  }
  if (!parseEmailAddress(request.to)) return { queued: false, error: 'invalid_recipient' };
  if (opts.afterSent && !parseAfterSent(opts.afterSent)) return { queued: false, error: 'invalid_request' };

  const windowEnd = first.startedAt.getTime() + EMAIL_RETRY_WINDOW_MS;
  const giveUpAt = Math.min(windowEnd, opts.expiresAt ? opts.expiresAt.getTime() : windowEnd);
  if (!Number.isFinite(giveUpAt) || giveUpAt <= Math.max(Date.now(), first.nextAttemptAt.getTime())) {
    return { queued: false, error: 'expired' };
  }
  const maxAttempts = Math.min(Math.max(Math.floor(opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS), 1), 50);
  const dedupeKey = cleanKey(opts.dedupeKey);
  const supersedeKey = cleanKey(opts.supersedeKey);

  let payload: StoredPayload;
  try {
    payload = sealRequest(config, request);
  } catch (err) {
    console.warn('[email-outbox] mail not queued: it could not be sealed:', err instanceof Error ? err.message : String(err));
    return { queued: false, error: 'outbox_unavailable' };
  }

  const failure = first.lastFailure ? failureOf(first.lastFailure) : null;
  const sb = client(config);
  const { data, error } = await sb
    .from('email_outbox')
    .insert({
      workspace_id: workspaceId,
      template_slug: request.templateSlug ? String(request.templateSlug).slice(0, 120) : null,
      category: request.category ?? 'transactional',
      payload,
      dedupe_key: dedupeKey,
      supersede_key: supersedeKey,
      after_sent: opts.afterSent ?? null,
      attempts: first.attempts,
      max_attempts: Math.max(maxAttempts, first.attempts + 1),
      next_attempt_at: first.nextAttemptAt.toISOString(),
      give_up_at: new Date(giveUpAt).toISOString(),
      ...(first.lastFailure && failure
        ? { provider: first.lastFailure.provider, last_error_code: failure.errorCode, last_error: failure.error }
        : {}),
    })
    .select('id, created_at')
    .single();

  if (error) {
    // 23505 is the dedupe index doing its job: the mail this key names is
    // already queued (or was sent), which is the outcome the caller wanted.
    if (String(error.code) === '23505' && dedupeKey) {
      const { data: existing } = await sb.from('email_outbox').select('id').eq('dedupe_key', dedupeKey).maybeSingle();
      return { queued: true, duplicate: true, id: (existing as { id?: string } | null)?.id };
    }
    if (String(error.code) === '23503') return { queued: false, error: 'invalid_request' };
    console.warn('[email-outbox] mail not queued:', error.message);
    return { queued: false, error: 'outbox_unavailable' };
  }

  const row = data as { id: string; created_at: string };
  if (supersedeKey) await cancelSuperseded(config, supersedeKey, row.created_at, row.id);
  if (first.nextAttemptAt.getTime() <= Date.now()) wakeEmailOutbox();
  return { queued: true, id: row.id };
}

/**
 * Queues a mail to be sent from the outbox, now (or at `notBefore`), with
 * retries; it never sends from the caller's request. `queued: false` means
 * the queue could not take it (its `error` says why: the migration is not
 * applied, an address that cannot be mailed, a link already expired), and the
 * caller decides what to do instead.
 */
export async function enqueueEmail(
  config: ServerConfig,
  request: EmailRequest,
  opts: EmailOutboxOptions = {},
): Promise<EnqueueEmailResult> {
  const now = new Date();
  const notBefore = opts.notBefore && opts.notBefore.getTime() > now.getTime() ? opts.notBefore : now;
  return insertRow(config, request, opts, { attempts: 0, startedAt: notBefore, nextAttemptAt: notBefore });
}

/**
 * One attempt now; if it failed in a way that can pass (a timeout, a dropped
 * connection, the provider's own error), the same mail is queued for another
 * and the failed result comes back with `queuedRetry: true`. A failure that
 * cannot pass comes back as it is and queues nothing. When the attempt
 * succeeds, `afterSent` runs and older mails under `supersedeKey` are
 * cancelled here; when it is queued, the outbox does both once it sends.
 */
export async function sendEmailWithRetry(
  config: ServerConfig,
  request: EmailRequest,
  opts: Omit<EmailOutboxOptions, 'notBefore'> = {},
): Promise<SendResult> {
  const startedAt = new Date();
  const result = await sendEmail(config, request);
  if (result.success) {
    await afterHandOver(config, opts.afterSent, cleanKey(opts.supersedeKey), startedAt.toISOString());
    return result;
  }
  if (!retryable(result)) return result;
  const queued = await insertRow(config, request, opts, {
    attempts: 1,
    startedAt,
    nextAttemptAt: new Date(Date.now() + emailRetryDelayMs(1)),
    lastFailure: result,
  });
  if (!queued.queued) {
    if (queued.error === 'outbox_unavailable') console.warn('[email-outbox] the failed mail could not be queued for a retry');
    return result;
  }
  return { ...result, queuedRetry: true };
}

// ─── The worker ───────────────────────────────────────────────────────────

const WORKER_ID = `email-outbox-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
/** Poll cadence while there is work; an enqueue in this process wakes it at once. */
const POLL_MS = 5_000;
/** The idle poll stretches to this; a retry is due no sooner than a minute anyway. */
const MAX_IDLE_POLL_MS = 60_000;
/** Longer than the slowest attempt (SMTP: DNS, connect, greeting and socket timeouts). */
const LEASE_SECONDS = 120;
/** One pass stops starting new attempts after this, or after this many rows. */
const PASS_BUDGET_MS = 30_000;
const MAX_ROWS_PER_PASS = 50;
const PURGE_EVERY_MS = 60 * 60_000;

interface OutboxRow {
  id: string;
  claim_token: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  give_up_at: string;
  supersede_key: string | null;
  after_sent: unknown;
  created_at: string;
  last_error_code: string | null;
  last_error: string | null;
}

export type EmailOutboxWorkerPhase = 'stopped' | 'running' | 'draining';

let phase: EmailOutboxWorkerPhase = 'stopped';
let timer: NodeJS.Timeout | null = null;
let running = false;
let shuttingDown = false;
let wakeRequested = false;
let activeDrain: Promise<unknown> | null = null;
let workerConfig: ServerConfig | null = null;
let claimWarned = false;
let pollBackoff = new IdleBackoff({ busyMs: POLL_MS, idleMs: POLL_MS, maxIdleMs: MAX_IDLE_POLL_MS });
let purgeGate = new IntervalGate(PURGE_EVERY_MS);

/**
 * Writes a claimed row's outcome, guarded by its claim token: a worker whose
 * lease ran out (and whose row another worker took) writes nothing.
 */
async function complete(config: ServerConfig, row: OutboxRow, patch: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await client(config)
    .from('email_outbox')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('claim_token', row.claim_token)
    .eq('status', 'sending')
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}

function finish(
  config: ServerConfig,
  row: OutboxRow,
  status: FinalStatus,
  extra: { provider?: string; messageId?: string; errorCode?: string | null; error?: string | null } = {},
): Promise<boolean> {
  return complete(config, row, {
    status,
    payload: null,
    finished_at: new Date().toISOString(),
    claim_token: null,
    lease_expires_at: null,
    ...(extra.provider ? { provider: extra.provider } : {}),
    ...(extra.messageId ? { provider_message_id: String(extra.messageId).slice(0, 300) } : {}),
    ...(extra.errorCode !== undefined ? { last_error_code: extra.errorCode } : {}),
    ...(extra.error !== undefined ? { last_error: extra.error ? String(extra.error).slice(0, 300) : null } : {}),
  });
}

function retryLater(config: ServerConfig, row: OutboxRow, at: Date, failure: { provider?: string; errorCode: string; error: string }): Promise<boolean> {
  return complete(config, row, {
    status: 'pending',
    next_attempt_at: at.toISOString(),
    claim_token: null,
    lease_expires_at: null,
    ...(failure.provider ? { provider: failure.provider } : {}),
    last_error_code: failure.errorCode,
    last_error: failure.error.slice(0, 300),
  });
}

/** One claimed row: sent, retried later, or final. */
async function processRow(config: ServerConfig, row: OutboxRow): Promise<void> {
  const giveUpAt = Date.parse(row.give_up_at);
  if (!Number.isFinite(giveUpAt) || giveUpAt <= Date.now()) {
    await finish(config, row, 'expired', {
      errorCode: row.last_error_code ?? 'expired',
      error: row.last_error ?? 'expired: the mail was not sent before its deadline',
    });
    return;
  }
  const request = openRequest(config, row.payload);
  if (!request) {
    await finish(config, row, 'failed', {
      errorCode: 'payload_unreadable',
      error: 'payload_unreadable: the queued mail could not be read (PLUGIN_SECRETS_MASTER_KEY missing or changed)',
    });
    return;
  }

  const result = await sendEmail(config, request);
  if (result.success) {
    await finish(config, row, 'sent', { provider: result.provider, messageId: result.id, errorCode: null, error: null });
    // Handed over: whether or not this worker still held the row, the mail
    // went, so what follows its sending follows now.
    await afterHandOver(config, row.after_sent, row.supersede_key, row.created_at, row.id);
    return;
  }

  const failure = failureOf(result);
  const next = Date.now() + emailRetryDelayMs(row.attempts);
  if (!retryable(result) || row.attempts >= row.max_attempts || next > giveUpAt) {
    await finish(config, row, 'failed', { provider: result.provider, ...failure });
    return;
  }
  await retryLater(config, row, new Date(next), { provider: result.provider, ...failure });
}

async function purgeFinished(config: ServerConfig): Promise<void> {
  const { error } = await client(config)
    .from('email_outbox')
    .delete()
    .in('status', [...FINAL_STATUSES])
    .lt('finished_at', new Date(Date.now() - KEEP_FINAL_MS).toISOString());
  if (error) console.warn('[email-outbox] purge failed:', error.message);
}

/**
 * One pass over the queue: rows are claimed one at a time (so a slow
 * provider can never outlive the lease of a row still waiting in a batch)
 * and processed until none is due, the pass's budget is spent, or a shutdown
 * begins. Never throws. Returns how many rows it processed. Exported so the
 * tests (and an operator) can drain the queue deterministically; production
 * drives it from the worker's own loop.
 */
export async function drainEmailOutbox(
  config: ServerConfig,
  opts: { runMaintenance?: boolean } = {},
): Promise<number> {
  const sb = client(config);
  if (opts.runMaintenance !== false) await purgeFinished(config).catch(() => undefined);

  const deadline = Date.now() + PASS_BUDGET_MS;
  let processed = 0;
  while (!shuttingDown && processed < MAX_ROWS_PER_PASS && Date.now() < deadline) {
    const { data, error } = await sb.rpc('email_outbox_claim', {
      p_worker: WORKER_ID,
      p_limit: 1,
      p_lease_seconds: LEASE_SECONDS,
    });
    if (error) {
      // Said once: before migration 289b this is every poll, and the
      // senders already fall back to an inline attempt.
      if (!claimWarned) console.warn('[email-outbox] claim failed:', error.message);
      claimWarned = true;
      break;
    }
    claimWarned = false;
    const rows = (Array.isArray(data) ? data : data ? [data] : []) as OutboxRow[];
    if (!rows.length) break;
    for (const row of rows) {
      processed += 1;
      try {
        await processRow(config, row);
      } catch (err) {
        // A database fault mid-row: give it back for a later attempt; if even
        // that fails, the lease runs out and the row is claimed again.
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[email-outbox] attempt not recorded:', message);
        await retryLater(config, row, new Date(Date.now() + emailRetryDelayMs(row.attempts)), {
          errorCode: 'provider_error',
          error: 'provider_error: the attempt could not be recorded',
        }).catch(() => undefined);
      }
    }
  }
  return processed;
}

async function tick(config: ServerConfig): Promise<boolean> {
  if (running || shuttingDown || phase !== 'running') return false;
  running = true;
  const pass = drainEmailOutbox(config, { runMaintenance: purgeGate.due() }).catch((err: unknown) => {
    console.warn('[email-outbox] pass failed:', err instanceof Error ? err.message : String(err));
    return 0;
  });
  activeDrain = pass;
  try {
    return (await pass) > 0;
  } finally {
    running = false;
    if (activeDrain === pass) activeDrain = null;
  }
}

function scheduleNextPoll(config: ServerConfig, delayMs: number): void {
  if (phase !== 'running') return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void pump(config);
  }, delayMs);
  timer.unref?.();
}

async function pump(config: ServerConfig): Promise<void> {
  let worked = false;
  try {
    worked = await tick(config);
  } finally {
    const now = wakeRequested;
    wakeRequested = false;
    scheduleNextPoll(config, now ? 0 : pollBackoff.next(worked));
  }
}

/**
 * Asks the worker in this process, if it runs here, to look at the queue now
 * rather than at its next poll: a mail enqueued for now goes out within
 * moments instead of up to a minute later.
 */
export function wakeEmailOutbox(): void {
  if (phase !== 'running' || !workerConfig) return;
  if (running) {
    wakeRequested = true;
    return;
  }
  scheduleNextPoll(workerConfig, 0);
}

/** Idempotent. Registers its drain for SIGTERM/SIGINT (processShutdown.ts). */
export function startEmailOutboxWorker(config: ServerConfig): void {
  if (phase === 'running') return;
  workerConfig = config;
  shuttingDown = false;
  phase = 'running';
  pollBackoff = new IdleBackoff({ busyMs: POLL_MS, idleMs: POLL_MS, maxIdleMs: MAX_IDLE_POLL_MS });
  purgeGate = new IntervalGate(PURGE_EVERY_MS);
  scheduleNextPoll(config, POLL_MS);
  onProcessShutdown('email-outbox', () => shutdownEmailOutboxWorker());
  console.log(`[email-outbox] started (${WORKER_ID})`);
}

/** Stops claiming at once; a pass in flight finishes the row it holds. Idempotent. */
export function stopEmailOutboxWorker(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  shuttingDown = true;
  phase = activeDrain ? 'draining' : 'stopped';
  if (activeDrain) {
    void activeDrain.finally(() => {
      if (!timer) phase = 'stopped';
    });
  }
}

/**
 * Stops the worker and waits (bounded) for the attempt in flight. One still
 * running when the bound passes is abandoned: its lease runs out and the row
 * is claimed again, so it may be sent twice (at least once, by contract).
 */
export async function shutdownEmailOutboxWorker(timeoutMs = 20_000): Promise<{ drained: boolean }> {
  stopEmailOutboxWorker();
  const pending = activeDrain;
  if (!pending) {
    phase = 'stopped';
    return { drained: true };
  }
  let handle: NodeJS.Timeout | undefined;
  const bound = new Promise<false>((resolve) => {
    handle = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    handle.unref?.();
  });
  const drained = await Promise.race([pending.then(() => true, () => true), bound]);
  if (handle) clearTimeout(handle);
  phase = 'stopped';
  if (!drained) console.warn('[email-outbox] shutdown timeout: the attempt in flight was abandoned; its lease will be reclaimed');
  return { drained };
}

export function getEmailOutboxWorkerStatus(): { workerId: string; phase: EmailOutboxWorkerPhase } {
  return { workerId: WORKER_ID, phase };
}
