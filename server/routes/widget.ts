/**
 * Widget API — Full-featured widget backend
 * 
 * Adapted from WebYar Growth Suite widget system.
 * 
 * Endpoints:
 *  - POST /bootstrap        — Public. Issues HMAC session token
 *  - GET  /config           — Token-secured. Full widget config
 *  - GET  /poll             — Token-secured. Poll messages
 *  - GET  /history          — Token-secured. Conversation history
 *  - GET  /help-articles    — Token-secured. KB articles
 *  - POST /message          — Token-secured. Send message + AI auto-reply
 *  - POST /track            — Token-secured. Visitor tracking event
 *  - PUT  /action           — Token-secured. Heartbeat, typing, reopen, CSAT
 *  - POST /session/refresh  — Refresh expiring token
 *  - GET  /manifest         — Token-secured. Versioned runtime manifest
 *  - POST /validate-origin  — Origin validation check
 *  - GET  /kb               — Legacy KB endpoint (kept for compat)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { getServiceClient } from '../supabase.js';
import type { ServerConfig } from '../config.js';
import {
  getLoaderAssetBase,
  getRequestBaseUrl,
  getRequestOrigin as getRequestOriginPublic,
  getWorkspaceOriginRules,
  isWorkspaceOriginAllowed,
  resolveWidgetApiBase,
  resolveWidgetAssetBase,
  resolveWorkspaceIdFromOrigin,
} from '../services/widget/public.js';
import { getWidgetAssetName, getLoaderVersion } from '../services/widget/manifest.js';
import {
  createSessionToken,
  verifySessionToken,
  verifyTokenForRefresh,
  enforceWidgetToken,
  enforceOrigin,
  widgetRateLimit,
  widgetSecurityCors,
  resolveWorkspaceId,
  verifyConversationOwnership,
  getClientIp,
  getRequestOrigin,
} from '../services/widget/security.js';
import { resolveAIConfig, executeAICompletion } from '../services/ai/index.js';
import { resolveVisitorIdentity, readVisitorCookie } from '../services/widget/visitorIdentity.js';
import { widgetIdentityRouter } from './widgetIdentity.js';
import { widgetAttachmentsRouter, attachUploadedFileToMessage, enrichMessagesWithAttachments } from './widgetAttachments.js';

export const widgetRouter = Router();

// Mount identity sub-router (all routes require widget token + origin)
widgetRouter.use('/identity', widgetIdentityRouter);

// Phase 6a — Mount attachments sub-router (token + origin enforced inside)
widgetRouter.use('/attachments', widgetAttachmentsRouter);

// ─── CORS preflight for all widget routes ───
widgetRouter.use(widgetSecurityCors);

// ─── Default widget settings ───
const DEFAULT_WIDGET_SETTINGS = {
  enabled: true,
  primary_color: '#3B82F6',
  secondary_color: '#6366f1',
  greeting_message: '',
  welcome_message: 'Hello! How can we help you?',
  placeholder_text: '',
  position: 'bottom-right',
  show_logo: true,
  offline_message: '',
  auto_open_delay: 0,
  theme: 'modern',
  fab_icon: 'chat',
  fab_shape: 'circle',
  fab_label: '',
  fab_scale: 100,
  fab_icon_color: '#ffffff',
  fab_text_color: '#ffffff',
  default_mode: 'chat',
  chat_enabled: true,
  kb_enabled: true,
  visitor_tracking_enabled: true,
  support_mode: 'human_first',
  widget_language: 'auto',
  mobile_behavior: 'bottom_sheet',
  locale: 'en',
  // Phase 5 — Availability
  live_chat_enabled: true,
  offline_mode: 'accept_messages',
  business_hours: { enabled: false, timezone: 'UTC', schedule: [] },
  availability_labels: {},
  // Phase 6a — Attachments (off by default)
  attachments_enabled: false,
  attachments_max_size_mb: 10,
  attachments_allowed_mimes: [
    'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    'application/pdf', 'text/plain',
  ],
  // Phase 7 — Read receipts (on by default; admin can disable per-workspace)
  read_receipts_enabled: true,
};

const PRECHAT_RUNTIME_KEY = 'widget_prechat_fields';
const PRECHAT_FIELD_KEYS = {
  name: 'widget_prechat_name',
  email: 'widget_prechat_email',
  phone: 'widget_prechat_phone',
} as const;
const DEFAULT_PRECHAT_POLICY = {
  name: 'default_on',
  email: 'default_on',
  phone: 'default_on',
} as const;

function normalizePreChatPolicy(value: any) {
  const source = value && typeof value === 'object' ? value : {};
  const valid = (v: any) => v === 'force_on' || v === 'force_off' || v === 'default_on' || v === 'default_off';
  return {
    name: valid(source.name) ? source.name : DEFAULT_PRECHAT_POLICY.name,
    email: valid(source.email) ? source.email : DEFAULT_PRECHAT_POLICY.email,
    phone: valid(source.phone) ? source.phone : DEFAULT_PRECHAT_POLICY.phone,
  };
}

// Loads policy from widget_platform_settings (preferred) or falls back to app_runtime_config
async function loadPlatformPreChatPolicy(supabase: any): Promise<any> {
  const { data: platformRow } = await supabase
    .from('widget_platform_settings')
    .select('prechat_name_policy, prechat_email_policy, prechat_phone_policy')
    .limit(1)
    .maybeSingle();
  if (platformRow) {
    return {
      name: platformRow.prechat_name_policy,
      email: platformRow.prechat_email_policy,
      phone: platformRow.prechat_phone_policy,
    };
  }
  const { data: legacy } = await supabase
    .from('app_runtime_config')
    .select('value')
    .eq('key', PRECHAT_RUNTIME_KEY)
    .maybeSingle();
  return legacy?.value || null;
}

function buildPreChatConfig(policyValue: any, workspaceFlags: Array<{ key: string; enabled: boolean | null }> = []) {
  const policy = normalizePreChatPolicy(policyValue);
  const flagMap = new Map(workspaceFlags.map((flag) => [flag.key, flag.enabled]));

  const resolveField = (field: keyof typeof PRECHAT_FIELD_KEYS) => {
    const mode = policy[field];
    const locked = mode === 'force_off';
    const workspaceOverride = flagMap.has(PRECHAT_FIELD_KEYS[field]) ? flagMap.get(PRECHAT_FIELD_KEYS[field]) ?? false : null;
    const enabled = locked ? false : workspaceOverride === null ? mode === 'default_on' : !!workspaceOverride;
    return { enabled, locked, mode, workspaceOverride };
  };

  return {
    name: resolveField('name'),
    email: resolveField('email'),
    phone: resolveField('phone'),
  };
}

// ═══════════════════════════════════════════════
// POST /bootstrap — Public. Issues session token
// ═══════════════════════════════════════════════
widgetRouter.post('/bootstrap', widgetRateLimit('bootstrap'), async (req: Request, res: Response) => {
  try {
    const config = (req as any).serverConfig as ServerConfig;
    const supabase = getServiceClient(config);
    const { workspace_id } = req.body || {};

    const requestOrigin = getRequestOrigin(req) || (() => {
      try { return new URL(req.headers['referer'] as string || '').origin; } catch { return null; }
    })();

    // Resolve workspace: explicit ID or by origin
    const resolvedWorkspaceId = workspace_id || (requestOrigin ? await resolveWorkspaceIdFromOrigin(config, requestOrigin) : null);

    if (!resolvedWorkspaceId) {
      return res.status(400).json({ error: 'workspace_id required or origin must be mapped', code: 'MISSING_WORKSPACE' });
    }

    // Verify workspace exists
    const { data: workspace } = await supabase
      .from('workspaces')
      .select('id, name')
      .eq('id', resolvedWorkspaceId)
      .maybeSingle();

    if (!workspace) {
      return res.status(404).json({ disabled: true, error: 'Workspace not found' });
    }

    // Check widget enabled
    const { data: widgetSettings } = await supabase
      .from('widget_settings')
      .select('enabled, allowed_domains, allow_subdomains')
      .eq('workspace_id', resolvedWorkspaceId)
      .maybeSingle();

    if (widgetSettings?.enabled === false) {
      return res.json({ disabled: true, fallback: true });
    }

    // Origin validation
    if (requestOrigin && widgetSettings) {
      const originRules = await getWorkspaceOriginRules(config, resolvedWorkspaceId);
      if (originRules.domains.length > 0) {
        const allowed = await isWorkspaceOriginAllowed(config, resolvedWorkspaceId, requestOrigin);
        if (!allowed) {
          // Allow localhost for dev
          const isLocalDev = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(requestOrigin);
          if (!isLocalDev) {
            console.warn(`[widget-bootstrap] Origin rejected: ${requestOrigin} for workspace ${resolvedWorkspaceId}`);
            return res.status(403).json({ error: 'Origin not authorized', code: 'ORIGIN_DENIED' });
          }
        }
      }
    }

    // Issue session token
    const sessionToken = createSessionToken(resolvedWorkspaceId, requestOrigin || '');
    const tokenInfo = verifySessionToken(sessionToken);

    // Set CORS (credentials enabled so visitor cookie can be set cross-site)
    if (requestOrigin) {
      res.header('Access-Control-Allow-Origin', requestOrigin);
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('Vary', 'Origin');
    }

    // Issue / refresh visitor identity cookie (HttpOnly, signed)
    const visitor = resolveVisitorIdentity(req, res, resolvedWorkspaceId);

    // No-cache
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');

    // Get branding for platform display name
    const { data: branding } = await supabase
      .from('workspace_branding')
      .select('platform_name')
      .eq('workspace_id', resolvedWorkspaceId)
      .maybeSingle();

    return res.json({
      session_token: sessionToken,
      workspace_id: resolvedWorkspaceId,
      workspace_name: workspace.name,
      expires_at: tokenInfo.valid && tokenInfo.expiresAt ? new Date(tokenInfo.expiresAt * 1000).toISOString() : null,
      platform_display_name: branding?.platform_name || '',
      visitor_id: visitor.visitorId,
      is_new_visitor: visitor.isNew,
      version: '3.0.0',
    });
  } catch (err: any) {
    console.error('[widget-bootstrap] Error:', err.message);
    return res.status(500).json({ error: 'Bootstrap failed' });
  }
});

// ═══════════════════════════════════════════════
// POST /session/refresh — Secure token renewal
// ═══════════════════════════════════════════════
widgetRouter.post('/session/refresh', widgetRateLimit('refresh'), async (req: Request, res: Response) => {
  try {
    const currentToken = req.headers['x-widget-token'] as string;
    if (!currentToken) {
      return res.status(401).json({ error: 'Current session token required', code: 'MISSING_TOKEN' });
    }

    const tokenData = verifyTokenForRefresh(currentToken);
    if (!tokenData.valid && !tokenData.workspaceId) {
      return res.status(403).json({
        error: tokenData.reason === 'expired_beyond_grace' ? 'Session expired beyond refresh window' : 'Invalid session token',
        code: tokenData.reason === 'expired_beyond_grace' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
      });
    }

    const workspaceId = tokenData.workspaceId;
    const tokenOrigin = tokenData.origin || '';

    if (!workspaceId) {
      return res.status(403).json({ error: 'Invalid token — no workspace', code: 'INVALID_TOKEN' });
    }

    const requestOrigin = getRequestOrigin(req) || '';
    if (tokenOrigin && requestOrigin && tokenOrigin.toLowerCase() !== requestOrigin.toLowerCase()) {
      return res.status(403).json({ error: 'Origin mismatch', code: 'ORIGIN_MISMATCH' });
    }

    const newToken = createSessionToken(workspaceId, tokenOrigin || requestOrigin);
    const newResult = verifySessionToken(newToken);

    if (requestOrigin) {
      res.header('Access-Control-Allow-Origin', requestOrigin);
    }

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');

    return res.json({
      session_token: newToken,
      workspace_id: workspaceId,
      expires_at: newResult.expiresAt ? new Date(newResult.expiresAt * 1000).toISOString() : null,
    });
  } catch (err: any) {
    console.error('[session-refresh] Error:', err.message);
    return res.status(500).json({ error: 'Session refresh failed' });
  }
});

// ═══════════════════════════════════════════════
// All routes below require valid session token
// ═══════════════════════════════════════════════
widgetRouter.use(enforceWidgetToken);
widgetRouter.use(enforceOrigin);

// ═══════════════════════════════════════════════
// Cookie-based visitor identity resolution
// ───────────────────────────────────────────────
// The widget runtime no longer sends visitor_id in body/query — instead the
// server reads it from the signed HttpOnly `dvsid` cookie. Existing route
// handlers still expect req.body.visitor_id / req.query.visitor_id, so this
// middleware fills them in from the cookie when missing. Workspace mismatch
// is rejected so a cookie issued for workspace A cannot be replayed against B.
// ═══════════════════════════════════════════════
widgetRouter.use((req: Request, res: Response, next: NextFunction) => {
  try {
    const tokenWs = (req as any)._widgetWorkspaceId as string | undefined;
    const wsFromBody = (req.body && typeof req.body === 'object' ? (req.body as any).workspace_id : undefined) as string | undefined;
    const wsFromQuery = req.query.workspace_id as string | undefined;
    const ws = tokenWs || wsFromBody || wsFromQuery;
    if (!ws) return next();

    const cookie = readVisitorCookie(req, ws);
    if (!cookie) return next();

    if (req.body && typeof req.body === 'object' && !(req.body as any).visitor_id) {
      (req.body as any).visitor_id = cookie.v;
    }
    if (!req.query.visitor_id) {
      (req.query as any).visitor_id = cookie.v;
    }
    (req as any).visitorId = cookie.v;
  } catch (_) {
    // Identity resolution must never block the request
  }
  return next();
});
// ═══════════════════════════════════════════════
// GET /config — Full widget configuration
// ═══════════════════════════════════════════════
widgetRouter.get('/config', widgetRateLimit('bootstrap'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = resolveWorkspaceId(req, res, req.query.workspace_id as string);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const supabase = getServiceClient(config);

  try {
    const [{ data: widget, error }, { data: branding }, { data: platformDomains }, originRules, platformPreChatPolicy, { data: workspacePreChatFlags }] = await Promise.all([
      supabase.from('widget_settings').select('*').eq('workspace_id', workspaceId).maybeSingle(),
      supabase.from('workspace_branding')
        .select('platform_name, logo_url, primary_color, widget_base_url, widget_public_base_url, widget_loader_base_url, widget_api_base_url, asset_base_url')
        .eq('workspace_id', workspaceId).maybeSingle(),
      supabase.from('platform_domains')
        .select('api_base_url, widget_base_url, asset_base_url, public_base_url')
        .limit(1).maybeSingle(),
      getWorkspaceOriginRules(config, workspaceId),
      loadPlatformPreChatPolicy(supabase),
      supabase.from('feature_flags').select('key, enabled').eq('workspace_id', workspaceId).in('key', Object.values(PRECHAT_FIELD_KEYS)),
    ]);

    if (error || !widget) {
      return res.status(404).json({ error: 'Widget not found or not configured' });
    }

    if (!widget.enabled) {
      return res.json({ enabled: false });
    }

    const ws = { ...DEFAULT_WIDGET_SETTINGS, ...widget };

    // Get workspace info + team members
    const { data: workspace } = await supabase
      .from('workspaces').select('name').eq('id', workspaceId).maybeSingle();

    const { data: members } = await supabase
      .from('workspace_members').select('user_id').eq('workspace_id', workspaceId).limit(4);

    let teamMembers: Array<{ name: string; avatar: string | null }> = [];
    if (members?.length) {
      const { data: profiles } = await supabase
        .from('profiles').select('full_name, avatar_url')
        .in('id', members.map((m: any) => m.user_id));
      if (profiles) {
        teamMembers = profiles.map((p: any) => ({ name: p.full_name || 'Operator', avatar: p.avatar_url }));
      }
    }

    const apiBase = resolveWidgetApiBase({
      widgetApiBaseUrl: branding?.widget_api_base_url,
      platformApiBaseUrl: platformDomains?.api_base_url,
      requestBaseUrl: getRequestBaseUrl(req),
      allowRequestFallback: !branding?.widget_api_base_url && !platformDomains?.api_base_url,
    });
    const assetBase = resolveWidgetAssetBase({
      widgetBaseUrl: branding?.widget_base_url,
      widgetLoaderBaseUrl: branding?.widget_loader_base_url,
      widgetPublicBaseUrl: branding?.widget_public_base_url || platformDomains?.widget_base_url || platformDomains?.public_base_url,
      assetBaseUrl: branding?.asset_base_url,
      loaderAssetBase: getLoaderAssetBase(req),
    });

    const runtimeJsName = getWidgetAssetName('runtime.js');
    const runtimeCssName = getWidgetAssetName('runtime.css');
    const chatModuleName = getWidgetAssetName('runtime-chat.js');
    const kbModuleName = getWidgetAssetName('runtime-kb.js');
    const loaderVersion = getLoaderVersion();
    const preChat = buildPreChatConfig(platformPreChatPolicy, workspacePreChatFlags || []);
    const versionedAssetUrl = (url: string | null) => {
      if (!url) return null;
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}v=${encodeURIComponent(loaderVersion)}`;
    };
    const widgetConfig = {
      enabled: true,
      workspaceId,
      apiBase,
      assetBase,
      debugMode: ws.debug_mode ?? false,
      brandName: branding?.platform_name || 'Support',
      primaryColor: ws.primary_color || branding?.primary_color || '#3B82F6',
      secondaryColor: ws.secondary_color || '#6366f1',
      logoUrl: ws.logo_url || branding?.logo_url || null,
      launcherText: ws.launcher_text || 'Chat with us',
      welcomeMessage: ws.welcome_message || 'Hello! How can we help you?',
      greetingMessage: ws.greeting_message || '',
      placeholderText: ws.placeholder_text || '',
      offlineMessage: ws.offline_message || '',
      position: ws.position || 'bottom-right',
      locale: ws.locale || 'en',
      widgetLanguage: ws.widget_language || 'auto',
      loaderVersion,
      theme: ws.theme || 'modern',
      fab: {
        icon: ws.fab_icon || 'chat',
        helpIcon: ws.fab_help_icon || 'help_circle',
        shape: ws.fab_shape || 'circle',
        label: ws.fab_label || '',
        chatLabel: ws.fab_chat_label || '',
        helpLabel: ws.fab_help_label || '',
        scale: ws.fab_scale ?? 100,
        iconColor: ws.fab_icon_color || '#ffffff',
        textColor: ws.fab_text_color || '#ffffff',
        animation: ws.fab_animation ?? true,
      },
      features: {
        chat: ws.chat_enabled ?? true,
        knowledgeBase: ws.kb_enabled ?? true,
        visitorTracking: ws.visitor_tracking_enabled ?? true,
      },
      preChat,
      // Phase 5 — Availability snapshot consumed by widget runtime presence layer.
      // Widget never assumes realtime presence; this snapshot is always valid.
      availability: {
        liveChatEnabled: ws.live_chat_enabled ?? true,
        offlineMode: ws.offline_mode === 'contact_fallback' ? 'contact_fallback' : 'accept_messages',
        businessHours: ws.business_hours && typeof ws.business_hours === 'object'
          ? ws.business_hours
          : { enabled: false, timezone: 'UTC', schedule: [] },
        labels: ws.availability_labels && typeof ws.availability_labels === 'object'
          ? ws.availability_labels
          : {},
      },
      // Phase 6a — Attachment config exposed to the widget runtime.
      // The widget enforces these as a UX guard; the backend re-validates.
      attachments: {
        enabled: ws.attachments_enabled === true,
        maxSizeMb: Math.max(1, Math.min(25, ws.attachments_max_size_mb ?? 10)),
        allowedMimes: Array.isArray(ws.attachments_allowed_mimes) && ws.attachments_allowed_mimes.length > 0
          ? ws.attachments_allowed_mimes
          : ['image/png','image/jpeg','image/webp','image/gif','application/pdf','text/plain'],
        maxCount: 1, // v1: single file per message
      },
      // Phase 7 — Read receipts toggle. When false, the widget shows only
      // sending/sent (no "Seen" indicator). The widget never invents seen
      // state; it only renders what the backend has actually recorded.
      readReceipts: {
        enabled: ws.read_receipts_enabled !== false,
      },
      supportMode: ws.support_mode || 'human_first',
      defaultMode: ws.default_mode || 'chat',
      mobileBehavior: ws.mobile_behavior || 'bottom_sheet',
      autoOpenDelay: ws.auto_open_delay || 0,
      showLogo: ws.show_logo ?? true,
      workspaceName: workspace?.name || '',
      teamMembers,
      onlineOperators: 0, // Resolved client-side from realtime presence when supported.
      runtimeUrl: versionedAssetUrl(assetBase ? `${assetBase}/widget/${runtimeJsName}` : null),
      styleUrl: versionedAssetUrl(assetBase ? `${assetBase}/widget/${runtimeCssName}` : null),
      modules: {
        chat: versionedAssetUrl(assetBase ? `${assetBase}/widget/${chatModuleName}` : null),
        kb: versionedAssetUrl(assetBase ? `${assetBase}/widget/${kbModuleName}` : null),
      },
    };

    res.json(widgetConfig);
  } catch (err: any) {
    console.error('Widget config error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════
// GET /poll — Poll for new messages
// ═══════════════════════════════════════════════
widgetRouter.get('/poll', widgetRateLimit('poll'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = resolveWorkspaceId(req, res, req.query.workspace_id as string);
  if (res.headersSent) return;
  if (!workspaceId) return res.json({ status: 'unknown', messages: [], conversation_id: null });

  const conversationId = req.query.conversation_id as string;
  const visitorId = req.query.visitor_id as string || null;
  const sessionId = req.query.session_id as string || null;
  const supabase = getServiceClient(config);

  try {
    let conv: any = null;
    let activeConversationId: string | null = null;

    // Try direct conversation lookup with ownership verification
    if (conversationId) {
      const ownership = await verifyConversationOwnership(config, conversationId, workspaceId, visitorId, sessionId);
      if (ownership.valid && ownership.conversation) {
        conv = ownership.conversation;
        activeConversationId = conv.id;
      }
    }

    // Fallback: find by visitor_id via visitor_sessions
    if (!conv && visitorId) {
      const { data: session } = await supabase
        .from('visitor_sessions').select('id')
        .eq('workspace_id', workspaceId).eq('visitor_id', visitorId)
        .order('last_seen_at', { ascending: false }).limit(1).maybeSingle();

      if (session) {
        const { data: fc } = await supabase
          .from('conversations').select('id, status, assigned_to, updated_at, contact_id, visitor_session_id, workspace_id')
          .eq('workspace_id', workspaceId).eq('visitor_session_id', session.id)
          .order('updated_at', { ascending: false }).limit(1).maybeSingle();

        if (fc) { conv = fc; activeConversationId = fc.id; }
      }
    }

    // Fallback: find by contact metadata
    if (!conv && visitorId) {
      const { data: contact } = await supabase
        .from('contacts').select('id')
        .eq('workspace_id', workspaceId)
        .contains('metadata', { visitor_id: visitorId })
        .limit(1).maybeSingle();

      if (contact) {
        const { data: fc } = await supabase
          .from('conversations').select('id, status, assigned_to, updated_at, contact_id, visitor_session_id, workspace_id')
          .eq('workspace_id', workspaceId).eq('contact_id', contact.id)
          .order('updated_at', { ascending: false }).limit(1).maybeSingle();

        if (fc) { conv = fc; activeConversationId = fc.id; }
      }
    }

    if (!conv) {
      return res.json({ status: 'unknown', messages: [], operator: null, operator_typing: false, conversation_id: null });
    }

    const { data: msgs } = await supabase
      .from('conversation_messages')
      .select('id, body, sender_type, created_at, metadata, seen_at')
      .eq('conversation_id', activeConversationId)
      .order('created_at', { ascending: false })
      .limit(200);

    const baseMessages = (msgs || []).slice().reverse().map((m: any) => ({
      id: m.id,
      role: m.sender_type === 'contact' ? 'visitor' : m.sender_type === 'system' ? 'system' : 'agent',
      text: m.body,
      time: m.created_at,
      metadata: m.metadata,
      // Phase 7 — lifecycle. Only ever set on visitor messages, only by an
      // operator-side action (mark_conversation_seen RPC). Monotonic.
      seen_at: m.seen_at || null,
    }));
    // Phase 6b — attach public-safe attachment metadata (no provider URLs)
    const messages = await enrichMessagesWithAttachments(config, workspaceId, baseMessages);

    let operatorInfo = null;
    if (conv.assigned_to) {
      const { data: profile } = await supabase
        .from('profiles').select('full_name, avatar_url')
        .eq('id', conv.assigned_to).maybeSingle();
      if (profile) operatorInfo = { name: profile.full_name, avatar: profile.avatar_url };
    }

    return res.json({
      status: conv.status || 'unknown',
      messages,
      operator: operatorInfo,
      operator_typing: false,
      conversation_id: activeConversationId,
    });
  } catch (err: any) {
    console.error('[widget-poll] Error:', err.message);
    res.status(500).json({ error: 'Poll failed' });
  }
});

// ═══════════════════════════════════════════════
// GET /history — Conversation history
// ═══════════════════════════════════════════════
widgetRouter.get('/history', widgetRateLimit('poll'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = resolveWorkspaceId(req, res, req.query.workspace_id as string);
  if (res.headersSent) return;

  const conversationId = req.query.conversation_id as string;
  const visitorId = req.query.visitor_id as string || null;
  const sessionId = req.query.session_id as string || null;

  if (!conversationId || !workspaceId) {
    return res.status(400).json({ error: 'conversation_id and workspace_id required' });
  }

  const ownership = await verifyConversationOwnership(config, conversationId, workspaceId, visitorId, sessionId);
  if (!ownership.valid) {
    return res.status(403).json({ error: 'Access denied to this conversation', code: 'CONVERSATION_ACCESS_DENIED' });
  }

  const supabase = getServiceClient(config);
  const { data: msgs } = await supabase
    .from('conversation_messages')
    .select('id, body, sender_type, created_at, metadata, seen_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(200);

  const baseMessages = (msgs || []).slice().reverse().map((m: any) => ({
    id: m.id,
    role: m.sender_type === 'contact' ? 'visitor' : m.sender_type === 'system' ? 'system' : 'agent',
    text: m.body,
    time: m.created_at,
    metadata: m.metadata,
    // Phase 7 — lifecycle (see /poll for semantics).
    seen_at: m.seen_at || null,
  }));
  // Phase 6b — attach public-safe attachment metadata (no provider URLs)
  const messages = await enrichMessagesWithAttachments(config, workspaceId, baseMessages);

  return res.json({ messages });
});

// ═══════════════════════════════════════════════
// GET /help-articles — Knowledge base articles
// ═══════════════════════════════════════════════
widgetRouter.get('/help-articles', widgetRateLimit('default'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = resolveWorkspaceId(req, res, req.query.workspace_id as string);
  if (res.headersSent) return;
  if (!workspaceId) return res.json({ articles: [] });

  const supabase = getServiceClient(config);
  const search = (req.query.search as string) || '';
  const locale = (req.query.locale as string) || '';
  const limit = Math.min(parseInt(req.query.limit as string || '20'), 50);

  try {
    let query = supabase
      .from('knowledge_base_articles')
      .select('id, title, slug, content, excerpt, locale')
      .eq('workspace_id', workspaceId)
      .eq('status', 'published')
      .order('sort_order', { ascending: true })
      .limit(limit);

    if (locale) query = query.eq('locale', locale);
    if (search) query = query.or(`title.ilike.%${search}%,content.ilike.%${search}%`);

    const { data: articles } = await query;
    return res.json({ articles: articles || [] });
  } catch (err: any) {
    console.error('[widget-help] Error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════
// POST /message — Send message + AI auto-reply
// ═══════════════════════════════════════════════
const messageSchema = z.object({
  workspace_id: z.string().uuid().optional(),
  conversation_id: z.string().uuid().optional().nullable(),
  message: z.string().min(0).max(5000).optional(),
  body: z.string().min(0).max(5000).optional(),
  visitor_id: z.string().min(1).max(255).optional(),
  visitor_name: z.string().max(200).optional(),
  visitor_email: z.string().email().optional().nullable(),
  visitor_phone: z.string().max(30).optional().nullable(),
  session_id: z.string().uuid().optional().nullable(),
  force_new_conversation: z.boolean().optional(),
  attachment_id: z.string().uuid().optional().nullable(),
}).refine(
  d => !!((d.message && d.message.trim()) || (d.body && d.body.trim()) || d.attachment_id),
  { message: 'message, body, or attachment_id required' }
);

widgetRouter.post('/message', widgetRateLimit('message'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid parameters', details: parsed.error.flatten().fieldErrors });
  }

  const data = parsed.data;
  const messageText = (data.message || data.body || '').trim();
  const body = { ...data, message: messageText };
  const workspaceId = resolveWorkspaceId(req, res, body.workspace_id);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const supabase = getServiceClient(config);

  try {
    // Verify widget is enabled
    const { data: widget } = await supabase
      .from('widget_settings').select('enabled, chat_enabled')
      .eq('workspace_id', workspaceId).maybeSingle();

    if (!widget?.enabled || widget.chat_enabled === false) {
      return res.status(403).json({ error: 'Chat not enabled' });
    }

    let convId = body.conversation_id || null;

    // Verify conversation ownership if provided
    if (convId) {
      const ownership = await verifyConversationOwnership(config, convId, workspaceId, body.visitor_id, body.session_id);
      if (!ownership.valid) {
        convId = null; // Will create new conversation
      } else {
        const conv = ownership.conversation;
        if (['closed', 'resolved', 'pending'].includes(conv.status)) {
          await supabase.from('conversations')
            .update({ status: 'open', updated_at: new Date().toISOString() })
            .eq('id', convId);
        }
      }
    }

    // Try to find existing conversation by visitor identity
    if (!convId && body.visitor_id && !body.force_new_conversation) {
      // By session
      if (body.session_id) {
        const { data: existingConv } = await supabase
          .from('conversations').select('id')
          .eq('workspace_id', workspaceId).eq('visitor_session_id', body.session_id)
          .in('status', ['open', 'pending'])
          .order('updated_at', { ascending: false }).limit(1).maybeSingle();
        if (existingConv) convId = existingConv.id;
      }

      // By contact metadata
      if (!convId) {
        const { data: contact } = await supabase
          .from('contacts').select('id')
          .eq('workspace_id', workspaceId)
          .contains('metadata', { visitor_id: body.visitor_id })
          .limit(1).maybeSingle();

        if (contact) {
          const { data: existingConv } = await supabase
            .from('conversations').select('id')
            .eq('workspace_id', workspaceId).eq('contact_id', contact.id)
            .order('updated_at', { ascending: false }).limit(1).maybeSingle();
          if (existingConv) {
            convId = existingConv.id;
            await supabase.from('conversations')
              .update({ status: 'open', updated_at: new Date().toISOString() })
              .eq('id', convId);
          }
        }
      }
    }

    // Create new conversation
    if (!convId) {
      // Find or create contact
      let contactId: string | null = null;

      if (body.visitor_id) {
        const { data: existingContact } = await supabase
          .from('contacts').select('id')
          .eq('workspace_id', workspaceId)
          .contains('metadata', { visitor_id: body.visitor_id })
          .limit(1).maybeSingle();
        contactId = existingContact?.id || null;
      }

      if (!contactId && (body.visitor_name || body.visitor_email || body.visitor_id)) {
        const { data: newContact } = await supabase
          .from('contacts').insert({
            workspace_id: workspaceId,
            name: body.visitor_name || 'Visitor',
            email: body.visitor_email || null,
            phone: body.visitor_phone || null,
            metadata: { visitor_id: body.visitor_id, source: 'widget' },
          }).select('id').single();
        contactId = newContact?.id || null;
      }

      const subjectText = body.message ? body.message.slice(0, 80) : (data.attachment_id ? '[Attachment]' : 'New conversation');
      const { data: conv, error: convErr } = await supabase
        .from('conversations').insert({
          workspace_id: workspaceId,
          status: 'open',
          priority: 'normal',
          subject: subjectText,
          contact_id: contactId,
          visitor_session_id: body.session_id || null,
          updated_at: new Date().toISOString(),
        }).select('id').single();

      if (convErr) throw convErr;
      convId = conv!.id;
    }

    // Insert visitor message (body may be empty when only an attachment is sent)
    const messageBody = body.message || (data.attachment_id ? '' : '');
    const { data: insertedMsg, error: msgErr } = await supabase
      .from('conversation_messages').insert({
        conversation_id: convId,
        body: messageBody,
        sender_type: 'contact',
        metadata: {
          source: 'widget',
          visitor_id: body.visitor_id,
          session_id: body.session_id,
          attachment_id: data.attachment_id || undefined,
        },
      })
      .select('id')
      .single();
    if (msgErr) throw msgErr;

    // Phase 6a — Bind uploaded attachment to this message + conversation
    if (data.attachment_id && insertedMsg?.id) {
      const ok = await attachUploadedFileToMessage(
        config, data.attachment_id, workspaceId, convId!, insertedMsg.id
      );
      if (!ok) {
        // Don't fail the message; the attachment just won't be linked.
        console.warn('[widget] Failed to attach', data.attachment_id, 'to message', insertedMsg.id);
      }
    }

    await supabase.from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', convId);

    // AI auto-reply attempt
    let reply: string | null = null;
    try {
      const aiConfig = await resolveAIConfig(config, workspaceId);
      if (aiConfig) {
        // Get conversation history for context
        const { data: history } = await supabase
          .from('conversation_messages')
          .select('body, sender_type, created_at')
          .eq('conversation_id', convId)
          .order('created_at', { ascending: true })
          .limit(20);

        // Get KB articles for context
        const { data: kbArticles } = await supabase
          .from('knowledge_base_articles')
          .select('title, content')
          .eq('workspace_id', workspaceId)
          .eq('status', 'published')
          .limit(5);

        const kbContext = kbArticles?.length
          ? '\n\nKnowledge Base:\n' + kbArticles.map((a: any) => `- ${a.title}: ${(a.content || '').slice(0, 300)}`).join('\n')
          : '';

        const { data: wsInfo } = await supabase
          .from('workspaces').select('name').eq('id', workspaceId).maybeSingle();

        const systemPrompt = `You are a helpful support assistant for "${wsInfo?.name || 'this company'}".
Answer customer questions concisely and helpfully.
If you cannot answer, say so politely.${kbContext}`;

        const prompt = (history || []).map((m: any) =>
          `${m.sender_type === 'contact' ? 'Customer' : 'Agent'}: ${m.body}`
        ).join('\n');

        const aiResponse = await executeAICompletion(config, {
          workspaceId,
          prompt,
          systemPrompt,
          maxTokens: 300,
          temperature: 0.7,
        });

        if (aiResponse.text) {
          reply = aiResponse.text;
          await supabase.from('conversation_messages').insert({
            conversation_id: convId,
            body: reply,
            sender_type: 'agent',
            metadata: { source: 'ai_auto_reply', provider: aiResponse.provider, model: aiResponse.model },
          });
        }
      }
    } catch (aiErr: any) {
      console.warn('[widget-message] AI auto-reply failed:', aiErr.message);
    }

    return res.json({
      conversation_id: convId,
      // Phase 7 — return the canonical message id so the widget can bind its
      // optimistic "sending" bubble to a real backend record and transition
      // it to "sent". Never invented client-side; always backend-issued.
      message_id: insertedMsg?.id || null,
      status: 'sent',
      reply,
    });
  } catch (err: any) {
    console.error('[widget-message] Error:', err.message);
    res.status(500).json({ error: 'Message send failed' });
  }
});

// ═══════════════════════════════════════════════
// POST /track — Visitor tracking event
// ═══════════════════════════════════════════════
widgetRouter.post('/track', widgetRateLimit('default'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = resolveWorkspaceId(req, res, req.body?.workspace_id);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const supabase = getServiceClient(config);
  const {
    event_type,
    event,
    visitor_id,
    session_id,
    page_url,
    current_page,
    page_title,
    referrer,
    browser,
    device,
    os,
  } = req.body;

  try {
    const normalizedEvent = event_type || event;
    const normalizedPageUrl = page_url || current_page || null;
    let activeSessionId: string | null = session_id || null;

    if (normalizedEvent === 'page_view' || normalizedEvent === 'heartbeat') {
      const clientIp = getClientIp(req);
      const ipHash = crypto.createHash('sha256').update(clientIp).digest('hex').slice(0, 16);

      // Check for existing recent session
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { data: existing } = await supabase
        .from('visitor_sessions').select('id')
        .eq('workspace_id', workspaceId).eq('visitor_id', visitor_id || '')
        .gte('last_seen_at', thirtyMinAgo)
        .order('last_seen_at', { ascending: false }).limit(1).maybeSingle();

      if (existing) {
        activeSessionId = existing.id;
        await supabase.from('visitor_sessions')
          .update({
            current_page: normalizedPageUrl,
            browser: browser || undefined,
            device: device || undefined,
            os: os || undefined,
            last_seen_at: new Date().toISOString(),
          })
          .eq('id', existing.id);

        await supabase.from('visitor_presence')
          .update({ status: 'online', current_page: normalizedPageUrl, updated_at: new Date().toISOString() })
          .eq('visitor_session_id', existing.id);
      } else if (visitor_id) {
        const { data: newSession } = await supabase
          .from('visitor_sessions').insert({
            workspace_id: workspaceId,
            visitor_id,
            current_page: normalizedPageUrl,
            referrer: referrer || null,
            ip_hash: ipHash,
            browser: browser || null,
            device: device || null,
            os: os || null,
          }).select('id').maybeSingle();

        if (newSession) {
          activeSessionId = newSession.id;
          await supabase.from('visitor_presence').insert({
            workspace_id: workspaceId,
            visitor_session_id: newSession.id,
            status: 'online',
            current_page: normalizedPageUrl,
          });
        }
      }
    }

    return res.json({ ok: true, session_id: activeSessionId });
  } catch (err: any) {
    console.error('[widget-track] Error:', err.message);
    res.json({ ok: true, session_id: session_id || null }); // Don't fail on tracking errors
  }
});

// ═══════════════════════════════════════════════
// PUT /action — Heartbeat, Typing, Reopen, CSAT
// ═══════════════════════════════════════════════
widgetRouter.put('/action', widgetRateLimit('default'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = resolveWorkspaceId(req, res, req.body?.workspace_id);
  if (res.headersSent) return;

  const { action, conversation_id, visitor_id, session_id, visitor_name, visitor_email, visitor_phone, current_page } = req.body;
  const supabase = getServiceClient(config);

  try {
    if (action === 'heartbeat' && workspaceId) {
      const now = new Date().toISOString();

      if (conversation_id) {
        const ownership = await verifyConversationOwnership(config, conversation_id, workspaceId, visitor_id, session_id);
        if (!ownership.valid) return res.status(403).json({ error: 'Access denied', code: 'CONVERSATION_ACCESS_DENIED' });
        await supabase.from('conversations').update({ updated_at: now }).eq('id', conversation_id);
        return res.json({ ok: true });
      }

      if (session_id) {
        let sessionUpdate = supabase.from('visitor_sessions')
          .update({ last_seen_at: now, current_page: current_page || null })
          .eq('workspace_id', workspaceId)
          .eq('id', session_id);

        if (visitor_id) {
          sessionUpdate = sessionUpdate.eq('visitor_id', visitor_id);
        }

        const { error: sessionErr } = await sessionUpdate;
        if (sessionErr) throw sessionErr;

        await supabase.from('visitor_presence')
          .update({ status: 'online', current_page: current_page || null, updated_at: now })
          .eq('workspace_id', workspaceId)
          .eq('visitor_session_id', session_id);

        return res.json({ ok: true });
      }

      return res.status(400).json({ error: 'session_id or conversation_id required' });
    }

    if (action === 'typing' && conversation_id) {
      const ownership = await verifyConversationOwnership(config, conversation_id, workspaceId!, visitor_id, session_id);
      if (!ownership.valid) return res.status(403).json({ error: 'Access denied', code: 'CONVERSATION_ACCESS_DENIED' });
      // Broadcast typing event via Supabase Realtime
      const channel = supabase.channel(`typing:${conversation_id}`);
      await channel.send({ type: 'broadcast', event: 'typing', payload: { who: 'visitor', timestamp: new Date().toISOString() } });
      supabase.removeChannel(channel);
      return res.json({ ok: true });
    }

    if (action === 'reopen_conversation' && conversation_id && workspaceId) {
      const ownership = await verifyConversationOwnership(config, conversation_id, workspaceId, visitor_id, session_id);
      if (!ownership.valid) return res.json({ ok: false, not_found: true });
      const conv = ownership.conversation;
      if (['closed', 'resolved', 'pending'].includes(conv.status)) {
        await supabase.from('conversations')
          .update({ status: 'open', updated_at: new Date().toISOString() })
          .eq('id', conversation_id);
      }
      return res.json({ ok: true, status: 'open' });
    }

    if (action === 'resolve_visitor' && workspaceId) {
      let knownContact: { name: string | null; email: string | null; phone: string | null } | null = null;
      let contactId: string | null = null;
      let activeConvId = null;

      if (visitor_id) {
        const { data: contact } = await supabase
          .from('contacts').select('id, name, email, phone')
          .eq('workspace_id', workspaceId)
          .contains('metadata', { visitor_id })
          .limit(1).maybeSingle();

        if (contact) {
          contactId = contact.id;
          const updatePayload: Record<string, unknown> = {
            updated_at: new Date().toISOString(),
            metadata: { visitor_id, source: 'widget', session_id: session_id || null },
          };
          if (visitor_name && visitor_name !== contact.name) updatePayload.name = visitor_name;
          if (visitor_email && visitor_email !== contact.email) updatePayload.email = visitor_email;
          if (visitor_phone && visitor_phone !== contact.phone) updatePayload.phone = visitor_phone;
          if (Object.keys(updatePayload).length > 2) {
            const { data: updatedContact } = await supabase
              .from('contacts')
              .update(updatePayload)
              .eq('id', contact.id)
              .select('id, name, email, phone')
              .maybeSingle();
            if (updatedContact) {
              knownContact = { name: updatedContact.name, email: updatedContact.email, phone: updatedContact.phone };
            }
          }
        } else {
          const { data: createdContact } = await supabase
            .from('contacts')
            .insert({
              workspace_id: workspaceId,
              name: visitor_name || 'Visitor',
              email: visitor_email || null,
              phone: visitor_phone || null,
              metadata: { visitor_id, source: 'widget', session_id: session_id || null },
            })
            .select('id, name, email, phone')
            .maybeSingle();
          if (createdContact) {
            contactId = createdContact.id;
            knownContact = { name: createdContact.name, email: createdContact.email, phone: createdContact.phone };
          }
        }

        if (!knownContact && contact) {
          knownContact = { name: contact.name, email: contact.email, phone: contact.phone };
        }

        if (contactId) {
          const { data: conv } = await supabase
            .from('conversations').select('id')
            .eq('workspace_id', workspaceId).eq('contact_id', contactId)
            .order('updated_at', { ascending: false }).limit(1).maybeSingle();
          if (conv) activeConvId = conv.id;
        }
      }

      return res.json({ known_contact: knownContact, conversation_id: activeConvId, visitor_id, contact_id: contactId });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err: any) {
    console.error('[widget-action] Error:', err.message);
    res.status(500).json({ error: 'Action failed' });
  }
});

// ═══════════════════════════════════════════════
// GET /manifest — Versioned runtime manifest
// ═══════════════════════════════════════════════
const RUNTIME_VERSION = '3.0.0';
const RUNTIME_BUILD_HASH = crypto.createHash('md5')
  .update(RUNTIME_VERSION + Date.now().toString())
  .digest('hex')
  .slice(0, 8);

widgetRouter.get('/manifest', widgetRateLimit('bootstrap'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = resolveWorkspaceId(req, res, req.query.workspace_id as string);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const supabase = getServiceClient(config);

  try {
    const { data: widgetData } = await supabase
      .from('widget_settings')
      .select('enabled, chat_enabled, kb_enabled, visitor_tracking_enabled, widget_language, theme')
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    if (widgetData?.enabled === false) {
      return res.json({ disabled: true });
    }

    const ws = { ...DEFAULT_WIDGET_SETTINGS, ...widgetData };

    const chatEnabled = ws.chat_enabled !== false;
    const kbEnabled = ws.kb_enabled !== false;
    const trackingEnabled = ws.visitor_tracking_enabled !== false;

    const deliveryOrigin = `${req.protocol}://${req.get('host')}`;
    const v = RUNTIME_BUILD_HASH;

    const modules: Array<{ id: string; enabled: boolean; url: string }> = [];
    if (trackingEnabled) {
      modules.push({ id: 'visitors', enabled: true, url: `${deliveryOrigin}/widget/modules/visitors.js?v=${v}` });
    }
    if (chatEnabled) {
      modules.push({ id: 'chat', enabled: true, url: `${deliveryOrigin}/widget/modules/chat.js?v=${v}` });
    }
    if (kbEnabled) {
      modules.push({ id: 'help-center', enabled: true, url: `${deliveryOrigin}/widget/modules/help-center.js?v=${v}` });
    }

    const runtimeJsName = getWidgetAssetName('runtime.js');
    const runtimeCssName = getWidgetAssetName('runtime.css');

    const manifest = {
      version: RUNTIME_VERSION,
      build: v,
      runtime_entry: `${deliveryOrigin}/widget/${runtimeJsName}?v=${v}`,
      styles: [`${deliveryOrigin}/widget/${runtimeCssName}?v=${v}`],
      modules,
      locale: {
        default: ws.widget_language === 'auto' ? ws.locale : ws.widget_language,
        available: ['en', 'fa', 'tr'],
      },
      theme: { id: ws.theme || 'modern' },
      features: {
        chat: chatEnabled,
        knowledge_base: kbEnabled,
        tracking: trackingEnabled,
      },
      config_url: `${deliveryOrigin}/api/widget/config?workspace_id=${workspaceId}`,
      created_at: new Date().toISOString(),
    };

    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return res.json(manifest);
  } catch (err: any) {
    console.error('[widget-manifest] Error:', err.message);
    return res.status(500).json({ error: 'Manifest generation failed' });
  }
});

// ═══════════════════════════════════════════════
// POST /validate-origin — Origin validation
// ═══════════════════════════════════════════════
widgetRouter.post('/validate-origin', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const { workspace_id, origin } = req.body;

  if (!workspace_id || !origin) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

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

// ═══════════════════════════════════════════════
// GET /kb — Legacy knowledge base endpoint
// ═══════════════════════════════════════════════
const kbQuerySchema = z.object({
  workspace_id: z.string().uuid(),
  locale: z.string().min(2).max(10).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional().default(6),
});

widgetRouter.get('/kb', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = kbQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  const { workspace_id, locale, limit } = parsed.data;
  const supabase = getServiceClient(config);

  try {
    let query = supabase
      .from('knowledge_base_articles')
      .select('id, title, excerpt, slug, locale')
      .eq('workspace_id', workspace_id)
      .eq('status', 'published')
      .order('sort_order', { ascending: true })
      .limit(limit);

    if (locale) query = query.eq('locale', locale);

    const { data: articles, error: kbError } = await query;
    if (kbError) throw kbError;

    res.json({ articles: articles || [] });
  } catch (err) {
    console.error('Widget KB error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});
