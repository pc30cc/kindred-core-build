// SMTP email provider — self-hosted server runtime only
// Uses nodemailer for real SMTP transport.

import nodemailer from 'nodemailer';
import { SMTP_DEFAULT_PORT, pemCertificates, smtpEncryptionMode, type SmtpEncryptionMode } from '../../../../shared/emailProviders.js';
import {
  configSecret,
  configText,
  emailFailure,
  type EmailAdapter,
  type EmailProviderVerifyResult,
  type OutboundMessage,
  type ProviderConfig,
  type SendResult,
} from './types.js';

/**
 * How long one SMTP step may take. nodemailer's own defaults are 2 minutes
 * to connect, 30 s for the greeting and 10 minutes of silence on the socket,
 * and every send is awaited somewhere: inside a sign-up, a password reset, an
 * OTP request, the billing page, or one job of a serial queue. A relay that
 * accepts the connection and then stalls held all of them. With these, the
 * worst case is a little over half a minute, and it ends as a `timeout`,
 * which is transient (the outbox retries it).
 */
export const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
  dnsTimeout: 10_000,
} as const;

interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  pass: string;
  mode: SmtpEncryptionMode;
  options: Parameters<typeof nodemailer.createTransport>[0];
}

/**
 * The transport options a config asks for. `encryption` decides the TLS
 * behaviour (shared/emailProviders.ts): `starttls` refuses a server that
 * does not offer STARTTLS (nodemailer's requireTLS) instead of going on in
 * plain text as `auto` does; `none` never upgrades; `ssl` is implicit TLS.
 * `tls_servername` is the name the server's certificate is checked against,
 * for a relay reached by a service name its certificate does not carry
 * (`mail-relay`). `tls_ca` is the CA it is checked against instead of the
 * public ones, for a relay whose certificate a private CA signed: with
 * `starttls` or `ssl`, the connection is then encrypted and verified against
 * that CA and that name, so a container on the same network that answers as
 * the relay gets no password and no mail. SMTP_TLS_REJECT_UNAUTHORIZED=false
 * still turns the check off for every server, as before; the server name and
 * the CA are the narrower fix.
 */
function smtpSettings(config: ProviderConfig): SmtpSettings {
  const cfg = config.config;
  const host = configText(cfg, 'smtp_host');
  const port = Number.parseInt(configText(cfg, 'smtp_port') || String(SMTP_DEFAULT_PORT), 10);
  const user = configText(cfg, 'smtp_user');
  const pass = configSecret(cfg, 'smtp_pass');
  const mode = smtpEncryptionMode(cfg);
  const servername = configText(cfg, 'tls_servername');
  const ca = configText(cfg, 'tls_ca') ? pemCertificates(cfg.tls_ca) : null;
  return {
    host,
    port,
    user,
    pass,
    mode,
    options: {
      host,
      port,
      secure: mode === 'ssl',
      requireTLS: mode === 'starttls',
      ignoreTLS: mode === 'none',
      auth: user ? { user, pass } : undefined,
      ...SMTP_TIMEOUTS,
      tls: {
        rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false',
        ...(servername ? { servername } : {}),
        ...(ca ? { ca } : {}),
      },
      // The message is built from strings only; nothing in it may make the
      // library read a file or fetch a URL.
      disableFileAccess: true,
      disableUrlAccess: true,
    },
  };
}

interface SmtpError {
  code?: string;
  responseCode?: number;
  permanent?: boolean;
  message?: string;
}

/**
 * A nodemailer error as a SendResult. nodemailer 10.2 marks a reply-coded
 * error `permanent` (5xx but 503, RFC 5321); that wins where it is present.
 * The reason names the SMTP reply code at most; the server's text, which can
 * carry internal host names and addresses, goes to the console only.
 *
 * Two steps are told apart by their reply rather than by their name:
 *
 *   - Sign-in (EAUTH, ENOAUTH). A 5xx answer, or none (no AUTH offered, no
 *     password), is a configuration fault and permanent: retrying it only
 *     repeats the 535 (the invitation and OTP paths used to). A 4xx is the
 *     server's own "not now": Postfix's 454 while its SASL backend is down,
 *     a 421 while the relay restarts, Gmail's and Microsoft 365's 454 after
 *     too many sign-ins. Dropping a reset link or a receipt for that would
 *     be wrong, so it is transient and the outbox retries it.
 *   - STARTTLS (ETLS). A 5xx answer is the server refusing it ("502 5.5.1"
 *     from a relay that offers none, with encryption set to `starttls`): a
 *     configuration fault, said as such, so the Test button names it
 *     instead of "could not be reached". ETLS with no reply is a failed
 *     handshake or a dropped socket, transient as before.
 */
export function classifySmtpError(err: unknown, secrets: Array<unknown> = []): SendResult {
  const e = (err ?? {}) as SmtpError;
  const detail = `${e.code ?? 'Error'} ${e.message ?? String(err)}`;
  const code = typeof e.responseCode === 'number' ? e.responseCode : null;
  const reply = code !== null ? ` (${code})` : '';
  const opts = (permanent?: boolean) => ({ detail, secrets, ...(typeof permanent === 'boolean' ? { permanent } : {}) });
  const temporary = code !== null && code >= 400 && code < 500;

  switch (e.code) {
    case 'ETIMEDOUT':
      return emailFailure('smtp', 'timeout', 'the SMTP server did not answer in time', opts(false));
    case 'EAUTH':
    case 'ENOAUTH':
      if (code === 421) return emailFailure('smtp', 'connection', 'the SMTP server closed the connection during the sign-in (421)', opts(false));
      if (temporary) return emailFailure('smtp', 'auth', `the SMTP server cannot check the sign-in right now${reply}`, opts(false));
      return emailFailure('smtp', 'auth', `the SMTP server refused the sign-in${reply}`, opts(true));
    case 'ETLS':
      if (code !== null && code >= 500) {
        return emailFailure('smtp', 'connection', `the SMTP server refused STARTTLS${reply}; check the encryption setting`, opts(true));
      }
      return emailFailure('smtp', 'connection', `the TLS connection to the SMTP server could not be made${reply}`, opts(false));
    case 'ECONNECTION':
    case 'ESOCKET':
    case 'EDNS':
    case 'EPROXY':
      return emailFailure('smtp', 'connection', `the SMTP server could not be reached or the connection failed${reply}`, opts(false));
    default:
      break;
  }
  if (typeof e.responseCode === 'number') {
    if (e.responseCode === 421) {
      return emailFailure('smtp', 'connection', 'the SMTP server closed the connection (421)', opts(false));
    }
    const permanent = typeof e.permanent === 'boolean' ? e.permanent : e.responseCode >= 500 && e.responseCode !== 503;
    return emailFailure('smtp', 'rejected', `the SMTP server refused the message${reply}`, opts(permanent));
  }
  return emailFailure('smtp', 'provider_error', 'the SMTP send failed', opts(false));
}

/** Postfix answers the end of DATA with "250 2.0.0 Ok: queued as 4ABCD…". */
function queueIdFrom(response: unknown): string | undefined {
  const m = /queued as ([A-Za-z0-9]+)/i.exec(typeof response === 'string' ? response : '');
  return m ? m[1] : undefined;
}

async function sendViaSMTP(config: ProviderConfig, message: OutboundMessage): Promise<SendResult> {
  const smtp = smtpSettings(config);
  if (!smtp.host) {
    return emailFailure('smtp', 'unconfigured', 'the SMTP host is not configured. Set it in Super Admin → Providers → Email.');
  }

  const transporter = nodemailer.createTransport(smtp.options);
  try {
    const info = await transporter.sendMail({
      // An object, not "Name <address>": nodemailer quotes and encodes the
      // name itself, so a comma, a quote or Persian text in it stays a name.
      from: { name: message.from.name, address: message.from.address },
      to: message.to,
      subject: message.subject,
      ...(message.html ? { html: message.html } : {}),
      text: message.text,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      headers: message.headers,
    });
    const sent = info as { messageId?: string; serverMessageId?: string; response?: string };
    return {
      success: true,
      id: sent.messageId || `smtp-${Date.now()}`,
      provider: 'smtp',
      serverMessageId: sent.serverMessageId || queueIdFrom(sent.response),
    };
  } catch (err) {
    return classifySmtpError(err, [smtp.pass]);
  } finally {
    transporter.close();
  }
}

/**
 * Connects, upgrades as `encryption` says, and signs in, without sending:
 * nodemailer's verify(). A relay that answers but refuses the sign-in, a
 * certificate that does not match, or a server that does not offer the
 * STARTTLS this config requires all show here instead of on the next real
 * mail.
 */
async function verifySMTP(config: ProviderConfig): Promise<EmailProviderVerifyResult> {
  const smtp = smtpSettings(config);
  if (!smtp.host) return { ok: false, detail: 'unconfigured: the SMTP host is not configured' };
  const transporter = nodemailer.createTransport(smtp.options);
  try {
    await transporter.verify();
    const signedIn = smtp.user ? 'signed in' : 'connected (no sign-in configured)';
    const tls = smtp.mode === 'auto'
      ? 'encryption: auto (STARTTLS only when the server offers it; choose starttls to require it)'
      : `encryption: ${smtp.mode}`;
    return { ok: true, detail: `${signedIn} to ${smtp.host}:${smtp.port}; ${tls}` };
  } catch (err) {
    return { ok: false, detail: classifySmtpError(err, [smtp.pass]).error ?? 'provider_error: the check failed' };
  } finally {
    transporter.close();
  }
}

export const smtpAdapter: EmailAdapter = {
  name: 'smtp',
  send: sendViaSMTP,
  verify: verifySMTP,
};
