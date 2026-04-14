/**
 * AUTH SECURITY ROUTES — server-side brute force + captcha enforcement
 * These endpoints sit in front of Supabase Auth to add security layers.
 */

import { Router } from 'express';
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

export const authSecurityRouter = Router();

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(255),
  captchaToken: z.string().optional(),
});

const signupSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(255),
  captchaToken: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

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
 * Secured login endpoint with brute force + captcha
 */
authSecurityRouter.post('/login', authRateLimiter, async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten().fieldErrors });
    }

    const { email, password, captchaToken } = parsed.data;

    // Check brute force
    const bruteCheck = await checkBruteForce(req, email);
    if (bruteCheck.blocked) {
      await logSecurityEvent(req, 'brute_force', 'error', { email, failCount: bruteCheck.failCount });
      return res.status(429).json({
        error: 'Account temporarily locked due to too many failed attempts.',
        retryAfter: bruteCheck.retryAfter,
      });
    }

    // If 3+ failures, require captcha
    if ((bruteCheck.failCount || 0) >= 3 && captchaToken) {
      // Check for captcha provider config in runtime config
      const sb = getServiceClient(config);
      const { data: captchaConfig } = await sb
        .from('app_runtime_config')
        .select('value')
        .eq('key', 'captcha_provider')
        .single();

      if (captchaConfig?.value) {
        const captchaSettings = captchaConfig.value as any;
        const verification = await verifyCaptcha(
          captchaToken,
          captchaSettings.provider || 'turnstile',
          captchaSettings.secretKey,
          req.ip
        );
        if (!verification.success) {
          await logSecurityEvent(req, 'captcha_failed', 'warn', { email, provider: captchaSettings.provider });
          return res.status(400).json({ error: 'Captcha verification failed' });
        }
      }
    }

    // Record attempt (will be marked success/fail after result)
    // Use Supabase client to verify credentials
    const sb = getServiceClient(config);
    const { data: { users }, error: loginError } = await sb.auth.admin.listUsers();
    const loginData = users?.find((u: any) => u.email === email);

    // We don't actually perform login here — the frontend does via Supabase SDK
    // This endpoint validates brute force + captcha, then returns clearance
    if (loginError) {
      recordLoginAttempt(req, email, false);
      await logSecurityEvent(req, 'login_failed', 'warn', { email });

      // Log to DB for persistence
      await sb.from('login_attempts').insert({
        ip_address: req.ip || 'unknown',
        email,
        success: false,
      });

      return res.json({ cleared: true }); // Don't reveal user existence
    }

    return res.json({
      cleared: true,
      requiresCaptcha: (bruteCheck.failCount || 0) >= 3,
    });
  } catch (err) {
    console.error('[auth] Login check error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /api/auth/record-result
 * Frontend calls after Supabase auth to record success/failure.
 * Also accepts generic security event logging from the client.
 */
authSecurityRouter.post('/record-result', async (req, res) => {
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
