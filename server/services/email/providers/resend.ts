// Resend email provider — self-hosted server runtime only

import {
  configText,
  emailFailure,
  fetchFailure,
  formatMailbox,
  httpFailure,
  type EmailAdapter,
  type EmailProviderVerifyResult,
  type OutboundMessage,
  type ProviderConfig,
  type SendResult,
  timeoutSignal,
} from './types.js';

const API = 'https://api.resend.com';

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

async function sendViaResend(config: ProviderConfig, message: OutboundMessage): Promise<SendResult> {
  const apiKey = configText(config.config, 'api_key');
  if (!apiKey) {
    return emailFailure('resend', 'unconfigured', 'the Resend API key is not configured. Set it in Super Admin → Providers → Email.');
  }

  let res: Response;
  try {
    res = await fetch(`${API}/emails`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: formatMailbox(message.from),
        to: [message.to],
        subject: message.subject,
        html: message.html || undefined,
        text: message.text,
        reply_to: message.replyTo ? [message.replyTo] : undefined,
        headers: message.headers,
        tags: message.category ? [{ name: 'category', value: message.category }] : undefined,
      }),
      signal: timeoutSignal(),
    });
  } catch (err) {
    return fetchFailure('resend', err, [apiKey]);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return httpFailure('resend', res.status, body, [apiKey]);
  }

  const data: unknown = await res.json().catch(() => null);
  if (!isResendSendResponse(data)) {
    return emailFailure('resend', 'provider_error', 'Resend returned an unexpected response shape');
  }
  return { success: true, id: data.id, provider: 'resend' };
}

interface ResendDomain {
  name?: string;
  status?: string;
}

/**
 * An authenticated read: the account's domains. That proves the key, and
 * it shows the one fault a key check alone misses, the one RESPOK's mail
 * failed on in October 2026 (403 on every send): a From domain Resend has not
 * verified. A key restricted to sending cannot list domains; Resend answers
 * that with `restricted_api_key`, which still proves the key is real.
 */
async function verifyResend(config: ProviderConfig): Promise<EmailProviderVerifyResult> {
  const apiKey = configText(config.config, 'api_key');
  if (!apiKey) return { ok: false, detail: 'unconfigured: the Resend API key is not configured' };
  let res: Response;
  try {
    res = await fetch(`${API}/domains`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: timeoutSignal(),
    });
  } catch (err) {
    return { ok: false, detail: fetchFailure('resend', err, [apiKey]).error ?? 'connection: Resend could not be reached' };
  }
  const body = await res.text().catch(() => '');
  if (!res.ok) {
    if (res.status === 401 && /restricted_api_key/.test(body)) {
      return { ok: true, detail: 'the key is accepted; it may only send, so the sending domain was not checked' };
    }
    return { ok: false, detail: httpFailure('resend', res.status, body, [apiKey]).error ?? `auth: HTTP ${res.status}` };
  }
  let domains: ResendDomain[] | null = null;
  try {
    const parsed = JSON.parse(body) as { data?: ResendDomain[] };
    domains = Array.isArray(parsed?.data) ? parsed.data : null;
  } catch {
    /* an unreadable list proves the key all the same */
  }
  if (!domains) return { ok: true, detail: 'the key is accepted; the domain list could not be read' };
  const fromDomain = configText(config.config, 'from_email').split('@')[1]?.toLowerCase() ?? '';
  const domain = domains.find((d) => String(d.name ?? '').toLowerCase() === fromDomain);
  if (fromDomain && !domain) return { ok: false, detail: `rejected: the sending domain ${fromDomain} is not on this Resend account` };
  if (domain && domain.status !== 'verified') {
    return { ok: false, detail: `rejected: the sending domain ${fromDomain} is not verified at Resend (status: ${String(domain.status ?? 'unknown')})` };
  }
  return { ok: true, detail: `the key is accepted and ${fromDomain || 'the sending domain'} is verified` };
}

export const resendAdapter: EmailAdapter = {
  name: 'resend',
  send: sendViaResend,
  verify: verifyResend,
};
