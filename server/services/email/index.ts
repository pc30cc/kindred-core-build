// ============================================
// SELF-HOSTED EMAIL SERVICE
// All email delivery runs through the server runtime.
// No Supabase Edge Functions in the production email path.
// ============================================

import type { ServerConfig } from '../../config.js';
import { type SupabaseClient } from '@supabase/supabase-js';
import { serviceClientFor } from '../../lib/serviceClient.js';
import { sendViaResend } from './providers/resend.js';
import { sendViaSendGrid } from './providers/sendgrid.js';
import { sendViaSMTP } from './providers/smtp.js';
import { buildEmailLogMetadata } from './redactLogMetadata.js';
import { getPlatformAllowedLocales, getPlatformEditionOrNull } from '../platformRegion.js';
import type { Edition } from '../../../shared/edition.js';
import { IRAN_BRAND, brandContactFromDomains } from '../../../shared/brand.js';

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
  /**
   * The tenant this mail belongs to, or `null` for PLATFORM mail (password
   * reset, email verification — anything sent to a person rather than on a
   * workspace's behalf). Platform mail is never attributed to a workspace:
   * `email_logs` is readable by that workspace's admins, so a platform send
   * pinned to an arbitrary tenant leaked reset links to strangers. A `null`
   * workspace writes no `email_logs` row (the table is workspace-scoped and
   * `workspace_id` is NOT NULL).
   */
  workspaceId: string | null;
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
 * Which edition's templates to send, and in which language.
 *
 * Templates are Super Admin rows kept per edition (migration 260): the
 * Iranian edition's and the International edition's never mix, so a region
 * switch can never send one brand's mail to the other's customers. The
 * language is clamped to the languages this platform offers (Iran: Persian
 * only), the ones Super Admin can edit; the first of them stands in for a
 * language the platform does not offer.
 */
export async function resolveEmailScope(
  config: ServerConfig,
  locale: string | undefined,
): Promise<{ edition: Edition; locales: string[] } | null> {
  const edition = await getPlatformEditionOrNull(config);
  if (!edition) return null;
  const allowed = await getPlatformAllowedLocales(config).catch(() => ['en', 'fa', 'tr']);
  const requested = String(locale || '').toLowerCase().split('-')[0];
  const primary = requested && allowed.includes(requested) ? requested : allowed[0] || 'en';
  const locales = [...new Set([primary, allowed[0] || 'en', 'en'])];
  return { edition, locales };
}

/**
 * Resolve email template by slug, within ONE edition, trying each locale in
 * order (see resolveEmailScope). Templates are always global
 * (workspace_id IS NULL). Never falls back to the other edition.
 */
async function resolveTemplate(
  supabase: SupabaseClient,
  edition: Edition,
  slug: string,
  locales: string[],
): Promise<{ subject: string; html_body: string; text_body: string | null; locale: string } | null> {
  for (const locale of locales) {
    const { data: template } = await supabase
      .from('email_templates')
      .select('subject, html_body, text_body')
      .is('workspace_id', null)
      .eq('edition', edition)
      .eq('slug', slug)
      .eq('locale', locale)
      .eq('is_active', true)
      .maybeSingle();
    if (template) return { ...(template as { subject: string; html_body: string; text_body: string | null }), locale };
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

/**
 * The platform's support address for {support_email}, per edition
 * (shared/brand.ts): the Iranian edition's fixed address, else
 * support@<the platform's own site host> from platform_domains. Empty when
 * unknown — never an address made from the recipient's own domain.
 */
async function resolveSupportEmail(supabase: SupabaseClient, edition: Edition): Promise<string> {
  if (edition === 'iran') return IRAN_BRAND.supportEmail;
  try {
    const { data } = await supabase
      .from('platform_domains')
      .select('primary_domain, canonical_base_url, public_base_url')
      .limit(1)
      .maybeSingle();
    return brandContactFromDomains(data as Record<string, unknown> | null).support_email || '';
  } catch {
    return '';
  }
}

type RenderedTemplate =
  | { status: 'ok'; subject: string; html: string; text: string; locale: string }
  | { status: 'missing' }
  | { status: 'edition_unavailable' };

/**
 * The running edition's Super Admin template for `slug`, filled in. Branding
 * defaults ({brand}, {year}, {support_email}) are added so every template
 * renders them, while the caller's templateData always wins.
 */
async function renderEditionTemplate(
  config: ServerConfig,
  supabase: SupabaseClient,
  slug: string,
  templateData: Record<string, string> | undefined,
  locale: string | undefined,
): Promise<RenderedTemplate> {
  const scope = await resolveEmailScope(config, locale);
  if (!scope) return { status: 'edition_unavailable' };
  const tpl = await resolveTemplate(supabase, scope.edition, slug, scope.locales);
  if (!tpl) return { status: 'missing' };
  const data: Record<string, string> = {
    brand: await resolveBrandName(supabase, tpl.locale),
    year: String(new Date().getFullYear()),
    support_email: await resolveSupportEmail(supabase, scope.edition),
    ...(templateData || {}),
  };
  return {
    status: 'ok',
    subject: interpolate(tpl.subject, data),
    html: interpolate(tpl.html_body, data),
    text: interpolate(tpl.text_body || '', data),
    locale: tpl.locale,
  };
}

/** Same rule as EmailRequest: the platform provider owns the From header. */
export interface PlatformEmailRequest {
  to: string;
  /** The text sent when the template is missing (or no template is named). */
  subject: string;
  html?: string;
  text?: string;
  /** The running edition's Super Admin template to send, as in EmailRequest. */
  templateSlug?: string;
  templateData?: Record<string, string>;
  locale?: string;
}

/**
 * Sends an email with NO workspace binding — the pre-account flows
 * (the e-mail verification code of sign-up, e-mail change, order lookup)
 * that have no workspace to scope a provider or a log row against; see
 * docs/GENERIC_VERIFICATION_CORE.md §Workspace-less email. Only the
 * platform-default provider is used. With a templateSlug, the running
 * edition's Super Admin template is sent (the request's own text only when
 * it is missing). Deliberately does not write to `email_logs` — that table
 * is workspace-scoped delivery history, not applicable to a send with no
 * workspace.
 */
export async function sendPlatformEmail(
  config: ServerConfig,
  request: PlatformEmailRequest,
): Promise<SendResult> {
  const supabase = serviceClientFor(config.supabaseUrl, config.supabaseServiceRoleKey);

  const providerConfig = await resolveProviderConfig(supabase);
  const providerName = providerConfig?.provider_name || 'stub';

  let subject = request.subject;
  let html = request.html || '';
  let text = request.text || '';
  let fromLocale = 'en';
  if (request.templateSlug) {
    const rendered = await renderEditionTemplate(config, supabase, request.templateSlug, request.templateData, request.locale);
    if (rendered.status === 'ok') {
      ({ subject, html, text } = rendered);
      fromLocale = rendered.locale;
    } else if (rendered.status === 'edition_unavailable' && !subject && !html) {
      return { success: false, provider: providerName, error: 'EDITION_UNAVAILABLE' };
    }
  }

  let fromAddr = '';
  if (providerConfig) {
    const resolved = await resolveFromAddress(supabase, providerConfig, fromLocale);
    if (resolved.error) return { success: false, provider: providerName, error: resolved.error };
    fromAddr = resolved.from;
  }

  switch (providerName) {
    case 'resend':
      return sendViaResend(providerConfig!, request.to, subject, html, text, fromAddr);
    case 'sendgrid':
      return sendViaSendGrid(providerConfig!, request.to, subject, html, text, fromAddr);
    case 'smtp':
      return sendViaSMTP(providerConfig!, request.to, subject, html, text, fromAddr);
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
  const supabase = serviceClientFor(config.supabaseUrl, config.supabaseServiceRoleKey);

  const { workspaceId, to, templateSlug, templateData, locale } = request;

  // `workspaceId === null` is an explicit platform send; an empty string or a
  // missing field is still a caller bug.
  if (workspaceId === undefined || workspaceId === '' || !to) {
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

  let tplLocale = locale || 'en';
  if (templateSlug) {
    const rendered = await renderEditionTemplate(config, supabase, templateSlug, templateData, locale);
    if (rendered.status === 'ok') {
      ({ subject, html, text } = rendered);
      tplLocale = rendered.locale;
    } else if (rendered.status === 'edition_unavailable' && !subject && !html) {
      // Which brand's text to send cannot be told: retry later rather than
      // guess. With the caller's own text, that text goes out instead.
      return { success: false, provider: providerName, error: 'EDITION_UNAVAILABLE' };
    }
  }

  if (!subject && !html) {
    return { success: false, provider: providerName, error: 'No subject/body provided and template not found' };
  }

  // --- Resolve from address ---
  if (providerConfig) {
    const resolved = await resolveFromAddress(supabase, providerConfig, tplLocale);
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
  //
  // Platform mail (workspaceId null) is never logged against a tenant, and
  // template data is redacted before it is persisted: it carries reset /
  // verify links with raw tokens, OTP codes and invite links, and this table
  // is readable by workspace admins.
  if (config.deliveryDiagnosticsLoggingEnabled !== false && workspaceId) {
    await supabase.from('email_logs').insert({
      workspace_id: workspaceId,
      template_slug: templateSlug || null,
      recipient_email: to,
      subject,
      status: result.success ? 'sent' : 'failed',
      provider_name: providerName,
      error_message: result.error || null,
      metadata: buildEmailLogMetadata(templateData, result.id),
      sent_at: result.success ? new Date().toISOString() : null,
    });
  }

  return result;
}
