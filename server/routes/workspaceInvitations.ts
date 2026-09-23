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
import type { NextFunction, Request, Response } from 'express';
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
import { readSessionToken } from '../lib/sessionTransport.js';
import { hashPassword } from '../services/auth/password.js';
import { allowedOrigins } from '../services/platformOrigins.js';
import { getClientIp, hashIp } from '../utils/clientIp.js';
import {
  sha256Hex,
  randomToken,
  tokenPrefix,
  deriveOtpCode,
  otpDigest,
  hasOtpKey,
  currentOtpKeyVersion,
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
import { isEmailVerified } from '../services/auth/identity.js';
import {
  peekCommitted,
  runIdempotent,
  deriveScopedSecret,
  deriveDeterministicUuid,
  deriveIntentDigest,
} from '../services/invitations/idempotency.js';

export const workspaceInvitationsRouter = Router();

const PUBLIC_ERROR = { error: 'INVITATION_NOT_FOUND' };

const PURPOSES = ['email_claim', 'manual_handoff'] as const;
type Purpose = (typeof PURPOSES)[number];

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * What the app-level middleware (server/index.ts) and `requireUser` below
 * attach to every request this router handles.
 */
type InvitationRequest = Request & {
  serverConfig: ServerConfig;
  authUser?: { id: string };
};

/** A secret-free RPC projection (jsonb) as the service client returns it. */
type RpcRecord = Record<string, unknown>;

function cfg(req: Request): ServerConfig {
  return (req as InvitationRequest).serverConfig;
}

/** Only valid behind `requireUser`, which guarantees the identity is set. */
function authUserOf(req: Request): { id: string } {
  const user = (req as InvitationRequest).authUser;
  if (!user) throw new Error('authUserOf() used on a route without requireUser');
  return user;
}

/** Reads one field of an RPC projection that may be null. */
function field(record: unknown, key: string): unknown {
  return record && typeof record === 'object' ? (record as RpcRecord)[key] : undefined;
}

function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Strict same-origin enforcement for every mutating invitation route. */
function requireOrigin(req: Request, res: Response, next: NextFunction) {
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
function rejectTokenInUrl(req: Request, res: Response, next: NextFunction) {
  const q = req.query || {};
  if (q.token || q.proof || q.otp || q.code || q.handle) {
    return res.status(404).json(PUBLIC_ERROR);
  }
  next();
}

async function requireUser(req: Request, res: Response, next: NextFunction) {
  const userId = await requireSessionUser(req, res);
  if (!userId) return;
  (req as InvitationRequest).authUser = { id: userId };
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

function readRequestId(req: Request): string | null {
  const parsed = requestIdSchema.safeParse(req.body?.requestId);
  return parsed.success ? parsed.data : null;
}

/**
 * Effective locale resolution (v5.1 locale contract).
 *
 * There is exactly ONE language mechanism in this product: an explicit
 * user/site selection persisted on the workspace (`panel_locale`, then
 * `default_locale`). This helper reuses it instead of introducing a second
 * default — English is only the final fallback of that existing resolver, and
 * the browser's Accept-Language header is deliberately never consulted, so a
 * visitor's browser can never silently override the configured site default.
 */
const SUPPORTED_LOCALES = new Set(['en', 'fa', 'tr']);
const LAST_RESORT_LOCALE = 'en';

function normalizeLocale(value: unknown): string | null {
  const v = String(value ?? '').trim().toLowerCase();
  return SUPPORTED_LOCALES.has(v) ? v : null;
}

async function resolveEffectiveLocale(
  config: ServerConfig,
  workspaceId: string | null | undefined,
  requested: unknown,
): Promise<string> {
  // 1. explicit selection made through the existing language selector
  const selected = normalizeLocale(requested);
  if (selected) return selected;

  // 2. the site default configured for this workspace
  if (workspaceId) {
    const { data } = await getServiceClient(config)
      .from('workspaces')
      .select('panel_locale, default_locale')
      .eq('id', workspaceId)
      .maybeSingle();
    const siteDefault =
      normalizeLocale(field(data, 'panel_locale')) || normalizeLocale(field(data, 'default_locale'));
    if (siteDefault) return siteDefault;
  }

  // 3. the existing resolver's own last resort
  return LAST_RESORT_LOCALE;
}

interface PolicyVersionRow {
  id: string;
  policy_type: string;
  version: string;
  locale: string;
  document_url: string | null;
  effective_from: string;
}

async function activePolicyVersions(config: ServerConfig, locale: string) {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('legal_policy_versions')
    .select('id, policy_type, version, locale, document_url, effective_from')
    .eq('is_active', true)
    .lte('effective_from', new Date().toISOString())
    .order('effective_from', { ascending: false });

  const rows: PolicyVersionRow[] = data || [];
  const pick = (type: string) =>
    rows.find((r) => r.policy_type === type && r.locale === locale)
    || rows.find((r) => r.policy_type === type && r.locale === LAST_RESORT_LOCALE)
    || rows.find((r) => r.policy_type === type)
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
  // Phone is no longer collected in the invite form; kept optional for
  // backward compatibility with older clients that still send it.
  phone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/).optional().nullable(),
  memberType: z.enum(['staff', 'customer_facing']),
  role: z.string().trim().min(1).max(40),
  departmentIds: z.array(z.string().uuid()).max(50).optional(),
  jobTitle: z.string().trim().max(120).optional().nullable(),
  staffCode: z.string().trim().max(60).optional().nullable(),
  /**
   * Legacy clients may still send 0 for no expiry. New clients use the
   * explicit `neverExpires` flag and omit this field, which also remains
   * compatible with older API containers while a self-hosted rollout is in
   * progress.
   */
  expiresInDays: z.number().int().min(0).max(30).optional(),
  neverExpires: z.boolean().optional(),

  /** Effective UI locale captured by the management surface (fa/tr/en). */
  locale: z.enum(['fa', 'tr', 'en']).optional(),
  requestId: z.string().trim().uuid(),
});

/**
 * `expiresInDays === 0` means "no expiry — valid until the owner decides".
 *
 * The v2 required-field CHECK on `workspace_invitations` demands
 * `expires_at IS NOT NULL`, so "no expiry" is materialised as a far-future
 * timestamp (100 years) rather than NULL. The sweeper will therefore never
 * expire it in practice, and the handoff link gets the same validity so the
 * link cannot die before the invitation itself.
 */
const NO_EXPIRY_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

function resolveExpiry(days: number | undefined, neverExpires = false) {
  const value = days ?? 7;
  if (neverExpires || value === 0) {
    const farFuture = new Date(Date.now() + NO_EXPIRY_TTL_MS).toISOString();
    return { invitationExpiresAt: farFuture as string | null, tokenExpiresAt: farFuture };
  }
  return {
    invitationExpiresAt: new Date(Date.now() + value * 24 * 60 * 60 * 1000).toISOString(),
    tokenExpiresAt: new Date(Date.now() + MANUAL_TOKEN_TTL_MS).toISOString(),
  };
}

/** Field names only — never values — so a 400 is diagnosable without leaking PII. */
function invalidFields(parsed: { error?: z.ZodError }): string[] {
  return (parsed.error?.issues || []).map((i) => i.path.join('.')).filter(Boolean);
}

workspaceInvitationsRouter.post('/', requireOrigin, rejectTokenInUrl, requireUser, async (req, res) => {
  // NEW-signup policy: an unverified account cannot pull other people into a
  // workspace it controls. This gate used to live on
  // POST /api/workspace-members/invitations and did not come across when that
  // route was retired in favour of this one, which left creating an invitation
  // as the one reach-expanding operation an unverified account could still
  // perform. Same rule and same shape as POST /api/workspaces; see
  // identity.ts's isEmailVerified for why it is enforced here rather than at
  // login.
  //
  // Ahead of the body parse on purpose: whether the caller may invite at all
  // does not depend on the shape of what they sent, and an account that may
  // not invite has no business learning which of its fields were malformed.
  if (!(await isEmailVerified(cfg(req), authUserOf(req).id))) {
    return res.status(403).json({ error: 'email_verification_required' });
  }

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: req.body?.requestId ? 'invalid_body' : 'REQUEST_ID_REQUIRED',
      fields: invalidFields(parsed),
    });
  }

  const body = parsed.data;
  const config = cfg(req);

  const email = body.email.toLowerCase();
  const manualToken = randomToken();
  const expiry = resolveExpiry(body.expiresInDays, body.neverExpires);

  const nonce = body.requestId;
  const departmentIds = [...(body.departmentIds ?? [])].sort();
  // Notification locale snapshot: explicit selection → configured workspace
  // default → application last resort. Accept-Language is never consulted.
  const effectiveLocale = await resolveEffectiveLocale(config, body.workspaceId, body.locale);

  const outcome = await runIdempotent(config, {
    operation: 'create',
    scopeKind: 'workspace',
    requestId: body.requestId,
    actorId: authUserOf(req).id,
    workspaceId: body.workspaceId,
    fingerprintInput: {
      workspaceId: body.workspaceId,
      email,
      phone: body.phone ?? null,
      memberType: body.memberType,
      role: body.role,
      departmentIds,
      firstName: body.firstName,
      lastName: body.lastName,
      jobTitle: body.jobTitle ?? null,
      staffCode: body.staffCode ?? null,
      expiresInDays: body.expiresInDays ?? 7,
      neverExpires: body.neverExpires ?? body.expiresInDays === 0,
      locale: effectiveLocale,
    },
    args: {
      first_name: body.firstName,
      last_name: body.lastName,
      email_normalized: email,
      phone_e164: body.phone ?? null,
      member_type: body.memberType,
      role: body.role,
      expires_at: expiry.invitationExpiresAt,
      department_ids: departmentIds,
      manual_token_hash: sha256Hex(manualToken),
      manual_token_prefix: tokenPrefix(manualToken),
      manual_token_expires_at: expiry.tokenExpiresAt,
      email_job_idempotency_key: sha256Hex(`email|${body.workspaceId}|${email}|${nonce}`),
      sms_job_idempotency_key: sha256Hex(`sms|${body.workspaceId}|${body.phone ?? ''}|${nonce}`),
      email_destination_hash: destinationHash(email),
      sms_destination_hash: destinationHash(body.phone ?? ''),
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

  // Persist the resolved locale snapshot for the notification worker. The
  // create RPC's signature is unchanged; this is a backend-only follow-up
  // restricted to pending invitations.
  const createdId = field(outcome.result, 'invitation_id') || field(outcome.result, 'id');
  if (createdId) {
    await getServiceClient(config).rpc('wi_set_invitation_locale', {
      _invitation_id: createdId,
      _locale: effectiveLocale,
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

workspaceInvitationsRouter.get('/', rejectTokenInUrl, requireUser, async (req, res) => {
  const workspaceId = String(req.query.workspaceId || '');
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) return res.status(400).json({ error: 'invalid_workspace' });
  const includeArchived = String(req.query.archived || '') === '1';
  const config = cfg(req);
  const sb = getServiceClient(config);

  const { data: member } = await sb
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', authUserOf(req).id)
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
  // An accepted invitation is spent: the person is now a workspace member and
  // belongs in the member list, not in the pending-invitation ledger.
  if (!includeArchived) query = query.is('archived_at', null).neq('status', 'accepted');

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'INTERNAL_ERROR' });
  return res.json({ invitations: data || [] });
});

workspaceInvitationsRouter.get('/:id', rejectTokenInUrl, requireUser, async (req, res) => {
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
    .eq('user_id', authUserOf(req).id)
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
    departmentIds: ((departments || []) as Array<{ department_id: string }>).map((d) => d.department_id),
  });
});

const editSchema = createSchema.omit({ workspaceId: true });

workspaceInvitationsRouter.patch('/:id', requireOrigin, rejectTokenInUrl, requireUser, async (req, res) => {
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
    actorId: authUserOf(req).id,
    invitationId: id,
    fingerprintInput: {
      invitationId: id,
      email,
      phone: body.phone ?? null,
      memberType: body.memberType,
      role: body.role,
      departmentIds,
      firstName: body.firstName,
      lastName: body.lastName,
      jobTitle: body.jobTitle ?? null,
      staffCode: body.staffCode ?? null,
      expiresInDays: body.expiresInDays ?? 7,
      neverExpires: body.neverExpires ?? body.expiresInDays === 0,
    },
    args: {
      first_name: body.firstName,
      last_name: body.lastName,
      email_normalized: email,
      phone_e164: body.phone ?? null,
      member_type: body.memberType,
      role: body.role,
      expires_at: resolveExpiry(body.expiresInDays, body.neverExpires).invitationExpiresAt,
      department_ids: departmentIds,
      email_job_idempotency_key: sha256Hex(`email|${id}|${email}|${nonce}`),
      sms_job_idempotency_key: sha256Hex(`sms|${id}|${body.phone ?? ''}|${nonce}`),
      email_destination_hash: destinationHash(email),
      sms_destination_hash: destinationHash(body.phone ?? ''),
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

workspaceInvitationsRouter.post('/:id/resend', requireOrigin, rejectTokenInUrl, requireUser, async (req, res) => {
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
    actorId: authUserOf(req).id,
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
  return res.json({ ...(outcome.result as RpcRecord | null), replayed: false });
});

workspaceInvitationsRouter.post('/:id/rotate-link', requireOrigin, rejectTokenInUrl, requireUser, async (req, res) => {
  const config = cfg(req);
  const id = String(req.params.id);
  const manualToken = randomToken();
  const requestId = readRequestId(req);
  if (!requestId) return res.status(400).json({ error: 'REQUEST_ID_REQUIRED' });

  const outcome = await runIdempotent(config, {
    operation: 'rotate',
    scopeKind: 'invitation',
    requestId,
    actorId: authUserOf(req).id,
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
    ...(outcome.result as RpcRecord | null),
    manualLink: buildInviteUrl(appBase, manualToken, 'manual_handoff'),
    replayed: false,
  });
});

workspaceInvitationsRouter.post('/:id/revoke', requireOrigin, rejectTokenInUrl, requireUser, async (req, res) => {
  const config = cfg(req);
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'REVOKE_REASON_REQUIRED' });
  const requestId = readRequestId(req);
  if (!requestId) return res.status(400).json({ error: 'REQUEST_ID_REQUIRED' });

  const outcome = await runIdempotent(config, {
    operation: 'revoke',
    scopeKind: 'invitation',
    requestId,
    actorId: authUserOf(req).id,
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

workspaceInvitationsRouter.post('/:id/archive', requireOrigin, rejectTokenInUrl, requireUser, async (req, res) => {
  const requestId = readRequestId(req);
  if (!requestId) return res.status(400).json({ error: 'REQUEST_ID_REQUIRED' });
  const config = cfg(req);

  const outcome = await runIdempotent(config, {
    operation: 'archive',
    scopeKind: 'invitation',
    requestId,
    actorId: authUserOf(req).id,
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

/**
 * DELETE /:id — permanent, irreversible removal.
 *
 * Archiving only hid a row: its tokens, OTPs, jobs, deliveries and
 * idempotency records survived, so a later invitation to the same address kept
 * colliding with leftover state. Owners asked for real deletion, so this route
 * removes the invitation and every dependent record.
 *
 * The whole removal is ONE service_role RPC, `wi_delete_invitation`, in one
 * transaction and the canonical lock order: authorisation, the accepted-
 * invitation guard, the consent and idempotency-ledger cleanup, the delete
 * itself (the invitation-scoped child tables cascade) and the audit row. The
 * router never touches the ledger or the consent evidence directly.
 *
 * An ACCEPTED invitation is never deleted — the membership it produced
 * references it, and deleting it would rewrite the workspace's staff history.
 */
const DELETE_ERRORS: Record<string, { status: number; code: string }> = {
  INVITATION_NOT_FOUND: { status: 404, code: 'INVITATION_NOT_FOUND' },
  FORBIDDEN: { status: 403, code: 'FORBIDDEN' },
  INVITATION_ALREADY_ACCEPTED: { status: 409, code: 'INVITATION_ALREADY_ACCEPTED' },
};

workspaceInvitationsRouter.delete('/:id', requireOrigin, rejectTokenInUrl, requireUser, async (req, res) => {
  const config = cfg(req);
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'INVITATION_NOT_FOUND' });

  const { error } = await getServiceClient(config).rpc('wi_delete_invitation', {
    _invitation_id: id,
    _actor_id: authUserOf(req).id,
  });
  if (error) {
    const raw = String(error.message || '');
    const known = Object.keys(DELETE_ERRORS).find((k) => raw.includes(k));
    if (known) return res.status(DELETE_ERRORS[known].status).json({ error: DELETE_ERRORS[known].code });
    console.error('[invitations] hard delete failed:', raw);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }

  return res.json({ deleted: true });
});



// ─────────────────────────────────────────────────────────────────────────
// PUBLIC SURFACE (token possession — JSON body only)
// ─────────────────────────────────────────────────────────────────────────

const tokenBody = z.object({
  token: z.string().trim().min(20).max(512),
  purpose: z.enum(PURPOSES),
});

/** The workspace a preview projection belongs to, when there is one. */
function workspaceIdOf(preview: unknown): string | null {
  const id = field(preview, 'workspace_id');
  return typeof id === 'string' ? id : null;
}

function tokenHashOf(token: string): string {
  return sha256Hex(token);
}

workspaceInvitationsRouter.post('/preview', requireOrigin, rejectTokenInUrl, publicLimiter, async (req, res) => {
  const parsed = tokenBody.safeParse(req.body);
  if (!parsed.success) return res.status(404).json(PUBLIC_ERROR);
  const config = cfg(req);

  const { data, error } = await getServiceClient(config).rpc('wi_preview_invitation', {
    _token_hash: tokenHashOf(parsed.data.token),
    _purpose: parsed.data.purpose,
  });
  if (error || !data) return res.status(404).json(PUBLIC_ERROR);

  const locale = await resolveEffectiveLocale(config, workspaceIdOf(data), req.body?.locale);
  const policies = await activePolicyVersions(config, locale);


  return res.json({ preview: data, policies });
});

workspaceInvitationsRouter.post('/login-context', requireOrigin, rejectTokenInUrl, publicLimiter, async (req, res) => {
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
    ? field(outcome.safeResult, 'invitation_id')
    : field(outcome.result, 'invitation_id');

  // The redirect URL carries NO token and no invitation secret.
  return res.json({ invitationId, loginPath: '/auth/login?invited=1', replayed: outcome.replayed });
});

workspaceInvitationsRouter.post('/context-preview', requireOrigin, rejectTokenInUrl, publicLimiter, async (req, res) => {
  const handle = req.cookies?.[CONTEXT_COOKIE_NAME];
  if (!handle) return res.status(404).json(PUBLIC_ERROR);
  const config = cfg(req);
  const { data, error } = await getServiceClient(config).rpc('wi_preview_login_context', {
    _handle_hash: sha256Hex(String(handle)),
  });
  if (error || !data) return res.status(404).json(PUBLIC_ERROR);
  const contextLocale = await resolveEffectiveLocale(config, workspaceIdOf(data), req.body?.locale);
  const policies = await activePolicyVersions(config, contextLocale);

  return res.json({ preview: data, policies });
});

workspaceInvitationsRouter.post('/otp/request', requireOrigin, rejectTokenInUrl, otpLimiter, async (req, res) => {
  const parsed = tokenBody.safeParse(req.body);
  const requestId = readRequestId(req);
  if (!parsed.success || !requestId || parsed.data.purpose !== 'manual_handoff') return res.status(404).json(PUBLIC_ERROR);
  const config = cfg(req);
  const sb = getServiceClient(config);

  const invitationHash = tokenHashOf(parsed.data.token);

  // Read-only probe: resolves the invitation id the digest is bound to. It
  // mutates nothing, so it stays outside the idempotent transaction.
  const { data: probe, error: probeError } = await sb.rpc('wi_preview_invitation', {
    _token_hash: invitationHash,
    _purpose: 'manual_handoff',
  });
  if (probeError || !probe) return res.status(404).json(PUBLIC_ERROR);

  const invitationId = String(field(probe, 'invitation_id'));
  // Deterministic OTP identity + code (v5.1 B.5): the code is NEVER stored and
  // NEVER sent inline. It is re-derivable by the delivery worker from the OTP
  // id plus the process-local pepper, so a crash between commit and delivery
  // is recoverable instead of stranding a live code nobody received.
  const otpId = deriveDeterministicUuid('otp_request', requestId, invitationHash);
  const code = deriveOtpCode(invitationId, otpId);

  const outcome = await runIdempotent(config, {
    operation: 'otp_request',
    scopeKind: 'public',
    requestId,
    invitationId,
    fingerprintInput: { tokenHash: invitationHash },
    args: {
      token_hash: invitationHash,
      otp_id: otpId,
      code_digest: otpDigest(invitationId, code),
      expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
      job_idempotency_key: `otp:${otpId}`,
      ip_hash: hashIp(getClientIp(req)),
    },
  });

  if (outcome.error) {
    const mapped = mapRpcError(outcome.error.message);
    // Uniform response: never reveal invitation/account existence.
    if (mapped.code === 'OTP_RATE_LIMITED') return res.status(429).json({ error: 'OTP_RATE_LIMITED' });
    if (mapped.code === 'IDEMPOTENCY_KEY_REUSED') return res.status(409).json({ error: 'IDEMPOTENCY_KEY_REUSED' });
    return res.status(404).json(PUBLIC_ERROR);
  }

  // Delivery is owned by the durable outbox worker; the OTP row and its job
  // were committed together, so nothing is "sent" from this request path.
  return res.json({ ok: true, expiresInSeconds: Math.floor(OTP_TTL_MS / 1000), replayed: outcome.replayed });
});

const otpVerifySchema = tokenBody.extend({ code: z.string().trim().regex(/^\d{6}$/) });

workspaceInvitationsRouter.post('/otp/verify', requireOrigin, rejectTokenInUrl, otpLimiter, async (req, res) => {
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

  const idempotentCall = {
    operation: 'otp_verify' as const,
    scopeKind: 'public' as const,
    requestId,
    invitationId: String(field(probe, 'invitation_id')),
    // Keyed digest: an unkeyed hash of a six-digit code is brute-forceable.
    fingerprintInput: {
      tokenHash: invitationHash,
      codeDigest: deriveIntentDigest('otp_code', `${String(field(probe, 'invitation_id'))}|${parsed.data.code}`),
    },
  };

  // Committed-replay FIRST: an already-committed requestId must resolve without
  // re-deriving (or re-consuming) the OTP, so retiring the pepper version that
  // signed the original code cannot turn an honest retry into a 503. The
  // fingerprint binding is unchanged — a different payload still 409s.
  const peek = await peekCommitted(config, idempotentCall);
  if (peek.conflict) return res.status(409).json({ error: 'IDEMPOTENCY_KEY_REUSED' });
  if (peek.committed) {
    res.cookie(PROOF_COOKIE_NAME, proof, {
      httpOnly: true,
      secure: isProd(),
      sameSite: 'strict',
      path: '/api/workspace-invitations/accept-new',
      maxAge: PROOF_TTL_MS,
    });
    return res.json({ ok: true, replayed: true });
  }

  // The live OTP records the (non-secret) pepper version its digest was built
  // with, so a rotation cannot silently invalidate a code already in flight.
  const { data: otpKeyVersion } = await sb.rpc('wi_otp_pending_key_version', {
    _token_hash: invitationHash,
  });
  // No OTP generation at all: digest with the current key and let the RPC
  // return the uniform OTP_INVALID — the HTTP path never leaks OTP existence.
  const verifyKeyVersion = otpKeyVersion == null ? currentOtpKeyVersion() : Number(otpKeyVersion);
  if (!hasOtpKey(verifyKeyVersion)) return res.status(503).json({ error: 'DERIVATION_KEY_UNAVAILABLE' });

  const outcome = await runIdempotent(config, {
    ...idempotentCall,
    args: {
      token_hash: invitationHash,
      code_digest: otpDigest(String(field(probe, 'invitation_id')), parsed.data.code, verifyKeyVersion),
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

async function issueSessionFor(config: ServerConfig, req: Request, res: Response, userId: string): Promise<boolean> {
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

workspaceInvitationsRouter.post('/accept-new', requireOrigin, rejectTokenInUrl, acceptLimiter, async (req, res) => {
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

  // Read-only probe used only to resolve the invitation's workspace so the
  // persisted consent locale can inherit the configured site default. It
  // mutates nothing and never widens the public error surface.
  const { data: localeProbe } = await getServiceClient(config).rpc('wi_preview_invitation', {
    _token_hash: tokenHash,
    _purpose: body.purpose,
  });
  const persistedLocale = await resolveEffectiveLocale(
    config,
    workspaceIdOf(localeProbe),
    body.locale,
  );

  const outcome = await runIdempotent(config, {
    operation: 'accept_new',
    scopeKind: 'public',
    requestId: body.requestId,
    fingerprintInput: {
      tokenHash,
      purpose: body.purpose,
      // Argon2 hashes are salted, so the stored hash cannot be a fingerprint
      // input: use a deterministic keyed digest of the raw password instead.
      // The raw password is never stored and never logged.
      passwordIntent: deriveIntentDigest('accept_new_password', body.password),
      proofBinding: proofRaw ? deriveIntentDigest('accept_new_proof', String(proofRaw)) : null,
      termsVersionId: body.termsVersionId,
      privacyVersionId: body.privacyVersionId,
      // The REQUESTED locale stays the fingerprint input: changing the site
      // default between two retries must not invalidate a replay.
      locale: body.locale ?? null,
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
      locale: persistedLocale,
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
  const safe: RpcRecord = outcome.safeResult;
  const result = (outcome.replayed ? safe : outcome.result) as RpcRecord | null;
  const recoveredUserId = String(field(result, 'user_id') || field(safe, 'user_id') || userId);

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

workspaceInvitationsRouter.post('/accept-existing', requireOrigin, rejectTokenInUrl, acceptLimiter, async (req, res) => {
  const parsed = acceptExistingSchema.safeParse(req.body);
  if (!parsed.success) {
    const consentMissing = req.body?.consent !== true;
    if (!req.body?.requestId) return res.status(400).json({ error: 'REQUEST_ID_REQUIRED' });
    return res.status(400).json({ error: consentMissing ? 'CONSENT_REQUIRED' : 'invalid_body' });
  }
  const body = parsed.data;
  const config = cfg(req);

  const session = await validateSessionToken(config, readSessionToken(req).token);
  if (!session) return res.status(401).json({ error: 'SESSION_REQUIRED' });

  const handle = req.cookies?.[CONTEXT_COOKIE_NAME];
  if (!handle) return res.status(404).json(PUBLIC_ERROR);
  const handleHash = sha256Hex(String(handle));

  // Read-only projection: resolves the workspace so the persisted consent
  // locale inherits the configured site default. It never consumes the context.
  const { data: ctxProbe } = await getServiceClient(config).rpc('wi_preview_login_context', {
    _handle_hash: handleHash,
  });
  const persistedLocale = await resolveEffectiveLocale(
    config,
    workspaceIdOf(ctxProbe),
    body.locale,
  );

  const outcome = await runIdempotent(config, {
    operation: 'accept_existing',
    scopeKind: 'public',
    requestId: body.requestId,
    actorId: session.userId,
    fingerprintInput: {
      handleHash,
      userId: session.userId,
      sessionEmail: deriveIntentDigest('session_email', session.email.toLowerCase()),
      termsVersionId: body.termsVersionId,
      privacyVersionId: body.privacyVersionId,
      // Requested locale only — see /accept-new for the rationale.
      locale: body.locale ?? null,
    },
    args: {
      handle_hash: handleHash,
      session_user_id: session.userId,
      session_email_normalized: session.email.toLowerCase(),
      terms_version_id: body.termsVersionId,
      privacy_version_id: body.privacyVersionId,
      locale: persistedLocale,
      ip: getClientIp(req),
      user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
    },
  });


  if (outcome.error) {
    const mapped = mapRpcError(outcome.error.message);
    return res.status(mapped.status).json({ error: mapped.code });
  }

  res.clearCookie(CONTEXT_COOKIE_NAME, { path: '/' });
  const payload = outcome.replayed ? outcome.safeResult : (outcome.result as RpcRecord | null);
  return res.json({ ...payload, replayed: outcome.replayed, session: 'existing' });
});
