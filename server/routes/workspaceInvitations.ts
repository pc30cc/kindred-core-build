/**
 * WORKSPACE INVITATIONS v5.1 — canonical Express API.
 *
 * Architecture rules honoured here:
 *   - Express/self-hosted only. No Supabase Edge Functions.
 *   - Every mutation is ONE service_role RPC executing a single transaction in
 *     the canonical lock order. Express never sequences independent writes.
 *   - No route accepts an invitation token, OTP or proof in a query string or
 *     a path parameter (v5.1 §5.5, §10). Tokens arrive in a JSON body, proofs
 *     and login contexts in HttpOnly cookies.
 *   - Public failures collapse to a uniform INVITATION_NOT_FOUND.
 */

import { Router } from 'express';
import { z } from 'zod';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import crypto from 'node:crypto';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requireUser as requireSessionUser } from '../lib/workspaceAuth.js';
import {
  createSession,
  setSessionCookie,
  validateSessionToken,
  verifyOriginForMutation,
  SESSION_COOKIE_NAME,
} from '../services/auth/sessions.js';
import { hashPassword } from '../services/auth/password.js';
import { allowedOrigins } from '../services/platformOrigins.js';
import { getClientIp, hashIp } from '../utils/clientIp.js';
import {
  sha256Hex,
  randomToken,
  tokenPrefix,
  generateOtpCode,
  otpDigest,
  destinationHash,
  resolveAppBaseUrl,
  buildInviteUrl,
  MANUAL_TOKEN_TTL_MS,
  OTP_TTL_MS,
  PROOF_TTL_MS,
  CONTEXT_TTL_MS,
  PROOF_COOKIE_NAME,
  CONTEXT_COOKIE_NAME,
} from '../services/invitations/tokens.js';

export const workspaceInvitationsRouter = Router();

const PUBLIC_ERROR = { error: 'INVITATION_NOT_FOUND' };

const PURPOSES = ['email_claim', 'manual_handoff'] as const;
type Purpose = (typeof PURPOSES)[number];

// ── Helpers ─────────────────────────────────────────────────────────────

function cfg(req: any): ServerConfig {
  return req.serverConfig as ServerConfig;
}

function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Strict same-origin enforcement for every mutating invitation route. */
function requireOrigin(req: any, res: any, next: any) {
  const config = cfg(req);
  if (!verifyOriginForMutation(req, allowedOrigins(config))) {
    return res.status(403).json({ error: 'FORBIDDEN_ORIGIN' });
  }
  if (req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) {
    return res.status(415).json({ error: 'UNSUPPORTED_MEDIA_TYPE' });
  }
  next();
}

/** Any token passed as a query/path parameter is a protocol violation. */
function rejectTokenInUrl(req: any, res: any, next: any) {
  const q = req.query || {};
  if (q.token || q.proof || q.otp || q.code || q.handle) {
    return res.status(404).json(PUBLIC_ERROR);
  }
  next();
}

async function requireUser(req: any, res: any, next: any) {
  const userId = await requireSessionUser(req, res);
  if (!userId) return;
  req.authUser = { id: userId };
  next();
}

function mapRpcError(message: string | undefined): { status: number; code: string } {
  const raw = String(message || '');
  const known = [
    'INVITATION_DUPLICATE', 'INVITATION_NOT_PENDING', 'ACCOUNT_EXISTS_LOGIN_REQUIRED',
    'ACCOUNT_DISABLED', 'EMAIL_PROOF_REQUIRED', 'OTP_INVALID', 'OTP_RATE_LIMITED',
    'CONSENT_REQUIRED', 'SEAT_LIMIT_REACHED', 'ENTITLEMENT_UNAVAILABLE',
    'FORBIDDEN_ROLE_ESCALATION', 'INVITATION_NOT_FOUND', 'WORKSPACE_NOT_FOUND',
    'WRONG_ACCOUNT', 'SESSION_REQUIRED', 'PASSWORD_REQUIRED', 'INVALID_MEMBER_TYPE',
    'STAFF_INVITATION_MUST_HAVE_NO_DEPARTMENT', 'CUSTOMER_FACING_INVITATION_REQUIRES_DEPARTMENT',
    'REVOKE_REASON_REQUIRED', 'JOB_CLAIM_LOST', 'OWNER_PROTECTED',
  ];
  const code = known.find((k) => raw.includes(k));
  if (!code) return { status: 500, code: 'INTERNAL_ERROR' };
  const statusByCode: Record<string, number> = {
    INVITATION_DUPLICATE: 409,
    SEAT_LIMIT_REACHED: 409,
    ENTITLEMENT_UNAVAILABLE: 503,
    FORBIDDEN_ROLE_ESCALATION: 403,
    OWNER_PROTECTED: 403,
    ACCOUNT_DISABLED: 403,
    WRONG_ACCOUNT: 403,
    INVITATION_NOT_FOUND: 404,
    WORKSPACE_NOT_FOUND: 404,
    OTP_RATE_LIMITED: 429,
  };
  return { status: statusByCode[code] ?? 400, code };
}

/** Idempotency envelope — never stores tokens, proofs, OTPs or passwords. */
async function withIdempotency<T>(
  config: ServerConfig,
  key: string | null,
  scope: { scopeKind: string; operation: string; workspaceId?: string | null; invitationId?: string | null },
  run: () => Promise<T>,
): Promise<{ replayed: boolean; result: T | null; state?: string }> {
  if (!key) return { replayed: false, result: await run() };

  const sb = getServiceClient(config);
  const digestKey = sha256Hex(key);

  const { error: insertError } = await sb.from('workspace_invitation_idempotency').insert({
    key: digestKey,
    scope_kind: scope.scopeKind,
    operation: scope.operation,
    workspace_id: scope.workspaceId ?? null,
    invitation_id: scope.invitationId ?? null,
    result_state: 'in_progress',
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });

  if (insertError) {
    const { data: existing } = await sb
      .from('workspace_invitation_idempotency')
      .select('result_state, invitation_id')
      .eq('key', digestKey)
      .maybeSingle();
    return { replayed: true, result: null, state: existing?.result_state || 'unknown' };
  }

  const result = await run();
  await sb
    .from('workspace_invitation_idempotency')
    .update({ result_state: 'committed' })
    .eq('key', digestKey);
  return { replayed: false, result };
}

async function activePolicyVersions(config: ServerConfig, locale: string) {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('legal_policy_versions')
    .select('id, policy_type, version, locale, document_url, effective_from')
    .eq('is_active', true)
    .lte('effective_from', new Date().toISOString())
    .order('effective_from', { ascending: false });

  const pick = (type: string) =>
    (data || []).find((r: any) => r.policy_type === type && r.locale === locale)
    || (data || []).find((r: any) => r.policy_type === type && r.locale === 'en')
    || (data || []).find((r: any) => r.policy_type === type)
    || null;

  return { terms: pick('terms'), privacy: pick('privacy') };
}

// ── Rate limiters (public surface) ──────────────────────────────────────

const publicLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `wi:${ipKeyGenerator(req.ip || '')}`,
});

const otpLimiter = rateLimit({
  windowMs: 60_000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `wi-otp:${ipKeyGenerator(req.ip || '')}`,
});

const acceptLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `wi-accept:${ipKeyGenerator(req.ip || '')}`,
});

// ─────────────────────────────────────────────────────────────────────────
// MANAGEMENT SURFACE (owner/admin, gs_session)
// ─────────────────────────────────────────────────────────────────────────

const createSchema = z.object({
  workspaceId: z.string().uuid(),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/),
  memberType: z.enum(['staff', 'customer_facing']),
  role: z.string().trim().min(1).max(40),
  departmentIds: z.array(z.string().uuid()).max(50).optional(),
  jobTitle: z.string().trim().max(120).optional().nullable(),
  staffCode: z.string().trim().max(60).optional().nullable(),
  expiresInDays: z.number().int().min(1).max(30).optional(),
  requestId: z.string().trim().min(8).max(120).optional(),
});

workspaceInvitationsRouter.post('/', requireOrigin, rejectTokenInUrl, requireUser, async (req: any, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const body = parsed.data;
  const config = cfg(req);
  const sb = getServiceClient(config);

  const email = body.email.toLowerCase();
  const manualToken = randomToken();
  const expiresAt = new Date(Date.now() + (body.expiresInDays ?? 7) * 24 * 60 * 60 * 1000);
  const nonce = body.requestId || crypto.randomUUID();

  const outcome = await withIdempotency(
    config,
    body.requestId ? `${req.authUser.id}|${body.workspaceId}|create|${body.requestId}` : null,
    { scopeKind: 'workspace', operation: 'create', workspaceId: body.workspaceId },
    async () => sb.rpc('create_workspace_invitation_v2', {
      _workspace_id: body.workspaceId,
      _actor_id: req.authUser.id,
      _first_name: body.firstName,
      _last_name: body.lastName,
      _email_normalized: email,
      _phone_e164: body.phone,
      _member_type: body.memberType,
      _role: body.role,
      _expires_at: expiresAt.toISOString(),
      _department_ids: body.departmentIds ?? null,
      _manual_token_hash: sha256Hex(manualToken),
      _manual_token_prefix: tokenPrefix(manualToken),
      _manual_token_expires_at: new Date(Date.now() + MANUAL_TOKEN_TTL_MS).toISOString(),
      _email_job_idempotency_key: sha256Hex(`email|${body.workspaceId}|${email}|${nonce}`),
      _sms_job_idempotency_key: sha256Hex(`sms|${body.workspaceId}|${body.phone}|${nonce}`),
      _email_destination_hash: destinationHash(email),
      _sms_destination_hash: destinationHash(body.phone),
      _job_title: body.jobTitle ?? null,
      _staff_code: body.staffCode ?? null,
    }),
  );

  if (outcome.replayed) {
    return res.status(409).json({ error: 'OPERATION_COMMITTED_LINK_NOT_REPLAYABLE' });
  }

  const { data, error } = outcome.result as any;
  if (error) {
    const mapped = mapRpcError(error.message);
    return res.status(mapped.status).json({ error: mapped.code });
  }

  const appBase = await resolveAppBaseUrl(config);
  // The raw manual link is returned EXACTLY ONCE and never stored or logged.
  return res.status(201).json({
    invitation: data,
    manualLink: buildInviteUrl(appBase, manualToken, 'manual_handoff'),
  });
});

workspaceInvitationsRouter.get('/', rejectTokenInUrl, requireUser, async (req: any, res) => {
  const workspaceId = String(req.query.workspaceId || '');
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) return res.status(400).json({ error: 'invalid_workspace' });
  const includeArchived = String(req.query.archived || '') === '1';
  const config = cfg(req);
  const sb = getServiceClient(config);

  const { data: member } = await sb
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', req.authUser.id)
    .maybeSingle();
  if (!member || !['owner', 'admin'].includes(String(member.role))) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  await sb.rpc('expire_invitations_v2', { _limit: 200 });

  let query = sb
    .from('workspace_invitations')
    .select('id, workspace_id, status, role, member_type, first_name, last_name, invited_email_normalized, invited_phone_e164, job_title, staff_code, expires_at, created_at, accepted_at, revoked_at, revoked_reason, archived_at, notification_generation')
    .eq('workspace_id', workspaceId)
    .eq('invitation_flow_version', 2)
    .order('created_at', { ascending: false })
    .limit(200);
  if (!includeArchived) query = query.is('archived_at', null);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'INTERNAL_ERROR' });
  return res.json({ invitations: data || [] });
});

workspaceInvitationsRouter.get('/:id', rejectTokenInUrl, requireUser, async (req: any, res) => {
  const config = cfg(req);
  const sb = getServiceClient(config);
  const id = String(req.params.id);

  const { data: inv } = await sb
    .from('workspace_invitations')
    .select('*')
    .eq('id', id)
    .eq('invitation_flow_version', 2)
    .maybeSingle();
  if (!inv) return res.status(404).json({ error: 'INVITATION_NOT_FOUND' });

  const { data: member } = await sb
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', inv.workspace_id)
    .eq('user_id', req.authUser.id)
    .maybeSingle();
  if (!member || !['owner', 'admin'].includes(String(member.role))) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const [{ data: safe }, { data: deliveries }, { data: departments }] = await Promise.all([
    sb.rpc('wi_safe_invitation', { _invitation_id: id }),
    sb.from('workspace_invitation_deliveries')
      .select('id, channel, status, attempt_number, provider_name, error_code, safe_error_message, created_at, provider_accepted_at, sent_at, delivered_at, failed_at')
      .eq('invitation_id', id)
      .order('created_at', { ascending: false })
      .limit(50),
    sb.from('workspace_invitation_departments').select('department_id').eq('invitation_id', id),
  ]);

  return res.json({
    invitation: safe,
    deliveries: deliveries || [],
    departmentIds: (departments || []).map((d: any) => d.department_id),
  });
});

const editSchema = createSchema.omit({ workspaceId: true, requestId: true }).extend({
  requestId: z.string().trim().min(8).max(120).optional(),
});

workspaceInvitationsRouter.patch('/:id', requireOrigin, rejectTokenInUrl, requireUser, async (req: any, res) => {
  const parsed = editSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const body = parsed.data;
  const config = cfg(req);
  const sb = getServiceClient(config);
  const id = String(req.params.id);
  const email = body.email.toLowerCase();
  const nonce = body.requestId || crypto.randomUUID();

  const { data, error } = await sb.rpc('edit_workspace_invitation_v2', {
    _invitation_id: id,
    _actor_id: req.authUser.id,
    _first_name: body.firstName,
    _last_name: body.lastName,
    _email_normalized: email,
    _phone_e164: body.phone,
    _member_type: body.memberType,
    _role: body.role,
    _expires_at: new Date(Date.now() + (body.expiresInDays ?? 7) * 24 * 60 * 60 * 1000).toISOString(),
    _department_ids: body.departmentIds ?? null,
    _email_job_idempotency_key: sha256Hex(`email|${id}|${email}|${nonce}`),
    _sms_job_idempotency_key: sha256Hex(`sms|${id}|${body.phone}|${nonce}`),
    _email_destination_hash: destinationHash(email),
    _sms_destination_hash: destinationHash(body.phone),
    _job_title: body.jobTitle ?? null,
    _staff_code: body.staffCode ?? null,
  });

  if (error) {
    const mapped = mapRpcError(error.message);
    return res.status(mapped.status).json({ error: mapped.code });
  }
  return res.json({ invitation: data });
});

workspaceInvitationsRouter.post('/:id/resend', requireOrigin, rejectTokenInUrl, requireUser, async (req: any, res) => {
  const config = cfg(req);
  const sb = getServiceClient(config);
  const id = String(req.params.id);
  const nonce = String(req.body?.requestId || crypto.randomUUID());

  const { data: inv } = await sb
    .from('workspace_invitations')
    .select('invited_email_normalized')
    .eq('id', id)
    .maybeSingle();
  if (!inv) return res.status(404).json({ error: 'INVITATION_NOT_FOUND' });

  const { data, error } = await sb.rpc('resend_invitation_email_v2', {
    _invitation_id: id,
    _actor_id: req.authUser.id,
    _job_idempotency_key: sha256Hex(`email|${id}|resend|${nonce}`),
    _destination_hash: destinationHash(String(inv.invited_email_normalized)),
  });
  if (error) {
    const mapped = mapRpcError(error.message);
    return res.status(mapped.status).json({ error: mapped.code });
  }
  return res.json(data);
});

workspaceInvitationsRouter.post('/:id/rotate-link', requireOrigin, rejectTokenInUrl, requireUser, async (req: any, res) => {
  const config = cfg(req);
  const sb = getServiceClient(config);
  const id = String(req.params.id);
  const manualToken = randomToken();

  const { data, error } = await sb.rpc('rotate_manual_link_v2', {
    _invitation_id: id,
    _actor_id: req.authUser.id,
    _token_hash: sha256Hex(manualToken),
    _token_prefix: tokenPrefix(manualToken),
    _token_expires_at: new Date(Date.now() + MANUAL_TOKEN_TTL_MS).toISOString(),
  });
  if (error) {
    const mapped = mapRpcError(error.message);
    return res.status(mapped.status).json({ error: mapped.code });
  }

  const appBase = await resolveAppBaseUrl(config);
  return res.json({ ...(data as any), manualLink: buildInviteUrl(appBase, manualToken, 'manual_handoff') });
});

workspaceInvitationsRouter.post('/:id/revoke', requireOrigin, rejectTokenInUrl, requireUser, async (req: any, res) => {
  const config = cfg(req);
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'REVOKE_REASON_REQUIRED' });
  const { data, error } = await getServiceClient(config).rpc('revoke_invitation_v2', {
    _invitation_id: String(req.params.id),
    _actor_id: req.authUser.id,
    _reason: reason,
  });
  if (error) {
    const mapped = mapRpcError(error.message);
    return res.status(mapped.status).json({ error: mapped.code });
  }
  return res.json({ invitation: data });
});

workspaceInvitationsRouter.post('/:id/archive', requireOrigin, rejectTokenInUrl, requireUser, async (req: any, res) => {
  const { data, error } = await getServiceClient(cfg(req)).rpc('archive_invitation_v2', {
    _invitation_id: String(req.params.id),
    _actor_id: req.authUser.id,
  });
  if (error) {
    const mapped = mapRpcError(error.message);
    return res.status(mapped.status).json({ error: mapped.code });
  }
  return res.json({ invitation: data });
});

// ─────────────────────────────────────────────────────────────────────────
// PUBLIC SURFACE (token possession — JSON body only)
// ─────────────────────────────────────────────────────────────────────────

const tokenBody = z.object({
  token: z.string().trim().min(20).max(512),
  purpose: z.enum(PURPOSES),
});

function tokenHashOf(token: string): string {
  return sha256Hex(token);
}

workspaceInvitationsRouter.post('/preview', requireOrigin, rejectTokenInUrl, publicLimiter, async (req: any, res) => {
  const parsed = tokenBody.safeParse(req.body);
  if (!parsed.success) return res.status(404).json(PUBLIC_ERROR);
  const config = cfg(req);

  const { data, error } = await getServiceClient(config).rpc('wi_preview_invitation', {
    _token_hash: tokenHashOf(parsed.data.token),
    _purpose: parsed.data.purpose,
  });
  if (error || !data) return res.status(404).json(PUBLIC_ERROR);

  const locale = String(req.body?.locale || 'en');
  const policies = await activePolicyVersions(config, locale);

  return res.json({ preview: data, policies });
});

workspaceInvitationsRouter.post('/login-context', requireOrigin, rejectTokenInUrl, publicLimiter, async (req: any, res) => {
  const parsed = tokenBody.safeParse(req.body);
  if (!parsed.success) return res.status(404).json(PUBLIC_ERROR);
  const config = cfg(req);

  const handle = randomToken();
  const { data, error } = await getServiceClient(config).rpc('wi_create_login_context', {
    _token_hash: tokenHashOf(parsed.data.token),
    _purpose: parsed.data.purpose,
    _handle_hash: sha256Hex(handle),
    _expires_at: new Date(Date.now() + CONTEXT_TTL_MS).toISOString(),
  });
  if (error || !data) return res.status(404).json(PUBLIC_ERROR);

  res.cookie(CONTEXT_COOKIE_NAME, handle, {
    httpOnly: true,
    secure: isProd(),
    sameSite: 'lax',
    path: '/',
    maxAge: CONTEXT_TTL_MS,
  });

  // The redirect URL carries NO token and no invitation secret.
  return res.json({ invitationId: (data as any).invitation_id, loginPath: '/auth/login?invited=1' });
});

workspaceInvitationsRouter.post('/otp/request', requireOrigin, rejectTokenInUrl, otpLimiter, async (req: any, res) => {
  const parsed = tokenBody.safeParse(req.body);
  if (!parsed.success || parsed.data.purpose !== 'manual_handoff') return res.status(404).json(PUBLIC_ERROR);
  const config = cfg(req);
  const sb = getServiceClient(config);

  const invitationHash = tokenHashOf(parsed.data.token);
  const code = generateOtpCode();

  // The digest is bound to the invitation id, so it is computed after the RPC
  // resolves the invitation — a two-step that never persists the raw code.
  const { data: probe, error: probeError } = await sb.rpc('wi_preview_invitation', {
    _token_hash: invitationHash,
    _purpose: 'manual_handoff',
  });
  if (probeError || !probe) return res.status(404).json(PUBLIC_ERROR);

  const { data, error } = await sb.rpc('wi_request_invitation_otp', {
    _token_hash: invitationHash,
    _code_digest: otpDigest(String((probe as any).invitation_id), code),
    _expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    _ip_hash: hashIp(getClientIp(req)),
  });
  if (error) {
    const mapped = mapRpcError(error.message);
    // Uniform response: never reveal invitation/account existence.
    if (mapped.code === 'OTP_RATE_LIMITED') return res.status(429).json({ error: 'OTP_RATE_LIMITED' });
    return res.status(404).json(PUBLIC_ERROR);
  }

  try {
    const { sendEmail } = await import('../services/email/index.js');
    await sendEmail(config, {
      workspaceId: String((data as any).workspace_id),
      to: String((data as any).email_normalized),
      subject: 'Your verification code',
      text: `Verification code: ${code}\nIt expires in 10 minutes.`,
      html: `<p>Verification code: <strong>${code}</strong></p><p>It expires in 10 minutes.</p>`,
    });
  } catch {
    // Delivery problems never leak invitation state to the caller.
  }

  return res.json({ ok: true, expiresInSeconds: Math.floor(OTP_TTL_MS / 1000) });
});

const otpVerifySchema = tokenBody.extend({ code: z.string().trim().regex(/^\d{6}$/) });

workspaceInvitationsRouter.post('/otp/verify', requireOrigin, rejectTokenInUrl, otpLimiter, async (req: any, res) => {
  const parsed = otpVerifySchema.safeParse(req.body);
  if (!parsed.success || parsed.data.purpose !== 'manual_handoff') return res.status(404).json(PUBLIC_ERROR);
  const config = cfg(req);
  const sb = getServiceClient(config);
  const invitationHash = tokenHashOf(parsed.data.token);

  const { data: probe, error: probeError } = await sb.rpc('wi_preview_invitation', {
    _token_hash: invitationHash,
    _purpose: 'manual_handoff',
  });
  if (probeError || !probe) return res.status(404).json(PUBLIC_ERROR);

  const proof = randomToken();
  const { error } = await sb.rpc('wi_verify_invitation_otp', {
    _token_hash: invitationHash,
    _code_digest: otpDigest(String((probe as any).invitation_id), parsed.data.code),
    _proof_hash: sha256Hex(proof),
    _proof_expires_at: new Date(Date.now() + PROOF_TTL_MS).toISOString(),
  });
  if (error) {
    const mapped = mapRpcError(error.message);
    if (mapped.code === 'OTP_INVALID') return res.status(400).json({ error: 'OTP_INVALID' });
    if (mapped.code === 'OTP_RATE_LIMITED') return res.status(429).json({ error: 'OTP_RATE_LIMITED' });
    return res.status(404).json(PUBLIC_ERROR);
  }

  // The proof travels ONLY in an HttpOnly cookie — never in JSON or a URL.
  res.cookie(PROOF_COOKIE_NAME, proof, {
    httpOnly: true,
    secure: isProd(),
    sameSite: 'strict',
    path: '/api/workspace-invitations/accept-new',
    maxAge: PROOF_TTL_MS,
  });

  return res.json({ ok: true });
});

const acceptNewSchema = tokenBody.extend({
  password: z.string().min(10).max(200),
  consent: z.literal(true),
  termsVersionId: z.string().uuid(),
  privacyVersionId: z.string().uuid(),
  locale: z.string().trim().max(10).optional(),
});

workspaceInvitationsRouter.post('/accept-new', requireOrigin, rejectTokenInUrl, acceptLimiter, async (req: any, res) => {
  const parsed = acceptNewSchema.safeParse(req.body);
  if (!parsed.success) {
    const consentMissing = req.body?.consent !== true;
    return res.status(400).json({ error: consentMissing ? 'CONSENT_REQUIRED' : 'invalid_body' });
  }
  const body = parsed.data;
  const config = cfg(req);
  const sb = getServiceClient(config);

  const proofRaw = req.cookies?.[PROOF_COOKIE_NAME];
  if (body.purpose === 'manual_handoff' && !proofRaw) {
    return res.status(400).json({ error: 'EMAIL_PROOF_REQUIRED' });
  }

  const passwordHash = await hashPassword(body.password);

  const { data, error } = await sb.rpc('accept_invitation_new_user_v2', {
    _token_hash: tokenHashOf(body.token),
    _purpose: body.purpose,
    _proof_hash: proofRaw ? sha256Hex(String(proofRaw)) : null,
    _user_id: crypto.randomUUID(),
    _password_hash: passwordHash,
    _terms_version_id: body.termsVersionId,
    _privacy_version_id: body.privacyVersionId,
    _acceptance_method: body.purpose === 'manual_handoff' ? 'manual_handoff_otp' : 'email_claim',
    _locale: body.locale ?? null,
    _ip: getClientIp(req),
    _user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
  });

  res.clearCookie(PROOF_COOKIE_NAME, { path: '/api/workspace-invitations/accept-new' });

  if (error) {
    const mapped = mapRpcError(error.message);
    return res.status(mapped.status).json({ error: mapped.code });
  }

  const result = data as any;
  try {
    const { data: profile } = await sb.from('profiles').select('email').eq('id', result.user_id).maybeSingle();
    const session = await createSession(config, {
      userId: result.user_id,
      email: String(profile?.email || ''),
      ipAddress: getClientIp(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    });
    setSessionCookie(res, session.token, session.expiresAt);
  } catch {
    return res.status(200).json({ ...result, session: 'SESSION_CREATE_FAILED_LOGIN_REQUIRED' });
  }

  res.clearCookie(CONTEXT_COOKIE_NAME, { path: '/' });
  return res.json({ ...result, session: 'created' });
});

const acceptExistingSchema = z.object({
  token: z.string().trim().min(20).max(512).optional(),
  purpose: z.enum(PURPOSES).optional(),
  consent: z.literal(true),
  termsVersionId: z.string().uuid(),
  privacyVersionId: z.string().uuid(),
  locale: z.string().trim().max(10).optional(),
});

workspaceInvitationsRouter.post('/accept-existing', requireOrigin, rejectTokenInUrl, acceptLimiter, async (req: any, res) => {
  const parsed = acceptExistingSchema.safeParse(req.body);
  if (!parsed.success) {
    const consentMissing = req.body?.consent !== true;
    return res.status(400).json({ error: consentMissing ? 'CONSENT_REQUIRED' : 'invalid_body' });
  }
  const body = parsed.data;
  const config = cfg(req);
  const sb = getServiceClient(config);

  const session = await validateSessionToken(config, req.cookies?.[SESSION_COOKIE_NAME]);
  if (!session) return res.status(401).json({ error: 'SESSION_REQUIRED' });

  let tokenHash: string | null = null;
  let purpose: Purpose | null = null;

  if (body.token && body.purpose) {
    tokenHash = tokenHashOf(body.token);
    purpose = body.purpose;
  } else {
    const handle = req.cookies?.[CONTEXT_COOKIE_NAME];
    if (!handle) return res.status(404).json(PUBLIC_ERROR);
    const { data: ctx, error: ctxError } = await sb.rpc('wi_consume_login_context', {
      _handle_hash: sha256Hex(String(handle)),
    });
    if (ctxError || !ctx) {
      res.clearCookie(CONTEXT_COOKIE_NAME, { path: '/' });
      return res.status(404).json(PUBLIC_ERROR);
    }
    tokenHash = String((ctx as any).token_hash);
    purpose = (ctx as any).purpose as Purpose;
  }

  const { data, error } = await sb.rpc('accept_invitation_existing_user_v2', {
    _token_hash: tokenHash,
    _purpose: purpose,
    _session_user_id: session.userId,
    _session_email_normalized: session.email.toLowerCase(),
    _terms_version_id: body.termsVersionId,
    _privacy_version_id: body.privacyVersionId,
    _locale: body.locale ?? null,
    _ip: getClientIp(req),
    _user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
  });

  res.clearCookie(CONTEXT_COOKIE_NAME, { path: '/' });

  if (error) {
    const mapped = mapRpcError(error.message);
    return res.status(mapped.status).json({ error: mapped.code });
  }
  return res.json({ ...(data as any), session: 'existing' });
});
