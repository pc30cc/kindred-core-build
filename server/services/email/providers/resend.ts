// Resend email provider — self-hosted server runtime only

import type { ProviderConfig, SendResult } from '../index.js';

/**
 * Minimal shape of the Resend `POST /emails` success response.
 * Only the message `id` is consumed here.
 */
interface ResendSendResponse {
  id: string;
}

export function isResendSendResponse(value: unknown): value is ResendSendResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof (value as { id: unknown }).id === 'string'
  );
}

export async function sendViaResend(
  config: ProviderConfig,
  to: string,
  subject: string,
  html: string,
  text: string,
  from: string
): Promise<SendResult> {
  const cfg = config.config as Record<string, string>;
  const apiKey = process.env.RESEND_API_KEY || cfg.api_key;

  if (!apiKey) {
    return { success: false, provider: 'resend', error: 'Resend API key not configured. Set RESEND_API_KEY env var or configure via admin UI.' };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html,
      text: text || undefined,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return { success: false, provider: 'resend', error: `Resend ${res.status}: ${err}` };
  }

  const data: unknown = await res.json();
  if (!isResendSendResponse(data)) {
    return { success: false, provider: 'resend', error: 'Resend returned an unexpected response shape' };
  }
  return { success: true, id: data.id, provider: 'resend' };
}
