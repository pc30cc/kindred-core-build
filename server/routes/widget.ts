import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getServiceClient } from '../supabase.js';
import type { ServerConfig } from '../config.js';
import { isOriginAllowed, isTrustedPreviewOrigin } from '../utils/domain.js';

export const widgetRouter = Router();

function normalizeBaseUrl(value?: string | null) {
  if (!value) return '';
  return value.replace(/\/widget\/?$/i, '').replace(/\/+$/, '');
}

function getRequestBaseUrl(req: Request) {
  const forwardedProtoHeader = req.headers['x-forwarded-proto'];
  const forwardedHostHeader = req.headers['x-forwarded-host'];

  const forwardedProto = Array.isArray(forwardedProtoHeader)
    ? forwardedProtoHeader[0]
    : forwardedProtoHeader?.toString().split(',')[0]?.trim();

  const forwardedHost = Array.isArray(forwardedHostHeader)
    ? forwardedHostHeader[0]
    : forwardedHostHeader?.toString().split(',')[0]?.trim();

  const protocol = forwardedProto || req.protocol || 'https';
  const host = forwardedHost || req.get('host') || '';

  return host ? `${protocol}://${host}` : '';
}

function getDefaultWidgetAssetBaseUrl(req: Request) {
  const requestBaseUrl = getRequestBaseUrl(req);
  if (!requestBaseUrl) return '';

  try {
    const url = new URL(requestBaseUrl);

    if (url.hostname.toLowerCase().startsWith('api.')) {
      url.hostname = url.hostname.slice(4);
    }

    return url.toString().replace(/\/+$/, '');
  } catch {
    return requestBaseUrl;
  }
}

// ============================================
// GET /api/widget/config
// Widget bootstrap endpoint — server-validated
// ============================================
const configQuerySchema = z.object({
  workspace_id: z.string().uuid(),
  origin: z.string().url().optional(),
});

widgetRouter.get('/config', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = configQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid parameters', details: parsed.error.flatten().fieldErrors });
  }

  const { workspace_id, origin } = parsed.data;
  const supabase = getServiceClient(config);

  try {
    const { data: widget, error } = await supabase
      .from('widget_settings')
      .select('*')
      .eq('workspace_id', workspace_id)
      .single();

    if (error || !widget) {
      return res.status(404).json({ error: 'Widget not found or not configured' });
    }

    if (!widget.enabled) {
      return res.json({ enabled: false });
    }

    if (origin && widget.allowed_domains && widget.allowed_domains.length > 0) {
      if (!isTrustedPreviewOrigin(origin) && !isOriginAllowed(origin, widget.allowed_domains, widget.allow_subdomains ?? false)) {
        return res.status(403).json({ error: 'Origin not allowed' });
      }
    }

    const { data: branding } = await supabase
      .from('workspace_branding')
      .select('platform_name, logo_url, primary_color, widget_base_url')
      .eq('workspace_id', workspace_id)
      .single();

    const assetBaseUrl = normalizeBaseUrl(branding?.widget_base_url) || getDefaultWidgetAssetBaseUrl(req);

    const widgetConfig = {
      enabled: true,
      workspaceId: workspace_id,
      branding: {
        platformName: branding?.platform_name || 'Support',
        primaryColor: widget.primary_color || branding?.primary_color || '#3B82F6',
        secondaryColor: widget.secondary_color || '#6366f1',
        logoUrl: widget.logo_url || branding?.logo_url || null,
        launcherText: widget.launcher_text || 'Chat with us',
        welcomeMessage: widget.welcome_message || 'Hello! How can we help you?',
        greetingMessage: widget.greeting_message || '',
        placeholderText: widget.placeholder_text || '',
        offlineMessage: widget.offline_message || '',
      },
      position: widget.position || 'bottom-right',
      locale: widget.locale || 'en',
      theme: {
        id: widget.theme || 'modern',
        fabIcon: widget.fab_icon || 'chat',
        fabShape: widget.fab_shape || 'circle',
        fabLabel: widget.fab_label || '',
        fabScale: widget.fab_scale ?? 100,
        fabIconColor: widget.fab_icon_color || '#ffffff',
        fabTextColor: widget.fab_text_color || '#ffffff',
        fabAnimation: widget.fab_animation !== false,
        fabHelpIcon: widget.fab_help_icon || 'help_circle',
        fabChatLabel: widget.fab_chat_label || '',
        fabHelpLabel: widget.fab_help_label || '',
        showLogo: widget.show_logo !== false,
        autoOpenDelay: widget.auto_open_delay ?? 0,
        defaultMode: widget.default_mode || 'chat',
        supportMode: widget.support_mode || 'human_first',
        widgetLanguage: widget.widget_language || 'auto',
        mobileBehavior: widget.mobile_behavior || 'bottom_sheet',
      },
      features: {
        chat: widget.chat_enabled ?? true,
        knowledgeBase: widget.kb_enabled ?? true,
        visitorTracking: widget.visitor_tracking_enabled ?? true,
      },
      runtimeUrl: assetBaseUrl ? `${assetBaseUrl}/widget/runtime.js` : null,
      styleUrl: assetBaseUrl ? `${assetBaseUrl}/widget/widget.css` : null,
    };

    res.json(widgetConfig);
  } catch (err) {
    console.error('Widget config error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ============================================
// POST /api/widget/validate-origin
// Server-side origin validation
// ============================================
const validateOriginSchema = z.object({
  workspace_id: z.string().uuid(),
  origin: z.string().url(),
});

widgetRouter.post('/validate-origin', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = validateOriginSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  const { workspace_id, origin } = parsed.data;
  const supabase = getServiceClient(config);

  const { data: widget } = await supabase
    .from('widget_settings')
    .select('allowed_domains, allow_subdomains, enabled')
    .eq('workspace_id', workspace_id)
    .single();

  if (!widget || !widget.enabled) {
    return res.json({ valid: false, reason: 'widget_disabled' });
  }

  if (!widget.allowed_domains || widget.allowed_domains.length === 0) {
    return res.json({ valid: true });
  }

  if (isTrustedPreviewOrigin(origin)) {
    return res.json({ valid: true, reason: 'trusted_preview' });
  }

  const allowed = isOriginAllowed(origin, widget.allowed_domains, widget.allow_subdomains ?? false);
  res.json({ valid: allowed, reason: allowed ? null : 'origin_not_allowed' });
});
