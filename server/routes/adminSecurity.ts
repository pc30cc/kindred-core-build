/**
 * Platform-admin security dashboard: security_events / ip_blocklist /
 * admin_security_stats. Mounted under adminRouter (server/routes/admin.ts),
 * which already gates every route here behind `requirePlatformAdmin` —
 * replaces direct browser `supabase.rpc('admin_security_stats')` and
 * `supabase.from('security_events' | 'ip_blocklist')` calls, whose RLS/ACL
 * requires `auth.uid()` + `has_role('admin')`, unreachable from a browser
 * client that never holds a GoTrue session under first-party auth.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';

export const adminSecurityRouter = Router();

function serverConfigOf(req: any): ServerConfig {
  return req.serverConfig as ServerConfig;
}

adminSecurityRouter.get('/stats', async (req, res) => {
  const sb = getServiceClient(serverConfigOf(req));
  const { data, error } = await sb.rpc('admin_security_stats');
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

const eventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

adminSecurityRouter.get('/events', async (req, res) => {
  const parsed = eventsQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const sb = getServiceClient(serverConfigOf(req));
  const { data, error } = await sb
    .from('security_events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(parsed.data.limit);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ events: data });
});

adminSecurityRouter.post('/events/:id/resolve', async (req, res) => {
  const sb = getServiceClient(serverConfigOf(req));
  const { error } = await sb
    .from('security_events')
    .update({ resolved: true, resolved_at: new Date().toISOString() })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

adminSecurityRouter.get('/blocked-ips', async (req, res) => {
  const sb = getServiceClient(serverConfigOf(req));
  const { data, error } = await sb
    .from('ip_blocklist')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ips: data });
});

const blockIpSchema = z.object({
  ip: z.string().min(1).max(64),
  reason: z.string().min(1).max(500),
});

adminSecurityRouter.post('/blocked-ips', async (req, res) => {
  const parsed = blockIpSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const sb = getServiceClient(serverConfigOf(req));
  const { error } = await sb.from('ip_blocklist').insert({
    ip_address: parsed.data.ip,
    reason: parsed.data.reason,
    blocked_by: (req as any).adminUser?.id ?? null,
  });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

adminSecurityRouter.delete('/blocked-ips/:id', async (req, res) => {
  const sb = getServiceClient(serverConfigOf(req));
  const { error } = await sb.from('ip_blocklist').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});
