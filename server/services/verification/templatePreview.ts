/**
 * Generic Verification Core — Super Admin template preview.
 *
 * EMAIL: renders the EXACT SAME templates.ts function a real send would use,
 * with a fixed fake code, so preview and reality can never diverge.
 *
 * SMS: a real OTP send does NOT use templates.ts at all — it goes through the
 * vendor's own verification template (SMS.ir `/v1/send/verify`, Kavenegar
 * VerifyLookup) so it is sent on a high-priority service line that reaches
 * recipients who have blocked advertising SMS. Only the code is substituted
 * into that template. The `sms.text` below is therefore the platform's
 * reference wording, NOT the bytes the recipient receives, and is flagged
 * `providerTemplated` so the admin UI can say so rather than imply the
 * platform controls it.
 *
 * Neither branch calls a provider or touches
 * verification_challenges/proofs. No database write happens in this file.
 */
import { renderOtpEmail, renderOtpSms } from './templates.js';
import type { VerificationLocale } from './types.js';

/** Never a real, derivable code — fixed so a preview can never leak anything about how a real code is derived. */
export const FAKE_PREVIEW_CODE = '123456';
const PREVIEW_TTL_SECONDS = 600;

export interface TemplatePreviewResult {
  locale: VerificationLocale;
  email: { subject: string; text: string; html: string };
  /** `providerTemplated` is always true: the real body lives in the vendor panel. */
  sms: { text: string; providerTemplated: boolean };
}

export function renderTemplatePreview(locale: VerificationLocale): TemplatePreviewResult {
  const email = renderOtpEmail(locale, FAKE_PREVIEW_CODE, PREVIEW_TTL_SECONDS);
  const sms = renderOtpSms(locale, FAKE_PREVIEW_CODE, PREVIEW_TTL_SECONDS);
  return {
    locale,
    email: { subject: email.subject ?? '', text: email.text, html: email.html ?? '' },
    sms: { text: sms.text, providerTemplated: true },
  };
}
