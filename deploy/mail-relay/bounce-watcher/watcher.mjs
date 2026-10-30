// ============================================
// mail-relay bounce watcher
// ============================================
//
// Our Postfix relay accepts a mail and only then tries the recipient's
// server, so a refusal there (an unknown mailbox, a policy) never reaches
// the backend that sent it: Postfix writes it to its log and mails a bounce
// notice to the sender, noreply@<brand>, whose mailbox is at iCloud and read
// by nobody. This sidecar reads that log instead (Postfix's maillog_file, on
// a volume both containers share), and reports each hard bounce to the
// sending brand's backend, which puts the address on its suppression list
// (POST https://api.<brand domain>/api/email-events/relay, see
// server/routes/emailEvents.ts and docs/operations/EMAIL.md):
//
//   - qmgr's `<queue id>: from=<sender>` names the sender of a queue id; the
//     brand is the sender's domain, so each brand only hears of its own mail;
//   - smtp's `<queue id>: to=<recipient>, … dsn=5.x.x, status=bounced (…)` is
//     a permanent failure; deferrals (4.x.x) are retried by Postfix and only
//     counted for the alert;
//   - a permanent failure about the address (5.1.x, 5.2.x, 5.4.4) is
//     reported; one about our sending (5.7.x: the relay's IP reputation, SPF,
//     DKIM, DMARC, a policy; the rest of 5.x.x) is not, since it says nothing
//     about the address, and is alerted instead: suppressing it would keep
//     resets from that address for 30 days after the cause is fixed;
//   - each report is signed with that brand's events token (HMAC over the
//     timestamp and the body), so the token never crosses the wire.
//
// The read position, the open queue ids and the reports not yet delivered
// are kept in a state file, so a restart neither repeats nor loses a bounce;
// a report the backend did not take is retried with backoff for 3 days.
// Optionally (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID), refusals of our
// sending, deferred mail and a growing queue are reported to Telegram, by
// count, status and domain only.
//
// Plain Node 24, no dependencies. Nothing here logs a token or an address.

import { createHmac } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** A report the backend has not taken after this long is given up. */
export const MAX_REPORT_AGE_MS = 3 * DAY;
/** An open queue id is forgotten after this long (Postfix keeps mail 5 days). */
const MAX_PENDING_AGE_MS = 6 * DAY;
/** A report holds at most this many events. */
const MAX_BATCH = 100;

// ─── Configuration ─────────────────────────────────────────────────

/** `webyar.ai` → `WEBYAR_AI`: the suffix of that brand's variables. */
export function envSuffix(domain) {
  return domain.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * The brands to report to, from BRAND_DOMAINS: each one's endpoint
 * (EVENTS_URL_<DOMAIN>, by default its API) and token
 * (EVENTS_TOKEN_<DOMAIN>). A brand without a token is left out: its bounces
 * are only logged.
 */
export function readBrands(env) {
  const domains = String(env.BRAND_DOMAINS || 'webyar.ai respok.app').split(/[\s,]+/).filter(Boolean);
  const brands = new Map();
  for (const domain of domains.map((d) => d.toLowerCase())) {
    const suffix = envSuffix(domain);
    const token = String(env[`EVENTS_TOKEN_${suffix}`] || '').trim();
    if (!token) continue;
    const url = String(env[`EVENTS_URL_${suffix}`] || `https://api.${domain}/api/email-events/relay`).trim();
    brands.set(domain, { domain, url, token });
  }
  return brands;
}

/** The brand a sender belongs to: its domain, or a parent domain of it. */
export function brandFor(sender, brands) {
  const at = sender.lastIndexOf('@');
  if (at < 0) return null;
  let domain = sender.slice(at + 1).toLowerCase();
  while (domain) {
    if (brands.has(domain)) return brands.get(domain);
    const dot = domain.indexOf('.');
    if (dot < 0) break;
    domain = domain.slice(dot + 1);
  }
  return null;
}

// ─── The log ───────────────────────────────────────────────────────

const LINE = /postfix(?:\/[\w.-]+)*\/([\w-]+)\[\d+\]: ([0-9A-Za-z]{6,}): (.*)$/;

/**
 * One line of Postfix's log, as far as it matters here: the daemon, the
 * queue id and what happened to it. Anything else (connections, NOQUEUE
 * rejections, warnings) is null.
 */
export function parseLogLine(line) {
  const m = LINE.exec(line);
  if (!m || m[2] === 'NOQUEUE') return null;
  const [, daemon, queueId, rest] = m;
  if (rest === 'removed') return { daemon, queueId, kind: 'removed' };
  const from = /^from=<([^>]*)>/.exec(rest);
  if (from) return { daemon, queueId, kind: 'from', sender: from[1] };
  const to = /^to=<([^>]*)>/.exec(rest);
  const status = /\bstatus=(\w+)/.exec(rest);
  if (to && status) {
    const dsn = /\bdsn=(\d\.\d{1,3}\.\d{1,3})/.exec(rest)?.[1] ?? '';
    const reason = /\bstatus=\w+ \((.*)\)\s*$/.exec(rest)?.[1] ?? '';
    return { daemon, queueId, kind: 'delivery', recipient: to[1], status: status[1], dsn, reason };
  }
  return null;
}

/**
 * Whether a permanent failure's dsn is about the recipient's address: 5.1.x
 * the address, 5.2.x the mailbox, 5.4.4 a domain with no mail route. The
 * backend's own rule (isSuppressible in server/routes/emailEvents.ts), which
 * also skips the rest if they are sent; src/test/email/mailRelayBounceWatcher.test.ts
 * holds the two equal.
 */
export function recipientFault(dsn) {
  return /^5\.[12]\./.test(dsn) || dsn === '5.4.4';
}

/**
 * Applies one line to the state and returns what it means:
 * `{ bounce: { brand, event } }` for a hard bounce of a brand's mail,
 * `{ refused: { domain, dsn } }` for a refusal of our sending,
 * `{ deferred: <recipient domain> }` for a deferral, or null.
 */
export function handleLine(state, brands, line, now = Date.now()) {
  const parsed = parseLogLine(line);
  if (!parsed) return null;
  if (parsed.kind === 'from') {
    state.pending[parsed.queueId] = { sender: parsed.sender, at: now };
    return null;
  }
  if (parsed.kind === 'removed') {
    delete state.pending[parsed.queueId];
    return null;
  }
  const recipientDomain = parsed.recipient.slice(parsed.recipient.lastIndexOf('@') + 1).toLowerCase();
  if (parsed.status === 'deferred') return { deferred: recipientDomain };
  if (parsed.status !== 'bounced' || !parsed.dsn.startsWith('5.')) return null;
  if (!recipientFault(parsed.dsn)) return { refused: { domain: recipientDomain, dsn: parsed.dsn } };
  const sender = state.pending[parsed.queueId]?.sender;
  // A bounce of a bounce notice (sender <>) or of a queue id seen before
  // this watcher started: nothing to report to.
  if (!sender) return { unknownSender: true };
  const brand = brandFor(sender, brands);
  if (!brand) return { unknownSender: true };
  return {
    bounce: {
      brand: brand.domain,
      event: {
        type: 'bounce',
        recipient: parsed.recipient,
        status: parsed.dsn,
        detail: parsed.reason.slice(0, 200),
        queue_id: parsed.queueId,
        at: new Date(now).toISOString(),
      },
    },
  };
}

// ─── Reports ───────────────────────────────────────────────────────

/** `v1=<hex>`: HMAC-SHA256 over `<timestamp>.<body>`, as the backend checks it. */
export function signReport(token, timestamp, body) {
  return `v1=${createHmac('sha256', token).update(`${timestamp}.`).update(body).digest('hex')}`;
}

/** 30 s, doubling, at most an hour. */
export function retryDelayMs(attempts) {
  return Math.min(30_000 * 2 ** Math.max(attempts - 1, 0), HOUR);
}

async function postReport(brand, events, fetchImpl = fetch) {
  const body = JSON.stringify({ events });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const res = await fetchImpl(brand.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-relay-timestamp': timestamp,
      'x-relay-signature': signReport(brand.token, timestamp, body),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  return res.status;
}

/**
 * Sends what is due in the outbox, one report per brand. 2xx: delivered;
 * 400: the backend can never take it, dropped; anything else (a network
 * error, 401 while a token is being rotated, 404 before the backend has its
 * token, 429, 5xx): retried with backoff until it is 3 days old.
 */
export async function flushOutbox(state, brands, now = Date.now(), fetchImpl = fetch, log = console) {
  const due = state.outbox.filter((item) => item.nextAt <= now);
  const byBrand = new Map();
  for (const item of due) {
    if (!byBrand.has(item.brand)) byBrand.set(item.brand, []);
    byBrand.get(item.brand).push(item);
  }
  for (const [domain, items] of byBrand) {
    const brand = brands.get(domain);
    const batch = items.slice(0, MAX_BATCH);
    let status = 0;
    if (brand) {
      try {
        status = await postReport(brand, batch.map((item) => item.event), fetchImpl);
      } catch (err) {
        log.warn(`[bounce-watcher] ${domain}: report failed: ${err instanceof Error ? err.name : 'error'}`);
      }
    }
    const done = new Set();
    if (status >= 200 && status < 300) {
      log.info(`[bounce-watcher] ${domain}: ${batch.length} bounce(s) reported`);
      for (const item of batch) done.add(item);
    } else if (status === 400) {
      log.error(`[bounce-watcher] ${domain}: report refused (400), ${batch.length} bounce(s) dropped`);
      for (const item of batch) done.add(item);
    } else {
      if (status) log.warn(`[bounce-watcher] ${domain}: report answered ${status}, will retry`);
      for (const item of batch) {
        item.attempts += 1;
        item.nextAt = now + retryDelayMs(item.attempts);
        if (now - item.firstAt > MAX_REPORT_AGE_MS) {
          log.error(`[bounce-watcher] ${domain}: a bounce report was given up after 3 days`);
          done.add(item);
        }
      }
    }
    state.outbox = state.outbox.filter((item) => !done.has(item));
  }
}

// ─── Telegram (optional) ───────────────────────────────────────────

async function telegram(env, text, log = console) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const chat = String(env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chat) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) log.warn(`[bounce-watcher] telegram answered ${res.status}`);
  } catch (err) {
    log.warn(`[bounce-watcher] telegram failed: ${err instanceof Error ? err.name : 'error'}`);
  }
}

/** Files in Postfix's queues: what waits to be delivered. */
async function queueSize(spoolDir) {
  let total = 0;
  for (const queue of ['incoming', 'active', 'deferred', 'hold']) {
    try {
      const entries = await fsp.readdir(path.join(spoolDir, queue), { recursive: true, withFileTypes: true });
      total += entries.filter((e) => e.isFile()).length;
    } catch {
      // A queue directory that is not there (or not readable) counts as empty.
    }
  }
  return total;
}

// ─── State ─────────────────────────────────────────────────────────

function emptyState() {
  return { inode: null, position: null, pending: {}, outbox: [] };
}

async function loadState(file) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

async function saveState(file, state) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state));
  await fsp.rename(tmp, file);
}

// ─── The loop ──────────────────────────────────────────────────────

/**
 * Reads what the log gained since the last position. A line is consumed
 * only once it is whole. When the log was rotated (a new inode: `postfix
 * logrotate`), the rest of the old file is read first through the handle
 * still open on it; when it was truncated, reading starts over.
 */
function createReader(file, state) {
  let handle = null;
  let handleInode = null;

  async function readFrom(fh, onLine) {
    const chunk = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, state.position);
      if (bytesRead === 0) return;
      const lastNewline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (lastNewline < 0) {
        // A partial line waits for its end; a "line" longer than the buffer
        // is not Postfix's, and is skipped.
        if (bytesRead < chunk.length) return;
        state.position += bytesRead;
        continue;
      }
      for (const line of chunk.subarray(0, lastNewline).toString('utf8').split('\n')) if (line) onLine(line);
      state.position += lastNewline + 1;
    }
  }

  return async function poll(onLine) {
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      return; // Not written yet.
    }
    if (handle && handleInode !== stat.ino) {
      await readFrom(handle, onLine);
      await handle.close();
      handle = null;
      state.position = 0;
    }
    if (!handle) {
      handle = await fsp.open(file, 'r');
      handleInode = stat.ino;
      if (state.inode !== stat.ino) {
        // A file this state has never read: from its start if the log was
        // rotated under us, from its end on the very first run.
        state.position = state.inode === null && state.position === null ? stat.size : 0;
        state.inode = stat.ino;
      }
    }
    if (state.position > stat.size) state.position = 0;
    await readFrom(handle, onLine);
  };
}

async function main() {
  const env = process.env;
  const log = console;
  const logFile = env.MAILLOG_PATH || '/var/log/postfix/mail.log';
  const stateDir = env.STATE_DIR || '/state';
  const spoolDir = env.SPOOL_DIR || '/var/spool/postfix';
  const pollMs = Number(env.POLL_INTERVAL_MS) || 2000;
  const queueThreshold = Number(env.QUEUE_ALERT_THRESHOLD) || 20;
  const alertEveryMs = (Number(env.ALERT_INTERVAL_MINUTES) || 60) * 60_000;
  const brands = readBrands(env);
  const stateFile = path.join(stateDir, 'bounce-watcher.json');
  await fsp.mkdir(stateDir, { recursive: true });
  const state = await loadState(stateFile);
  const poll = createReader(logFile, state);

  log.info(`[bounce-watcher] reading ${logFile}; reporting for ${[...brands.keys()].join(', ') || 'no brand (no token set)'}`);
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) log.info('[bounce-watcher] Telegram alerts on');

  const deferred = new Map();
  let lastDeferredAlert = Date.now();
  // Refusals of our sending, by recipient domain and status. The first run
  // of them is said at once (a block on the relay's IP stops every mail to
  // that provider), the next ones at most once per interval.
  const refused = new Map();
  let lastRefusedAlert = 0;
  let lastQueueCheck = 0;
  let lastQueueAlert = 0;
  let lastQueueAlerted = 0;
  let stopping = false;

  const stop = async () => {
    stopping = true;
    await saveState(stateFile, state).catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  while (!stopping) {
    const now = Date.now();
    let changed = false;
    try {
      await poll((line) => {
        changed = true;
        const result = handleLine(state, brands, line, now);
        if (result?.bounce) {
          state.outbox.push({ brand: result.bounce.brand, event: result.bounce.event, firstAt: now, attempts: 0, nextAt: now });
        } else if (result?.refused) {
          const key = `${result.refused.domain} ${result.refused.dsn}`;
          refused.set(key, (refused.get(key) || 0) + 1);
        } else if (result?.deferred) {
          deferred.set(result.deferred, (deferred.get(result.deferred) || 0) + 1);
        }
      });
    } catch (err) {
      log.warn(`[bounce-watcher] reading the log failed: ${err instanceof Error ? err.message : 'error'}`);
    }

    for (const [qid, entry] of Object.entries(state.pending)) {
      if (now - entry.at > MAX_PENDING_AGE_MS) {
        delete state.pending[qid];
        changed = true;
      }
    }
    if (state.outbox.some((item) => item.nextAt <= now)) {
      await flushOutbox(state, brands, now, fetch, log);
      changed = true;
    }
    if (changed) await saveState(stateFile, state).catch((err) => log.warn(`[bounce-watcher] saving state failed: ${err.message}`));

    if (refused.size > 0 && now - lastRefusedAlert >= alertEveryMs) {
      const total = [...refused.values()].reduce((a, b) => a + b, 0);
      const top = [...refused.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} ×${n}`).join(', ');
      log.warn(`[bounce-watcher] ${total} delivery(ies) refused for our sending, not the address (${top}); not reported`);
      await telegram(
        env,
        `mail-relay: ${total} mail(s) refused because of our sending, not the address (${top}). `
          + 'No address was suppressed. Check the relay\'s IP reputation, SPF, DKIM and DMARC (docs/operations/EMAIL.md, "Policy bounces").',
        log,
      );
      refused.clear();
      lastRefusedAlert = now;
    }
    if (deferred.size > 0 && now - lastDeferredAlert >= alertEveryMs) {
      const total = [...deferred.values()].reduce((a, b) => a + b, 0);
      const domains = [...deferred.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d, n]) => `${d} ×${n}`).join(', ');
      await telegram(env, `mail-relay: ${total} deferred delivery attempt(s) since the last report (${domains}).`, log);
      deferred.clear();
      lastDeferredAlert = now;
    }
    if (now - lastQueueCheck >= 5 * 60_000) {
      lastQueueCheck = now;
      const size = await queueSize(spoolDir);
      if (size >= queueThreshold && (now - lastQueueAlert >= alertEveryMs || size >= lastQueueAlerted * 2)) {
        await telegram(env, `mail-relay: ${size} message(s) waiting in the Postfix queue.`, log);
        lastQueueAlert = now;
        lastQueueAlerted = size;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[bounce-watcher] stopped: ${err instanceof Error ? err.message : 'error'}`);
    process.exit(1);
  });
}
