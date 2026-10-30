/**
 * Generic Verification Core — Super Admin template preview (the SMS).
 *
 * EMAIL: not here. The code is mailed with the Super Admin template
 * `verification_code` (Branding → Email templates), and Super Admin →
 * Verification shows it through Branding's own preview
 * (POST /api/admin/management/email-templates/preview), which renders that
 * row through the email core as it is sent, with FAKE_PREVIEW_CODE as its
 * code. The compiled text in templates.ts is only the fallback for a missing
 * row, so previewing it here showed a mail nobody received.
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
 * Nothing here calls a provider or touches verification_challenges/proofs.
 * No database write happens in this file.
 */
import { renderOtpSms } from './templates.js';
import type { VerificationLocale } from './types.js';

/** Never a real, derivable code — fixed so a preview can never leak anything about how a real code is derived. */
export const FAKE_PREVIEW_CODE = '123456';
const PREVIEW_TTL_SECONDS = 600;

export interface TemplatePreviewResult {
  locale: VerificationLocale;
  /** `providerTemplated` is always true: the real body lives in the vendor panel. */
  sms: { text: string; providerTemplated: boolean };
}

export function renderTemplatePreview(locale: VerificationLocale): TemplatePreviewResult {
  const sms = renderOtpSms(locale, FAKE_PREVIEW_CODE, PREVIEW_TTL_SECONDS);
  return {
    locale,
    sms: { text: sms.text, providerTemplated: true },
  };
}
