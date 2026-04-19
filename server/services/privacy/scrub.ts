/**
 * PII scrubbing — regex-based, conservative.
 *
 * Used during DELETE jobs to scrub operator-written message bodies and
 * note bodies in-place. Only emails and phone numbers are scrubbed.
 *
 * Idempotent: re-running on already-scrubbed text produces the same
 * output (placeholders never re-match).
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// International-friendly phone matcher: optional +, 7–15 digits with
// optional spaces / dashes / dots / parens. Avoids matching dates by
// requiring at least 7 total digits.
const PHONE_RE = /(?<!\w)(?:\+?\d[\d\s().-]{6,18}\d)(?!\w)/g;

const EMAIL_PLACEHOLDER = '[email-redacted]';
const PHONE_PLACEHOLDER = '[phone-redacted]';

export interface ScrubResult {
  text: string;
  changed: boolean;
  emailMatches: number;
  phoneMatches: number;
}

export function scrubPii(input: string | null | undefined): ScrubResult {
  if (!input) return { text: input ?? '', changed: false, emailMatches: 0, phoneMatches: 0 };

  let emailMatches = 0;
  const afterEmail = input.replace(EMAIL_RE, () => {
    emailMatches++;
    return EMAIL_PLACEHOLDER;
  });

  let phoneMatches = 0;
  const afterPhone = afterEmail.replace(PHONE_RE, (m) => {
    // Count digits to avoid stripping things like "12-3" with spaces.
    const digits = (m.match(/\d/g) || []).length;
    if (digits < 7) return m;
    phoneMatches++;
    return PHONE_PLACEHOLDER;
  });

  return {
    text: afterPhone,
    changed: emailMatches + phoneMatches > 0,
    emailMatches,
    phoneMatches,
  };
}