import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getServiceClient } from '../supabase.js';
import type { ServerConfig } from '../config.js';
import { isWorkspaceOriginAllowed } from '../services/widget/public.js';
import { listVisitorIntelligence, getVisitorIntelligence } from '../services/visitors/intelligence.js';
import { resolveMapTilesConfig } from '../services/maptiles/index.js';
import { publishVisitorEvent } from '../services/realtime/publish.js';
import { getClientIp, hashIp } from '../utils/clientIp.js';
import { resolveVisitorGeo } from '../services/geo/index.js';

export const visitorRouter = Router();

/**
 * Operator-side router. Mounted under a different prefix in `index.ts`
 * so the standard appCors applies (we don't want widget-origin CORS for
 * authenticated reads coming from the operator panel).
 */
export const visitorsAdminRouter = Router();

// ============================================
// Auth helper for operator-side reads.
// Same pattern used in conversations.ts / cannedResponses.ts:
// Bearer = Supabase user access token; verify workspace membership via RPC.
// ============================================
async function authorizeWorkspaceMember(
  req: Request,
  res: Response,
  config: ServerConfig,
  workspaceId: string,
): Promise<{ userId: string; role: string | null } | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization' });
    return null;
  }
  const token = authHeader.replace('Bearer ', '');
  const sb = getServiceClient(config);
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) {
    res.status(401).json({ error: 'Invalid token' });
    return null;
  }
  const { data: isMember } = await sb.rpc('is_workspace_member', {
    _workspace_id: workspaceId,
    _user_id: user.id,
  });
  if (!isMember) {
    res.status(403).json({ error: 'Not a workspace member' });
    return null;
  }
  // Resolve workspace role for IP-exposure decisions.
  const { data: member } = await sb
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .maybeSingle();
  return { userId: user.id, role: (member?.role as string | null) ?? null };
}

// ============================================
// POST /api/visitors/track
// Visitor tracking ingestion endpoint
// ============================================
const trackSchema = z.object({
  workspace_id: z.string().uuid(),
  visitor_id: z.string().min(1).max(255),
  current_page: z.string().max(2048).optional(),
  referrer: z.string().max(2048).optional(),
  browser: z.string().max(100).optional(),
  device: z.string().max(100).optional(),
  os: z.string().max(100).optional(),
});

visitorRouter.post('/track', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = trackSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid tracking data', details: parsed.error.flatten().fieldErrors });
  }

  const data = parsed.data;
  const supabase = getServiceClient(config);

  // Resolve the real client IP (Cloudflare → XFF → X-Real-IP → socket).
  // We hash it for at-rest storage; the raw IP only lives in this scope and
  // is passed to the geo provider (if configured) for warm-cache enrichment.
  const clientIp = getClientIp(req);
  const ipHash = hashIp(clientIp);

  try {
    // Validate workspace exists and has tracking enabled
    const { data: widget } = await supabase
      .from('widget_settings')
      .select('visitor_tracking_enabled, allowed_domains, allow_subdomains, store_raw_ip')
      .eq('workspace_id', data.workspace_id)
      .single();

    if (!widget || !widget.visitor_tracking_enabled) {
      return res.status(403).json({ error: 'Visitor tracking not enabled' });
    }

    // Privacy gate: only persist raw IP when the workspace explicitly opts in.
    const storeRawIp = (widget as any).store_raw_ip === true;
    const ipRawForStorage = storeRawIp ? clientIp : null;

    const origin = typeof req.headers.origin === 'string'
      ? req.headers.origin
      : typeof req.headers.referer === 'string'
        ? req.headers.referer
        : null;
    if (!(await isWorkspaceOriginAllowed(config, data.workspace_id, origin))) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }

    // Upsert visitor session (update last_seen if exists within last 30 min)
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const { data: existing } = await supabase
      .from('visitor_sessions')
      .select('id')
      .eq('workspace_id', data.workspace_id)
      .eq('visitor_id', data.visitor_id)
      .gte('last_seen_at', thirtyMinAgo)
      .order('last_seen_at', { ascending: false })
      .limit(1)
      .single();

    let sessionId: string;

    if (existing) {
      // Update existing session
      await supabase
        .from('visitor_sessions')
        .update({
          current_page: data.current_page,
          last_seen_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
      sessionId = existing.id;
    } else {
      // Create new session
      const { data: newSession, error } = await supabase
        .from('visitor_sessions')
        .insert({
          workspace_id: data.workspace_id,
          visitor_id: data.visitor_id,
          current_page: data.current_page,
          referrer: data.referrer,
          browser: data.browser,
          device: data.device,
          os: data.os,
          ip_hash: ipHash,
          ip_raw: ipRawForStorage,
        })
        .select('id')
        .single();

      if (error) {
        console.error('Visitor session insert error:', error);
        return res.status(500).json({ error: 'Failed to create session' });
      }
      sessionId = newSession!.id;
    }

    // Best-effort geo enrichment at ingest time. Calls the configured
    // geo_enrichment provider (if any) and warms visitor_geo_cache so
    // operator-side reads return precise coords without re-calling the
    // provider on every poll. Failures are silent — the resolver falls
    // back to centroid on the read path.
    if (clientIp && ipHash) {
      resolveVisitorGeo(config, data.workspace_id, {
        country: null, city: null, ip_hash: ipHash, raw_ip: clientIp,
      }).catch(() => {});
    }

    // Append a page-view row (best-effort; failures must not block tracking).
    if (data.current_page) {
      try {
        await supabase.from('visitor_page_views').insert({
          workspace_id: data.workspace_id,
          visitor_session_id: sessionId,
          url: data.current_page.slice(0, 2048),
        });
      } catch (e) {
        console.warn('[visitors.track] page-view insert failed:', (e as any)?.message);
      }
    }

    // Upsert presence
    const { data: existingPresence } = await supabase
      .from('visitor_presence')
      .select('id')
      .eq('visitor_session_id', sessionId)
      .single();

    if (existingPresence) {
      await supabase
        .from('visitor_presence')
        .update({
          status: 'online',
          current_page: data.current_page,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingPresence.id);
    } else {
      await supabase
        .from('visitor_presence')
        .insert({
          workspace_id: data.workspace_id,
          visitor_session_id: sessionId,
          status: 'online',
          current_page: data.current_page,
        });
    }

    // Realtime push to operator visitors channel — best-effort.
    publishVisitorEvent(config, {
      kind: 'visitor.upsert',
      workspace_id: data.workspace_id,
      session_id: sessionId,
      patch: {
        status: 'online',
        current_page: data.current_page ?? null,
        last_activity_at: new Date().toISOString(),
        visitor_id: data.visitor_id,
      },
      occurred_at: new Date().toISOString(),
    }).catch(() => {});

    res.json({ session_id: sessionId, status: 'tracked' });
  } catch (err) {
    console.error('Visitor tracking error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ============================================
// POST /api/visitors/heartbeat
// Presence heartbeat
// ============================================
const heartbeatSchema = z.object({
  workspace_id: z.string().uuid().optional(),
  session_id: z.string().uuid(),
  current_page: z.string().max(2048).optional(),
  status: z.enum(['online', 'idle']).optional().default('online'),
});

visitorRouter.post('/heartbeat', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = heartbeatSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid data' });
  }

  const { session_id, current_page, status, workspace_id } = parsed.data;
  const supabase = getServiceClient(config);

  try {
    if (workspace_id) {
      const origin = typeof req.headers.origin === 'string'
        ? req.headers.origin
        : typeof req.headers.referer === 'string'
          ? req.headers.referer
          : null;
      if (!(await isWorkspaceOriginAllowed(config, workspace_id, origin))) {
        return res.status(403).json({ error: 'Origin not allowed' });
      }
    }

    // Read previous current_page so we only append a new page-view on change.
    const { data: prevSession } = await supabase
      .from('visitor_sessions')
      .select('id, workspace_id, visitor_id, current_page')
      .eq('id', session_id)
      .maybeSingle();

    await supabase
      .from('visitor_sessions')
      .update({
        current_page,
        last_seen_at: new Date().toISOString(),
      })
      .eq('id', session_id);

    await supabase
      .from('visitor_presence')
      .update({
        status,
        current_page,
        updated_at: new Date().toISOString(),
      })
      .eq('visitor_session_id', session_id);

    // Append a page-view only if the URL changed (avoids spam from heartbeats).
    if (
      prevSession?.workspace_id &&
      current_page &&
      current_page !== prevSession.current_page
    ) {
      try {
        await supabase.from('visitor_page_views').insert({
          workspace_id: prevSession.workspace_id,
          visitor_session_id: session_id,
          url: current_page.slice(0, 2048),
        });
      } catch (e) {
        console.warn('[visitors.heartbeat] page-view insert failed:', (e as any)?.message);
      }
    }

    // Realtime push — best-effort.
    if (prevSession?.workspace_id) {
      publishVisitorEvent(config, {
        kind: 'visitor.upsert',
        workspace_id: prevSession.workspace_id,
        session_id,
        patch: {
          status,
          current_page: current_page ?? null,
          last_activity_at: new Date().toISOString(),
          visitor_id: prevSession.visitor_id ?? undefined,
        },
        occurred_at: new Date().toISOString(),
      }).catch(() => {});
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Heartbeat error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ============================================
// POST /api/visitors/disconnect
// Mark visitor as offline
// ============================================
const disconnectSchema = z.object({
  session_id: z.string().uuid(),
});

visitorRouter.post('/disconnect', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = disconnectSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid data' });
  }

  const supabase = getServiceClient(config);

  try {
    // Look up workspace_id so we can publish a `visitor.remove` event.
    const { data: session } = await supabase
      .from('visitor_sessions')
      .select('workspace_id')
      .eq('id', parsed.data.session_id)
      .maybeSingle();

    await supabase
      .from('visitor_presence')
      .update({ status: 'offline', updated_at: new Date().toISOString() })
      .eq('visitor_session_id', parsed.data.session_id);

    if (session?.workspace_id) {
      publishVisitorEvent(config, {
        kind: 'visitor.remove',
        workspace_id: session.workspace_id,
        session_id: parsed.data.session_id,
        occurred_at: new Date().toISOString(),
      }).catch(() => {});
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Disconnect error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ============================================
// OPERATOR-SIDE READS (authenticated)
// ============================================

/**
 * GET /api/visitor-intel/live?workspace_id=...&include_offline=0
 *
 * Returns the normalized visitor intelligence list. Backend resolves
 * presence + session + geo + linked contact/conversation in one shot.
 */
visitorsAdminRouter.get('/live', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = (req.query.workspace_id as string) || '';
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const auth = await authorizeWorkspaceMember(req, res, config, workspaceId);
  if (!auth) return;

  try {
    const items = await listVisitorIntelligence(config, workspaceId, {
      includeOffline: req.query.include_offline === '1',
      staleMinutes: req.query.stale_minutes ? Number(req.query.stale_minutes) : 30,
      limit: req.query.limit ? Number(req.query.limit) : 200,
      viewerRole: auth.role,
    });
    res.json({ items });
  } catch (err) {
    console.error('[visitors.live] failed:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/visitor-intel/map?workspace_id=...
 *
 * Returns map markers (subset of live shape: id, status, geo, current_page).
 * Visitors without coordinates are excluded — the list endpoint still has them.
 */
visitorsAdminRouter.get('/map', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = (req.query.workspace_id as string) || '';
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const auth = await authorizeWorkspaceMember(req, res, config, workspaceId);
  if (!auth) return;

  try {
    const items = await listVisitorIntelligence(config, workspaceId, {
      includeOffline: false,
      viewerRole: auth.role,
    });
    const markers = items
      .filter(i => i.geo.latitude != null && i.geo.longitude != null)
      .map(i => ({
        id: i.id,
        status: i.status,
        lat: i.geo.latitude,
        lng: i.geo.longitude,
        country: i.geo.country,
        country_code: i.geo.country_code,
        city: i.geo.city,
        current_page: i.current_page,
        source: i.geo.source,
      }));
    const without_location = items.length - markers.length;
    // Geo source breakdown — fuels the header insight chip on the Visitors page.
    // 'cache' counts as 'precise' for UX purposes (cache rows came from a real provider).
    const source_counts = {
      precise: 0, approximate: 0, unavailable: 0,
    };
    for (const i of items) {
      const s = i.geo.source;
      if (s === 'provider' || s === 'cache') source_counts.precise++;
      else if (s === 'centroid') source_counts.approximate++;
      else source_counts.unavailable++;
    }
    res.json({ markers, total: items.length, without_location, source_counts });
  } catch (err) {
    console.error('[visitors.map] failed:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/visitor-intel/map-config?workspace_id=...
 *
 * Returns the resolved map_tiles provider config the client should use.
 * Falls back to free OSM tiles when nothing is configured.
 */
visitorsAdminRouter.get('/map-config', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = (req.query.workspace_id as string) || '';
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const auth = await authorizeWorkspaceMember(req, res, config, workspaceId);
  if (!auth) return;

  try {
    const cfg = await resolveMapTilesConfig(config, workspaceId);
    res.json(cfg);
  } catch (err) {
    console.error('[visitors.map-config] failed:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/visitor-intel/:id?workspace_id=...
 *
 * Detail for a single visitor session — full intelligence shape.
 * Used by the detail drawer.
 */
visitorsAdminRouter.get('/:id', async (req: Request, res: Response) => {
  // Sub-route guard: /:id/page-history is handled below.
  if (req.params.id === 'live' || req.params.id === 'map' || req.params.id === 'map-config') {
    return res.status(404).json({ error: 'Not found' });
  }
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = (req.query.workspace_id as string) || '';
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const auth = await authorizeWorkspaceMember(req, res, config, workspaceId);
  if (!auth) return;

  try {
    const item = await getVisitorIntelligence(config, workspaceId, req.params.id, {
      viewerRole: auth.role,
    });
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) {
    console.error('[visitors.detail] failed:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/visitor-intel/:id/page-history?workspace_id=...&limit=20
 *
 * Returns ordered (most-recent first) page-view rows for a session.
 */
visitorsAdminRouter.get('/:id/page-history', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = (req.query.workspace_id as string) || '';
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const auth = await authorizeWorkspaceMember(req, res, config, workspaceId);
  if (!auth) return;

  const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('visitor_page_views')
      .select('id, url, viewed_at')
      .eq('workspace_id', workspaceId)
      .eq('visitor_session_id', req.params.id)
      .order('viewed_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json({ items: data ?? [] });
  } catch (err) {
    console.error('[visitors.page-history] failed:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});
