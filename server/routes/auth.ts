/**
 * AUTH ROUTES — first-party login/signup.
 *
 * `/login` and `/signup` are the real authentication endpoints as of the
 * auth migration: identity lives in `profiles` + `user_credentials`
 * (Argon2id, server/services/auth/password.ts), sessions are opaque
 * HttpOnly cookies (server/services/auth/sessions.ts). Supabase Auth/GoTrue
 * is not used here — `sb.auth.admin.*` / `auth.users` are neither read nor
 * written by this file.
 */

import { Router } from 'express';
import crypto from 'crypto';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  authRateLimiter,
  checkBruteForce,
  recordLoginAttempt,
  verifyCaptcha,
  logSecurityEvent,
} from '../middleware/security.js';
import { z } from 'zod';
import { issueVerificationEmail } from '../services/auth-email.js';
import { findIdentityByEmail, findIdentityById } from '../services/auth/identity.js';
import { hashPassword, verifyPassword, needsRehash, InvalidPasswordError } from '../services/auth/password.js';
import { redeemImpersonationToken } from '../services/auth/impersonation.js';
import { resolveAppBaseUrl } from './admin.js';
import {
  createSession,
  setSessionCookie,
  clearSessionCookie,
  validateSessionToken,
  verifyOriginForMutation,
  revokeSession,
  revokeAllSessions,
  SESSION_COOKIE_NAME,
} from '../services/auth/sessions.js';

export const authSecurityRouter = Router();

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(255),
  captchaToken: z.string().optional(),
});

const signupSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(255),
  fullName: z.string().trim().max(120).optional(),
  website: z.string().trim().max(255).optional().default(''),
  locale: z.string().trim().min(2).max(10).optional(),
  captchaToken: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

function normalizeWebsiteUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    if (!url.hostname || !url.hostname.includes('.')) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/**
 * POST /api/auth/check-brute-force
 * Client calls this before login to check if brute force protection is active
 */
authSecurityRouter.post('/check-brute-force', authRateLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const result = await checkBruteForce(req, email);
  return res.json({
    blocked: result.blocked,
    retryAfter: result.retryAfter || 0,
    failCount: result.failCount || 0,
    requiresCaptcha: (result.failCount || 0) >= 3,
  });
});

/**
 * POST /api/auth/login
 * Real first-party login: brute force + captcha, Argon2id password
 * verification against `user_credentials`, then an application session.
 */
authSecurityRouter.post('/login', authRateLimiter, async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten().fieldErrors });
    }

    const { password, captchaToken } = parsed.data;
    const normalizedEmail = parsed.data.email.trim().toLowerCase();
    const sb = getServiceClient(config);

    const bruteCheck = await checkBruteForce(req, normalizedEmail);
    if (bruteCheck.blocked) {
      await logSecurityEvent(req, 'brute_force', 'error', { email: normalizedEmail, failCount: bruteCheck.failCount });
      return res.status(429).json({
        error: 'Account temporarily locked due to too many failed attempts.',
        retryAfter: bruteCheck.retryAfter,
      });
    }

    // 3+ recent failures requires a verified captcha before we even touch credentials.
    if ((bruteCheck.failCount || 0) >= 3) {
      const { data: captchaConfig } = await sb
        .from('app_runtime_config')
        .select('value')
        .eq('key', 'captcha_provider')
        .single();

      if (captchaConfig?.value) {
        const captchaSettings = captchaConfig.value as any;
        if (!captchaToken) {
          return res.status(400).json({ error: 'Captcha verification required', requiresCaptcha: true });
        }
        const verification = await verifyCaptcha(
          captchaToken,
          captchaSettings.provider || 'turnstile',
          captchaSettings.secretKey,
          req.ip
        );
        if (!verification.success) {
          await logSecurityEvent(req, 'captcha_failed', 'warn', { email: normalizedEmail, provider: captchaSettings.provider });
          return res.status(400).json({ error: 'Captcha verification failed' });
        }
      }
    }

    const genericInvalid = async () => {
      recordLoginAttempt(req, normalizedEmail, false);
      await logSecurityEvent(req, 'login_failed', 'warn', { email: normalizedEmail });
      await sb.from('login_attempts').insert({ ip_address: req.ip || 'unknown', email: normalizedEmail, success: false });
      return res.status(401).json({ error: 'Invalid email or password' });
    };

    const identity = await findIdentityByEmail(config, normalizedEmail);
    if (!identity) return genericInvalid();

    if (identity.status === 'disabled') {
      recordLoginAttempt(req, normalizedEmail, false);
      await logSecurityEvent(req, 'login_failed', 'warn', { email: normalizedEmail, userId: identity.id, reason: 'disabled' });
      return res.status(403).json({ error: 'This account has been disabled.' });
    }

    if (!identity.passwordHash) {
      // Migrated (pre-first-party) user, or a brand-new profile row with no
      // credentials yet: there is no password to check against. This is a
      // deliberate, documented departure from the generic-failure response —
      // the account genuinely needs a one-time password-setup step (via the
      // same forgot-password flow), which is a different remediation than
      // "your password was wrong". It does not reveal anything an attacker
      // couldn't already learn by attempting "forgot password" for the email.
      recordLoginAttempt(req, normalizedEmail, false);
      await logSecurityEvent(req, 'login_failed', 'info', { email: normalizedEmail, userId: identity.id, reason: 'password_setup_required' });
      return res.status(403).json({ error: 'Password setup required', passwordSetupRequired: true });
    }

    const validPassword = await verifyPassword(identity.passwordHash, password);
    if (!validPassword) return genericInvalid();

    // POLICY DECISION — email verification is NOT required to log in.
    // `user_credentials.email_verified_at` starts NULL for every one of the
    // pre-existing (migrated) accounts created by the auth migration — there
    // was no backfill from the old `auth.users.email_confirmed_at`, and
    // inventing one is out of scope here. Gating login on it would lock out
    // every current customer, not just new signups, until each one clicked
    // a fresh verification link. The frontend's own signup flow already
    // auto-logs a brand-new user in immediately after signup without
    // checking this flag (src/pages/auth/SignupPage.tsx), so this matches
    // already-shipped product behavior rather than introducing a new gap.
    //
    // This is safe independently of the account-takeover fix above: that
    // fix is structural (signup can never attach a password to an existing
    // identity at all, verified or not), so leaving verification
    // non-blocking here does not reopen it. Verified/unverified is exposed
    // to the client (`emailVerified` in the response) so the UI can still
    // nudge toward verification without blocking access to it.
    recordLoginAttempt(req, normalizedEmail, true);
    await sb.from('login_attempts').insert({ ip_address: req.ip || 'unknown', email: normalizedEmail, success: true });

    // Silent rehash-on-login when stored params are weaker than current policy.
    if (needsRehash(identity.passwordHash)) {
      try {
        const upgradedHash = await hashPassword(password);
        await sb.from('user_credentials').update({ password_hash: upgradedHash }).eq('user_id', identity.id);
      } catch (rehashErr) {
        console.error('[auth] Rehash-on-login failed (non-fatal):', rehashErr);
      }
    }

    await sb
      .from('user_credentials')
      .update({ last_login_at: new Date().toISOString(), failed_login_count: 0 })
      .eq('user_id', identity.id);

    const session = await createSession(config, {
      userId: identity.id,
      email: identity.email,
      ipAddress: req.ip || null,
      userAgent: (req.headers['user-agent'] as string | undefined) || null,
    });
    setSessionCookie(res, session.token, session.expiresAt);

    await logSecurityEvent(req, 'login_success', 'info', { email: normalizedEmail, userId: identity.id });

    return res.json({
      user: {
        id: identity.id,
        email: identity.email,
        emailVerified: !!identity.emailVerifiedAt,
        fullName: identity.fullName,
      },
    });
  } catch (err) {
    console.error('[auth] Login error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /api/auth/signup
 * First-party account creation: `profiles` is the identity root (026 freed
 * it from requiring an `auth.users` row), `user_credentials` holds the
 * Argon2id hash. No `sb.auth.admin.*` call anywhere in this path.
 */
authSecurityRouter.post('/signup', authRateLimiter, async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = signupSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten().fieldErrors });
    }

    const { password, fullName, website, locale, metadata } = parsed.data;
    const normalizedWebsite = website ? normalizeWebsiteUrl(website) : null;
    const normalizedEmail = parsed.data.email.trim().toLowerCase();
    const sb = getServiceClient(config);

    // SECURITY (account-takeover fix): a signup request must NEVER create or
    // replace credentials, or mutate profile fields, for an identity that
    // already existed before this request — whether it's a migrated
    // (pre-first-party) user with password_hash IS NULL, an unverified
    // signup, or a fully set-up account. Every existing user starts with
    // password_hash = NULL after the auth migration, so writing credentials
    // here for "existing, no password yet" let anyone who knew a victim's
    // email attach an attacker-chosen password to the victim's identity via
    // a bare POST — instant account takeover, no proof of email ownership
    // required. This check runs BEFORE hashing the submitted password, so an
    // existing-identity signup attempt never pays (or needs) the Argon2id
    // cost at all.
    //
    // The only path that may ever set a password on an EXISTING identity is
    // proof-of-email-ownership through a token mailed to that address:
    // POST /api/auth-email/reset-password. Its own comment documents that it
    // doubles as the migrated-user "password setup" flow — the same
    // user_credentials upsert this route used to do, but gated by a
    // single-use token instead of a bare, unauthenticated POST body.
    //
    // The response is identical in shape (status + error message) whether
    // or not the existing identity has a password, so this endpoint reveals
    // no more than the login endpoint already does for the same email.
    const existing = await findIdentityByEmail(config, normalizedEmail);
    if (existing) {
      return res.status(409).json({
        error: 'An account with this email already exists',
        passwordSetupRequired: !existing.passwordHash,
      });
    }

    let passwordHash: string;
    try {
      passwordHash = await hashPassword(password);
    } catch (err) {
      if (err instanceof InvalidPasswordError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    const profileFields = {
      email: normalizedEmail,
      full_name: fullName?.trim() || null,
      company_name: metadata?.companyName || null,
      website_domain: metadata?.websiteDomain || normalizedWebsite || null,
      main_goal: metadata?.mainGoal || null,
      ai_mode: metadata?.aiMode || null,
      signup_ip: req.ip || null,
      signup_locale: locale || null,
    };

    const newUserId = crypto.randomUUID();
    const { error: profileError } = await sb.from('profiles').insert({ id: newUserId, ...profileFields });
    if (profileError) {
      // Most likely a unique-email race with a concurrent signup for the same address.
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const { error: credError } = await sb.from('user_credentials').insert({
      user_id: newUserId,
      password_hash: passwordHash,
      password_algo: 'argon2id',
      password_set_at: new Date().toISOString(),
    });
    if (credError) {
      // Don't leave an unusable, password-less identity behind.
      await sb.from('profiles').delete().eq('id', newUserId);
      console.error('[auth] Failed to create credentials, rolled back profile:', credError);
      return res.status(500).json({ error: 'Failed to create account' });
    }

    const verificationResult = await issueVerificationEmail(config, {
      userId: newUserId,
      email: normalizedEmail,
      fullName,
      locale,
      ipAddress: req.ip || null,
    });
    if (!verificationResult.success) {
      // Account exists and is usable — user can resend from the panel banner.
      console.warn('[auth] Signup succeeded but verification email failed:', verificationResult.error);
    }

    return res.json({
      user: {
        id: newUserId,
        email: normalizedEmail,
        email_confirmed_at: null,
        created_at: new Date().toISOString(),
      },
      needsEmailVerification: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[auth] Signup error:', message, err);
    return res.status(500).json({ error: message || 'Internal error' });
  }
});

/**
 * GET /api/auth/session
 * Resolves the caller's session from the `gs_session` HttpOnly cookie.
 * Frontend AuthProvider.getSession() reads state here — never from
 * browser-readable storage, since the cookie itself isn't visible to JS.
 */
authSecurityRouter.get('/session', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const token = req.cookies?.[SESSION_COOKIE_NAME];
    const session = await validateSessionToken(config, token);
    if (!session) return res.json({ user: null });

    const identity = await findIdentityById(config, session.userId);
    if (!identity) return res.json({ user: null });

    return res.json({
      user: {
        id: identity.id,
        email: identity.email,
        emailVerified: !!identity.emailVerifiedAt,
        fullName: identity.fullName,
      },
    });
  } catch (err) {
    console.error('[auth] Session check error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /api/auth/logout
 * Revokes only the calling browser's session and clears its cookie.
 */
authSecurityRouter.post('/logout', authRateLimiter, async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    if (!verifyOriginForMutation(req, config.corsOrigins)) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }
    const token = req.cookies?.[SESSION_COOKIE_NAME];
    const session = await validateSessionToken(config, token);
    if (session) {
      await revokeSession(config, session.sessionId, 'logout');
      await logSecurityEvent(req, 'session_revoked', 'info', { userId: session.userId, reason: 'logout' });
    }
    clearSessionCookie(res);
    return res.json({ success: true });
  } catch (err) {
    console.error('[auth] Logout error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /api/auth/logout-all
 * Revokes every session for the caller's account (all devices), including
 * this one, and clears this browser's cookie.
 */
authSecurityRouter.post('/logout-all', authRateLimiter, async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    if (!verifyOriginForMutation(req, config.corsOrigins)) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }
    const token = req.cookies?.[SESSION_COOKIE_NAME];
    const session = await validateSessionToken(config, token);
    if (!session) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const revokedCount = await revokeAllSessions(config, session.userId, 'logout_all');
    await logSecurityEvent(req, 'logout_all', 'info', { userId: session.userId, revokedCount });
    clearSessionCookie(res);
    return res.json({ success: true, revokedCount });
  } catch (err) {
    console.error('[auth] Logout-all error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/auth/impersonate
 * Redeems a one-time platform-admin "login as user" token (issued by
 * POST /api/admin/impersonate) — sets a real session cookie for the target
 * user and redirects into the app. Replaces the old Supabase Auth
 * magic-link verify URL; the frontend just opens this URL in a new tab.
 */
authSecurityRouter.get('/impersonate', authRateLimiter, async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const redeemed = await redeemImpersonationToken(config, req.query.token as string | undefined);
  if (!redeemed) {
    return res.status(400).send('This impersonation link is invalid or has expired.');
  }

  const identity = await findIdentityById(config, redeemed.targetUserId);
  if (!identity) {
    return res.status(404).send('Target user no longer exists.');
  }

  const session = await createSession(config, {
    userId: identity.id,
    email: identity.email,
    ipAddress: req.ip || null,
    userAgent: (req.headers['user-agent'] as string | undefined) || null,
  });
  setSessionCookie(res, session.token, session.expiresAt);
  await logSecurityEvent(req, 'admin_impersonation', 'warn', {
    userId: identity.id,
    adminUserId: redeemed.createdBy,
  });

  const redirectBase = await resolveAppBaseUrl(config, req);
  return res.redirect(302, `${redirectBase || ''}/app`);
});

/**
 * POST /api/auth/record-result
 * Frontend calls after Supabase auth to record success/failure.
 * Also accepts generic security event logging from the client.
 */
authSecurityRouter.post('/record-result', authRateLimiter, async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const { email, success, eventType, severity, metadata } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'email required' });
    }

    // If this is a generic security event log
    if (eventType) {
      await logSecurityEvent(req, eventType, severity || 'info', { email, ...metadata });
      return res.json({ ok: true });
    }

    // Standard login result recording
    if (typeof success !== 'boolean') {
      return res.status(400).json({ error: 'success (boolean) required' });
    }

    recordLoginAttempt(req, email, success);

    const sb = getServiceClient(config);
    await sb.from('login_attempts').insert({
      ip_address: req.ip || 'unknown',
      email,
      success,
    });

    if (!success) {
      await logSecurityEvent(req, 'login_failed', 'warn', { email });
    }

    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /api/auth/verify-captcha
 * Standalone captcha verification for signup and other actions
 */
authSecurityRouter.post('/verify-captcha', authRateLimiter, async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Captcha token required' });

    const sb = getServiceClient(config);
    const { data: captchaConfig } = await sb
      .from('app_runtime_config')
      .select('value')
      .eq('key', 'captcha_provider')
      .single();

    if (!captchaConfig?.value) {
      // No captcha configured — pass through
      return res.json({ success: true, message: 'No captcha provider configured' });
    }

    const settings = captchaConfig.value as any;
    const result = await verifyCaptcha(token, settings.provider || 'turnstile', settings.secretKey, req.ip);

    if (!result.success) {
      await logSecurityEvent(req, 'captcha_failed', 'warn', { provider: settings.provider });
    }

    return res.json(result);
  } catch {
    return res.status(500).json({ error: 'Captcha verification error' });
  }
});
