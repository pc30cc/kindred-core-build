/**
 * Email logs, contact channel badges/call history, workspace provider
 * settings (email/ai/webhook), and workspace privacy-export storage
 * override. Replaces direct browser supabase.from() calls from
 * useEmailLogs.ts / useContactChannels.ts / useWorkspaceProviders.ts /
 * useWorkspacePrivacyStorage.ts — all auth.uid()-RLS-gated, silently
 * broken today under first-party auth.
 *
 * Authorization mirrors the RLS policies being replaced:
 *  - email_logs SELECT: owner/admin only ("Admins can view email logs").
 *  - workspace_provider_settings: owner/admin only for ALL operations.
 *  - provider_configs (privacy_export_storage): owner/admin only, per the
 *    hook's own pre-existing comment.
 *  - conversations/call_sessions/call_recordings (channel badges + call
 *    history): plain member-level, matching the contacts/conversations
 *    precedent already established elsewhere in this migration.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';

export const workspaceIntegrationsRouter = Router();

function serverConfigOf(req: any): ServerConfig {
  return req.serverConfig as ServerConfig;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Email logs ──────────────────────────────────────────────────────────
const emailLogsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.string().max(50).optional(),
});

workspaceIntegrationsRouter.get('/:workspaceId/email-logs', async (req, res) => {
  const config = serverConfigOf(req);
  const parsed = emailLogsQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  if (!(await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true }))) return;
  const sb = getServiceClient(config);
  let query = sb
    .from('email_logs')
    .select('*')
    .eq('workspace_id', req.params.workspaceId)
    .order('created_at', { ascending: false })
    .limit(parsed.data.limit);
  if (parsed.data.status) query = query.eq('status', parsed.data.status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ logs: data });
});

// ── Contact channel badges + call history ──────────────────────────────
const CALL_SESSION_COLUMNS =
  'id, context_id, call_type, direction, state, entry_source, duration_seconds, wait_seconds, created_at, started_at, connected_at, ended_at, end_reason, assigned_agent_id, recording_enabled, recording_state, visitor_name, visitor_phone, visitor_email';

workspaceIntegrationsRouter.get('/:workspaceId/contact-channels', async (req, res) => {
  const config = serverConfigOf(req);
  if (!(await authorizeWorkspaceAccess(req, res, req.params.workspaceId))) return;
  const sb = getServiceClient(config);

  const { data: convs, error } = await sb
    .from('conversations')
    .select('id, contact_id')
    .eq('workspace_id', req.params.workspaceId)
    .not('contact_id', 'is', null);
  if (error) return res.status(500).json({ error: error.message });

  const convToContact = new Map<string, string>();
  const map: Record<string, { chat: boolean; call: boolean; calls: number; lastCallAt: string | null }> = {};
  for (const c of (convs ?? []) as any[]) {
    convToContact.set(c.id, c.contact_id);
    if (!map[c.contact_id]) map[c.contact_id] = { chat: false, call: false, calls: 0, lastCallAt: null };
  }

  const convIds = Array.from(convToContact.keys());
  const callConvIds = new Set<string>();
  if (convIds.length) {
    for (const part of chunk(convIds, 150)) {
      const { data: sessions, error: sessErr } = await sb
        .from('call_sessions')
        .select(CALL_SESSION_COLUMNS)
        .eq('context_type', 'conversation')
        .in('context_id', part)
        .order('created_at', { ascending: false });
      if (sessErr) return res.status(500).json({ error: sessErr.message });
      for (const s of (sessions ?? []) as any[]) {
        const contactId = convToContact.get(s.context_id);
        if (!contactId) continue;
        callConvIds.add(s.context_id);
        const entry = map[contactId];
        entry.call = true;
        entry.calls += 1;
        const at = s.created_at ?? null;
        if (at && (!entry.lastCallAt || at > entry.lastCallAt)) entry.lastCallAt = at;
      }
    }
  }

  for (const [convId, contactId] of convToContact) {
    if (!callConvIds.has(convId)) map[contactId].chat = true;
  }

  return res.json({ channels: map });
});

workspaceIntegrationsRouter.get('/:workspaceId/contacts/:contactId/calls', async (req, res) => {
  const config = serverConfigOf(req);
  if (!(await authorizeWorkspaceAccess(req, res, req.params.workspaceId))) return;
  const sb = getServiceClient(config);
  const { workspaceId, contactId } = req.params;

  // Tenant check via the contact's own workspace_id — same load-then-
  // authorize pattern used throughout contacts.ts / conversations.ts.
  const { data: contact } = await sb
    .from('contacts')
    .select('id')
    .eq('id', contactId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const { data: convs, error } = await sb.from('conversations').select('id').eq('contact_id', contactId);
  if (error) return res.status(500).json({ error: error.message });
  const convIds = ((convs ?? []) as any[]).map((c) => c.id);
  if (!convIds.length) return res.json({ calls: [] });

  const sessions: any[] = [];
  for (const part of chunk(convIds, 150)) {
    const { data, error: sessErr } = await sb
      .from('call_sessions')
      .select(CALL_SESSION_COLUMNS)
      .eq('context_type', 'conversation')
      .in('context_id', part)
      .order('created_at', { ascending: false });
    if (sessErr) return res.status(500).json({ error: sessErr.message });
    sessions.push(...((data ?? []) as any[]));
  }
  if (!sessions.length) return res.json({ calls: [] });

  const agentIds = Array.from(new Set(sessions.map((s) => s.assigned_agent_id).filter(Boolean))) as string[];
  const profiles: Record<string, { full_name: string | null; email: string; avatar_url: string | null }> = {};
  if (agentIds.length) {
    const { data: profs } = await sb.from('profiles').select('id, full_name, email, avatar_url').in('id', agentIds);
    for (const p of (profs ?? []) as any[]) {
      profiles[p.id] = { full_name: p.full_name, email: p.email, avatar_url: p.avatar_url };
    }
  }

  const recordings: Record<string, any> = {};
  for (const part of chunk(sessions.map((s) => s.id), 150)) {
    const { data: recs } = await sb
      .from('call_recordings')
      .select('call_session_id, duration_seconds, size_bytes, created_at')
      .in('call_session_id', part);
    for (const r of (recs ?? []) as any[]) recordings[r.call_session_id] = r;
  }

  const calls = sessions.map((s) => {
    const p = s.assigned_agent_id ? profiles[s.assigned_agent_id] : null;
    const rec = recordings[s.id] ?? null;
    return {
      id: s.id,
      call_type: s.call_type,
      direction: s.direction,
      state: s.state,
      entry_source: s.entry_source ?? null,
      duration_seconds: s.duration_seconds ?? null,
      wait_seconds: s.wait_seconds ?? null,
      created_at: s.created_at,
      ended_at: s.ended_at ?? null,
      end_reason: s.end_reason ?? null,
      agent_name: p ? p.full_name || p.email : null,
      agent_avatar: p?.avatar_url ?? null,
      recording_state: s.recording_state ?? null,
      recording_available: !!rec,
      recording_duration: rec?.duration_seconds ?? null,
      recording_size_bytes: rec?.size_bytes ?? null,
      conversation_id: s.context_id ?? null,
    };
  });
  return res.json({ calls });
});

// ── Workspace email templates (owner/admin ALL, per RLS) ───────────────
workspaceIntegrationsRouter.get('/:workspaceId/email-templates', async (req, res) => {
  const config = serverConfigOf(req);
  if (!(await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true }))) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('email_templates')
    .select('*')
    .eq('workspace_id', req.params.workspaceId)
    .order('slug');
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ templates: data });
});

// ── Workspace provider settings (email/ai/webhook) ─────────────────────
workspaceIntegrationsRouter.get('/:workspaceId/providers', async (req, res) => {
  const config = serverConfigOf(req);
  if (!(await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true }))) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('workspace_provider_settings')
    .select('*')
    .eq('workspace_id', req.params.workspaceId)
    .order('provider_type');
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ settings: data });
});

const upsertProviderSchema = z.object({
  provider_type: z.enum(['email', 'ai', 'webhook']),
  provider_name: z.string().min(1).max(100),
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()),
  secrets: z.record(z.string(), z.unknown()),
});

workspaceIntegrationsRouter.put('/:workspaceId/providers', async (req, res) => {
  const config = serverConfigOf(req);
  const parsed = upsertProviderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  if (!(await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true }))) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('workspace_provider_settings')
    .upsert(
      { workspace_id: req.params.workspaceId, ...parsed.data },
      { onConflict: 'workspace_id,provider_type' },
    )
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ setting: data });
});

workspaceIntegrationsRouter.delete('/:workspaceId/providers/:providerType', async (req, res) => {
  const config = serverConfigOf(req);
  if (!(await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true }))) return;
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('workspace_provider_settings')
    .delete()
    .eq('workspace_id', req.params.workspaceId)
    .eq('provider_type', req.params.providerType);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

// ── Workspace privacy-export storage override ──────────────────────────
const PRIVACY_STORAGE_TYPE = 'privacy_export_storage';

workspaceIntegrationsRouter.get('/:workspaceId/privacy-storage', async (req, res) => {
  const config = serverConfigOf(req);
  if (!(await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true }))) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('provider_configs')
    .select('*')
    .eq('workspace_id', req.params.workspaceId)
    .eq('provider_type', PRIVACY_STORAGE_TYPE)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ storage: data });
});

const upsertPrivacyStorageSchema = z.object({
  provider_name: z.enum(['local', 's3', 'cloudflare_r2', 'minio', 'do_spaces', 'bunny_storage']),
  config: z.record(z.string(), z.unknown()),
});

workspaceIntegrationsRouter.put('/:workspaceId/privacy-storage', async (req, res) => {
  const config = serverConfigOf(req);
  const parsed = upsertPrivacyStorageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  if (!(await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true }))) return;
  const sb = getServiceClient(config);

  // Deactivate previous overrides, then insert a fresh active row —
  // provider_configs is generic and doesn't enforce one-row-per-type.
  await sb
    .from('provider_configs')
    .update({ is_active: false })
    .eq('workspace_id', req.params.workspaceId)
    .eq('provider_type', PRIVACY_STORAGE_TYPE);

  const { data, error } = await sb
    .from('provider_configs')
    .insert({
      workspace_id: req.params.workspaceId,
      provider_type: PRIVACY_STORAGE_TYPE,
      provider_name: parsed.data.provider_name,
      is_active: true,
      config: parsed.data.config,
    })
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ storage: data });
});

workspaceIntegrationsRouter.delete('/:workspaceId/privacy-storage', async (req, res) => {
  const config = serverConfigOf(req);
  if (!(await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true }))) return;
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('provider_configs')
    .delete()
    .eq('workspace_id', req.params.workspaceId)
    .eq('provider_type', PRIVACY_STORAGE_TYPE);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});
