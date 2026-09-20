/**
 * Telephony caller-ID normalization — deliberately SEPARATE from the SMS
 * verification normalizer (`server/services/phoneVerification/phone.ts`).
 *
 * WHY TWO: the SMS normalizer validates *mobile* shapes and rejects landlines
 * on purpose, because an SMS to a landline can never be delivered. A PSTN
 * caller ID is the opposite problem — the call already happened, so we must
 * never "reject" the number and lose the call. This layer accepts Iranian
 * mobiles and landlines, E.164, `00` international prefixes, Persian/Arabic
 * digits, and degrades to a safe sanitized display form for anything else.
 *
 * Nothing here weakens SMS validation; the two modules share no code path.
 */

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Converts Persian/Arabic-Indic digits to ASCII. */
export function toAsciiDigits(input: string): string {
  let out = '';
  for (const ch of String(input ?? '')) {
    const p = PERSIAN_DIGITS.indexOf(ch);
    if (p >= 0) { out += String(p); continue; }
    const a = ARABIC_DIGITS.indexOf(ch);
    if (a >= 0) { out += String(a); continue; }
    out += ch;
  }
  return out;
}

export type TelephonyNumberKind =
  | 'e164'          // fully resolved international number
  | 'national'      // recognised national number we could not internationalize
  | 'short'         // internal extension / short code
  | 'anonymous'     // withheld / unavailable caller ID
  | 'unknown';      // something we kept verbatim but could not classify

export interface TelephonyNumber {
  /** Best canonical form. `+98…` when resolvable, else a sanitized string. */
  value: string;
  /** E.164 form when (and only when) we could resolve one. */
  e164: string | null;
  /** Human display form, suitable for the Call Center UI. */
  display: string;
  kind: TelephonyNumberKind;
  /** ISO country when confidently derived. */
  country: string | null;
}

const ANONYMOUS_TOKENS = new Set([
  '', 'anonymous', 'unknown', 'unavailable', 'private', 'restricted',
  'withheld', 'null', 'none', 'asterisk',
]);

/** Iranian mobile: 9xxxxxxxxx (10 digits). */
const IR_MOBILE = /^9\d{9}$/;
/** Iranian landline national significant number: area code + subscriber, 10 digits, not starting with 9. */
const IR_LANDLINE = /^[1-8]\d{9}$/;

function sanitizeRaw(input: string): string {
  // Keep only characters that can legitimately appear in a dialable string.
  return toAsciiDigits(input).replace(/[^\d+*#]/g, '');
}

function ok(
  value: string,
  e164: string | null,
  kind: TelephonyNumberKind,
  country: string | null,
): TelephonyNumber {
  return { value, e164, display: e164 ?? value, kind, country };
}

/**
 * Normalizes a PSTN caller/called number. NEVER throws and never returns an
 * empty result — an unrecognisable caller ID becomes `anonymous`/`unknown`
 * so the call can still ring.
 *
 * @param defaultCountry ISO country used to interpret national numbers
 *                       (trunk-zero form). Defaults to Iran.
 */
export function normalizeTelephonyNumber(
  input: unknown,
  defaultCountry: 'IR' = 'IR',
): TelephonyNumber {
  const rawText = typeof input === 'string' ? input.trim() : '';
  if (ANONYMOUS_TOKENS.has(rawText.toLowerCase())) {
    return ok('anonymous', null, 'anonymous', null);
  }

  // A SIP URI or `user@host` form: take the user part.
  const userPart = rawText.replace(/^sips?:/i, '').split('@')[0] ?? rawText;
  let digits = sanitizeRaw(userPart);
  if (!digits) return ok('anonymous', null, 'anonymous', null);

  // `00` international prefix → `+`
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;

  if (digits.startsWith('+')) {
    const body = digits.slice(1).replace(/\D/g, '');
    if (body.length >= 8 && body.length <= 15) {
      const country = body.startsWith('98') ? 'IR' : null;
      return ok(`+${body}`, `+${body}`, 'e164', country);
    }
    return ok(digits, null, 'unknown', null);
  }

  const bare = digits.replace(/\D/g, '');
  if (!bare) return ok(digits, null, 'unknown', null);

  if (defaultCountry === 'IR') {
    // 98xxxxxxxxxx without a plus
    if (bare.startsWith('98') && bare.length >= 12 && bare.length <= 13) {
      return ok(`+${bare}`, `+${bare}`, 'e164', 'IR');
    }
    // Trunk-zero national form: 0912…, 021…
    const national = bare.startsWith('0') ? bare.slice(1) : bare;
    if (IR_MOBILE.test(national) || IR_LANDLINE.test(national)) {
      return ok(`+98${national}`, `+98${national}`, 'e164', 'IR');
    }
  }

  // Short codes / internal extensions (e.g. `104`).
  if (bare.length <= 6) return ok(bare, null, 'short', null);

  // Something plausible but not resolvable — keep it, never drop the call.
  return ok(bare, null, bare.length >= 7 ? 'national' : 'unknown', null);
}

/**
 * Candidate strings to match against stored contact phone numbers. Contacts
 * may have been saved in any of the accepted input shapes, so we search for
 * all equivalent forms of the same number within the workspace.
 */
export function contactMatchCandidates(n: TelephonyNumber): string[] {
  const out = new Set<string>();
  if (n.kind === 'anonymous') return [];
  out.add(n.value);
  if (n.e164) {
    const e = n.e164;
    out.add(e);
    out.add(e.slice(1));            // 98912…
    if (e.startsWith('+98')) {
      const national = e.slice(3);
      out.add(`0${national}`);      // 0912…
      out.add(national);            // 912…
      out.add(`0098${national}`);
    }
  }
  return [...out].filter(Boolean);
}

/** Log-safe form: keeps country/prefix, masks the subscriber tail. */
export function maskNumberForLog(value: string | null | undefined): string {
  const s = String(value ?? '');
  if (!s) return '';
  if (s.length <= 5) return `${s[0] ?? ''}***`;
  return `${s.slice(0, s.length - 5)}*****`;
}
