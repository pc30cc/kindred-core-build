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
 *
 * Redemption is ATOMIC: `redeem_email_verify_token` (service_role-only,
 * database/migrations/030_atomic_auth_token_redemption.sql) claims the
 * token with a single conditional UPDATE ... WHERE used_at IS NULL ...
 * RETURNING and writes user_credentials.email_verified_at in the same
 * function call, so two simultaneous requests for the same raw token can
 * never both succeed — the old SELECT-then-UPDATE shape here let both
 * requests pass the "is it unused" check before either write landed.
 */
authEmailRouter.post('/verify-email', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const { token } = req.body;

    if (!token) return res.status(400).json({ error: 'token is required' });

    const tokenHash = hashToken(token);
    const sb = getServiceClient(config);

    const { data, error } = await sb.rpc('redeem_email_verify_token', { _token_hash: tokenHash });
    if (error) {
      console.error('[auth-email] redeem_email_verify_token error:', error);
      return res.status(500).json({ error: 'Failed to confirm email' });
    }

    const redeemed = Array.isArray(data) ? data[0] : data;
    if (!redeemed?.redeemed_user_id) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    return res.json({ success: true, email: redeemed.redeemed_email });
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
 *
 * Redemption is ATOMIC: `redeem_password_reset_token` (service_role-only,
 * database/migrations/030_atomic_auth_token_redemption.sql) claims the
 * token, writes the new hash, and revokes every existing session for that
 * user — all inside one function call/transaction — so two simultaneous
 * requests for the same raw token can never both succeed, and a failure
 * partway through can never leave the token "used" with no password
 * change or a password change with the old sessions still live. Identity
 * comes ONLY from the token row the function itself claims; this route
 * never passes a client-supplied user id into it.
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

    const { data, error } = await sb.rpc('redeem_password_reset_token', {
      _token_hash: tokenHash,
      _new_password_hash: passwordHash,
    });
    if (error) {
      console.error('[auth-email] redeem_password_reset_token error:', error);
      return res.status(500).json({ error: 'Failed to reset password' });
    }

    const redeemed = Array.isArray(data) ? data[0] : data;
    if (!redeemed?.redeemed_user_id) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    await logSecurityEvent(req, 'password_changed', 'info', {
      userId: redeemed.redeemed_user_id,
      revokedCount: redeemed.redeemed_sessions_revoked ?? 0,
    });

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
