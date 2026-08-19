/**
 * REALTIME ROUTES — split into:
 *   • Public-ish (widget): /api/realtime/connect
 *       - requires valid widget session (X-Widget-Token + workspace_id)
 *       - returns { vendor, ws_url, token, capabilities, fallback_policy } if Centrifugo,
 *         or { vendor: 'polling_builtin', capabilities } if fallback/disabled.
 *   • Admin: /api/realtime/admin/*
 *       - read/update global realtime provider config (admin-only)
 *       - test connection
 *       - audit list
 */

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  resolveRealtimeProvider,
  loadRealtimeConfig,
  saveRealtimeConfig,
  maskedConfig,
  getCentrifugoDriver,
  CentrifugoDriver,
  invalidateRealtimeCache,
  type RealtimeProviderConfig,
} from '../services/realtime/index.js';
import { verifySessionToken } from '../services/widget/security.js';
import { readVisitorCookie } from '../services/widget/visitorIdentity.js';
import { perfHttpMiddleware } from '../services/observability/perf.js';
import {
  getRequestOrigin,
  getWorkspaceOriginRules,
} from '../services/widget/public.js';
import { isOriginAllowed } from '../utils/domain.js';
import {
  channelBelongsToWorkspace,
  isInboxChannel,
  isVisitorsChannel,
} from '../services/realtime/types.js';
import { loadWidgetPlatformRuntimeSettings } from '../services/widget/platformSettings.js';
import { emitMetric } from '../services/observability/metrics.js';
import { realtimeControlRouter } from './realtimeControl.js';
import { resolveEffectivePolicy } from '../services/realtime/effectivePolicy.js';
import { authorizeWorkspaceAccess, requirePlatformAdmin } from '../lib/workspaceAuth.js';

export const realtimeRouter = Router();

// Phase 6A — Realtime Control Plane (admin-only). Mounted before the
// dynamic /admin/* handlers below so it gets first match on /admin/control*.
realtimeRouter.use('/admin/control', realtimeControlRouter);

/**
 * Enforce that the requesting browser origin is in the workspace's
 * dynamic allow-list (workspace_domains + widget_settings.allowed_domains).
 *
 * This is the SOLE gatekeeper for cross-origin realtime access — Centrifugo
 * itself runs with permissive `allowed_origins=*` so we can scale to any
 * customer domain without redeploying. All authorization happens here.
 *
 * Returns true on allow, false on deny (response already sent).
 */
async function enforceWorkspaceOrigin(
  req: any,
  res: any,
  config: ServerConfig,
  workspaceId: string,
): Promise<boolean> {
  const origin = getRequestOrigin(req);
  // No Origin header (e.g. server-to-server, curl) → allow; widget token still required.
  if (!origin) return true;
  try {
    const { domains, allowSubdomains } = await getWorkspaceOriginRules(config, workspaceId);
    // Empty allow-list → workspace hasn't configured domains yet; permit
    // (matches widgetCorsMiddleware bootstrap behavior).
    if (!domains.length) return true;
    if (isOriginAllowed(origin, domains, allowSubdomains)) return true;
    res.status(403).json({ error: 'Origin not allowed for this workspace' });
    return false;
  } catch (err) {
    console.error('[realtime] origin lookup failed:', err);
    // Fail-closed for realtime — origin lookup failure must NOT silently allow.
    res.status(503).json({ error: 'Origin verification unavailable' });
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  PUBLIC: /api/realtime/connect
//  Issues a connection token to a widget visitor.
// ─────────────────────────────────────────────────────────────────────
const connectSchema = z.object({
  workspace_id: z.string().uuid(),
  conversation_ids: z.array(z.string().uuid()).optional(),
});

realtimeRouter.post('/connect', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  try {
    const parsed = connectSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request' });
    }
    // Phase 3 — every /connect is a (re)connect attempt from the server's POV.
    // We can't distinguish the very first connect from a reconnect without
    // adding state, so we tag the kind and let the dashboard split if needed.
    emitMetric(config, {
      metric: 'realtime.reconnect_attempt',
      workspaceId: parsed.data.workspace_id,
      driver: 'centrifugo',
      source: 'widget',
      tags: { endpoint: 'connect' },
    });

    // Authorize the visitor — same security model as the rest of the widget API.
    const widgetToken = req.headers['x-widget-token'] as string | undefined;
    if (!widgetToken) return res.status(401).json({ error: 'Missing widget token' });
    const tokRes = verifySessionToken(widgetToken);
    if (!tokRes.valid || tokRes.workspaceId !== parsed.data.workspace_id) {
      return res.status(401).json({ error: 'Invalid widget session' });
    }

    // Dynamic per-workspace origin enforcement (replaces static Centrifugo allowlist).
    if (!(await enforceWorkspaceOrigin(req, res, config, parsed.data.workspace_id))) return;

    // Visitor identity comes from HttpOnly cookie (cross-tab/device safe).
    const visitor = readVisitorCookie(req as any, parsed.data.workspace_id);
    const subjectId = visitor?.v || `vt_${tokRes.nonce || 'anon'}`;

    const [resolved, effective_policy] = await Promise.all([
      resolveRealtimeProvider(config),
      resolveEffectivePolicy(config),
    ]);

    // Phase 6C — force_polling overrides any vendor selection so the
    // widget runtime's existing polling_builtin branch takes over without
    // any FSM / runtime change. Existing widgets ignore unknown payload
    // fields, so embedding `effective_policy` is additive.
    if (effective_policy.force_polling) {
      emitMetric(config, {
        metric: 'realtime.fallback_engaged',
        workspaceId: parsed.data.workspace_id,
        driver: 'polling_builtin',
        tags: { source: 'effective_policy:force_polling' },
      });
      return res.json({
        vendor: 'polling_builtin',
        capabilities: { supportsRealtime: false, supportsTyping: false, supportsPresence: false, supportsHistoryLoad: true, supportsReconnectSignals: true },
        fallback_policy: resolved.fallback_policy,
        source: 'fallback',
        effective_policy,
      });
    }

    // Disabled / strict-failed → tell client realtime is not available.
    if (resolved.effective_vendor === 'disabled') {
      return res.json({
        vendor: 'disabled',
        capabilities: resolved.capabilities,
        fallback_policy: resolved.fallback_policy,
        source: resolved.source,
        effective_policy,
      });
    }

    // Polling fallback / built-in → no token needed; widget keeps polling.
    if (resolved.effective_vendor === 'polling_builtin') {
      emitMetric(config, {
        metric: 'realtime.fallback_engaged',
        workspaceId: parsed.data.workspace_id,
        driver: 'polling_builtin',
        tags: { source: resolved.source },
      });
      return res.json({
        vendor: 'polling_builtin',
        capabilities: resolved.capabilities,
        fallback_policy: resolved.fallback_policy,
        source: resolved.source,
        effective_policy,
      });
    }

    // Supabase Realtime → expose the public/anon key + URL so the widget
    // can open a Realtime websocket directly. The anon key is a public
    // (publishable) key and is already shipped to the dashboard browser
    // bundle today; the service-role key is NEVER sent to the client.
    if (resolved.effective_vendor === 'supabase') {
      return res.json({
        vendor: 'supabase',
        supabase_url: config.supabaseUrl,
        anon_key: config.supabaseAnonKey,
        capabilities: resolved.capabilities,
        fallback_policy: resolved.fallback_policy,
        source: resolved.source,
        effective_policy,
      });
    }


    // Centrifugo → issue HMAC connection token.
    const driver = await getCentrifugoDriver(config);
    if (!driver) {
      // Should not happen because resolver already validated config + health,
      // but fail-closed regardless.
      return res.json({
        vendor: 'polling_builtin',
        capabilities: { supportsRealtime: false, supportsTyping: false, supportsPresence: false, supportsHistoryLoad: true, supportsReconnectSignals: true },
        fallback_policy: resolved.fallback_policy,
        source: 'fallback',
        effective_policy,
      });
    }

    // Subject = stable visitor id (multi-tenant safe).
    const platform = await loadWidgetPlatformRuntimeSettings(config);
    const tokenInfo = driver.issueConnectionToken({
      sub: subjectId,
      workspace_id: parsed.data.workspace_id,
      conversation_ids: parsed.data.conversation_ids,
      expires_in_seconds: platform.realtime.tokenTtlSeconds,
    });
    emitMetric(config, {
      metric: 'realtime.token_minted',
      workspaceId: parsed.data.workspace_id,
      driver: 'centrifugo',
      tags: { kind: 'connect', ttl_s: platform.realtime.tokenTtlSeconds },
    });

    return res.json({
      vendor: 'centrifugo',
      ws_url: tokenInfo.ws_url,
      token: tokenInfo.token,
      expires_at: tokenInfo.expires_at,
      channels: tokenInfo.channels,
      capabilities: resolved.capabilities,
      fallback_policy: resolved.fallback_policy,
      public_config: resolved.public_config,
      source: resolved.source,
      effective_policy,
    });
  } catch (err: any) {
    console.error('[realtime/connect] error:', err);
    emitMetric(config, {
      metric: 'realtime.token_refresh_failed',
      driver: 'centrifugo',
      source: 'widget',
      tags: { endpoint: 'connect', reason: 'internal_error' },
    });
    return res.status(500).json({ error: 'Internal error' });
  }
});

// Public-ish channel subscription token issuer.
const subscribeSchema = z.object({
  workspace_id: z.string().uuid(),
  conversation_id: z.string().uuid(),
});

realtimeRouter.post('/subscribe', perfHttpMiddleware('realtime.subscribe'), async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  try {
    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      emitMetric(config, {
        metric: 'realtime.subscribe_failed',
        driver: 'centrifugo',
        source: 'widget',
        tags: { endpoint: 'subscribe', reason: 'invalid_request' },
      });
      return res.status(400).json({ error: 'Invalid request' });
    }

    const widgetToken = req.headers['x-widget-token'] as string | undefined;
    if (!widgetToken) return res.status(401).json({ error: 'Missing widget token' });
    const tokRes = verifySessionToken(widgetToken);
    if (!tokRes.valid || tokRes.workspaceId !== parsed.data.workspace_id) {
      return res.status(401).json({ error: 'Invalid widget session' });
    }

    // Dynamic per-workspace origin enforcement.
    if (!(await enforceWorkspaceOrigin(req, res, config, parsed.data.workspace_id))) return;

    const visitor = readVisitorCookie(req as any, parsed.data.workspace_id);
    const subjectId = visitor?.v || `vt_${tokRes.nonce || 'anon'}`;

    const sb = getServiceClient(config);
    // Authorize: this conversation must belong to this visitor's workspace.
    const { data: conv } = await sb
      .from('conversations')
      .select('id, workspace_id')
      .eq('id', parsed.data.conversation_id)
      .maybeSingle();
    if (!conv || conv.workspace_id !== parsed.data.workspace_id) {
      emitMetric(config, {
        metric: 'realtime.channel_ownership_reject',
        workspaceId: parsed.data.workspace_id,
        conversationId: parsed.data.conversation_id,
        driver: 'centrifugo',
        tags: { reason: 'conversation_not_in_workspace', endpoint: 'subscribe' },
      });
      return res.status(403).json({ error: 'Conversation not accessible' });
    }

    const driver = await getCentrifugoDriver(config);
    if (!driver) {
      return res.json({ vendor: 'polling_builtin' });
    }
    // Strict channel naming — never trust client-supplied channel names.
    const channel = `ws:${parsed.data.workspace_id}:conv:${parsed.data.conversation_id}`;
    if (!channelBelongsToWorkspace(channel, parsed.data.workspace_id)
        || isInboxChannel(channel, parsed.data.workspace_id)
        || isVisitorsChannel(channel, parsed.data.workspace_id)) {
      emitMetric(config, {
        metric: 'realtime.channel_ownership_reject',
        workspaceId: parsed.data.workspace_id,
        conversationId: parsed.data.conversation_id,
        driver: 'centrifugo',
        tags: { reason: 'channel_pattern_invalid', endpoint: 'subscribe' },
      });
      // Defense in depth: widget tokens MUST NEVER be issued for the
      // operator-only inbox or visitors channels. Schema already prevents
      // this (the channel name does not match :conv:<uuid>) but we reject
      // explicitly.
      return res.status(403).json({ error: 'Channel not allowed' });
    }
    const platform = await loadWidgetPlatformRuntimeSettings(config);
    const tk = driver.issueSubscriptionToken({
      sub: subjectId,
      channel,
      workspaceId: parsed.data.workspace_id,
      expiresInSeconds: platform.realtime.tokenTtlSeconds,
    });
    emitMetric(config, {
      metric: 'realtime.token_minted',
      workspaceId: parsed.data.workspace_id,
      conversationId: parsed.data.conversation_id,
      driver: 'centrifugo',
      tags: { kind: 'subscribe', ttl_s: platform.realtime.tokenTtlSeconds },
    });
    return res.json({ vendor: 'centrifugo', channel, token: tk.token, expires_at: tk.expires_at });
  } catch (err: any) {
    console.error('[realtime/subscribe] error:', err);
    emitMetric(config, {
      metric: 'realtime.subscribe_failed',
      driver: 'centrifugo',
      source: 'widget',
      tags: { endpoint: 'subscribe', reason: 'internal_error' },
    });
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ─────────────────────────────────────────────────────────────────────
//  OPERATOR (inbox): /api/realtime/operator-connect | /operator-subscribe
//  Auth = Supabase user JWT + workspace membership.
//  Lets the workspace inbox subscribe to the SAME conversation channels
//  the visitor widget uses, so agent↔visitor messages flow live both ways.
// ─────────────────────────────────────────────────────────────────────
const operatorConnectSchema = z.object({ workspace_id: z.string().uuid() });
const operatorSubscribeSchema = z.object({
  workspace_id: z.string().uuid(),
  conversation_id: z.string().uuid(),
});

async function authorizeOperator(req: any, res: any, _config: ServerConfig, workspaceId: string) {
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return null;
  return { id: auth.userId };
}

realtimeRouter.post('/operator-connect', perfHttpMiddleware('realtime.operator_connect'), async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  try {
    const parsed = operatorConnectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
    const user = await authorizeOperator(req, res, config, parsed.data.workspace_id);
    if (!user) return;

    // Phase 3 — every operator-connect is a (re)connect attempt. Used to
    // chart reconnect rates per workspace in the observability panel.
    emitMetric(config, {
      metric: 'realtime.reconnect_attempt',
      workspaceId: parsed.data.workspace_id,
      driver: 'centrifugo',
      source: 'operator',
      tags: { endpoint: 'operator-connect' },
    });

    // Phase 6C — derive the public effective policy snapshot so the
    // operator client can honor failover/degradation decisions on every
    // (re)connect without a separate round-trip.
    const [resolved, effective_policy] = await Promise.all([
      resolveRealtimeProvider(config),
      resolveEffectivePolicy(config),
    ]);

    // If policy says force polling, short-circuit BEFORE we mint a
    // Centrifugo connection token — the client must not open WS.
    if (effective_policy.force_polling) {
      return res.json({
        vendor: 'polling_builtin',
        capabilities: { supportsRealtime: false, supportsTyping: false, supportsPresence: false, supportsHistoryLoad: true, supportsReconnectSignals: true },
        effective_policy,
      });
    }

    if (resolved.effective_vendor !== 'centrifugo') {
      // For supabase / polling / disabled the operator client uses the
      // matching provider and never receives a centrifugo token.
      return res.json({
        vendor: resolved.effective_vendor,
        capabilities: resolved.capabilities,
        effective_policy,
      });
    }
    const driver = await getCentrifugoDriver(config);
    if (!driver) return res.json({ vendor: 'polling_builtin', effective_policy });
    const platform = await loadWidgetPlatformRuntimeSettings(config);
    const tk = driver.issueConnectionToken({
      sub: `op_${user.id}`,
      workspace_id: parsed.data.workspace_id,
      expires_in_seconds: platform.realtime.tokenTtlSeconds,
    });
    return res.json({
      vendor: 'centrifugo',
      ws_url: tk.ws_url,
      token: tk.token,
      expires_at: tk.expires_at,
      capabilities: resolved.capabilities,
      effective_policy,
    });
  } catch (err: any) {
    console.error('[realtime/operator-connect]', err);
    emitMetric(config, {
      metric: 'realtime.token_refresh_failed',
      driver: 'centrifugo',
      source: 'operator',
      tags: { endpoint: 'operator-connect', reason: 'internal_error' },
    });
    res.status(500).json({ error: 'Internal error' });
  }
});

realtimeRouter.post('/operator-subscribe', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  try {
    const parsed = operatorSubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      emitMetric(config, {
        metric: 'realtime.subscribe_failed',
        driver: 'centrifugo',
        source: 'operator',
        tags: { endpoint: 'operator-subscribe', reason: 'invalid_request' },
      });
      return res.status(400).json({ error: 'Invalid request' });
    }
    const user = await authorizeOperator(req, res, config, parsed.data.workspace_id);
    if (!user) return;

    const sb = getServiceClient(config);
    const { data: conv } = await sb.from('conversations')
      .select('id, workspace_id').eq('id', parsed.data.conversation_id).maybeSingle();
    if (!conv || conv.workspace_id !== parsed.data.workspace_id) {
      emitMetric(config, {
        metric: 'realtime.channel_ownership_reject',
        workspaceId: parsed.data.workspace_id,
        conversationId: parsed.data.conversation_id,
        driver: 'centrifugo',
        source: 'operator',
        tags: { reason: 'conversation_not_in_workspace', endpoint: 'operator-subscribe' },
      });
      return res.status(404).json({ error: 'Conversation not in workspace' });
    }
    const driver = await getCentrifugoDriver(config);
    if (!driver) return res.json({ vendor: 'polling_builtin' });
    const channel = `ws:${parsed.data.workspace_id}:conv:${parsed.data.conversation_id}`;
    if (!channelBelongsToWorkspace(channel, parsed.data.workspace_id)) {
      emitMetric(config, {
        metric: 'realtime.channel_ownership_reject',
        workspaceId: parsed.data.workspace_id,
        conversationId: parsed.data.conversation_id,
        driver: 'centrifugo',
        source: 'operator',
        tags: { reason: 'channel_pattern_invalid', endpoint: 'operator-subscribe' },
      });
      return res.status(403).json({ error: 'Channel not allowed' });
    }
    const platform = await loadWidgetPlatformRuntimeSettings(config);
    const tk = driver.issueSubscriptionToken({
      sub: `op_${user.id}`, channel, workspaceId: parsed.data.workspace_id,
      expiresInSeconds: platform.realtime.tokenTtlSeconds,
    });
    emitMetric(config, {
      metric: 'realtime.token_minted',
      workspaceId: parsed.data.workspace_id,
      conversationId: parsed.data.conversation_id,
      driver: 'centrifugo',
      source: 'operator',
      tags: { kind: 'operator-subscribe', ttl_s: platform.realtime.tokenTtlSeconds },
    });
    return res.json({ vendor: 'centrifugo', channel, token: tk.token, expires_at: tk.expires_at });
  } catch (err: any) {
    console.error('[realtime/operator-subscribe]', err);
    emitMetric(config, {
      metric: 'realtime.subscribe_failed',
      driver: 'centrifugo',
      source: 'operator',
      tags: { endpoint: 'operator-subscribe', reason: 'internal_error' },
    });
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─────────────────────────────────────────────────────────────────────
//  OPERATOR (inbox list): /api/realtime/operator-inbox-subscribe
//  Phase 5 — Subscribes the workspace inbox to the operator-only
//  channel `ws:<workspace_id>:inbox`. Carries `event` envelopes for
//  conversation-list updates (status, priority, assignee, tags).
//
//  Auth: Supabase user JWT + workspace membership. Widget tokens can
//  never reach this endpoint and could not subscribe to this channel
//  even if they tried (`/realtime/subscribe` rejects inbox channel names).
// ─────────────────────────────────────────────────────────────────────
const operatorInboxSubscribeSchema = z.object({ workspace_id: z.string().uuid() });

realtimeRouter.post('/operator-inbox-subscribe', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  try {
    const parsed = operatorInboxSubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      emitMetric(config, {
        metric: 'realtime.subscribe_failed',
        driver: 'centrifugo',
        source: 'operator',
        tags: { endpoint: 'operator-inbox-subscribe', reason: 'invalid_request' },
      });
      return res.status(400).json({ error: 'Invalid request' });
    }
    const user = await authorizeOperator(req, res, config, parsed.data.workspace_id);
    if (!user) return;

    const driver = await getCentrifugoDriver(config);
    if (!driver) return res.json({ vendor: 'polling_builtin' });
    const channel = `ws:${parsed.data.workspace_id}:inbox`;
    const platform = await loadWidgetPlatformRuntimeSettings(config);
    const tk = driver.issueSubscriptionToken({
      sub: `op_${user.id}`, channel, workspaceId: parsed.data.workspace_id,
      expiresInSeconds: platform.realtime.tokenTtlSeconds,
    });
    return res.json({ vendor: 'centrifugo', channel, token: tk.token, expires_at: tk.expires_at });
  } catch (err: any) {
    console.error('[realtime/operator-inbox-subscribe]', err);
    emitMetric(config, {
      metric: 'realtime.subscribe_failed',
      driver: 'centrifugo',
      source: 'operator',
      tags: { endpoint: 'operator-inbox-subscribe', reason: 'internal_error' },
    });
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─────────────────────────────────────────────────────────────────────
//  OPERATOR (visitor intelligence): /api/realtime/operator-visitors-subscribe
//  Issues a Centrifugo subscription token for the operator-only channel
//  `ws:<workspace_id>:visitors`. Carries `event` envelopes with
//  payload.kind = 'visitor.upsert' | 'visitor.remove' for the live
//  Visitors page (list + map).
// ─────────────────────────────────────────────────────────────────────
const operatorVisitorsSubscribeSchema = z.object({ workspace_id: z.string().uuid() });

realtimeRouter.post('/operator-visitors-subscribe', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  try {
    const parsed = operatorVisitorsSubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      emitMetric(config, {
        metric: 'realtime.subscribe_failed',
        driver: 'centrifugo',
        source: 'operator',
        tags: { endpoint: 'operator-visitors-subscribe', reason: 'invalid_request' },
      });
      return res.status(400).json({ error: 'Invalid request' });
    }
    const user = await authorizeOperator(req, res, config, parsed.data.workspace_id);
    if (!user) return;

    const driver = await getCentrifugoDriver(config);
    if (!driver) return res.json({ vendor: 'polling_builtin' });
    const channel = `ws:${parsed.data.workspace_id}:visitors`;
    const platform = await loadWidgetPlatformRuntimeSettings(config);
    const tk = driver.issueSubscriptionToken({
      sub: `op_${user.id}`, channel, workspaceId: parsed.data.workspace_id,
      expiresInSeconds: platform.realtime.tokenTtlSeconds,
    });
    return res.json({ vendor: 'centrifugo', channel, token: tk.token, expires_at: tk.expires_at });
  } catch (err: any) {
    console.error('[realtime/operator-visitors-subscribe]', err);
    emitMetric(config, {
      metric: 'realtime.subscribe_failed',
      driver: 'centrifugo',
      source: 'operator',
      tags: { endpoint: 'operator-visitors-subscribe', reason: 'internal_error' },
    });
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─────────────────────────────────────────────────────────────────────
//  ADMIN: /api/realtime/admin/*
// ─────────────────────────────────────────────────────────────────────
async function requireAdmin(req: any, res: any, next: any) {
  const userId = await requirePlatformAdmin(req, res);
  if (!userId) return;
  (req as any).adminUser = { id: userId };
  next();
}

realtimeRouter.get('/admin/config', requireAdmin, async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const cfg = await loadRealtimeConfig(config, true);
  res.json({ config: maskedConfig(cfg) });
});

const adminUpdateSchema = z.object({
  vendor: z.enum(['centrifugo', 'polling_builtin', 'disabled']),
  enabled: z.boolean().optional(),
  fallback_policy: z.enum(['lenient', 'strict']).optional(),
  centrifugo: z.object({
    ws_url: z.string().url().optional(),
    api_url: z.string().url().optional(),
    api_key: z.string().optional(),
    token_hmac_secret: z.string().optional(),
    allowed_origins: z.array(z.string()).optional(),
    connect_timeout_ms: z.number().int().min(1000).max(60000).optional(),
    subscribe_timeout_ms: z.number().int().min(1000).max(60000).optional(),
    presence_enabled: z.boolean().optional(),
    typing_enabled: z.boolean().optional(),
    token_ttl_seconds: z.number().int().min(60).max(3600).optional(),
  }).optional(),
});

realtimeRouter.put('/admin/config', requireAdmin, async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const adminUser = (req as any).adminUser;
    const parsed = adminUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });

    const prev = await loadRealtimeConfig(config, true);

    // Merge: keep previously stored secrets if the new payload omits them
    // (so admins can update non-secret fields without re-entering keys).
    const mergedCentrifugo = parsed.data.vendor === 'centrifugo'
      ? mergeCentrifugo(prev.centrifugo, parsed.data.centrifugo)
      : undefined;

    const next: RealtimeProviderConfig = {
      vendor: parsed.data.vendor,
      enabled: parsed.data.enabled !== false,
      fallback_policy: parsed.data.fallback_policy ?? prev.fallback_policy,
      fallback_vendor: 'polling_builtin',
      centrifugo: mergedCentrifugo,
    };

    await saveRealtimeConfig(config, next);

    // Audit (masked diff only)
    await getServiceClient(config).from('realtime_provider_audit').insert({
      changed_by: adminUser.id,
      action: 'configure',
      vendor: next.vendor,
      prev_vendor: prev.vendor,
      config_diff: diffMask(prev, next),
      result: 'success',
      ip_address: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress,
    });

    res.json({ ok: true, config: maskedConfig(next) });
  } catch (err: any) {
    console.error('[realtime/admin/config PUT] error:', err);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

realtimeRouter.post('/admin/test', requireAdmin, async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  try {
    const adminUser = (req as any).adminUser;
    const cfg = await loadRealtimeConfig(config, true);

    if (cfg.vendor !== 'centrifugo' || !cfg.centrifugo) {
      return res.json({ status: 'unknown', message: 'No active Centrifugo provider to test' });
    }
    const c = cfg.centrifugo;
    if (!c.ws_url || !c.api_url || !c.api_key || !c.token_hmac_secret) {
      return res.json({ status: 'down', message: 'Centrifugo configuration incomplete' });
    }
    const driver = new CentrifugoDriver(c as any);
    const h = await driver.health();
    if (h.status !== 'healthy') {
      // Phase 3 — surface upstream Centrifugo socket failure as a
      // server-observable ws_error / socket_closed signal. The admin
      // observability panel uses this to alert on backend outages without
      // needing a widget beacon.
      emitMetric(config, {
        metric: h.status === 'down' ? 'realtime.socket_closed' : 'realtime.ws_error',
        driver: 'centrifugo',
        source: 'server',
        tags: { endpoint: 'admin-test', status: h.status, reason: (h.message || 'unknown').slice(0, 64) },
      });
    }
    await getServiceClient(config).from('realtime_provider_audit').insert({
      changed_by: adminUser.id,
      action: 'test',
      vendor: cfg.vendor,
      result: h.status === 'healthy' ? 'success' : 'failed',
      error_message: h.status !== 'healthy' ? h.message : null,
    });
    res.json({ status: h.status, message: h.message, checked_at: Date.now() });
  } catch (err: any) {
    emitMetric(config, {
      metric: 'realtime.ws_error',
      driver: 'centrifugo',
      source: 'server',
      tags: { endpoint: 'admin-test', reason: 'exception' },
    });
    res.status(500).json({ status: 'down', message: err.message });
  }
});

realtimeRouter.get('/admin/resolved', requireAdmin, async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const resolved = await resolveRealtimeProvider(config);
  res.json(resolved);
});

realtimeRouter.get('/admin/audit', requireAdmin, async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('admin_list_realtime_audit', { _limit: 50 });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ entries: data ?? [] });
});

realtimeRouter.post('/admin/refresh', requireAdmin, (_req, res) => {
  invalidateRealtimeCache();
  res.json({ ok: true });
});

// ─── helpers ────────────────────────────────────────────────────────
function mergeCentrifugo(prev: any, next: any): any {
  const result: any = { ...(prev || {}) };
  if (!next) return result;
  for (const k of Object.keys(next)) {
    const v = (next as any)[k];
    // Empty or masked secret values mean "do not change".
    if ((k === 'api_key' || k === 'token_hmac_secret') && (v === '' || v == null || isMaskedSecretValue(v))) continue;
    result[k] = v;
  }
  return result;
}

function isMaskedSecretValue(value: unknown): boolean {
  return typeof value === 'string' && value.includes('•');
}

function diffMask(prev: RealtimeProviderConfig, next: RealtimeProviderConfig): Record<string, any> {
  const out: Record<string, any> = {};
  if (prev.vendor !== next.vendor) out.vendor = { from: prev.vendor, to: next.vendor };
  if (prev.enabled !== next.enabled) out.enabled = { from: prev.enabled, to: next.enabled };
  if (prev.fallback_policy !== next.fallback_policy) out.fallback_policy = { from: prev.fallback_policy, to: next.fallback_policy };
  if (next.centrifugo) {
    const cdiff: Record<string, any> = {};
    const fields: Array<keyof NonNullable<RealtimeProviderConfig['centrifugo']>> = ['ws_url', 'api_url', 'allowed_origins', 'connect_timeout_ms', 'subscribe_timeout_ms', 'presence_enabled', 'typing_enabled', 'token_ttl_seconds'];
    for (const f of fields) {
      const pv = prev.centrifugo?.[f];
      const nv = next.centrifugo[f];
      if (JSON.stringify(pv) !== JSON.stringify(nv)) cdiff[f] = { from: pv, to: nv };
    }
    if (next.centrifugo.api_key && next.centrifugo.api_key !== prev.centrifugo?.api_key) cdiff.api_key = '***changed***';
    if (next.centrifugo.token_hmac_secret && next.centrifugo.token_hmac_secret !== prev.centrifugo?.token_hmac_secret) cdiff.token_hmac_secret = '***changed***';
    if (Object.keys(cdiff).length) out.centrifugo = cdiff;
  }
  return out;
}
