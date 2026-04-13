// Resend email provider — self-hosted server runtime only

import type { ProviderConfig, SendResult } from '../index.js';

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

  const data = await res.json();
  return { success: true, id: data.id, provider: 'resend' };
}
