/**
 * AUTH EMAIL ROUTES — sends auth-related emails through configured provider
 * Replaces Supabase's built-in auth emails with the self-hosted email system.
 * Uses auth_verify_tokens and auth_reset_tokens tables.
 */

import { Router } from 'express';
import crypto from 'crypto';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { sendEmail } from '../services/email/index.js';

export const authEmailRouter = Router();

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return crypto.randomUUID();
}

/**
 * POST /api/auth-email/send-verification
 * Generate a verification token and send email via configured provider.
 */
authEmailRouter.post('/send-verification', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const { email, locale } = req.body;

    if (!email) return res.status(400).json({ error: 'email is required' });

    const sb = getServiceClient(config);

    // Find user by email
    const { data: userData, error: userError } = await sb.auth.admin.getUserByEmail(email);
    if (userError || !userData?.user) {
      // Don't reveal if user exists
      return res.json({ success: true });
    }

    const userId = userData.user.id;

    // Revoke any existing unused tokens for this user
    await sb.from('auth_verify_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', userId)
      .is('used_at', null)
      .is('revoked_at', null);

    // Generate new token
    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h

    await sb.from('auth_verify_tokens').insert({
      user_id: userId,
      email,
      token_hash: tokenHash,
      expires_at: expiresAt,
      ip_address: req.ip || null,
    });

    // Get app base URL from platform_domains or env
    const { data: domains } = await sb.from('platform_domains').select('app_base_url').limit(1).maybeSingle();
    const appBaseUrl = domains?.app_base_url || process.env.APP_BASE_URL || config.corsOrigins[0] || 'http://localhost:5173';
    const verifyUrl = `${appBaseUrl}/auth/email-confirmed?token=${rawToken}`;

    // Get workspace ID for email (use first workspace or null for platform-level)
    const { data: wsData } = await sb.from('workspaces').select('id').limit(1).maybeSingle();
    const workspaceId = wsData?.id || '00000000-0000-0000-0000-000000000000';

    // Send via configured email provider
    const result = await sendEmail(config, {
      workspaceId,
      to: email,
      templateSlug: 'email_verify',
      templateData: {
        name: userData.user.user_metadata?.full_name || email.split('@')[0],
        brand: 'Platform',
        action_url: verifyUrl,
        email,
      },
      locale: locale || 'en',
    });

    if (!result.success) {
      console.error('[auth-email] Failed to send verification:', result.error);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[auth-email] send-verification error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /api/auth-email/verify-email
 * Verify token and confirm user's email.
 */
authEmailRouter.post('/verify-email', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const { token } = req.body;

    if (!token) return res.status(400).json({ error: 'token is required' });

    const tokenHash = hashToken(token);
    const sb = getServiceClient(config);

    // Find valid token
    const { data: tokenData, error: tokenError } = await sb
      .from('auth_verify_tokens')
      .select('*')
      .eq('token_hash', tokenHash)
      .is('used_at', null)
      .is('revoked_at', null)
      .maybeSingle();

    if (tokenError || !tokenData) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    // Check expiry
    if (new Date(tokenData.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Token has expired' });
    }

    // Confirm user's email via admin API
    const { error: updateError } = await sb.auth.admin.updateUserById(tokenData.user_id, {
      email_confirm: true,
    });

    if (updateError) {
      console.error('[auth-email] Failed to confirm user:', updateError);
      return res.status(500).json({ error: 'Failed to confirm email' });
    }

    // Mark token as used
    await sb.from('auth_verify_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('id', tokenData.id);

    return res.json({ success: true, email: tokenData.email });
  } catch (err) {
    console.error('[auth-email] verify-email error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /api/auth-email/send-reset
 * Generate a password reset token and send email via configured provider.
 */
authEmailRouter.post('/send-reset', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const { email, locale } = req.body;

    if (!email) return res.status(400).json({ error: 'email is required' });

    const sb = getServiceClient(config);

    const { data: userData, error: userError } = await sb.auth.admin.getUserByEmail(email);
    if (userError || !userData?.user) {
      // Don't reveal if user exists
      return res.json({ success: true });
    }

    const userId = userData.user.id;

    // Revoke existing unused reset tokens
    await sb.from('auth_reset_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', userId)
      .is('used_at', null)
      .is('revoked_at', null);

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h

    await sb.from('auth_reset_tokens').insert({
      user_id: userId,
      email,
      token_hash: tokenHash,
      expires_at: expiresAt,
      ip_address: req.ip || null,
    });

    const { data: domains } = await sb.from('platform_domains').select('app_base_url').limit(1).maybeSingle();
    const appBaseUrl = domains?.app_base_url || process.env.APP_BASE_URL || config.corsOrigins[0] || 'http://localhost:5173';
    const resetUrl = `${appBaseUrl}/auth/reset-password?token=${rawToken}`;

    const { data: wsData } = await sb.from('workspaces').select('id').limit(1).maybeSingle();
    const workspaceId = wsData?.id || '00000000-0000-0000-0000-000000000000';

    const result = await sendEmail(config, {
      workspaceId,
      to: email,
      templateSlug: 'password_reset',
      templateData: {
        name: userData.user.user_metadata?.full_name || email.split('@')[0],
        brand: 'Platform',
        action_url: resetUrl,
        email,
      },
      locale: locale || 'en',
    });

    if (!result.success) {
      console.error('[auth-email] Failed to send reset:', result.error);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[auth-email] send-reset error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /api/auth-email/reset-password
 * Validate reset token and update user's password.
 */
authEmailRouter.post('/reset-password', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ error: 'token and newPassword are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const tokenHash = hashToken(token);
    const sb = getServiceClient(config);

    const { data: tokenData, error: tokenError } = await sb
      .from('auth_reset_tokens')
      .select('*')
      .eq('token_hash', tokenHash)
      .is('used_at', null)
      .is('revoked_at', null)
      .maybeSingle();

    if (tokenError || !tokenData) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    if (new Date(tokenData.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Token has expired' });
    }

    // Update password via admin API
    const { error: updateError } = await sb.auth.admin.updateUserById(tokenData.user_id, {
      password: newPassword,
    });

    if (updateError) {
      console.error('[auth-email] Failed to reset password:', updateError);
      return res.status(500).json({ error: 'Failed to reset password' });
    }

    // Mark token as used
    await sb.from('auth_reset_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('id', tokenData.id);

    return res.json({ success: true });
  } catch (err) {
    console.error('[auth-email] reset-password error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /api/auth-email/resend-verification
 * Resend verification email for a user.
 */
authEmailRouter.post('/resend-verification', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const { email, locale } = req.body;

    if (!email) return res.status(400).json({ error: 'email is required' });

    const sb = getServiceClient(config);

    const { data: userData } = await sb.auth.admin.getUserByEmail(email);
    if (!userData?.user) {
      return res.json({ success: true }); // Don't reveal
    }

    // Check if already confirmed
    if (userData.user.email_confirmed_at) {
      return res.json({ success: true, already_confirmed: true });
    }

    // Forward to send-verification logic
    // Revoke old tokens
    await sb.from('auth_verify_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', userData.user.id)
      .is('used_at', null)
      .is('revoked_at', null);

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await sb.from('auth_verify_tokens').insert({
      user_id: userData.user.id,
      email,
      token_hash: tokenHash,
      expires_at: expiresAt,
      ip_address: req.ip || null,
    });

    const { data: domains } = await sb.from('platform_domains').select('app_base_url').limit(1).maybeSingle();
    const appBaseUrl = domains?.app_base_url || process.env.APP_BASE_URL || config.corsOrigins[0] || 'http://localhost:5173';
    const verifyUrl = `${appBaseUrl}/auth/email-confirmed?token=${rawToken}`;

    const { data: wsData } = await sb.from('workspaces').select('id').limit(1).maybeSingle();
    const workspaceId = wsData?.id || '00000000-0000-0000-0000-000000000000';

    await sendEmail(config, {
      workspaceId,
      to: email,
      templateSlug: 'email_verify',
      templateData: {
        name: userData.user.user_metadata?.full_name || email.split('@')[0],
        brand: 'Platform',
        action_url: verifyUrl,
        email,
      },
      locale: locale || 'en',
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('[auth-email] resend-verification error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});
