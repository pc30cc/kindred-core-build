// ============================================
// EMAIL PROVIDER REGISTRY
// ============================================
//
// The one place that maps a provider name to the code that sends through
// it. sendEmail, sendPlatformEmail, readiness and the provider config store
// all dispatch through here, so a provider is either here (and works the
// same for every one of them) or nowhere. The names, their fields and which
// are secrets live in shared/emailProviders.ts; this file adds only the code.

import {
  EMAIL_PROVIDER_ADAPTERS,
  canonicalEmailProviderConfig,
  emailProviderConfigProblems,
  isEmailProviderAdapter,
  withEmailProviderEnvFallbacks,
  type EmailProviderAdapter,
  type EmailProviderConfigProblem,
} from '../../../../shared/emailProviders.js';
import { resendAdapter } from './resend.js';
import { sendgridAdapter } from './sendgrid.js';
import { smtpAdapter } from './smtp.js';
import type { EmailAdapter, ProviderConfig } from './types.js';

const ADAPTERS: Record<EmailProviderAdapter, EmailAdapter> = {
  resend: resendAdapter,
  sendgrid: sendgridAdapter,
  smtp: smtpAdapter,
};

export { EMAIL_PROVIDER_ADAPTERS };

/** The adapter for a provider name, or null when this server has none by that name. */
export function getEmailAdapter(name: string | null | undefined): EmailAdapter | null {
  const key = String(name ?? '').trim().toLowerCase();
  return isEmailProviderAdapter(key) ? ADAPTERS[key] : null;
}

/**
 * The config a send reads: today's field names (older rows' aliases folded
 * in), then an environment variable for any field the database left blank.
 * The database always wins.
 */
export function effectiveEmailProviderConfig(
  provider: ProviderConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProviderConfig {
  const canonical = canonicalEmailProviderConfig(provider.provider_name, provider.config);
  return { provider_name: provider.provider_name, config: withEmailProviderEnvFallbacks(provider.provider_name, canonical, env) };
}

/** What stops this provider from sending (none when it can); an unknown name is one problem. */
export function emailProviderProblems(
  provider: ProviderConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): EmailProviderConfigProblem[] {
  const canonical = canonicalEmailProviderConfig(provider.provider_name, provider.config);
  return emailProviderConfigProblems(provider.provider_name, canonical, env);
}

/**
 * The readiness of a stored provider, the same reading for the Super Admin's
 * readiness page and for isEmailProviderConfigured: `configured` only for a
 * provider this server has an adapter for, with its required fields and a
 * valid from_email.
 */
export function emailProviderReadiness(
  provider: ProviderConfig | null,
  env: Readonly<Record<string, string | undefined>> = process.env,
): 'unconfigured' | 'configured' | 'invalid' {
  if (!provider) return 'unconfigured';
  if (!getEmailAdapter(provider.provider_name)) return 'invalid';
  return emailProviderProblems(provider, env).length === 0 ? 'configured' : 'invalid';
}

/** Words for a field in a reason ("the email provider has no API key (api_key)"). */
const FIELD_LABELS: Record<string, string> = {
  from_email: 'sender address',
  reply_to: 'reply-to address',
  from_name: 'sender name',
  api_key: 'API key',
  smtp_host: 'SMTP host',
  smtp_port: 'SMTP port',
  smtp_pass: 'SMTP password',
  encryption: 'SMTP encryption',
  tls_servername: 'TLS server name',
  tls_ca: 'TLS CA certificate',
};

/** A short, value-free sentence for the first thing that stops a provider. */
export function describeEmailProviderProblem(problem: EmailProviderConfigProblem): string {
  if (problem.field === 'provider_name') return 'the email provider has no adapter on this server';
  const label = FIELD_LABELS[problem.field] ? `${FIELD_LABELS[problem.field]} (${problem.field})` : problem.field;
  return problem.problem === 'missing'
    ? `the email provider has no ${label}. Set it in Super Admin → Providers → Email.`
    : `the email provider's ${label} is not valid. Fix it in Super Admin → Providers → Email.`;
}
