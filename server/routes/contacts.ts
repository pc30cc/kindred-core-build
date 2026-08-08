/**
 * Contacts API — canonical TS-first create / import chokepoint.
 *
 * Flow:
 *   1. Bearer = Supabase user access token.
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
  const { data: isMember, error: memErr } = await sb.rpc('is_workspace_member', {
    _workspace_id: workspaceId,
    _user_id: user.id,
  });
  if (memErr) {
    res.status(500).json({ error: 'Membership check failed' });
    return null;
  }
  if (!isMember) {
    res.status(403).json({ error: 'Not a workspace member' });
    return null;
  }
  // Workspace role drives the raw-IP decision (see networkProfile.ts).
  const { data: member } = await sb
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .maybeSingle();
  return { userId: user.id, role: ((member as any)?.role as string | null) ?? null };
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
// GET /:id/ip — Plan-gated visitor IP lookup for the contact detail page.
//
// The IP is never part of the regular contact payload (useContact() reads
// `contacts` directly via Supabase RLS) — it's resolved on demand here so a
// workspace without the `contact_ip_visibility` entitlement never has it
// leave the server at all. There's also nothing on `contacts` itself to
// read: raw IP only ever lives on `visitor_sessions.ip_raw`, and only when
// the workspace opted in via widget_settings.store_raw_ip (see
// server/routes/visitors.ts) — no opt-in means no raw IP was ever stored,
// by design, regardless of plan.
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

    const gate = await checkEntitlementFromDB(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      contact.workspace_id,
      'contact_ip_visibility',
    );
    if (!gate.allowed) {
      return res.status(403).json({ error: 'feature_not_entitled', feature: 'contact_ip_visibility' });
    }

    const { data: session } = await sb
      .from('visitor_sessions')
      .select('ip_raw')
      .eq('workspace_id', contact.workspace_id)
      .eq('contact_id', contactId)
      .not('ip_raw', 'is', null)
      .order('last_seen_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return res.json({ ip: (session as any)?.ip_raw || null });
  } catch (err: any) {
    console.error('[contacts/ip] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});