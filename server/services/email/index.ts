// ============================================
// SELF-HOSTED EMAIL SERVICE
// All email delivery runs through the server runtime.
// No Supabase Edge Functions in the production email path.
// ============================================

import type { ServerConfig } from '../../config.js';
import { createClient } from '@supabase/supabase-js';
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
 * Priority: workspace override → global default → stub.
 */
async function resolveProviderConfig(
  supabase: any,
  workspaceId: string
): Promise<ProviderConfig | null> {
  // 1. Canonical workspace settings written by Settings → Providers.
  const { data: wsSetting, error: wsSettingError } = await supabase
    .from('workspace_provider_settings')
    .select('provider_name, config, secrets, enabled')
    .eq('workspace_id', workspaceId)
    .eq('provider_type', 'email')
    .eq('enabled', true)
    .maybeSingle();
  if (wsSettingError) {
    console.warn('[email] workspace provider lookup failed:', wsSettingError.message);
  }
  const activeWorkspaceProvider = normalizeProviderConfig(wsSetting);
  if (activeWorkspaceProvider) return activeWorkspaceProvider;

  // 2. Legacy provider registry compatibility.
  const { data: wsConfig, error: wsConfigError } = await supabase
    .from('provider_configs')
    .select('provider_name, config')
    .eq('workspace_id', workspaceId)
    .eq('provider_type', 'email')
    .eq('is_active', true)
    .maybeSingle();
  if (wsConfigError) console.warn('[email] legacy provider lookup failed:', wsConfigError.message);
  const legacyWorkspaceProvider = normalizeProviderConfig(wsConfig);
  if (legacyWorkspaceProvider) return legacyWorkspaceProvider;

  // 3. Platform default from app_runtime_config.
  const { data: globalConfig, error: globalConfigError } = await (supabase as any)
    .from('app_runtime_config')
    .select('value')
    .eq('key', 'default_email_provider')
    .maybeSingle();
  if (globalConfigError) console.warn('[email] platform provider lookup failed:', globalConfigError.message);
  const platformProvider = normalizeProviderConfig((globalConfig as any)?.value);
  if (platformProvider) return platformProvider;

  return null;
}

/**
 * Resolve email template by slug + locale.
 * Templates are always global (workspace_id IS NULL).
 * Fallback: requested locale → 'en'.
 */
async function resolveTemplate(
  supabase: any,
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
  const providerConfig = await resolveProviderConfig(supabase, workspaceId);
  const providerName = providerConfig?.provider_name || 'stub';

  // --- Resolve template if slug provided ---
  let subject = request.subject || '';
  let html = request.html || '';
  let text = request.text || '';
  let fromAddr = request.from || '';

  if (templateSlug) {
    const tpl = await resolveTemplate(supabase, workspaceId, templateSlug, locale || 'en');
    if (tpl) {
      subject = tpl.subject;
      html = tpl.html_body;
      text = tpl.text_body || '';
      if (templateData) {
        subject = interpolate(subject, templateData);
        html = interpolate(html, templateData);
        text = interpolate(text, templateData);
      }
    }
  }

  if (!subject && !html) {
    return { success: false, provider: providerName, error: 'No subject/body provided and template not found' };
  }

  // --- Resolve from address ---
  if (!fromAddr && providerConfig?.config) {
    const cfg = providerConfig.config as Record<string, string>;
    const name = cfg.from_name || cfg.sender_name || 'Platform';
    const email = cfg.from_email || cfg.sender_email || 'noreply@example.com';
    fromAddr = `${name} <${email}>`;
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
      console.log(`[email] STUB: Would send "${subject}" to ${to}`);
      result = { success: true, id: `stub-${Date.now()}`, provider: 'stub' };
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
