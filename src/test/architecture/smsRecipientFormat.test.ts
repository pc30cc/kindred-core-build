/**
 * Every phone number handed to the SMS service is in the vendors' local form.
 *
 * The database stores E.164 (`+989121234567`) everywhere and should keep
 * doing so — it is the canonical, unambiguous representation. But the Iranian
 * vendors this platform ships adapters for reject it: SMS.ir documents
 * `919xxxx904`, its SDK documents `09123456789`, and Kavenegar expects the
 * same local shape. `toProviderFormat` is the one conversion, and every path
 * into `server/services/sms` has to go through it.
 *
 * This was not hypothetical. Three call sites passed E.164 straight to the
 * provider:
 *
 *   server/services/verification/service.ts   guest order-lookup OTP
 *   server/services/invitations/worker.ts     invitation notification
 *   server/services/billing/notifications/    billing notification
 *     dispatcher.ts
 *
 * all of which the vendor would refuse. Nothing caught it because the send
 * "succeeded" as far as the caller could see — the failure was a provider
 * error code buried in a log line.
 *
 * A static test rather than a runtime one on purpose: the bug is a missing
 * call, and the cheapest place to notice a missing call is the source. Adding
 * a new `sendSms`/`sendSmsVerification` caller that forgets the conversion
 * fails here, at the moment it is written.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SERVER_DIR = join(process.cwd(), 'server');

/** The SMS service itself defines these; it is not a caller. */
const NOT_A_CALLER = join('server', 'services', 'sms');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Returns the `to:` argument of every sendSms / sendSmsVerification call in a
 * file. Deliberately simple: the codebase always writes these as an object
 * literal with `to:` as a property, so a brace-balanced scan of the call is
 * enough and is far easier to read than a parser.
 */
function sendToArguments(src: string): { fn: string; to: string }[] {
  const out: { fn: string; to: string }[] = [];
  const call = /\b(sendSmsVerification|sendSms)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(src))) {
    let depth = 1;
    let i = call.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    const args = src.slice(call.lastIndex, i - 1);
    const to = /\bto\s*:\s*([^,\n]+)/.exec(args);
    if (to) out.push({ fn: m[1], to: to[1].trim() });
  }
  return out;
}

describe('SMS recipients reach the vendor in local format', () => {
  const files = walk(SERVER_DIR).filter((f) => !f.includes(NOT_A_CALLER));

  it('finds the known callers, so a silent zero-match cannot pass this test', () => {
    const callers = files.filter((f) => sendToArguments(readFileSync(f, 'utf8')).length > 0);
    // verification/service.ts, phoneVerification/index.ts, invitations/worker.ts,
    // billing/notifications/dispatcher.ts
    expect(callers.length).toBeGreaterThanOrEqual(4);
  });

  it('every sendSms / sendSmsVerification recipient goes through toProviderFormat', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const { fn, to } of sendToArguments(readFileSync(file, 'utf8'))) {
        if (!to.includes('toProviderFormat')) {
          offenders.push(`${file.replace(process.cwd() + '/', '')}: ${fn}({ to: ${to} })`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is idempotent, so converting at the call site twice is harmless', async () => {
    const { toProviderFormat } = await import('../../../server/services/phoneVerification/phone.js');
    const once = toProviderFormat('+989121234567');
    expect(once).toBe('09121234567');
    expect(toProviderFormat(once)).toBe('09121234567');
  });
});
