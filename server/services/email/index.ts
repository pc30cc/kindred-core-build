// ============================================
// SELF-HOSTED EMAIL SERVICE
// All email delivery runs through the server runtime.
// No Supabase Edge Functions in the production email path.
// ============================================

import type { ServerConfig } from '../../config.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { sendViaResend } from './providers/resend.js';
import { sendViaSendGrid } from './providers/sendgrid.js';
import { sendViaSMTP } from './providers/smtp.js';

export interface EmailRequest {
  workspaceId: string;
  to: string;
  subject?: string;
  html?: string;
  text?: string;
  from?: string;
  replyTo?: string;
  templateSlug?: string;
  templateData?: Record<string, string>;
  locale?: string;
}

export interface ProviderConfig {
  provider_name: string;
  config: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeProviderConfig(value: unknown): ProviderConfig | null {
  const row = asRecord(value);
  const providerName = String(row.provider_name || row.provider || '').trim().toLowerCase();
  if (!providerName || providerName === 'disabled') return null;
  return {
    provider_name: providerName,
    config: { ...asRecord(row.config), ...asRecord(row.secrets) },
  };
}

export interface SendResult {
  success: boolean;
  id?: string;
  provider: string;
  error?: string;
}

/**
 * Resolve which email provider to use.
 *
 * PLATFORM ONLY, and that is the whole point. There is exactly one email
 * transport and the platform admin owns it:
 * `app_runtime_config.default_email_provider`, written by
 * Super Admin → Providers → Communication → Email.
 *
 * This used to resolve workspace-first —
 * `workspace_provider_settings` → `provider_configs` → platform — which meant
 * a workspace admin could point the platform's own password resets,
 * verification codes and invitations at their own Resend account by saving a
 * provider in Settings → Providers. Email transport is platform
 * infrastructure, not a per-tenant setting, so there is no workspace lookup
 * here at all any more.
 *
 * A workspace id is still passed around this module for entitlement checks,
 * templates, recipients and `email_logs` — it just no longer selects the
 * infrastructure.
 */
async function resolveProviderConfig(supabase: SupabaseClient): Promise<ProviderConfig | null> {
  const { data, error } = await supabase
    .from('app_runtime_config')
    .select('value')
    .eq('key', 'default_email_provider')
    .maybeSingle();
  if (error) console.warn('[email] platform provider lookup failed:', error.message);
  return normalizeProviderConfig((data as { value?: unknown } | null)?.value);
}

/**
 * The From header, fail-closed.
 *
 * Transport identity (who the mail is *from*) comes from the provider config
 * and nowhere else. Brand identity (the `{brand}` a template prints) comes
 * from platform branding. They are different things and this is the seam.
 *
 * There is no invented address. `noreply@example.com` used to stand in for a
 * missing `from_email`, which meant a half-configured provider silently sent
 * mail that every receiver rejected — a failure that looked like a delivery
 * problem for as long as nobody read the logs. A missing `from_email` is a
 * configuration error and says so.
 *
 * `from_name` is the one part that may fall back: the provider config still
 * owns it, but a blank one becomes the platform's own brand name, which is
 * the same name the template body already prints.
 */
async function resolveFromAddress(
  supabase: SupabaseClient,
  provider: ProviderConfig,
  locale: string,
): Promise<{ from: string; error?: undefined } | { from?: undefined; error: string }> {
  const cfg = provider.config as Record<string, unknown>;
  const email = String(cfg.from_email ?? '').trim();
  if (!email) {
    return {
      error:
        `Email provider "${provider.provider_name}" has no from_email configured. ` +
        'Set it in Super Admin → Providers → Email.',
    };
  }
  const name = String(cfg.from_name ?? '').trim() || (await resolveBrandName(supabase, locale));
  return { from: `${name} <${email}>` };
}

/**
 * Resolve email template by slug + locale.
 * Templates are always global (workspace_id IS NULL).
 * Fallback: requested locale → 'en'.
 */
async function resolveTemplate(
  supabase: SupabaseClient,
  _workspaceId: string,
  slug: string,
  locale: string
): Promise<{ subject: string; html_body: string; text_body: string | null } | null> {
  const { data: template } = await supabase
    .from('email_templates')
    .select('subject, html_body, text_body')
    .is('workspace_id', null)
    .eq('slug', slug)
    .eq('locale', locale)
    .eq('is_active', true)
    .maybeSingle();

  if (template) return template;

  if (locale !== 'en') {
    const { data: fallback } = await supabase
      .from('email_templates')
      .select('subject, html_body, text_body')
      .is('workspace_id', null)
      .eq('slug', slug)
      .eq('locale', 'en')
      .eq('is_active', true)
      .maybeSingle();
    return fallback;
  }

  return null;
}

/**
 * Interpolate {{key}} variables in a string.
 */
function interpolate(text: string, data: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(data)) {
    // Support both {key} and {{key}} patterns
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return result;
}

/**
 * Platform brand name for a locale, used to brand every template that
 * references {brand}. Falls back: locale → en → 'Platform'.
 */
async function resolveBrandName(supabase: SupabaseClient, locale: string): Promise<string> {
  const read = async (lc: string) => {
    const { data } = await supabase
      .from('platform_branding_localized')
      .select('platform_name')
      .eq('locale', lc)
      .maybeSingle();
    return (data?.platform_name || '').trim();
  };
  try {
    const primary = await read(locale);
    if (primary) return primary;
    if (locale !== 'en') {
      const fallback = await read('en');
      if (fallback) return fallback;
    }
    const { data } = await supabase
      .from('platform_branding')
      .select('platform_name')
      .limit(1)
      .maybeSingle();
    if (data?.platform_name) return String(data.platform_name).trim();
  } catch {
    /* branding is optional — never block delivery */
  }
  return 'Platform';
}

export interface PlatformEmailRequest {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  from?: string;
}

/**
 * Sends an email with NO workspace binding — for future pre-account flows
 * (signup-email-verification, password-reset, email-change) that have no
 * workspace to scope a provider or a log row against. Dormant: nothing in
 * this codebase calls this yet (see
 * docs/GENERIC_VERIFICATION_CORE.md §Workspace-less email). Deliberately
 * does not write to `email_logs` — that table is workspace-scoped
 * delivery history, not applicable to a send with no workspace.
 */
export async function sendPlatformEmail(
  config: ServerConfig,
  request: PlatformEmailRequest,
): Promise<SendResult> {
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);

  const providerConfig = await resolveProviderConfig(supabase);
  const providerName = providerConfig?.provider_name || 'stub';

  let fromAddr = request.from || '';
  if (!fromAddr && providerConfig) {
    const resolved = await resolveFromAddress(supabase, providerConfig, 'en');
    if (resolved.error) return { success: false, provider: providerName, error: resolved.error };
    fromAddr = resolved.from;
  }

  switch (providerName) {
    case 'resend':
      return sendViaResend(providerConfig!, request.to, request.subject, request.html || '', request.text || '', fromAddr);
    case 'sendgrid':
      return sendViaSendGrid(providerConfig!, request.to, request.subject, request.html || '', request.text || '', fromAddr);
    case 'smtp':
      return sendViaSMTP(providerConfig!, request.to, request.subject, request.html || '', request.text || '', fromAddr);
    case 'stub':
      return { success: false, provider: 'stub', error: 'Email provider is not configured' };
    default:
      return { success: false, provider: providerName, error: `Unknown provider: ${providerName}` };
  }
}

/**
 * Main email sending function.
 * Resolves provider, template, and sends email.
 * Logs all delivery attempts to email_logs.
 */
export async function sendEmail(
  config: ServerConfig,
  request: EmailRequest
): Promise<SendResult> {
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);

  const { workspaceId, to, templateSlug, templateData, locale } = request;

  if (!workspaceId || !to) {
    return { success: false, provider: 'none', error: 'workspaceId and to are required' };
  }

  // --- Resolve provider config ---
  const providerConfig = await resolveProviderConfig(supabase);
  const providerName = providerConfig?.provider_name || 'stub';

  // --- Resolve template if slug provided ---
  let subject = request.subject || '';
  let html = request.html || '';
  let text = request.text || '';
  let fromAddr = request.from || '';

  if (templateSlug) {
    const tplLocale = locale || 'en';
    const tpl = await resolveTemplate(supabase, workspaceId, templateSlug, tplLocale);
    if (tpl) {
      subject = tpl.subject;
      html = tpl.html_body;
      text = tpl.text_body || '';
      // Branding defaults so every template renders {brand}/{year} correctly,
      // while explicit templateData always wins.
      const data: Record<string, string> = {
        brand: await resolveBrandName(supabase, tplLocale),
        year: String(new Date().getFullYear()),
        ...(templateData || {}),
      };
      subject = interpolate(subject, data);
      html = interpolate(html, data);
      text = interpolate(text, data);
    }
  }

  if (!subject && !html) {
    return { success: false, provider: providerName, error: 'No subject/body provided and template not found' };
  }

  // --- Resolve from address ---
  if (!fromAddr && providerConfig) {
    const resolved = await resolveFromAddress(supabase, providerConfig, locale || 'en');
    if (resolved.error) return { success: false, provider: providerName, error: resolved.error };
    fromAddr = resolved.from;
  }

  // --- Send via resolved provider ---
  let result: SendResult;

  switch (providerName) {
    case 'resend':
      result = await sendViaResend(providerConfig!, to, subject, html, text, fromAddr);
      break;
    case 'sendgrid':
      result = await sendViaSendGrid(providerConfig!, to, subject, html, text, fromAddr);
      break;
    case 'smtp':
      result = await sendViaSMTP(providerConfig!, to, subject, html, text, fromAddr);
      break;
    case 'stub':
      // Never claim delivery when no provider is active. Invitation/OTP
      // workers use this result to fail closed and keep their delivery state
      // truthful instead of reporting a message that was never sent.
      result = { success: false, provider: 'stub', error: 'Email provider is not configured' };
      break;
    default:
      result = { success: false, provider: providerName, error: `Unknown provider: ${providerName}` };
  }

  // --- Log delivery attempt ---
  await supabase.from('email_logs').insert({
    workspace_id: workspaceId,
    template_slug: templateSlug || null,
    recipient_email: to,
    subject,
    status: result.success ? 'sent' : 'failed',
    provider_name: providerName,
    error_message: result.error || null,
    metadata: { templateData, messageId: result.id },
    sent_at: result.success ? new Date().toISOString() : null,
  });

  return result;
}
