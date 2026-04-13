// SendGrid email provider — self-hosted server runtime only

import type { ProviderConfig, SendResult } from '../index.js';

export async function sendViaSendGrid(
  config: ProviderConfig,
  to: string,
  subject: string,
  html: string,
  text: string,
  from: string
): Promise<SendResult> {
  const cfg = config.config as Record<string, string>;
  const apiKey = process.env.SENDGRID_API_KEY || cfg.api_key;

  if (!apiKey) {
    return { success: false, provider: 'sendgrid', error: 'SendGrid API key not configured. Set SENDGRID_API_KEY env var or configure via admin UI.' };
  }

  // Parse "Name <email>" format
  const fromMatch = from.match(/^(.+?)\s*<(.+?)>$/);
  const fromEmail = fromMatch ? fromMatch[2] : from;
  const fromName = fromMatch ? fromMatch[1].trim() : undefined;

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: fromEmail, name: fromName },
      subject,
      content: [
        ...(text ? [{ type: 'text/plain', value: text }] : []),
        { type: 'text/html', value: html },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return { success: false, provider: 'sendgrid', error: `SendGrid ${res.status}: ${err}` };
  }

  const messageId = res.headers.get('x-message-id') || `sg-${Date.now()}`;
  return { success: true, id: messageId, provider: 'sendgrid' };
}
