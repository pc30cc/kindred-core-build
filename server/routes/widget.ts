/**
 * Widget API — Full-featured widget backend
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
import { routeParam } from '../lib/routeParams.js';
import {
  publishConversationEvent,
  buildMessageEnvelope,
} from '../services/realtime/publish.js';
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
import { perfHttpMiddleware } from '../services/observability/perf.js';
import { getWidgetAssetName, getLoaderVersion, getManifestDiagnostics, invalidateManifestCache } from '../services/widget/manifest.js';
import { loadPublicSmartRules, recordSmartEvent } from '../services/widget/smartEngagement.js';
import {
  createSessionToken,
  verifySessionToken,
  verifyTokenForRefresh,
  enforceWidgetToken,
  enforceOrigin,
  widgetRateLimit,
  resolveWorkspaceId,
  verifyConversationOwnership,
  getClientIp,
  getRequestOrigin,
} from '../services/widget/security.js';
import { maybeRunAiAssistantAfterVisitorMessage } from '../services/ai-agent/engine.js';
import { getPlatformAiAgentSettings } from '../services/ai-agent/platformSettings.js';
import { clearAiManagementForPlatformOff, markNeedsHuman } from '../services/ai-agent/handoffState.js';
import { resolveVisitorIdentity, readVisitorCookie } from '../services/widget/visitorIdentity.js';
import {
  pinContactOnVisitorSessions,
  issueContinuityCookieForContact,
} from '../services/widget/crossWidgetIdentity.js';
import { widgetIdentityRouter } from './widgetIdentity.js';
import { widgetAttachmentsRouter, attachUploadedFileToMessage, enrichMessagesWithAttachments } from './widgetAttachments.js';
import { widgetCallbacksRouter } from './widgetCallbacks.js';
import { widgetDepartmentsRouter } from './widgetDepartments.js';
import { widgetCallInvitationsRouter } from './widgetCallInvitations.js';
import { recordConversationEvent } from '../services/conversationEvents.js';
import { extractHostname, isOriginAllowed } from '../utils/domain.js';
import { resolveAvailability, snapshotToWirePayload } from '../services/widget/availability.js';
import { sendEmail } from '../services/email/index.js';
import { enrichVisitorSessionGeo } from '../services/geo/index.js';
import { getClientCountry } from '../utils/clientIp.js';
import { checkTypingAllowed } from '../services/widget/typingRateLimit.js';
import { loadWidgetPlatformRuntimeSettings } from '../services/widget/platformSettings.js';
import { isActionActive } from '../services/observability/autoActionsCache.js';
import { emitMetric, emitLog } from '../services/observability/metrics.js';
import { resolveEffectivePolicy } from '../services/realtime/effectivePolicy.js';
import { enforceMaxConversationsLimit } from '../services/billing/conversationLimit.js';
import { enforceMaxVisitorsLimitIfNewThisMonth } from '../services/billing/visitorLimit.js';
import { getPlatformAllowedLocales } from '../services/platformRegion.js';

export const widgetRouter = Router();

// Mount identity sub-router (all routes require widget token + origin)
widgetRouter.use('/identity', widgetIdentityRouter);

// Phase 6a — Mount attachments sub-router (token + origin enforced inside)
widgetRouter.use('/attachments', widgetAttachmentsRouter);

// Phase 8D — Visitor-side callback request endpoint (token + origin
// enforced inside the sub-router — it is mounted before the parent's own
// enforceWidgetToken/enforceOrigin, so it cannot rely on those).
widgetRouter.use('/callback', widgetCallbacksRouter);

// Phase 8H — Widget-facing department visibility (token + origin enforced
// inside the sub-router). Used by the widget runtime to choose between
// general / single / multi mode.
widgetRouter.use('/departments', widgetDepartmentsRouter);

// Phase 9 — Widget-side Call Invitation join/decline. Sub-router enforces
// its own widget token + origin; visitor identity is verified via the
// existing conversation-ownership helper.
widgetRouter.use('/call-invitations', widgetCallInvitationsRouter);

// ─── Default widget settings ───
// Seeded English defaults. When the widget locale is not English these are
// treated as "unset" so the visitor sees a localized string instead of the
// leftover English seed value.
const SEED_LAUNCHER_TEXTS = ['chat with us', 'support', 'hello!'];
const SEED_WELCOME_TEXTS = ['hello! how can we help you?', 'how can we help you?'];
const LOCALIZED_WIDGET_DEFAULTS: Record<string, { launcher: string; welcome: string }> = {
  fa: { launcher: 'با ما گفتگو کنید', welcome: 'سلام! چطور می‌توانیم کمکتان کنیم؟' },
  tr: { launcher: 'Bizimle sohbet edin', welcome: 'Merhaba! Size nasıl yardımcı olabiliriz?' },
  en: { launcher: 'Chat with us', welcome: 'Hello! How can we help you?' },
};

function resolveLocalizedDefault(
  value: unknown,
  kind: 'launcher' | 'welcome',
  locale: string | null | undefined,
): string {
  const lang = String(locale || 'en').toLowerCase().split('-')[0];
  const defaults = LOCALIZED_WIDGET_DEFAULTS[lang] || LOCALIZED_WIDGET_DEFAULTS.en;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return lang === 'en' ? '' : defaults[kind];
  if (lang === 'en') return raw;
  const seeds = kind === 'launcher' ? SEED_LAUNCHER_TEXTS : SEED_WELCOME_TEXTS;
  if (seeds.includes(raw.toLowerCase())) return defaults[kind];
  return raw;
}

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
  // Voice notes — independent of file attachments (own toggle, own
  // fixed audio-mime allow-list server-side; see widgetAttachments.ts).
  voice_notes_enabled: false,
  // Emoji picker — client-side only, on by default.
  emoji_enabled: true,
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
widgetRouter.post('/bootstrap', widgetRateLimit('bootstrap'), perfHttpMiddleware('widget.bootstrap'), async (req: Request, res: Response) => {
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
    // Cloudflare/CDN-aware bypass — `Cache-Control: no-store` alone is not
    // always honored by edge caches that have their own override rules.
    res.set('CDN-Cache-Control', 'no-store');
    res.set('Cloudflare-CDN-Cache-Control', 'no-store');

    // Get branding for platform display name
    const { data: branding } = await supabase
      .from('workspace_branding')
      .select('platform_name')
      .eq('workspace_id', resolvedWorkspaceId)
      .maybeSingle();

    // Phase 8 — server-authoritative availability snapshot. Additive;
    // existing widget runtimes ignore unknown fields.
    let availabilityPayload: ReturnType<typeof snapshotToWirePayload> | null = null;
    try {
      const localeHint = (req.body && (req.body.locale as string)) ||
        (req.headers['accept-language'] as string | undefined)?.split(',')[0] ||
        'en';
      const snap = await resolveAvailability(config, {
        workspaceId: resolvedWorkspaceId,
        locale: localeHint,
      });
      availabilityPayload = snapshotToWirePayload(snap);
    } catch (err: any) {
      console.warn('[widget-bootstrap] availability resolve failed:', err?.message);
    }

    // Phase 6C — effective realtime policy snapshot. Additive payload;
    // older widget runtimes ignore the field, newer ones honor force_polling /
    // typing_suppressed / reconnect_backoff_multiplier without a separate
    // round-trip. Resolution is fail-open and never blocks bootstrap.
    const effective_policy = await resolveEffectivePolicy(config, {
      workspaceId: resolvedWorkspaceId,
    });

    return res.json({
      session_token: sessionToken,
      workspace_id: resolvedWorkspaceId,
      workspace_name: workspace.name,
      expires_at: tokenInfo.valid && tokenInfo.expiresAt ? new Date(tokenInfo.expiresAt * 1000).toISOString() : null,
      platform_display_name: branding?.platform_name || '',
      visitor_id: visitor.visitorId,
      is_new_visitor: visitor.isNew,
      availability: availabilityPayload,
      effective_policy,
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
widgetRouter.post('/session/refresh', widgetRateLimit('refresh'), perfHttpMiddleware('widget.session_refresh'), async (req: Request, res: Response) => {
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

    // Phase 6C — refresh handshake also returns the latest effective policy
    // snapshot so a long-lived widget tab picks up failover/lock/degraded
    // changes without needing a full re-bootstrap. Fail-open if resolution
    // hiccups — token refresh must never block.
    let effective_policy: Awaited<ReturnType<typeof resolveEffectivePolicy>> | null = null;
    try {
      const config = (req as any).serverConfig as ServerConfig;
      effective_policy = await resolveEffectivePolicy(config, { workspaceId });
    } catch (_err) {
      effective_policy = null;
    }

    return res.json({
      session_token: newToken,
      workspace_id: workspaceId,
      expires_at: newResult.expiresAt ? new Date(newResult.expiresAt * 1000).toISOString() : null,
      effective_policy,
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

  // /config drives runtime URLs (with hashed asset names). MUST never be
  // cached at the edge — a stale config returns dead asset URLs after
  // a deploy and the launcher silently fails.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('CDN-Cache-Control', 'no-store');
  res.set('Cloudflare-CDN-Cache-Control', 'no-store');

  try {
    const [
      { data: widget, error },
      { data: branding },
      { data: platformWidget },
      originRules,
      platformPreChatPolicy,
      { data: workspacePreChatFlags },
    ] = await Promise.all([
      supabase.from('widget_settings').select('*').eq('workspace_id', workspaceId).maybeSingle(),
      supabase.from('workspace_branding')
        .select('platform_name, logo_url, primary_color')
        .eq('workspace_id', workspaceId).maybeSingle(),
      // Single source of truth for widget URLs — never read platform_domains/branding for these.
      supabase.from('widget_platform_settings')
        .select('widget_loader_base_url, widget_asset_base_url, widget_public_base_url, widget_api_base_url, default_welcome_message')
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

    // Smart Engagement rules (active + published only). Failure here must
    // never take down /config — the helper already degrades to an empty list.
    const smartPayload = await loadPublicSmartRules(
      supabase,
      workspaceId,
      ws.smart_engagement_enabled === true,
    );

    // Get workspace info + team members
    const { data: workspace } = await supabase
      .from('workspaces').select('name').eq('id', workspaceId).maybeSingle();

    // Phase 4 — expose AI Agent activation snapshot so the widget can decide
    // whether to suppress the generic greeting. Best-effort; never blocks
    // the widget config response.
    let aiAgentInfo: {
      enabled: boolean;
      mode: string;
      introEnabled: boolean;
      suppressGreeting: boolean;
      agentName: string | null;
      agentLogoUrl: string | null;
      disabledByPlatform: boolean;
      disabledMessage: string | null;
      // Owner-configurable text for the inline pre-chat card shown when the
      // AI hands off to a human mid-conversation. Empty = client falls back
      // to its own built-in copy.
      handoffPrechatMessageLocalized: Record<string, string>;
    } = {
      enabled: false,
      mode: 'off',
      introEnabled: false,
      suppressGreeting: false,
      agentName: null,
      agentLogoUrl: null,
      disabledByPlatform: false,
      disabledMessage: null,
      handoffPrechatMessageLocalized: {},
    };
    try {
      // E12 — platform kill switch wins over workspace AI settings.
      // When the platform disables AI Agent globally we MUST advertise
      // it as disabled to the widget so it stops suppressing the generic
      // greeting and never requests the AI intro.
      const { getPlatformAiAgentSettings } = await import('../services/ai-agent/platformSettings.js');
      const platform = await getPlatformAiAgentSettings(config).catch(() => null);
      const platformDisabled = !!platform && platform.ai_agent_enabled === false;
      if (platformDisabled) {
        aiAgentInfo = {
          enabled: false,
          mode: 'off',
          introEnabled: false,
          suppressGreeting: false,
          agentName: null,
          agentLogoUrl: null,
          disabledByPlatform: true,
          disabledMessage: platform?.disabled_message || null,
          handoffPrechatMessageLocalized: {},
        };
      } else {
      const { data: aiSettings } = await supabase
        .from('ai_agent_settings')
        .select('enabled, mode, ai_intro_enabled, agent_name, agent_logo_url')
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      // Best-effort, separate from the query above on purpose: this column
      // ships in a migration that may not be applied to every environment
      // yet. Fetching it in the SAME select as the fields above would make
      // one missing column fail the whole lookup — which previously broke
      // suppressGreeting entirely (aiAgentInfo silently fell back to its
      // all-off default, forcing pre-chat to show for every visitor even
      // with AI correctly enabled). Never let this one field take down the
      // fields everything else here depends on.
      let handoffPrechatMessageLocalized: Record<string, string> = {};
      try {
        const { data: hpRow } = await supabase
          .from('ai_agent_settings')
          .select('handoff_prechat_message_localized')
          .eq('workspace_id', workspaceId)
          .maybeSingle();
        if (hpRow && (hpRow as any).handoff_prechat_message_localized
          && typeof (hpRow as any).handoff_prechat_message_localized === 'object') {
          handoffPrechatMessageLocalized = (hpRow as any).handoff_prechat_message_localized;
        }
      } catch (_) { /* column may not exist yet — fine, client has its own fallback copy */ }
      if (aiSettings) {
        const mode = String(aiSettings.mode || 'off');
        const isAuto = mode === 'auto_reply_when_offline'
          || mode === 'auto_reply_until_human_joins'
          || mode === 'auto_reply_always';
        const introEnabled = aiSettings.ai_intro_enabled !== false;
        // Effective AI Mode — a toggle+auto-mode being set is not sufficient
        // on its own; also require the platform kill-switch/feature/
        // entitlement gates before treating the AI as visitor-facing.
        // Deliberately NOT requiring a resolvable AI provider here: the
        // intro message this flag gates is static/templated
        // (server/services/ai-agent/intro.ts never calls resolveAIConfig),
        // so it doesn't need one. Gating pre-chat-skip on provider
        // resolvability caused prechat to show (and the intro to never
        // fire) for workspaces with the AI toggle correctly on whenever
        // provider resolution had ANY hiccup — worse than before. Whether
        // the AI can actually generate a conversational reply is enforced
        // independently, deeper in engine.ts's own reply pipeline.
        let visitorFacing = !!aiSettings.enabled && isAuto;
        try {
          const { classifyEffectiveAiMode } = await import('../services/ai-agent/effectiveMode.js');
          const { isAutoAnswerAllowedForWorkspace } = await import('../services/ai-agent/platformGuards.js');
          const platformGate = await isAutoAnswerAllowedForWorkspace(config, workspaceId);
          const classified = classifyEffectiveAiMode(platformGate.allowed === true, {
            enabled: !!aiSettings.enabled,
            mode: mode as any,
          });
          // 'provider_pending' means every non-provider gate passed —
          // exactly what this greeting-suppression decision needs.
          visitorFacing = classified.visitorFacing || classified.reason === 'provider_pending';
        } catch (_) { /* keep toggle-only fallback */ }
        aiAgentInfo = {
          enabled: !!aiSettings.enabled,
          mode,
          introEnabled,
          // Suppress the generic greeting only when AI will actually speak
          // first to the visitor — i.e. effectively enabled + intro enabled.
          suppressGreeting: visitorFacing && introEnabled,
          agentName: aiSettings.agent_name || null,
          agentLogoUrl: aiSettings.agent_logo_url || null,
          disabledByPlatform: false,
          disabledMessage: null,
          handoffPrechatMessageLocalized: handoffPrechatMessageLocalized,
        };
      }
      }
    } catch (e: any) {
      console.warn('[widget-config] ai_agent_settings lookup failed:', e?.message || e);
    }

    const { data: members } = await supabase
      .from('workspace_members').select('user_id').eq('workspace_id', workspaceId).limit(4);

    let teamMembers: Array<{ name: string; avatar: string | null; online: boolean }> = [];
    if (members?.length) {
      const { data: profiles } = await supabase
        .from('profiles').select('id, full_name, avatar_url')
        .in('id', members.map((m: any) => m.user_id));
      // Resolve who's online right now using the operator presence service
      // so the widget can render a green status dot on each avatar.
      let presenceByUser = new Map<string, 'online' | 'offline'>();
      try {
        const { listWorkspacePresence } = await import('../services/widget/operatorPresence.js');
        const presence = await listWorkspacePresence(config, workspaceId);
        for (const p of presence) presenceByUser.set(p.user_id, p.state);
      } catch (_) {}
      if (profiles) {
        teamMembers = profiles.map((p: any) => ({
          name: p.full_name || 'Operator',
          avatar: p.avatar_url,
          online: presenceByUser.get(p.id) === 'online',
        }));
        // Online operators first so the stack leads with available staff.
        teamMembers.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
      }
    }

    const apiBase = resolveWidgetApiBase({
      widgetApiBaseUrl: platformWidget?.widget_api_base_url,
      platformApiBaseUrl: null,
      requestBaseUrl: getRequestBaseUrl(req),
      allowRequestFallback: !platformWidget?.widget_api_base_url,
    });
    const assetBase = resolveWidgetAssetBase({
      widgetBaseUrl: platformWidget?.widget_asset_base_url,
      widgetLoaderBaseUrl: platformWidget?.widget_loader_base_url,
      widgetPublicBaseUrl: platformWidget?.widget_public_base_url,
      assetBaseUrl: platformWidget?.widget_asset_base_url,
      loaderAssetBase: getLoaderAssetBase(req),
    });

    const runtimeJsName = getWidgetAssetName('runtime.js');
    const runtimeCssName = getWidgetAssetName('runtime.css');
    const callRuntimeJsName = getWidgetAssetName('runtime-call.js');
    const chatModuleName = getWidgetAssetName('runtime-chat.js');
    const kbModuleName = getWidgetAssetName('runtime-kb.js');
    const smartEngineName = getWidgetAssetName('smart-engine.js');
    // Self-hosted LiveKit JS SDK. Hashed at build time so we can serve it
    // with `immutable, max-age=1y`. The widget never contacts a CDN for
    // this asset — see scripts/widget-hash.js VENDOR_FILES.
    const livekitSdkName = getWidgetAssetName('vendor/livekit-client.umd.min.js');
    const loaderVersion = getLoaderVersion();
    const preChat = buildPreChatConfig(platformPreChatPolicy, workspacePreChatFlags || []);
    // Platform region lock — a single-language deployment must serve the
    // widget only in that language, whatever the workspace row still holds.
    const platformLocales = await getPlatformAllowedLocales(config);
    const clampLoc = (loc: string | null | undefined, fallbackToFirst = true) => {
      const base = String(loc || '').toLowerCase().split('-')[0];
      if (base && platformLocales.includes(base)) return base;
      return fallbackToFirst ? (platformLocales[0] || 'en') : '';
    };
    const effectiveLocale = clampLoc(
      ws.widget_language && ws.widget_language !== 'auto' ? ws.widget_language : ws.locale,
    );
    const effectiveWidgetLanguage =
      platformLocales.length === 1
        ? platformLocales[0]
        : ws.widget_language && ws.widget_language !== 'auto'
          ? clampLoc(ws.widget_language)
          : 'auto';
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
      launcherText: resolveLocalizedDefault(
        ws.launcher_text,
        'launcher',
        effectiveLocale,
      ),
      // Three-tier resolution: workspace override → platform default → hardcoded fallback.
      // Stored in `widget_settings.welcome_message` (per-workspace) or
      // `widget_platform_settings.default_welcome_message` (platform-wide).
      welcomeMessage:
        resolveLocalizedDefault(
          ws.welcome_message,
          'welcome',
          effectiveLocale,
        )
        || platformWidget?.default_welcome_message
        || '',
      greetingMessage: ws.greeting_message || '',
      placeholderText: ws.placeholder_text || '',
      offlineMessage: ws.offline_message || '',
      position: ws.position || 'bottom-right',
      locale: effectiveLocale,
      widgetLanguage: effectiveWidgetLanguage,
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
      // Phase 8 — Server-authoritative availability. Computed via resolver
      // so runtime never has to interpret weekly schedules. Locked rules:
      //  - business_hours.enabled === false  =>  state = 'online' always.
      //  - offline_message comes from offline_message_localized (per-locale)
      //    with legacy offline_message as fallback. No translation pipeline.
      availability: snapshotToWirePayload(
        await resolveAvailability(config, {
          workspaceId,
          locale: effectiveLocale,
        }),
      ),
      // Phase 6a — Attachment config exposed to the widget runtime.
      // The widget enforces these as a UX guard; the backend re-validates.
      attachments: {
        enabled: ws.attachments_enabled === true,
        maxSizeMb: Math.max(1, Math.min(25, ws.attachments_max_size_mb ?? 10)),
        allowedMimes: Array.isArray(ws.attachments_allowed_mimes) && ws.attachments_allowed_mimes.length > 0
          ? ws.attachments_allowed_mimes
          : ['image/png','image/jpeg','image/webp','image/gif','application/pdf','text/plain'],
        maxCount: 1, // v1: single file per message
        // Voice notes — independent toggle from file attachments (own
        // fixed audio-mime allow-list is enforced server-side, not
        // configurable via allowedMimes above).
        voiceNotesEnabled: ws.voice_notes_enabled === true,
      },
      composer: {
        emojiEnabled: ws.emoji_enabled !== false,
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
      callRuntimeUrl: versionedAssetUrl(assetBase ? `${assetBase}/widget/${callRuntimeJsName}` : null),
      // Pass 1 — explicit LiveKit SDK URL. Self-hosted, hashed asset. The
      // call runtime MUST consume this and never fall back to a CDN. When
      // assetBase is unresolved (very unusual — most likely a misconfigured
      // deploy) we surface `null` so the widget can render a clear
      // `provider_not_ready` error instead of silently breaking.
      livekitSdkUrl: versionedAssetUrl(
        assetBase ? `${assetBase}/widget/${livekitSdkName}` : null,
      ),
      modules: {
        chat: versionedAssetUrl(assetBase ? `${assetBase}/widget/${chatModuleName}` : null),
        kb: versionedAssetUrl(assetBase ? `${assetBase}/widget/${kbModuleName}` : null),
      },
      // Smart Engagement — proactive rules. The payload is already
      // sanitized and stripped of management fields; evaluation happens in
      // the browser with the shared engine bundle.
      smart: {
        enabled: smartPayload.enabled,
        engineUrl: smartPayload.enabled
          ? versionedAssetUrl(assetBase ? `${assetBase}/widget/${smartEngineName}` : null)
          : null,
        rules: smartPayload.rules,
      },
      // Phase 4 — AI Agent snapshot. Used by the widget runtime to decide
      // whether to suppress the generic welcome greeting (the AI intro will
      // take its place after pre-chat).
      aiAgent: aiAgentInfo,
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

// ═══════════════════════════════════════════════
// POST /smart/event — Smart Engagement telemetry
// Token + origin enforced by the middleware above. Idempotent by key.
// ═══════════════════════════════════════════════
const smartEventSchema = z.object({
  rule_id: z.string().uuid(),
  rule_version: z.number().int().min(1).max(100000).optional(),
  event_type: z.enum(['shown', 'opened', 'dismissed', 'cta_clicked', 'widget_opened', 'conversation_started', 'suppressed']),
  visitor_id: z.string().max(120).optional().nullable(),
  session_id: z.string().max(120).optional().nullable(),
  page_path: z.string().max(500).optional().nullable(),
  idempotency_key: z.string().min(6).max(120),
});

widgetRouter.post('/smart/event', widgetRateLimit('default'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = resolveWorkspaceId(req, res, req.body?.workspace_id);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const parsed = smartEventSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });

  try {
    const supabase = getServiceClient(config);
    const result = await recordSmartEvent(supabase, {
      workspaceId,
      ruleId: parsed.data.rule_id,
      ruleVersion: parsed.data.rule_version,
      visitorId: parsed.data.visitor_id ?? null,
      sessionId: parsed.data.session_id ?? null,
      eventType: parsed.data.event_type,
      pagePath: parsed.data.page_path ?? null,
      idempotencyKey: parsed.data.idempotency_key,
    });
    if (!result.ok) {
      const status = result.reason === 'rule_workspace_mismatch' ? 403 : 400;
      return res.status(status).json({ error: result.reason || 'rejected' });
    }
    res.json({ ok: true });
  } catch (err: any) {
    console.error('[smart-event] failed:', err?.message || err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * Resolve operator profile (full_name + avatar_url) for any agent/ai message.
 * Single batched lookup keeps /poll and /history fast even on long threads.
 * Visitor + system messages are passed through unchanged.
 */
async function enrichMessagesWithSender(
  supabase: any,
  messages: any[],
  workspaceId?: string | null,
): Promise<any[]> {
  if (!messages || !messages.length) return messages || [];
  const ids = Array.from(new Set(
    messages
      .filter((m) => m._sender_id && (m.role === 'agent' || m.sender_type === 'agent' || m.sender_type === 'ai'))
      .map((m) => m._sender_id as string)
  ));
  let profileMap = new Map<string, { name: string | null; avatar: string | null }>();
  if (ids.length) {
    try {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, avatar_url')
        .in('id', ids);
      (profiles || []).forEach((p: any) => {
        profileMap.set(p.id, { name: p.full_name || null, avatar: p.avatar_url || null });
      });
    } catch (e: any) {
      console.warn('[widget-sender-enrich] profile lookup failed:', e?.message || e);
    }
  }
  // AI messages have no operator profile — their identity comes from the
  // agent settings (name + logo). Older rows may predate the metadata
  // snapshot, so fall back to the workspace's current agent settings.
  let aiDisplay: { name: string | null; avatar: string | null } | null = null;
  const hasAi = messages.some((m) => m.sender_type === 'ai');
  if (hasAi && workspaceId) {
    try {
      const { data: s } = await supabase
        .from('ai_agent_settings')
        .select('agent_name, agent_logo_url')
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      if (s) aiDisplay = { name: s.agent_name || null, avatar: s.agent_logo_url || null };
    } catch (e: any) {
      console.warn('[widget-sender-enrich] ai settings lookup failed:', e?.message || e);
    }
  }
  return messages.map((m) => {
    if (m.sender_type === 'ai') {
      const { _sender_id: _ignored, ...rest } = m;
      const meta = (m.metadata && typeof m.metadata === 'object') ? m.metadata : {};
      return {
        ...rest,
        sender_name: meta.agent_name || aiDisplay?.name || null,
        sender_avatar: meta.agent_logo_url || aiDisplay?.avatar || null,
      };
    }
    const { _sender_id, ...rest } = m;
    if (m.role === 'agent' || m.sender_type === 'agent' || m.sender_type === 'ai') {
      const profile = _sender_id ? profileMap.get(_sender_id) : null;
      return {
        ...rest,
        sender_name: profile?.name || null,
        sender_avatar: profile?.avatar || null,
      };
    }
    return rest;
  });
}

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
      const ownership = await verifyConversationOwnership(config, conversationId, workspaceId, visitorId, sessionId, req);
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
      .select('id, body, sender_type, sender_id, created_at, metadata, seen_at')
      .eq('conversation_id', activeConversationId)
      .order('created_at', { ascending: false })
      .limit(200);

    const baseMessages = (msgs || []).slice().reverse().map((m: any) => ({
      id: m.id,
      // Legacy 'role' kept for widget runtime compatibility — AI replies
      // collapse to 'agent' here so existing widget rendering still works.
      role: m.sender_type === 'contact' ? 'visitor' : m.sender_type === 'system' ? 'system' : 'agent',
      // Forward the raw enum so newer widget versions / analytics can
      // distinguish 'ai' from 'agent' without re-parsing metadata.
      sender_type: m.sender_type,
      // Raw sender id is needed below to look up profile (avatar/name).
      _sender_id: m.sender_id || null,
      text: m.body,
      time: m.created_at,
      metadata: m.metadata,
      // Phase 7 — lifecycle. Only ever set on visitor messages, only by an
      // operator-side action (mark_conversation_seen RPC). Monotonic.
      seen_at: m.seen_at || null,
    }));
    // Phase 6b — attach public-safe attachment metadata (no provider URLs)
    const enriched = await enrichMessagesWithAttachments(config, workspaceId, baseMessages);
    const messages = await enrichMessagesWithSender(supabase, enriched, workspaceId);

    let operatorInfo = null;
    if (conv.assigned_to) {
      const { data: profile } = await supabase
        .from('profiles').select('full_name, avatar_url')
        .eq('id', conv.assigned_to).maybeSingle();
      if (profile) operatorInfo = { name: profile.full_name, avatar: profile.avatar_url };
    }

    // Phase 8B — surface a `ringing` call session on this conversation as
    // `active_call` so the widget rings even when realtime is offline. This
    // is the polling-mode counterpart of the `call:incoming` envelope. The
    // payload intentionally OMITS token/turn — the widget MUST call the
    // visitor token endpoint on accept (separate route, served per call).
    let activeCall: { id: string; call_type: string; state: string } | null = null;
    try {
      const { data: ringing } = await supabase
        .from('call_sessions')
        .select('id, call_type, state')
        .eq('workspace_id', workspaceId)
        .eq('context_type', 'conversation')
        .eq('context_id', activeConversationId)
        .in('state', ['ringing', 'connecting'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (ringing) {
        activeCall = { id: ringing.id, call_type: ringing.call_type, state: ringing.state };
      }
    } catch { /* never break /poll on calls lookup */ }

    return res.json({
      status: conv.status || 'unknown',
      messages,
      operator: operatorInfo,
      operator_typing: false,
      conversation_id: activeConversationId,
      active_call: activeCall,
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

  const ownership = await verifyConversationOwnership(config, conversationId, workspaceId, visitorId, sessionId, req);
  if (!ownership.valid) {
    return res.status(403).json({ error: 'Access denied to this conversation', code: 'CONVERSATION_ACCESS_DENIED' });
  }

  const supabase = getServiceClient(config);
  const { data: msgs } = await supabase
    .from('conversation_messages')
    .select('id, body, sender_type, sender_id, created_at, metadata, seen_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(200);

  const baseMessages = (msgs || []).slice().reverse().map((m: any) => ({
    id: m.id,
    role: m.sender_type === 'contact' ? 'visitor' : m.sender_type === 'system' ? 'system' : 'agent',
    sender_type: m.sender_type,
    _sender_id: m.sender_id || null,
    text: m.body,
    time: m.created_at,
    metadata: m.metadata,
    // Phase 7 — lifecycle (see /poll for semantics).
    seen_at: m.seen_at || null,
  }));
  // Phase 6b — attach public-safe attachment metadata (no provider URLs)
  const enriched = await enrichMessagesWithAttachments(config, workspaceId, baseMessages);
  const messages = await enrichMessagesWithSender(supabase, enriched, workspaceId);

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
      .eq('visible_in_widget', true)
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
  /** Phase 8H — optional department selected by widget (single/multi mode). */
  department_id: z.string().uuid().optional().nullable(),
  /** E2C — sanitized page context (currentPageUrl/Origin/Path/Title/referrer). */
  page_context: z.object({
    currentPageUrl: z.string().max(1000).optional().nullable(),
    currentPageOrigin: z.string().max(255).optional().nullable(),
    currentPagePath: z.string().max(1000).optional().nullable(),
    currentPageTitle: z.string().max(300).optional().nullable(),
    referrer: z.string().max(1000).optional().nullable(),
  }).optional().nullable(),
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

  // ─── E2C — sanitize + validate visitor page context ──────────────────
  // We only trust pageContext if its origin matches the request Origin OR is
  // covered by the workspace allowed_domains. Otherwise we drop it silently
  // (no error to widget) so a forged context can never poison retrieval.
  let pageContext: {
    currentPageUrl: string | null;
    currentPageOrigin: string | null;
    currentPagePath: string | null;
    currentPageTitle: string | null;
    referrer: string | null;
    source: 'widget';
  } | null = null;
  try {
    // Accept both canonical and camelCase aliases for forward compat.
    const raw = (data as any).page_context || (req.body && (req.body as any).pageContext) || null;
    const debugPC = process.env.DEBUG_WIDGET_PAGE_CONTEXT === '1';
    if (debugPC) {
      console.log('[widget-page-ctx] received', { workspaceId, hasRaw: !!raw });
    }
    if (raw && typeof raw === 'object') {
      const sanitizeStr = (v: any, max: number) =>
        (typeof v === 'string' && v.trim()) ? v.trim().slice(0, max) : null;
      const sanitizeUrl = (raw: string | null): string | null => {
        if (!raw) return null;
        try {
          const u = new URL(raw);
          u.hash = '';
          for (const k of ['token','access_token','refresh_token','code','password','session','auth','key','secret','api_key','sig','signature']) {
            u.searchParams.delete(k);
          }
          const s = u.toString();
          return s.slice(0, 1000);
        } catch { return null; }
      };
      const cleanUrl = sanitizeUrl(sanitizeStr(raw.currentPageUrl, 1000));
      const cleanRef = sanitizeUrl(sanitizeStr(raw.referrer, 1000));
      const reqOrigin = (req.headers.origin as string) || '';
      const reqOriginHost = extractHostname(reqOrigin);
      const ctxHost = cleanUrl ? extractHostname(cleanUrl) : null;
      // Pull workspace allowed_domains for cross-check.
      let allowedDomains: string[] = [];
      let allowSubdomains = false;
      try {
        const { data: ws } = await supabase
          .from('widget_settings')
          .select('allowed_domains, allow_subdomains')
          .eq('workspace_id', workspaceId).maybeSingle();
        allowedDomains = (ws?.allowed_domains as string[] | null) || [];
        allowSubdomains = !!ws?.allow_subdomains;
      } catch { /* best-effort */ }
      const matchesReqOrigin = !!(reqOriginHost && ctxHost && reqOriginHost === ctxHost);
      const matchesWorkspace = !!(cleanUrl && (allowedDomains.length === 0 || isOriginAllowed(cleanUrl, allowedDomains, allowSubdomains)));
      if (cleanUrl && (matchesReqOrigin || matchesWorkspace)) {
        let parsed: URL | null = null;
        try { parsed = new URL(cleanUrl); } catch { parsed = null; }
        pageContext = {
          currentPageUrl: cleanUrl,
          currentPageOrigin: parsed?.origin || sanitizeStr(raw.currentPageOrigin, 255),
          currentPagePath: parsed?.pathname || sanitizeStr(raw.currentPagePath, 1000),
          currentPageTitle: sanitizeStr(raw.currentPageTitle, 300),
          referrer: cleanRef,
          source: 'widget',
        };
        if (debugPC) console.log('[widget-page-ctx] accepted', {
          workspaceId, currentPageUrl: cleanUrl, ctxHost, reqOriginHost,
        });
      } else if (cleanUrl) {
        // Gated: probing bots can otherwise flood logs. Security-relevant
        // events are still observable via DEBUG_WIDGET_PAGE_CONTEXT=1.
        if (debugPC) {
          console.warn('[widget-page-ctx] rejected', {
            workspaceId, ctxHost, reqOriginHost,
            reason: !ctxHost ? 'invalid_url' : (matchesReqOrigin ? 'unknown' : 'domain_not_allowed'),
          });
        }
      }
    }
  } catch (err: any) {
    console.warn('[widget-message] page_context parse failed:', err?.message || err);
    pageContext = null;
  }

  try {
    // Verify widget is enabled
    const { data: widget } = await supabase
      .from('widget_settings').select('enabled, chat_enabled')
      .eq('workspace_id', workspaceId).maybeSingle();

    if (!widget?.enabled || widget.chat_enabled === false) {
      return res.status(403).json({ error: 'Chat not enabled' });
    }

    // Pass E12-Hardening — compute platform-AI-off verdict once. When OFF,
    // we must not run any AI side-effects and must restore conversations
    // out of the Automated inbox so they appear in Main Inbox.
    let platformAiOff = false;
    let platformAiOffReason: 'platform_ai_disabled' | 'customer_ai_hidden' | 'auto_answer_disabled' = 'platform_ai_disabled';
    try {
      const platform = await getPlatformAiAgentSettings(config);
      if (platform.ai_agent_enabled === false) {
        platformAiOff = true;
        platformAiOffReason = 'platform_ai_disabled';
      } else if (platform.customer_ai_agent_visible === false) {
        platformAiOff = true;
        platformAiOffReason = 'customer_ai_hidden';
      } else if (platform.auto_answer_enabled === false) {
        platformAiOff = true;
        platformAiOffReason = 'auto_answer_disabled';
      }
    } catch { /* fail-open if settings table missing */ }

    let convId = body.conversation_id || null;

    // Verify conversation ownership if provided
    if (convId) {
      const ownership = await verifyConversationOwnership(config, convId, workspaceId, body.visitor_id, body.session_id, req);
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
          // Prefer an existing open/pending thread for this contact so
          // returning visitors land in the same conversation instead of
          // spawning a new one each visit.
          let { data: existingConv } = await supabase
            .from('conversations').select('id')
            .eq('workspace_id', workspaceId).eq('contact_id', contact.id)
            .in('status', ['open', 'pending'])
            .order('updated_at', { ascending: false }).limit(1).maybeSingle();
          // Fallback to most recent (any status) — caller may reopen.
          if (!existingConv) {
            const r = await supabase
              .from('conversations').select('id')
              .eq('workspace_id', workspaceId).eq('contact_id', contact.id)
              .order('updated_at', { ascending: false }).limit(1).maybeSingle();
            existingConv = r.data || null;
          }
          if (existingConv) {
            convId = existingConv.id;
            await supabase.from('conversations')
              .update({ status: 'open', updated_at: new Date().toISOString() })
              .eq('id', convId);
          }
        }
      }

      // Final fallback: if we still don't have a conv but the visitor sent
      // identity fields (email/phone), look up the contact directly and
      // attach to their most recent open thread. Covers cross-device returns
      // where the visitor cookie is fresh but the contact already exists.
      if (!convId && (body.visitor_email || body.visitor_phone)) {
        const email = (body.visitor_email || '').trim().toLowerCase() || null;
        const phone = (body.visitor_phone || '').trim().replace(/[^\d+]/g, '') || null;
        let contactRow: any = null;
        if (email) {
          const r = await supabase
            .from('contacts').select('id')
            .eq('workspace_id', workspaceId).eq('email', email)
            .limit(1).maybeSingle();
          contactRow = r.data;
        }
        if (!contactRow && phone) {
          const r = await supabase
            .from('contacts').select('id')
            .eq('workspace_id', workspaceId).eq('phone', phone)
            .limit(1).maybeSingle();
          contactRow = r.data;
        }
        if (contactRow) {
          const { data: openConv } = await supabase
            .from('conversations').select('id')
            .eq('workspace_id', workspaceId).eq('contact_id', contactRow.id)
            .in('status', ['open', 'pending'])
            .order('updated_at', { ascending: false }).limit(1).maybeSingle();
          if (openConv) {
            convId = openConv.id;
            await supabase.from('conversations')
              .update({ status: 'open', updated_at: new Date().toISOString() })
              .eq('id', convId);
          }
        }
      }
    }

    // Create new conversation
    if (!convId) {
      // Phase 5 — enforce max_conversations only on this creation
      // branch. Replies into an existing conversation (the branches
      // above) intentionally bypass the cap. workspace_id has already
      // been resolved via resolveWorkspaceId() + widget token checks.
      {
        const ok = await enforceMaxConversationsLimit(req, res);
        if (!ok) return;
      }

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

      // Cross-widget continuity: pin the contact on this device's visitor
      // sessions and refresh the continuity cookie so the CALL widget skips
      // its pre-call form for the same person.
      if (contactId) {
        try {
          const cookieVisitorId = readVisitorCookie(req, workspaceId)?.v || body.visitor_id || null;
          if (cookieVisitorId) {
            await pinContactOnVisitorSessions(supabase, workspaceId, cookieVisitorId, contactId);
          }
          await issueContinuityCookieForContact(
            supabase, req, res, workspaceId, contactId, 'chat_widget',
          );
        } catch (e: any) {
          console.warn('[widget] cross-widget identity link failed:', e?.message || e);
        }
      }

      const subjectText = body.message ? body.message.slice(0, 80) : (data.attachment_id ? '[Attachment]' : null);
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

      // Phase 4b — record canonical 'created' timeline event.
      // Payload contract: { source: 'widget' }
      void recordConversationEvent(config, {
        workspaceId,
        conversationId: convId!,
        eventType: 'created',
        actorType: 'visitor',
        actorId: null,
        payload: { source: 'widget' },
      });
      // If the visitor was already identified at conversation creation
      // (pre-chat or continuity restored), surface that as 'identified'
      // so the timeline reflects how the contact attached.
      if (contactId) {
        void recordConversationEvent(config, {
          workspaceId,
          conversationId: convId!,
          eventType: 'identified',
          actorType: 'visitor',
          actorId: null,
          payload: {
            contact_id: contactId,
            method: body.visitor_email ? 'email' : (body.visitor_phone ? 'phone' : 'visitor_id'),
            is_new_contact: false,
          },
        });
      }
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
          department_id: data.department_id || undefined,
          page_context: pageContext || undefined,
        },
      })
      .select('id, conversation_id, sender_type, body, created_at, metadata, seen_at')
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

    // Pass E12-Hardening — when platform AI is OFF, ensure this conversation
    // is NOT stuck in Automated. Clears AI-managed metadata defensively for
    // both new and reused conversations (idempotent; no-op if nothing set).
    if (platformAiOff && convId) {
      try {
        const restored = await clearAiManagementForPlatformOff(config, {
          workspaceId,
          conversationId: convId,
          reason: platformAiOffReason,
        });
        console.log('[widget-message] platform_ai_disabled_restore', {
          workspace_id: workspaceId,
          conversation_id: convId,
          reason: platformAiOffReason,
          previous_ai_state: restored.previousAiState,
          restored_to_main_inbox: restored.changed,
        });
      } catch (e: any) {
        console.warn('[widget-message] platform_ai_disabled_restore_failed:', e?.message || e);
      }
    }

    // Realtime: broadcast the visitor message to the inbox subscriber.
    // Fire-and-forget — DB row is the source of truth.
    if (insertedMsg) {
      publishConversationEvent(
        config,
        workspaceId,
        convId!,
        buildMessageEnvelope(insertedMsg as any),
      ).catch(() => {});
    }

    // ─────────────────────────────────────────────────────────────────────
    // Phase 3 — AI Agent runtime.
    //
    // The engine respects ai_agent_settings.mode and runtime policy:
    //   - off / disabled                → no-op
    //   - suggest_only                  → operator-only suggestion
    //   - auto_reply_when_offline       → reply when operators offline
    //   - auto_reply_until_human_joins  → reply until human posts
    //   - auto_reply_always             → reply (capped + safety)
    //
    // Fire-and-forget: must never block the widget /message response.
    // ─────────────────────────────────────────────────────────────────────
    if (insertedMsg?.id && convId && !platformAiOff) {
      void maybeRunAiAssistantAfterVisitorMessage(config, {
        workspaceId,
        conversationId: convId,
        visitorMessageId: insertedMsg.id,
        question: messageBody,
        locale: (req.body && (req.body.locale as string)) || undefined,
        pageContext: pageContext || undefined,
      }).catch((e: any) =>
        console.warn('[widget-message] AI Agent engine error:', e?.message || e),
      );
    }
    if (platformAiOff && insertedMsg?.id && convId) {
      console.log('[widget-message] ai_skipped_platform_disabled', {
        workspace_id: workspaceId,
        conversation_id: convId,
        reason: platformAiOffReason,
      });
    }
    const reply: string | null = null;

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
      // Privacy gate: only persist raw IP when the workspace explicitly
      // opts in — same setting + same rule as /api/visitors/track. This
      // endpoint (the chat widget's own background tracker, loader.js) was
      // never actually reading it, so a raw IP was never stored for ANY
      // chat-widget visitor regardless of the toggle — contacts.ts's /ip
      // lookup and identityMerge's location enrichment had nothing to read.
      let storeRawIp = false;
      try {
        const { data: ws } = await supabase
          .from('widget_settings')
          .select('store_raw_ip')
          .eq('workspace_id', workspaceId)
          .maybeSingle();
        storeRawIp = (ws as any)?.store_raw_ip === true;
      } catch { /* default to not storing on lookup failure */ }
      const ipRawForStorage = storeRawIp ? clientIp : null;

      // Check for existing recent session
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { data: existing } = await supabase
        .from('visitor_sessions').select('id')
        .eq('workspace_id', workspaceId).eq('visitor_id', visitor_id || '')
        .gte('last_seen_at', thirtyMinAgo)
        .order('last_seen_at', { ascending: false }).limit(1).maybeSingle();

      if (existing) {
        activeSessionId = existing.id;
        // Detect URL change BEFORE we overwrite current_page so we can log it.
        const { data: prevRow } = await supabase.from('visitor_sessions')
          .select('current_page').eq('id', existing.id).maybeSingle();
        const prevPage = prevRow?.current_page ?? null;
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

        // Append a page-view row when the URL is new for this session.
        // First page_view of an existing session also counts (prevPage may
        // be null on rehydrated sessions).
        if (normalizedPageUrl && normalizedPageUrl !== prevPage) {
          try {
            await supabase.from('visitor_page_views').insert({
              workspace_id: workspaceId,
              visitor_session_id: existing.id,
              url: String(normalizedPageUrl).slice(0, 2048),
              title: page_title ? String(page_title).slice(0, 300) : null,
            });
          } catch (e: any) {
            console.warn('[widget-track] page-view insert failed:', e?.message);
          }
        }
      } else if (visitor_id) {
        // Phase 10 — gate true-new-this-month visitors on the public widget
        // /track endpoint. Reuses the Phase 9 helper so the trigger remains
        // the sole writer of `workspace_usage_counters.visitors_count` and
        // in-month revisits / 30-min reconnects stay ungated.
        const ok = await enforceMaxVisitorsLimitIfNewThisMonth(
          req,
          res,
          supabase,
          workspaceId,
          visitor_id,
        );
        if (!ok) return;
        const { data: newSession } = await supabase
          .from('visitor_sessions').insert({
            workspace_id: workspaceId,
            visitor_id,
            current_page: normalizedPageUrl,
            referrer: referrer || null,
            ip_hash: ipHash,
            ip_raw: ipRawForStorage,
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
          // Always log the very first page view of a brand-new session.
          if (normalizedPageUrl) {
            try {
              await supabase.from('visitor_page_views').insert({
                workspace_id: workspaceId,
                visitor_session_id: newSession.id,
                url: String(normalizedPageUrl).slice(0, 2048),
                title: page_title ? String(page_title).slice(0, 300) : null,
              });
            } catch (e: any) {
              console.warn('[widget-track] first page-view insert failed:', e?.message);
            }
          }
          // Fire-and-forget geo enrichment — never block the widget response.
          // Uses MaxMind local DB when configured (city-level), with cache.
          void enrichVisitorSessionGeo(config, {
            sessionId: newSession.id,
            workspaceId,
            ipHash,
            rawIp: clientIp,
            country: getClientCountry(req),
          });
        }
      }

      // Existing-session path: enrich if geo fields are still empty (e.g.
      // session was created before MaxMind was configured).
      if (activeSessionId) {
        void (async () => {
          try {
            const { data: row } = await supabase
              .from('visitor_sessions')
              .select('geo_resolved_at')
              .eq('id', activeSessionId)
              .maybeSingle();
            if (!row || !row.geo_resolved_at) {
              await enrichVisitorSessionGeo(config, {
                sessionId: activeSessionId!,
                workspaceId,
                ipHash,
                rawIp: clientIp,
                country: getClientCountry(req),
              });
            }
          } catch {/* best-effort */}
        })();
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
widgetRouter.put('/action', widgetRateLimit('default'), perfHttpMiddleware('widget.action'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = resolveWorkspaceId(req, res, req.body?.workspace_id);
  if (res.headersSent) return;

  const { action, conversation_id, visitor_id, session_id, visitor_name, visitor_email, visitor_phone, current_page, page_title } = req.body;
  const supabase = getServiceClient(config);

  try {
    if (action === 'heartbeat' && workspaceId) {
      const now = new Date().toISOString();

      if (conversation_id) {
        const ownership = await verifyConversationOwnership(config, conversation_id, workspaceId, visitor_id, session_id, req);
        if (!ownership.valid) {
          // Task 6 — surface the precise rejection reason in logs (never to
          // the client) so 403 spikes can be diagnosed without weakening
          // auth. The client receives only the safe code.
          console.warn(
            `[widget-action] heartbeat denied: workspace=${workspaceId} conv=${conversation_id} ` +
              `visitor=${visitor_id || 'none'} session=${session_id || 'none'}`,
          );
          return res.status(403).json({ error: 'Access denied', code: 'CONVERSATION_ACCESS_DENIED' });
        }
        await supabase.from('conversations').update({ updated_at: now }).eq('id', conversation_id);
        return res.json({ ok: true });
      }

      if (session_id) {
        // Read the previous current_page first so heartbeats only log a new
        // page-view row when the URL actually changed (avoids ~120 rows/hr
        // of duplicates from the 30 s heartbeat loop).
        const { data: prevSess } = await supabase.from('visitor_sessions')
          .select('current_page').eq('id', session_id).maybeSingle();
        const prevPage = prevSess?.current_page ?? null;

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

        if (current_page && current_page !== prevPage) {
          try {
            await supabase.from('visitor_page_views').insert({
              workspace_id: workspaceId,
              visitor_session_id: session_id,
              url: String(current_page).slice(0, 2048),
              title: page_title ? String(page_title).slice(0, 300) : null,
            });
          } catch (e: any) {
            console.warn('[widget-action] page-view insert failed:', e?.message);
          }
        }

        return res.json({ ok: true });
      }

      return res.status(400).json({ error: 'session_id or conversation_id required' });
    }

    if (action === 'typing' && conversation_id) {
      const ownership = await verifyConversationOwnership(config, conversation_id, workspaceId!, visitor_id, session_id, req);
      if (!ownership.valid) {
        console.warn(
          `[widget-action] typing denied: workspace=${workspaceId} conv=${conversation_id} ` +
            `visitor=${visitor_id || 'none'} session=${session_id || 'none'}`,
        );
        return res.status(403).json({ error: 'Access denied', code: 'CONVERSATION_ACCESS_DENIED' });
      }
      // Phase 5C.1 — suppress typing entirely while the
      // disable_typing_temporarily auto-action is active. We still
      // return 200 ok so the widget never sees an error or retries.
      if (isActionActive('disable_typing_temporarily')) {
        emitLog(config, 'info', 'auto_action_effect_applied', {
          action_type: 'disable_typing_temporarily',
          workspace_id: workspaceId,
          conversation_id,
          surface: 'widget',
          ts: Date.now(),
        });
        return res.json({ ok: true, published: false, reason: 'auto_action_suppressed' });
      }
      // Phase 1.1 — server-side typing rate limit.
      // Per-conversation sliding-window cap (default: 2 publishes / 2000ms).
      // Overflow is silently dropped — we still return 200 ok so the widget
      // never sees an error and never retries. Typing is best-effort.
      const platform = await loadWidgetPlatformRuntimeSettings(config);
      if (!checkTypingAllowed(conversation_id, platform.typing)) {
        emitMetric(config, {
          metric: 'widget.typing_rate_limited',
          workspaceId,
          conversationId: conversation_id,
          tags: {
            window_ms: platform.typing.windowMs,
            max_events: platform.typing.maxEvents,
          },
        });
        return res.json({ ok: true, published: false, reason: 'rate_limited' });
      }
      // Publish ephemeral typing event on the canonical conversation channel
      // (ws:<workspace_id>:conv:<cid>) using the active realtime publisher
      // (Centrifugo or Supabase). Polling clients silently miss it — typing
      // is best-effort by design.
      const pub = await publishConversationEvent(config, workspaceId!, conversation_id, {
        type: 'typing',
        payload: {
          actor: 'visitor',
          conversation_id,
          ts: Date.now(),
        },
      });
      return res.json({ ok: true, published: pub.ok });
    }

    if (action === 'reopen_conversation' && conversation_id && workspaceId) {
      const ownership = await verifyConversationOwnership(config, conversation_id, workspaceId, visitor_id, session_id, req);
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
// POST /escalate — Visitor-initiated "talk to a human" request.
// Invokes the existing AI handoff state machine (markNeedsHuman) so the
// conversation moves to `needs_human` in the inbox and the AI stops
// auto-replying — the same transition that keyword-detection already
// triggers server-side, just reachable from an explicit widget button
// instead of requiring the visitor to type the right words.
// ═══════════════════════════════════════════════
const escalateSchema = z.object({
  conversation_id: z.string().uuid(),
  visitor_id: z.string().min(1).max(255).optional(),
  session_id: z.string().uuid().nullable().optional(),
});
widgetRouter.post('/escalate', widgetRateLimit('default'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = resolveWorkspaceId(req, res, req.body?.workspace_id);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const parsed = escalateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const { conversation_id, visitor_id, session_id } = parsed.data;

  const ownership = await verifyConversationOwnership(config, conversation_id, workspaceId, visitor_id, session_id, req);
  if (!ownership.valid) {
    return res.status(403).json({ error: 'Access denied', code: 'CONVERSATION_ACCESS_DENIED' });
  }

  try {
    await markNeedsHuman(config, { workspaceId, conversationId: conversation_id, reason: 'human_request' });
    void recordConversationEvent(config, {
      workspaceId,
      conversationId: conversation_id,
      eventType: 'escalation_requested',
      actorType: 'visitor',
      payload: { source: 'widget_button' },
    });
    return res.json({ ok: true });
  } catch (err: any) {
    console.error('[widget-escalate] Error:', err.message);
    return res.status(500).json({ error: 'escalate_failed' });
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

/**
 * Visitor-side call state poll (Phase 8B fallback).
 *
 * The widget runtime keeps an open realtime channel and rings instantly on
 * `call:incoming` envelopes. When realtime is disabled or briefly down, the
 * widget falls back to polling THIS endpoint every 2 s to detect a session
 * that has transitioned into `ringing`.
 *
 * Auth: widget token + origin (already enforced by parent middleware) plus
 * conversation ownership — the call must belong to a conversation owned by
 * this visitor session. No operator-only fields are returned.
 */
widgetRouter.get('/calls/:id/state', widgetRateLimit('poll'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = resolveWorkspaceId(req, res, req.query.workspace_id as string);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const callId = req.params.id;
  if (!callId) return res.status(400).json({ error: 'call id required' });

  const supabase = getServiceClient(config);
  const { data: session, error } = await supabase
    .from('call_sessions')
    .select('id, workspace_id, call_type, context_type, context_id, state, recording_enabled')
    .eq('id', callId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error || !session) return res.status(404).json({ error: 'call_not_found' });
  if (session.context_type !== 'conversation' || !session.context_id) {
    return res.status(403).json({ error: 'call_context_not_widget' });
  }

  const visitorId = (req.query.visitor_id as string) || null;
  const sessionId = (req.query.session_id as string) || null;
  const ownership = await verifyConversationOwnership(
    config,
    session.context_id,
    workspaceId,
    visitorId,
    sessionId,
    req,
  );
  if (!ownership.valid) {
    return res.status(403).json({ error: 'call_access_denied' });
  }

  res.json({
    id: session.id,
    state: session.state,
    call_type: session.call_type,
    recording: !!session.recording_enabled,
  });
});

/**
 * Visitor token endpoint (Phase 8B).
 *
 * Mints a visitor-scoped LiveKit participant token + RTC/TURN bundle for an
 * existing call session. Used by the widget when accepting a call delivered
 * over the polling fallback (where the realtime envelope's pre-minted token
 * was unavailable).
 *
 * Auth: widget token + origin + conversation ownership. Operator tokens are
 * NEVER returned here — participantType is forced to 'visitor'.
 */
widgetRouter.post('/calls/:id/visitor-token', widgetRateLimit('default'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = resolveWorkspaceId(req, res, req.body?.workspace_id);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const callId = req.params.id;
  const supabase = getServiceClient(config);
  const { data: session, error } = await supabase
    .from('call_sessions')
    .select('id, workspace_id, provider, provider_room_id, call_type, context_type, context_id, state, recording_enabled')
    .eq('id', callId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error || !session) return res.status(404).json({ error: 'call_not_found' });
  if (session.context_type !== 'conversation' || !session.context_id) {
    const { CALL_ERROR_CODES, CALL_ERROR_HTTP_STATUS, callErrorBody } =
      await import('../services/calls/errorCodes.js');
    return res.status(CALL_ERROR_HTTP_STATUS.invitation_access_denied).json(
      callErrorBody(
        CALL_ERROR_CODES.INVITATION_ACCESS_DENIED,
        'Call is not associated with a widget conversation.',
      ),
    );
  }
  if (!session.provider_room_id) {
    const { CALL_ERROR_CODES, CALL_ERROR_HTTP_STATUS, callErrorBody } =
      await import('../services/calls/errorCodes.js');
    return res.status(CALL_ERROR_HTTP_STATUS.room_create_failed).json(
      callErrorBody(
        CALL_ERROR_CODES.ROOM_CREATE_FAILED,
        'Provider room is not ready.',
        { provider: session.provider },
      ),
    );
  }

  const visitorId = (req.body?.visitor_id as string) || null;
  const sessionId = (req.body?.session_id as string) || null;
  const ownership = await verifyConversationOwnership(
    config,
    session.context_id,
    workspaceId,
    visitorId,
    sessionId,
    req,
  );
  if (!ownership.valid) {
    const { CALL_ERROR_CODES, CALL_ERROR_HTTP_STATUS, callErrorBody } =
      await import('../services/calls/errorCodes.js');
    return res.status(CALL_ERROR_HTTP_STATUS.invitation_access_denied).json(
      callErrorBody(
        CALL_ERROR_CODES.INVITATION_ACCESS_DENIED,
        'Visitor does not own this call.',
      ),
    );
  }

  try {
    // Lazy import to avoid pulling provider modules into the widget request
    // path on cold start when calls are disabled.
    const { resolveCallProvider } = await import('../services/calls/providerResolver.js');
    const { getCallNetworkBundle } = await import('../services/calls/rtcResolver.js');
    const { mintTurnCreds } = await import('../services/calls/turnAuth.js');
    const { CALL_ERROR_CODES, CALL_ERROR_HTTP_STATUS, callErrorBody, callErrorFromUnknown } =
      await import('../services/calls/errorCodes.js');

    const provider = resolveCallProvider(session.provider);
    let visitorIdentity = 'visitor:' + session.context_id;
    try {
      const { data: vs } = await supabase
        .from('visitor_sessions')
        .select('visitor_id')
        .eq('id', sessionId || '')
        .maybeSingle();
      if (vs?.visitor_id) visitorIdentity = 'visitor:' + vs.visitor_id;
    } catch { /* */ }

    let minted;
    try {
      minted = await provider.createParticipantToken(config, {
        callSessionId: session.id,
        providerRoomId: session.provider_room_id,
        participantId: visitorIdentity,
        participantType: 'visitor',
        displayName: 'Visitor',
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        ttlSeconds: 600,
      });
    } catch (mintErr) {
      const mapped = callErrorFromUnknown(mintErr, {
        code: CALL_ERROR_CODES.TOKEN_MINT_FAILED,
        message: 'Failed to mint visitor token.',
        provider: session.provider,
      });
      return res.status(mapped.status).json(mapped.body);
    }

    const network = await getCallNetworkBundle(config);
    const turn = { ...network.turn };
    if (turn.static_secret_present && turn.urls.length > 0) {
      try {
        const { data: rtcRow } = await supabase
          .from('app_runtime_config')
          .select('value')
          .eq('key', 'call_rtc_endpoints')
          .maybeSingle();
        const sharedSecret = (rtcRow?.value as any)?.turn?.shared_secret;
        if (typeof sharedSecret === 'string' && sharedSecret.length > 0) {
          const m = mintTurnCreds({ sharedSecret, identity: 'call:' + session.id, ttlSeconds: 600 });
          turn.username = m.username;
          turn.credential = m.credential;
        }
      } catch { /* fallback to static */ }
    }

    res.json({
      token: minted.token,
      expires_at: minted.expiresAt,
      ws_url: network.ws_url,
      rtc_url: network.rtc_url,
      turn: { urls: turn.urls, username: turn.username, credential: turn.credential },
      ice_policy: network.ice_policy,
      call_type: session.call_type,
      recording: !!session.recording_enabled,
      warnings: [
        ...(turn.urls.length === 0 ? [CALL_ERROR_CODES.TURN_MISSING] : []),
      ],
    });
  } catch (err: any) {
    const { CALL_ERROR_CODES, CALL_ERROR_HTTP_STATUS, callErrorBody } =
      await import('../services/calls/errorCodes.js');
    if (err?.providerId) {
      return res.status(CALL_ERROR_HTTP_STATUS.provider_not_ready).json(
        callErrorBody(
          CALL_ERROR_CODES.PROVIDER_NOT_READY,
          err.message || 'Call provider is not ready.',
          { provider: err.providerId },
        ),
      );
    }
    console.error('[widget-calls/visitor-token] error:', err?.message || err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

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
    const callRuntimeJsName = getWidgetAssetName('runtime-call.js');
    const livekitSdkName = getWidgetAssetName('vendor/livekit-client.umd.min.js');

    const manifest = {
      version: RUNTIME_VERSION,
      build: v,
      runtime_entry: `${deliveryOrigin}/widget/${runtimeJsName}?v=${v}`,
      styles: [`${deliveryOrigin}/widget/${runtimeCssName}?v=${v}`],
      call_runtime_entry: `${deliveryOrigin}/widget/${callRuntimeJsName}?v=${v}`,
      livekit_sdk_entry: `${deliveryOrigin}/widget/${livekitSdkName}?v=${v}`,
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

    // Manifest carries hashed asset names — must NOT be cached by edge
    // CDNs across deploys. Browser may keep its own short cache.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('CDN-Cache-Control', 'no-store');
    res.set('Cloudflare-CDN-Cache-Control', 'no-store');
    return res.json(manifest);
  } catch (err: any) {
    console.error('[widget-manifest] Error:', err.message);
    return res.status(500).json({ error: 'Manifest generation failed' });
  }
});

// ═══════════════════════════════════════════════
// GET /manifest-debug — Diagnostics for asset resolution (Task 5)
// ───────────────────────────────────────────────
// Returns the in-memory state of the widget asset manifest resolver:
// which source was used (local FS / remote / fallback), which hashed
// asset names are currently being served, and ETag/cache state. Useful
// for verifying that a deploy has propagated.
//
// Security: token-secured (sits below enforceWidgetToken). No secrets
// are exposed — only public asset names + cache metadata.
// ═══════════════════════════════════════════════
widgetRouter.get('/manifest-debug', widgetRateLimit('default'), (_req: Request, res: Response) => {
  try {
    const diag = getManifestDiagnostics();
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.json({ ok: true, diagnostics: diag });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message || 'manifest_debug_failed' });
  }
});

// POST /manifest-invalidate — force a refresh on the next request. Useful
// after a deploy if you cannot wait for the 15s TTL. No-ops if called more
// than once per second. Token-secured.
widgetRouter.post('/manifest-invalidate', widgetRateLimit('default'), (_req: Request, res: Response) => {
  invalidateManifestCache();
  return res.json({ ok: true });
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
      .eq('visible_in_widget', true)
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

// ═══════════════════════════════════════════════
// POST /offline-messages — Capture a message while the workspace is offline
// ───────────────────────────────────────────────
// Server is the source of truth for availability — we re-resolve here and
// reject if the workspace is currently online (the widget should send a
// regular message instead). When accepted, this creates a normal
// conversation tagged 'offline' with a `captured_offline` event so it shows
// up in the inbox like any other thread, and notifies workspace admins by
// email when an email provider is configured.
// ═══════════════════════════════════════════════
const offlineMessageSchema = z.object({
  workspace_id: z.string().uuid(),
  message: z.string().min(2).max(4000),
  email: z.string().email().max(255).optional(),
  name: z.string().max(120).optional(),
  phone: z.string().max(40).optional(),
  locale: z.string().min(2).max(10).optional(),
  honeypot: z.string().max(0).optional(),
});

widgetRouter.post('/offline-messages', widgetRateLimit('message'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = offlineMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', details: parsed.error.flatten() });
  }

  const { workspace_id, message, email, name, phone, locale } = parsed.data;
  const tokenWs = (req as any)._widgetWorkspaceId as string | undefined;
  if (tokenWs && tokenWs !== workspace_id) {
    return res.status(403).json({ error: 'workspace_mismatch' });
  }

  // Honeypot — silently 200 so bots don't learn anything.
  if (parsed.data.honeypot && parsed.data.honeypot.length > 0) {
    return res.json({ ok: true, captured: false, conversation_id: null });
  }

  const supabase = getServiceClient(config);

  // Re-resolve availability server-side. Reject when online — the widget
  // should be sending a normal /message in that case.
  const snap = await resolveAvailability(config, { workspaceId: workspace_id, locale });
  const transitioning = snap.state === 'online';

  // Resolve visitor identity from cookie (set during /bootstrap).
  const cookie = readVisitorCookie(req, workspace_id);
  const visitorId = cookie?.v || null;

  let visitorSessionId: string | null = null;
  if (visitorId) {
    const { data: vs } = await supabase
      .from('visitor_sessions')
      .select('id')
      .eq('workspace_id', workspace_id)
      .eq('visitor_id', visitorId)
      .order('last_seen_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    visitorSessionId = vs?.id || null;
  }

  // Resolve / create contact when email provided. Email is the only stable
  // long-lived key we can reuse for follow-up.
  let contactId: string | null = null;
  if (email) {
    const { data: existing } = await supabase
      .from('contacts')
      .select('id, name, phone')
      .eq('workspace_id', workspace_id)
      .eq('email', email.toLowerCase())
      .maybeSingle();

    if (existing) {
      contactId = existing.id;
      const patch: Record<string, unknown> = {};
      if (name && !existing.name) patch.name = name;
      if (phone && !existing.phone) patch.phone = phone;
      if (Object.keys(patch).length) {
        await supabase.from('contacts').update(patch).eq('id', contactId);
      }
    } else {
      const { data: created } = await supabase
        .from('contacts')
        .insert({
          workspace_id,
          email: email.toLowerCase(),
          name: name || null,
          phone: phone || null,
          metadata: { source: 'offline_capture', visitor_id: visitorId },
        })
        .select('id')
        .single();
      contactId = created?.id || null;
    }
  }

  // Create conversation tagged 'offline'.
  // Phase 5 — offline capture is always a new conversation row, so
  // enforce max_conversations here. workspace_id is verified above
  // against the widget token (`tokenWs === workspace_id`).
  {
    const ok = await enforceMaxConversationsLimit(req, res);
    if (!ok) return;
  }
  const { data: conv, error: convErr } = await supabase
    .from('conversations')
    .insert({
      workspace_id,
      contact_id: contactId,
      visitor_session_id: visitorSessionId,
      status: 'open',
      priority: 'normal',
      tags: ['offline'],
      subject: 'Offline message',
    })
    .select('id')
    .single();

  if (convErr || !conv) {
    console.error('[offline-messages] conversation insert failed:', convErr?.message);
    return res.status(500).json({ error: 'capture_failed' });
  }

  // Insert visitor message.
  await supabase.from('conversation_messages').insert({
    conversation_id: conv.id,
    sender_type: 'contact',
    body: message,
    metadata: { source: 'offline_capture', visitor_id: visitorId },
  });

  // Record the timeline event so operators can see it was offline-captured.
  await recordConversationEvent(config, {
    workspaceId: workspace_id,
    conversationId: conv.id,
    eventType: 'captured_offline' as any,
    actorType: 'system',
    payload: {
      availability_state: snap.state,
      availability_reason: snap.reason,
      transitioning,
      contact_email: email || null,
      next_open_at: snap.next_open_at,
    },
  });

  // Best-effort email notification to workspace owners/admins.
  void notifyOfflineCapture(config, workspace_id, {
    conversationId: conv.id,
    message,
    email: email || null,
    name: name || null,
    locale: locale || 'en',
  }).catch((err) => console.warn('[offline-messages] notify failed:', err?.message));

  return res.json({
    ok: true,
    captured: true,
    conversation_id: conv.id,
    transitioning,
  });
});

async function notifyOfflineCapture(
  config: ServerConfig,
  workspaceId: string,
  payload: { conversationId: string; message: string; email: string | null; name: string | null; locale: string },
): Promise<void> {
  const supabase = getServiceClient(config);
  // Resolve workspace owners/admins. The codebase uses `workspace_members`
  // (with `workspace_role` enum) — fall through gracefully if the table or
  // column shape isn't what we expect, so notification is purely best-effort.
  let recipientIds: string[] = [];
  try {
    const { data: wsMembers } = await (supabase as any)
      .from('workspace_members')
      .select('user_id, role')
      .eq('workspace_id', workspaceId)
      .in('role', ['owner', 'admin']);
    if (Array.isArray(wsMembers)) {
      recipientIds = wsMembers.map((m: any) => m.user_id).filter(Boolean);
    }
  } catch {
    // ignore — will check email_settings.reply_to_email below
  }

  let emails: string[] = [];
  if (recipientIds.length) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, email')
      .in('id', recipientIds);
    emails = (profiles || []).map((p: any) => p.email).filter(Boolean);
  }

  if (!emails.length) {
    const { data: settings } = await supabase
      .from('email_settings')
      .select('reply_to_email')
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (settings?.reply_to_email) emails = [settings.reply_to_email];
  }

  if (!emails.length) return;

  const subject = `New offline message`;
  const safeMsg = payload.message.replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'));
  const html = `
    <p>A visitor left a message while your workspace was offline.</p>
    <p><strong>From:</strong> ${payload.name || 'Anonymous'} ${payload.email ? `&lt;${payload.email}&gt;` : ''}</p>
    <p><strong>Message:</strong></p>
    <blockquote style="border-left:3px solid #ccc;padding-left:12px;">${safeMsg}</blockquote>
    <p>Open this conversation in the inbox to reply.</p>
  `;
  const text = `New offline message\nFrom: ${payload.name || 'Anonymous'} ${payload.email || ''}\n\n${payload.message}`;

  for (const to of emails) {
    try {
      await sendEmail(config, {
        workspaceId,
        to,
        subject,
        html,
        text,
        templateSlug: 'offline_message_received',
        templateData: {
          conversation_id: payload.conversationId,
          contact_name: payload.name || '',
          contact_email: payload.email || '',
          message_body: payload.message,
        },
        locale: payload.locale,
      });
    } catch (err: any) {
      console.warn('[offline-messages] email to', to, 'failed:', err?.message);
    }
  }
}

// ═══════════════════════════════════════════════
// POST /admin/test-offline-email — Workspace member-only test send
// ───────────────────────────────────────────────
// Used by the Workspace → Widget → Availability tab to verify the
// `offline_message_received` template + active email provider.
// Always sends a sample payload; never touches conversations.
// ═══════════════════════════════════════════════
const testEmailSchema = z.object({
  workspace_id: z.string().uuid(),
  to: z.string().email().max(255),
  locale: z.enum(['en', 'fa', 'tr']).optional(),
});

widgetRouter.post('/admin/test-offline-email', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = testEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', details: parsed.error.flatten() });
  }
  const { workspace_id, to, locale } = parsed.data;

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_authorization' });
  }
  const token = authHeader.replace('Bearer ', '');
  const sb = getServiceClient(config);
  const { data: { user } = {} as any, error: userErr } = await sb.auth.getUser(token);
  if (userErr || !user) {
    return res.status(401).json({ error: 'invalid_token' });
  }
  const { data: isMember, error: memErr } = await sb.rpc('is_workspace_member', {
    _workspace_id: workspace_id,
    _user_id: user.id,
  });
  if (memErr) return res.status(500).json({ error: 'membership_check_failed' });
  if (!isMember) return res.status(403).json({ error: 'forbidden' });

  try {
    await sendEmail(config, {
      workspaceId: workspace_id,
      to,
      subject: '[TEST] New offline message',
      html: '<p>This is a test of your offline message notification email.</p>',
      text: 'This is a test of your offline message notification email.',
      templateSlug: 'offline_message_received',
      templateData: {
        conversation_id: 'test-conversation-id',
        contact_name: 'Test Visitor',
        contact_email: 'visitor@example.com',
        message_body:
          'Hello — this is a test message confirming your offline notification pipeline works.',
      },
      locale: locale || 'en',
    });
    return res.json({ ok: true });
  } catch (err: any) {
    console.error('[admin/test-offline-email] failed:', err?.message);
    return res.status(500).json({ error: 'send_failed', message: err?.message || 'unknown' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Phase 8C — Widget call channels & queue (visitor-facing)
// ═══════════════════════════════════════════════════════════════════
import { loadEffectiveCallChannels } from '../services/calls/controlPlane.js';
import { enqueueCall, cancelEntry, getEntry as getQueueEntry } from '../services/calls/queue.js';
import { loadEffectiveCallEntitlements } from '../services/calls/entitlementComposer.js';
import { evaluateVisitorQueueEnqueueGate } from '../services/calls/queueEntitlementGate.js';
import type { QueueGateResult, QueueDenial } from '../services/calls/queueEntitlementGate.js';

/**
 * Explicit narrowing helper: with `strictNullChecks: false` TypeScript cannot
 * discriminate the `allowed: true | false` union via `if (!gate.allowed)`.
 * Same runtime condition as before — no behavior change.
 */
function isQueueGateDenial(gate: QueueGateResult): gate is QueueDenial {
  return gate.allowed === false;
}

/**
 * GET /api/widget/call-channels
 * Returns effective availability for voice/video/queue/recording on this
 * workspace. Reuses the visitor session for identity and the existing
 * effective policy snapshot. No new identity flow, no new pre-chat form.
 */
widgetRouter.get('/call-channels', widgetRateLimit('bootstrap'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = (req as any)._widgetWorkspaceId as string | undefined
    || (req.query.workspace_id as string | undefined);
  if (!workspaceId) return res.status(400).json({ error: 'missing_workspace' });
  try {
    const channels = await loadEffectiveCallChannels(config, workspaceId);
    return res.json({
      voice_enabled: channels.voice_enabled,
      video_enabled: channels.video_enabled,
      recording_enabled: channels.recording_enabled,
      queue_enabled: channels.queue_enabled,
      visitor_initiated_audio: channels.visitor_initiated_audio,
      visitor_initiated_video: channels.visitor_initiated_video,
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'channel_lookup_failed' });
  }
});

/**
 * POST /api/widget/call-queue/enqueue
 * Body: { channel: 'audio'|'video', conversation_id?: string }
 * Reuses the existing visitor identity (cookie + workspace token).
 * Honors effective channel gates server-side.
 */
widgetRouter.post('/call-queue/enqueue', widgetRateLimit('message'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = (req as any)._widgetWorkspaceId as string | undefined;
  const visitorId = (req as any).visitorId as string | undefined;
  if (!workspaceId) return res.status(400).json({ error: 'missing_workspace' });
  const parsed = z.object({
    channel: z.enum(['audio', 'video']),
    conversation_id: z.string().uuid().optional(),
    /** Phase 8E — optional page context for the operator preview card. */
    page_url: z.string().max(2048).optional(),
    page_title: z.string().max(512).optional(),
    /** Phase 8H — optional department selected by widget. */
    department_id: z.string().uuid().optional(),
  }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  // Plan composer gate (deny-on-create / visitor-initiated queue enqueue).
  // Reuses the canonical loadEffectiveCallEntitlements — no second composer,
  // no new capability key. Runs BEFORE enqueueCall so we never strand a
  // half-created queue row on plan denial. plan_forbidden (403) stays
  // strictly distinct from runtime queue/business-state denials
  // (queue_disabled / voice_disabled / video_disabled → 409 below) and from
  // validation failures (invalid_body → 400 above).
  try {
    const eff = await loadEffectiveCallEntitlements(config, workspaceId);
    const gate = evaluateVisitorQueueEnqueueGate(eff, parsed.data.channel);
    if (isQueueGateDenial(gate)) {
      return res.status(403).json({
        error: 'plan_forbidden',
        capability: gate.capability,
        upgrade_required: true,
      });
    }
  } catch {
    return res.status(403).json({ error: 'plan_forbidden', capability: 'call_queue', upgrade_required: true });
  }
  try {
    const entry = await enqueueCall(config, {
      workspaceId,
      channel: parsed.data.channel,
      visitorSessionId: visitorId ?? null,
      conversationId: parsed.data.conversation_id ?? null,
      requestedBy: 'visitor',
      metadata: {
        page_url: parsed.data.page_url || null,
        page_title: parsed.data.page_title || null,
        department_id: parsed.data.department_id || null,
      },
    });
    return res.json({ entry });
  } catch (err: any) {
    const code = err?.message || 'enqueue_failed';
    const status = code === 'queue_disabled' || code === 'voice_disabled' || code === 'video_disabled'
      ? 409
      : 500;
    return res.status(status).json({ error: code });
  }
});

/**
 * POST /api/widget/call-queue/:entryId/cancel
 * Visitor cancels an active queue entry. Workspace-scoped lookup
 * prevents cross-workspace cancellation.
 */
widgetRouter.post('/call-queue/:entryId/cancel', widgetRateLimit('message'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = (req as any)._widgetWorkspaceId as string | undefined;
  const entryId = routeParam(req.params.entryId);
  if (!entryId) return res.status(400).json({ error: 'invalid_entry_id' });
  if (!workspaceId) return res.status(400).json({ error: 'missing_workspace' });
  const entry = await getQueueEntry(config, workspaceId, entryId);
  if (!entry) return res.status(404).json({ error: 'not_found' });
  // Optional safety: only owner of entry can cancel.
  const visitorId = (req as any).visitorId as string | undefined;
  if (entry.visitor_session_id && visitorId && entry.visitor_session_id !== visitorId) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const updated = await cancelEntry(config, entryId, 'visitor_cancelled');
  return res.json({ entry: updated });
});

// ═══════════════════════════════════════════════════════════════════
// Phase 3 — AI Agent visitor-facing intro
// ───────────────────────────────────────────────────────────────────
// POST /api/widget/ai-agent/intro
// Body: { conversation_id?, session_id?, locale? }
// Token + origin already enforced by widgetRouter.use() above.
// Returns the intro bubble or { sent:false, reason }. Never throws —
// widget MUST tolerate any failure and continue rendering normally.
// ═══════════════════════════════════════════════════════════════════
import { maybeSendIntro } from '../services/ai-agent/intro.js';

widgetRouter.post('/ai-agent/intro', widgetRateLimit('message'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = (req as any)._widgetWorkspaceId as string | undefined;
  if (!workspaceId) return res.status(400).json({ error: 'missing_workspace' });
  const visitorId = (req as any).visitorId as string | undefined;

  const parsed = z.object({
    conversation_id: z.string().uuid().optional().nullable(),
    session_id: z.string().uuid().optional().nullable(),
    locale: z.string().max(10).optional(),
  }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  try {
    const result = await maybeSendIntro(config, {
      workspaceId,
      conversationId: parsed.data.conversation_id || null,
      visitorSessionId: parsed.data.session_id || null,
      visitorId: visitorId || null,
      locale: parsed.data.locale,
    });
    return res.json(result);
  } catch (err: any) {
    console.warn('[widget/ai-intro] failed:', err?.message);
    // Never break widget — return graceful no-op.
    return res.json({ sent: false, reason: 'intro_failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/widget/ai-agent/qna-suggestions
// Query: { locale?, limit? }
// Quick-reply chips shown under the AI intro message — reuses the
// existing ai_agent_qna table (already populated for AI retrieval) as
// the question source rather than building a second, parallel content
// type. Token + origin already enforced by widgetRouter.use() above.
// Never throws — an empty list just means no chips render.
// ═══════════════════════════════════════════════════════════════════
widgetRouter.get('/ai-agent/qna-suggestions', widgetRateLimit('default'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = (req as any)._widgetWorkspaceId as string | undefined;
  if (!workspaceId) return res.status(400).json({ error: 'missing_workspace' });

  const parsed = z.object({
    locale: z.string().max(10).optional(),
    limit: z.coerce.number().int().min(1).max(20).optional(),
  }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });

  const limit = parsed.data.limit || 10;
  const locale = (parsed.data.locale || 'en').toLowerCase().split('-')[0];

  try {
    const sb = getServiceClient(config);
    let { data } = await sb
      .from('ai_agent_qna')
      .select('id, question')
      .eq('workspace_id', workspaceId)
      .eq('enabled', true)
      .eq('locale', locale)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (!data || !data.length) {
      // Same cross-locale fallback as the KB article endpoint — a
      // workspace with all its Q&A authored in one locale shouldn't show
      // zero chips just because the visitor's locale differs.
      const fallback = await sb
        .from('ai_agent_qna')
        .select('id, question')
        .eq('workspace_id', workspaceId)
        .eq('enabled', true)
        .order('created_at', { ascending: true })
        .limit(limit);
      data = fallback.data || [];
    }
    return res.json({
      questions: (data || []).map((q: any) => ({ id: q.id, question: q.question })),
    });
  } catch (err: any) {
    console.warn('[widget/qna-suggestions] failed:', err?.message);
    return res.json({ questions: [] });
  }
});
