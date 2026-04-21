/**
 * ADMIN USER MANAGEMENT ROUTES
 * Password reset, password change, block/unblock users.
 * All require global admin role verified via service client.
 */

import { Router } from 'express';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { z } from 'zod';
import { adminWidgetRouter } from './adminWidget.js';
import { adminWidgetTemplatesRouter } from './adminWidgetTemplates.js';

export const adminRouter = Router();

// Middleware: verify caller is a global admin
async function requireAdmin(req: any, res: any, next: any) {
  const config: ServerConfig = req.serverConfig;
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization' });
  }

  const token = authHeader.replace('Bearer ', '');
  const sb = getServiceClient(config);

  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Check admin role
  const { data: isAdmin } = await sb.rpc('has_role', {
    _user_id: user.id,
    _role: 'admin',
  });

  if (!isAdmin) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  (req as any).adminUser = user;
  next();
}

adminRouter.use(requireAdmin);

// Widget diagnostics (server-side URL test for super admin)
adminRouter.use('/widget', adminWidgetRouter);

// Widget templates registry (super admin only)
adminRouter.use('/widget/templates', adminWidgetTemplatesRouter);

// ─── Send Password Reset Link ────────────────────────────────────
const resetLinkSchema = z.object({
  email: z.string().email(),
});

adminRouter.post('/send-reset-link', async (req, res) => {
  try {
    const { email } = resetLinkSchema.parse(req.body);
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);

    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: `${config.corsOrigins[0] !== '*' ? config.corsOrigins[0] : 'http://localhost:5173'}/reset-password`,
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to send reset link' });
  }
});

// ─── Admin Change Password ───────────────────────────────────────
const changePasswordSchema = z.object({
  userId: z.string().uuid(),
  newPassword: z.string().min(8).max(255),
});

adminRouter.post('/change-password', async (req, res) => {
  try {
    const { userId, newPassword } = changePasswordSchema.parse(req.body);
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);

    const { error } = await sb.auth.admin.updateUserById(userId, {
      password: newPassword,
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to change password' });
  }
});

// ─── Block / Unblock User ────────────────────────────────────────
const blockSchema = z.object({
  userId: z.string().uuid(),
  blocked: z.boolean(),
});

adminRouter.post('/block-user', async (req, res) => {
  try {
    const { userId, blocked } = blockSchema.parse(req.body);
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);

    const { error } = await sb.auth.admin.updateUserById(userId, {
      ban_duration: blocked ? '876600h' : 'none', // ~100 years or unban
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, blocked });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to update user' });
  }
});

// ─── Get User Auth Status (banned, confirmed, etc.) ──────────────
const userStatusSchema = z.object({
  userId: z.string().uuid(),
});

adminRouter.post('/user-status', async (req, res) => {
  try {
    const { userId } = userStatusSchema.parse(req.body);
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);

    const { data: { user }, error } = await sb.auth.admin.getUserById(userId);

    if (error || !user) {
      return res.status(400).json({ error: error?.message || 'User not found' });
    }

    res.json({
      id: user.id,
      email: user.email,
      email_confirmed_at: user.email_confirmed_at,
      banned_until: user.banned_until,
      last_sign_in_at: user.last_sign_in_at,
      created_at: user.created_at,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to get user status' });
  }
});

// ─── Impersonate User (generate magic link) ──────────────────────
const impersonateSchema = z.object({
  userId: z.string().uuid(),
});

adminRouter.post('/impersonate', async (req, res) => {
  try {
    const { userId } = impersonateSchema.parse(req.body);
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);

    // Get user email
    const { data: { user }, error: userErr } = await sb.auth.admin.getUserById(userId);
    if (userErr || !user?.email) {
      return res.status(400).json({ error: userErr?.message || 'User not found' });
    }

    // Generate a magic link for the user
    const { data, error } = await sb.auth.admin.generateLink({
      type: 'magiclink',
      email: user.email,
    });

    if (error || !data) {
      return res.status(400).json({ error: error?.message || 'Failed to generate link' });
    }

    // Build the verification URL using the hashed_token
    const redirectBase = config.corsOrigins[0] !== '*' ? config.corsOrigins[0] : 'http://localhost:5173';
    const verifyUrl = `${config.supabaseUrl}/auth/v1/verify?token=${data.properties.hashed_token}&type=magiclink&redirect_to=${encodeURIComponent(redirectBase + '/app')}`;

    res.json({ url: verifyUrl });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to impersonate user' });
  }
});
