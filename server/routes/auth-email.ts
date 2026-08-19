/**
 * AUTH EMAIL ROUTES — sends auth-related emails through configured provider
 * Uses auth_verify_tokens and auth_reset_tokens tables. First-party as of
 * the auth migration: `verify-email`/`reset-password` write directly to
 * `public.user_credentials` (Argon2id password hash, email_verified_at) —
 * `sb.auth.admin.updateUserById` / `auth.users` are not touched here.
 */

import { Router, type Response } from 'express';
import crypto from 'crypto';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { issueRecoveryEmail, issueVerificationEmail } from '../services/auth-email.js';
import { findIdentityByEmail } from '../services/auth/identity.js';
import { hashPassword, InvalidPasswordError } from '../services/auth/password.js';
import { revokeAllSessions } from '../services/auth/sessions.js';
import { logSecurityEvent } from '../middleware/security.js';

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

interface AuthLookupUser {
  id: string;
  email: string | null;
  emailConfirmedAt: string | null;
  fullName: string | null;
}

async function findAuthUserByEmail(config: ServerConfig, email: string): Promise<AuthLookupUser | null> {
  const identity = await findIdentityByEmail(config, email);
  if (!identity) return null;
  return {
    id: identity.id,
    email: identity.email,
    emailConfirmedAt: identity.emailVerifiedAt,
    fullName: identity.fullName,
  };
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

    // Mark the identity's email verified. Upsert so this also works for a
    // user_credentials row that doesn't exist yet (shouldn't happen for a
    // signup-issued token, but keeps this endpoint safe either way) without
    // ever touching password_hash/status on an existing row.
    const { error: updateError } = await sb
      .from('user_credentials')
      .upsert(
        { user_id: tokenData.user_id, email_verified_at: new Date().toISOString() },
        { onConflict: 'user_id' },
      );

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

    let passwordHash: string;
    try {
      passwordHash = await hashPassword(newPassword);
    } catch (err) {
      if (err instanceof InvalidPasswordError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
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

    // Write the new Argon2id hash. Upsert (not update) so this also serves as
    // the migrated-user "password setup" path — a pre-migration account with
    // no user_credentials row yet gets one created here, the same way
    // "forgot password" would for any first-party account.
    const { error: updateError } = await sb.from('user_credentials').upsert(
      {
        user_id: tokenData.user_id,
        password_hash: passwordHash,
        password_algo: 'argon2id',
        password_set_at: new Date().toISOString(),
        failed_login_count: 0,
      },
      { onConflict: 'user_id' },
    );

    if (updateError) {
      console.error('[auth-email] Failed to reset password:', updateError);
      return res.status(500).json({ error: 'Failed to reset password' });
    }

    // Mark token as used
    await sb.from('auth_reset_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('id', tokenData.id);

    // The old password (if any) must stop working everywhere immediately.
    const revokedCount = await revokeAllSessions(config, tokenData.user_id, 'password_reset');
    await logSecurityEvent(req, 'password_changed', 'info', { userId: tokenData.user_id, revokedCount });

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
