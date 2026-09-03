/**
 * Generic Verification Core v1 — type definitions and purpose registry.
 *
 * Deliberately a TypeScript `Record`, NOT a Postgres enum: the task that
 * commissioned this subsystem was explicit that a DB enum "makes extension
 * difficult" (adding a value requires an `ALTER TYPE ... ADD VALUE`, which
 * cannot run inside the same transaction as other DDL in older Postgres
 * semantics and cannot be removed). A new purpose is added here by editing
 * this file and shipping a normal code deploy — no migration required. The
 * `purpose`/`channel` columns on `verification_challenges` are plain
 * `text`, validated only by this registry at the application layer.
 */

export type VerificationChannel = 'email' | 'sms';

export type VerificationLocale = 'fa' | 'tr' | 'en';

export type VerificationSubjectKind = 'user' | 'pending_account' | 'anonymous';

/**
 * Every purpose this core could ever serve. NONE of these are integrated
 * with any real signup/reset/change flow in this pass — see
 * PURPOSE_POLICIES below, where every one of these ships `enabled: false`.
 * `workspace_invitation` is listed ONLY as a registry placeholder
 * documenting a possible FUTURE migration path (see
 * docs/GENERIC_VERIFICATION_CORE.md §Future integration checklist) — the
 * real, currently-live Workspace Invitations v5.1 OTP system
 * (workspace_invitation_otps/_proofs, migrations 077-097) is completely
 * unaffected and unmigrated by this entry existing.
 */
export type VerificationPurpose =
  | 'signup_email'
  | 'signup_phone'
  | 'password_reset'
  | 'login_step_up'
  | 'change_email'
  | 'change_phone'
  | 'sensitive_action'
  | 'workspace_invitation';

export const ALL_VERIFICATION_PURPOSES: readonly VerificationPurpose[] = [
  'signup_email',
  'signup_phone',
  'password_reset',
  'login_step_up',
  'change_email',
  'change_phone',
  'sensitive_action',
  'workspace_invitation',
];

export interface PurposePolicy {
  /** Must be false for every purpose in this pass — see docs/GENERIC_VERIFICATION_CORE.md. */
  enabled: boolean;
  allowedChannels: readonly VerificationChannel[];
  otpLength: number;                 // 4-10 digits
  otpTtlSeconds: number;
  deliveryRetryWindowSeconds: number; // reserved for a future policy-driven retry/backoff window; there is no background worker — Express sends once per request/resend and a retryable failure requires the caller to resend
  resendCooldownSeconds: number;
  maxSendsPerWindow: number;
  rateWindowSeconds: number;         // the rolling window maxSendsPerWindow is counted over
  maxVerificationAttempts: number;
  proofTtlSeconds: number;
  requiresAuth: boolean;             // true = caller must already hold a valid gs_session
  subjectBinding: VerificationSubjectKind;
  tenantBinding: 'none' | 'optional' | 'required';
  invalidatesPreviousGeneration: boolean;
  issuesProof: boolean;
  /**
   * An OPT-IN, explicitly configured platform-wide cap for this
   * purpose+channel, independent of `maxSendsPerWindow` (which is a
   * per-destination/subject/workspace limit, not a platform-wide one).
   * `null` (the default for every shipped purpose) means NO platform-wide
   * cap is enforced at the database layer for this purpose+channel at all
   * — no advisory lock is even acquired in the normal request path — and
   * platform-wide abuse control is expected to live at the infrastructure
   * layer (a CDN/API gateway/WAF) instead. This replaces an earlier design
   * that derived a platform-wide cap as `maxSendsPerWindow × 20` through a
   * single shared advisory lock: that formula could cap the ENTIRE
   * platform's traffic for a purpose at a number as low as ~100/hour, and
   * serialized every request for that purpose+channel through one lock
   * regardless of how many unrelated users were involved. If a deployment
   * genuinely wants a database-enforced platform-wide ceiling for a live
   * purpose, it must configure this field explicitly with numbers sized
   * for that deployment's real traffic — never inferred from a
   * per-identifier limit.
   */
  globalRateLimit: { maxPerWindow: number; windowSeconds: number } | null;
}

/**
 * Hard ceilings. A purpose policy is CLAMPED to these at read time
 * (clampPolicyToPlatformMaximums) — nothing (not a tenant setting, not a
 * future config table) can ever widen beyond them. Tenant-level settings,
 * if they ever exist, may only TIGHTEN a purpose's effective policy.
 */
export const PLATFORM_MAXIMUMS = Object.freeze({
  otpLength: 8,
  otpTtlSeconds: 900,              // 15 minutes
  deliveryRetryWindowSeconds: 3600,
  resendCooldownSecondsMin: 30,    // a policy may not set a cooldown SHORTER than this
  maxSendsPerWindow: 5,
  rateWindowSeconds: 3600,
  maxVerificationAttempts: 8,
  proofTtlSeconds: 1800,           // 30 minutes
  globalRateLimitWindowSecondsMax: 86400, // a configured global bucket may not span more than 24h
});

function clampPolicy(p: PurposePolicy): PurposePolicy {
  return {
    ...p,
    otpLength: Math.min(p.otpLength, PLATFORM_MAXIMUMS.otpLength),
    otpTtlSeconds: Math.min(p.otpTtlSeconds, PLATFORM_MAXIMUMS.otpTtlSeconds),
    deliveryRetryWindowSeconds: Math.min(p.deliveryRetryWindowSeconds, PLATFORM_MAXIMUMS.deliveryRetryWindowSeconds),
    resendCooldownSeconds: Math.max(p.resendCooldownSeconds, PLATFORM_MAXIMUMS.resendCooldownSecondsMin),
    maxSendsPerWindow: Math.min(p.maxSendsPerWindow, PLATFORM_MAXIMUMS.maxSendsPerWindow),
    rateWindowSeconds: Math.min(p.rateWindowSeconds, PLATFORM_MAXIMUMS.rateWindowSeconds),
    maxVerificationAttempts: Math.min(p.maxVerificationAttempts, PLATFORM_MAXIMUMS.maxVerificationAttempts),
    proofTtlSeconds: Math.min(p.proofTtlSeconds, PLATFORM_MAXIMUMS.proofTtlSeconds),
    globalRateLimit: p.globalRateLimit && {
      maxPerWindow: Math.max(1, p.globalRateLimit.maxPerWindow),
      windowSeconds: Math.min(Math.max(p.globalRateLimit.windowSeconds, 60), PLATFORM_MAXIMUMS.globalRateLimitWindowSecondsMax),
    },
  };
}

/**
 * EVERY policy below ships `enabled: false`. This is not a placeholder to
 * be flipped on later by editing a boolean in isolation — enabling a
 * purpose for real use requires: (1) flipping this flag, (2) building and
 * wiring the actual consumer (signup route, password-reset route, etc.)
 * per docs/GENERIC_VERIFICATION_CONSUMER_GUIDE.md, and (3) a deliberate,
 * reviewed deploy. Nothing in this pass does any of that.
 */
const RAW_POLICIES: Record<VerificationPurpose, PurposePolicy> = {
  signup_email: {
    enabled: false,
    allowedChannels: ['email'],
    otpLength: 6,
    otpTtlSeconds: 600,
    deliveryRetryWindowSeconds: 900,
    resendCooldownSeconds: 60,
    maxSendsPerWindow: 5,
    rateWindowSeconds: 3600,
    maxVerificationAttempts: 5,
    proofTtlSeconds: 600,
    requiresAuth: false,
    subjectBinding: 'pending_account',
    tenantBinding: 'none',
    invalidatesPreviousGeneration: true,
    issuesProof: true,
    globalRateLimit: null,
  },
  signup_phone: {
    enabled: false,
    allowedChannels: ['sms'],
    otpLength: 6,
    otpTtlSeconds: 300,
    deliveryRetryWindowSeconds: 600,
    resendCooldownSeconds: 60,
    maxSendsPerWindow: 5,
    rateWindowSeconds: 3600,
    maxVerificationAttempts: 5,
    proofTtlSeconds: 600,
    requiresAuth: false,
    subjectBinding: 'pending_account',
    tenantBinding: 'none',
    invalidatesPreviousGeneration: true,
    issuesProof: true,
    globalRateLimit: null,
  },
  password_reset: {
    enabled: false,
    allowedChannels: ['email'],
    otpLength: 6,
    otpTtlSeconds: 600,
    deliveryRetryWindowSeconds: 900,
    resendCooldownSeconds: 60,
    maxSendsPerWindow: 3,
    rateWindowSeconds: 3600,
    maxVerificationAttempts: 5,
    proofTtlSeconds: 300,
    requiresAuth: false,
    subjectBinding: 'user',
    tenantBinding: 'none',
    invalidatesPreviousGeneration: true,
    issuesProof: true,
    globalRateLimit: null,
  },
  login_step_up: {
    enabled: false,
    allowedChannels: ['email', 'sms'],
    otpLength: 6,
    otpTtlSeconds: 300,
    deliveryRetryWindowSeconds: 600,
    resendCooldownSeconds: 45,
    maxSendsPerWindow: 5,
    rateWindowSeconds: 1800,
    maxVerificationAttempts: 5,
    proofTtlSeconds: 300,
    requiresAuth: true,
    subjectBinding: 'user',
    tenantBinding: 'optional',
    invalidatesPreviousGeneration: true,
    issuesProof: true,
    globalRateLimit: null,
  },
  change_email: {
    enabled: false,
    allowedChannels: ['email'],
    otpLength: 6,
    otpTtlSeconds: 600,
    deliveryRetryWindowSeconds: 900,
    resendCooldownSeconds: 60,
    maxSendsPerWindow: 5,
    rateWindowSeconds: 3600,
    maxVerificationAttempts: 5,
    proofTtlSeconds: 600,
    requiresAuth: true,
    subjectBinding: 'user',
    tenantBinding: 'none',
    invalidatesPreviousGeneration: true,
    issuesProof: true,
    globalRateLimit: null,
  },
  change_phone: {
    enabled: false,
    allowedChannels: ['sms'],
    otpLength: 6,
    otpTtlSeconds: 300,
    deliveryRetryWindowSeconds: 600,
    resendCooldownSeconds: 60,
    maxSendsPerWindow: 5,
    rateWindowSeconds: 3600,
    maxVerificationAttempts: 5,
    proofTtlSeconds: 600,
    requiresAuth: true,
    subjectBinding: 'user',
    tenantBinding: 'none',
    invalidatesPreviousGeneration: true,
    issuesProof: true,
    globalRateLimit: null,
  },
  sensitive_action: {
    enabled: false,
    allowedChannels: ['email', 'sms'],
    otpLength: 6,
    otpTtlSeconds: 300,
    deliveryRetryWindowSeconds: 600,
    resendCooldownSeconds: 60,
    maxSendsPerWindow: 3,
    rateWindowSeconds: 1800,
    maxVerificationAttempts: 5,
    proofTtlSeconds: 180,
    requiresAuth: true,
    subjectBinding: 'user',
    tenantBinding: 'required',
    invalidatesPreviousGeneration: true,
    issuesProof: true,
    globalRateLimit: null,
  },
  workspace_invitation: {
    // Registry placeholder only — see the type-level doc comment above.
    // The real, live invitation OTP flow does NOT use this core.
    enabled: false,
    allowedChannels: ['email', 'sms'],
    otpLength: 6,
    otpTtlSeconds: 600,
    deliveryRetryWindowSeconds: 900,
    resendCooldownSeconds: 60,
    maxSendsPerWindow: 5,
    rateWindowSeconds: 3600,
    maxVerificationAttempts: 5,
    proofTtlSeconds: 600,
    requiresAuth: false,
    subjectBinding: 'anonymous',
    tenantBinding: 'required',
    invalidatesPreviousGeneration: true,
    issuesProof: true,
    globalRateLimit: null,
  },
};

export const PURPOSE_POLICIES: Readonly<Record<VerificationPurpose, PurposePolicy>> = Object.freeze(
  Object.fromEntries(
    Object.entries(RAW_POLICIES).map(([k, v]) => [k, Object.freeze(clampPolicy(v))]),
  ) as Record<VerificationPurpose, PurposePolicy>,
);

export class UnknownVerificationPurposeError extends Error {
  constructor(purpose: string) {
    super(`Unknown verification purpose: ${purpose}`);
    this.name = 'UnknownVerificationPurposeError';
  }
}

export class VerificationPurposeDisabledError extends Error {
  constructor(purpose: string) {
    super(`Verification purpose is disabled: ${purpose}`);
    this.name = 'VerificationPurposeDisabledError';
  }
}

export class VerificationChannelNotAllowedError extends Error {
  constructor(purpose: string, channel: string) {
    super(`Channel ${channel} is not allowed for purpose ${purpose}`);
    this.name = 'VerificationChannelNotAllowedError';
  }
}

export class VerificationAuthRequiredError extends Error {
  constructor(purpose: string) {
    super(`Verification purpose ${purpose} requires an authenticated requester`);
    this.name = 'VerificationAuthRequiredError';
  }
}

export class VerificationSubjectBindingViolationError extends Error {
  constructor(reason: string) {
    super(`Verification subject binding violation: ${reason}`);
    this.name = 'VerificationSubjectBindingViolationError';
  }
}

export class VerificationTenantBindingViolationError extends Error {
  constructor(reason: string) {
    super(`Verification tenant binding violation: ${reason}`);
    this.name = 'VerificationTenantBindingViolationError';
  }
}

export class VerificationScopeMismatchError extends Error {
  constructor(reason: string) {
    super(`Verification scope mismatch: ${reason}`);
    this.name = 'VerificationScopeMismatchError';
  }
}

export function isVerificationPurpose(value: string): value is VerificationPurpose {
  return (ALL_VERIFICATION_PURPOSES as readonly string[]).includes(value);
}

/**
 * TEST-ONLY override layer. `PURPOSE_POLICIES` above is the real,
 * shipped-disabled-by-default registry and is never mutated. Integration
 * tests need to exercise the full lifecycle of a purpose end-to-end
 * against real Postgres, which requires temporarily treating one purpose
 * as enabled FOR THAT TEST PROCESS ONLY — this is NOT a production
 * enablement mechanism (no route, env var, or admin action can reach it;
 * it is only reachable by importing this exact function from a test file).
 */
const testOverrides = new Map<VerificationPurpose, Partial<PurposePolicy>>();

export function __setPurposePolicyOverrideForTests(purpose: VerificationPurpose, override: Partial<PurposePolicy> | null): void {
  assertTestEnvironment('__setPurposePolicyOverrideForTests');
  if (override === null) testOverrides.delete(purpose);
  else testOverrides.set(purpose, override);
}

export function __clearAllPurposePolicyOverridesForTests(): void {
  assertTestEnvironment('__clearAllPurposePolicyOverridesForTests');
  testOverrides.clear();
}

export function getPurposePolicy(purpose: string): PurposePolicy {
  if (!isVerificationPurpose(purpose)) throw new UnknownVerificationPurposeError(purpose);
  const base = PURPOSE_POLICIES[purpose];
  const override = testOverrides.get(purpose);
  return override ? clampPolicy({ ...base, ...override }) : base;
}

/**
 * The mandatory, first-thing-called dormancy gate. Every entry point in
 * service.ts calls this BEFORE constructing any database call — a disabled
 * purpose therefore creates zero challenge rows, zero delivery jobs, and
 * sends nothing, by construction (proven directly, without a database, by
 * src/test/verification/purposeDormancy.test.ts, and independently again
 * at the database layer by the "disabled purpose ⇒ zero writes" PG test).
 */
export function assertPurposeEnabled(purpose: string): PurposePolicy {
  const policy = getPurposePolicy(purpose);
  if (!policy.enabled) throw new VerificationPurposeDisabledError(purpose);
  return policy;
}

export function assertChannelAllowed(purpose: string, channel: VerificationChannel): PurposePolicy {
  const policy = assertPurposeEnabled(purpose);
  if (!policy.allowedChannels.includes(channel)) {
    throw new VerificationChannelNotAllowedError(purpose, channel);
  }
  return policy;
}

export interface PolicyBindingContext {
  /** Omitted (not merely undefined-checked-loosely) for verify/consume, which carry no subjectKind field at all. */
  subjectKind?: VerificationSubjectKind;
  subjectRef?: string;
  workspaceId?: string;
  authenticatedUserId?: string;
}

/**
 * The mandatory second half of the dormancy/authorization gate: even an
 * ENABLED purpose must have requiresAuth/subjectBinding/tenantBinding
 * enforced on EVERY mutation (request, resend, verify, consume) — called
 * immediately after assertChannelAllowed/assertPurposeEnabled, before any
 * database call. Every check here is a strict presence/equality test —
 * omitting subjectRef or workspaceId never relaxes a requirement that
 * exists; there is no "if provided, then check" branch that a caller could
 * bypass by simply not sending a field.
 */
export function assertPolicyBindings(purpose: VerificationPurpose, policy: PurposePolicy, ctx: PolicyBindingContext): void {
  if (policy.requiresAuth && !ctx.authenticatedUserId) {
    throw new VerificationAuthRequiredError(purpose);
  }
  if (ctx.subjectKind !== undefined && ctx.subjectKind !== policy.subjectBinding) {
    throw new VerificationSubjectBindingViolationError(
      `purpose ${purpose} requires subjectKind '${policy.subjectBinding}', got '${ctx.subjectKind}'`,
    );
  }
  if (policy.subjectBinding === 'user') {
    if (!ctx.subjectRef) {
      throw new VerificationSubjectBindingViolationError(`purpose ${purpose} requires a subjectRef`);
    }
    if (policy.requiresAuth && ctx.subjectRef !== ctx.authenticatedUserId) {
      throw new VerificationSubjectBindingViolationError(
        `purpose ${purpose} requires the authenticated requester to act only on their own subject`,
      );
    }
  }
  if (policy.tenantBinding === 'required' && !ctx.workspaceId) {
    throw new VerificationTenantBindingViolationError(`purpose ${purpose} requires a workspaceId`);
  }
  if (policy.tenantBinding === 'none' && ctx.workspaceId) {
    throw new VerificationTenantBindingViolationError(`purpose ${purpose} forbids a workspaceId`);
  }
}

/**
 * Guards every test-only override hook so it is unreachable outside a
 * genuine test process — not merely "no production code imports it" (true
 * before, but not a hard guarantee), but an active runtime check.
 */
function assertTestEnvironment(hookName: string): void {
  const isVitest = process.env.VITEST === 'true' || typeof process.env.VITEST_WORKER_ID !== 'undefined';
  const isNodeTestEnv = process.env.NODE_ENV === 'test';
  if (!isVitest && !isNodeTestEnv) {
    throw new Error(`${hookName} is only callable under a test environment (VITEST=true or NODE_ENV=test)`);
  }
}

// ─── Request/response shapes for the internal service contract ───

export interface RequestChallengeInput {
  purpose: VerificationPurpose;
  channel: VerificationChannel;
  destination: string;                 // raw email/phone, normalized inside the service
  subjectKind: VerificationSubjectKind;
  subjectRef?: string;                 // e.g. an existing user id
  workspaceId?: string;
  locale?: VerificationLocale;         // explicit override; otherwise resolved per docs/GENERIC_VERIFICATION_CORE.md §Locale
  idempotencyKey: string;              // caller-supplied, e.g. a client-generated request id
  requester: { ipAddress: string | null; authenticatedUserId?: string };
  metadata?: Record<string, unknown>;  // safe, non-secret — never the OTP, never a raw destination beyond what's already in `destination`
}

/**
 * A resend targets one SPECIFIC existing challenge by its own handle — it
 * is never "find whatever is live for this destination/purpose/channel"
 * (that loose lookup let a resend in workspace B revoke a live challenge in
 * workspace A sharing the same destination — see
 * docs/GENERIC_VERIFICATION_CORE.md §Lifecycle). The claimed scope
 * (purpose/channel/subjectKind/subjectRef/workspaceId) must match the
 * EXISTING challenge's own recorded scope exactly, re-validated
 * server-side under a row lock — this input shape is the caller's claim,
 * not a trusted fact.
 */
export interface ResendChallengeInput {
  handle: string;
  purpose: VerificationPurpose;
  channel: VerificationChannel;
  subjectKind: VerificationSubjectKind;
  subjectRef?: string;
  workspaceId?: string;
  locale?: VerificationLocale;
  idempotencyKey: string;
  requester: { ipAddress: string | null; authenticatedUserId?: string };
  metadata?: Record<string, unknown>;
}

export interface RequestChallengeResult {
  handle: string;
  generation: number;
  expiresAt: string;
  resendAvailableAt: string;
  /**
   * What actually happened when Express called the provider, in THIS
   * request/resend call — never populated by a background process, because
   * there is none. 'provider_accepted' is the only outcome a caller should
   * treat as "the code is on its way"; every other value means the caller
   * should surface a retry/resend affordance to the end user. See
   * docs/GENERIC_VERIFICATION_CORE.md §Delivery for the full state machine.
   */
  deliveryOutcome: 'provider_accepted' | 'retryable_failure' | 'permanent_failure' | 'unconfigured' | 'ambiguous' | 'derivation_key_unavailable';
}

export interface VerifyChallengeInput {
  handle: string;
  code: string;
  purpose: VerificationPurpose;
  channel: VerificationChannel;
  workspaceId?: string;
  subjectRef?: string;
  /** Required — makes verify idempotent-by-construction. See docs/GENERIC_VERIFICATION_CORE.md §Idempotency. */
  requestId: string;
  requester: { ipAddress: string | null; authenticatedUserId?: string };
}

export interface VerifyChallengeResult {
  ok: boolean;
  reason?: string;
  proofToken?: string; // raw, single-use — returned ONCE, never persisted anywhere in plaintext
}

export interface ConsumeProofInput {
  proofToken: string;
  purpose: VerificationPurpose;
  channel: VerificationChannel;
  workspaceId?: string;
  subjectRef?: string;
  /** Only present when the calling context already holds an authenticated session — required for assertPolicyBindings' requiresAuth check. */
  authenticatedUserId?: string;
  consumedByContext: string;
}

export interface ConsumeProofResult {
  ok: boolean;
  reason?: string;
  challengeId?: string;
  subjectRef?: string;
  /**
   * The AUTHORITATIVE normalized destination the underlying challenge was
   * actually verified for (email or phone, per channel) — read from the
   * proof row itself, which is populated from the LOCKED challenge at
   * verify-time (see `_gv_do_verify` / `verification_proofs.destination_
   * normalized` in the migration). A future consumer MUST use this value
   * for its own business mutation (e.g. "which email to actually set as
   * verified") rather than trusting any client-supplied destination
   * independently — a proof for destination A can never be used to
   * authorize an action against destination B, because the consumer never
   * has to (and must not) accept a destination as input at all when a
   * verified one is available here.
   */
  destinationNormalized?: string;
}

/**
 * Revocation is a privileged mutation on an EXISTING challenge and is
 * scoped/authorized exactly like verify/resend — never accepted on
 * `handle`+`purpose` alone. `channel`, `workspaceId`, and `subjectRef` are
 * the caller's CLAIMED scope, re-validated server-side under a row lock
 * against the challenge's own recorded scope (see `_gv_do_revoke`); a
 * mismatch on any of them is rejected with the same generic failure as a
 * non-existent handle.
 */
export interface RevokeChallengeInput {
  handle: string;
  purpose: VerificationPurpose;
  channel: VerificationChannel;
  reason: string;
  workspaceId?: string;
  subjectRef?: string;
  idempotencyKey: string;
  requester: { ipAddress: string | null; authenticatedUserId?: string };
}

export interface SafeVerificationStatus {
  status: string;
  purpose: string;
  channel: string;
  generation: number;
  expiresAt: string;
  attemptsRemaining: number;
  resendAvailableAt: string;
}
