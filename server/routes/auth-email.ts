// ============================================
// AUTH EMAIL ROUTES — self-hosted backend
// All identity resolved from config resolver.
// No hardcoded brand names.
// ============================================

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import type { ServerConfig } from '../config.js';
import { sendVerificationEmail, sendPasswordResetEmail } from '../services/email/auth-sender.js';

export const authEmailRouter = Router();

/**
 * POST /api/auth-email/signup
 */
authEmailRouter.post('/signup', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const { email, password, fullName, locale } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
      user_metadata: { full_name: fullName || '' },
    });

    if (error) {
      if (error.message?.includes('already been registered')) {
        const { data: { users } } = await supabase.auth.admin.listUsers();
        const existingUser = users.find((u: any) => u.email === email);
        if (existingUser && !existingUser.email_confirmed_at) {
          await sendVerificationEmail(config, existingUser.id, email, locale || 'en');
          return res.json({ success: true, message: 'Verification email resent' });
        }
        return res.status(400).json({ error: error.message });
      }
      throw error;
    }

    await sendVerificationEmail(config, data.user.id, email, locale || 'en');

    res.json({
      success: true,
      user: { id: data.user.id, email: data.user.email },
    });
  } catch (err: any) {
    console.error('[auth-email] Signup error:', err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/auth-email/reset-password
 */
authEmailRouter.post('/reset-password', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const { email, locale } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    await sendPasswordResetEmail(config, email, locale || 'en');
    res.json({ success: true });
  } catch (err: any) {
    console.error('[auth-email] Password reset error:', err);
    res.json({ success: true });
  }
});

/**
 * POST /api/auth-email/resend-verification
 */
authEmailRouter.post('/resend-verification', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const { email, locale } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    const { data: { users } } = await supabase.auth.admin.listUsers();
    const foundUser = users.find((u: any) => u.email === email);
    if (!foundUser) {
      return res.json({ success: true });
    }

    await sendVerificationEmail(config, foundUser.id, email, locale || 'en');
    res.json({ success: true });
  } catch (err: any) {
    console.error('[auth-email] Resend verification error:', err);
    res.json({ success: true });
  }
});
