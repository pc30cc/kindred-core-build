/**
 * AUTH EMAIL ROUTES — sends auth-related emails through configured provider
 * Replaces Supabase's built-in auth emails with the self-hosted email system.
 * Uses auth_verify_tokens and auth_reset_tokens tables.
 */

import { Router, type Response } from 'express';
import crypto from 'crypto';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { issueRecoveryEmail, issueVerificationEmail } from '../services/auth-email.js';

export const authEmailRouter = Router();

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getErrorMessage(error: unknown, fallback: string = 'Internal error'): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

function handleRouteError(res: Response, scope: string, error: unknown) {
  const message = getErrorMessage(error);
  console.error(scope, message, error);
  return res.status(500).json({ error: message });
}

function resolveUserFullName(userMetadata: unknown, fallback: string | null = null): string | null {
  if (userMetadata && typeof userMetadata === 'object') {
    const fullName = (userMetadata as Record<string, unknown>).full_name;
    if (typeof fullName === 'string' && fullName.trim()) return fullName.trim();
  }

  return fallback?.trim() || null;
}

interface AuthLookupUser {
  id: string;
  email: string | null;
  emailConfirmedAt: string | null;
  fullName: string | null;
}

async function findAuthUserByEmail(config: ServerConfig, email: string): Promise<AuthLookupUser | null> {
  const sb = getServiceClient(config);
  const normalizedEmail = email.trim().toLowerCase();

  const { data: profile, error: profileError } = await sb
    .from('profiles')
    .select('id, email, full_name')
    .eq('email', normalizedEmail)
    .maybeSingle();

  if (profileError) {
    throw new Error(`Failed to look up profile: ${profileError.message}`);
  }

  if (profile?.id) {
    const { data: authUserData, error: authUserError } = await sb.auth.admin.getUserById(profile.id);

    if (authUserError) {
      throw new Error(`Failed to load auth user: ${authUserError.message}`);
    }

    if (authUserData?.user) {
      return {
        id: authUserData.user.id,
        email: authUserData.user.email ?? profile.email ?? normalizedEmail,
        emailConfirmedAt: authUserData.user.email_confirmed_at ?? null,
        fullName: resolveUserFullName(authUserData.user.user_metadata, profile.full_name ?? null),
      };
    }
  }

  const perPage = 200;

  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage });

    if (error) {
      throw new Error(`Failed to search auth users: ${error.message}`);
    }

    const users = data?.users ?? [];
    const matchedUser = users.find((candidate) => candidate.email?.trim().toLowerCase() === normalizedEmail);

    if (matchedUser) {
      return {
        id: matchedUser.id,
        email: matchedUser.email ?? normalizedEmail,
        emailConfirmedAt: matchedUser.email_confirmed_at ?? null,
        fullName: resolveUserFullName(matchedUser.user_metadata, profile?.full_name ?? null),
      };
    }

    if (users.length < perPage) break;
  }

  return null;
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

    const authUser = await findAuthUserByEmail(config, email);
    if (!authUser) {
      // Don't reveal if user exists
      return res.json({ success: true });
    }

    const result = await issueVerificationEmail(config, {
      userId: authUser.id,
      email: authUser.email || email.trim().toLowerCase(),
      fullName: authUser.fullName,
      locale: locale || 'en',
      ipAddress: req.ip || null,
    });

    if (!result.success) {
      console.error('[auth-email] Failed to send verification:', result.error);
    }

    return res.json({ success: true });
  } catch (err) {
    return handleRouteError(res, '[auth-email] send-verification error:', err);
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

    // Confirm user's email via admin API + set metadata flag
    const { error: updateError } = await sb.auth.admin.updateUserById(tokenData.user_id, {
      email_confirm: true,
      user_metadata: { email_verified: true },
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
    return handleRouteError(res, '[auth-email] verify-email error:', err);
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

    const authUser = await findAuthUserByEmail(config, email);
    if (!authUser) {
      // Don't reveal if user exists
      return res.json({ success: true });
    }

    const result = await issueRecoveryEmail(config, {
      userId: authUser.id,
      email: authUser.email || email.trim().toLowerCase(),
      fullName: authUser.fullName,
      locale: locale || 'en',
    });

    if (!result.success) {
      console.error('[auth-email] Failed to send reset:', result.error);
    }

    return res.json({ success: true });
  } catch (err) {
    return handleRouteError(res, '[auth-email] send-reset error:', err);
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
    return handleRouteError(res, '[auth-email] reset-password error:', err);
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

    const authUser = await findAuthUserByEmail(config, email);
    if (!authUser) {
      return res.json({ success: true }); // Don't reveal
    }

    // Check if already confirmed
    if (authUser.emailConfirmedAt) {
      return res.json({ success: true, already_confirmed: true });
    }

    const result = await issueVerificationEmail(config, {
      userId: authUser.id,
      email: authUser.email || email.trim().toLowerCase(),
      fullName: authUser.fullName,
      locale: locale || 'en',
      ipAddress: req.ip || null,
    });

    if (!result.success) {
      console.error('[auth-email] Failed to resend verification:', result.error);
    }

    return res.json({ success: true });
  } catch (err) {
    return handleRouteError(res, '[auth-email] resend-verification error:', err);
  }
});
