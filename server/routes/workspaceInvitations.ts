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
import {
  runIdempotent,
  deriveScopedSecret,
  deriveDeterministicUuid,
} from '../services/invitations/idempotency.js';

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
    'IDEMPOTENCY_KEY_REUSED', 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_IN_PROGRESS',
    'IDEMPOTENCY_KEY_REQUIRED', 'IDEMPOTENCY_FINGERPRINT_REQUIRED',
    'IDEMPOTENCY_OPERATION_UNKNOWN',
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
    IDEMPOTENCY_KEY_REUSED: 409,
    IDEMPOTENCY_CONFLICT: 409,
    IDEMPOTENCY_IN_PROGRESS: 409,
  };
  return { status: statusByCode[code] ?? 400, code };
}

/**
 * requestId contract: every retryable mutation carries a client-generated,
 * stable UUID. Retrying the SAME action reuses it; a new action mints a new
 * one. The final ledger key is server-derived and scope-bound.
 */
const requestIdSchema = z.string().trim().uuid();

function readRequestId(req: any): string | null {
  const parsed = requestIdSchema.safeParse(req.body?.requestId);
  return parsed.success ? parsed.data : null;
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
  requestId: z.string().trim().uuid(),
});

workspaceInvitationsRouter.post('/', requireOrigin, rejectTokenInUrl, requireUser, async (req: any, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: req.body?.requestId ? 'invalid_body' : 'REQUEST_ID_REQUIRED' });
  }
  const body = parsed.data;
  const config = cfg(req);

  const email = body.email.toLowerCase();
  const manualToken = randomToken();
  const expiresAt = new Date(Date.now() + (body.expiresInDays ?? 7) * 24 * 60 * 60 * 1000);
  const nonce = body.requestId;
  const departmentIds = [...(body.departmentIds ?? [])].sort();

  const outcome = await runIdempotent(config, {
    operation: 'create',
    scopeKind: 'workspace',
    requestId: body.requestId,
    actorId: req.authUser.id,
    workspaceId: body.workspaceId,
    fingerprintInput: {
      workspaceId: body.workspaceId,
      email,
      phone: body.phone,
      memberType: body.memberType,
      role: body.role,
      departmentIds,
      firstName: body.firstName,
      lastName: body.lastName,
      jobTitle: body.jobTitle ?? null,
      staffCode: body.staffCode ?? null,
    },
    args: {
      first_name: body.firstName,
      last_name: body.lastName,
      email_normalized: email,
      phone_e164: body.phone,
      member_type: body.memberType,
      role: body.role,
      expires_at: expiresAt.toISOString(),
      department_ids: departmentIds,
      manual_token_hash: sha256Hex(manualToken),
      manual_token_prefix: tokenPrefix(manualToken),
      manual_token_expires_at: new Date(Date.now() + MANUAL_TOKEN_TTL_MS).toISOString(),
      email_job_idempotency_key: sha256Hex(`email|${body.workspaceId}|${email}|${nonce}`),
      sms_job_idempotency_key: sha256Hex(`sms|${body.workspaceId}|${body.phone}|${nonce}`),
      email_destination_hash: destinationHash(email),
      sms_destination_hash: destinationHash(body.phone),
      job_title: body.jobTitle ?? null,
      staff_code: body.staffCode ?? null,
    },
  });

  if (outcome.error) {
    const mapped = mapRpcError(outcome.error.message);
    return res.status(mapped.status).json({ error: mapped.code });
  }

  if (outcome.replayed) {
    // The raw link is never stored, so a committed create can only be
    // acknowledged — never replayed with a token.
    return res.status(409).json({
      error: 'OPERATION_COMMITTED_LINK_NOT_REPLAYABLE',
      replayed: true,
      invitation: outcome.safeResult,
    });
  }

  const appBase = await resolveAppBaseUrl(config);
  // The raw manual link is returned EXACTLY ONCE and never stored or logged.
  return res.status(201).json({
    invitation: outcome.result,
    manualLink: buildInviteUrl(appBase, manualToken, 'manual_handoff'),
    replayed: false,
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
    .select('id, workspace_id')
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

const editSchema = createSchema.omit({ workspaceId: true });

workspaceInvitationsRouter.patch('/:id', requireOrigin, rejectTokenInUrl, requireUser, async (req: any, res) => {
  const parsed = editSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: req.body?.requestId ? 'invalid_body' : 'REQUEST_ID_REQUIRED' });
  }
  const body = parsed.data;
  const config = cfg(req);
  const id = String(req.params.id);
  const email = body.email.toLowerCase();
  const nonce = body.requestId;
  const departmentIds = [...(body.departmentIds ?? [])].sort();

  const outcome = await runIdempotent(config, {
    operation: 'edit',
    scopeKind: 'invitation',
    requestId: body.requestId,
    actorId: req.authUser.id,
    invitationId: id,
    fingerprintInput: {
      invitationId: id,
      email,
      phone: body.phone,
      memberType: body.memberType,
      role: body.role,
      departmentIds,
      firstName: body.firstName,
      lastName: body.lastName,
      jobTitle: body.jobTitle ?? null,
      staffCode: body.staffCode ?? null,
    },
    args: {
      first_name: body.firstName,
      last_name: body.lastName,
      email_normalized: email,
      phone_e164: body.phone,
      member_type: body.memberType,
      role: body.role,
      expires_at: new Date(Date.now() + (body.expiresInDays ?? 7) * 24 * 60 * 60 * 1000).toISOString(),
      department_ids: departmentIds,
      email_job_idempotency_key: sha256Hex(`email|${id}|${email}|${nonce}`),
      sms_job_idempotency_key: sha256Hex(`sms|${id}|${body.phone}|${nonce}`),
      email_destination_hash: destinationHash(email),
      sms_destination_hash: destinationHash(body.phone),
      job_title: body.jobTitle ?? null,
      staff_code: body.staffCode ?? null,
    },
  });

  if (outcome.error) {
    const mapped = mapRpcError(outcome.error.message);
    return res.status(mapped.status).json({ error: mapped.code });
  }
  if (outcome.replayed) return res.json({ invitation: outcome.safeResult, replayed: true });
  return res.json({ invitation: outcome.result, replayed: false });
});

workspaceInvitationsRouter.post('/:id/resend', requireOrigin, rejectTokenInUrl, requireUser, async (req: any, res) => {
  const config = cfg(req);
  const sb = getServiceClient(config);
  const id = String(req.params.id);
  const requestId = readRequestId(req);
  if (!requestId) return res.status(400).json({ error: 'REQUEST_ID_REQUIRED' });

  const { data: inv } = await sb
    .from('workspace_invitations')
    .select('invited_email_normalized')
    .eq('id', id)
    .maybeSingle();
  if (!inv) return res.status(404).json({ error: 'INVITATION_NOT_FOUND' });

  const outcome = await runIdempotent(config, {
    operation: 'resend',
    scopeKind: 'invitation',
    requestId,
    actorId: req.authUser.id,
    invitationId: id,
    fingerprintInput: { invitationId: id },
    args: {
      job_idempotency_key: sha256Hex(`email|${id}|resend|${requestId}`),
      destination_hash: destinationHash(String(inv.invited_email_normalized)),
    },
  });

  if (outcome.error) {
    const mapped = mapRpcError(outcome.error.message);
    return res.status(mapped.status).json({ error: mapped.code });
  }
  if (outcome.replayed) return res.json({ ...outcome.safeResult, replayed: true });
  return res.json({ ...(outcome.result as any), replayed: false });
});

workspaceInvitationsRouter.post('/:id/rotate-link', requireOrigin, rejectTokenInUrl, requireUser, async (req: any, res) => {
  const config = cfg(req);
  const id = String(req.params.id);
  const manualToken = randomToken();
  const requestId = readRequestId(req);
  if (!requestId) return res.status(400).json({ error: 'REQUEST_ID_REQUIRED' });

  const outcome = await runIdempotent(config, {
    operation: 'rotate',
    scopeKind: 'invitation',
    requestId,
    actorId: req.authUser.id,
    invitationId: id,
    fingerprintInput: { invitationId: id },
    args: {
      token_hash: sha256Hex(manualToken),
      token_prefix: tokenPrefix(manualToken),
      token_expires_at: new Date(Date.now() + MANUAL_TOKEN_TTL_MS).toISOString(),
    },
  });

  if (outcome.error) {
    const mapped = mapRpcError(outcome.error.message);
    return res.status(mapped.status).json({ error: mapped.code });
  }
  if (outcome.replayed) {
    return res.status(409).json({
      error: 'OPERATION_COMMITTED_LINK_NOT_REPLAYABLE',
      replayed: true,
      invitation: outcome.safeResult,
    });
  }

  const appBase = await resolveAppBaseUrl(config);
  return res.json({
    ...(outcome.result as any),
    manualLink: buildInviteUrl(appBase, manualToken, 'manual_handoff'),
    replayed: false,
  });
});

workspaceInvitationsRouter.post('/:id/revoke', requireOrigin, rejectTokenInUrl, requireUser, async (req: any, res) => {
  const config = cfg(req);
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'REVOKE_REASON_REQUIRED' });
  const requestId = readRequestId(req);
  if (!requestId) return res.status(400).json({ error: 'REQUEST_ID_REQUIRED' });

  const outcome = await runIdempotent(config, {
    operation: 'revoke',
    scopeKind: 'invitation',
    requestId,
    actorId: req.authUser.id,
    invitationId: String(req.params.id),
    fingerprintInput: { invitationId: String(req.params.id), reason },
    args: { reason },
  });

  if (outcome.error) {
    const mapped = mapRpcError(outcome.error.message);
    return res.status(mapped.status).json({ error: mapped.code });
  }
  if (outcome.replayed) return res.json({ invitation: outcome.safeResult, replayed: true });
  return res.json({ invitation: outcome.result, replayed: false });
});

workspaceInvitationsRouter.post('/:id/archive', requireOrigin, rejectTokenInUrl, requireUser, async (req: any, res) => {
  const requestId = readRequestId(req);
  if (!requestId) return res.status(400).json({ error: 'REQUEST_ID_REQUIRED' });
  const config = cfg(req);

  const outcome = await runIdempotent(config, {
    operation: 'archive',
    scopeKind: 'invitation',
    requestId,
    actorId: req.authUser.id,
    invitationId: String(req.params.id),
    fingerprintInput: { invitationId: String(req.params.id) },
    args: {},
  });

  if (outcome.error) {
    const mapped = mapRpcError(outcome.error.message);
    return res.status(mapped.status).json({ error: mapped.code });
  }
  if (outcome.replayed) return res.json({ invitation: outcome.safeResult, replayed: true });
  return res.json({ invitation: outcome.result, replayed: false });
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
  const requestId = readRequestId(req);
  if (!parsed.success || !requestId) return res.status(404).json(PUBLIC_ERROR);
  const config = cfg(req);
  const tokenHash = tokenHashOf(parsed.data.token);

  // Deterministic handle: a retry with the same requestId re-derives the very
  // same raw cookie value, so a lost response can be recovered without a
  // second context row. The raw handle is never stored.
  const handle = deriveScopedSecret('login_context', requestId, tokenHash);

  const outcome = await runIdempotent(config, {
    operation: 'login_context',
    scopeKind: 'public',
    requestId,
    fingerprintInput: { tokenHash, purpose: parsed.data.purpose },
    args: {
      token_hash: tokenHash,
      purpose: parsed.data.purpose,
      handle_hash: sha256Hex(handle),
      expires_at: new Date(Date.now() + CONTEXT_TTL_MS).toISOString(),
    },
  });
  if (outcome.error) return res.status(404).json(PUBLIC_ERROR);

  res.cookie(CONTEXT_COOKIE_NAME, handle, {
    httpOnly: true,
    secure: isProd(),
    sameSite: 'lax',
    path: '/',
    maxAge: CONTEXT_TTL_MS,
  });

  const invitationId = outcome.replayed
    ? (outcome.safeResult as any).invitation_id
    : (outcome.result as any)?.invitation_id;

  // The redirect URL carries NO token and no invitation secret.
  return res.json({ invitationId, loginPath: '/auth/login?invited=1', replayed: outcome.replayed });
});

workspaceInvitationsRouter.post('/context-preview', requireOrigin, rejectTokenInUrl, publicLimiter, async (req: any, res) => {
  const handle = req.cookies?.[CONTEXT_COOKIE_NAME];
  if (!handle) return res.status(404).json(PUBLIC_ERROR);
  const config = cfg(req);
  const { data, error } = await getServiceClient(config).rpc('wi_preview_login_context', {
    _handle_hash: sha256Hex(String(handle)),
  });
  if (error || !data) return res.status(404).json(PUBLIC_ERROR);
  const policies = await activePolicyVersions(config, String(req.body?.locale || 'en'));
  return res.json({ preview: data, policies });
});

workspaceInvitationsRouter.post('/otp/request', requireOrigin, rejectTokenInUrl, otpLimiter, async (req: any, res) => {
  const parsed = tokenBody.safeParse(req.body);
  const requestId = readRequestId(req);
  if (!parsed.success || !requestId || parsed.data.purpose !== 'manual_handoff') return res.status(404).json(PUBLIC_ERROR);
  const config = cfg(req);
  const sb = getServiceClient(config);

  const invitationHash = tokenHashOf(parsed.data.token);
  const code = generateOtpCode();

  // Read-only probe: resolves the invitation id the digest is bound to. It
  // mutates nothing, so it stays outside the idempotent transaction.
  const { data: probe, error: probeError } = await sb.rpc('wi_preview_invitation', {
    _token_hash: invitationHash,
    _purpose: 'manual_handoff',
  });
  if (probeError || !probe) return res.status(404).json(PUBLIC_ERROR);

  const outcome = await runIdempotent(config, {
    operation: 'otp_request',
    scopeKind: 'public',
    requestId,
    invitationId: String((probe as any).invitation_id),
    fingerprintInput: { tokenHash: invitationHash },
    args: {
      token_hash: invitationHash,
      code_digest: otpDigest(String((probe as any).invitation_id), code),
      expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
      ip_hash: hashIp(getClientIp(req)),
    },
  });

  if (outcome.error) {
    const mapped = mapRpcError(outcome.error.message);
    // Uniform response: never reveal invitation/account existence.
    if (mapped.code === 'OTP_RATE_LIMITED') return res.status(429).json({ error: 'OTP_RATE_LIMITED' });
    return res.status(404).json(PUBLIC_ERROR);
  }

  // A replay must NOT send a second code: the first one is still the live one.
  if (!outcome.replayed) {
    try {
      const { sendEmail } = await import('../services/email/index.js');
      const data = outcome.result as any;
      await sendEmail(config, {
        workspaceId: String(data.workspace_id),
        to: String(data.email_normalized),
        subject: 'Your verification code',
        text: `Verification code: ${code}\nIt expires in 10 minutes.`,
        html: `<p>Verification code: <strong>${code}</strong></p><p>It expires in 10 minutes.</p>`,
      });
    } catch {
      // Delivery problems never leak invitation state to the caller.
    }
  }

  return res.json({ ok: true, expiresInSeconds: Math.floor(OTP_TTL_MS / 1000), replayed: outcome.replayed });
});

const otpVerifySchema = tokenBody.extend({ code: z.string().trim().regex(/^\d{6}$/) });

workspaceInvitationsRouter.post('/otp/verify', requireOrigin, rejectTokenInUrl, otpLimiter, async (req: any, res) => {
  const parsed = otpVerifySchema.safeParse(req.body);
  const requestId = readRequestId(req);
  if (!parsed.success || !requestId || parsed.data.purpose !== 'manual_handoff') return res.status(404).json(PUBLIC_ERROR);
  const config = cfg(req);
  const sb = getServiceClient(config);
  const invitationHash = tokenHashOf(parsed.data.token);

  const { data: probe, error: probeError } = await sb.rpc('wi_preview_invitation', {
    _token_hash: invitationHash,
    _purpose: 'manual_handoff',
  });
  if (probeError || !probe) return res.status(404).json(PUBLIC_ERROR);

  // Deterministic proof: a retry re-issues the identical HttpOnly cookie
  // instead of minting a second proof row. The raw proof is never stored.
  const proof = deriveScopedSecret('otp_proof', requestId, invitationHash);

  const outcome = await runIdempotent(config, {
    operation: 'otp_verify',
    scopeKind: 'public',
    requestId,
    invitationId: String((probe as any).invitation_id),
    fingerprintInput: { tokenHash: invitationHash, code: sha256Hex(`code|${parsed.data.code}`) },
    args: {
      token_hash: invitationHash,
      code_digest: otpDigest(String((probe as any).invitation_id), parsed.data.code),
      proof_hash: sha256Hex(proof),
      proof_expires_at: new Date(Date.now() + PROOF_TTL_MS).toISOString(),
    },
  });

  if (outcome.error) {
    const mapped = mapRpcError(outcome.error.message);
    if (mapped.code === 'OTP_INVALID') return res.status(400).json({ error: 'OTP_INVALID' });
    if (mapped.code === 'OTP_RATE_LIMITED') return res.status(429).json({ error: 'OTP_RATE_LIMITED' });
    if (mapped.code === 'IDEMPOTENCY_KEY_REUSED') return res.status(409).json({ error: 'IDEMPOTENCY_KEY_REUSED' });
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

  return res.json({ ok: true, replayed: outcome.replayed });
});

const acceptNewSchema = tokenBody.extend({
  password: z.string().min(10).max(200),
  consent: z.literal(true),
  termsVersionId: z.string().uuid(),
  privacyVersionId: z.string().uuid(),
  locale: z.string().trim().max(10).optional(),
  requestId: z.string().trim().uuid(),
});

async function issueSessionFor(config: ServerConfig, req: any, res: any, userId: string): Promise<boolean> {
  try {
    const sb = getServiceClient(config);
    const { data: profile } = await sb.from('profiles').select('email').eq('id', userId).maybeSingle();
    const session = await createSession(config, {
      userId,
      email: String(profile?.email || ''),
      ipAddress: getClientIp(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    });
    setSessionCookie(res, session.token, session.expiresAt);
    return true;
  } catch {
    return false;
  }
}

workspaceInvitationsRouter.post('/accept-new', requireOrigin, rejectTokenInUrl, acceptLimiter, async (req: any, res) => {
  const parsed = acceptNewSchema.safeParse(req.body);
  if (!parsed.success) {
    const consentMissing = req.body?.consent !== true;
    if (!req.body?.requestId) return res.status(400).json({ error: 'REQUEST_ID_REQUIRED' });
    return res.status(400).json({ error: consentMissing ? 'CONSENT_REQUIRED' : 'invalid_body' });
  }
  const body = parsed.data;
  const config = cfg(req);

  const proofRaw = req.cookies?.[PROOF_COOKIE_NAME];
  if (body.purpose === 'manual_handoff' && !proofRaw) {
    return res.status(400).json({ error: 'EMAIL_PROOF_REQUIRED' });
  }

  const tokenHash = tokenHashOf(body.token);
  const passwordHash = await hashPassword(body.password);
  // Deterministic identity: a retry after a lost response can never create a
  // second user for the same logical acceptance.
  const userId = deriveDeterministicUuid('accept_new', body.requestId, tokenHash);

  const outcome = await runIdempotent(config, {
    operation: 'accept_new',
    scopeKind: 'public',
    requestId: body.requestId,
    fingerprintInput: {
      tokenHash,
      purpose: body.purpose,
      termsVersionId: body.termsVersionId,
      privacyVersionId: body.privacyVersionId,
    },
    args: {
      token_hash: tokenHash,
      purpose: body.purpose,
      proof_hash: proofRaw ? sha256Hex(String(proofRaw)) : null,
      user_id: userId,
      password_hash: passwordHash,
      terms_version_id: body.termsVersionId,
      privacy_version_id: body.privacyVersionId,
      acceptance_method: body.purpose === 'manual_handoff' ? 'manual_handoff_otp' : 'email_claim',
      locale: body.locale ?? null,
      ip: getClientIp(req),
      user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
    },
  });

  if (outcome.error) {
    const mapped = mapRpcError(outcome.error.message);
    return res.status(mapped.status).json({ error: mapped.code });
  }

  res.clearCookie(PROOF_COOKIE_NAME, { path: '/api/workspace-invitations/accept-new' });

  // Replay of a committed acceptance: the membership/consent already exist, so
  // recover the logical result and mint a FRESH session for the same user
  // instead of failing with INVITATION_NOT_FOUND.
  const safe = outcome.safeResult as any;
  const result = (outcome.replayed ? safe : outcome.result) as any;
  const recoveredUserId = String(result?.user_id || safe?.user_id || userId);

  const created = await issueSessionFor(config, req, res, recoveredUserId);
  if (!created) {
    return res.status(200).json({ ...result, replayed: outcome.replayed, session: 'SESSION_CREATE_FAILED_LOGIN_REQUIRED' });
  }

  res.clearCookie(CONTEXT_COOKIE_NAME, { path: '/' });
  return res.json({ ...result, replayed: outcome.replayed, session: 'created' });
});

const acceptExistingSchema = z.object({
  token: z.string().trim().min(20).max(512).optional(),
  purpose: z.enum(PURPOSES).optional(),
  consent: z.literal(true),
  termsVersionId: z.string().uuid(),
  privacyVersionId: z.string().uuid(),
  locale: z.string().trim().max(10).optional(),
  requestId: z.string().trim().uuid(),
});

workspaceInvitationsRouter.post('/accept-existing', requireOrigin, rejectTokenInUrl, acceptLimiter, async (req: any, res) => {
  const parsed = acceptExistingSchema.safeParse(req.body);
  if (!parsed.success) {
    const consentMissing = req.body?.consent !== true;
    if (!req.body?.requestId) return res.status(400).json({ error: 'REQUEST_ID_REQUIRED' });
    return res.status(400).json({ error: consentMissing ? 'CONSENT_REQUIRED' : 'invalid_body' });
  }
  const body = parsed.data;
  const config = cfg(req);

  const session = await validateSessionToken(config, req.cookies?.[SESSION_COOKIE_NAME]);
  if (!session) return res.status(401).json({ error: 'SESSION_REQUIRED' });

  const handle = req.cookies?.[CONTEXT_COOKIE_NAME];
  if (!handle) return res.status(404).json(PUBLIC_ERROR);
  const handleHash = sha256Hex(String(handle));

  const outcome = await runIdempotent(config, {
    operation: 'accept_existing',
    scopeKind: 'public',
    requestId: body.requestId,
    actorId: session.userId,
    fingerprintInput: {
      handleHash,
      userId: session.userId,
      termsVersionId: body.termsVersionId,
      privacyVersionId: body.privacyVersionId,
    },
    args: {
      handle_hash: handleHash,
      session_user_id: session.userId,
      session_email_normalized: session.email.toLowerCase(),
      terms_version_id: body.termsVersionId,
      privacy_version_id: body.privacyVersionId,
      locale: body.locale ?? null,
      ip: getClientIp(req),
      user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
    },
  });

  if (outcome.error) {
    const mapped = mapRpcError(outcome.error.message);
    return res.status(mapped.status).json({ error: mapped.code });
  }

  res.clearCookie(CONTEXT_COOKIE_NAME, { path: '/' });
  const payload = outcome.replayed ? outcome.safeResult : (outcome.result as any);
  return res.json({ ...payload, replayed: outcome.replayed, session: 'existing' });
});
