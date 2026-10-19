import { clearContinuityCookie } from '../services/widget/continuity.js';
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
 *  - PUT  /action           — Token-secured. Heartbeat, typing, reopen
 *  - GET  /conversations/:id/csat       — The closed line's rating state, transcript availability
 *  - POST /conversations/:id/csat       — Rate the closed line
 *  - POST /conversations/:id/transcript — Mail the transcript to the contact's email
 *  - GET  /conversations/:id/reactions  — Message reactions of the thread (counts, the visitor's own)
 *  - POST /conversations/:id/reactions  — Set or take back the visitor's ❤️ on a team message
 *  - GET  /queue            — The conversation's place in the manual queue and the wait
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
import { canonicalWorkspaceId } from '../lib/workspaceId.js';
import { authorizeWorkspaceAccess, serverConfigOf } from '../lib/workspaceAuth.js';
import {
  publishConversationEvent,
  buildMessageEnvelope,
  visitorMessageMetadata,
} from '../services/realtime/publish.js';
import { notifyInboundMessage } from '../services/push/index.js';
import {
  getRequestOrigin as getRequestOriginPublic,
  getWorkspaceOriginRules,
  isWorkspaceOriginAllowed,
  resolveWorkspaceIdFromOrigin,
} from '../services/widget/public.js';
import { perfHttpMiddleware } from '../services/observability/perf.js';
import { kbSuggestGlobalCeiling } from '../middleware/security.js';
import { handleKbSuggest } from './widgetKbSuggest.js';
import { getWidgetAssetName, getManifestDiagnostics, invalidateManifestCache } from '../services/widget/manifest.js';
import { attachmentPreviewKind, type AttachmentPreviewKind } from '../services/attachmentPreviewKind.js';
import {
  DEFAULT_WIDGET_SETTINGS,
  bootstrapAvailability,
  getQuotaFull,
  getWidgetPlatformSnapshot,
  getWorkspaceWidgetSnapshot,
  resolveWidgetConfigBody,
  WidgetConfigBusyError,
} from '../services/widget/configSnapshot.js';


import { recordSmartEvent } from '../services/widget/smartEngagement.js';
import { evaluateAiProactiveNudge } from '../services/widget/aiNudge/evaluate.js';
import {
  touchVisitorLiveness,
  VISITOR_LIVENESS_NAVIGATION_ONLY_MS,
} from '../services/widget/visitorLiveness.js';
import {
  resolveVisitorPresenceMode,
  recordVisitorLivenessWrite,
} from '../services/visitors/presenceSource.js';
import { verifyVisitorPresenceLease } from '../services/visitors/presenceLease.js';


import { resolveTrustedNudgeSessionKey } from '../services/widget/aiNudge/session.js';
import { transitionNudgeStatus } from '../services/widget/aiNudge/lifecycle.js';
import { AI_JOURNEY_MAX_PAGES, type AiJourneyContext, type SmartEvalContext } from '../../src/lib/widget/smartEngine.js';
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
  takeNewVisitorSession,
} from '../services/widget/security.js';
import { createStorageUrlResolver } from '../services/storage/urlResolver.js';
import {
  availableOperatorIds,
  enrichMessagesWithSender,
  resolveOperatorIdentities,
} from '../services/widget/senderIdentity.js';

/**
 * What the widget security middleware attaches to a request after it has
 * verified the session token and the visitor cookie: the workspace the token
 * is scoped to, and the visitor it belongs to. Both are server-derived —
 * never read from the body or the query.
 */
type WidgetScopedRequest = Request & {
  _widgetWorkspaceId?: string;
  visitorId?: string;
};
import { maybeRunAiAssistantAfterVisitorMessage } from '../services/ai-agent/engine.js';
import { logRun as logAiRun } from '../services/ai-agent/logs.js';
import { clearAiManagementForPlatformOff, markNeedsHuman, type PlatformOffReason } from '../services/ai-agent/handoffState.js';
import { resolveVisitorIdentity, readVisitorCookie } from '../services/widget/visitorIdentity.js';
import { ensureVisitorContact } from '../services/widget/anonymousContact.js';
import { isContactIdentityConflict, placeUnverifiedIdentifiers } from '../services/widget/claimedIdentity.js';
import { insertContactWithVisitorCode, backfillVisitorCode } from '../services/widget/visitorCode.js';
import {
  pinContactOnVisitorSessions,
  issueContinuityCookieForContact,
} from '../services/widget/crossWidgetIdentity.js';
import { widgetIdentityRouter } from './widgetIdentity.js';
import { widgetAttachmentsRouter, attachUploadedFileToMessage, enrichMessagesWithAttachments, enrichMessagesWithReplyTo, isVisitorVisibleMessageMeta, filterVisitorVisibleMessages, visitorReplyPreview, type ReplyToPreview } from './widgetAttachments.js';
import { widgetCallbacksRouter } from './widgetCallbacks.js';
import { widgetDepartmentsRouter } from './widgetDepartments.js';
import { widgetCallInvitationsRouter } from './widgetCallInvitations.js';
import { recordConversationEvent } from '../services/conversationEvents.js';
import {
  applyInboundConversationLifecycle,
  INBOUND_REUSABLE_STATUSES,
} from '../services/conversationLifecycle.js';
import { extractHostname, isOriginAllowed } from '../utils/domain.js';
import { resolveAvailability, snapshotToWirePayload } from '../services/widget/availability.js';
import { applyKbUnlockedFilter, resolveKbLock } from '../services/knowledge-base/locks.js';
import { sendEmail } from '../services/email/index.js';
import { resolveWorkspaceAppUrl } from '../services/auth-email.js';

import { enrichVisitorSessionGeo } from '../services/geo/index.js';
import { trackEvent } from '../services/webAnalytics/eventsService.js';
import { getClientCountry, hashIp } from '../utils/clientIp.js';
import { checkTypingAllowed } from '../services/widget/typingRateLimit.js';
import { loadWidgetPlatformRuntimeSettings } from '../services/widget/platformSettings.js';
import { isActionActive } from '../services/observability/autoActionsCache.js';
import { emitMetric, emitLog } from '../services/observability/metrics.js';
import { resolveEffectivePolicy } from '../services/realtime/effectivePolicy.js';
import { checkMaxConversationsAllowance, enforceMaxConversationsLimit } from '../services/billing/conversationLimit.js';
import { locksEnabled } from '../services/billing/locks/state.js';
import { enforceMaxVisitorsLimitIfNewThisMonth } from '../services/billing/visitorLimit.js';
import { recordVisitorPageView } from '../services/webAnalytics/pageViews.js';
import { getPlatformEditionOrNull } from '../services/platformRegion.js';
import { workspaceChatTemplate } from '../services/widget/configSnapshot.js';
import {
  csatEnabledFor,
  csatState,
  humanOperatorAnswered,
  rateClosedConversation,
  RatingError,
} from '../services/conversationRatings.js';
import { emailVisitorTranscript, transcriptAvailability } from '../services/visitorTranscript.js';
import {
  REACTIONS_MIGRATION_REQUIRED,
  publishMessageReactions,
  readConversationReactions,
  readMessageReactions,
  setMessageReaction,
} from '../services/messageReactions.js';
import { readQueueStatus } from '../services/chatRouting.js';
import {
  VISITOR_REACTION_EMOJI,
  normalizeReactionEmoji,
  reactableByVisitor,
  visitorReactionList,
} from '../../shared/messageReactions.js';
import { visitorSystemPreview, type VisitorSystemPreview } from '../../shared/systemMessages.js';
import { operatorFallbackLocale, operatorLocale, operatorLocales } from '../services/operatorLocale.js';

/**
 * Internal staffing notices never reach the visitor.
 *
 * Several places in the server have long carried a comment saying the widget
 * filters `metadata.internal === true` out of /poll and /history. Nothing
 * ever did. A visitor could therefore read "Ali unassigned this
 * conversation" as an ordinary chat bubble, in English, because the widget's
 * renderer has no branch for that kind and falls through to a plain bubble.
 *
 * The flag itself is the contract: anything marked internal is for the inbox
 * only. A transfer is deliberately NOT marked internal — from the visitor's
 * side the next operator arriving is real news, and the widget renders it as
 * a join.
 */
export function isInternalMessage(m: { sender_type?: string | null; metadata?: unknown }): boolean {
  if (m.sender_type !== 'system') return false;
  const meta = (m.metadata || {}) as Record<string, unknown>;
  return meta.internal === true;
}

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

// ═══════════════════════════════════════════════
// POST /bootstrap — Public. Issues session token
// ═══════════════════════════════════════════════
//
// Reads nothing on a warm cache: the workspace, its widget settings, team
// prefs and call channels come from the workspace snapshot, the platform
// name from the platform snapshot (services/widget/configSnapshot.ts). The
// visitor-specific parts — token, cookies, origin checks — are per request.
//
// `include_config: true` (the current loader) adds `config`: exactly the
// GET /config body, so a page view needs one API round trip instead of two.
// It is left out whenever that body would not be a 200 (the loader then asks
// GET /config and gets the same answer as before). The loader posts the body
// as text/plain (a CORS-simple request: no preflight); server/index.ts parses
// it as JSON on this path only.
//
// `protocol` on every body this handler answers tells the loader it reached
// this server and not an older one:
//   >= 2  this server read the text/plain bootstrap body (an older one
//         ignores it; see public/widget/loader.js requestBootstrap). Every
//         answer the handler writes carries it, errors included, so the
//         loader can tell a final error from this server from an older
//         backend's answer to POST /boot, a route it does not have;
//   >= 3  POST /track and POST /api/realtime/visitor-presence also take the
//         session token as `widget_token` in a text/plain body, so the
//         loader sends them CORS-simple (no preflight; loader.js tokenPost).
const BOOTSTRAP_PROTOCOL = 3;

async function handleBootstrap(req: Request, res: Response) {
  try {
    const config = serverConfigOf(req);
    const { workspace_id } = req.body || {};

    const requestOrigin = getRequestOrigin(req) || (() => {
      try { return new URL(req.headers['referer'] as string || '').origin; } catch { return null; }
    })();

    // An explicit id is used in its canonical spelling only (lib/workspaceId.ts):
    // every cache, token and bucket below sees one key per workspace. A value
    // that is no uuid at all names no workspace.
    const explicitWorkspaceId = workspace_id ? canonicalWorkspaceId(workspace_id) : null;
    if (workspace_id && !explicitWorkspaceId) {
      return res.status(404).json({ disabled: true, error: 'Workspace not found', protocol: BOOTSTRAP_PROTOCOL });
    }

    // Resolve workspace: explicit ID or by origin
    const resolvedWorkspaceId = explicitWorkspaceId || (requestOrigin ? await resolveWorkspaceIdFromOrigin(config, requestOrigin) : null);

    if (!resolvedWorkspaceId) {
      return res.status(400).json({ error: 'workspace_id required or origin must be mapped', code: 'MISSING_WORKSPACE', protocol: BOOTSTRAP_PROTOCOL });
    }

    // Verify workspace exists
    const snap = await getWorkspaceWidgetSnapshot(config, resolvedWorkspaceId);
    const workspace = snap.workspace;

    if (!workspace) {
      return res.status(404).json({ disabled: true, error: 'Workspace not found', protocol: BOOTSTRAP_PROTOCOL });
    }

    // Check widget enabled
    const widgetSettings = snap.widgetRow;

    if (widgetSettings?.enabled === false) {
      return res.json({ disabled: true, fallback: true, protocol: BOOTSTRAP_PROTOCOL });
    }

    // Credential-issuance integrity — a bootstrap request with NEITHER
    // Origin NOR Referer cannot be bound to anything. Without this check,
    // createSessionToken() below would mint a real, validly-signed token
    // with origin="". A real browser embedding this widget always sends
    // Origin (fetch POST with credentials:'include' — see
    // public/widget/loader.js) regardless of same-origin/cross-origin, dev
    // or prod, so this is required unconditionally rather than gated behind
    // an environment flag: Dockerfile.server never sets NODE_ENV=production,
    // so a NODE_ENV-gated bypass would silently stay ACTIVE in production,
    // and no real browser traffic needs the bypass anyway.
    if (!requestOrigin) {
      console.warn(`[widget-bootstrap] Rejected — no Origin/Referer for workspace ${resolvedWorkspaceId}`);
      return res.status(403).json({ error: 'Origin or Referer required', code: 'ORIGIN_REQUIRED', protocol: BOOTSTRAP_PROTOCOL });
    }

    // Origin validation. An unreadable widget_settings row is checked too
    // (getWorkspaceOriginRules reads it itself and throws on error): the
    // snapshot that failed to read it is cached for seconds, and the
    // allow-list must not be off for that long.
    if (requestOrigin && (widgetSettings || snap.widgetRowUnreadable)) {
      const originRules = await getWorkspaceOriginRules(config, resolvedWorkspaceId);
      if (originRules.domains.length > 0) {
        const allowed = await isWorkspaceOriginAllowed(config, resolvedWorkspaceId, requestOrigin);
        if (!allowed) {
          // Allow localhost for dev
          const isLocalDev = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(requestOrigin);
          if (!isLocalDev) {
            console.warn(`[widget-bootstrap] Origin rejected: ${requestOrigin} for workspace ${resolvedWorkspaceId}`);
            return res.status(403).json({ error: 'Origin not authorized', code: 'ORIGIN_DENIED', protocol: BOOTSTRAP_PROTOCOL });
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
    // `fresh_visitor`: the embedding page says a different signed-in person
    // is now on this browser (see public/widget/loader.js commerce subject).
    const visitor = resolveVisitorIdentity(req, res, resolvedWorkspaceId, {
      forceNew: (req.body as { fresh_visitor?: unknown } | undefined)?.fresh_visitor === true,
    });

    if ((req.body as { fresh_visitor?: unknown } | undefined)?.fresh_visitor === true) {
      clearContinuityCookie(res, req);
    }

    // No-cache
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    // Cloudflare/CDN-aware bypass — `Cache-Control: no-store` alone is not
    // always honored by edge caches that have their own override rules.
    res.set('CDN-Cache-Control', 'no-store');
    res.set('Cloudflare-CDN-Cache-Control', 'no-store');

    // Platform display name — owned by platform branding (super admin only).
    // Workspace rows must never influence how the platform is credited.
    // platform_name lives on platform_branding_localized; 'en' is the
    // terminal fallback used by manifest.ts and resolveBrandName().
    const now = new Date();
    const [platform, edition, quotaFull] = await Promise.all([
      getWidgetPlatformSnapshot(config),
      getPlatformEditionOrNull(config),
      getQuotaFull(config, resolvedWorkspaceId),
    ]);

    // Phase 8 — server-authoritative availability snapshot. Additive;
    // existing widget runtimes ignore unknown fields.
    let availabilityPayload: ReturnType<typeof snapshotToWirePayload> | null = null;
    try {
      const localeHint = (req.body && (req.body.locale as string)) ||
        (req.headers['accept-language'] as string | undefined)?.split(',')[0] ||
        'en';
      availabilityPayload = await bootstrapAvailability(config, resolvedWorkspaceId, snap, localeHint, now, quotaFull);
    } catch (err) {
      console.warn('[widget-bootstrap] availability resolve failed:', err?.message);
    }

    // Phase 6C — effective realtime policy snapshot. Additive payload;
    // older widget runtimes ignore the field, newer ones honor force_polling /
    // typing_suppressed / reconnect_backoff_multiplier without a separate
    // round-trip. Resolution is fail-open and never blocks bootstrap.
    const effective_policy = await resolveEffectivePolicy(config, {
      workspaceId: resolvedWorkspaceId,
      callChannels: snap.callChannels,
    });

    // The GET /config body, inline, when the loader asks for it and it
    // would be a 200. A failure here only means the loader asks GET /config.
    let inlineConfig: Record<string, unknown> | null = null;
    if ((req.body as { include_config?: unknown } | undefined)?.include_config === true) {
      try {
        const built = await resolveWidgetConfigBody(config, req, resolvedWorkspaceId, { snap, platform, edition, quotaFull, now });
        if (built.status === 200) inlineConfig = built.body;
      } catch (err) {
        console.warn('[widget-bootstrap] inline config failed:', err?.message);
      }
    }

    return res.json({
      session_token: sessionToken,
      workspace_id: resolvedWorkspaceId,
      workspace_name: workspace.name,
      expires_at: tokenInfo.valid && tokenInfo.expiresAt ? new Date(tokenInfo.expiresAt * 1000).toISOString() : null,
      platform_display_name: platform.names.get('en') || '',
      // Additive: the platform's edition (null when it cannot be read; the
      // widget then behaves as the Iranian edition).
      edition,
      visitor_id: visitor.visitorId,
      is_new_visitor: visitor.isNew,
      availability: availabilityPayload,
      effective_policy,
      version: '3.0.0',
      protocol: BOOTSTRAP_PROTOCOL,
      ...(inlineConfig ? { config: inlineConfig } : {}),
    });
  } catch (err) {
    if (err instanceof WidgetConfigBusyError) {
      // Too many cold snapshots at once on this process: retry shortly.
      res.set('Retry-After', '1');
      return res.status(503).json({ error: 'Bootstrap failed', code: err.code, protocol: BOOTSTRAP_PROTOCOL });
    }
    console.error('[widget-bootstrap] Error:', err.message);
    return res.status(500).json({ error: 'Bootstrap failed', protocol: BOOTSTRAP_PROTOCOL });
  }
}

// The same bootstrap under two paths:
//   POST /bootstrap  what every loader posts as application/json (and what
//                    an older loader only knows);
//   POST /boot       what the current loader posts FIRST, CORS-simple
//                    (text/plain, no preflight). A backend older than that
//                    loader has no such route: it answers before any
//                    bootstrap work, minting no token and setting no visitor
//                    cookie, and the loader falls back to /bootstrap as JSON.
//                    Sending the CORS-simple body to /bootstrap itself would
//                    let an older backend, which cannot read it, resolve the
//                    workspace from the page origin instead, and set a
//                    visitor cookie for THAT workspace.
widgetRouter.post('/bootstrap', widgetRateLimit('bootstrap'), perfHttpMiddleware('widget.bootstrap'), handleBootstrap);
widgetRouter.post('/boot', widgetRateLimit('bootstrap'), perfHttpMiddleware('widget.bootstrap'), handleBootstrap);

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

    // createSessionToken() always signs rl:'public' now — there is no
    // trust-class argument to pass through, so refresh cannot escalate a
    // token's trust even in principle (see createSessionToken's doc
    // comment). tokenData.rateLimitTrust is not read here; nothing this
    // codebase issues is ever anything but 'public' today.
    //
    // The nonce DOES carry forward unchanged — it's the stable "session
    // lineage" id widgetSessionRateLimiter keys on. Without this, every
    // refresh would mint an unrelated new rate-limit identity, letting a
    // caller reset its own session quota just by refreshing (see
    // createSessionToken's doc comment for why this is safe: the nonce is
    // never taken from anything the caller supplies directly, only from
    // this request's own already-verified token).
    const newToken = createSessionToken(workspaceId, tokenOrigin || requestOrigin, { sessionNonce: tokenData.nonce });
    const newResult = verifySessionToken(newToken);

    // CORS headers are NOT written here. widgetCorsMiddleware already
    // resolved this request's workspace from the (refresh-grace-verified)
    // token and wrote the full credentialed contract when the origin is
    // authorized. Writing a lone Access-Control-Allow-Origin here produced
    // a response without Allow-Credentials, which the browser rejects —
    // the exact production "blocked by CORS policy on a 200 OK" symptom.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');


    // Phase 6C — refresh handshake also returns the latest effective policy
    // snapshot so a long-lived widget tab picks up failover/lock/degraded
    // changes without needing a full re-bootstrap. Fail-open if resolution
    // hiccups — token refresh must never block.
    let effective_policy: Awaited<ReturnType<typeof resolveEffectivePolicy>> | null = null;
    try {
      const config = serverConfigOf(req);
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
  } catch (err) {
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
    const tokenWs = (req as WidgetScopedRequest)._widgetWorkspaceId as string | undefined;
    const wsFromBody = (req.body && typeof req.body === 'object' ? req.body.workspace_id : undefined) as string | undefined;
    const wsFromQuery = req.query.workspace_id as string | undefined;
    const ws = tokenWs || wsFromBody || wsFromQuery;
    if (!ws) return next();

    const cookie = readVisitorCookie(req, ws);
    if (!cookie) return next();

    if (req.body && typeof req.body === 'object' && !req.body.visitor_id) {
      req.body.visitor_id = cookie.v;
    }
    if (!req.query.visitor_id) {
      req.query.visitor_id = cookie.v;
    }
    (req as WidgetScopedRequest).visitorId = cookie.v;
  } catch (_) {
    // Identity resolution must never block the request
  }
  return next();
});
// ═══════════════════════════════════════════════
// GET /config — Full widget configuration
// ═══════════════════════════════════════════════
widgetRouter.get('/config', widgetRateLimit('config'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const workspaceId = resolveWorkspaceId(req, res, req.query.workspace_id as string);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  // /config drives runtime URLs (with hashed asset names). MUST never be
  // cached at the edge — a stale config returns dead asset URLs after
  // a deploy and the launcher silently fails.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('CDN-Cache-Control', 'no-store');
  res.set('Cloudflare-CDN-Cache-Control', 'no-store');

  try {
    // Every input comes from the workspace / platform snapshots
    // (services/widget/configSnapshot.ts); a cache hit reads nothing.
    const { status, body } = await resolveWidgetConfigBody(config, req, workspaceId);
    res.status(status).json(body);
  } catch (err) {
    if (err instanceof WidgetConfigBusyError) {
      res.set('Retry-After', '1');
      return res.status(503).json({ error: 'Internal error', code: err.code });
    }
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
  rule_id: z.string().uuid().optional(),
  rule_version: z.number().int().min(1).max(100000).optional(),
  /** AI Proactive Nudge lifecycle events set source:'ai_proactive' + ai_nudge_id instead of rule_id. */
  source: z.enum(['rule', 'ai_proactive']).optional().default('rule'),
  ai_nudge_id: z.string().uuid().optional(),
  event_type: z.enum(['shown', 'opened', 'dismissed', 'cta_clicked', 'widget_opened', 'conversation_started', 'suppressed']),
  visitor_id: z.string().max(120).optional().nullable(),
  session_id: z.string().max(120).optional().nullable(),
  page_path: z.string().max(500).optional().nullable(),
  idempotency_key: z.string().min(6).max(120),
}).refine((d) => (d.source === 'ai_proactive' ? !!d.ai_nudge_id : !!d.rule_id), { message: 'rule_id or ai_nudge_id required' });

widgetRouter.post('/smart/event', widgetRateLimit('default'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
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
      source: parsed.data.source,
      aiNudgeId: parsed.data.ai_nudge_id,
      visitorId: parsed.data.visitor_id ?? null,
      sessionId: parsed.data.session_id ?? null,
      eventType: parsed.data.event_type,
      pagePath: parsed.data.page_path ?? null,
      idempotencyKey: parsed.data.idempotency_key,
    }, config);
    if (!result.ok) {
      const status = (result.reason === 'rule_workspace_mismatch' || result.reason === 'nudge_workspace_mismatch') ? 403 : 400;
      return res.status(status).json({ error: result.reason || 'rejected' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[smart-event] failed:', err?.message || err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════
// AI Proactive Nudge — POST /api/widget/nudge/evaluate
//
// Called by the widget loader only when the client-side deterministic gate
// (SmartEngine.evaluateAiProactiveEligibility, run against the SAME rule
// set for defense-in-depth) already thinks AI *may* be worth asking. This
// endpoint independently re-verifies eligibility server-side (never trusts
// the client's own frequency/cooldown bookkeeping for cost control) before
// spending an AI call. Token + origin already enforced by the middleware
// mounted above. Never blocks/slows the rest of the widget on failure.
// ═══════════════════════════════════════════════
const nudgePageSchema = z.object({
  path: z.string().max(500),
  title: z.string().max(300).optional().nullable(),
});
const nudgeEvaluateSchema = z.object({
  visitor_id: z.string().max(120).optional().nullable(),
  session_id: z.string().max(120).optional().nullable(),
  locale: z.string().max(10).default('en'),
  device: z.enum(['desktop', 'mobile', 'tablet']).default('desktop'),
  current: nudgePageSchema,
  recent_pages: z.array(nudgePageSchema.extend({ ts: z.number() })).max(AI_JOURNEY_MAX_PAGES).default([]),
  session_page_count: z.number().int().min(0).max(100000).default(1),
  returning: z.boolean().default(false),
  previous_nudge: z.object({ topic: z.string().max(60), dismissed: z.boolean(), engaged: z.boolean() }).optional().nullable(),
  referrer: z.string().max(1000).optional().nullable(),
  utm: z.object({ source: z.string().max(200).optional(), medium: z.string().max(200).optional(), campaign: z.string().max(200).optional() }).optional().nullable(),
  signals: z.object({
    elapsedMs: z.number().min(0).max(24 * 3600_000).default(0),
    scrollPercent: z.number().min(0).max(100).default(0),
    inactiveMs: z.number().min(0).max(24 * 3600_000).default(0),
    exitIntent: z.boolean().default(false),
    pageHidden: z.boolean().optional(),
  }),
  interaction: z.object({
    widgetOpen: z.boolean().optional(),
    conversationActive: z.boolean().optional(),
    visitorTyping: z.boolean().optional(),
    callActive: z.boolean().optional(),
    prechatOpen: z.boolean().optional(),
    anotherRuleShowing: z.boolean().optional(),
    visitorReplied: z.boolean().optional(),
    widgetError: z.boolean().optional(),
  }),
  online: z.boolean().default(true),
});

/** Strips sensitive query params and truncates — same deny-list as page_context elsewhere in this file. */
function sanitizeNudgePath(raw: string | null | undefined): string {
  if (!raw) return '/';
  try {
    const u = new URL(raw, 'https://placeholder.invalid');
    for (const k of ['token', 'access_token', 'refresh_token', 'code', 'password', 'session', 'auth', 'key', 'secret', 'api_key', 'sig', 'signature']) {
      u.searchParams.delete(k);
    }
    return (u.pathname + (u.search || '')).slice(0, 500) || '/';
  } catch {
    return String(raw).split('?')[0].slice(0, 500) || '/';
  }
}

widgetRouter.post('/nudge/evaluate', widgetRateLimit('default'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const workspaceId = resolveWorkspaceId(req, res, req.body?.workspace_id);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const parsed = nudgeEvaluateSchema.safeParse(req.body || {});
  if (!parsed.success) return res.json({ decision: 'suppress' }); // fail closed, never surface schema errors to the page

  // Trusted session lineage — derived from the verified widget token's
  // nonce (enforceWidgetToken, mounted above), never from client-supplied
  // session_id/visitor_id. This is the ONLY identity that may gate AI
  // evaluation quota, cooldown, dedup, or AI billing identity for this
  // feature — see server/services/widget/aiNudge/session.ts.
  const trustedSessionKey = resolveTrustedNudgeSessionKey(req);
  if (!trustedSessionKey) return res.json({ decision: 'suppress' }); // fail closed — no verified token context

  try {
    const d = parsed.data;
    // Visitor identity: the signed HttpOnly cookie is authoritative, same
    // precedence as every other widget route. A client-supplied visitor_id
    // is stored ONLY as a display/analytics column — never used for
    // enforcement (frequency, dedup, billing all key on trustedSessionKey).
    const visitorId = readVisitorCookie(req as Request, workspaceId)?.v || null;
    const journey: AiJourneyContext = {
      current: { path: sanitizeNudgePath(d.current.path), title: d.current.title || undefined, ts: Date.now() },
      recentPages: d.recent_pages.map((p) => ({ path: sanitizeNudgePath(p.path), title: p.title || undefined, ts: p.ts })),
      sessionPageCount: d.session_page_count,
      returning: d.returning,
      previousNudge: d.previous_nudge
        ? { topic: d.previous_nudge.topic, dismissed: d.previous_nudge.dismissed, engaged: d.previous_nudge.engaged }
        : null,
    };
    const ctx: SmartEvalContext = {
      masterEnabled: true,
      mode: 'production',
      page: { url: journey.current.path, path: journey.current.path, hostname: '', title: journey.current.title },
      referrer: d.referrer || undefined,
      utm: d.utm || undefined,
      device: d.device,
      locale: d.locale,
      visitor: { isReturning: d.returning, sessionPageCount: d.session_page_count },
      availability: { online: d.online },
      interaction: d.interaction,
      signals: {
        elapsedMs: d.signals.elapsedMs,
        scrollPercent: d.signals.scrollPercent,
        inactiveMs: d.signals.inactiveMs,
        exitIntent: d.signals.exitIntent,
        pageHidden: d.signals.pageHidden,
      },
    };
    const result = await evaluateAiProactiveNudge(config, {
      workspaceId,
      trustedSessionKey,
      visitorId,
      sessionId: d.session_id ?? null,
      locale: d.locale,
      device: d.device,
      ctx,
      journey,
    });
    res.json(result);
  } catch (err) {
    console.error('[nudge-evaluate] failed:', err?.message || err);
    res.json({ decision: 'suppress' });
  }
});

widgetRouter.get('/poll', widgetRateLimit('poll'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const workspaceId = resolveWorkspaceId(req, res, req.query.workspace_id as string);
  if (res.headersSent) return;
  if (!workspaceId) return res.json({ status: 'unknown', messages: [], conversation_id: null });

  const conversationId = req.query.conversation_id as string;
  const visitorId = req.query.visitor_id as string || null;
  const sessionId = req.query.session_id as string || null;
  const supabase = getServiceClient(config);

  try {
    let conv = null;
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
      .select('id, body, sender_type, sender_id, created_at, metadata, seen_at, reply_to_message_id')
      .eq('conversation_id', activeConversationId)
      .order('created_at', { ascending: false })
      .limit(200);

    const baseMessages = (msgs || []).slice().reverse().filter((m) => !isInternalMessage(m)).map((m) => ({
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
      // Without the operator account ids a row records (a join's agent_id,
      // a transfer's from_id / to_id, the closed line's operator_id): the
      // widget shows the names beside them (realtime/publish.ts).
      metadata: visitorMessageMetadata(m.metadata),
      // Phase 7 — lifecycle. Only ever set on visitor messages, only by an
      // operator-side action (mark_conversation_seen RPC). Monotonic.
      seen_at: m.seen_at || null,
      // Structured reply-to-message relationship — resolved below via
      // enrichMessagesWithReplyTo (one batch query, not one per message).
      reply_to_message_id: m.reply_to_message_id || null,
    }));
    // Phase 6b — attach public-safe attachment metadata (no provider URLs)
    const enriched = await enrichMessagesWithAttachments(config, workspaceId, baseMessages);
    const withReplies = await enrichMessagesWithReplyTo(config, activeConversationId as string, enriched);
    const messages = await enrichMessagesWithSender(config, supabase, withReplies, workspaceId);

    let operatorInfo = null;
    if (conv.assigned_to) {
      const { data: profile } = await supabase
        .from('profiles').select('id, full_name, avatar_storage_key')
        .eq('id', conv.assigned_to).maybeSingle();
      if (profile) {
        operatorInfo = {
          name: profile.full_name,
          avatar: await createStorageUrlResolver(config).user(conv.assigned_to, profile.avatar_storage_key),
        };
      }
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
  } catch (err) {
    console.error('[widget-poll] Error:', err.message);
    res.status(500).json({ error: 'Poll failed' });
  }
});

// ═══════════════════════════════════════════════
// GET /history — Conversation history
// ═══════════════════════════════════════════════
widgetRouter.get('/history', widgetRateLimit('poll'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
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
  // The operator the thread is assigned to, for a chat header that shows who
  // answers ({ name, avatar, online }; null while nobody is assigned). Only
  // on request (`operator=1`, sent by a renderer that draws it, see
  // runtime.js operatorQ): the default template asks nothing, so its
  // history costs what it always did.
  const withOperator = req.query.operator === '1';
  const assignedOperatorP = withOperator
    ? assignedOperatorOf(config, supabase, workspaceId, ownership.conversation?.assigned_to || null)
    : null;
  const { data: msgs } = await supabase
    .from('conversation_messages')
    .select('id, body, sender_type, sender_id, created_at, metadata, seen_at, reply_to_message_id')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(200);

  const baseMessages = (msgs || []).slice().reverse().filter((m) => !isInternalMessage(m)).map((m) => ({
    id: m.id,
    role: m.sender_type === 'contact' ? 'visitor' : m.sender_type === 'system' ? 'system' : 'agent',
    sender_type: m.sender_type,
    _sender_id: m.sender_id || null,
    text: m.body,
    time: m.created_at,
    // Without operator account ids (see /poll).
    metadata: visitorMessageMetadata(m.metadata),
    // Phase 7 — lifecycle (see /poll for semantics).
    seen_at: m.seen_at || null,
    reply_to_message_id: m.reply_to_message_id || null,
  }));
  // Phase 6b — attach public-safe attachment metadata (no provider URLs)
  const enriched = await enrichMessagesWithAttachments(config, workspaceId, baseMessages);
  const withReplies = await enrichMessagesWithReplyTo(config, conversationId, enriched);
  const messages = await enrichMessagesWithSender(config, supabase, withReplies, workspaceId);

  return res.json(withOperator ? { messages, assigned_operator: await assignedOperatorP } : { messages });
});

/** `{ name, avatar, online }` of an assigned operator, or null (cosmetic: never fails). */
async function assignedOperatorOf(
  config: ServerConfig,
  supabase: ReturnType<typeof getServiceClient>,
  workspaceId: string,
  userId: string | null,
): Promise<{ name: string | null; avatar: string | null; online: boolean } | null> {
  if (!userId) return null;
  try {
    const [identities, online] = await Promise.all([
      resolveOperatorIdentities(config, supabase, [userId]),
      availableOperatorIds(config, workspaceId),
    ]);
    const who = identities.get(userId);
    return who ? { name: who.name, avatar: who.avatar, online: online.has(userId) } : null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════
// GET /queue — the place in the manual queue (issue #340 g4)
// ───────────────────────────────────────────────
// `?workspace_id&conversation_id` (+ visitor_id / session_id as /history)
// → { position, wait_minutes }: two integers, or nulls while the
// conversation is not waiting in the queue (an operator has it, it is
// closed, routing never queued it) and before migration 276. Asked by Core's
// late module (runtime-late.js) every 30 s while a template that draws the
// queue pill shows a queued thread; `default` never asks. Ownership exactly
// as /history; the count is one range on the partial index of 276
// (services/chatRouting.ts readQueueStatus).
// ═══════════════════════════════════════════════
widgetRouter.get('/queue', widgetRateLimit('poll'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const workspaceId = resolveWorkspaceId(req, res, req.query.workspace_id as string);
  if (res.headersSent) return;

  const conversationId = typeof req.query.conversation_id === 'string' ? req.query.conversation_id : '';
  if (!conversationId || !workspaceId) {
    return res.status(400).json({ error: 'conversation_id and workspace_id required' });
  }
  if (!CONVERSATION_ID_RE.test(conversationId)) return res.status(400).json({ error: 'invalid conversation id' });
  const visitorId = req.query.visitor_id as string || null;
  const sessionId = req.query.session_id as string || null;

  try {
    const ownership = await verifyConversationOwnership(config, conversationId, workspaceId, visitorId, sessionId, req);
    if (!ownership.valid || !ownership.conversation) {
      return res.status(403).json({ error: 'Access denied to this conversation', code: 'CONVERSATION_ACCESS_DENIED' });
    }
    res.set('Cache-Control', 'no-store');
    return res.json(await readQueueStatus(config, workspaceId, ownership.conversation));
  } catch (err) {
    console.error('[widget-queue] Error:', err?.message || err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════
// GET /conversations — Visitor's own conversation list
// ───────────────────────────────────────────────
// Identity is taken EXCLUSIVELY from the signed HttpOnly `dvsid` cookie
// (`(req as WidgetScopedRequest).visitorId`, set by the middleware above after verifying the cookie
// signature AND that it was issued for this workspace). Any `visitor_id`
// supplied by the client in the query string or body is ignored outright —
// it is never read here, so a tampered/forged value cannot widen or shift
// the result set. visitor_session_id / contact linkage only widens the match
// within that already-authenticated identity.
// ═══════════════════════════════════════════════
widgetRouter.get('/conversations', widgetRateLimit('poll'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const workspaceId = resolveWorkspaceId(req, res, req.query.workspace_id as string);
  if (res.headersSent) return;
  if (!workspaceId) return res.json({ conversations: [] });

  // Cookie-derived identity ONLY. Deliberately does not fall back to
  // req.query.visitor_id / req.body.visitor_id.
  const visitorId = (req as WidgetScopedRequest).visitorId as string | undefined;
  if (!visitorId) return res.json({ conversations: [] });

  const supabase = getServiceClient(config);

  try {
    // Every visitor_sessions row this browser has ever had for this
    // workspace — a visitor can accumulate more than one session row over
    // time (new tab, cookie renewal, etc).
    const { data: sessions } = await supabase
      .from('visitor_sessions')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('visitor_id', visitorId)
      .limit(50);
    const sessionIds = (sessions || []).map((s) => s.id).filter(Boolean);

    // Fallback linkage used elsewhere in this file (see /poll, /message):
    // a contact whose metadata carries this visitor_id.
    const { data: contact } = await supabase
      .from('contacts')
      .select('id')
      .eq('workspace_id', workspaceId)
      .contains('metadata', { visitor_id: visitorId })
      .limit(1)
      .maybeSingle();

    if (sessionIds.length === 0 && !contact) {
      return res.json({ conversations: [] });
    }

    const orParts: string[] = [];
    if (sessionIds.length > 0) orParts.push(`visitor_session_id.in.(${sessionIds.join(',')})`);
    if (contact?.id) orParts.push(`contact_id.eq.${contact.id}`);

    // Who answers each thread only on request (`operator=1`, sent by a
    // renderer that draws it, see runtime.js operatorQ): the default
    // template asks nothing, so its list costs what it always did.
    const withOperator = req.query.operator === '1';
    // Typed as the wider list: without operator=1 the rows simply have no
    // `assigned_to` (read as null below).
    const columns = (withOperator ? 'id, status, updated_at, assigned_to' : 'id, status, updated_at') as
      'id, status, updated_at, assigned_to';
    const { data: convos, error } = await supabase
      .from('conversations')
      .select(columns)
      .eq('workspace_id', workspaceId)
      .or(orParts.join(','))
      .order('updated_at', { ascending: false })
      .limit(20);
    if (error) throw error;

    const list = convos || [];
    const convIds = list.map((c) => c.id);

    // Visitor-side read markers (widget_conversation_reads). Keyed by the
    // cookie-derived visitor id, so a visitor only ever sees their own
    // read state.
    const readAtByConv: Record<string, number> = {};
    if (convIds.length > 0) {
      const { data: reads } = await supabase
        .from('widget_conversation_reads')
        .select('conversation_id, last_read_at')
        .eq('workspace_id', workspaceId)
        .eq('visitor_id', visitorId)
        .in('conversation_id', convIds);
      for (const r of (reads || [])) {
        readAtByConv[r.conversation_id] = new Date(r.last_read_at).getTime();
      }
    }

    // Last message per conversation (preview + lastMessageAt) and the real
    // unread count: inbound messages (operator / ai / bot / system) created
    // after this visitor's last_read_at for that thread. The visitor's own
    // messages never count as unread.
    const INBOUND = new Set(['agent', 'operator', 'ai', 'bot', 'system']);
    const lastByConv: Record<string, {
      body: string;
      created_at: string;
      sender_type: string;
      attachment_id: string | null;
      attachment_kind: AttachmentPreviewKind | null;
      system: VisitorSystemPreview | null;
    }> = {};
    const unreadByConv: Record<string, number> = {};
    if (convIds.length > 0) {
      const { data: msgs } = await supabase
        .from('conversation_messages')
        .select('conversation_id, body, created_at, sender_type, metadata')
        .in('conversation_id', convIds)
        .order('created_at', { ascending: false })
        .limit(500);
      for (const m of (msgs || [])) {
        // Rows the visitor's thread never shows as news neither preview it
        // nor count as unread: inbox-only notices ("Ali unassigned this
        // conversation", in English, written for the inbox) and the closed
        // line, which a template that draws it draws in the thread.
        if (!isVisitorVisibleMessageMeta(m.metadata)) continue;
        if ((m.metadata as Record<string, unknown> | null)?.kind === 'conversation_closed') continue;
        // A system row previews as its kind, from which the widget writes
        // the sentence; one it cannot write (a kind it does not know) is
        // not the preview, the row before it is. It still counts as unread.
        const system = m.sender_type === 'system' ? visitorSystemPreview(m.metadata) : null;
        if (!lastByConv[m.conversation_id] && (m.sender_type !== 'system' || system)) {
          const meta = (m.metadata || {}) as Record<string, unknown>;
          lastByConv[m.conversation_id] = {
            body: m.body ?? '',
            created_at: m.created_at,
            sender_type: String(m.sender_type || ''),
            // A message whose only content is an attachment has an empty
            // body; without this the list said "no messages yet" about a
            // conversation the visitor had just sent a photo to.
            attachment_id: meta.attachment_id ? String(meta.attachment_id) : null,
            attachment_kind: null,
            system,
          };
        }
        if (!INBOUND.has(String(m.sender_type))) continue;
        const readAt = readAtByConv[m.conversation_id] ?? 0;
        if (new Date(m.created_at).getTime() > readAt) {
          unreadByConv[m.conversation_id] = (unreadByConv[m.conversation_id] || 0) + 1;
        }
      }
    }

    // Only a message with NO text needs its media described — a caption
    // already previews fine on its own.
    const previewAttachmentIds = Array.from(new Set(
      Object.values(lastByConv)
        .filter((l) => l.attachment_id && !String(l.body || '').trim())
        .map((l) => l.attachment_id as string),
    ));
    if (previewAttachmentIds.length) {
      const { data: atts } = await supabase
        .from('conversation_attachments')
        .select('id, mime_type')
        .in('id', previewAttachmentIds);
      const mimeById = new Map<string, string>(
        ((atts || [])).map((a) => [String(a.id), String(a.mime_type || '')]),
      );
      for (const last of Object.values(lastByConv)) {
        if (!last.attachment_id || String(last.body || '').trim()) continue;
        last.attachment_kind = attachmentPreviewKind(mimeById.get(last.attachment_id));
      }
    }

    // Who answers each thread: one profile read for all of them and the
    // presence from the cached workspace snapshot (no query per row).
    const assignedIds = withOperator ? list.map((c) => c.assigned_to || null) : [];
    const [operators, onlineIds] = assignedIds.some(Boolean)
      ? await Promise.all([
        resolveOperatorIdentities(config, supabase, assignedIds),
        availableOperatorIds(config, workspaceId),
      ])
      : [new Map(), new Set<string>()];

    const truncate = (text: string, max = 120) => {
      const flat = String(text || '').replace(/\s+/g, ' ').trim();
      return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
    };

    const conversations = list.map((c) => {
      const last = lastByConv[c.id] || null;
      const assignedTo = c.assigned_to || null;
      const row = {
        id: c.id,
        status: c.status || 'unknown',
        updatedAt: c.updated_at,
        preview: last ? truncate(last.body) : '',
        // Structured, never display text: the widget writes the sentence in
        // the VISITOR's language, which the server has no business choosing.
        attachmentKind: last?.attachment_kind ?? null,
        // The same for a system row ("Your message is in the support
        // queue."): its kind and the names its sentence needs, never the
        // stored English body as the text to show. Only on such a row, so
        // every other row keeps exactly the keys it had; `preview` above
        // stays the body for a runtime loaded before this field existed.
        ...(last?.system ? { systemKind: last.system.kind, systemMeta: last.system.meta } : {}),
        // Whether the visitor themselves sent it — "you sent a photo" reads
        // differently from "you received a photo".
        outbound: last ? last.sender_type === 'contact' : false,
        unreadCount: unreadByConv[c.id] || 0,
        lastMessageAt: last ? last.created_at : c.updated_at,
      };
      // The assigned operator (null while nobody is): a template draws
      // their name, photo and presence on the row.
      return withOperator ? {
        ...row,
        operatorName: (assignedTo && operators.get(assignedTo)?.name) || null,
        operatorAvatar: (assignedTo && operators.get(assignedTo)?.avatar) || null,
        operatorOnline: !!assignedTo && onlineIds.has(assignedTo),
      } : row;
    });

    return res.json({ conversations });
  } catch (err) {
    console.error('[widget-conversations] Error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════
// POST /conversations/:id/read — visitor read marker
// ───────────────────────────────────────────────
// Sets last_read_at=now() for (conversation, cookie-derived visitor).
// Ownership is re-verified against the visitor's own sessions/contact so a
// visitor cannot mark somebody else's thread as read.
// ═══════════════════════════════════════════════
widgetRouter.post('/conversations/:id/read', widgetRateLimit('poll'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const workspaceId = resolveWorkspaceId(req, res, (req.body && req.body.workspace_id) || (req.query.workspace_id as string));
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const visitorId = (req as WidgetScopedRequest).visitorId as string | undefined;
  if (!visitorId) return res.status(401).json({ error: 'visitor identity required' });

  const conversationId = String(req.params.id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)) {
    return res.status(400).json({ error: 'invalid conversation id' });
  }

  const supabase = getServiceClient(config);
  try {
    const { data: convo } = await supabase
      .from('conversations')
      .select('id, visitor_session_id, contact_id')
      .eq('workspace_id', workspaceId)
      .eq('id', conversationId)
      .maybeSingle();
    if (!convo) return res.status(404).json({ error: 'not found' });

    const { data: sessions } = await supabase
      .from('visitor_sessions')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('visitor_id', visitorId)
      .limit(50);
    const sessionIds = new Set((sessions || []).map((s) => s.id));

    let owns = !!convo.visitor_session_id && sessionIds.has(convo.visitor_session_id);
    if (!owns && convo.contact_id) {
      const { data: contact } = await supabase
        .from('contacts')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('id', convo.contact_id)
        .contains('metadata', { visitor_id: visitorId })
        .maybeSingle();
      owns = !!contact;
    }
    if (!owns) return res.status(404).json({ error: 'not found' });

    await supabase
      .from('widget_conversation_reads')
      .upsert({
        workspace_id: workspaceId,
        conversation_id: conversationId,
        visitor_id: visitorId,
        last_read_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'conversation_id,visitor_id' });

    return res.json({ ok: true });
  } catch (err) {
    console.error('[widget-conversation-read] Error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});


// ═══════════════════════════════════════════════
// The rating after a chat and the transcript by email (issue #340)
// ───────────────────────────────────────────────
// Called only by Core's late module (runtime-late.js) of a template that
// draws them; the rules live in services/conversationRatings.ts and
// services/visitorTranscript.ts. Every route checks the visitor owns the
// conversation by the signed cookie alone (never an id from the body).
// ═══════════════════════════════════════════════
const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The visitor's own conversation (cookie identity), or null. */
async function ownedConversation(config: ServerConfig, req: Request, workspaceId: string) {
  const conversationId = String(req.params.id || '');
  if (!CONVERSATION_ID_RE.test(conversationId)) return null;
  const ownership = await verifyConversationOwnership(config, conversationId, workspaceId, null, null, req);
  return ownership.valid ? ownership.conversation : null;
}

// GET /conversations/:id/csat — the closed line the thread ends with:
// { closed_id, rateable, rating: {score, comment, rated_at} | null,
//   operator: {name, avatar} | null, transcript: {available, to} }.
widgetRouter.get('/conversations/:id/csat', widgetRateLimit('poll'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const workspaceId = resolveWorkspaceId(req, res, req.query.workspace_id as string);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });
  try {
    const conversation = await ownedConversation(config, req, workspaceId);
    if (!conversation) return res.status(404).json({ error: 'not_found' });
    const [template, humanAnswered] = await Promise.all([
      workspaceChatTemplate(config, workspaceId),
      humanOperatorAnswered(getServiceClient(config), conversation.id),
    ]);
    const [state, transcript] = await Promise.all([
      csatState(config, { workspaceId, conversationId: conversation.id, csatEnabled: csatEnabledFor(template), humanAnswered }),
      // The link is the card's extra: a failed read hides it, never the card.
      transcriptAvailability(config, { workspaceId, conversation, humanAnswered }).catch((err: unknown) => {
        console.warn('[widget-csat] transcript availability failed:', (err as { message?: string } | null)?.message || err);
        return { available: false, to: null };
      }),
    ]);
    return res.json({ ...state, transcript: { available: transcript.available, to: transcript.to } });
  } catch (err) {
    console.error('[widget-csat] Error:', err?.message || err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

const csatBodySchema = z.object({
  closed_id: z.unknown(),
  rating: z.unknown(),
  comment: z.unknown().optional(),
}).passthrough();

// POST /conversations/:id/csat {closed_id, rating 1..5, comment?} —
// 200 {ok, rating} | 400 invalid_rating | 403 csat_disabled (code
// CSAT_DISABLED) | 409 not_ratable | 409 already_rated (+ rating) |
// 503 csat_unavailable.
widgetRouter.post('/conversations/:id/csat', widgetRateLimit('message'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const workspaceId = resolveWorkspaceId(req, res, (req.body && req.body.workspace_id) || (req.query.workspace_id as string));
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });
  const body = csatBodySchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_rating' });
  try {
    const conversation = await ownedConversation(config, req, workspaceId);
    if (!conversation) {
      return res.status(403).json({ error: 'Access denied to this conversation', code: 'CONVERSATION_ACCESS_DENIED' });
    }
    if (!csatEnabledFor(await workspaceChatTemplate(config, workspaceId))) {
      // With its code: the widget's fetchWith takes a code-less 403 for an
      // expired token (a refresh and the same request again).
      return res.status(403).json({ error: 'csat_disabled', code: 'CSAT_DISABLED' });
    }
    const rating = await rateClosedConversation(config, {
      workspaceId,
      conversationId: conversation.id,
      closedId: body.data.closed_id,
      score: body.data.rating,
      comment: body.data.comment,
    });
    return res.json({ ok: true, rating });
  } catch (err) {
    if (err instanceof RatingError) {
      return res.status(err.status).json(err.code === 'already_rated' && err.rating
        ? { error: err.code, rating: err.rating }
        : { error: err.code });
    }
    console.error('[widget-csat] rate error:', err?.message || err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

const transcriptBodySchema = z.object({
  locale: z.unknown().optional(),
  tz: z.unknown().optional(),
}).passthrough();

// POST /conversations/:id/transcript {locale?, tz?} — mails the transcript
// to the email on the conversation's contact (never one from the request):
// 200 {ok, to: masked} | 403 transcript_disabled (code TRANSCRIPT_DISABLED) | 409 no_email |
// 409 nothing_to_send | 429 rate_limited (+ retry_after) | limit_reached |
// workspace_limit | 502 send_failed | 503 email_unavailable.
widgetRouter.post('/conversations/:id/transcript', widgetRateLimit('transcript'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const workspaceId = resolveWorkspaceId(req, res, (req.body && req.body.workspace_id) || (req.query.workspace_id as string));
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });
  const body = transcriptBodySchema.safeParse(req.body ?? {});
  const raw = body.success ? body.data : {};
  const locale = typeof raw.locale === 'string' && /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(raw.locale) && raw.locale.length <= 10
    ? raw.locale : undefined;
  const tz = typeof raw.tz === 'string' && raw.tz.length <= 64 ? raw.tz : undefined;
  try {
    const conversation = await ownedConversation(config, req, workspaceId);
    if (!conversation) {
      return res.status(403).json({ error: 'Access denied to this conversation', code: 'CONVERSATION_ACCESS_DENIED' });
    }
    const result = await emailVisitorTranscript(config, { workspaceId, conversation, locale, tz });
    if (!('error' in result)) return res.json({ ok: true, to: result.to });
    if (result.retryAfter) {
      res.setHeader('Retry-After', String(result.retryAfter));
      return res.status(result.status).json({ error: result.error, code: 'RATE_LIMITED', retry_after: result.retryAfter });
    }
    // A 403 names its code, as csat_disabled does (fetchWith).
    return res.status(result.status).json(result.status === 403
      ? { error: result.error, code: 'TRANSCRIPT_DISABLED' }
      : { error: result.error });
  } catch (err) {
    console.error('[widget-transcript] Error:', err?.message || err);
    return res.status(500).json({ error: 'Internal error' });
  }
});


// ═══════════════════════════════════════════════
// Message reactions (issue #340 g2)
// ───────────────────────────────────────────────
// Called only by Core's late module (runtime-late.js) of a template that
// draws them (Template 2's badge and the visitor's heart): GET /poll,
// /history, /identity/history and POST /message carry no reactions, so
// `default` answers exactly as it always did. Ownership exactly as /history.
// The visitor reacts with ❤️ only, on the team's messages; what they get
// back is counts and their own part (`mine`), never who reacted. Rules:
// shared/messageReactions.ts; storage and the live event:
// services/messageReactions.ts. Before migration 276 the read is empty and a
// write 503 `migration_required`.
// ═══════════════════════════════════════════════

/** The thread a reaction route is about, when the visitor owns it (else the answer is written). */
async function reactionThread(
  config: ServerConfig,
  req: Request,
  res: Response,
  candidateWorkspaceId: string | undefined,
  ids: { visitorId: string | null; sessionId: string | null },
): Promise<{ workspaceId: string; conversationId: string } | null> {
  const workspaceId = resolveWorkspaceId(req, res, candidateWorkspaceId);
  if (res.headersSent) return null;
  if (!workspaceId) {
    res.status(400).json({ error: 'workspace_id required' });
    return null;
  }
  const conversationId = String(req.params.id || '');
  if (!CONVERSATION_ID_RE.test(conversationId)) {
    res.status(400).json({ error: 'invalid conversation id' });
    return null;
  }
  const ownership = await verifyConversationOwnership(config, conversationId, workspaceId, ids.visitorId, ids.sessionId, req);
  if (!ownership.valid) {
    res.status(403).json({ error: 'Access denied to this conversation', code: 'CONVERSATION_ACCESS_DENIED' });
    return null;
  }
  return { workspaceId, conversationId };
}

const queryId = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

// GET /conversations/:id/reactions → { reactions: { <message_id>: [{emoji, count, mine}] }, at }
// (only messages that have any; `at` = ms when they were read).
widgetRouter.get('/conversations/:id/reactions', widgetRateLimit('poll'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  try {
    const thread = await reactionThread(config, req, res, req.query.workspace_id as string, {
      visitorId: queryId(req.query.visitor_id),
      sessionId: queryId(req.query.session_id),
    });
    if (!thread) return;
    res.set('Cache-Control', 'no-store');
    // Taken before the read: a later `at` always saw every earlier write.
    const at = Date.now();
    const { byMessage } = await readConversationReactions(getServiceClient(config), thread.conversationId, { type: 'visitor' });
    const reactions: Record<string, ReturnType<typeof visitorReactionList>> = {};
    for (const [messageId, list] of byMessage) reactions[messageId] = visitorReactionList(list);
    return res.json({ reactions, at });
  } catch (err) {
    console.error('[widget-reactions] read error:', err?.message || err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

const reactionBodySchema = z.object({
  workspace_id: z.string().optional(),
  message_id: z.string().uuid(),
  emoji: z.unknown(),
  on: z.boolean(),
  visitor_id: z.string().max(200).nullable().optional(),
  session_id: z.string().max(200).nullable().optional(),
});

// POST /conversations/:id/reactions {workspace_id, message_id, emoji, on} →
// 200 {ok, message_id, reactions: [{emoji, count, mine}], at} | 400
// invalid_payload / invalid_emoji | 403 CONVERSATION_ACCESS_DENIED | 404
// message_not_found | 422 not_reactable | 503 migration_required. Sets
// (`on`) or takes back the visitor's ❤️; either is idempotent. Not a reply:
// the conversation's status, updated_at, unread counts, AI state, mails and
// pushes stay as they are, whatever its status.
widgetRouter.post('/conversations/:id/reactions', widgetRateLimit('default'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const body = reactionBodySchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_payload' });
  const emoji = normalizeReactionEmoji(body.data.emoji);
  // The visitor's one reaction (owner, 2026-10-17).
  if (emoji !== VISITOR_REACTION_EMOJI) return res.status(400).json({ error: 'invalid_emoji' });
  try {
    const thread = await reactionThread(config, req, res, body.data.workspace_id, {
      visitorId: body.data.visitor_id ?? null,
      sessionId: body.data.session_id ?? null,
    });
    if (!thread) return;
    const sb = getServiceClient(config);
    const { data: message } = await sb
      .from('conversation_messages')
      .select('id, conversation_id, sender_type, metadata')
      .eq('id', body.data.message_id)
      .eq('conversation_id', thread.conversationId)
      .maybeSingle();
    // An inbox-only row does not exist for the visitor.
    if (!message || !isVisitorVisibleMessageMeta(message.metadata)) {
      return res.status(404).json({ error: 'message_not_found' });
    }
    if (!reactableByVisitor(message)) return res.status(422).json({ error: 'not_reactable' });

    const outcome = await setMessageReaction(sb, {
      workspaceId: thread.workspaceId,
      conversationId: thread.conversationId,
      messageId: message.id as string,
      actorType: 'visitor',
      actorId: null,
      emoji,
      on: body.data.on,
    });
    if (outcome === 'missing') return res.status(503).json(REACTIONS_MIGRATION_REQUIRED);
    const at = Date.now();
    const summary = await readMessageReactions(sb, message.id as string, { type: 'visitor' });
    // Only a change is news (the visitor's other tabs, the inbox).
    if (outcome === 'changed') {
      void publishMessageReactions(config, {
        workspaceId: thread.workspaceId,
        conversationId: thread.conversationId,
        messageId: message.id as string,
        reactions: summary,
        at,
      });
    }
    return res.json({ ok: true, message_id: message.id, reactions: visitorReactionList(summary), at });
  } catch (err) {
    console.error('[widget-reactions] write error:', err?.message || err);
    return res.status(500).json({ error: 'Internal error' });
  }
});


// ═══════════════════════════════════════════════
// GET /kb-suggest — instant answers for a first message being written
// (t1/t2 Core only; routes/widgetKbSuggest.ts). Its own per-visitor bucket
// first, so a request it refuses does not spend the process ceiling.
// ═══════════════════════════════════════════════
widgetRouter.get('/kb-suggest', widgetRateLimit('kb_suggest'), kbSuggestGlobalCeiling, handleKbSuggest);

// ═══════════════════════════════════════════════
// GET /help-articles — Knowledge base articles
// ═══════════════════════════════════════════════
widgetRouter.get('/help-articles', widgetRateLimit('default'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const workspaceId = resolveWorkspaceId(req, res, req.query.workspace_id as string);
  if (res.headersSent) return;
  if (!workspaceId) return res.json({ articles: [] });

  const supabase = getServiceClient(config);
  const search = (req.query.search as string) || '';
  const locale = (req.query.locale as string) || '';
  const limit = Math.min(parseInt(req.query.limit as string || '20'), 50);

  try {
    // Articles over the plan's max_kb_articles are hidden (phase 4). The
    // lock is awaited first: the query builder is a thenable and is only
    // built here, never returned from an async helper.
    const kbLock = await resolveKbLock(config, workspaceId);
    let query = applyKbUnlockedFilter(supabase
      .from('knowledge_base_articles')
      .select('id, title, slug, content, excerpt, locale')
      .eq('workspace_id', workspaceId)
      .eq('status', 'published')
      .order('sort_order', { ascending: true })
      .limit(limit), kbLock);

    // Articles are not split by language.
    if (search) query = query.or(`title.ilike.%${search}%,content.ilike.%${search}%`);

    const { data: articles } = await query;
    return res.json({ articles: articles || [] });
  } catch (err) {
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
  /**
   * Client-generated, stable across a message's retries (same id on every
   * resend of the SAME composed message; a brand-new message gets a new
   * id). Mirrors the operator-side `/send-message` idempotency contract
   * (server/routes/conversations.ts) so a double-click or a client-side
   * retry can never create two rows for one intended send.
   */
  client_message_id: z.string().min(8).max(64).optional(),
  /** Visitor-side reply-to-message: must reference a message already in
   *  this same conversation — validated below, never trusted blindly. */
  reply_to_message_id: z.string().uuid().optional().nullable(),
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
  /**
   * AI Proactive Nudge continuity — sent only when this message resulted
   * from the visitor clicking a nudge's CTA. `nudge_id` is re-validated
   * against widget_ai_nudges (workspace-scoped) below; topic/message are
   * NEVER trusted verbatim from the client, only the id is used as a
   * lookup key.
   */
  nudge_context: z.object({
    source: z.literal('ai_proactive_nudge'),
    nudge_id: z.string().uuid(),
  }).optional().nullable(),
}).refine(
  d => !!((d.message && d.message.trim()) || (d.body && d.body.trim()) || d.attachment_id),
  { message: 'message, body, or attachment_id required' }
);

/**
 * The visitor's current session in this workspace, from the signed HttpOnly
 * `dvsid` cookie (never from a client-supplied id). The widget sends no
 * session_id on POST /message, so without this every widget conversation
 * was stored with visitor_session_id = NULL and the operator's presence
 * panel answered "unknown" for all of them.
 */
async function resolveCookieVisitorSessionId(
  supabase: ReturnType<typeof getServiceClient>,
  req: Request,
  workspaceId: string,
): Promise<string | null> {
  const visitorId = readVisitorCookie(req, workspaceId)?.v;
  if (!visitorId) return null;
  const { data, error } = await supabase
    .from('visitor_sessions')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('visitor_id', visitorId)
    .order('last_seen_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn('[widget] visitor session lookup failed:', error.message);
    return null;
  }
  return (data?.id as string | undefined) ?? null;
}

widgetRouter.post('/message', widgetRateLimit('message'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
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
  // Hoisted: needed both for the new-conversation creation-idempotency key
  // (below) and the message-insert idempotency key (further down).
  const clientMessageId = data.client_message_id || null;

  const supabase = getServiceClient(config);
  // The page-context check and the chat-enabled gate below read the same
  // widget_settings row: one read, shared (awaited at most once).
  type WidgetGateRow = {
    enabled: boolean | null;
    chat_enabled: boolean | null;
    allowed_domains: string[] | null;
    allow_subdomains: boolean | null;
  };
  let widgetRowRead: Promise<{ data: WidgetGateRow | null }> | null = null;
  const readWidgetRow = () =>
    (widgetRowRead ??= (async () => {
      const { data } = await supabase
        .from('widget_settings')
        .select('enabled, chat_enabled, allowed_domains, allow_subdomains')
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      return { data: (data as WidgetGateRow | null) ?? null };
    })());

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
    const raw = data.page_context || (req.body && req.body.pageContext) || null;
    const debugPC = process.env.DEBUG_WIDGET_PAGE_CONTEXT === '1';
    if (debugPC) {
      console.log('[widget-page-ctx] received', { workspaceId, hasRaw: !!raw });
    }
    if (raw && typeof raw === 'object') {
      const sanitizeStr = (v, max: number) =>
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
        const { data: ws } = await readWidgetRow();
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
  } catch (err) {
    console.warn('[widget-message] page_context parse failed:', err?.message || err);
    pageContext = null;
  }

  // ─── AI Proactive Nudge continuity ────────────────────────────────────
  // The client sends only `nudge_id` — topic/message are ALWAYS re-read
  // from widget_ai_nudges here, scoped to this workspace, so a forged or
  // cross-workspace nudge_id can never inject arbitrary text into the
  // AI Agent's prompt.
  let nudgeContext: { topic: string; message: string } | null = null;
  let nudgeIdForAttribution: string | null = null;
  const nudgeCtxInput = data.nudge_context || null;
  if (nudgeCtxInput?.nudge_id) {
    try {
      const { data: nudgeRow } = await supabase
        .from('widget_ai_nudges')
        .select('id, topic, message')
        .eq('id', nudgeCtxInput.nudge_id)
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      if (nudgeRow) {
        nudgeContext = { topic: String(nudgeRow.topic || '').slice(0, 60), message: String(nudgeRow.message || '').slice(0, 400) };
        nudgeIdForAttribution = nudgeRow.id as string;
      }
    } catch (err) {
      console.warn('[widget-message] nudge_context lookup failed:', err?.message || err);
    }
  }

  try {
    // Verify widget is enabled
    const { data: widget } = await readWidgetRow();

    if (!widget?.enabled || widget.chat_enabled === false) {
      return res.status(403).json({ error: 'Chat not enabled' });
    }

    // Pass E12-Hardening — compute the AI-off verdict once. When OFF, we must
    // not run any AI side-effects and must restore conversations out of the
    // Automated inbox so they appear in Main Inbox.
    // P0-G — this now delegates to the ONE canonical visitor-facing gate
    // instead of re-reading platform flags locally: the previous local copy
    // ignored the plan module and the per-workspace platform_disabled latch,
    // so the widget could believe AI was live while the engine skipped it,
    // stranding conversations in the Automated inbox with no responder.
    let platformAiOff = false;
    let platformAiOffReason: PlatformOffReason = 'platform_ai_disabled';
    try {
      const { isAutoAnswerAllowedForWorkspace } = await import('../services/ai-agent/platformGuards.js');
      const gate = await isAutoAnswerAllowedForWorkspace(config, workspaceId);
      if (gate.allowed !== true) {
        platformAiOff = true;
        platformAiOffReason = (gate.reason || 'platform_ai_disabled') as PlatformOffReason;
      }
    } catch {
      // Fail-closed, matching the canonical gate: treat AI as off so the
      // conversation lands in Main Inbox where a human will actually see it.
      platformAiOff = true;
      platformAiOffReason = 'auto_answer_guard_error';
    }


    let convId = body.conversation_id || null;

    // Verify conversation ownership if provided
    if (convId) {
      const ownership = await verifyConversationOwnership(config, convId, workspaceId, body.visitor_id, body.session_id, req);
      if (!ownership.valid) {
        convId = null; // Will create new conversation
      } else {
        const conv = ownership.conversation;
        // Threads created before the session link existed carry no
        // visitor_session_id. Fill it (never overwrite) from this visitor's
        // own cookie session so the operator's presence panel can find them.
        if (!conv.visitor_session_id && conv.status !== 'closed') {
          const linkSessionId = await resolveCookieVisitorSessionId(supabase, req, workspaceId);
          if (linkSessionId) {
            await supabase.from('conversations')
              .update({ visitor_session_id: linkSessionId })
              .eq('id', convId).is('visitor_session_id', null);
          }
        }
        // Shared lifecycle: `closed` is archived and must never be revived —
        // the message below starts a brand new conversation instead.
        // `pending`/`resolved` stay untouched here: those transitions are
        // customer-reply transitions applied AFTER the message is committed
        // (applyInboundConversationLifecycle), so they emit a timeline event
        // and a realtime update instead of changing status silently.
        if (conv.status === 'closed') convId = null;
      }
    }

    // Try to find existing conversation by visitor identity
    if (!convId && body.visitor_id && !body.force_new_conversation) {
      // By session
      if (body.session_id) {
        const { data: existingConv } = await supabase
          .from('conversations').select('id')
          .eq('workspace_id', workspaceId).eq('visitor_session_id', body.session_id)
          .in('status', INBOUND_REUSABLE_STATUSES as unknown as string[])
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
          // open / pending / resolved are continuable; `closed` is archived
          // and deliberately excluded so it spawns a new conversation.
          const { data: existingConv } = await supabase
            .from('conversations').select('id')
            .eq('workspace_id', workspaceId).eq('contact_id', contact.id)
            .in('status', INBOUND_REUSABLE_STATUSES as unknown as string[])
            .order('updated_at', { ascending: false }).limit(1).maybeSingle();
          if (existingConv) {
            // No silent status change: pending/resolved transition after the
            // message is committed, with timeline event + realtime echo.
            convId = existingConv.id;
          }
        }
      }

      // SECURITY: there is deliberately NO fallback that resolves a contact by
      // the visitor-supplied `visitor_email` / `visitor_phone` and appends to
      // that contact's open thread. Those fields are unverified claims — the
      // old fallback let anyone who typed a customer's email post into (and
      // receive the conversation_id of) that customer's conversation.
      // Cross-device continuation goes through /identity/verify/confirm or
      // the continuity cookie instead.
    }

    // Create new conversation
    if (!convId) {
      // Phase 5 — enforce max_conversations only on this creation
      // branch. Replies into an existing conversation (the branches
      // above) intentionally bypass the cap. workspace_id has already
      // been resolved via resolveWorkspaceId() + widget token checks.
      {
        const ok = await enforceMaxConversationsLimit(req, res, workspaceId);
        if (!ok) return;
      }

      // Find or create contact. Every conversation gets one — anonymous
      // visitors get a placeholder contact that the pre-chat / identity
      // form later fills in (see services/widget/anonymousContact.ts).
      // visitor_email / visitor_phone are unverified here (identityVerified
      // unset): they are recorded on this visitor's own/new contact only and
      // never select an existing contact, so the continuity cookie issued
      // below can never point at somebody else's contact.
      const contactId: string | null = await ensureVisitorContact(supabase, {
        workspaceId,
        visitorId: body.visitor_id || null,
        sessionId: body.session_id || null,
        name: body.visitor_name || null,
        email: body.visitor_email || null,
        phone: body.visitor_phone || null,
      });

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
        } catch (e) {
          console.warn('[widget] cross-widget identity link failed:', e?.message || e);
        }
      }

      const subjectText = body.message ? body.message.slice(0, 80) : (data.attachment_id ? '[Attachment]' : null);
      // Atomic match-or-create (migration 071). Two genuinely different
      // messages sent at the same instant by the same visitor — typically
      // right after their previous thread was `closed` — converge on ONE new
      // conversation instead of creating one per request: the loser of the
      // race blocks on the per-(workspace, visitor) advisory lock and then
      // matches the winner's row. `closed` threads are never matched, so the
      // archived one stays archived.
      //
      // Lost-response retry safety: the widget client sends NEITHER
      // visitor_id NOR session_id on POST /message (identity there is the
      // HttpOnly `dvsid` cookie only, which this creation path — unlike
      // /identity/history — never consults), so p_match_session_id/
      // p_match_contact_id below essentially never match anything for a
      // visitor's very first message. Concretely: visitor sends message 1,
      // the server creates conversation A and inserts message A, but the
      // HTTP response is lost before the client sees `conversation_id`. The
      // client still believes it has no conversation. A retry (manual or
      // via resendMessage(), reusing the SAME client_message_id) would,
      // without this, call ensure_active_conversation a second time with no
      // match key that could find conversation A — creating a second
      // conversation B with a duplicate logical message. That is a real
      // conversation-level duplicate no `client_message_id` check inside a
      // single conversation can catch, since it never learns conversation A
      // exists.
      //
      // Fix: reuse the RPC's existing `p_match_thread_key` mechanism (today
      // only exercised by channel bridges — Telegram/WhatsApp/etc. thread
      // ids) as a client-message-scoped creation-idempotency key. It is
      // matched — inside the SAME advisory-locked transaction as the
      // insert — BEFORE the session/contact fallback, so a retry with the
      // identical client_message_id deterministically finds conversation A
      // instead of creating conversation B, and namespaced
      // (`widget_cmid:`) so it can never collide with a real external
      // channel thread key.
      //
      // This does NOT weaken "+ New conversation": forcingNew() always
      // mints a brand-new client_message_id for that first message (see
      // runtime.js sendMessage), so the thread-key match only ever reunites
      // RETRIES of the exact same compose attempt — it never reattaches to
      // an unrelated prior open conversation the way matching on a stable
      // visitor/session identity would.
      const widgetThreadKey = clientMessageId ? `widget_cmid:${clientMessageId}` : null;
      const lockKey = clientMessageId || body.session_id || body.visitor_id || contactId || `anon:${Date.now()}:${Math.random()}`;
      // The link (not a match key): which session this conversation belongs
      // to, so presence-by-conversation and the Visitors list can pair them.
      // Taken from the signed cookie because the widget sends no session_id.
      // It stays out of p_match_session_id on purpose — see above: a new
      // compose must never reattach to an older open thread by identity.
      const linkSessionId = body.session_id || await resolveCookieVisitorSessionId(supabase, req, workspaceId);
      const { data: ensured, error: convErr } = await supabase.rpc('ensure_active_conversation', {
        p_workspace_id: workspaceId,
        p_lock_key: lockKey,
        p_match_thread_key: widgetThreadKey,
        p_match_session_id: body.session_id || null,
        p_match_contact_id: contactId,
        p_contact_id: contactId,
        p_visitor_session_id: linkSessionId,
        p_subject: subjectText,
        p_metadata: widgetThreadKey ? { channel_thread_key: widgetThreadKey } : {},
      });

      if (convErr) throw convErr;
      const ensuredRow = Array.isArray(ensured) ? ensured[0] : ensured;
      if (!ensuredRow?.id) throw new Error('conversation creation failed');
      convId = ensuredRow.id as string;
      const createdNewConversation = Boolean(ensuredRow.created);

      // Only the winner emits creation events — the losing concurrent request
      // attached to an existing conversation and must not duplicate them.
      if (createdNewConversation) {
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
    }


    // NOTE: the "awaiting customer reply" resume runs AFTER the visitor
    // message is committed (below), so a failed insert can never un-park a
    // thread that has no new customer reply.


    // Insert visitor message (body may be empty when only an attachment is sent)
    const messageBody = body.message || (data.attachment_id ? '' : '');
    const MESSAGE_COLUMNS = 'id, conversation_id, sender_type, body, created_at, metadata, seen_at, reply_to_message_id';

    // Reply-to: only ever accept a target that already exists in THIS same
    // conversation — never trust a cross-conversation id from the client
    // (that would let one visitor's widget leak a snippet of a message from
    // a conversation it has no access to). A miss is dropped silently, same
    // as an invalid page_context — it never fails the send itself.
    // Selecting body/sender_type here (not just id) means the send RESPONSE
    // and the realtime envelope can both carry a resolved preview with zero
    // extra round-trips — the same shape enrichMessagesWithReplyTo resolves
    // for /poll, /history and /identity/history from the DB afterwards.
    //
    // The DB-stored FK (dbReplyToMessageId) is kept even when the parent is
    // an internal staffing/system notice — same-conversation is still a
    // true fact about the reply, and the column may be useful internally
    // for audit/integrity — but nothing PUBLIC (the send response, the
    // realtime envelope, and every other read path via
    // enrichMessagesWithReplyTo) may ever expose that id unless the parent
    // also passes the canonical visitor-visibility check. A visitor who
    // supplies the UUID of an internal message must see a response
    // INDISTINGUISHABLE from a missing/deleted parent: both
    // reply_to_message_id AND reply_to come back null publicly — the raw id
    // by itself would otherwise be a visibility oracle ("something exists
    // here I can't see"). Never expose an internal message's body OR id to
    // the browser.
    let dbReplyToMessageId: string | null = null;
    let publicReplyToMessageId: string | null = null;
    let replyToPreview: ReplyToPreview | null = null;
    if (data.reply_to_message_id) {
      const { data: parent } = await supabase
        .from('conversation_messages')
        .select('id, body, sender_type, metadata')
        .eq('id', data.reply_to_message_id)
        .eq('conversation_id', convId)
        .maybeSingle();
      if (parent) {
        dbReplyToMessageId = parent.id;
        // Visible to the visitor, and a system row quoted as its kind (the
        // widget writes it in the visitor's language): the same rule as
        // every read path (widgetAttachments.ts visitorReplyPreview).
        replyToPreview = visitorReplyPreview(parent);
        if (replyToPreview) publicReplyToMessageId = parent.id;
      }
    }

    const insertMetadata: Record<string, unknown> = {
      source: 'widget',
      visitor_id: body.visitor_id,
      session_id: body.session_id,
      attachment_id: data.attachment_id || undefined,
      department_id: data.department_id || undefined,
      page_context: pageContext || undefined,
      nudge_context: nudgeIdForAttribution ? { source: 'ai_proactive_nudge', nudge_id: nudgeIdForAttribution } : undefined,
    };
    if (clientMessageId) insertMetadata.client_message_id = clientMessageId;

    /**
     * Idempotency (double-click / client retry / resend-after-failure).
     * Mirrors server/routes/conversations.ts's operator-side `/send-message`
     * exactly, including reuse of the SAME partial unique index from
     * migration 070 (`conversation_id`, `metadata->>'client_message_id'`) —
     * there is one idempotency mechanism for `conversation_messages`
     * inserts, not a second one invented for the widget. The lookup here
     * only avoids a pointless failing insert; the unique index is the real
     * guard against a genuine race between two near-simultaneous retries.
     */
    let duplicate = false;
    let insertedMsg = null;
    if (clientMessageId) {
      const { data: prior } = await supabase
        .from('conversation_messages')
        .select(MESSAGE_COLUMNS)
        .eq('conversation_id', convId)
        .filter('metadata->>client_message_id', 'eq', clientMessageId)
        .maybeSingle();
      if (prior) { insertedMsg = prior; duplicate = true; }
    }

    if (!insertedMsg) {
      const { data: row, error: insErr } = await supabase
        .from('conversation_messages').insert({
          conversation_id: convId,
          body: messageBody,
          sender_type: 'contact',
          // The true FK — stored regardless of visitor-visibility (see the
          // doc comment above dbReplyToMessageId). Only the PUBLIC response
          // and realtime envelope further down are sanitized.
          reply_to_message_id: dbReplyToMessageId,
          metadata: insertMetadata,
        })
        .select(MESSAGE_COLUMNS)
        .single();
      if (insErr || !row) {
        // Lost the race against a concurrent replay of the same key.
        if (clientMessageId && /duplicate key|23505/i.test(insErr?.message || '')) {
          const { data: prior } = await supabase
            .from('conversation_messages')
            .select(MESSAGE_COLUMNS)
            .eq('conversation_id', convId)
            .filter('metadata->>client_message_id', 'eq', clientMessageId)
            .maybeSingle();
          if (prior) { insertedMsg = prior; duplicate = true; }
        }
        if (!insertedMsg) throw insErr || new Error('Insert failed');
      } else {
        insertedMsg = row;
      }
    }

    // AI Proactive Nudge attribution — best-effort, never blocks the message.
    // Skipped on a duplicate replay: the original send already attributed
    // this nudge exactly once.
    if (!duplicate && nudgeIdForAttribution && convId) {
      // Guarded transition only — a nudge that was never clicked cannot
      // silently become "converted" and corrupt attribution.
      void transitionNudgeStatus(supabase, { nudgeId: nudgeIdForAttribution, workspaceId, to: 'converted' });
      // Route the analytics event through the same canonical, server-owned
      // idempotency path as every other ai_proactive event (recordSmartEvent
      // derives the key itself; the value passed here is ignored for this
      // source), so this call site can never diverge from that convention.
      void recordSmartEvent(supabase, {
        workspaceId,
        source: 'ai_proactive',
        aiNudgeId: nudgeIdForAttribution,
        eventType: 'conversation_started',
        visitorId: body.visitor_id || null,
        sessionId: body.session_id || null,
        pagePath: pageContext?.currentPagePath || null,
        idempotencyKey: `conversation_started:${nudgeIdForAttribution}`,
      });
    }

    // "Awaiting customer reply" threads return to the active queue as soon as
    // the customer writes again. Conditional, atomic and idempotent; the
    // shared guard rejects anything that is not a real inbound customer
    // message. Skipped on a duplicate replay — the original send already
    // ran this transition for the same logical message.
    //
    // The thread's `updated_at` touch comes first and returns the status it
    // found, so the lifecycle only sends the transition that can apply: an
    // open thread (the usual case) now costs this one write instead of two
    // conditional updates that matched nothing plus the touch.
    let touchedStatus: string | null = null;
    if (convId) {
      const { data: touched } = await supabase.from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', convId)
        .select('status')
        .maybeSingle();
      touchedStatus = typeof touched?.status === 'string' ? touched.status : null;
    }
    if (!duplicate && convId && insertedMsg?.id) {
      await applyInboundConversationLifecycle(config, {
        workspaceId,
        conversationId: convId,
        source: 'widget',
        messageId: insertedMsg.id,
        knownStatus: touchedStatus,
        message: {
          senderType: insertedMsg.sender_type,
          direction: 'inbound',
          text: messageBody,
          attachmentCount: data.attachment_id ? 1 : 0,
        },
      });
    }


    // Phase 6a — Bind uploaded attachment to this message + conversation.
    // Skipped on a duplicate replay — already bound by the original send.
    if (!duplicate && data.attachment_id && insertedMsg?.id) {
      const ok = await attachUploadedFileToMessage(
        config, data.attachment_id, workspaceId, convId!, insertedMsg.id
      );
      if (!ok) {
        // Don't fail the message; the attachment just won't be linked.
        console.warn('[widget] Failed to attach', data.attachment_id, 'to message', insertedMsg.id);
      }
    }

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
        // Logged only when the conversation actually moved back to the main
        // inbox: with platform AI off this runs on every visitor message.
        if (restored.changed) {
          console.log('[widget-message] platform_ai_disabled_restore', {
            workspace_id: workspaceId,
            conversation_id: convId,
            reason: platformAiOffReason,
            previous_ai_state: restored.previousAiState,
          });
        }
      } catch (e) {
        console.warn('[widget-message] platform_ai_disabled_restore_failed:', e?.message || e);
      }
    }

    // Realtime: broadcast the visitor message to the inbox subscriber.
    // Fire-and-forget — DB row is the source of truth. Skipped on a
    // duplicate replay: the original send already broadcast and pushed
    // this exact message once — replaying it would double-deliver.
    if (insertedMsg && !duplicate) {
      publishConversationEvent(
        config,
        workspaceId,
        convId!,
        // Merge in the already-resolved parent preview (fetched above, zero
        // extra query) so a live realtime delivery carries the structured
        // reply relationship immediately — the receiving widget never has
        // to wait for a poll/history round-trip to render the quote box.
        // reply_to_message_id is overridden with the SANITIZED public id
        // (not insertedMsg's raw DB column, which may still be the true FK
        // to a hidden/internal parent) — the envelope must follow the exact
        // same public contract as every other read path.
        buildMessageEnvelope({ ...(insertedMsg as Parameters<typeof buildMessageEnvelope>[0]), reply_to_message_id: publicReplyToMessageId, reply_to: replyToPreview }),
      ).catch(() => {});

      // NATIVE PUSH — same central dispatcher as every other channel.
      // Fire-and-forget after commit: a push failure never fails the widget
      // message, and the dispatcher itself dedupes per messageId.
      void notifyInboundMessage(config, {
        workspaceId,
        conversationId: convId!,
        messageId: insertedMsg.id,
        text: messageBody,
        senderName: body?.visitor_name || null,
        channel: 'widget',
        attachmentCount: data.attachment_id ? 1 : 0,
      });
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
    // Skipped on a duplicate replay — the original send already triggered
    // (or correctly skipped) exactly one AI run for this message; running
    // it again would risk a second AI reply for one visitor message.
    // ─────────────────────────────────────────────────────────────────────
    if (!duplicate && insertedMsg?.id && convId && !platformAiOff) {
      const aiConvId = convId;
      const aiMsgId = insertedMsg.id;
      void maybeRunAiAssistantAfterVisitorMessage(config, {
        workspaceId,
        conversationId: aiConvId,
        visitorMessageId: aiMsgId,
        question: messageBody,
        locale: (req.body && (req.body.locale as string)) || undefined,
        pageContext: pageContext || undefined,
        nudgeContext: nudgeContext || undefined,
      })
        .then(async (result) => {
          // Observability: several engine outcomes (empty question, agent
          // disabled, duplicate suggestion, internal failure) return without
          // writing an ai_agent_runs row, which makes a silent AI impossible
          // to diagnose from the database. Persist those outcomes here.
          if (!result || result.runId) return;
          try {
            await logAiRun(config, {
              workspaceId,
              conversationId: aiConvId,
              visitorMessageId: aiMsgId,
              runType: 'skip',
              mode: 'unknown',
              status: result.action === 'failed' ? 'failed' : 'skipped',
              inputText: messageBody,
              skipReason: result.reason || result.action || 'unlogged_outcome',
              metadata: { engine_outcome: result.action || null, engine_reason: result.reason || null },
            });
          } catch { /* diagnostics must never break the visitor flow */ }
        })
        .catch((e) =>
          console.warn('[widget-message] AI Agent engine error:', e?.message || e),
        );
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
      // Structured reply-to-message relationship (§ reply-to end-to-end):
      // the SANITIZED (public) id plus a resolved preview, so the widget
      // can paint the quote box on the just-sent bubble without a second
      // request. Both are null together for a hidden/foreign/missing
      // parent — never just the preview — so the id alone can't be used as
      // a visibility oracle. Same shape /poll, /history and
      // /identity/history resolve independently via enrichMessagesWithReplyTo
      // for every OTHER read path.
      reply_to_message_id: publicReplyToMessageId,
      reply_to: replyToPreview,
    });
  } catch (err) {
    // Full detail (Postgres code/constraint/message) stays server-side only —
    // the public response carries a stable, sanitized code so the widget can
    // distinguish/report failure classes without ever seeing raw DB internals.
    console.error('[widget-message] Error:', err.message);
    res.status(500).json({ error: 'Message send failed', code: 'MESSAGE_PERSIST_FAILED' });
  }
});

// ═══════════════════════════════════════════════
// POST /track — Visitor tracking event
// ═══════════════════════════════════════════════
/**
 * How recently a session / presence row must have been written for an
 * UNCHANGED /track repeat (same URL, same network identity and device) to
 * skip rewriting it. Deliberately short: well inside the 45s realtime handoff
 * window (presenceSource.ts), so a reload can never make a visitor read as
 * offline while their socket reconnects, and far inside the 240s database
 * liveness window. A changed URL or column always writes, whatever the age.
 */
const TRACK_REWRITE_MS = 15_000;

/**
 * Sessions whose geo enrichment was attempted, per (session, address), and
 * when. With no geo source that can place an address (no MaxMind file, no
 * provider), enrichment writes nothing, `geo_resolved_at` stays empty, and
 * every page view of the session used to run the whole resolution again:
 * a session read, two provider reads and two cache reads per /track. One
 * attempt per session and address every GEO_ATTEMPT_TTL_MS is enough; a new
 * address (VPN, mobile handover) is a new key and resolves at once.
 */
const GEO_ATTEMPT_TTL_MS = 10 * 60_000;
const GEO_ATTEMPT_MAX_ENTRIES = 50_000;
const geoAttemptedAt = new Map<string, number>();

function geoEnrichmentAttemptedRecently(sessionId: string, ipHash: string | null): boolean {
  const at = geoAttemptedAt.get(`${sessionId}:${ipHash ?? ''}`);
  return at !== undefined && Date.now() - at < GEO_ATTEMPT_TTL_MS;
}

function markGeoEnrichmentAttempt(sessionId: string, ipHash: string | null): void {
  if (geoAttemptedAt.size >= GEO_ATTEMPT_MAX_ENTRIES) geoAttemptedAt.clear();
  geoAttemptedAt.set(`${sessionId}:${ipHash ?? ''}`, Date.now());
}

widgetRouter.post('/track', widgetRateLimit('default'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
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
    utm_source,
    utm_medium,
    utm_campaign,
    utm_term,
    utm_content,
    language,
  } = req.body;

  try {
    const normalizedEvent = event_type || event;
    const normalizedPageUrl = page_url || current_page || null;
    let activeSessionId: string | null = session_id || null;

    if (normalizedEvent === 'page_view' || normalizedEvent === 'heartbeat') {
      const clientIp = getClientIp(req);
      // Canonical, null-safe hashing (server/utils/clientIp.ts). The previous
      // inline crypto.createHash(...).update(clientIp) threw whenever no
      // public IP could be resolved, which silently aborted the whole
      // tracking branch (the catch below swallows it and returns ok:true).
      const ipHash = hashIp(clientIp);
      // The independent reads below run together, and so do the writes: a
      // navigation costs 2 database round trips instead of 5. The operations
      // and what each branch writes are unchanged.
      //
      // Privacy gate: only persist raw IP when the workspace explicitly
      // opts in — same setting + same rule as /api/visitors/track. This
      // endpoint (the chat widget's own background tracker, loader.js) was
      // never actually reading it, so a raw IP was never stored for ANY
      // chat-widget visitor regardless of the toggle — contacts.ts's /ip
      // lookup and identityMerge's location enrichment had nothing to read.
      // Read from the database on every request (not the config snapshot),
      // so the toggle holds from the very next request, on every node.
      const storeRawIpRead = (async () => {
        try {
          const { data: ws } = await supabase
            .from('widget_settings')
            .select('store_raw_ip')
            .eq('workspace_id', workspaceId)
            .maybeSingle();
          return ws?.store_raw_ip === true;
        } catch { return false; /* default to not storing on lookup failure */ }
      })();

      // Check for existing recent session
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const sessionRead = supabase
        // ip_hash is fetched so a mid-session network change (VPN / mobile
        // handover) forces a geo re-resolve instead of keeping the old country.
        // current_page detects a URL change BEFORE it is overwritten, and the
        // remaining columns let an unchanged repeat skip its writes (below).
        // (Only columns every chain has: ip_raw is hosted-only, so it is read
        // separately below and a failure there just means "write".)
        .from('visitor_sessions').select('id, ip_hash, current_page, browser, device, os, last_seen_at')
        .eq('workspace_id', workspaceId).eq('visitor_id', visitor_id || '')
        .gte('last_seen_at', thirtyMinAgo)
        .order('last_seen_at', { ascending: false }).limit(1).maybeSingle();
      const [storeRawIp, { data: existing }] = await Promise.all([storeRawIpRead, sessionRead]);
      const ipRawForStorage = storeRawIp ? clientIp : null;

      let previousIpHash: string | null = null;
      if (existing) {
        activeSessionId = existing.id;
        previousIpHash = (existing.ip_hash as string | null) ?? null;
        const prevPage = (existing.current_page as string | null) ?? null;
        const nowMs = Date.now();

        // An unchanged repeat — same URL (a reload, a redirect back, a
        // duplicate track call), same network identity and device, within
        // TRACK_REWRITE_MS of the last write — would rewrite the row with
        // what it already holds. Every column the UPDATE below sets is
        // compared exactly as that UPDATE would set it.
        const lastSeenMs = existing.last_seen_at ? Date.parse(existing.last_seen_at as string) : NaN;
        let sessionUnchanged =
          (normalizedPageUrl ?? null) === prevPage &&
          (!browser || browser === existing.browser) &&
          (!device || device === existing.device) &&
          (!os || os === existing.os) &&
          (!ipHash || ipHash === existing.ip_hash) &&
          Number.isFinite(lastSeenMs) &&
          nowMs - lastSeenMs < TRACK_REWRITE_MS;
        let presenceFresh = false;
        if (sessionUnchanged) {
          // The two checks of an unchanged repeat, read together:
          //  - ip_raw must match too, or the privacy toggle would not take
          //    effect on this request. Anything but a clean read of an equal
          //    value (including a chain without the column) means the write
          //    runs.
          //  - The presence row is normally written together with the
          //    session, but it is checked on its own: another path may have
          //    marked it offline since. More than one row (a creation race)
          //    reads as "not fresh", so it gets the unconditional update, as
          //    before. It counts only when the session is still unchanged.
          const [{ data: rawRow, error: rawErr }, { data: presence }] = await Promise.all([
            supabase.from('visitor_sessions')
              .select('ip_raw').eq('id', existing.id).maybeSingle(),
            supabase.from('visitor_presence')
              .select('status, current_page, updated_at').eq('visitor_session_id', existing.id).maybeSingle(),
          ]);
          sessionUnchanged =
            !rawErr && !!rawRow && (ipRawForStorage ?? null) === ((rawRow.ip_raw as string | null) ?? null);
          const presenceMs = presence?.updated_at ? Date.parse(presence.updated_at as string) : NaN;
          presenceFresh =
            sessionUnchanged &&
            !!presence &&
            presence.status === 'online' &&
            ((presence.current_page as string | null) ?? null) === (normalizedPageUrl ?? null) &&
            Number.isFinite(presenceMs) &&
            nowMs - presenceMs < TRACK_REWRITE_MS;
        }

        // Independent rows: written together.
        const writes: Array<PromiseLike<unknown>> = [];
        if (!sessionUnchanged) {
          writes.push(supabase.from('visitor_sessions')
            .update({
              current_page: normalizedPageUrl,
              browser: browser || undefined,
              device: device || undefined,
              os: os || undefined,
              last_seen_at: new Date().toISOString(),
              // Sync network identity on every page_view / heartbeat. Sessions
              // created by another surface (call widget / identity bootstrap)
              // start with ip_hash = null, and the raw-IP privacy toggle must
              // take effect on the very next request in both directions:
              //   store_raw_ip = true  → persist the raw IP
              //   store_raw_ip = false → clear any previously stored raw IP
              ...(ipHash ? { ip_hash: ipHash } : {}),
              ip_raw: ipRawForStorage,
            })
            .eq('id', existing.id));
        }

        if (!presenceFresh) {
          writes.push(supabase.from('visitor_presence')
            .update({ status: 'online', current_page: normalizedPageUrl, updated_at: new Date().toISOString() })
            .eq('visitor_session_id', existing.id));
        }

        // Append a page-view row when the URL is new for this session.
        // First page_view of an existing session also counts (prevPage may
        // be null on rehydrated sessions).
        if (normalizedPageUrl && normalizedPageUrl !== prevPage) {
          writes.push(recordVisitorPageView(config, supabase, {
            workspaceId,
            sessionId: existing.id,
            url: normalizedPageUrl,
            title: page_title,
            context: 'widget-track',
          }));
        }
        await Promise.all(writes);
      } else if (visitor_id) {
        // A new row may count against the workspace's monthly visitor quota,
        // and visitor_id is the client's: new rows are budgeted per address.
        if (!takeNewVisitorSession(req, res, workspaceId)) return;
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
            // First-touch attribution — set once, at session creation, and
            // never overwritten on later page_view/heartbeat calls for the
            // same session (Web Analytics' Traffic Sources report reads
            // these; see server/services/webAnalytics/channels.ts).
            utm_source: utm_source ? String(utm_source).slice(0, 200) : null,
            utm_medium: utm_medium ? String(utm_medium).slice(0, 200) : null,
            utm_campaign: utm_campaign ? String(utm_campaign).slice(0, 200) : null,
            utm_term: utm_term ? String(utm_term).slice(0, 200) : null,
            utm_content: utm_content ? String(utm_content).slice(0, 200) : null,
            language: language ? String(language).slice(0, 35) : null,
          }).select('id').maybeSingle();

        if (newSession) {
          activeSessionId = newSession.id;
          // The presence row and the first page view need only the session
          // id: written together.
          await Promise.all([
            supabase.from('visitor_presence').insert({
              workspace_id: workspaceId,
              visitor_session_id: newSession.id,
              status: 'online',
              current_page: normalizedPageUrl,
            }),
            // Always log the very first page view of a brand-new session.
            normalizedPageUrl
              ? recordVisitorPageView(config, supabase, {
                workspaceId,
                sessionId: newSession.id,
                url: normalizedPageUrl,
                title: page_title,
                context: 'widget-track',
              })
              : null,
          ]);
          // Fire-and-forget geo enrichment — never block the widget response.
          // Uses MaxMind local DB when configured (city-level), with cache.
          // Marked as attempted so the existing-session check below does not
          // enrich the brand-new session a second time.
          markGeoEnrichmentAttempt(newSession.id, ipHash);
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
      if (activeSessionId && !geoEnrichmentAttemptedRecently(activeSessionId, ipHash)) {
        markGeoEnrichmentAttempt(activeSessionId, ipHash);
        void (async () => {
          try {
            const { data: row } = await supabase
              .from('visitor_sessions')
              .select('geo_resolved_at')
              .eq('id', activeSessionId)
              .maybeSingle();
            const ipChanged = !!previousIpHash && !!ipHash && previousIpHash !== ipHash;
            if (!row || !row.geo_resolved_at || ipChanged) {
              await enrichVisitorSessionGeo(config, {
                sessionId: activeSessionId!,
                workspaceId,
                ipHash,
                rawIp: clientIp,
                country: getClientCountry(req),
                previousIpHash,
              });
            }
          } catch {/* best-effort */}
        })();
      }
    }

    return res.json({ ok: true, session_id: activeSessionId });
  } catch (err) {
    console.error('[widget-track] Error:', err.message);
    res.json({ ok: true, session_id: session_id || null }); // Don't fail on tracking errors
  }
});

// ═══════════════════════════════════════════════
// POST /event — Web Analytics custom event
// (window.gsAnalytics.track(name, properties) in the loader snippet)
// ═══════════════════════════════════════════════
widgetRouter.post('/event', widgetRateLimit('default'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const workspaceId = resolveWorkspaceId(req, res, req.body?.workspace_id);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const { session_id, event_name, properties, page_url } = req.body;
  if (typeof event_name !== 'string' || !event_name.trim()) {
    return res.status(400).json({ error: 'event_name required' });
  }

  try {
    const result = await trackEvent(config, {
      workspaceId,
      sessionId: typeof session_id === 'string' ? session_id : null,
      eventName: event_name,
      properties,
      pageUrl: typeof page_url === 'string' ? page_url : null,
    });
    res.json(result);
  } catch (err) {
    console.error('[widget-event] Error:', err.message);
    res.json({ ok: true }); // Never fail the visitor's page on a tracking error
  }
});

// ═══════════════════════════════════════════════
// PUT /action — Heartbeat, Typing, Reopen, CSAT
// ═══════════════════════════════════════════════
widgetRouter.put('/action', widgetRateLimit('default'), perfHttpMiddleware('widget.action'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const workspaceId = resolveWorkspaceId(req, res, req.body?.workspace_id);
  if (res.headersSent) return;

  const { action, conversation_id, visitor_id, session_id, visitor_name, visitor_email, visitor_phone, current_page, page_title, presence_lease } = req.body;
  const supabase = getServiceClient(config);

  try {
    if (action === 'heartbeat' && workspaceId) {
      const now = new Date().toISOString();

      // Realtime-first presence: liveness is proven by the widget's own live
      // subscription, evidenced per session by a signed presence lease. Only
      // then does the heartbeat skip its write — a workspace-wide flag would
      // silently drop visitors whose socket never opened. Durable business
      // facts (a real navigation, page-view history) always reach PostgreSQL.
      const presenceMode = await resolveVisitorPresenceMode(config, workspaceId);
      const sessionOwnedByRealtime =
        presenceMode === 'realtime' &&
        !!session_id &&
        verifyVisitorPresenceLease(presence_lease, workspaceId, session_id);
      const realtimePresence = sessionOwnedByRealtime;


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
        // `conversations.updated_at` is business recency, not liveness: in
        // realtime mode the open subscription already proves the visitor is
        // here, so touching the row on every tick would be exactly the write
        // amplification this architecture removes.
        if (!realtimePresence) {
          await supabase.from('conversations').update({ updated_at: now }).eq('id', conversation_id);
        }
        return res.json({ ok: true, presence_mode: presenceMode });
      }

      if (session_id) {
        // Liveness is coalesced server-side: the RPC only writes when the
        // visitor navigated or the row aged past the refresh interval, so a
        // 60 s heartbeat no longer costs a write per tick. Page-view history
        // (business data) is still appended on every real URL change.
        // In realtime mode the minimum interval is effectively infinite: the
        // RPC then writes ONLY when `current_page` actually changed
        // (navigation = durable business fact) and coalesces everything else
        // away. In database mode the historical refresh interval applies.
        const touch = await touchVisitorLiveness(supabase, {
          workspaceId,
          sessionId: session_id,
          visitorId: visitor_id || null,
          currentPage: current_page || null,
          minIntervalMs: realtimePresence ? VISITOR_LIVENESS_NAVIGATION_ONLY_MS : undefined,
        });
        recordVisitorLivenessWrite(
          touch.wrote && !touch.pageChanged
            ? 'wrote'
            : sessionOwnedByRealtime
              ? 'skipped_lease'
              : 'coalesced',
          presenceMode,
        );


        if (!touch.matched) {
          return res.json({ ok: true, matched: false });
        }

        if (touch.pageChanged && current_page) {
          await recordVisitorPageView(config, supabase, {
            workspaceId,
            sessionId: session_id,
            url: current_page,
            title: page_title,
            context: 'widget-action',
          });
        }

        return res.json({ ok: true, presence_mode: presenceMode });
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
      // `pending` is intentionally excluded: reopening the panel is not a
      // reply. The visitor's next actual message transitions the thread
      // through applyInboundConversationLifecycle, which records the event.
      // `closed` is archived — the panel must start a new conversation.
      if (conv.status === 'closed') {
        return res.json({ ok: false, closed: true, status: 'closed' });
      }
      if (conv.status === 'resolved') {
        const { data: reopened } = await supabase.from('conversations')
          .update({ status: 'open', updated_at: new Date().toISOString() })
          .eq('id', conversation_id)
          .eq('status', 'resolved')
          .select('id')
          .maybeSingle();
        if (reopened) {
          void recordConversationEvent(config, {
            workspaceId,
            conversationId: conversation_id,
            eventType: 'reopened',
            actorType: 'visitor',
            actorId: null,
            payload: { from: 'resolved', to: 'open', reason: 'manual_reopen_by_visitor', source: 'widget' },
          });
        }
      }

      return res.json({ ok: true, status: 'open' });
    }

    if (action === 'resolve_visitor' && workspaceId) {
      let knownContact: { name: string | null; email: string | null; phone: string | null } | null = null;
      let contactId: string | null = null;
      let activeConvId = null;

      if (visitor_id) {
        const { data: contact } = await supabase
          .from('contacts').select('id, name, email, phone, visitor_code, metadata')
          .eq('workspace_id', workspaceId)
          .contains('metadata', { visitor_id })
          .limit(1).maybeSingle();

        // visitor_email / visitor_phone are unverified visitor input: they
        // may only fill this visitor's OWN contact's empty columns, and only
        // when no other contact holds them; the claim itself is always kept
        // in metadata (unverified_email / unverified_phone) for the operator.
        // They never overwrite an existing (possibly verified) value.
        const placement = await placeUnverifiedIdentifiers(
          supabase,
          workspaceId,
          typeof visitor_email === 'string' ? visitor_email.trim().toLowerCase() || null : null,
          typeof visitor_phone === 'string' ? visitor_phone.trim().replace(/[^\d+]/g, '') || null : null,
          contact?.id ?? null,
        );

        if (contact) {
          contactId = contact.id;
          const updatePayload: Record<string, unknown> = {
            updated_at: new Date().toISOString(),
            metadata: {
              ...((contact.metadata as Record<string, unknown> | null) || {}),
              visitor_id,
              source: 'widget',
              session_id: session_id || null,
              ...placement.metadata,
            },
          };
          if (visitor_name && visitor_name !== contact.name) updatePayload.name = visitor_name;
          if (placement.email && !contact.email) updatePayload.email = placement.email;
          if (placement.phone && !contact.phone) updatePayload.phone = placement.phone;
          if (Object.keys(updatePayload).length > 2 || Object.keys(placement.metadata).length > 0) {
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
          // Same lazy backfill as ensureVisitorContact/mergeVisitorIdentity —
          // legacy contact, or one whose earlier insert exhausted its
          // collision-retry budget.
          if (!contact.visitor_code) await backfillVisitorCode(supabase, contact.id);
        } else {
          const buildPayload = (visitorCode: string | null) => ({
            workspace_id: workspaceId,
            // Never seed a fake real name — see anonymousContact.ts's module
            // doc comment. `visitor_name` here is only ever populated once
            // the visitor has actually submitted one.
            name: visitor_name || null,
            email: placement.email,
            phone: placement.phone,
            visitor_code: visitorCode,
            metadata: { visitor_id, source: 'widget', session_id: session_id || null, ...placement.metadata },
          });
          const { data: createdContact } = await insertContactWithVisitorCode(
            supabase, buildPayload, 'id, name, email, phone',
          );
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
  } catch (err) {
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
  const config = serverConfigOf(req);
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
  } catch (err) {
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
  const config = serverConfigOf(req);
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
  const config = serverConfigOf(req);
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
        const sharedSecret = rtcRow?.value?.turn?.shared_secret;
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
  } catch (err) {
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

widgetRouter.get('/manifest', widgetRateLimit('config'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
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
  } catch (err) {
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
  } catch (err) {
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
  const config = serverConfigOf(req);
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
  const config = serverConfigOf(req);
  const parsed = kbQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  const { workspace_id, locale, limit } = parsed.data;
  const supabase = getServiceClient(config);

  try {
    // Locked articles (phase 4) are left out; see /help-articles.
    const kbLock = await resolveKbLock(config, workspace_id);
    const query = applyKbUnlockedFilter(supabase
      .from('knowledge_base_articles')
      .select('id, title, excerpt, slug, locale')
      .eq('workspace_id', workspace_id)
      .eq('status', 'published')
      .order('sort_order', { ascending: true })
      .limit(limit), kbLock);

    // Articles are not split by language.

    const { data: articles, error: kbError } = await query;
    if (kbError) throw kbError;

    res.json({ articles: articles || [] });
  } catch (err) {
    console.error('Widget KB error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════
// POST /kb/articles/:slug/feedback — Article helpful / not helpful vote
// ───────────────────────────────────────────────
// Extends the existing Knowledge Base (public.knowledge_base_articles) —
// resolves the article by slug within the caller's own workspace, then
// upserts a single overwritable vote per visitor session (one row per
// (article_id, visitor_session_id), see migration 060).
// ═══════════════════════════════════════════════
// 'neutral' is the middle face ("partly") of a template that draws three.
// The database accepts it from migration 275 on (it widens
// kb_article_feedback_rating_chk); before that the CHECK refuses the row and
// the vote is answered as invalid input, below.
const kbFeedbackSchema = z.object({
  rating: z.enum(['up', 'neutral', 'down']),
});

widgetRouter.post('/kb/articles/:slug/feedback', widgetRateLimit('default'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const workspaceId = resolveWorkspaceId(req, res, req.query.workspace_id as string || req.body?.workspace_id);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const parsed = kbFeedbackSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_rating' });

  const slug = String(req.params.slug || '').trim();
  if (!slug) return res.status(400).json({ error: 'invalid_slug' });

  const supabase = getServiceClient(config);

  try {
    // A slug is unique per (workspace, locale) — the SAME slug can exist in
    // several locales, so resolving with .maybeSingle() on slug alone throws
    // on multi-row and the vote 404s. Prefer the caller's locale, then fall
    // back to any locale that owns the slug.
    //
    // An article locked by the plan (phase 4) is not found: no vote.
    const locale = String(req.query.locale || '').toLowerCase().split('-')[0];
    const kbLock = await resolveKbLock(config, workspaceId);
    let article: { id: string } | null = null;
    if (locale) {
      const { data, error } = await applyKbUnlockedFilter(supabase
        .from('knowledge_base_articles')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('slug', slug)
        .eq('locale', locale), kbLock)
        .limit(1);
      if (error) throw error;
      article = data?.[0] || null;
    }
    if (!article) {
      const { data, error } = await applyKbUnlockedFilter(supabase
        .from('knowledge_base_articles')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('slug', slug), kbLock)
        .limit(1);
      if (error) throw error;
      article = data?.[0] || null;
    }
    if (!article) return res.status(404).json({ error: 'article_not_found' });

    // Identity is HttpOnly-cookie owned; the query param is only a legacy
    // fallback for embeds that still pass it explicitly.
    const cookie = readVisitorCookie(req, workspaceId);
    const visitorId = cookie?.v || (req.query.visitor_id as string) || null;
    let visitorSessionId: string | null = null;
    if (visitorId) {
      const { data: session, error: sessionError } = await supabase
        .from('visitor_sessions')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('visitor_id', visitorId)
        .order('last_seen_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (sessionError) throw sessionError;
      visitorSessionId = session?.id || null;
    }


    const row = {
      workspace_id: workspaceId,
      article_id: article.id,
      visitor_session_id: visitorSessionId,
      rating: parsed.data.rating,
      updated_at: new Date().toISOString(),
    };

    if (visitorSessionId) {
      // The de-duplication index is partial (session_id IS NOT NULL).
      // PostgREST upsert cannot infer a partial unique index from
      // `on_conflict=article_id,visitor_session_id` and returns PostgreSQL
      // 42P10. Update-first preserves overwrite semantics without depending
      // on constraint inference; the insert race is resolved by retrying the
      // update after a unique violation.
      const { data: updated, error: updateError } = await supabase
        .from('kb_article_feedback')
        .update({ rating: row.rating, updated_at: row.updated_at })
        .eq('article_id', row.article_id)
        .eq('visitor_session_id', visitorSessionId)
        .select('id')
        .limit(1);
      if (updateError) throw updateError;

      if (!updated?.length) {
        const { error: insertError } = await supabase.from('kb_article_feedback').insert(row);
        if (insertError && insertError.code === '23505') {
          const { error: retryError } = await supabase
            .from('kb_article_feedback')
            .update({ rating: row.rating, updated_at: row.updated_at })
            .eq('article_id', row.article_id)
            .eq('visitor_session_id', visitorSessionId);
          if (retryError) throw retryError;
        } else if (insertError) {
          throw insertError;
        }
      }
    } else {
      // No resolvable session — record an un-deduplicated anonymous vote
      // rather than rejecting the feedback outright.
      const { error } = await supabase.from('kb_article_feedback').insert(row);
      if (error) throw error;
    }

    return res.json({ ok: true, rating: parsed.data.rating });
  } catch (err) {
    // A rating the database's CHECK does not allow yet ('neutral' before
    // migration 275): the same answer as any rating the API refuses.
    if (err && err.code === '23514') return res.status(400).json({ error: 'invalid_rating' });
    console.error('[widget-kb-feedback] Error:', err.message);
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

/**
 * The away thread's first message (issue #340 g4, runtime-late.js of a
 * template that draws it): what the visitor typed in the thread while the
 * team is away, from one character up to what POST /message takes (its
 * messageSchema: the composer sends this message there when the team is in),
 * with the bubble's client id. A retry with the same id within 24 h answers
 * the conversation and message the first one made, without a second insert,
 * push or mail. The leave-a-message form never sends
 * `client_message_id`, so its requests are checked and answered exactly as
 * before (offlineMessageSchema).
 */
const awayMessageSchema = offlineMessageSchema.extend({
  message: z.string().max(5000).refine((m) => m.trim().length > 0),
  client_message_id: z.string().min(8).max(64),
  // What the widget already knows of the contact rides along (runtime-late.js),
  // not what the visitor typed into a form: a stored value the form would
  // refuse (a long name, an odd address) never costs them their message.
  name: z.string().optional().transform((v) => (v ? v.slice(0, 120) : undefined)),
  email: z.string().email().max(255).optional().catch(undefined),
  phone: z.string().max(40).optional().catch(undefined),
});

/** How long a client id finds the capture it made. */
const OFFLINE_REPLAY_MS = 24 * 60 * 60 * 1000;

/**
 * The conversation and visitor message an earlier request with this client
 * id captured for this visitor within OFFLINE_REPLAY_MS, or null. The
 * visitor must be the same one exactly: a capture made with the cookie never
 * answers a request without it (nor one without it a request with another
 * cookie), so a client id alone finds nobody else's conversation.
 */
async function priorOfflineCapture(
  supabase: ReturnType<typeof getServiceClient>,
  workspaceId: string,
  threadKey: string,
  clientMessageId: string,
  visitorId: string | null,
): Promise<{ conversationId: string; messageId: string | null } | null> {
  const { data: convs } = await supabase
    .from('conversations')
    .select('id, metadata')
    .eq('workspace_id', workspaceId)
    .contains('metadata', { channel_thread_key: threadKey, ...(visitorId ? { visitor_id: visitorId } : {}) })
    .gte('created_at', new Date(Date.now() - OFFLINE_REPLAY_MS).toISOString())
    .order('created_at', { ascending: true })
    .limit(5);
  const conv = (Array.isArray(convs) ? convs : []).find((c) => {
    const meta = (c?.metadata && typeof c.metadata === 'object' ? c.metadata : {}) as Record<string, unknown>;
    return (typeof meta.visitor_id === 'string' ? meta.visitor_id : null) === visitorId;
  });
  if (!conv?.id) return null;
  const { data: msg } = await supabase
    .from('conversation_messages')
    .select('id')
    .eq('conversation_id', conv.id)
    .eq('sender_type', 'contact')
    .filter('metadata->>client_message_id', 'eq', clientMessageId)
    .limit(1)
    .maybeSingle();
  return { conversationId: conv.id as string, messageId: (msg?.id as string | undefined) ?? null };
}

widgetRouter.post('/offline-messages', widgetRateLimit('message'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const away = req.body && typeof req.body === 'object' && (req.body as Record<string, unknown>).client_message_id != null;
  const parsed = away ? awayMessageSchema.safeParse(req.body) : offlineMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', details: parsed.error.flatten() });
  }

  const { workspace_id, message, email, name, phone, locale } = parsed.data;
  const clientMessageId = away ? (parsed.data as z.infer<typeof awayMessageSchema>).client_message_id : null;
  const threadKey = clientMessageId ? `widget_cmid:${clientMessageId}` : null;
  const tokenWs = (req as WidgetScopedRequest)._widgetWorkspaceId as string | undefined;
  if (tokenWs && tokenWs !== workspace_id) {
    return res.status(403).json({ error: 'workspace_mismatch' });
  }

  // Honeypot — silently 200 so bots don't learn anything.
  if (parsed.data.honeypot && parsed.data.honeypot.length > 0) {
    return res.json({ ok: true, captured: false, conversation_id: null });
  }

  const supabase = getServiceClient(config);

  // A retry of an away message that was captured: the same answer, nothing new.
  if (threadKey && clientMessageId) {
    const prior = await priorOfflineCapture(supabase, workspace_id, threadKey, clientMessageId, readVisitorCookie(req, workspace_id)?.v || null);
    if (prior) {
      return res.json({
        ok: true,
        captured: true,
        conversation_id: prior.conversationId,
        transitioning: false,
        message_id: prior.messageId,
      });
    }
  }

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

  // Resolve / create contact when email provided.
  //
  // SECURITY (C6): the typed email/phone are UNVERIFIED. They must never
  // attach this capture to an existing contact that holds them — that filed
  // the visitor's thread (and the operator's replies) under somebody else's
  // contact. Reuse only this visitor's OWN contact (cookie visitor id);
  // otherwise create one, storing an address another contact already holds
  // only as an unverified claim in metadata so the operator still sees it.
  let contactId: string | null = null;
  if (email) {
    const typedEmail = email.trim().toLowerCase();
    const typedPhone = phone ? phone.trim().replace(/[^\d+]/g, '') || null : null;
    let own: { id: string; name: string | null; email: string | null; phone: string | null; metadata: Record<string, unknown> | null } | null = null;
    if (visitorId) {
      const { data } = await supabase
        .from('contacts')
        .select('id, name, email, phone, metadata')
        .eq('workspace_id', workspace_id)
        .contains('metadata', { visitor_id: visitorId })
        .limit(1)
        .maybeSingle();
      own = data || null;
    }
    const placement = await placeUnverifiedIdentifiers(supabase, workspace_id, typedEmail, typedPhone, own?.id ?? null);

    if (own) {
      contactId = own.id;
      const patch: Record<string, unknown> = {};
      if (name && !own.name) patch.name = name;
      if (placement.email && !own.email) patch.email = placement.email;
      if (placement.phone && !own.phone) patch.phone = placement.phone;
      if (Object.keys(placement.metadata).length) patch.metadata = { ...(own.metadata || {}), ...placement.metadata };
      if (Object.keys(patch).length) {
        const { error: patchErr } = await supabase.from('contacts').update(patch).eq('id', contactId);
        if (patchErr && isContactIdentityConflict(patchErr)) {
          const { email: _droppedEmail, phone: _droppedPhone, ...rest } = patch;
          if (Object.keys(rest).length) await supabase.from('contacts').update(rest).eq('id', contactId);
        }
      }
    } else {
      const insertContact = (cols: { email: string | null; phone: string | null }) => supabase
        .from('contacts')
        .insert({
          workspace_id,
          email: cols.email,
          name: name || null,
          phone: cols.phone,
          metadata: { source: 'offline_capture', visitor_id: visitorId, ...placement.metadata },
        })
        .select('id')
        .single();
      let { data: created, error: createErr } = await insertContact({ email: placement.email, phone: placement.phone });
      if (createErr && isContactIdentityConflict(createErr)) {
        ({ data: created, error: createErr } = await insertContact({ email: null, phone: null }));
      }
      contactId = createErr ? null : created?.id || null;
    }
  }

  // Create conversation tagged 'offline'.
  // Phase 5 — offline capture is always a new conversation row, so
  // enforce max_conversations here. workspace_id is verified above
  // against the widget token (`tokenWs === workspace_id`).
  //
  // Simple billing phase 4 (D10): while billing locks are on, a full
  // monthly quota does NOT refuse the leave-a-message form — the spec shows
  // exactly this form when the quota is full. The capture is inserted
  // anyway, tagged `over_quota`, counted like any conversation and shown to
  // operators. Every other refusal (not in the plan, unreadable) stands.
  let overQuota = false;
  {
    let locksOn = false;
    try { locksOn = config.selfHostBillingUnlimited !== true && await locksEnabled(config); } catch { locksOn = false; }
    if (locksOn) {
      const allowance = await checkMaxConversationsAllowance(config, workspace_id);
      overQuota = allowance.reason === 'limit_reached';
    }
    if (!overQuota) {
      const ok = await enforceMaxConversationsLimit(req, res, workspace_id);
      if (!ok) return;
    }
  }
  const { data: conv, error: convErr } = await supabase
    .from('conversations')
    .insert({
      workspace_id,
      contact_id: contactId,
      visitor_session_id: visitorSessionId,
      status: 'open',
      priority: 'normal',
      tags: overQuota ? ['offline', 'over_quota'] : ['offline'],
      subject: 'Offline message',
      // The away thread goes on in this conversation (POST /message, typing,
      // the email card): `visitor_id` proves it is this visitor's even with
      // no session row, and the client id finds it again on a retry (and on
      // a /message retry of the same bubble, as /message's own key).
      ...(threadKey
        ? { metadata: { source: 'offline_capture', ...(visitorId ? { visitor_id: visitorId } : {}), channel_thread_key: threadKey } }
        : {}),
    })
    .select('id')
    .single();

  if (convErr || !conv) {
    console.error('[offline-messages] conversation insert failed:', convErr?.message);
    return res.status(500).json({ error: 'capture_failed' });
  }

  // Insert visitor message.
  const { data: offlineMessage } = await supabase.from('conversation_messages').insert({
    conversation_id: conv.id,
    sender_type: 'contact',
    body: message,
    metadata: { source: 'offline_capture', visitor_id: visitorId, ...(clientMessageId ? { client_message_id: clientMessageId } : {}) },
  }).select('id').single();

  // A message left while nobody was there is still a customer's message: on
  // the phones of those who follow the workspace, like any other — the email
  // to the owners below is for whoever is not carrying one.
  if (offlineMessage?.id) {
    void notifyInboundMessage(config, {
      workspaceId: workspace_id,
      conversationId: conv.id,
      messageId: offlineMessage.id,
      text: message,
      senderName: name || email || null,
      channel: 'widget',
    });
  }

  // Record the timeline event so operators can see it was offline-captured.
  await recordConversationEvent(config, {
    workspaceId: workspace_id,
    conversationId: conv.id,
    eventType: 'captured_offline',
    actorType: 'system',
    payload: {
      availability_state: snap.state,
      availability_reason: snap.reason,
      transitioning,
      contact_email: email || null,
      next_open_at: snap.next_open_at,
      ...(overQuota ? { over_quota: true } : {}),
    },
  });

  // Best-effort email notification to workspace owners/admins, each in
  // their own language (not the visitor's).
  void notifyOfflineCapture(config, workspace_id, {
    conversationId: conv.id,
    message,
    email: email || null,
    name: name || null,
  }).catch((err) => console.warn('[offline-messages] notify failed:', err?.message));

  return res.json({
    ok: true,
    captured: true,
    conversation_id: conv.id,
    // Over the quota the team may well be online: "we may be back sooner"
    // would be wrong there.
    transitioning: transitioning && !overQuota,
    ...(overQuota ? { over_quota: true } : {}),
    // The away thread's bubble becomes this message (runtime-late.js).
    ...(clientMessageId ? { message_id: offlineMessage?.id ?? null } : {}),
  });
});

/** Visitor text for an HTML mail body: `&`, `<`, `>` and `"` as entities. */
export function escapeMailText(value: string): string {
  return String(value).replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

async function notifyOfflineCapture(
  config: ServerConfig,
  workspaceId: string,
  payload: { conversationId: string; message: string; email: string | null; name: string | null },
): Promise<void> {
  const supabase = getServiceClient(config);
  // Resolve workspace owners/admins. The codebase uses `workspace_members`
  // (with `workspace_role` enum) — fall through gracefully if the table or
  // column shape isn't what we expect, so notification is purely best-effort.
  let recipientIds: string[] = [];
  try {
    const { data: wsMembers } = await supabase
      .from('workspace_members')
      .select('user_id, role')
      .eq('workspace_id', workspaceId)
      .in('role', ['owner', 'admin']);
    if (Array.isArray(wsMembers)) {
      recipientIds = wsMembers.map((m) => m.user_id).filter(Boolean);
    }
  } catch {
    // ignore — will check email_settings.reply_to_email below
  }

  // Each mail in its recipient's language (operatorLocale.ts:
  // preferred_locale, else the platform's), never the visitor's.
  let recipients: Array<{ to: string; locale: string }> = [];
  if (recipientIds.length) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, email')
      .in('id', recipientIds);
    const withEmail = (profiles || []).filter((p) => p.email);
    const locales = await operatorLocales(config, withEmail.map((p) => String(p.id)));
    recipients = withEmail.map((p) => ({ to: p.email, locale: locales.get(String(p.id)) || 'en' }));
  }

  if (!recipients.length) {
    const { data: settings } = await supabase
      .from('email_settings')
      .select('reply_to_email')
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (settings?.reply_to_email) recipients = [{ to: settings.reply_to_email, locale: await operatorFallbackLocale(config) }];
  }

  if (!recipients.length) return;

  const subject = `New offline message`;
  // Deep-link straight into the conversation inside THIS workspace.
  let inboxUrl = '';
  try {
    inboxUrl = await resolveWorkspaceAppUrl(
      config,
      workspaceId,
      `/inbox?c=${encodeURIComponent(payload.conversationId)}`,
    );
  } catch {
    inboxUrl = '';
  }
  // What the visitor typed is text, never markup: in this fallback body and
  // in the template's HTML alike.
  const html = `
    <p>A visitor left a message while your workspace was offline.</p>
    <p><strong>From:</strong> ${escapeMailText(payload.name || 'Anonymous')} ${payload.email ? `&lt;${escapeMailText(payload.email)}&gt;` : ''}</p>
    <p><strong>Message:</strong></p>
    <blockquote style="border-left:3px solid #ccc;padding-left:12px;">${escapeMailText(payload.message)}</blockquote>
    <p>${inboxUrl ? `<a href="${escapeMailText(inboxUrl)}">Open this conversation in the inbox to reply.</a>` : 'Open this conversation in the inbox to reply.'}</p>
  `;
  const text = `New offline message\nFrom: ${payload.name || 'Anonymous'} ${payload.email || ''}\n\n${payload.message}${inboxUrl ? `\n\n${inboxUrl}` : ''}`;

  for (const { to, locale } of recipients) {
    try {
      await sendEmail(config, {
        workspaceId,
        to,
        subject,
        html,
        text,
        templateSlug: 'offline_message_received',
        // What the visitor typed, as typed, for the template's subject and
        // text part; its HTML part gets the escaped copies (htmlData), so
        // there it is text, never markup, and nowhere does an `&` read as
        // `&amp;`.
        templateData: {
          conversation_id: payload.conversationId,
          contact_name: payload.name || '',
          contact_email: payload.email || '',
          message_body: payload.message,
          action_url: inboxUrl,
        },
        htmlData: {
          contact_name: escapeMailText(payload.name || ''),
          contact_email: escapeMailText(payload.email || ''),
          message_body: escapeMailText(payload.message),
          action_url: escapeMailText(inboxUrl),
        },
        locale,
      });
    } catch (err) {
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
  const config = serverConfigOf(req);
  const parsed = testEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', details: parsed.error.flatten() });
  }
  const { workspace_id, to, locale } = parsed.data;

  const auth = await authorizeWorkspaceAccess(req, res, workspace_id);
  if (!auth) return;

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
      // As the real mail: the requesting member's language unless asked.
      locale: locale || await operatorLocale(config, auth.userId),
    });
    return res.json({ ok: true });
  } catch (err) {
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
widgetRouter.get('/call-channels', widgetRateLimit('config'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const workspaceId = (req as WidgetScopedRequest)._widgetWorkspaceId as string | undefined
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
  } catch (err) {
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
  const config = serverConfigOf(req);
  const workspaceId = (req as WidgetScopedRequest)._widgetWorkspaceId as string | undefined;
  const visitorId = (req as WidgetScopedRequest).visitorId as string | undefined;
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
  } catch (err) {
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
  const config = serverConfigOf(req);
  const workspaceId = (req as WidgetScopedRequest)._widgetWorkspaceId as string | undefined;
  const entryId = routeParam(req.params.entryId);
  if (!entryId) return res.status(400).json({ error: 'invalid_entry_id' });
  if (!workspaceId) return res.status(400).json({ error: 'missing_workspace' });
  const entry = await getQueueEntry(config, workspaceId, entryId);
  if (!entry) return res.status(404).json({ error: 'not_found' });
  // Optional safety: only owner of entry can cancel.
  const visitorId = (req as WidgetScopedRequest).visitorId as string | undefined;
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
  const config = serverConfigOf(req);
  const workspaceId = (req as WidgetScopedRequest)._widgetWorkspaceId as string | undefined;
  if (!workspaceId) return res.status(400).json({ error: 'missing_workspace' });
  const visitorId = (req as WidgetScopedRequest).visitorId as string | undefined;

  const parsed = z.object({
    conversation_id: z.string().uuid().optional().nullable(),
    session_id: z.string().uuid().optional().nullable(),
    locale: z.string().max(10).optional(),
    // P0-F — visitor explicitly started a new thread; never reuse an old one.
    force_new_conversation: z.boolean().optional(),
  }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  try {
    const result = await maybeSendIntro(config, {
      workspaceId,
      conversationId: parsed.data.conversation_id || null,
      visitorSessionId: parsed.data.session_id || null,
      visitorId: visitorId || null,
      locale: parsed.data.locale,
      forceNewConversation: parsed.data.force_new_conversation === true,
    });
    return res.json(result);
  } catch (err) {
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
  const config = serverConfigOf(req);
  const workspaceId = (req as WidgetScopedRequest)._widgetWorkspaceId as string | undefined;
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
      questions: (data || []).map((q) => ({ id: q.id, question: q.question })),
    });
  } catch (err) {
    console.warn('[widget/qna-suggestions] failed:', err?.message);
    return res.json({ questions: [] });
  }
});
