/**
 * Incremental thread sync for GET /api/conversations/:id/messages?since=…
 *
 * Native clients keep the thread on the device and only ask for what changed.
 * "Changed" is decided by conversation_messages.updated_at, which a trigger
 * sets to clock_timestamp() on every INSERT and UPDATE (migration 216) — and
 * which the attachment trigger bumps when a file is linked to a message later.
 *
 * The cursor is opaque to clients ("v1.<epoch microseconds>"). It is never
 * the newest timestamp the server has seen, but at most `now - SAFETY_LAG`:
 * a row whose timestamp was taken before that instant has certainly
 * committed, so a later reader cannot find an older, just-committed row
 * behind the cursor. Rows newer than the lag are simply sent again on the
 * next call, and clients upsert by id, so a repeat is harmless.
 *
 * Deletes and rows that become hidden have no tombstone here. Instead every
 * sync response carries `total` — how many messages a full fetch would
 * return right now — and a client whose merged copy does not add up to it
 * throws its copy away and takes a full snapshot. That covers deletes,
 * retention, the Telegram menu-visibility switch and anything missed.
 */

export const SYNC_CURSOR_PREFIX = 'v1.';
/** How far behind "now" a cursor stays, so an in-flight write is never skipped. */
export const SAFETY_LAG_MICROS = 30n * 1_000_000n;
/** A delta bigger than this is answered with a full snapshot instead. */
export const MAX_DELTA_ROWS = 500;

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * Postgres timestamptz text → epoch microseconds, without going through a JS
 * Date (which would drop the microseconds and make the cursor re-send the
 * newest row forever).
 */
export function timestampToMicros(value: unknown): bigint | null {
  if (typeof value !== 'string') return null;
  const m = TS_RE.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (!Number.isFinite(ms)) return null;
  let micros = BigInt(ms) * 1000n + BigInt((frac ?? '').padEnd(6, '0').slice(0, 6) || '0');
  if (zone && zone.toUpperCase() !== 'Z') {
    const sign = zone.startsWith('-') ? -1n : 1n;
    const digits = zone.slice(1).replace(':', '');
    const offMin = BigInt(Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || '0'));
    micros -= sign * offMin * 60n * 1_000_000n;
  }
  return micros;
}

/** Epoch microseconds → an ISO timestamp Postgres reads back exactly. */
export function microsToTimestamp(micros: bigint): string {
  const ms = micros / 1000n;
  const rest = micros % 1000n;
  const base = new Date(Number(ms)).toISOString(); // …THH:MM:SS.mmmZ
  return `${base.slice(0, 23)}${String(rest < 0n ? -rest : rest).padStart(3, '0')}Z`;
}

export function encodeCursor(micros: bigint): string {
  return `${SYNC_CURSOR_PREFIX}${micros.toString()}`;
}

/** null for anything that is not a cursor this server issued (the caller then answers in full). */
export function decodeCursor(raw: unknown): bigint | null {
  if (typeof raw !== 'string' || !raw.startsWith(SYNC_CURSOR_PREFIX)) return null;
  const digits = raw.slice(SYNC_CURSOR_PREFIX.length);
  if (!/^\d{1,20}$/.test(digits)) return null;
  return BigInt(digits);
}

/**
 * The cursor to hand back after reading `rows`: the newest updated_at seen,
 * but never later than now - SAFETY_LAG, and never earlier than the cursor
 * the client came with. null when rows exist but carry no updated_at (the
 * migration has not run) — the client then keeps fetching in full.
 */
export function nextCursor(
  rows: Array<{ updated_at?: unknown }>,
  since: bigint | null,
  now: bigint,
): bigint | null {
  let newest: bigint | null = null;
  for (const r of rows) {
    const t = timestampToMicros(r?.updated_at);
    if (t === null) return null;
    if (newest === null || t > newest) newest = t;
  }
  const safe = now - SAFETY_LAG_MICROS;
  let cursor = newest !== null && newest < safe ? newest : safe;
  if (since !== null && cursor < since) cursor = since;
  return cursor;
}

export function nowMicros(): bigint {
  return BigInt(Date.now()) * 1000n;
}

/** Same rule the full thread applies: bot menu taps are hidden unless Super Admin shows them. */
export function isMenuEvent(m: { metadata?: unknown } | null | undefined): boolean {
  const meta = (m?.metadata && typeof m.metadata === 'object') ? m.metadata as Record<string, unknown> : null;
  return String(meta?.channel_menu_event ?? '') === 'true';
}
