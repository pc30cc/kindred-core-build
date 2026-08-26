/**
 * Contacts API — canonical TS-first create / import chokepoint.
 *
 * Flow:
 *   1. Identity = first-party session cookie (server/lib/workspaceAuth.ts).
 *   2. Verify the user is a workspace member via `is_workspace_member`.
 *   3. Compose entitlements + enforce `max_contacts` through the
 *      existing TypeScript stack (`requireLimit` / `checkEntitlementFromDB`
 *      + `usageFnForLimit('max_contacts')`). No SQL-side composer.
 *   4. Insert via the service-role client.
 *
 * Bulk import is all-or-nothing: if the post-insert count would exceed
 * the effective limit, the entire batch is rejected with a structured
 * 403 and zero rows are inserted.
 *
 * Update / delete / tags / notes are intentionally NOT exposed here —
 * they remain direct PostgREST operations and are out of scope for
 * this enforcement boundary.
 */

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  enforceMaxContactsCreate,
  assertContactsBatchFits,
} from '../services/billing/contactsLimit.js';
import { clearEntitlementCache } from '../middleware/featureGating.js';
import { checkEntitlementFromDB } from '../middleware/featureGating.js';
import {
  resolveIpVisibilityPolicy,
  resolveContactNetworkProfile,
} from '../services/visitors/networkProfile.js';
import { authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';

export const contactsRouter = Router();

const contactSchema = z.object({
  email: z.string().email().max(320).nullable().optional(),
  name: z.string().max(200).nullable().optional(),
  phone: z.string().max(64).nullable().optional(),
  avatar_url: z.string().max(2048).nullable().optional(),
  tags: z.array(z.string().max(64)).max(64).optional(),
  notes: z.string().max(10_000).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const createSchema = contactSchema.extend({
  workspace_id: z.string().uuid(),
});

const bulkSchema = z.object({
  workspace_id: z.string().uuid(),
  contacts: z.array(contactSchema).min(1).max(5_000),
});

async function authorizeWorkspaceMember(
  req: any,
  res: any,
  _config: ServerConfig,
  workspaceId: string,
): Promise<{ userId: string; role: string | null } | null> {
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return null;
  // Workspace role drives the raw-IP decision (see networkProfile.ts).
  return { userId: auth.userId, role: auth.role };
}

function normalizeContactRow(c: z.infer<typeof contactSchema>, workspaceId: string) {
  return {
    workspace_id: workspaceId,
    email: c.email ?? null,
    name: c.name ?? null,
    phone: c.phone ?? null,
    avatar_url: c.avatar_url ?? null,
    tags: c.tags ?? [],
    notes: c.notes ?? null,
    metadata: c.metadata ?? {},
  };
}

contactsRouter.post('/', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const auth = await authorizeWorkspaceMember(req, res, config, parsed.data.workspace_id);
    if (!auth) return;

    // Plan gate: manual contact creation must be entitled.
    const createGate = await checkEntitlementFromDB(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      parsed.data.workspace_id,
      'contact_create',
    );
    if (!createGate.allowed) {
      return res.status(403).json({
        error: 'feature_not_entitled',
        feature: 'contact_create',
        reason: createGate.reason ?? 'not_entitled',
      });
    }

    // Canonical TS limit check. The middleware reads workspace_id off
    // req.body — already validated above.
    const ok = await enforceMaxContactsCreate(req, res);
    if (!ok) return;

    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('contacts')
      .insert(normalizeContactRow(parsed.data, parsed.data.workspace_id))
      .select()
      .single();
    if (error) {
      return res.status(500).json({ error: error.message });
    }
    // Invalidate cached entitlement so a subsequent at-cap check sees the
    // new occupancy on the next request (cache TTL is 60s otherwise).
    clearEntitlementCache(parsed.data.workspace_id);
    return res.json({ ok: true, contact: data });
  } catch (err: any) {
    console.error('[contacts/create] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

contactsRouter.post('/bulk', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = bulkSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const auth = await authorizeWorkspaceMember(req, res, config, parsed.data.workspace_id);
    if (!auth) return;

    // All-or-nothing pre-check.
    const fits = await assertContactsBatchFits(
      req,
      res,
      parsed.data.workspace_id,
      parsed.data.contacts.length,
    );
    if (!fits) return;

    const rows = parsed.data.contacts.map((c) =>
      normalizeContactRow(c, parsed.data.workspace_id),
    );
    const sb = getServiceClient(config);
    const { data, error } = await sb.from('contacts').insert(rows).select('id');
    if (error) {
      return res.status(500).json({ error: error.message, inserted: 0 });
    }
    clearEntitlementCache(parsed.data.workspace_id);
    return res.json({ ok: true, inserted: data?.length ?? 0 });
  } catch (err: any) {
    console.error('[contacts/bulk] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════
// GET / — list contacts for a workspace.
// GET /:id, GET /:id/conversations, PATCH /:id, DELETE /:id, POST /bulk-delete
//
// Replace the direct supabase.from('contacts'/'conversations'/
// 'conversation_messages'/'profiles') reads/writes in src/hooks/useContacts.ts,
// which relied on RLS scoped to auth.uid() (silently empty/no-op without a
// Supabase Auth session) and — for update/delete — accepted a bare contact
// id with NO workspace check of any kind (a service-role write reachable
// from any authenticated caller for any contact id, regardless of tenant).
//
// Every id-based route below loads the row FIRST and authorizes against
// ITS OWN workspace_id (mirroring the existing GET /:id/ip pattern just
// below) rather than trusting a client-supplied workspace_id — a caller
// can't launder access to a foreign contact by pairing its id with a
// workspace_id they legitimately belong to.
// ═══════════════════════════════════════════════

contactsRouter.get('/', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const workspaceId = String(req.query.workspace_id || '');
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
    const auth = await authorizeWorkspaceMember(req, res, config, workspaceId);
    if (!auth) return;

    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('contacts')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ contacts: data || [] });
  } catch (err: any) {
    console.error('[contacts list] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

/** Loads a contact and authorizes the caller against its OWN workspace_id. Sends the response and returns null on any failure. */
async function loadAndAuthorizeContact(
  req: any,
  res: any,
  config: ServerConfig,
  sb: ReturnType<typeof getServiceClient>,
  contactId: string,
  opts: { manage?: boolean } = {},
): Promise<{ contact: any } | null> {
  const { data: contact } = await sb.from('contacts').select('*').eq('id', contactId).maybeSingle();
  if (!contact) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  const auth = opts.manage
    ? await authorizeWorkspaceAccess(req, res, contact.workspace_id, { manage: true })
    : await authorizeWorkspaceMember(req, res, config, contact.workspace_id);
  if (!auth) return null;
  return { contact };
}

contactsRouter.get('/:id', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const loaded = await loadAndAuthorizeContact(req, res, config, sb, req.params.id);
    if (!loaded) return;
    return res.json({ contact: loaded.contact });
  } catch (err: any) {
    console.error('[contacts get] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

contactsRouter.get('/:id/conversations', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const loaded = await loadAndAuthorizeContact(req, res, config, sb, req.params.id);
    if (!loaded) return;

    const { data: convData, error: convErr } = await sb
      .from('conversations')
      .select('*')
      .eq('contact_id', req.params.id)
      .order('updated_at', { ascending: false });
    if (convErr) return res.status(500).json({ error: convErr.message });
    const convs = (convData ?? []) as any[];
    if (!convs.length) return res.json({ conversations: [] });

    const ids = convs.map((c) => c.id);
    const { data: msgs } = await sb
      .from('conversation_messages')
      .select('conversation_id, sender_type, sender_id, body, created_at')
      .in('conversation_id', ids)
      .order('created_at', { ascending: true });

    const operatorIds = new Set<string>();
    for (const c of convs) if (c.assigned_to) operatorIds.add(c.assigned_to);
    for (const m of (msgs ?? []) as any[]) {
      if (m.sender_type === 'agent' && m.sender_id) operatorIds.add(m.sender_id);
    }

    let profiles: Record<string, { full_name: string | null; email: string; avatar_url: string | null }> = {};
    if (operatorIds.size) {
      const { data: profs } = await sb
        .from('profiles')
        .select('id, full_name, email, avatar_url')
        .in('id', Array.from(operatorIds));
      for (const p of (profs ?? []) as any[]) {
        profiles[p.id] = { full_name: p.full_name, email: p.email, avatar_url: p.avatar_url };
      }
    }

    const result = convs.map((c) => {
      const mine = ((msgs ?? []) as any[]).filter((m) => m.conversation_id === c.id);
      const hasAi = mine.some((m) => m.sender_type === 'ai' || m.sender_type === 'bot');
      const agentMsgs = mine.filter((m) => m.sender_type === 'agent' && m.sender_id);
      const lastAgentId = agentMsgs.length ? agentMsgs[agentMsgs.length - 1].sender_id : null;
      const operatorId = lastAgentId || c.assigned_to || null;
      const operator = operatorId ? profiles[operatorId] ?? null : null;
      const lastMessage = mine.length ? mine[mine.length - 1] : null;
      return {
        ...c,
        handled_by_ai: hasAi,
        handled_by_operator: !!operator,
        operator_name: operator ? operator.full_name || operator.email : null,
        operator_avatar: operator?.avatar_url ?? null,
        last_message_body: lastMessage?.body ?? null,
        message_count: mine.length,
      };
    });
    return res.json({ conversations: result });
  } catch (err: any) {
    console.error('[contacts conversations] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

const updateContactSchema = contactSchema.partial();

contactsRouter.patch('/:id', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = updateContactSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten().fieldErrors });
    }
    const sb = getServiceClient(config);
    const loaded = await loadAndAuthorizeContact(req, res, config, sb, req.params.id);
    if (!loaded) return;

    const { data, error } = await sb
      .from('contacts')
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, contact: data });
  } catch (err: any) {
    console.error('[contacts update] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

contactsRouter.delete('/:id', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const loaded = await loadAndAuthorizeContact(req, res, config, sb, req.params.id);
    if (!loaded) return;

    const { error } = await sb.from('contacts').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  } catch (err: any) {
    console.error('[contacts delete] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// POST /bulk-delete — every id must resolve to the SAME workspace, and the
// caller must be a member of it (matches the original "Members can delete
// contacts" RLS policy — bulk delete was never owner/admin-only). A batch
// mixing ids from more than one workspace (or containing an id the caller
// can't reach) is rejected in full — no partial deletes, and no "figure
// out which ids are foreign" signal handed back beyond a generic rejection.
const bulkDeleteSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) });

contactsRouter.post('/bulk-delete', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = bulkDeleteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
    const sb = getServiceClient(config);

    const { data: rows, error: loadErr } = await sb
      .from('contacts')
      .select('id, workspace_id')
      .in('id', parsed.data.ids);
    if (loadErr) return res.status(500).json({ error: loadErr.message });
    const found = (rows || []) as Array<{ id: string; workspace_id: string }>;
    if (found.length !== parsed.data.ids.length) {
      return res.status(400).json({ error: 'unknown_contact_id' });
    }
    const workspaceIds = new Set(found.map((r) => r.workspace_id));
    if (workspaceIds.size !== 1) {
      return res.status(400).json({ error: 'mixed_workspace_batch' });
    }
    const [workspaceId] = workspaceIds;
    const auth = await authorizeWorkspaceMember(req, res, config, workspaceId);
    if (!auth) return;

    const { error: delErr } = await sb.from('contacts').delete().in('id', parsed.data.ids);
    if (delErr) return res.status(500).json({ error: delErr.message });
    return res.json({ deleted: parsed.data.ids.length });
  } catch (err: any) {
    console.error('[contacts bulk-delete] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════
// GET /:id/ip — Plan-gated visitor IP lookup for the contact detail page.
//
// The IP is never part of the regular contact payload — it's resolved on
// demand here so a workspace without the `contact_ip_visibility`
// entitlement never has it leave the server at all.
//
// This route owns NO policy of its own: it delegates to the canonical
// `resolveIpVisibilityPolicy` + `resolveContactNetworkProfile` in
// services/visitors/networkProfile.ts, so the three states are identical to
// Inbox / Visitors / Call Center:
//   • no entitlement                  → 403, nothing (not even masked)
//   • entitled, non-admin member      → masked value only
//   • entitled, owner/admin           → raw (when store_raw_ip persisted one)
// `store_raw_ip = false` means no raw IP was ever written, so even an owner
// only receives the masked / hash placeholder form.
// ═══════════════════════════════════════════════
contactsRouter.get('/:id/ip', async (req, res) => {
  try {
    const contactId = req.params.id;
    if (!contactId) return res.status(400).json({ error: 'missing_id' });
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);

    const { data: contact } = await sb
      .from('contacts')
      .select('id, workspace_id')
      .eq('id', contactId)
      .maybeSingle();
    if (!contact) return res.status(404).json({ error: 'not_found' });

    const auth = await authorizeWorkspaceMember(req, res, config, contact.workspace_id);
    if (!auth) return;

    const policy = await resolveIpVisibilityPolicy(config, contact.workspace_id, auth.role);
    if (!policy.entitled) {
      return res.status(403).json({ error: 'feature_not_entitled', feature: 'contact_ip_visibility' });
    }

    const profile = await resolveContactNetworkProfile(
      config,
      contact.workspace_id,
      contactId,
      policy,
    );
    if (!profile) return res.json({ ip: null, ip_view: null });
    return res.json({
      // Back-compat scalar: raw for admins, masked/placeholder for everyone
      // else — never the raw value for a non-admin member.
      ip: profile.ip.display || null,
      ip_view: profile.ip,
      visitor_session_id: profile.visitor_session_id,
    });
  } catch (err: any) {
    console.error('[contacts/ip] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});