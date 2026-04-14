// ============================================
// ADMIN USER & ROLE MANAGEMENT — self-hosted backend only
// All admin operations use the service role key server-side.
// NO Edge Functions in this path.
// ============================================

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import type { ServerConfig } from '../config.js';

export const adminRouter = Router();

/**
 * Middleware: verify caller is authenticated admin.
 * Accepts the user's JWT via Authorization header.
 */
async function requireAdmin(req: any, res: any, next: any) {
  const config: ServerConfig = req.serverConfig;
  const supabaseAdmin = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No authorization header' });

  // Create a client with the caller's JWT to identify them
  const callerClient = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user: caller } } = await callerClient.auth.getUser();
  if (!caller) return res.status(401).json({ error: 'Not authenticated' });

  // Check admin role via security definer function
  const { data: hasAdmin } = await supabaseAdmin.rpc('has_role', {
    _user_id: caller.id,
    _role: 'admin',
  });
  if (!hasAdmin) return res.status(403).json({ error: 'Insufficient permissions' });

  // Attach admin client to request
  req.supabaseAdmin = supabaseAdmin;
  req.callerId = caller.id;
  next();
}

adminRouter.use(requireAdmin);

// ─── List Users ──────────────────────────────────────────────────
adminRouter.post('/users/list', async (req, res) => {
  try {
    const { page = 1, perPage = 100 } = req.body;
    const admin = (req as any).supabaseAdmin;
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    res.json({
      users: data.users.map((u: any) => ({
        id: u.id,
        email: u.email,
        phone: u.phone,
        banned_until: u.banned_until,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
        email_confirmed_at: u.email_confirmed_at,
        phone_confirmed_at: u.phone_confirmed_at,
        user_metadata: u.user_metadata,
      })),
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Create User ─────────────────────────────────────────────────
adminRouter.post('/users/create', async (req, res) => {
  try {
    const { email, password, fullName, emailConfirm } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
    const admin = (req as any).supabaseAdmin;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: emailConfirm ?? true,
      user_metadata: { full_name: fullName || '' },
    });
    if (error) throw error;
    res.json({ success: true, user: { id: data.user.id, email: data.user.email } });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Reset Password (generate link) ─────────────────────────────
adminRouter.post('/users/reset-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    const admin = (req as any).supabaseAdmin;
    const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email });
    if (error) throw error;
    res.json({ success: true, link: data?.properties?.action_link });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Update Password ────────────────────────────────────────────
adminRouter.post('/users/update-password', async (req, res) => {
  try {
    const { userId, password } = req.body;
    if (!userId || !password) return res.status(400).json({ error: 'userId and password are required' });
    const admin = (req as any).supabaseAdmin;
    const { error } = await admin.auth.admin.updateUserById(userId, { password });
    if (error) throw error;
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Disable/Enable User ────────────────────────────────────────
adminRouter.post('/users/toggle-disable', async (req, res) => {
  try {
    const { userId, disable } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const admin = (req as any).supabaseAdmin;
    const { error } = await admin.auth.admin.updateUserById(userId, {
      ban_duration: disable ? '876000h' : 'none',
    });
    if (error) throw error;
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Confirm Email ──────────────────────────────────────────────
adminRouter.post('/users/confirm-email', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const admin = (req as any).supabaseAdmin;
    const { error } = await admin.auth.admin.updateUserById(userId, { email_confirm: true });
    if (error) throw error;
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Delete User ────────────────────────────────────────────────
adminRouter.post('/users/delete', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const admin = (req as any).supabaseAdmin;
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Assign Role ────────────────────────────────────────────────
adminRouter.post('/roles/assign', async (req, res) => {
  try {
    const { userId, role } = req.body;
    if (!userId || !role) return res.status(400).json({ error: 'userId and role are required' });
    const admin = (req as any).supabaseAdmin;
    const { error } = await admin.from('user_roles')
      .upsert({ user_id: userId, role }, { onConflict: 'user_id,role' });
    if (error) throw error;
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Remove Role ────────────────────────────────────────────────
adminRouter.post('/roles/remove', async (req, res) => {
  try {
    const { userId, role, roleId } = req.body;
    const admin = (req as any).supabaseAdmin;
    let query = admin.from('user_roles').delete();
    if (roleId) {
      query = query.eq('id', roleId);
    } else if (userId && role) {
      query = query.eq('user_id', userId).eq('role', role);
    } else {
      return res.status(400).json({ error: 'roleId or (userId + role) required' });
    }
    const { error } = await query;
    if (error) throw error;
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── List All Roles ─────────────────────────────────────────────
adminRouter.get('/roles/list', async (req, res) => {
  try {
    const admin = (req as any).supabaseAdmin;
    const { data, error } = await admin.from('user_roles').select('*').order('role');
    if (error) throw error;
    res.json({ roles: data });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
