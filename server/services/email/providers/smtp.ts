// SMTP email provider — self-hosted server runtime only
// Uses nodemailer for real SMTP transport.

import nodemailer from 'nodemailer';
import type { ProviderConfig, SendResult } from '../index.js';

export async function sendViaSMTP(
  config: ProviderConfig,
  to: string,
  subject: string,
  html: string,
  text: string,
  from: string
): Promise<SendResult> {
  const cfg = config.config as Record<string, string>;

  const host = cfg.smtp_host || process.env.SMTP_HOST;
  const port = parseInt(cfg.smtp_port || process.env.SMTP_PORT || '587', 10);
  const user = cfg.smtp_user || cfg.smtp_username || process.env.SMTP_USER;
  const pass = cfg.smtp_pass || cfg.smtp_password || process.env.SMTP_PASS;
  const secure = cfg.encryption === 'ssl' || port === 465;

  if (!host) {
    return { success: false, provider: 'smtp', error: 'SMTP host not configured. Set SMTP_HOST env var or configure via admin UI.' };
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user ? { user, pass } : undefined,
      tls: { rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false' },
    });

    const info = await transporter.sendMail({
      from,
      to,
      subject,
      html,
      text: text || undefined,
    });

    return {
      success: true,
      id: info.messageId || `smtp-${Date.now()}`,
      provider: 'smtp',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, provider: 'smtp', error: `SMTP error: ${message}` };
  }
}
