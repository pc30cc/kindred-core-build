/**
 * ACCOUNT ROUTES — self-service for the currently authenticated user.
 *
 * Auth: first-party session cookie (server/lib/workspaceAuth.ts).
 * Storage: avatars are uploaded through the active workspace storage
 *   provider (BunnyCDN / S3 / local) using the existing storage service,
 *   so secrets never reach the browser.
 * Object key convention: `avatars/<userId>/<timestamp>-<rand>.<ext>`
 *
 * Backward compatibility: this router is purely additive; existing
 * profile reads via Supabase RLS continue to work.
 */

import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { uploadFile, deleteFile } from '../services/storage/index.js';
import { resolveVisitorGeo } from '../services/geo/index.js';
import { hashIp, maskIp } from '../utils/clientIp.js';
import { issueVerificationEmail } from '../services/auth-email.js';
import { requireUser as requireSessionUser } from '../lib/workspaceAuth.js';
import { findIdentityById } from '../services/auth/identity.js';
import { hashPassword, verifyPassword, InvalidPasswordError } from '../services/auth/password.js';
import { SESSION_COOKIE_NAME, validateSessionToken, revokeSession, revokeAllSessions, listActiveSessions } from '../services/auth/sessions.js';

export const accountRouter = Router();

// ── Auth middleware ───────────────────────────────────────────────
// Builds a `req.authUser` shaped like the old Supabase Auth user object
// (id/email/phone/email_confirmed_at/user_metadata.full_name) so downstream
// handlers below didn't need individual rewrites — but every field now
// comes from `profiles`/`user_credentials`, not `auth.users`.
async function requireUser(req: any, res: any, next: any) {
  const config: ServerConfig = req.serverConfig;
  const userId = await requireSessionUser(req, res);
  if (!userId) return;
  const identity = await findIdentityById(config, userId);
  if (!identity) {
    return res.status(401).json({ error: 'Account not found' });
  }
  req.authUser = {
    id: identity.id,
    email: identity.email,
    phone: identity.phone,
    email_confirmed_at: identity.emailVerifiedAt,
    created_at: identity.createdAt,
    user_metadata: { full_name: identity.fullName },
  };
  // Cheap second read of the already-validated cookie to expose the
  // first-party sessionId to route handlers (Active Sessions UI) without
  // widening requireSessionUser's return type for its ~15 other callers.
  // Never re-derived from a JWT payload — this is the same server-side
  // validateSessionToken() every other authenticated route already trusts.
  const session = await validateSessionToken(config, req.cookies?.[SESSION_COOKIE_NAME]);
  req.currentSessionId = session?.sessionId ?? null;
  next();
}

accountRouter.use(requireUser);

// ── Helper: get user's primary workspace for storage scoping ──────
async function getUserPrimaryWorkspaceId(config: ServerConfig, userId: string): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('workspace_members')
    .select('workspace_id, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.workspace_id ?? null;
}

// ── GET /api/account/me ───────────────────────────────────────────
accountRouter.get('/me', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const user = (req as any).authUser;
    const sb = getServiceClient(config);

    const { data: profile } = await sb
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    return res.json({
      id: user.id,
      email: user.email,
      email_confirmed_at: user.email_confirmed_at ?? null,
      phone: user.phone ?? null,
      created_at: user.created_at,
      profile: profile ?? null,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to load account' });
  }
});

// ── PATCH /api/account/me ─────────────────────────────────────────
const updateProfileSchema = z.object({
  full_name: z.string().trim().max(120).nullable().optional(),
  first_name: z.string().trim().max(60).optional(),
  last_name: z.string().trim().max(60).optional(),
  preferred_locale: z.string().trim().min(2).max(10).nullable().optional(),
  company_name: z.string().trim().max(120).nullable().optional(),
  website_domain: z.string().trim().max(255).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
});

accountRouter.patch('/me', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const user = (req as any).authUser;
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten().fieldErrors });
    }
    const sb = getServiceClient(config);

    // Compose full_name from first/last if provided explicitly
    const updates: Record<string, unknown> = {};
    if (parsed.data.first_name !== undefined || parsed.data.last_name !== undefined) {
      const first = (parsed.data.first_name ?? '').trim();
      const last = (parsed.data.last_name ?? '').trim();
      const combined = [first, last].filter(Boolean).join(' ').trim();
      if (combined) updates.full_name = combined;
    }
    for (const k of ['full_name', 'preferred_locale', 'company_name', 'website_domain'] as const) {
      if (parsed.data[k] !== undefined) updates[k] = parsed.data[k];
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      const { error: profileErr } = await sb
        .from('profiles')
        .update(updates)
        .eq('id', user.id);
      if (profileErr) {
        return res.status(500).json({ error: profileErr.message });
      }
    }

    if (parsed.data.phone !== undefined) {
      const { error: phoneErr } = await sb
        .from('profiles')
        .update({ phone: parsed.data.phone || null })
        .eq('id', user.id);
      if (phoneErr) {
        return res.status(400).json({ error: phoneErr.message });
      }
    }

    const { data: profile } = await sb
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    return res.json({ success: true, profile });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to update profile' });
  }
});

// ── POST /api/account/avatar ──────────────────────────────────────
const avatarSchema = z.object({
  data: z.string().min(10), // base64
  contentType: z.string().regex(/^image\/(png|jpe?g|webp|gif)$/i),
  fileName: z.string().max(160).optional(),
});

function extFromContentType(ct: string): string {
  const m = ct.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'jpg';
}

async function ensureProfileRow(config: ServerConfig, user: any) {
  const sb = getServiceClient(config);
  const { data: profile, error } = await sb
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load profile row: ${error.message}`);
  }

  if (profile) return profile;

  const seed = {
    id: user.id,
    email: user.email ?? '',
    full_name: (user.user_metadata?.full_name as string | undefined)?.trim() || null,
    avatar_url: null,
    updated_at: new Date().toISOString(),
  };

  const { data: inserted, error: insertError } = await sb
    .from('profiles')
    .upsert(seed, { onConflict: 'id' })
    .select('*')
    .maybeSingle();

  if (insertError) {
    throw new Error(`Failed to create profile row: ${insertError.message}`);
  }

  if (!inserted) {
    throw new Error('Profile row could not be created');
  }

  return inserted;
}

accountRouter.post('/avatar', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const user = (req as any).authUser;
    const parsed = avatarSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten().fieldErrors });
    }

    const buffer = Buffer.from(parsed.data.data, 'base64');
    if (buffer.length === 0) {
      return res.status(400).json({ error: 'Empty file' });
    }
    if (buffer.length > 10 * 1024 * 1024) {
      return res.status(413).json({ error: 'Avatar must be smaller than 10 MB' });
    }

    const workspaceId = await getUserPrimaryWorkspaceId(config, user.id);
    if (!workspaceId) {
      return res.status(400).json({ error: 'No workspace available for storage routing' });
    }

    const existingProfile = await ensureProfileRow(config, user);

    const ext = extFromContentType(parsed.data.contentType);
    const fileKey = `avatars/${user.id}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;

    const result = await uploadFile(config, {
      workspaceId,
      fileKey,
      data: buffer,
      contentType: parsed.data.contentType,
    });

    if (!result.success || !result.url) {
      return res.status(500).json({ error: result.error || 'Upload failed' });
    }

    const sb = getServiceClient(config);

    const prev = existingProfile?.avatar_url;
    if (prev && typeof prev === 'string') {
      const marker = `/avatars/${user.id}/`;
      const idx = prev.indexOf(marker);
      if (idx >= 0) {
        const oldKey = prev.slice(idx + 1); // strip leading slash
        if (oldKey && oldKey !== fileKey) {
          await deleteFile(config, workspaceId, oldKey).catch(() => undefined);
        }
      }
    }

    const { data: savedProfile, error: saveError } = await sb
      .from('profiles')
      .update({ avatar_url: result.url, updated_at: new Date().toISOString() })
      .eq('id', user.id)
      .select('id, avatar_url')
      .maybeSingle();

    if (saveError) {
      console.error('[account] avatar persistence error:', saveError.message, { userId: user.id, fileKey, url: result.url });
      return res.status(500).json({ error: 'Avatar uploaded but profile update failed' });
    }

    if (!savedProfile?.id || !savedProfile.avatar_url) {
      console.error('[account] avatar persistence missing row:', { userId: user.id, fileKey, url: result.url });
      return res.status(500).json({ error: 'Avatar uploaded but profile row was not updated' });
    }

    return res.json({
      success: true,
      url: savedProfile.avatar_url,
      fileKey: result.fileKey,
      provider: 'resolved',
    });
  } catch (err: any) {
    console.error('[account] avatar upload error:', err);
    return res.status(500).json({ error: err?.message || 'Avatar upload failed' });
  }
});

// ── DELETE /api/account/avatar ────────────────────────────────────
accountRouter.delete('/avatar', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const user = (req as any).authUser;
    const sb = getServiceClient(config);

    const workspaceId = await getUserPrimaryWorkspaceId(config, user.id);
    const { data: prevProfile } = await sb
      .from('profiles')
      .select('avatar_url')
      .eq('id', user.id)
      .maybeSingle();

    const prev = prevProfile?.avatar_url;
    if (prev && workspaceId && typeof prev === 'string') {
      const marker = `/avatars/${user.id}/`;
      const idx = prev.indexOf(marker);
      if (idx >= 0) {
        const oldKey = prev.slice(idx + 1);
        if (oldKey) await deleteFile(config, workspaceId, oldKey).catch(() => undefined);
      }
    }

    await sb
      .from('profiles')
      .update({ avatar_url: null, updated_at: new Date().toISOString() })
      .eq('id', user.id);

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to remove avatar' });
  }
});

// ── POST /api/account/change-password ─────────────────────────────
// Verifies the current password against the stored Argon2id hash, then
// writes the new one. First-party — no Supabase Auth involved.
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(255),
  newPassword: z.string().min(8).max(255),
});

accountRouter.post('/change-password', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const user = (req as any).authUser;
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    if (!user.email) {
      return res.status(400).json({ error: 'Account has no email' });
    }

    const sb = getServiceClient(config);
    const { data: cred, error: credErr } = await sb
      .from('user_credentials')
      .select('password_hash')
      .eq('user_id', user.id)
      .maybeSingle();
    if (credErr) {
      return res.status(500).json({ error: credErr.message });
    }
    if (!cred?.password_hash || !(await verifyPassword(cred.password_hash, parsed.data.currentPassword))) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    let newHash: string;
    try {
      newHash = await hashPassword(parsed.data.newPassword);
    } catch (err) {
      if (err instanceof InvalidPasswordError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    const { error: updErr } = await sb
      .from('user_credentials')
      .update({ password_hash: newHash, password_algo: 'argon2id', password_set_at: new Date().toISOString() })
      .eq('user_id', user.id);
    if (updErr) {
      return res.status(500).json({ error: updErr.message });
    }

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to change password' });
  }
});

// ── POST /api/account/resend-verification ─────────────────────────
// Authenticated re-send of the account verification email.
//
// Unlike the public /api/auth-email/resend-verification endpoint (which must
// stay enumeration-safe and therefore always answers 200), this route knows
// exactly who is asking, so it can report the REAL outcome back to the UI:
//   - 200 { sent: true }            → the self-hosted email provider accepted it
//   - 200 { already_verified: true }→ nothing to do
//   - 429 { retry_after_seconds }   → server-side cooldown, still pending
//   - 502 { error: 'email_send_failed' } → provider rejected / not configured
//
// Delivery goes through the same self-hosted registry as signup
// (services/auth-email.ts → services/email → the active email provider),
// so no Supabase built-in mail is involved.
const RESEND_MIN_INTERVAL_MS = 60_000;

accountRouter.post('/resend-verification', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const user = (req as any).authUser;
    const email: string | undefined = user?.email;
    if (!email) return res.status(400).json({ error: 'Account has no email' });

    if (user?.user_metadata?.app_email_verified === true) {
      return res.json({ success: true, already_verified: true });
    }

    const sb = getServiceClient(config);

    // Server-side cooldown so the button cannot be spammed from any client.
    const { data: lastToken } = await sb
      .from('auth_verify_tokens')
      .select('created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastToken?.created_at) {
      const elapsed = Date.now() - new Date(lastToken.created_at).getTime();
      if (elapsed >= 0 && elapsed < RESEND_MIN_INTERVAL_MS) {
        return res.status(429).json({
          error: 'too_many_requests',
          retry_after_seconds: Math.ceil((RESEND_MIN_INTERVAL_MS - elapsed) / 1000),
        });
      }
    }

    const rawLocale = typeof req.body?.locale === 'string' ? req.body.locale : 'en';
    const locale = /^[a-zA-Z-]{2,5}$/.test(rawLocale) ? rawLocale : 'en';

    const result = await issueVerificationEmail(config, {
      userId: user.id,
      email,
      fullName: user?.user_metadata?.full_name || null,
      locale,
      ipAddress: (req as any).ip || null,
    });

    if (!result.success) {
      console.error('[account] resend-verification failed:', result.error);
      return res.status(502).json({ error: 'email_send_failed' });
    }

    return res.json({ success: true, sent: true, email });
  } catch (err: any) {
    console.error('[account] resend-verification error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to send verification email' });
  }
});

// ─── SECURITY: Active sessions + login history ───────────────────
//
// We read directly from Supabase's managed `auth.sessions` table via
// service-role; the JS SDK does not expose a list endpoint for it.
// `public.auth_sessions` columns this router reads via listActiveSessions():
//   id, created_at, expires_at, ip_address, user_agent — see
//   server/services/auth/sessions.ts for the full table shape.
//
// `login_attempts` (already in our schema) powers the recent login history.

function parseUserAgent(ua: string | null): { browser: string; os: string; device: string } {
  if (!ua) return { browser: 'Unknown', os: 'Unknown', device: 'Unknown' };
  const lower = ua.toLowerCase();
  let browser = 'Unknown';
  if (lower.includes('edg/')) browser = 'Edge';
  else if (lower.includes('chrome/') && !lower.includes('chromium')) browser = 'Chrome';
  else if (lower.includes('firefox/')) browser = 'Firefox';
  else if (lower.includes('safari/') && !lower.includes('chrome')) browser = 'Safari';
  else if (lower.includes('opera') || lower.includes('opr/')) browser = 'Opera';

  let os = 'Unknown';
  if (lower.includes('windows nt')) os = 'Windows';
  else if (lower.includes('mac os x') || lower.includes('macintosh')) os = 'macOS';
  else if (lower.includes('android')) os = 'Android';
  else if (lower.includes('iphone') || lower.includes('ipad') || lower.includes('ios')) os = 'iOS';
  else if (lower.includes('linux')) os = 'Linux';

  let device = 'Desktop';
  if (lower.includes('mobile') || lower.includes('iphone') || lower.includes('android')) device = 'Mobile';
  else if (lower.includes('tablet') || lower.includes('ipad')) device = 'Tablet';

  return { browser, os, device };
}

async function enrichIpForDisplay(config: ServerConfig, rawIp: string | null) {
  if (!rawIp) {
    return { ip_display: '', country: null as string | null, country_code: null as string | null, city: null as string | null, region: null as string | null };
  }
  try {
    const geo = await resolveVisitorGeo(config, null, {
      raw_ip: rawIp,
      ip_hash: hashIp(rawIp),
    });
    return {
      ip_display: maskIp(rawIp),
      country: geo.country,
      country_code: geo.country_code,
      city: geo.city,
      region: geo.region,
    };
  } catch {
    return { ip_display: maskIp(rawIp), country: null, country_code: null, city: null, region: null };
  }
}

/**
 * GET /api/account/security/sessions
 * Lists every active first-party session (`public.auth_sessions`, written
 * by createSession()) for the current user, enriched with parsed UA + geo
 * (best-effort). The current session id comes from the already-validated
 * gs_session cookie (req.currentSessionId, set by this router's own
 * requireUser middleware) — never from decoding a token payload.
 *
 * GoTrue-off closure: this used to describe/manage Supabase's own
 * `auth.sessions` (via account_list_auth_sessions), a table this app's
 * users never populate under first-party auth — the list was always empty
 * or stale. It's now backed by the actual session store `requireUser`
 * itself authenticates against.
 */
accountRouter.get('/security/sessions', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const user = (req as any).authUser;
    const currentSessionId: string | null = (req as any).currentSessionId ?? null;

    const rows = await listActiveSessions(config, user.id);

    const enriched = await Promise.all(rows.map(async (row) => {
      const ua = parseUserAgent(row.user_agent as string | null);
      const geo = await enrichIpForDisplay(config, row.ip_address as string | null);
      return {
        id: row.id,
        is_current: currentSessionId ? row.id === currentSessionId : false,
        created_at: row.created_at,
        // auth_sessions is a fixed-TTL, non-sliding session store (see
        // sessions.ts's design note) — there is no separate "last active"
        // timestamp to report, so this intentionally mirrors created_at
        // rather than fabricating one.
        last_active_at: row.created_at,
        not_after: row.expires_at,
        user_agent_raw: row.user_agent,
        browser: ua.browser,
        os: ua.os,
        device: ua.device,
        ip: geo.ip_display,
        country: geo.country,
        country_code: geo.country_code,
        city: geo.city,
        region: geo.region,
      };
    }));

    return res.json({ sessions: enriched, current_session_id: currentSessionId });
  } catch (err: any) {
    console.error('[account/security] sessions error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to load sessions' });
  }
});

/**
 * DELETE /api/account/security/sessions/:id
 * Revoke a single session by id (or `?all=1` to revoke every OTHER active
 * session, keeping the caller's own current one alive).
 *
 * IDOR guard: revokeSession() itself has no ownership check (by design —
 * it's a generic primitive also used by logout/password-reset/admin-action
 * flows with their own already-verified target), so this route loads the
 * target row first and rejects (404, not 403 — no existence leak) if it
 * doesn't belong to the caller, before ever calling revokeSession().
 */
accountRouter.delete('/security/sessions/:id', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const user = (req as any).authUser;
    const currentSessionId: string | null = (req as any).currentSessionId ?? null;
    const sessionId = String(req.params.id || '').trim();
    const all = req.query.all === '1' || req.query.all === 'true';

    if (!all && !sessionId) {
      return res.status(400).json({ error: 'Missing session id' });
    }

    if (all) {
      const revoked = await revokeAllSessions(config, user.id, 'logout', currentSessionId ?? undefined);
      return res.json({ success: true, revoked });
    }

    const sb = getServiceClient(config);
    const { data: target } = await sb
      .from('auth_sessions')
      .select('id, user_id')
      .eq('id', sessionId)
      .maybeSingle();
    if (!target || (target as any).user_id !== user.id) {
      return res.status(404).json({ error: 'Session not found' });
    }

    await revokeSession(config, sessionId, 'logout');
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[account/security] revoke error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to revoke session' });
  }
});

/**
 * GET /api/account/security/login-history
 * Returns the most recent login attempts (success + failure) from the
 * `login_attempts` table, scoped to the caller's email.
 */
accountRouter.get('/security/login-history', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const user = (req as any).authUser;
    if (!user.email) return res.json({ entries: [] });
    const sb = getServiceClient(config);

    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);

    const { data, error } = await sb
      .from('login_attempts')
      .select('id, email, ip_address, success, created_at')
      .eq('email', user.email.trim().toLowerCase())
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[account/security] login history error:', error.message);
      return res.status(500).json({ error: 'Failed to load login history' });
    }

    const entries = await Promise.all((data ?? []).map(async (row: any) => {
      const geo = await enrichIpForDisplay(config, row.ip_address);
      return {
        id: row.id,
        created_at: row.created_at,
        success: !!row.success,
        ip: geo.ip_display,
        country: geo.country,
        country_code: geo.country_code,
        city: geo.city,
        region: geo.region,
      };
    }));

    return res.json({ entries });
  } catch (err: any) {
    console.error('[account/security] login-history error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to load login history' });
  }
});

// ─── WORKSPACE ICON UPLOAD ──────────────────────────────────────
//
// Mirrors the avatar upload flow but writes to the workspace-scoped
// `branding/<workspaceId>/icon-...` key and persists the resulting URL
// to `workspace_branding.logo_url`. Caller must be a member of the
// workspace (any role) — verified by RLS via service-role lookup.

const workspaceIconSchema = z.object({
  workspaceId: z.string().uuid(),
  data: z.string().min(10),
  contentType: z.string().regex(/^image\/(png|jpe?g|webp|gif|svg\+xml)$/i),
  fileName: z.string().max(160).optional(),
});

async function userIsWorkspaceMember(config: ServerConfig, userId: string, workspaceId: string): Promise<boolean> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('workspace_members')
    .select('id')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  return !!data;
}

accountRouter.post('/workspace-icon', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const user = (req as any).authUser;
    const parsed = workspaceIconSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten().fieldErrors });
    }

    const { workspaceId, contentType } = parsed.data;
    if (!(await userIsWorkspaceMember(config, user.id, workspaceId))) {
      return res.status(403).json({ error: 'Not a member of this workspace' });
    }

    const buffer = Buffer.from(parsed.data.data, 'base64');
    if (buffer.length === 0) return res.status(400).json({ error: 'Empty file' });
    if (buffer.length > 5 * 1024 * 1024) {
      return res.status(413).json({ error: 'Icon must be smaller than 5 MB' });
    }

    const ext = extFromContentType(contentType);
    const fileKey = `branding/${workspaceId}/icon-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;

    const result = await uploadFile(config, {
      workspaceId,
      fileKey,
      data: buffer,
      contentType,
    });
    if (!result.success || !result.url) {
      return res.status(500).json({ error: result.error || 'Upload failed' });
    }

    const sb = getServiceClient(config);

    // Best-effort cleanup of the previous icon
    const { data: prevBranding } = await sb
      .from('workspace_branding')
      .select('logo_url')
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    const prev = prevBranding?.logo_url;
    if (prev && typeof prev === 'string') {
      const marker = `/branding/${workspaceId}/`;
      const idx = prev.indexOf(marker);
      if (idx >= 0) {
        const oldKey = prev.slice(idx + 1);
        if (oldKey && oldKey !== fileKey) {
          await deleteFile(config, workspaceId, oldKey).catch(() => undefined);
        }
      }
    }

    const { error: saveError } = await sb
      .from('workspace_branding')
      .update({ logo_url: result.url, updated_at: new Date().toISOString() })
      .eq('workspace_id', workspaceId);

    if (saveError) {
      console.error('[account] workspace icon persistence error:', saveError.message);
      return res.status(500).json({ error: 'Icon uploaded but workspace update failed' });
    }

    return res.json({ success: true, url: result.url, fileKey: result.fileKey });
  } catch (err: any) {
    console.error('[account] workspace icon upload error:', err);
    return res.status(500).json({ error: err?.message || 'Workspace icon upload failed' });
  }
});

accountRouter.delete('/workspace-icon', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const user = (req as any).authUser;
    const workspaceId = String(req.query.workspaceId || '').trim();
    if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
    if (!(await userIsWorkspaceMember(config, user.id, workspaceId))) {
      return res.status(403).json({ error: 'Not a member of this workspace' });
    }

    const sb = getServiceClient(config);
    const { data: prevBranding } = await sb
      .from('workspace_branding')
      .select('logo_url')
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    const prev = prevBranding?.logo_url;
    if (prev && typeof prev === 'string') {
      const marker = `/branding/${workspaceId}/`;
      const idx = prev.indexOf(marker);
      if (idx >= 0) {
        const oldKey = prev.slice(idx + 1);
        if (oldKey) await deleteFile(config, workspaceId, oldKey).catch(() => undefined);
      }
    }

    await sb
      .from('workspace_branding')
      .update({ logo_url: null, updated_at: new Date().toISOString() })
      .eq('workspace_id', workspaceId);

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to remove workspace icon' });
  }
});