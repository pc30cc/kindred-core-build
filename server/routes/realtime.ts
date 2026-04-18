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
import { resolveSession } from '../services/widget/continuity.js';

export const realtimeRouter = Router();

// ─────────────────────────────────────────────────────────────────────
//  PUBLIC: /api/realtime/connect
//  Issues a connection token to a widget visitor.
// ─────────────────────────────────────────────────────────────────────
const connectSchema = z.object({
  workspace_id: z.string().uuid(),
  conversation_ids: z.array(z.string().uuid()).optional(),
});

realtimeRouter.post('/connect', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = connectSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    // Authorize the visitor — same security model as the rest of the widget API.
    const widgetToken = req.headers['x-widget-token'] as string | undefined;
    if (!widgetToken) {
      return res.status(401).json({ error: 'Missing widget token' });
    }

    const sb = getServiceClient(config);
    const session = await resolveSession(sb, widgetToken, parsed.data.workspace_id);
    if (!session) {
      return res.status(401).json({ error: 'Invalid widget session' });
    }

    const resolved = await resolveRealtimeProvider(config);

    // Disabled / strict-failed → tell client realtime is not available.
    if (resolved.effective_vendor === 'disabled') {
      return res.json({
        vendor: 'disabled',
        capabilities: resolved.capabilities,
        fallback_policy: resolved.fallback_policy,
        source: resolved.source,
      });
    }

    // Polling fallback / built-in → no token needed; widget keeps polling.
    if (resolved.effective_vendor === 'polling_builtin') {
      return res.json({
        vendor: 'polling_builtin',
        capabilities: resolved.capabilities,
        fallback_policy: resolved.fallback_policy,
        source: resolved.source,
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
      });
    }

    // Subject = visitor id from session (stable, multi-tenant safe).
    const subjectId = session.visitorId || session.id;
    const tokenInfo = driver.issueConnectionToken({
      sub: subjectId,
      workspace_id: parsed.data.workspace_id,
      conversation_ids: parsed.data.conversation_ids,
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
    });
  } catch (err: any) {
    console.error('[realtime/connect] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// Public-ish channel subscription token issuer.
const subscribeSchema = z.object({
  workspace_id: z.string().uuid(),
  conversation_id: z.string().uuid(),
});

realtimeRouter.post('/subscribe', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });

    const widgetToken = req.headers['x-widget-token'] as string | undefined;
    if (!widgetToken) return res.status(401).json({ error: 'Missing widget token' });

    const sb = getServiceClient(config);
    const session = await resolveSession(sb, widgetToken, parsed.data.workspace_id);
    if (!session) return res.status(401).json({ error: 'Invalid widget session' });

    // Authorize: this conversation must belong to this visitor's workspace.
    const { data: conv } = await sb
      .from('conversations')
      .select('id, workspace_id')
      .eq('id', parsed.data.conversation_id)
      .maybeSingle();
    if (!conv || conv.workspace_id !== parsed.data.workspace_id) {
      return res.status(403).json({ error: 'Conversation not accessible' });
    }

    const driver = await getCentrifugoDriver(config);
    if (!driver) {
      return res.json({ vendor: 'polling_builtin' });
    }
    const channel = `ws:${parsed.data.workspace_id}:conv:${parsed.data.conversation_id}`;
    const tk = driver.issueSubscriptionToken({
      sub: session.visitorId || session.id,
      channel,
      workspaceId: parsed.data.workspace_id,
    });
    return res.json({ vendor: 'centrifugo', channel, token: tk.token, expires_at: tk.expires_at });
  } catch (err: any) {
    console.error('[realtime/subscribe] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ─────────────────────────────────────────────────────────────────────
//  ADMIN: /api/realtime/admin/*
// ─────────────────────────────────────────────────────────────────────
async function requireAdmin(req: any, res: any, next: any) {
  const config: ServerConfig = req.serverConfig;
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing authorization' });
  const token = authHeader.replace('Bearer ', '');
  const sb = getServiceClient(config);
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  const { data: isAdmin } = await sb.rpc('has_role', { _user_id: user.id, _role: 'admin' });
  if (!isAdmin) return res.status(403).json({ error: 'Not authorized' });
  (req as any).adminUser = user;
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
  try {
    const config: ServerConfig = (req as any).serverConfig;
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
    await getServiceClient(config).from('realtime_provider_audit').insert({
      changed_by: adminUser.id,
      action: 'test',
      vendor: cfg.vendor,
      result: h.status === 'healthy' ? 'success' : 'failed',
      error_message: h.status !== 'healthy' ? h.message : null,
    });
    res.json({ status: h.status, message: h.message, checked_at: Date.now() });
  } catch (err: any) {
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
    // Empty string for secrets means "do not change".
    if ((k === 'api_key' || k === 'token_hmac_secret') && (v === '' || v == null)) continue;
    result[k] = v;
  }
  return result;
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
