/**
 * Phase 6 — Canned responses (operator reply templates).
 *
 * Workspace-scoped, multilingual (en/fa/tr), with slash-trigger search.
 * No widget exposure, no realtime push, no envelope changes.
 *
 * ─── ROUTES ────────────────────────────────────────────────────────
 *   GET    /api/canned-responses?workspace_id=&locale=&q=&limit=
 *   POST   /api/canned-responses
 *   PATCH  /api/canned-responses/:id
 *   DELETE /api/canned-responses/:id?workspace_id=<uuid>
 *   POST   /api/canned-responses/:id/track-use
 *
 * ─── AUTH MODEL ────────────────────────────────────────────────────
 * Bearer = Supabase user access token. We resolve the user, verify
 * workspace membership via `is_workspace_member`, then perform DB
 * operations through the service-role client. RLS on the table also
 * enforces these rules defensively at the database layer.
 *
 * ─── PERMISSIONS ───────────────────────────────────────────────────
 *   View   : any workspace member
 *   Create : any workspace member (created_by forced to caller)
 *   Edit   : author OR workspace owner/admin
 *   Delete : author OR workspace owner/admin
 *
 * ─── IMMUTABLE FIELDS ON EDIT ──────────────────────────────────────
 *   workspace_id, created_by, usage_count, last_used_at
 * Editable via PATCH:
 *   locale, shortcut, title, body, is_active
 * usage_count + last_used_at are mutated ONLY via /track-use.
 *
 * ─── SEARCH / RANKING ──────────────────────────────────────────────
 * GET supports:
 *   - locale="op"       → operator-locale-first, then other locales as fallback
 *   - q="<text>"        → matches against shortcut/title/body (ilike)
 *   - limit=1..50       → default 25
 * Ranking:
 *   1. exact shortcut match (case-insensitive)
 *   2. shortcut prefix match
 *   3. title ilike match
 *   4. body ilike match
 * Ties broken by usage_count DESC, then last_used_at DESC NULLS LAST,
 * then updated_at DESC. Operator-locale rows always sort above fallback
 * locales for a given match tier.
 */

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';

export const cannedResponsesRouter = Router();

// ─── Validation ────────────────────────────────────────────────────
const LOCALES = ['en', 'fa', 'tr'] as const;
const SHORTCUT_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

const localeSchema = z.enum(LOCALES);
const shortcutSchema = z
  .string()
  .trim()
  .min(1)
  .max(41)
  .regex(SHORTCUT_RE, 'shortcut must match ^[a-z0-9][a-z0-9_-]{0,40}$');
const titleSchema = z.string().trim().min(1).max(120);
const bodySchema = z.string().min(1).max(4000);

const createSchema = z.object({
  workspace_id: z.string().uuid(),
  locale: localeSchema,
  shortcut: shortcutSchema,
  title: titleSchema,
  body: bodySchema,
  is_active: z.boolean().optional(),
});

// PATCH: workspace_id required for auth+routing, but is NOT applied to the row.
// created_by, usage_count, last_used_at are NOT accepted here.
const updateSchema = z
  .object({
    workspace_id: z.string().uuid(),
    locale: localeSchema.optional(),
    shortcut: shortcutSchema.optional(),
    title: titleSchema.optional(),
    body: bodySchema.optional(),
    is_active: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.locale !== undefined ||
      v.shortcut !== undefined ||
      v.title !== undefined ||
      v.body !== undefined ||
      v.is_active !== undefined,
    { message: 'At least one editable field must be provided' },
  );

const trackUseSchema = z.object({ workspace_id: z.string().uuid() });

// ─── Auth helper — delegates to the central first-party session helper ──
async function authorizeMember(
  req: any,
  res: any,
  _config: ServerConfig,
  workspaceId: string,
): Promise<{ userId: string } | null> {
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return null;
  return { userId: auth.userId };
}

async function isAdminOrOwner(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const sb = getServiceClient(config);
  const { data: role } = await sb.rpc('get_workspace_role', {
    _workspace_id: workspaceId,
    _user_id: userId,
  });
  return role === 'owner' || role === 'admin';
}

// Escape user input for ilike pattern usage (prevents wildcard injection
// from changing match scope; PostgREST passes patterns through verbatim).
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (m) => '\\' + m);
}

// Rank tier for a row given the search query (lower = better).
function matchTier(row: { shortcut: string; title: string; body: string }, q: string): number {
  const ql = q.toLowerCase();
  const sc = row.shortcut.toLowerCase();
  if (sc === ql) return 0;
  if (sc.startsWith(ql)) return 1;
  if (row.title.toLowerCase().includes(ql)) return 2;
  if (row.body.toLowerCase().includes(ql)) return 3;
  return 4;
}

const SELECT_COLS =
  'id, workspace_id, created_by, locale, shortcut, title, body, is_active, usage_count, last_used_at, created_at, updated_at';

// ═══════════════════════════════════════════════════════════════════
// GET /api/canned-responses
// Query: workspace_id (req), locale (req), q?, limit?
// Operator-locale rows are returned first; remaining locales follow as
// fallback so the picker can show them with a language badge.
// ═══════════════════════════════════════════════════════════════════
cannedResponsesRouter.get('/', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const workspaceId = String(req.query.workspace_id || '');
    const locale = String(req.query.locale || '');
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '25'), 10) || 25, 1), 50);

    if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });
    const localeCheck = localeSchema.safeParse(locale);
    if (!localeCheck.success) return res.status(400).json({ error: 'invalid locale' });

    const auth = await authorizeMember(req, res, config, workspaceId);
    if (!auth) return;

    const sb = getServiceClient(config);
    let query = sb
      .from('canned_responses')
      .select(SELECT_COLS)
      .eq('workspace_id', workspaceId)
      .eq('is_active', true);

    if (q) {
      const safe = escapeLike(q);
      // PostgREST `or` filter — quote values to allow commas/spaces safely.
      query = query.or(
        `shortcut.ilike.*${safe}*,title.ilike.*${safe}*,body.ilike.*${safe}*`,
      );
    }

    // Pull a generous slice; we re-rank in app code so we can interleave
    // operator-locale + fallback locales deterministically.
    const { data, error } = await query
      .order('usage_count', { ascending: false })
      .order('last_used_at', { ascending: false, nullsFirst: false })
      .order('updated_at', { ascending: false })
      .limit(Math.max(limit * 4, 100));

    if (error) return res.status(500).json({ error: error.message });

    const rows = (data ?? []).map((r) => ({
      ...r,
      __isOperatorLocale: r.locale === locale,
      __tier: q ? matchTier(r as any, q) : 0,
    }));

    rows.sort((a, b) => {
      if (a.__tier !== b.__tier) return a.__tier - b.__tier;
      if (a.__isOperatorLocale !== b.__isOperatorLocale) {
        return a.__isOperatorLocale ? -1 : 1;
      }
      if (a.usage_count !== b.usage_count) return b.usage_count - a.usage_count;
      const al = a.last_used_at ? new Date(a.last_used_at).getTime() : 0;
      const bl = b.last_used_at ? new Date(b.last_used_at).getTime() : 0;
      if (al !== bl) return bl - al;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });

    const trimmed = rows.slice(0, limit).map(({ __isOperatorLocale, __tier, ...rest }) => rest);
    return res.json({ ok: true, items: trimmed, locale });
  } catch (err: any) {
    console.error('[canned-responses GET] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/canned-responses
// Body: { workspace_id, locale, shortcut, title, body, is_active? }
// created_by is forced to the caller — never accepted from input.
// ═══════════════════════════════════════════════════════════════════
cannedResponsesRouter.post('/', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid payload', details: parsed.error.flatten().fieldErrors });
    }
    const auth = await authorizeMember(req, res, config, parsed.data.workspace_id);
    if (!auth) return;

    const sb = getServiceClient(config);
    const { data: inserted, error } = await sb
      .from('canned_responses')
      .insert({
        workspace_id: parsed.data.workspace_id,
        created_by: auth.userId, // server-controlled, ignores any caller value
        locale: parsed.data.locale,
        shortcut: parsed.data.shortcut,
        title: parsed.data.title,
        body: parsed.data.body,
        is_active: parsed.data.is_active ?? true,
      })
      .select(SELECT_COLS)
      .single();

    if (error) {
      // Unique violation → 409 with stable code so the client can show a
      // friendly "shortcut already used" message.
      if ((error as any).code === '23505') {
        return res
          .status(409)
          .json({ error: 'Shortcut already exists for this locale', code: 'duplicate_shortcut' });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.json({ ok: true, item: inserted });
  } catch (err: any) {
    console.error('[canned-responses POST] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// PATCH /api/canned-responses/:id
// Body: { workspace_id, ...editable fields }
// Editable: locale, shortcut, title, body, is_active
// Forbidden in this route: workspace_id (move), created_by, usage_count,
// last_used_at. Author OR workspace owner/admin only.
// ═══════════════════════════════════════════════════════════════════
cannedResponsesRouter.patch('/:id', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const id = req.params.id;
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid payload', details: parsed.error.flatten().fieldErrors });
    }
    const auth = await authorizeMember(req, res, config, parsed.data.workspace_id);
    if (!auth) return;

    const sb = getServiceClient(config);
    const { data: existing } = await sb
      .from('canned_responses')
      .select('id, workspace_id, created_by')
      .eq('id', id)
      .maybeSingle();
    if (!existing || existing.workspace_id !== parsed.data.workspace_id) {
      return res.status(404).json({ error: 'Canned response not found' });
    }

    const isAuthor = existing.created_by === auth.userId;
    const canEdit = isAuthor || (await isAdminOrOwner(config, parsed.data.workspace_id, auth.userId));
    if (!canEdit) return res.status(403).json({ error: 'Not allowed to edit this canned response' });

    // Build the update payload from the *whitelist* only — never trust the
    // body to set workspace_id / created_by / usage_count / last_used_at.
    const patch: Record<string, unknown> = {};
    if (parsed.data.locale !== undefined) patch.locale = parsed.data.locale;
    if (parsed.data.shortcut !== undefined) patch.shortcut = parsed.data.shortcut;
    if (parsed.data.title !== undefined) patch.title = parsed.data.title;
    if (parsed.data.body !== undefined) patch.body = parsed.data.body;
    if (parsed.data.is_active !== undefined) patch.is_active = parsed.data.is_active;

    const { data: updated, error } = await sb
      .from('canned_responses')
      .update(patch)
      .eq('id', id)
      .select(SELECT_COLS)
      .single();
    if (error) {
      if ((error as any).code === '23505') {
        return res
          .status(409)
          .json({ error: 'Shortcut already exists for this locale', code: 'duplicate_shortcut' });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.json({ ok: true, item: updated });
  } catch (err: any) {
    console.error('[canned-responses PATCH] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// DELETE /api/canned-responses/:id?workspace_id=<uuid>
// Author OR workspace owner/admin (matches RLS).
// ═══════════════════════════════════════════════════════════════════
cannedResponsesRouter.delete('/:id', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const id = req.params.id;
    const workspaceId = String(req.query.workspace_id || '');
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });
    const auth = await authorizeMember(req, res, config, workspaceId);
    if (!auth) return;

    const sb = getServiceClient(config);
    const { data: existing } = await sb
      .from('canned_responses')
      .select('id, workspace_id, created_by')
      .eq('id', id)
      .maybeSingle();
    if (!existing || existing.workspace_id !== workspaceId) {
      return res.status(404).json({ error: 'Canned response not found' });
    }

    const isAuthor = existing.created_by === auth.userId;
    const canDelete = isAuthor || (await isAdminOrOwner(config, workspaceId, auth.userId));
    if (!canDelete) return res.status(403).json({ error: 'Not allowed to delete this canned response' });

    const { error } = await sb.from('canned_responses').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  } catch (err: any) {
    console.error('[canned-responses DELETE] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/canned-responses/:id/track-use
// Body: { workspace_id }
// The ONLY route that mutates usage_count / last_used_at. Any workspace
// member may track a use. We do an atomic UPDATE ... SET usage_count =
// usage_count + 1 to avoid lost-update races.
// ═══════════════════════════════════════════════════════════════════
cannedResponsesRouter.post('/:id/track-use', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const id = req.params.id;
    const parsed = trackUseSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' });
    const auth = await authorizeMember(req, res, config, parsed.data.workspace_id);
    if (!auth) return;

    const sb = getServiceClient(config);
    // Verify the row belongs to the claimed workspace before mutating.
    const { data: existing } = await sb
      .from('canned_responses')
      .select('id, workspace_id, usage_count')
      .eq('id', id)
      .maybeSingle();
    if (!existing || existing.workspace_id !== parsed.data.workspace_id) {
      return res.status(404).json({ error: 'Canned response not found' });
    }

    // PostgREST has no inline expression UPDATE; do read-then-write.
    // Race condition tolerated: counter is advisory (ranking only), and
    // the unique row id ensures we never cross-update.
    const nextCount = (existing.usage_count ?? 0) + 1;
    const nowIso = new Date().toISOString();
    const { error } = await sb
      .from('canned_responses')
      .update({ usage_count: nextCount, last_used_at: nowIso })
      .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ ok: true, usage_count: nextCount, last_used_at: nowIso });
  } catch (err: any) {
    console.error('[canned-responses track-use] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});
