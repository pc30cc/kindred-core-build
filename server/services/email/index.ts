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

/**
 * What a caller may ask this service to send.
 *
 * There is no `from` and no `replyTo`, and their absence is the rule rather
 * than an oversight. Transport identity — who the mail is from — belongs to
 * the platform email provider and to nothing else, so a caller cannot supply
 * it and therefore cannot pass one through from a request body. That is
 * exactly what happened: `POST /api/email/send-channel` read `from` off the
 * JSON it was handed and passed it straight down, so any workspace with the
 * email channel could send as any address it liked through the platform's own
 * Resend account.
 *
 * Closing the route alone would not have been enough. The rule has to live
 * here, in the service, or the next caller re-opens it.
 *
 * `replyTo` went for a different reason: it was accepted, typed and threaded
 * all the way down — then dropped, because not one of the three providers ever
 * put it in a payload. It is also not the same thing as
 * `email_settings.reply_to_email`, which is a notification RECIPIENT, not a
 * `Reply-To` header.
 */
export interface EmailRequest {
  workspaceId: string;
  to: string;
  subject?: string;
  html?: string;
  text?: string;
  templateSlug?: string;
  templateData?: Record<string, string>;
  locale?: string;
  /**
   * Send through a provider chosen for this KIND of mail rather than the
   * platform default.
   *
   * There is one default transport and the platform admin owns it. This is
   * the one deliberate exception: Super Admin → Notifications may point the
   * operator notification emails — digests, transcripts, announcements — at
   * a second configured provider, so a burst of them cannot cost a platform
   * the reputation its password resets and verification codes depend on.
   * The key names an `app_runtime_config` row holding the same shape as
   * `default_email_provider`; anything missing or disabled falls back to the
   * default rather than failing, because the mail matters more than which
   * wire it went down.
   */
  providerConfigKey?: string;
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
async function resolveProviderConfig(
  supabase: SupabaseClient,
  overrideKey?: string,
): Promise<ProviderConfig | null> {
  if (overrideKey && overrideKey !== 'default_email_provider') {
    const { data, error } = await supabase
      .from('app_runtime_config')
      .select('value')
      .eq('key', overrideKey)
      .maybeSingle();
    if (error) console.warn('[email] override provider lookup failed:', error.message);
    const override = normalizeProviderConfig((data as { value?: unknown } | null)?.value);
    // A named-but-unconfigured override falls through to the default. The
    // alternative is a silent stop on mail somebody asked for, because an
    // admin picked a provider and never filled in its key.
    if (override) return override;
  }

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
    // No third tier: platform_name only exists on platform_branding_localized
    // now, so the old platform_branding fallback that used to sit here was
    // dead code that returned 400 on every miss.
  } catch {
    /* branding is optional — never block delivery */
  }
  return 'Platform';
}

/** Same rule as EmailRequest: the platform provider owns the From header. */
export interface PlatformEmailRequest {
  to: string;
  subject: string;
  html?: string;
  text?: string;
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

  let fromAddr = '';
  if (providerConfig) {
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
  const providerConfig = await resolveProviderConfig(supabase, request.providerConfigKey);
  const providerName = providerConfig?.provider_name || 'stub';

  // --- Resolve template if slug provided ---
  let subject = request.subject || '';
  let html = request.html || '';
  let text = request.text || '';
  let fromAddr = '';

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
  if (providerConfig) {
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
  // DELIVERY_DIAGNOSTICS_LOGGING — the single writer of email_logs (platform
  // -level email at line ~213 deliberately never writes here). This row is
  // the only evidence that a transactional email was actually handed to a
  // provider; the send itself, and the SendResult every caller branches on,
  // are already decided above and are unaffected either way.
  if (config.deliveryDiagnosticsLoggingEnabled !== false) {
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
  }

  return result;
}
