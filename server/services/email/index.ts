// ============================================
// SELF-HOSTED EMAIL SERVICE
// All email delivery runs through the server runtime.
// No hardcoded sender names or addresses.
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

export interface SendResult {
  success: boolean;
  id?: string;
  provider: string;
  error?: string;
}

async function resolveProviderConfig(
  supabase: ReturnType<typeof createClient>,
  workspaceId: string
): Promise<ProviderConfig | null> {
  const { data: wsConfig } = await supabase
    .from('provider_configs')
    .select('provider_name, config')
    .eq('workspace_id', workspaceId)
    .eq('provider_type', 'email')
    .eq('is_active', true)
    .maybeSingle();

  if (wsConfig) return wsConfig as ProviderConfig;

  const { data: globalConfig } = await supabase
    .from('app_runtime_config')
    .select('value')
    .eq('key', 'default_email_provider')
    .maybeSingle();

  if (globalConfig?.value) return globalConfig.value as unknown as ProviderConfig;

  return null;
}

async function resolveTemplate(
  supabase: ReturnType<typeof createClient>,
  workspaceId: string,
  slug: string,
  locale: string
): Promise<{ subject: string; html_body: string; text_body: string | null } | null> {
  const { data: template } = await supabase
    .from('email_templates')
    .select('subject, html_body, text_body')
    .eq('workspace_id', workspaceId)
    .eq('slug', slug)
    .eq('locale', locale)
    .maybeSingle();

  if (template) return template;

  if (locale !== 'en') {
    const { data: fallback } = await supabase
      .from('email_templates')
      .select('subject, html_body, text_body')
      .eq('workspace_id', workspaceId)
      .eq('slug', slug)
      .eq('locale', 'en')
      .maybeSingle();
    return fallback;
  }

  return null;
}

/**
 * Interpolate {{key}} and {{dotted.key}} variables in a string.
 */
function interpolate(text: string, data: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(data)) {
    result = result.replace(new RegExp(`\\{\\{${key.replace(/\./g, '\\.')}\\}\\}`, 'g'), value);
  }
  return result;
}

/**
 * Main email sending function.
 * Resolves provider, template, and sends email.
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

  const providerConfig = await resolveProviderConfig(supabase, workspaceId);
  const providerName = providerConfig?.provider_name || 'stub';

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

  // Resolve from address: use request.from (set by auth-sender with resolved config),
  // then provider config, then safe fallback
  if (!fromAddr && providerConfig?.config) {
    const cfg = providerConfig.config as Record<string, string>;
    const name = cfg.from_name || 'Platform';
    const email = cfg.from_email || 'noreply@example.com';
    fromAddr = `${name} <${email}>`;
  }

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
