/**
 * ADMIN USER MANAGEMENT ROUTES
 * Password reset, password change, block/unblock users.
 * All require global admin role verified via service client.
 */

import { Router } from 'express';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { z } from 'zod';
import { issueRecoveryEmail } from '../services/auth-email.js';
import { deleteFile } from '../services/storage/index.js';
import { adminWidgetRouter } from './adminWidget.js';
import { adminMetricsRouter } from './adminMetrics.js';
import { adminAlertsRouter } from './adminAlerts.js';
import { adminPerfRouter } from './adminPerf.js';
import { adminAutoActionsRouter } from './adminAutoActions.js';
import { adminReliabilityRouter } from './adminReliability.js';
import { adminEnforcementRouter } from './adminEnforcement.js';
import { adminCallsRouter } from './adminCalls.js';
import { adminAdvancedRoutingRouter } from './adminAdvancedRouting.js';
import { adminSmsProvidersRouter } from './adminSmsProviders.js';
import { adminPhoneVerificationRouter } from './adminPhoneVerification.js';
import { normalizePhoneToE164 } from '../services/phoneVerification/phone.js';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';

export const adminRouter = Router();

/**
 * Resolve the canonical app base URL without falling back to `localhost`.
 * Order: platform_domains.app_base_url → APP_BASE_URL env →
 *        first non-wildcard CORS origin → request origin → null.
 * Callers MUST handle a null result (multi-domain deploys without a
 * configured app base must not silently link visitors to localhost).
 */
async function resolveAppBaseUrl(config: ServerConfig, req: any): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data: domains } = await sb
    .from('platform_domains')
    .select('app_base_url')
    .limit(1)
    .maybeSingle();

  const fromDb = domains?.app_base_url?.trim();
  if (fromDb) return fromDb.replace(/\/+$/, '');

  const fromEnv = process.env.APP_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');

  const explicitOrigin = (config.corsOrigins || []).find((o) => o && o !== '*');
  if (explicitOrigin) return explicitOrigin.replace(/\/+$/, '');

  // Last resort: request-derived origin. Honors X-Forwarded-* set by trust proxy.
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
  if (proto && host) return `${proto}://${host}`;

  return null;
}

// Middleware: verify caller is a global admin
async function requireAdmin(req: any, res: any, next: any) {
  const userId = await requirePlatformAdmin(req, res);
  if (!userId) return;
  (req as any).adminUser = { id: userId };
  next();
}

adminRouter.use(requireAdmin);

// Widget diagnostics (server-side URL test for super admin)
adminRouter.use('/widget', adminWidgetRouter);

// Widget templates registry (super admin only)

// Phase 3 — observability (super admin only)
adminRouter.use('/metrics', adminMetricsRouter);

// Phase 4 — alerting & anomaly detection (super admin only)
adminRouter.use('/alerts', adminAlertsRouter);

// Phase 5A — performance / latency observability (super admin only)
adminRouter.use('/perf', adminPerfRouter);

// Phase 5C — self-healing / auto-actions (super admin only)
adminRouter.use('/auto-actions', adminAutoActionsRouter);

// Phase 7 — SLA / reliability / business / workspace health (super admin only)
adminRouter.use('/reliability', adminReliabilityRouter);

// Phase 7.5 — SLA enforcement (SLO breaches, rules, actions, kill switch)
adminRouter.use('/enforcement', adminEnforcementRouter);

// Phase 8A — Voice/Video control plane (super admin only).
adminRouter.use('/calls', adminCallsRouter);

// Global Advanced Routing — owner fallback / general-pool policy applied to
// all workspaces. Lives inside super-admin Widget Settings UI.
adminRouter.use('/advanced-routing', adminAdvancedRoutingRouter);

// Phase 6-S3A — platform SMS provider (Kavenegar). Credential is stored in a
// service-role-only table and never returned to the browser.
adminRouter.use('/providers/sms', adminSmsProvidersRouter);

// Phase 6-S3B — per-user phone verification (status / resend / manual verify).
// Mounted inside the admin router so `requireAdmin` runs first.
adminRouter.use('/users', adminPhoneVerificationRouter);

// ─── Send Password Reset Link ────────────────────────────────────
const resetLinkSchema = z.object({
  email: z.string().email(),
});

adminRouter.post('/send-reset-link', async (req, res) => {
  try {
    const { email } = resetLinkSchema.parse(req.body);
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);

    // Fully self-hosted recovery: custom token table + configured email provider.
    // Supabase's built-in reset mailer is never used.
    const normalizedEmail = email.trim().toLowerCase();

    const { data: profile, error: profileError } = await sb
      .from('profiles')
      .select('id, email, full_name, preferred_locale')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (profileError) {
      return res.status(500).json({ error: profileError.message });
    }
    if (!profile?.id) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    const result = await issueRecoveryEmail(config, {
      userId: profile.id,
      email: profile.email || normalizedEmail,
      fullName: profile.full_name ?? null,
      locale: profile.preferred_locale || 'en',
    });

    if (!result.success) {
      return res.status(502).json({ error: result.error || 'Failed to send reset email' });
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to send reset link' });
  }
});

// ─── Admin Change Password ───────────────────────────────────────
const changePasswordSchema = z.object({
  userId: z.string().uuid(),
  newPassword: z.string().min(8).max(255),
});

adminRouter.post('/change-password', async (req, res) => {
  try {
    const { userId, newPassword } = changePasswordSchema.parse(req.body);
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);

    const { error } = await sb.auth.admin.updateUserById(userId, {
      password: newPassword,
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to change password' });
  }
});

// ─── Block / Unblock User ────────────────────────────────────────
const blockSchema = z.object({
  userId: z.string().uuid(),
  blocked: z.boolean(),
});

adminRouter.post('/block-user', async (req, res) => {
  try {
    const { userId, blocked } = blockSchema.parse(req.body);
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);

    const { error } = await sb.auth.admin.updateUserById(userId, {
      ban_duration: blocked ? '876600h' : 'none', // ~100 years or unban
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, blocked });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to update user' });
  }
});

// ─── Get User Auth Status (banned, confirmed, etc.) ──────────────
const userStatusSchema = z.object({
  userId: z.string().uuid(),
});

adminRouter.post('/user-status', async (req, res) => {
  try {
    const { userId } = userStatusSchema.parse(req.body);
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);

    const { data: { user }, error } = await sb.auth.admin.getUserById(userId);

    if (error || !user) {
      return res.status(400).json({ error: error?.message || 'User not found' });
    }

    res.json({
      id: user.id,
      email: user.email,
      email_confirmed_at: user.email_confirmed_at,
      banned_until: user.banned_until,
      last_sign_in_at: user.last_sign_in_at,
      created_at: user.created_at,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to get user status' });
  }
});

// ─── Impersonate User (generate magic link) ──────────────────────
const impersonateSchema = z.object({
  userId: z.string().uuid(),
});

adminRouter.post('/impersonate', async (req, res) => {
  try {
    const { userId } = impersonateSchema.parse(req.body);
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);

    // Get user email
    const { data: { user }, error: userErr } = await sb.auth.admin.getUserById(userId);
    if (userErr || !user?.email) {
      return res.status(400).json({ error: userErr?.message || 'User not found' });
    }

    // Generate a magic link for the user
    const { data, error } = await sb.auth.admin.generateLink({
      type: 'magiclink',
      email: user.email,
    });

    if (error || !data) {
      return res.status(400).json({ error: error?.message || 'Failed to generate link' });
    }

    // Build the verification URL using the hashed_token
    const redirectBase = await resolveAppBaseUrl(config, req);
    if (!redirectBase) {
      return res.status(500).json({
        error: 'app_base_url_unconfigured',
        message: 'Configure platform_domains.app_base_url or APP_BASE_URL before impersonating.',
      });
    }
    const verifyUrl = `${config.supabaseUrl}/auth/v1/verify?token=${data.properties.hashed_token}&type=magiclink&redirect_to=${encodeURIComponent(redirectBase + '/app')}`;

    res.json({ url: verifyUrl });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to impersonate user' });
  }
});

// ─── Remove a user's avatar (super admin) ────────────────────────
// Mirrors DELETE /api/account/avatar but acts on any user. The stored
// object is removed through the active storage provider, then the
// profile column is cleared.
adminRouter.delete('/users/:userId/avatar', async (req, res) => {
  try {
    const userId = z.string().uuid().parse(req.params.userId);
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);

    const { data: profile, error: profileError } = await sb
      .from('profiles')
      .select('avatar_url')
      .eq('id', userId)
      .maybeSingle();
    if (profileError) return res.status(500).json({ error: profileError.message });
    if (!profile) return res.status(404).json({ error: 'user_not_found' });

    const prev = profile.avatar_url;
    if (prev && typeof prev === 'string') {
      const { data: membership } = await sb
        .from('workspace_members')
        .select('workspace_id')
        .eq('user_id', userId)
        .limit(1)
        .maybeSingle();
      const workspaceId = membership?.workspace_id;
      const marker = `/avatars/${userId}/`;
      const idx = prev.indexOf(marker);
      if (workspaceId && idx >= 0) {
        const oldKey = prev.slice(idx + 1);
        if (oldKey) await deleteFile(config, workspaceId, oldKey).catch(() => undefined);
      }
    }

    const { error: updateError } = await sb
      .from('profiles')
      .update({ avatar_url: null, updated_at: new Date().toISOString() })
      .eq('id', userId);
    if (updateError) return res.status(500).json({ error: updateError.message });

    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to remove avatar' });
  }
});

// ─── Sent messages (emails + SMS) for a user ─────────────────────

// ─── Edit a user's profile / identity (super admin) ──────────────
const adminProfilePatchSchema = z.object({
  full_name: z.string().trim().max(120).nullable().optional(),
  company_name: z.string().trim().max(160).nullable().optional(),
  website_domain: z.string().trim().max(255).nullable().optional(),
  preferred_locale: z.enum(['fa', 'en', 'tr']).nullable().optional(),
  email: z.string().trim().email().max(255).optional(),
});

adminRouter.patch('/users/:userId/profile', async (req, res) => {
  try {
    const userId = z.string().uuid().parse(req.params.userId);
    const body = adminProfilePatchSchema.parse(req.body ?? {});
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of ['full_name', 'company_name', 'website_domain', 'preferred_locale'] as const) {
      if (key in body) patch[key] = (body as any)[key] || null;
    }

    if (body.email) {
      const nextEmail = body.email.toLowerCase();
      const { error: authErr } = await sb.auth.admin.updateUserById(userId, { email: nextEmail });
      if (authErr) return res.status(400).json({ error: authErr.message });
      patch.email = nextEmail;
    }

    const { error } = await sb.from('profiles').update(patch).eq('id', userId);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to update user' });
  }
});

// ─── Force-confirm (or unconfirm) a user's email ─────────────────
adminRouter.post('/users/:userId/email-verification', async (req, res) => {
  try {
    const userId = z.string().uuid().parse(req.params.userId);
    const { verified } = z.object({ verified: z.boolean() }).parse(req.body ?? {});
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);

    const { error } = verified
      ? await sb.auth.admin.updateUserById(userId, { email_confirm: true })
      : await sb.auth.admin.updateUserById(userId, { email_confirm: false } as any);
    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true, verified });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to update email verification' });
  }
});

// ─── Set / edit a user's phone number (super admin) ──────────────
// Storing a new number always resets verification: the admin must either
// send an SMS challenge or manually verify with a reason afterwards.
adminRouter.put('/users/:userId/phone', async (req, res) => {
  try {
    const userId = z.string().uuid().parse(req.params.userId);
    const { phone, country } = z
      .object({ phone: z.string().trim().min(4).max(32), country: z.string().trim().min(2).max(2).default('IR') })
      .parse(req.body ?? {});
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);

    const normalized = normalizePhoneToE164(phone, country.toUpperCase());
    if (normalized.ok !== true) return res.status(400).json({ error: normalized.reason });

    const now = new Date().toISOString();
    const { error } = await sb.from('user_phone_verifications').upsert(
      {
        user_id: userId,
        phone_e164: normalized.e164,
        country_code: normalized.country,
        phone_verified_at: null,
        verification_method: null,
        verified_by_admin_id: null,
        manual_verification_reason: null,
        updated_at: now,
      },
      { onConflict: 'user_id' },
    );
    if (error) return res.status(500).json({ error: error.message });

    res.json({ success: true, phone: normalized.e164, country: normalized.country });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to save phone' });
  }
});

adminRouter.delete('/users/:userId/phone', async (req, res) => {
  try {
    const userId = z.string().uuid().parse(req.params.userId);
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const { error } = await sb.from('user_phone_verifications').delete().eq('user_id', userId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to remove phone' });
  }
});

// Emails come from `email_logs` (matched on the profile's email address),
// SMS from `phone_verification_challenges` (delivery metadata only — the
// code digest and full number are never returned).
adminRouter.get('/users/:userId/messages', async (req, res) => {
  try {
    const userId = z.string().uuid().parse(req.params.userId);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);

    const { data: profile } = await sb
      .from('profiles')
      .select('email')
      .eq('id', userId)
      .maybeSingle();

    const email = profile?.email?.trim().toLowerCase() || null;

    const emailsQuery = email
      ? sb
          .from('email_logs')
          .select('id, template_slug, recipient_email, subject, status, provider_name, error_message, metadata, created_at, sent_at')
          .ilike('recipient_email', email)
          .order('created_at', { ascending: false })
          .limit(limit)
      : null;

    const [emailsRes, smsRes] = await Promise.all([
      emailsQuery ? emailsQuery : Promise.resolve({ data: [], error: null } as any),
      sb
        .from('phone_verification_challenges')
        .select('id, purpose, delivery_status, provider_name, provider_message_id, created_by, sent_at, created_at, consumed_at, expires_at, phone_e164')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit),
    ]);

    if (emailsRes.error) return res.status(500).json({ error: emailsRes.error.message });
    if (smsRes.error) return res.status(500).json({ error: smsRes.error.message });

    const maskPhone = (p: string | null) => {
      if (!p) return null;
      const digits = p.replace(/[^\d+]/g, '');
      if (digits.length <= 5) return digits;
      return `${digits.slice(0, 4)}****${digits.slice(-3)}`;
    };

    res.json({
      emails: emailsRes.data ?? [],
      sms: (smsRes.data ?? []).map((s: any) => ({
        id: s.id,
        purpose: s.purpose,
        delivery_status: s.delivery_status,
        provider_name: s.provider_name,
        provider_message_id: s.provider_message_id,
        created_by: s.created_by,
        sent_at: s.sent_at,
        created_at: s.created_at,
        consumed_at: s.consumed_at,
        expires_at: s.expires_at,
        phone_masked: maskPhone(s.phone_e164 ?? null),
      })),
    });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to load messages' });
  }
});

// ─── Financial overview for a user (payments, events, plan history) ───
adminRouter.get('/users/:userId/billing', async (req, res) => {
  try {
    const userId = z.string().uuid().parse(req.params.userId);
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);

    const { data: memberships, error: memErr } = await sb
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', userId);
    if (memErr) return res.status(500).json({ error: memErr.message });

    const workspaceIds = Array.from(new Set((memberships ?? []).map((m: any) => m.workspace_id))).filter(Boolean);
    if (workspaceIds.length === 0) {
      return res.json({ payments: [], events: [], subscriptions: [], planChanges: [], workspaces: [], plans: [], gateways: [] });
    }

    const [wsRes, payRes, evRes, subRes, chgRes, planRes, gwRes] = await Promise.all([
      sb.from('workspaces').select('id, name, slug').in('id', workspaceIds),
      sb.from('billing_payments')
        .select('id, workspace_id, provider_name, provider_payment_id, amount, currency, status, refund_amount, metadata, created_at')
        .in('workspace_id', workspaceIds).order('created_at', { ascending: false }).limit(limit),
      sb.from('billing_events')
        .select('id, workspace_id, event_type, provider_name, provider_event_id, amount, currency, status, metadata, processed_at, created_at')
        .in('workspace_id', workspaceIds).order('created_at', { ascending: false }).limit(limit),
      sb.from('workspace_subscriptions')
        .select('id, workspace_id, plan_id, provider_name, provider_subscription_id, provider_customer_id, status, cancel_at_period_end, current_period_start, current_period_end, trial_end, created_at, updated_at')
        .in('workspace_id', workspaceIds),
      sb.from('plan_change_log')
        .select('id, workspace_id, old_plan_id, new_plan_id, change_type, changed_by, metadata, created_at')
        .in('workspace_id', workspaceIds).order('created_at', { ascending: false }).limit(limit),
      sb.from('billing_plans').select('id, name, slug, localized'),
      sb.from('provider_configs')
        .select('id, workspace_id, provider_type, provider_name, config, is_active, created_at, updated_at')
        .in('workspace_id', workspaceIds)
        .in('provider_type', ['billing', 'payment', 'payments']),
    ]);

    const firstError = [wsRes, payRes, evRes, subRes, chgRes, planRes, gwRes].find((r: any) => r.error);
    if (firstError) return res.status(500).json({ error: (firstError as any).error.message });

    // Never leak provider secrets — only expose which config keys are set.
    const SECRET_KEY_RE = /(secret|key|token|password|pin|signature)/i;
    const gateways = (gwRes.data ?? []).map((g: any) => {
      const cfg = (g.config ?? {}) as Record<string, unknown>;
      return {
        id: g.id,
        workspace_id: g.workspace_id,
        provider_type: g.provider_type,
        provider_name: g.provider_name,
        is_active: g.is_active,
        created_at: g.created_at,
        updated_at: g.updated_at,
        config_summary: Object.keys(cfg).map((k) => ({
          key: k,
          value: SECRET_KEY_RE.test(k)
            ? (cfg[k] ? '••••••' : null)
            : typeof cfg[k] === 'object'
              ? JSON.stringify(cfg[k])
              : cfg[k] == null ? null : String(cfg[k]),
        })),
      };
    });

    res.json({
      workspaces: wsRes.data ?? [],
      payments: payRes.data ?? [],
      events: evRes.data ?? [],
      subscriptions: subRes.data ?? [],
      planChanges: chgRes.data ?? [],
      plans: planRes.data ?? [],
      gateways,
    });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to load billing data' });
  }
});
