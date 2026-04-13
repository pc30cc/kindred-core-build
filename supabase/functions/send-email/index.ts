// ============================================
// SEND-EMAIL EDGE FUNCTION
// Provider-driven email sending with Resend/SendGrid/SMTP support.
// Reads provider config from DB (workspace override → global default → stub).
// Logs all delivery attempts to email_logs.
// ============================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface SendEmailRequest {
  workspaceId: string
  to: string
  subject?: string
  html?: string
  text?: string
  from?: string
  replyTo?: string
  templateSlug?: string
  templateData?: Record<string, string>
  locale?: string
}

interface ProviderConfig {
  provider_name: string
  config: Record<string, unknown>
}

interface SendResult {
  success: boolean
  id?: string
  provider: string
  error?: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, serviceKey)

    const body: SendEmailRequest = await req.json()
    const { workspaceId, to, templateSlug, templateData, locale } = body

    if (!workspaceId || !to) {
      return jsonResponse({ error: 'workspaceId and to are required' }, 400)
    }

    // --- Resolve provider config ---
    const providerConfig = await resolveProviderConfig(supabase, workspaceId)
    const providerName = providerConfig?.provider_name || 'stub'

    // --- Resolve template if slug provided ---
    let subject = body.subject || ''
    let html = body.html || ''
    let text = body.text || ''
    let fromAddr = body.from || ''

    if (templateSlug) {
      const targetLocale = locale || 'en'
      // Try exact locale, then fallback to 'en'
      const { data: template } = await supabase
        .from('email_templates')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('slug', templateSlug)
        .eq('locale', targetLocale)
        .maybeSingle()

      const tpl = template || (targetLocale !== 'en'
        ? (await supabase
            .from('email_templates')
            .select('*')
            .eq('workspace_id', workspaceId)
            .eq('slug', templateSlug)
            .eq('locale', 'en')
            .maybeSingle()).data
        : null)

      if (tpl) {
        subject = tpl.subject
        html = tpl.html_body
        text = tpl.text_body || ''
        // Interpolate template variables
        if (templateData) {
          for (const [key, value] of Object.entries(templateData)) {
            const re = new RegExp(`\\{\\{${key}\\}\\}`, 'g')
            subject = subject.replace(re, value)
            html = html.replace(re, value)
            text = text.replace(re, value)
          }
        }
      }
    }

    if (!subject && !html) {
      return jsonResponse({ error: 'No subject/body provided and template not found' }, 400)
    }

    // --- Resolve from address ---
    if (!fromAddr && providerConfig?.config) {
      const cfg = providerConfig.config as Record<string, string>
      const name = cfg.from_name || 'Platform'
      const email = cfg.from_email || 'noreply@example.com'
      fromAddr = `${name} <${email}>`
    }

    // --- Send via resolved provider ---
    let result: SendResult

    switch (providerName) {
      case 'resend':
        result = await sendViaResend(providerConfig!, to, subject, html, text, fromAddr)
        break
      case 'sendgrid':
        result = await sendViaSendGrid(providerConfig!, to, subject, html, text, fromAddr)
        break
      case 'smtp':
        result = await sendViaSMTP(providerConfig!, to, subject, html, text, fromAddr)
        break
      case 'stub':
        console.log(`[send-email] STUB: Would send "${subject}" to ${to}`)
        result = { success: true, id: `stub-${crypto.randomUUID()}`, provider: 'stub' }
        break
      default:
        result = { success: false, provider: providerName, error: `Unknown provider: ${providerName}` }
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
    })

    return jsonResponse(result, result.success ? 200 : 500)
  } catch (e) {
    console.error('[send-email] Unhandled error:', e)
    return jsonResponse({ error: e.message }, 500)
  }
})

// --- Provider Config Resolution ---
async function resolveProviderConfig(
  supabase: ReturnType<typeof createClient>,
  workspaceId: string
): Promise<ProviderConfig | null> {
  // 1. Workspace-level override
  const { data: wsConfig } = await supabase
    .from('provider_configs')
    .select('provider_name, config')
    .eq('workspace_id', workspaceId)
    .eq('provider_type', 'email')
    .eq('is_active', true)
    .maybeSingle()

  if (wsConfig) return wsConfig as ProviderConfig

  // 2. Global default from app_runtime_config
  const { data: globalConfig } = await supabase
    .from('app_runtime_config')
    .select('value')
    .eq('key', 'default_email_provider')
    .maybeSingle()

  if (globalConfig?.value) return globalConfig.value as unknown as ProviderConfig

  return null
}

// --- Resend ---
async function sendViaResend(
  config: ProviderConfig, to: string, subject: string,
  html: string, text: string, from: string
): Promise<SendResult> {
  const apiKey = Deno.env.get('RESEND_API_KEY') || (config.config as Record<string, string>).api_key
  if (!apiKey) return { success: false, provider: 'resend', error: 'Resend API key not configured' }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, html, text: text || undefined }),
  })

  if (!res.ok) {
    const err = await res.text()
    return { success: false, provider: 'resend', error: `Resend ${res.status}: ${err}` }
  }

  const data = await res.json()
  return { success: true, id: data.id, provider: 'resend' }
}

// --- SendGrid ---
async function sendViaSendGrid(
  config: ProviderConfig, to: string, subject: string,
  html: string, text: string, from: string
): Promise<SendResult> {
  const apiKey = Deno.env.get('SENDGRID_API_KEY') || (config.config as Record<string, string>).api_key
  if (!apiKey) return { success: false, provider: 'sendgrid', error: 'SendGrid API key not configured' }

  // Parse from address
  const fromMatch = from.match(/^(.+?)\s*<(.+?)>$/)
  const fromEmail = fromMatch ? fromMatch[2] : from
  const fromName = fromMatch ? fromMatch[1].trim() : undefined

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: fromEmail, name: fromName },
      subject,
      content: [
        ...(text ? [{ type: 'text/plain', value: text }] : []),
        { type: 'text/html', value: html },
      ],
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    return { success: false, provider: 'sendgrid', error: `SendGrid ${res.status}: ${err}` }
  }

  const messageId = res.headers.get('x-message-id') || crypto.randomUUID()
  return { success: true, id: messageId, provider: 'sendgrid' }
}

// --- SMTP (via Deno net) ---
async function sendViaSMTP(
  config: ProviderConfig, to: string, subject: string,
  html: string, text: string, from: string
): Promise<SendResult> {
  // SMTP requires server-side libraries; for Deno edge functions we use
  // a lightweight HTTP-to-SMTP bridge approach or direct TCP.
  // For production, SMTP configs typically point to services with HTTP APIs.
  // This implementation uses a basic approach via fetch to an SMTP relay API.
  const cfg = config.config as Record<string, string>
  const host = cfg.smtp_host
  const port = cfg.smtp_port || '587'
  const user = cfg.smtp_user || Deno.env.get('SMTP_USER')
  const pass = cfg.smtp_pass || Deno.env.get('SMTP_PASS')

  if (!host) return { success: false, provider: 'smtp', error: 'SMTP host not configured' }

  // For edge functions, direct SMTP is limited. Log and return info.
  // In production self-hosted, the server/index.ts handles SMTP via nodemailer.
  console.warn(`[send-email] SMTP: host=${host}:${port}, to=${to}, subject=${subject}`)
  console.warn('[send-email] SMTP direct sending requires server-side runtime. Consider using Resend/SendGrid API or the self-hosted server.')

  return {
    success: false,
    provider: 'smtp',
    error: 'SMTP direct sending not available in edge functions. Use the self-hosted server runtime or switch to an API-based provider (Resend/SendGrid).',
  }
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
