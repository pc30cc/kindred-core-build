/**
 * ACCOUNT ROUTES — self-service for the currently authenticated user.
 *
 * Auth: Supabase access token (Bearer) — verified via service client.
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

export const accountRouter = Router();

// ── Auth middleware ───────────────────────────────────────────────
async function requireUser(req: any, res: any, next: any) {
  const config: ServerConfig = req.serverConfig;
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization' });
  }
  const token = authHeader.slice(7);
  const sb = getServiceClient(config);
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  req.authUser = data.user;
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

    // Phone is on auth.users — propagate via admin API
    if (parsed.data.phone !== undefined) {
      const { error: authErr } = await sb.auth.admin.updateUserById(user.id, {
        phone: parsed.data.phone || undefined,
      });
      if (authErr) {
        return res.status(400).json({ error: authErr.message });
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
// Verifies current password by attempting a password sign-in, then updates.
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

    // Re-auth with a throwaway anon client (does not affect current session)
    const { createClient } = await import('@supabase/supabase-js');
    const verifier = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInErr } = await verifier.auth.signInWithPassword({
      email: user.email,
      password: parsed.data.currentPassword,
    });
    if (signInErr) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const sb = getServiceClient(config);
    const { error: updErr } = await sb.auth.admin.updateUserById(user.id, {
      password: parsed.data.newPassword,
    });
    if (updErr) {
      return res.status(500).json({ error: updErr.message });
    }

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to change password' });
  }
});