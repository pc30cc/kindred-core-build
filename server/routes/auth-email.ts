/**
 * AUTH-EMAIL ROUTES — Full backend-mediated authentication
 * The frontend NEVER calls Supabase Auth directly.
 * All auth flows go through these endpoints.
 */

import { Router, Request, Response } from 'express';
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
import crypto from 'crypto';

export const authEmailRouter = Router();

// ─── Helpers ─────────────────────────────────────────────────────

function getConfig(req: Request): ServerConfig {
  return (req as any).serverConfig;
}

// Session tokens: map token → { userId, email, expiresAt }
// In production, consider Redis or DB-backed sessions.
const sessions = new Map<string, { userId: string; email: string; expiresAt: number }>();

const SESSION_COOKIE = 'gs_session';
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

function createSessionToken(): string {
  return crypto.randomBytes(48).toString('hex');
}

function setSessionCookie(res: Response, token: string) {
  const isProduction = process.env.NODE_ENV === 'production';
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'lax' : 'lax',
    maxAge: SESSION_TTL,
    path: '/',
  });
}

function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

function getSessionFromRequest(req: Request): { userId: string; email: string } | null {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return { userId: session.userId, email: session.email };
}

// Password reset tokens
const resetTokens = new Map<string, { userId: string; email: string; expiresAt: number }>();
const RESET_TTL = 30 * 60 * 1000; // 30 minutes

// Localized messages
const messages: Record<string, Record<string, string>> = {
  en: {
    signupSuccess: 'Account created successfully. Please check your email to verify your account.',
    loginSuccess: 'Logged in successfully.',
    logoutSuccess: 'Logged out successfully.',
    invalidCredentials: 'Invalid email or password.',
    emailRequired: 'Email is required.',
    passwordRequired: 'Password is required.',
    passwordTooShort: 'Password must be at least 8 characters.',
    emailInUse: 'An account with this email already exists.',
    resetEmailSent: 'If an account with that email exists, a password reset link has been sent.',
    passwordUpdated: 'Password updated successfully.',
    invalidToken: 'Invalid or expired token.',
    sessionExpired: 'Session expired. Please log in again.',
    accountLocked: 'Account temporarily locked due to too many failed attempts.',
    invalidInput: 'Invalid input.',
    internalError: 'An internal error occurred.',
    emailVerified: 'Email verified successfully.',
    emailNotVerified: 'Please verify your email before logging in.',
    verificationSent: 'Verification email has been sent.',
  },
  fa: {
    signupSuccess: 'حساب کاربری با موفقیت ایجاد شد. لطفاً ایمیل خود را برای تأیید حساب بررسی کنید.',
    loginSuccess: 'با موفقیت وارد شدید.',
    logoutSuccess: 'با موفقیت خارج شدید.',
    invalidCredentials: 'ایمیل یا رمز عبور نامعتبر است.',
    emailRequired: 'ایمیل الزامی است.',
    passwordRequired: 'رمز عبور الزامی است.',
    passwordTooShort: 'رمز عبور باید حداقل ۸ کاراکتر باشد.',
    emailInUse: 'حساب کاربری با این ایمیل وجود دارد.',
    resetEmailSent: 'اگر حسابی با این ایمیل وجود داشته باشد، لینک بازنشانی ارسال شده است.',
    passwordUpdated: 'رمز عبور با موفقیت به‌روزرسانی شد.',
    invalidToken: 'توکن نامعتبر یا منقضی شده است.',
    sessionExpired: 'نشست منقضی شده. لطفاً دوباره وارد شوید.',
    accountLocked: 'حساب به دلیل تلاش‌های ناموفق زیاد موقتاً قفل شده است.',
    invalidInput: 'ورودی نامعتبر.',
    internalError: 'خطای داخلی رخ داد.',
    emailVerified: 'ایمیل با موفقیت تأیید شد.',
    emailNotVerified: 'لطفاً قبل از ورود ایمیل خود را تأیید کنید.',
    verificationSent: 'ایمیل تأیید ارسال شد.',
  },
  tr: {
    signupSuccess: 'Hesap başarıyla oluşturuldu. Hesabınızı doğrulamak için e-postanızı kontrol edin.',
    loginSuccess: 'Başarıyla giriş yapıldı.',
    logoutSuccess: 'Başarıyla çıkış yapıldı.',
    invalidCredentials: 'Geçersiz e-posta veya şifre.',
    emailRequired: 'E-posta gereklidir.',
    passwordRequired: 'Şifre gereklidir.',
    passwordTooShort: 'Şifre en az 8 karakter olmalıdır.',
    emailInUse: 'Bu e-posta ile bir hesap zaten mevcut.',
    resetEmailSent: 'Bu e-posta ile bir hesap varsa, şifre sıfırlama bağlantısı gönderildi.',
    passwordUpdated: 'Şifre başarıyla güncellendi.',
    invalidToken: 'Geçersiz veya süresi dolmuş token.',
    sessionExpired: 'Oturum süresi doldu. Lütfen tekrar giriş yapın.',
    accountLocked: 'Çok fazla başarısız deneme nedeniyle hesap geçici olarak kilitlendi.',
    invalidInput: 'Geçersiz giriş.',
    internalError: 'Bir iç hata oluştu.',
    emailVerified: 'E-posta başarıyla doğrulandı.',
    emailNotVerified: 'Giriş yapmadan önce e-postanızı doğrulayın.',
    verificationSent: 'Doğrulama e-postası gönderildi.',
  },
};

function msg(locale: string, key: string): string {
  const lang = messages[locale] ? locale : 'en';
  return messages[lang][key] || messages.en[key] || key;
}

function getLang(req: Request): string {
  const lang = (req.headers['accept-language'] || '').slice(0, 2).toLowerCase();
  return ['en', 'fa', 'tr'].includes(lang) ? lang : 'en';
}

// ─── Schemas ─────────────────────────────────────────────────────

const signupSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(255),
  fullName: z.string().max(255).optional(),
  locale: z.string().max(5).optional(),
  captchaToken: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(255),
  captchaToken: z.string().optional(),
});

const resetRequestSchema = z.object({
  email: z.string().email().max(255),
  locale: z.string().max(5).optional(),
});

const updatePasswordSchema = z.object({
  password: z.string().min(8).max(255),
  token: z.string().optional(), // For reset-password flow (not logged in)
});

// ─── POST /signup ────────────────────────────────────────────────

authEmailRouter.post('/signup', authRateLimiter, async (req: Request, res: Response) => {
  const lang = getLang(req);
  try {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: msg(lang, 'invalidInput'), details: parsed.error.flatten().fieldErrors });
    }

    const { email, password, fullName, locale } = parsed.data;
    const config = getConfig(req);
    const sb = getServiceClient(config);

    // Create user via Supabase Admin API
    const { data: userData, error: createError } = await sb.auth.admin.createUser({
      email: email.toLowerCase().trim(),
      password,
      email_confirm: false, // Require email verification
      user_metadata: {
        full_name: fullName || '',
      },
    });

    if (createError) {
      if (createError.message?.includes('already been registered') || createError.message?.includes('already exists')) {
        return res.status(409).json({ error: msg(lang, 'emailInUse') });
      }
      console.error('[auth-email] signup error:', createError.message);
      return res.status(400).json({ error: createError.message });
    }

    // Generate email verification token
    const { data: linkData, error: linkError } = await sb.auth.admin.generateLink({
      type: 'signup',
      email: email.toLowerCase().trim(),
    });

    if (linkError) {
      console.error('[auth-email] verification link error:', linkError.message);
    }

    // Send verification email via configured email provider
    // For now, Supabase handles the email via generateLink.
    // TODO: Use our own email provider when configured.

    await logSecurityEvent(req, 'signup', 'info', { email });

    return res.status(201).json({
      success: true,
      message: msg(lang, 'signupSuccess'),
      user: {
        id: userData.user.id,
        email: userData.user.email,
        emailVerified: !!userData.user.email_confirmed_at,
      },
    });
  } catch (err) {
    console.error('[auth-email] signup exception:', err);
    return res.status(500).json({ error: msg(lang, 'internalError') });
  }
});

// ─── POST /login ─────────────────────────────────────────────────

authEmailRouter.post('/login', authRateLimiter, async (req: Request, res: Response) => {
  const lang = getLang(req);
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: msg(lang, 'invalidInput') });
    }

    const { email, password, captchaToken } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();
    const config = getConfig(req);

    // Brute force check
    const bruteCheck = await checkBruteForce(req, normalizedEmail);
    if (bruteCheck.blocked) {
      await logSecurityEvent(req, 'brute_force', 'error', { email: normalizedEmail, failCount: bruteCheck.failCount });
      return res.status(429).json({
        error: msg(lang, 'accountLocked'),
        retryAfter: bruteCheck.retryAfter,
      });
    }

    // Captcha check if needed
    if ((bruteCheck.failCount || 0) >= 3 && captchaToken) {
      const sb = getServiceClient(config);
      const { data: captchaConfig } = await sb
        .from('app_runtime_config')
        .select('value')
        .eq('key', 'captcha_provider')
        .single();

      if (captchaConfig?.value) {
        const settings = captchaConfig.value as any;
        const verification = await verifyCaptcha(captchaToken, settings.provider || 'turnstile', settings.secretKey, req.ip);
        if (!verification.success) {
          return res.status(400).json({ error: 'Captcha verification failed' });
        }
      }
    }

    // Authenticate via Supabase Admin — use signInWithPassword on service client
    const sb = getServiceClient(config);

    // We use the anon client approach: create a temporary client to validate credentials
    const { createClient } = await import('@supabase/supabase-js');
    const tempClient = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: signInData, error: signInError } = await tempClient.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });

    if (signInError || !signInData.user) {
      recordLoginAttempt(req, normalizedEmail, false);
      await logSecurityEvent(req, 'login_failed', 'warn', { email: normalizedEmail });

      // Log to DB
      await sb.from('login_attempts').insert({
        ip_address: req.ip || 'unknown',
        email: normalizedEmail,
        success: false,
      }).catch(() => {});

      return res.status(401).json({
        error: msg(lang, 'invalidCredentials'),
        requiresCaptcha: (bruteCheck.failCount || 0) >= 2,
      });
    }

    // Sign out from temp client (we don't need it)
    await tempClient.auth.signOut().catch(() => {});

    // Successful login — create server session
    recordLoginAttempt(req, normalizedEmail, true);

    const sessionToken = createSessionToken();
    sessions.set(sessionToken, {
      userId: signInData.user.id,
      email: signInData.user.email || normalizedEmail,
      expiresAt: Date.now() + SESSION_TTL,
    });

    setSessionCookie(res, sessionToken);

    await sb.from('login_attempts').insert({
      ip_address: req.ip || 'unknown',
      email: normalizedEmail,
      success: true,
    }).catch(() => {});

    await logSecurityEvent(req, 'login_success', 'info', { email: normalizedEmail });

    return res.json({
      success: true,
      message: msg(lang, 'loginSuccess'),
      user: {
        id: signInData.user.id,
        email: signInData.user.email,
        emailVerified: !!signInData.user.email_confirmed_at,
        metadata: signInData.user.user_metadata || {},
        createdAt: signInData.user.created_at,
      },
    });
  } catch (err) {
    console.error('[auth-email] login exception:', err);
    return res.status(500).json({ error: msg(lang, 'internalError') });
  }
});

// ─── POST /logout ────────────────────────────────────────────────

authEmailRouter.post('/logout', async (req: Request, res: Response) => {
  const lang = getLang(req);
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    sessions.delete(token);
  }
  clearSessionCookie(res);
  return res.json({ success: true, message: msg(lang, 'logoutSuccess') });
});

// ─── GET /session ────────────────────────────────────────────────

authEmailRouter.get('/session', async (req: Request, res: Response) => {
  const sessionData = getSessionFromRequest(req);
  if (!sessionData) {
    return res.json({ authenticated: false, user: null });
  }

  // Fetch fresh user data from DB
  const config = getConfig(req);
  const sb = getServiceClient(config);

  try {
    const { data: userData, error } = await sb.auth.admin.getUserById(sessionData.userId);
    if (error || !userData?.user) {
      // Session references invalid user — clear it
      const token = req.cookies?.[SESSION_COOKIE];
      if (token) sessions.delete(token);
      clearSessionCookie(res);
      return res.json({ authenticated: false, user: null });
    }

    return res.json({
      authenticated: true,
      user: {
        id: userData.user.id,
        email: userData.user.email,
        emailVerified: !!userData.user.email_confirmed_at,
        metadata: userData.user.user_metadata || {},
        createdAt: userData.user.created_at,
      },
    });
  } catch (err) {
    console.error('[auth-email] session fetch error:', err);
    return res.json({ authenticated: false, user: null });
  }
});

// ─── POST /reset-password ────────────────────────────────────────

authEmailRouter.post('/reset-password', authRateLimiter, async (req: Request, res: Response) => {
  const lang = getLang(req);
  try {
    const parsed = resetRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: msg(lang, 'invalidInput') });
    }

    const { email } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();
    const config = getConfig(req);
    const sb = getServiceClient(config);

    // Generate password reset link via Supabase Admin
    const { data: linkData, error: linkError } = await sb.auth.admin.generateLink({
      type: 'recovery',
      email: normalizedEmail,
    });

    // Always return success to not leak user existence
    await logSecurityEvent(req, 'reset_password_request', 'info', { email: normalizedEmail });

    if (linkError) {
      console.error('[auth-email] reset link error:', linkError.message);
    }

    // If we got a link, extract the token and store it for our own flow
    if (linkData?.properties?.hashed_token) {
      // Store for our own reset verification
      const resetToken = crypto.randomBytes(32).toString('hex');
      // Look up user
      const { data: user } = await sb.auth.admin.getUserByEmail(normalizedEmail).catch(() => ({ data: null })) as any;
      if (user?.user) {
        resetTokens.set(resetToken, {
          userId: user.user.id,
          email: normalizedEmail,
          expiresAt: Date.now() + RESET_TTL,
        });

        // TODO: Send email via our own email provider with reset link containing resetToken
        // For now, Supabase handles it via generateLink
        console.log(`[auth-email] Reset token generated for ${normalizedEmail}: use GET /api/auth-email/reset-callback?token=${resetToken}`);
      }
    }

    return res.json({
      success: true,
      message: msg(lang, 'resetEmailSent'),
    });
  } catch (err) {
    console.error('[auth-email] reset-password exception:', err);
    return res.status(500).json({ error: msg(lang, 'internalError') });
  }
});

// ─── POST /update-password ───────────────────────────────────────

authEmailRouter.post('/update-password', async (req: Request, res: Response) => {
  const lang = getLang(req);
  try {
    const parsed = updatePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: msg(lang, 'invalidInput') });
    }

    const { password, token } = parsed.data;
    const config = getConfig(req);
    const sb = getServiceClient(config);

    let userId: string | null = null;

    if (token) {
      // Reset-password flow with token
      const resetData = resetTokens.get(token);
      if (!resetData || Date.now() > resetData.expiresAt) {
        return res.status(400).json({ error: msg(lang, 'invalidToken') });
      }
      userId = resetData.userId;
      resetTokens.delete(token);
    } else {
      // Authenticated user changing their own password
      const sessionData = getSessionFromRequest(req);
      if (!sessionData) {
        return res.status(401).json({ error: msg(lang, 'sessionExpired') });
      }
      userId = sessionData.userId;
    }

    // Update password via Supabase Admin
    const { error: updateError } = await sb.auth.admin.updateUserById(userId, {
      password,
    });

    if (updateError) {
      console.error('[auth-email] update password error:', updateError.message);
      return res.status(400).json({ error: updateError.message });
    }

    await logSecurityEvent(req, 'password_updated', 'info', { userId });

    return res.json({
      success: true,
      message: msg(lang, 'passwordUpdated'),
    });
  } catch (err) {
    console.error('[auth-email] update-password exception:', err);
    return res.status(500).json({ error: msg(lang, 'internalError') });
  }
});

// ─── GET /verify-email ───────────────────────────────────────────

authEmailRouter.get('/verify-email', async (req: Request, res: Response) => {
  const lang = getLang(req);
  try {
    const { token, type } = req.query;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: msg(lang, 'invalidToken') });
    }

    const config = getConfig(req);
    const sb = getServiceClient(config);

    // Verify via Supabase — verify OTP token
    const { createClient } = await import('@supabase/supabase-js');
    const tempClient = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data, error } = await tempClient.auth.verifyOtp({
      token_hash: token,
      type: (type as any) || 'signup',
    });

    if (error) {
      console.error('[auth-email] verify-email error:', error.message);
      return res.status(400).json({
        success: false,
        error: msg(lang, 'invalidToken'),
      });
    }

    await logSecurityEvent(req, 'email_verified', 'info', { email: data.user?.email });

    return res.json({
      success: true,
      message: msg(lang, 'emailVerified'),
      user: data.user ? {
        id: data.user.id,
        email: data.user.email,
        emailVerified: true,
      } : null,
    });
  } catch (err) {
    console.error('[auth-email] verify-email exception:', err);
    return res.status(500).json({ error: msg(lang, 'internalError') });
  }
});

// ─── Cleanup expired sessions/tokens periodically ────────────────

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of sessions) {
    if (now > val.expiresAt) sessions.delete(key);
  }
  for (const [key, val] of resetTokens) {
    if (now > val.expiresAt) resetTokens.delete(key);
  }
}, 5 * 60_000);
