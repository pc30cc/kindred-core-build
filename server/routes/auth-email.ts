/**
 * AUTH EMAIL ROUTES — fully self-hosted auth flow
 * Handles signup, login, session (me/logout), verification, and password reset.
 * No browser-side Supabase auth dependency — backend is the source of truth.
 */

import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { issueRecoveryEmail, issueVerificationEmail } from '../services/auth-email.js';

export const authEmailRouter = Router();

// ─── Helpers ─────────────────────────────────────────────────────

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return crypto.randomUUID();
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

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Cookie settings
function setSessionCookie(res: Response, token: string) {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('app_session', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: SESSION_DURATION_MS,
    path: '/',
  });
}

function clearSessionCookie(res: Response) {
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie('app_session', {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
  });
}

function getSessionToken(req: Request): string | null {
  // Check cookie first, then Authorization header
  const cookieToken = req.cookies?.app_session;
  if (cookieToken) return cookieToken;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return null;
}

// ─── Session management ──────────────────────────────────────────

async function createSession(config: ServerConfig, userId: string, email: string, req: Request): Promise<string> {
  const sb = getServiceClient(config);
  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();

  await sb.from('auth_sessions').insert({
    user_id: userId,
    email,
    token_hash: tokenHash,
    expires_at: expiresAt,
    ip_address: req.ip || null,
    user_agent: req.headers['user-agent'] || null,
  });

  return rawToken;
}

async function resolveSession(config: ServerConfig, token: string) {
  const sb = getServiceClient(config);
  const tokenHash = hashToken(token);

  const { data: session, error } = await sb
    .from('auth_sessions')
    .select('*')
    .eq('token_hash', tokenHash)
    .is('revoked_at', null)
    .maybeSingle();

  if (error || !session) return null;

  // Check expiry
  if (new Date(session.expires_at) < new Date()) return null;

  return session;
}

// ─── User lookup ─────────────────────────────────────────────────

interface AuthLookupUser {
  id: string;
  email: string;
  emailConfirmedAt: string | null;
  fullName: string | null;
  userMetadata: Record<string, unknown>;
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
    if (authUserError) throw new Error(`Failed to load auth user: ${authUserError.message}`);

    if (authUserData?.user) {
      return {
        id: authUserData.user.id,
        email: authUserData.user.email ?? profile.email ?? normalizedEmail,
        emailConfirmedAt: authUserData.user.email_confirmed_at ?? null,
        fullName: resolveUserFullName(authUserData.user.user_metadata, profile.full_name ?? null),
        userMetadata: (authUserData.user.user_metadata as Record<string, unknown>) ?? {},
      };
    }
  }

  // Fallback: scan auth users
  const perPage = 200;
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Failed to search auth users: ${error.message}`);

    const users = data?.users ?? [];
    const matchedUser = users.find((c) => c.email?.trim().toLowerCase() === normalizedEmail);
    if (matchedUser) {
      return {
        id: matchedUser.id,
        email: matchedUser.email ?? normalizedEmail,
        emailConfirmedAt: matchedUser.email_confirmed_at ?? null,
        fullName: resolveUserFullName(matchedUser.user_metadata, profile?.full_name ?? null),
        userMetadata: (matchedUser.user_metadata as Record<string, unknown>) ?? {},
      };
    }
    if (users.length < perPage) break;
  }

  return null;
}

function mapUserForClient(authUser: AuthLookupUser) {
  return {
    id: authUser.id,
    email: authUser.email,
    emailVerified: !!(authUser.userMetadata?.app_email_verified),
    metadata: authUser.userMetadata,
    fullName: authUser.fullName,
    createdAt: null, // not critical for session
  };
}

// ═══════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════

/**
 * POST /api/auth-email/signup
 * Create user, issue session immediately, send verification email.
 * Does NOT mark Supabase email as verified.
 */
authEmailRouter.post('/signup', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const { email, password, fullName, website, locale, metadata } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const sb = getServiceClient(config);
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedWebsite = website?.trim() || '';

    // Check if user already exists with confirmed email
    const existingUser = await findAuthUserByEmail(config, normalizedEmail).catch(() => null);
    if (existingUser?.userMetadata?.app_email_verified) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const userMetadata = {
      full_name: fullName?.trim() || '',
      website: normalizedWebsite,
      website_url: normalizedWebsite,
      locale: locale || 'en',
      app_email_verified: false,
    };

    let userId: string;

    if (existingUser) {
      // Update existing unverified user
      const { error: updateError } = await sb.auth.admin.updateUserById(existingUser.id, {
        password,
        user_metadata: userMetadata,
      });
      if (updateError) {
        return res.status(500).json({ error: updateError.message || 'Failed to update existing account' });
      }
      userId = existingUser.id;
    } else {
      // Create new user — email_confirm: false so Supabase does NOT mark as verified
      const { data: createData, error: createError } = await sb.auth.admin.createUser({
        email: normalizedEmail,
        password,
        email_confirm: false,
        user_metadata: userMetadata,
      });
      if (createError) {
        return res.status(500).json({ error: createError.message || 'Failed to create user' });
      }
      userId = createData.user?.id!;
    }

    // Upsert profile
    await sb.from('profiles').upsert({
      id: userId,
      email: normalizedEmail,
      full_name: fullName?.trim() || null,
    }, { onConflict: 'id' });

    // Issue app session immediately
    const sessionToken = await createSession(config, userId, normalizedEmail, req);
    setSessionCookie(res, sessionToken);

    // Send verification email (non-blocking)
    issueVerificationEmail(config, {
      userId,
      email: normalizedEmail,
      fullName: fullName?.trim(),
      locale: locale || 'en',
      ipAddress: req.ip || null,
    }).catch((err) => {
      console.warn('[auth-email] Verification email failed:', err);
    });

    return res.json({
      user: {
        id: userId,
        email: normalizedEmail,
        emailVerified: false,
        metadata: userMetadata,
        fullName: fullName?.trim() || '',
      },
      sessionToken,
      needsEmailVerification: true,
    });
  } catch (err) {
    return handleRouteError(res, '[auth-email] signup error:', err);
  }
});

/**
 * POST /api/auth-email/login
 * Validate credentials via Supabase admin API, issue our own session.
 */
authEmailRouter.post('/login', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const sb = getServiceClient(config);

    // Use Supabase signInWithPassword server-side (via service client with admin-like approach)
    // We use the anon client approach to verify password, but server-side.
    // The cleanest way: use supabase.auth.admin to get user, then verify password
    // via a server-side signIn call using a temporary anon-like client.

    // Supabase doesn't have admin.verifyPassword, so we create a server-side
    // auth call using the REST API directly.
    const authResponse = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': config.supabaseAnonKey,
      },
      body: JSON.stringify({ email: normalizedEmail, password }),
    });

    if (!authResponse.ok) {
      const errBody = await authResponse.json().catch(() => ({}));
      return res.status(401).json({ error: errBody.error_description || errBody.msg || 'Invalid credentials' });
    }

    // Credentials are valid — now look up full user data
    const authUser = await findAuthUserByEmail(config, normalizedEmail);
    if (!authUser) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Issue our app session
    const sessionToken = await createSession(config, authUser.id, normalizedEmail, req);
    setSessionCookie(res, sessionToken);

    return res.json({
      user: mapUserForClient(authUser),
      sessionToken,
    });
  } catch (err) {
    return handleRouteError(res, '[auth-email] login error:', err);
  }
});

/**
 * GET /api/auth-email/me
 * Resolve current user from session token (cookie or Bearer).
 */
authEmailRouter.get('/me', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const token = getSessionToken(req);

    if (!token) {
      return res.json({ user: null });
    }

    const session = await resolveSession(config, token);
    if (!session) {
      clearSessionCookie(res);
      return res.json({ user: null });
    }

    // Load full user data
    const authUser = await findAuthUserByEmail(config, session.email);
    if (!authUser) {
      clearSessionCookie(res);
      return res.json({ user: null });
    }

    return res.json({ user: mapUserForClient(authUser) });
  } catch (err) {
    return handleRouteError(res, '[auth-email] me error:', err);
  }
});

/**
 * POST /api/auth-email/logout
 * Revoke current session.
 */
authEmailRouter.post('/logout', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const token = getSessionToken(req);

    if (token) {
      const sb = getServiceClient(config);
      const tokenHash = hashToken(token);
      await sb.from('auth_sessions')
        .update({ revoked_at: new Date().toISOString() })
        .eq('token_hash', tokenHash);
    }

    clearSessionCookie(res);
    return res.json({ success: true });
  } catch (err) {
    return handleRouteError(res, '[auth-email] logout error:', err);
  }
});

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

    if (new Date(tokenData.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Token has expired' });
    }

    // Set app_email_verified in metadata
    const { error: updateError } = await sb.auth.admin.updateUserById(tokenData.user_id, {
      user_metadata: { app_email_verified: true },
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
      return res.json({ success: true }); // Don't reveal
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

    const { error: updateError } = await sb.auth.admin.updateUserById(tokenData.user_id, {
      password: newPassword,
    });

    if (updateError) {
      console.error('[auth-email] Failed to reset password:', updateError);
      return res.status(500).json({ error: 'Failed to reset password' });
    }

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

    // Check if already app-verified
    if (authUser.userMetadata?.app_email_verified) {
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
