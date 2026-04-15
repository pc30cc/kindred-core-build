import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createHash } from 'crypto';
import { getServiceClient } from '../supabase.js';
import type { ServerConfig } from '../config.js';
import { isOriginAllowed } from '../utils/domain.js';

export const visitorRouter = Router();

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

  // Hash IP for privacy
  const clientIp = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';
  const ipHash = createHash('sha256').update(clientIp).digest('hex').slice(0, 16);

  try {
    // Validate workspace exists and has tracking enabled
    const { data: widget } = await supabase
      .from('widget_settings')
      .select('visitor_tracking_enabled, allowed_domains, allow_subdomains')
      .eq('workspace_id', data.workspace_id)
      .single();
      .eq('workspace_id', data.workspace_id)
      .single();

    if (!widget || !widget.visitor_tracking_enabled) {
      return res.status(403).json({ error: 'Visitor tracking not enabled' });
    }

    const origin = req.headers.origin || req.headers.referer;
    if (origin && widget.allowed_domains && widget.allowed_domains.length > 0) {
      if (!isOriginAllowed(origin, widget.allowed_domains, widget.allow_subdomains ?? false)) {
        return res.status(403).json({ error: 'Origin not allowed' });
      }
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
        })
        .select('id')
        .single();

      if (error) {
        console.error('Visitor session insert error:', error);
        return res.status(500).json({ error: 'Failed to create session' });
      }
      sessionId = newSession!.id;
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

  const { session_id, current_page, status } = parsed.data;
  const supabase = getServiceClient(config);

  try {
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
    await supabase
      .from('visitor_presence')
      .update({ status: 'offline', updated_at: new Date().toISOString() })
      .eq('visitor_session_id', parsed.data.session_id);

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Disconnect error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});
