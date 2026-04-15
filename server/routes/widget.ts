import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getServiceClient } from '../supabase.js';
import type { ServerConfig } from '../config.js';
import {
  getLoaderAssetBase,
  getRequestBaseUrl,
  getRequestOrigin,
  getWorkspaceOriginRules,
  isWorkspaceOriginAllowed,
  resolveWidgetAssetBase,
  resolveWorkspaceIdFromOrigin,
} from '../services/widget/public.js';

export const widgetRouter = Router();

// ============================================
// GET /api/widget/config
// Widget bootstrap endpoint — server-validated
// ============================================
const configQuerySchema = z.object({
  workspace_id: z.string().uuid().optional(),
  origin: z.string().url(),
  loader_origin: z.string().url().optional(),
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
    const resolvedWorkspaceId = workspace_id || await resolveWorkspaceIdFromOrigin(config, origin);

    if (!resolvedWorkspaceId) {
      return res.status(404).json({ error: 'No widget workspace mapped to this domain' });
    }

    const [{ data: widget, error }, { data: branding }, originRules] = await Promise.all([
      supabase
        .from('widget_settings')
        .select('*')
        .eq('workspace_id', resolvedWorkspaceId)
        .single(),
      supabase
        .from('workspace_branding')
        .select('platform_name, logo_url, primary_color, widget_base_url, asset_base_url')
        .eq('workspace_id', resolvedWorkspaceId)
        .maybeSingle(),
      getWorkspaceOriginRules(config, resolvedWorkspaceId),
    ]);

    if (error || !widget) {
      return res.status(404).json({ error: 'Widget not found or not configured' });
    }

    if (!widget.enabled) {
      return res.json({ enabled: false });
    }

    if (originRules.domains.length && !(await isWorkspaceOriginAllowed(config, resolvedWorkspaceId, origin))) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }

    const apiBase = getRequestBaseUrl(req);
    const assetBase = resolveWidgetAssetBase({
      widgetBaseUrl: branding?.widget_base_url,
      assetBaseUrl: branding?.asset_base_url,
      loaderAssetBase: getLoaderAssetBase(req),
    });

    const widgetConfig = {
      enabled: true,
      workspaceId: resolvedWorkspaceId,
      apiBase,
      assetBase,
      brandName: branding?.platform_name || 'Support',
      primaryColor: widget.primary_color || branding?.primary_color || '#3B82F6',
      logoUrl: widget.logo_url || branding?.logo_url || null,
      launcherText: widget.launcher_text || 'Chat with us',
      welcomeMessage: widget.welcome_message || 'Hello! How can we help you?',
      position: widget.position || 'bottom-right',
      locale: widget.locale || 'en',
      features: {
        chat: widget.chat_enabled ?? true,
        knowledgeBase: widget.kb_enabled ?? true,
        visitorTracking: widget.visitor_tracking_enabled ?? true,
      },
      runtimeUrl: assetBase ? `${assetBase}/widget/runtime.js` : null,
      styleUrl: assetBase ? `${assetBase}/widget/runtime.css` : null,
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

  const allowed = await isWorkspaceOriginAllowed(config, workspace_id, origin);
  res.json({ valid: allowed, reason: allowed ? null : 'origin_not_allowed' });
});

const kbQuerySchema = z.object({
  workspace_id: z.string().uuid(),
  locale: z.string().min(2).max(10).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional().default(6),
});

widgetRouter.get('/kb', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = kbQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid parameters', details: parsed.error.flatten().fieldErrors });
  }

  const { workspace_id, locale, limit } = parsed.data;
  const supabase = getServiceClient(config);

  try {
    const origin = getRequestOrigin(req);
    const { data: widget } = await supabase
      .from('widget_settings')
      .select('enabled, kb_enabled')
      .eq('workspace_id', workspace_id)
      .maybeSingle();

    if (!widget?.enabled || widget.kb_enabled === false) {
      return res.status(403).json({ error: 'Knowledge base not enabled' });
    }

    if (!(await isWorkspaceOriginAllowed(config, workspace_id, origin))) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }

    let query = supabase
      .from('knowledge_base_articles')
      .select('id, title, excerpt, slug, locale')
      .eq('workspace_id', workspace_id)
      .eq('status', 'published')
      .order('sort_order', { ascending: true })
      .limit(limit);

    if (locale) {
      query = query.eq('locale', locale);
    }

    const { data: articles, error: kbError } = await query;
    if (kbError) throw kbError;

    res.json({ articles: articles || [] });
  } catch (err) {
    console.error('Widget KB error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

const messageSchema = z.object({
  workspace_id: z.string().uuid(),
  visitor_id: z.string().min(1).max(255),
  session_id: z.string().uuid().optional(),
  body: z.string().min(1).max(5000),
});

widgetRouter.post('/message', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = messageSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid parameters', details: parsed.error.flatten().fieldErrors });
  }

  const { workspace_id, visitor_id, session_id, body } = parsed.data;
  const supabase = getServiceClient(config);

  try {
    const origin = getRequestOrigin(req);
    const { data: widget } = await supabase
      .from('widget_settings')
      .select('enabled, chat_enabled')
      .eq('workspace_id', workspace_id)
      .maybeSingle();

    if (!widget?.enabled || widget.chat_enabled === false) {
      return res.status(403).json({ error: 'Chat not enabled' });
    }

    if (!(await isWorkspaceOriginAllowed(config, workspace_id, origin))) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }

    let conversationId: string | null = null;

    if (session_id) {
      const { data: existingConversation, error: lookupError } = await supabase
        .from('conversations')
        .select('id')
        .eq('workspace_id', workspace_id)
        .eq('visitor_session_id', session_id)
        .in('status', ['open', 'pending'])
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (lookupError) throw lookupError;
      conversationId = existingConversation?.id || null;
    }

    if (!conversationId) {
      const { data: newConversation, error: createError } = await supabase
        .from('conversations')
        .insert({
          workspace_id,
          visitor_session_id: session_id || null,
          status: 'open',
          priority: 'normal',
          subject: 'Widget conversation',
          updated_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (createError) throw createError;
      conversationId = newConversation.id;
    }

    const { error: messageError } = await supabase
      .from('conversation_messages')
      .insert({
        conversation_id: conversationId,
        body,
        sender_type: 'contact',
        metadata: {
          source: 'widget',
          visitor_id,
          session_id: session_id || null,
        },
      });

    if (messageError) throw messageError;

    await supabase
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId);

    res.json({ ok: true, conversation_id: conversationId, reply: null });
  } catch (err) {
    console.error('Widget message error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});
