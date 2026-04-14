// ============================================
// AUTH EMAIL ROUTES — self-hosted backend
// These routes handle auth email flows (signup verification,
// password reset) through the self-hosted email system,
// bypassing Supabase's default auth emails.
// ============================================

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import type { ServerConfig } from '../config.js';
import { sendVerificationEmail, sendPasswordResetEmail, sendWelcomeEmail } from '../services/email/auth-sender.js';

export const authEmailRouter = Router();

/**
 * POST /api/auth-email/signup
 * Creates user with email_confirm=false (no Supabase default email),
 * then sends verification via self-hosted email service.
 */
authEmailRouter.post('/signup', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const { email, password, fullName, locale, redirectTo } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);

    // Create user WITHOUT auto-confirm (we handle verification ourselves)
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
      user_metadata: { full_name: fullName || '' },
    });

    if (error) {
      // If user already exists but unconfirmed, resend verification
      if (error.message?.includes('already been registered')) {
        const { data: existingUser } = await supabase.auth.admin.getUserByEmail(email) as any;
        if (existingUser?.user && !existingUser.user.email_confirmed_at) {
          // Resend verification
          const { data: branding } = await supabase
            .from('workspace_branding')
            .select('platform_name')
            .limit(1)
            .maybeSingle();
          const brandName = branding?.platform_name || 'Platform';
          await sendVerificationEmail(config, existingUser.user.id, email, locale || 'en', brandName);
          return res.json({ success: true, message: 'Verification email resent' });
        }
        return res.status(400).json({ error: error.message });
      }
      throw error;
    }

    // Get brand name for email
    const { data: branding } = await supabase
      .from('workspace_branding')
      .select('platform_name')
      .limit(1)
      .maybeSingle();
    const brandName = branding?.platform_name || 'Platform';

    // Send verification email through self-hosted system
    await sendVerificationEmail(config, data.user.id, email, locale || 'en', brandName);

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
 * Sends password reset email through self-hosted system.
 */
authEmailRouter.post('/reset-password', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const { email, locale } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);

    // Get brand name
    const { data: branding } = await supabase
      .from('workspace_branding')
      .select('platform_name')
      .limit(1)
      .maybeSingle();
    const brandName = branding?.platform_name || 'Platform';

    const result = await sendPasswordResetEmail(config, email, locale || 'en', brandName);

    // Always return success (don't leak user existence)
    res.json({ success: true });
  } catch (err: any) {
    console.error('[auth-email] Password reset error:', err);
    // Don't leak errors about user existence
    res.json({ success: true });
  }
});

/**
 * POST /api/auth-email/resend-verification
 * Resends verification email for unconfirmed user.
 */
authEmailRouter.post('/resend-verification', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const { email, locale } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);

    const { data: userData } = await supabase.auth.admin.getUserByEmail(email) as any;
    if (!userData?.user) {
      return res.json({ success: true }); // Don't leak
    }

    const { data: branding } = await supabase
      .from('workspace_branding')
      .select('platform_name')
      .limit(1)
      .maybeSingle();
    const brandName = branding?.platform_name || 'Platform';

    await sendVerificationEmail(config, userData.user.id, email, locale || 'en', brandName);

    res.json({ success: true });
  } catch (err: any) {
    console.error('[auth-email] Resend verification error:', err);
    res.json({ success: true });
  }
});
