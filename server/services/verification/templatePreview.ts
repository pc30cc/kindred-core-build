/**
 * Generic Verification Core — Super Admin template preview.
 *
 * Renders the EXACT SAME templates.ts functions a real send would use, with
 * a fixed fake code, so preview and reality can never diverge — but never
 * calls a provider and never touches verification_challenges/proofs. No
 * database write happens anywhere in this file.
 */
import { renderOtpEmail, renderOtpSms } from './templates.js';
import type { VerificationLocale } from './types.js';

/** Never a real, derivable code — fixed so a preview can never leak anything about how a real code is derived. */
export const FAKE_PREVIEW_CODE = '123456';
const PREVIEW_TTL_SECONDS = 600;

export interface TemplatePreviewResult {
  locale: VerificationLocale;
  email: { subject: string; text: string; html: string };
  sms: { text: string };
}

export function renderTemplatePreview(locale: VerificationLocale): TemplatePreviewResult {
  const email = renderOtpEmail(locale, FAKE_PREVIEW_CODE, PREVIEW_TTL_SECONDS);
  const sms = renderOtpSms(locale, FAKE_PREVIEW_CODE, PREVIEW_TTL_SECONDS);
  return {
    locale,
    email: { subject: email.subject ?? '', text: email.text, html: email.html ?? '' },
    sms: { text: sms.text },
  };
}
