// SendGrid email provider — self-hosted server runtime only

import {
  configText,
  emailFailure,
  fetchFailure,
  httpFailure,
  type EmailAdapter,
  type EmailProviderVerifyResult,
  type OutboundMessage,
  type ProviderConfig,
  type SendResult,
  timeoutSignal,
} from './types.js';

const API = 'https://api.sendgrid.com/v3';

async function sendViaSendGrid(config: ProviderConfig, message: OutboundMessage): Promise<SendResult> {
  const apiKey = configText(config.config, 'api_key');
  if (!apiKey) {
    return emailFailure('sendgrid', 'unconfigured', 'the SendGrid API key is not configured. Set it in Super Admin → Providers → Email.');
  }

  let res: Response;
  try {
    res = await fetch(`${API}/mail/send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: message.to }] }],
        // SendGrid takes the name and the address apart, and quotes the name itself.
        from: { email: message.from.address, ...(message.from.name ? { name: message.from.name } : {}) },
        ...(message.replyTo ? { reply_to: { email: message.replyTo } } : {}),
        subject: message.subject,
        // text/plain first: SendGrid refuses the parts in any other order.
        content: [
          { type: 'text/plain', value: message.text },
          ...(message.html ? [{ type: 'text/html', value: message.html }] : []),
        ],
        headers: message.headers,
        ...(message.category ? { categories: [message.category] } : {}),
      }),
      signal: timeoutSignal(),
    });
  } catch (err) {
    return fetchFailure('sendgrid', err, [apiKey]);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return httpFailure('sendgrid', res.status, body, [apiKey]);
  }

  const messageId = res.headers?.get?.('x-message-id') || `sg-${Date.now()}`;
  return { success: true, id: messageId, provider: 'sendgrid' };
}

/** An authenticated read of the key's own scopes: it must be able to send mail. */
async function verifySendGrid(config: ProviderConfig): Promise<EmailProviderVerifyResult> {
  const apiKey = configText(config.config, 'api_key');
  if (!apiKey) return { ok: false, detail: 'unconfigured: the SendGrid API key is not configured' };
  let res: Response;
  try {
    res = await fetch(`${API}/scopes`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: timeoutSignal(),
    });
  } catch (err) {
    return { ok: false, detail: fetchFailure('sendgrid', err, [apiKey]).error ?? 'connection: SendGrid could not be reached' };
  }
  const body = await res.text().catch(() => '');
  if (!res.ok) return { ok: false, detail: httpFailure('sendgrid', res.status, body, [apiKey]).error ?? `auth: HTTP ${res.status}` };
  let scopes: unknown[] = [];
  try {
    const parsed = JSON.parse(body) as { scopes?: unknown[] };
    scopes = Array.isArray(parsed?.scopes) ? parsed.scopes : [];
  } catch {
    /* handled below as "cannot send" */
  }
  if (!scopes.includes('mail.send')) return { ok: false, detail: 'auth: the key is accepted but may not send mail (no mail.send scope)' };
  return { ok: true, detail: 'the key is accepted and may send mail' };
}

export const sendgridAdapter: EmailAdapter = {
  name: 'sendgrid',
  send: sendViaSendGrid,
  verify: verifySendGrid,
};
