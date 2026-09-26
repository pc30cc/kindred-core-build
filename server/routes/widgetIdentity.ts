/**
 * Widget Identity Routes
 * 
 * Endpoints for visitor identity, pre-chat, verification, and continuity.
 * All routes require a valid widget session token (HMAC).
 * 
 * Routes:
 *  - GET  /identity/me              — Current visitor identity (cookie + linked contact)
 *  - GET  /identity/prechat         — Pre-chat field requirements
 *  - POST /identity/prechat         — Submit pre-chat info → merge into contact
 *  - POST /identity/verify/request  — Request email/phone verification
 *  - POST /identity/verify/confirm  — Confirm verification token
 *  - POST /identity/continuity/attach — Issue cross-device continuity token
 *  - POST /identity/continuity/use    — Restore session from continuity token
 *  - POST /identity/continuity/revoke — Revoke continuity token
 *  - GET  /identity/history         — Smart conversation continuation
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getServiceClient } from '../supabase.js';
import type { ServerConfig } from '../config.js';
import {
  resolveVisitorIdentity,
  readVisitorCookie,
  clearVisitorCookie,
} from '../services/widget/visitorIdentity.js';
import {
  mergeVisitorIdentity,
  findContinuableConversation,
} from '../services/widget/identityMerge.js';
import {
  requestContactVerification,
  confirmContactVerification,
} from '../services/widget/contactVerification.js';
import {
  persistContinuityToken,
  resolveContinuityToken,
  revokeContinuityToken,
} from '../services/widget/continuity.js';
import {
  ensureVisitorSessionRow,
  resolveSessionNetworkContext,
  issueContinuityCookieForContact,
  resolveKnownContact,
} from '../services/widget/crossWidgetIdentity.js';
import {
  enforceWidgetToken,
  enforceOrigin,
  widgetRateLimit,
  resolveWorkspaceId,
  getClientIp,
} from '../services/widget/security.js';
import { enrichMessagesWithAttachments, enrichMessagesWithReplyTo, filterVisitorVisibleMessages } from './widgetAttachments.js';
import { recordConversationEvent } from '../services/conversationEvents.js';
import { getClientCountry } from '../utils/clientIp.js';
import { createStorageUrlResolver, resolveContactAvatarUrl } from '../services/storage/urlResolver.js';
import { enrichMessagesWithSender } from '../services/widget/senderIdentity.js';
import { serverConfigOf } from '../lib/workspaceAuth.js';

/**
 * markNeedsHuman() (server/services/ai-agent/handoffState.ts) defers actual
 * operator routing when pre-chat is still pending, flagging the
 * conversation `metadata.routing_pending = true` instead of routing right
 * away — the visitor shouldn't see "an operator joined" before they've even
 * filled in the inline pre-chat card. This is that deferred trigger: once
 * pre-chat is submitted, route any of the visitor's recent conversations
 * that were left waiting. Best-effort — a failure here must never fail the
 * pre-chat submission itself.
 */
async function triggerDeferredRoutingForContact(
  config: ServerConfig,
  supabase,
  workspaceId: string,
  contactId: string,
): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: convs } = await supabase
      .from('conversations')
      .select('id, metadata')
      .eq('workspace_id', workspaceId)
      .eq('contact_id', contactId)
      .gte('updated_at', cutoff)
      .order('updated_at', { ascending: false })
      .limit(5);
    for (const c of convs ?? []) {
      const meta = (c.metadata || {}) as Record<string, unknown>;
      if (meta.routing_pending !== true) continue;
      const { routeConversationToOperator } = await import('../services/chatRouting.js');
      await routeConversationToOperator(config, { workspaceId, conversationId: c.id });
    }
  } catch (e) {
    console.warn('[identity-prechat] deferred routing failed:', e?.message || e);
  }
}

/**
 * Phase 4b — Emit a stable `identified` timeline event on every conversation
 * that just got linked to a contact via merge. Best-effort, never throws.
 *
 * Payload contract: { contact_id, method, is_new_contact }
 */
async function emitIdentifiedEvents(
  config: ServerConfig,
  supabase,
  workspaceId: string,
  contactId: string,
  method: string,
  isNewContact: boolean,
) {
  try {
    // Look at the recent slice (last 24h) — the merge SQL function only
    // re-links open/recent conversations, so this is sufficient and bounded.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: convs } = await supabase
      .from('conversations')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('contact_id', contactId)
      .gte('updated_at', cutoff)
      .order('updated_at', { ascending: false })
      .limit(5);
    for (const c of convs ?? []) {
      void recordConversationEvent(config, {
        workspaceId,
        conversationId: c.id,
        eventType: 'identified',
        actorType: 'visitor',
        actorId: null,
        payload: {
          contact_id: contactId,
          method,
          is_new_contact: isNewContact,
        },
      });
    }
  } catch (e) {
    console.warn('[identified-event] failed:', e?.message || e);
  }
}

export const widgetIdentityRouter = Router();

/**
 * Platform-fixed conversation-continuity window (30 days).
 *
 * This used to be a per-workspace operator setting, but an identified visitor
 * whose HttpOnly cookie is still valid should simply resume — re-asking for
 * details they already gave only creates duplicate contacts. The value now
 * governs history restore only, and is not workspace-configurable.
 */
const HISTORY_CONTINUE_WINDOW_HOURS = 720;


// All identity routes require valid session token (HMAC) + matching origin
widgetIdentityRouter.use(enforceWidgetToken);
widgetIdentityRouter.use(enforceOrigin);

// ─── Pre-chat settings cache (per workspace) ─────────────────
export const PRECHAT_TIMINGS = ['always', 'after_handoff', 'never'] as const;
export type PrechatTiming = (typeof PRECHAT_TIMINGS)[number];

/** Never trust a stored/legacy value — fall back to the historical behaviour. */
export function normalizePrechatTiming(value): PrechatTiming {
  return PRECHAT_TIMINGS.includes(value) ? value : 'after_handoff';
}

async function getPrechatSettings(supabase, workspaceId: string) {
  const { data } = await supabase
    .from('widget_prechat_settings')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  return data || {
    workspace_id: workspaceId,
    ask_name: true,
    ask_email: true,
    ask_phone: false,
    require_name: true,
    require_email: true,
    require_phone: false,
    verify_email: false,
    verify_phone: false,
    prechat_timing: 'after_handoff',
    history_continue_window_hours: 24,
  };
}


// ═══════════════════════════════════════════════
// GET /identity/me — Resolve current visitor + contact
// ═══════════════════════════════════════════════
widgetIdentityRouter.get('/me', widgetRateLimit('default'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const workspaceId = resolveWorkspaceId(req, res, req.query.workspace_id as string);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const supabase = getServiceClient(config);
  const { visitorId, isNew } = resolveVisitorIdentity(req, res, workspaceId);

  // Look up the linked contact through the shared cross-widget chain
  // (visitor session → contact metadata → continuity cookie). This is what
  // makes a visitor identified in the CALL widget skip the chat pre-chat
  // form, and vice-versa.
  const contact = await resolveKnownContact(
    supabase, req, res, workspaceId, visitorId, 'chat_widget',
  );

  const prechat = await getPrechatSettings(supabase, workspaceId);
  // A contact avatar we stored is derived from its key for the current
  // provider; one a CRM import supplied stays exactly as given.
  const contactAvatarUrl = await resolveContactAvatarUrl(
    createStorageUrlResolver(config), workspaceId, contact,
  );

  return res.json({
    visitor_id: visitorId,
    is_new_visitor: isNew,
    identity_state: contact ? 'identified' : 'anonymous',
    contact: contact ? {
      id: contact.id,
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      avatar_url: contactAvatarUrl,
    } : null,
    prechat: {
      ask_name: prechat.ask_name,
      ask_email: prechat.ask_email,
      ask_phone: prechat.ask_phone,
      require_name: prechat.require_name,
      require_email: prechat.require_email,
      require_phone: prechat.require_phone,
      verify_email: prechat.verify_email,
      verify_phone: prechat.verify_phone,
      timing: normalizePrechatTiming(prechat.prechat_timing),
    },

  });
});

// ═══════════════════════════════════════════════
// GET /identity/prechat — Field requirements
// ═══════════════════════════════════════════════
widgetIdentityRouter.get('/prechat', widgetRateLimit('default'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const workspaceId = resolveWorkspaceId(req, res, req.query.workspace_id as string);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const supabase = getServiceClient(config);
  const prechat = await getPrechatSettings(supabase, workspaceId);

  // Ensure visitor cookie exists (so subsequent submit knows who's submitting)
  const cookie = readVisitorCookie(req, workspaceId);
  if (!cookie) resolveVisitorIdentity(req, res, workspaceId);

  return res.json({
    ask_name: prechat.ask_name,
    ask_email: prechat.ask_email,
    ask_phone: prechat.ask_phone,
    require_name: prechat.require_name,
    require_email: prechat.require_email,
    require_phone: prechat.require_phone,
    verify_email: prechat.verify_email,
    verify_phone: prechat.verify_phone,
    timing: normalizePrechatTiming(prechat.prechat_timing),
  });
});


// ═══════════════════════════════════════════════
// POST /identity/prechat — Submit pre-chat → merge
// ═══════════════════════════════════════════════
const prechatSchema = z.object({
  workspace_id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120).optional().nullable(),
  email: z.string().trim().email().max(254).optional().nullable(),
  phone: z.string().trim().min(4).max(30).optional().nullable(),
});

widgetIdentityRouter.post('/prechat', widgetRateLimit('message'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const parsed = prechatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten().fieldErrors });
  }

  const workspaceId = resolveWorkspaceId(req, res, parsed.data.workspace_id);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const supabase = getServiceClient(config);
  const prechat = await getPrechatSettings(supabase, workspaceId);

  // Validate required fields
  if (prechat.require_name && !parsed.data.name) return res.status(400).json({ error: 'name_required', field: 'name' });
  if (prechat.require_email && !parsed.data.email) return res.status(400).json({ error: 'email_required', field: 'email' });
  if (prechat.require_phone && !parsed.data.phone) return res.status(400).json({ error: 'phone_required', field: 'phone' });

  // Resolve / create visitor cookie
  const { visitorId } = resolveVisitorIdentity(req, res, workspaceId);
  // Guarantee a session row exists so the merge can pin contact_id on it —
  // otherwise the call widget would not see this visitor as identified.
  const netCtx = await resolveSessionNetworkContext(supabase, req, workspaceId);
  await ensureVisitorSessionRow(supabase, workspaceId, visitorId, null, 'chat_widget', netCtx);

  try {
    // Pre-chat email/phone are UNVERIFIED claims: mergeVisitorIdentity keeps
    // them on this visitor's own (or a new) contact and never links the
    // visitor to an existing contact that holds them — so the continuity
    // cookie below and /identity/me + /identity/history only ever expose this
    // visitor's own contact. Linking to an existing customer happens only
    // after /identity/verify/confirm.
    const merge = await mergeVisitorIdentity(config, supabase, {
      workspaceId,
      visitorId,
      identity: {
        name: parsed.data.name ?? null,
        email: parsed.data.email ?? null,
        phone: parsed.data.phone ?? null,
      },
      method: 'prechat',
      ipAddress: getClientIp(req),
      cfCountry: getClientCountry(req),
    });

    void emitIdentifiedEvents(config, supabase, workspaceId, merge.contactId, 'prechat', merge.isNewContact);
    void triggerDeferredRoutingForContact(config, supabase, workspaceId, merge.contactId);
    // Hand the call widget a continuity cookie for the same contact so its
    // pre-call form is skipped on the very next open.
    await issueContinuityCookieForContact(
      supabase, req, res, workspaceId, merge.contactId, 'chat_widget',
    );

    return res.json({
      success: true,
      visitor_id: visitorId,
      contact_id: merge.contactId,
      conversations_merged: merge.conversationsMerged,
      is_new_contact: merge.isNewContact,
    });
  } catch (err) {
    console.error('[identity-prechat] Error:', err.message);
    return res.status(500).json({ error: 'merge_failed' });
  }
});

// ═══════════════════════════════════════════════
// GET /identity/history — Smart continuation
// ═══════════════════════════════════════════════
widgetIdentityRouter.get('/history', widgetRateLimit('poll'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const workspaceId = resolveWorkspaceId(req, res, req.query.workspace_id as string);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const cookie = readVisitorCookie(req, workspaceId);
  if (!cookie) {
    return res.json({ conversation_id: null, messages: [], reason: 'no_visitor_cookie' });
  }

  const supabase = getServiceClient(config);


  // Find linked contact
  const { data: session } = await supabase
    .from('visitor_sessions')
    .select('contact_id')
    .eq('workspace_id', workspaceId)
    .eq('visitor_id', cookie.v)
    .not('contact_id', 'is', null)
    .order('last_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const conv = await findContinuableConversation(
    supabase,
    workspaceId,
    cookie.v,
    session?.contact_id || null,
    HISTORY_CONTINUE_WINDOW_HOURS,
  );

  if (!conv) {
    return res.json({ conversation_id: null, messages: [], reason: 'window_expired_or_no_history' });
  }

  const { data: msgs } = await supabase
    .from('conversation_messages')
    .select('id, body, sender_type, sender_id, created_at, metadata, seen_at, reply_to_message_id')
    .eq('conversation_id', conv.id)
    .order('created_at', { ascending: true })
    .limit(200);

  // The visitor-visibility filter is applied here as well as inside
  // enrichMessagesWithSender below: it is idempotent, and keeping it adjacent
  // to the mapping makes it impossible to drop an internal staffing notice
  // into `messages[]` by reordering the steps.
  const baseMessages = filterVisitorVisibleMessages((msgs || []).map((m) => ({
    id: m.id,
    role: m.sender_type === 'contact' ? 'visitor' : m.sender_type === 'system' ? 'system' : 'agent',
    sender_type: m.sender_type,
    // Carried for enrichMessagesWithSender; it strips the field before the
    // row is serialized, so no operator id reaches the visitor.
    _sender_id: m.sender_id || null,
    text: m.body,
    time: m.created_at,
    metadata: m.metadata,
    // Phase 7 — lifecycle propagated to history backfill so the widget
    // can render the correct status on already-seen messages.
    seen_at: m.seen_at || null,
    reply_to_message_id: m.reply_to_message_id || null,
  })));
  // Phase 6b — attach public-safe attachment metadata (no provider URLs)
  const withAttachments = await enrichMessagesWithAttachments(config, workspaceId, baseMessages);
  const withReplies = await enrichMessagesWithReplyTo(config, conv.id, withAttachments);
  // This is the endpoint the widget calls when it OPENS and replays an
  // existing thread. Without this step every restored operator and AI bubble
  // rendered with no avatar, because the row itself records only a sender id
  // and the link is derived from a storage key at read time.
  const messages = await enrichMessagesWithSender(config, supabase, withReplies, workspaceId);

  return res.json({ conversation_id: conv.id, messages, last_updated_at: conv.updatedAt });
});

// ═══════════════════════════════════════════════
// POST /identity/verify/request — Request email/phone code
// ═══════════════════════════════════════════════
/**
 * Echo the raw verification code back in the API response? Only for local
 * testing, only when explicitly asked for, and never in production.
 */
export function isWidgetIdentityDevTokenEnabled(): boolean {
  return process.env.WIDGET_IDENTITY_DEV_TOKEN === '1' && process.env.NODE_ENV !== 'production';
}

const verifyRequestSchema = z.object({
  workspace_id: z.string().uuid().optional(),
  channel: z.enum(['email', 'phone']),
  identifier: z.string().trim().min(3).max(254),
});

widgetIdentityRouter.post('/verify/request', widgetRateLimit('message'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const parsed = verifyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten().fieldErrors });
  }

  const workspaceId = resolveWorkspaceId(req, res, parsed.data.workspace_id);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const cookie = readVisitorCookie(req, workspaceId);
  if (!cookie) return res.status(403).json({ error: 'no_visitor_cookie' });

  const supabase = getServiceClient(config);
  const result = await requestContactVerification(supabase, {
    workspaceId,
    visitorId: cookie.v,
    channel: parsed.data.channel,
    identifier: parsed.data.identifier,
    ipAddress: getClientIp(req),
  });

  if (!result.success) {
    return res.status(500).json({ error: result.error || 'verify_request_failed' });
  }

  // TODO: actually deliver result.rawToken via configured email/sms provider.
  //
  // The raw verification code is the proof of ownership of the identifier —
  // returning it to the caller lets anyone "verify" any email/phone. It is
  // only echoed as `dev_token` behind an explicit, never-default opt-in
  // (WIDGET_IDENTITY_DEV_TOKEN=1), and never when NODE_ENV=production. This
  // used to be `NODE_ENV !== 'production'`, which was true in every real
  // deployment because the server image did not set NODE_ENV.
  return res.json({
    success: true,
    expires_at: result.expiresAt?.toISOString(),
    ...(isWidgetIdentityDevTokenEnabled() ? { dev_token: result.rawToken } : {}),
  });
});

// ═══════════════════════════════════════════════
// POST /identity/verify/confirm
// ═══════════════════════════════════════════════
const verifyConfirmSchema = z.object({
  workspace_id: z.string().uuid().optional(),
  channel: z.enum(['email', 'phone']),
  identifier: z.string().trim().min(3).max(254),
  token: z.string().trim().min(8).max(256),
});

widgetIdentityRouter.post('/verify/confirm', widgetRateLimit('message'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const parsed = verifyConfirmSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten().fieldErrors });
  }

  const workspaceId = resolveWorkspaceId(req, res, parsed.data.workspace_id);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const cookie = readVisitorCookie(req, workspaceId);
  if (!cookie) return res.status(403).json({ error: 'no_visitor_cookie' });

  const supabase = getServiceClient(config);
  const result = await confirmContactVerification(supabase, {
    workspaceId,
    channel: parsed.data.channel,
    identifier: parsed.data.identifier,
    token: parsed.data.token,
  });

  if (!result.success) {
    return res.status(400).json({ error: result.error || 'verify_failed' });
  }
  // The code proves control of the identifier only for the visitor that
  // requested it — a code issued to another browser must not attach THIS
  // visitor to the identifier's contact.
  if (result.visitorId && result.visitorId !== cookie.v) {
    return res.status(400).json({ error: 'invalid_token' });
  }

  // Auto-merge identity now that channel is verified. This is the ONLY
  // widget path where a visitor-supplied email/phone may resolve an existing
  // contact (verifiedIdentifiers) — pre-chat / message / call-widget input is
  // an unverified claim and never links to someone else's contact.
  try {
    const merge = await mergeVisitorIdentity(config, supabase, {
      workspaceId,
      visitorId: cookie.v,
      identity: parsed.data.channel === 'email'
        ? { email: parsed.data.identifier }
        : { phone: parsed.data.identifier },
      verifiedIdentifiers: true,
      method: parsed.data.channel,
      ipAddress: getClientIp(req),
      cfCountry: getClientCountry(req),
    });
    void emitIdentifiedEvents(config, supabase, workspaceId, merge.contactId, parsed.data.channel, merge.isNewContact);
    return res.json({
      success: true,
      contact_id: merge.contactId,
      conversations_merged: merge.conversationsMerged,
    });
  } catch (err) {
    console.error('[identity-verify-confirm] merge error:', err.message);
    return res.status(500).json({ error: 'merge_failed_after_verify' });
  }
});

// ═══════════════════════════════════════════════
// POST /identity/continuity/attach — Issue cross-device token
// ═══════════════════════════════════════════════
widgetIdentityRouter.post('/continuity/attach', widgetRateLimit('default'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const workspaceId = resolveWorkspaceId(req, res, req.body?.workspace_id);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const cookie = readVisitorCookie(req, workspaceId);
  if (!cookie) return res.status(403).json({ error: 'no_visitor_cookie' });

  const supabase = getServiceClient(config);
  const { data: session } = await supabase
    .from('visitor_sessions')
    .select('contact_id')
    .eq('workspace_id', workspaceId)
    .eq('visitor_id', cookie.v)
    .not('contact_id', 'is', null)
    .order('last_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!session?.contact_id) return res.status(400).json({ error: 'visitor_not_identified' });

  const issued = await persistContinuityToken(supabase, {
    workspaceId,
    contactId: session.contact_id,
    deviceInfo: {
      ua: req.headers['user-agent'] || null,
      ip: getClientIp(req),
    },
  });

  if (!issued) return res.status(500).json({ error: 'continuity_issue_failed' });
  return res.json({ token: issued.token, expires_at: issued.expiresAt.toISOString() });
});

// ═══════════════════════════════════════════════
// POST /identity/continuity/use — Restore from token
// ═══════════════════════════════════════════════
const continuityUseSchema = z.object({
  workspace_id: z.string().uuid().optional(),
  token: z.string().min(20).max(512),
});

widgetIdentityRouter.post('/continuity/use', widgetRateLimit('default'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const parsed = continuityUseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });

  const workspaceId = resolveWorkspaceId(req, res, parsed.data.workspace_id);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const supabase = getServiceClient(config);
  const result = await resolveContinuityToken(supabase, workspaceId, parsed.data.token);
  if (!result.valid || !result.contactId) {
    return res.status(403).json({ error: result.error || 'invalid_continuity_token' });
  }

  // Ensure a visitor cookie exists then merge it onto this contact
  const { visitorId } = resolveVisitorIdentity(req, res, workspaceId);
  try {
    const merge = await mergeVisitorIdentity(config, supabase, {
      workspaceId,
      visitorId,
      identity: {}, // no overrides — just attach
      method: 'token',
      ipAddress: getClientIp(req),
      cfCountry: getClientCountry(req),
    });
    // Override the merged contact_id with the continuity-resolved one if different
    if (merge.contactId !== result.contactId) {
      await supabase.rpc('merge_visitor_into_contact', {
        _workspace_id: workspaceId,
        _visitor_id: visitorId,
        _contact_id: result.contactId,
        _method: 'token',
        _metadata: { reattach: true },
      });
    }
    void emitIdentifiedEvents(config, supabase, workspaceId, result.contactId!, 'token', false);
    return res.json({ success: true, contact_id: result.contactId, visitor_id: visitorId });
  } catch (err) {
    console.error('[identity-continuity-use] error:', err.message);
    return res.status(500).json({ error: 'continuity_attach_failed' });
  }
});

// ═══════════════════════════════════════════════
// POST /identity/continuity/revoke
// ═══════════════════════════════════════════════
widgetIdentityRouter.post('/continuity/revoke', widgetRateLimit('default'), async (req: Request, res: Response) => {
  const config = serverConfigOf(req);
  const workspaceId = resolveWorkspaceId(req, res, req.body?.workspace_id);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const token = req.body?.token;
  if (!token) return res.status(400).json({ error: 'token required' });

  const supabase = getServiceClient(config);
  const ok = await revokeContinuityToken(supabase, workspaceId, token);
  return res.json({ success: ok });
});

// ═══════════════════════════════════════════════
// POST /identity/logout — Clear visitor cookie + revoke
// ═══════════════════════════════════════════════
widgetIdentityRouter.post('/logout', widgetRateLimit('default'), async (req: Request, res: Response) => {
  clearVisitorCookie(res, req);
  return res.json({ success: true });
});
