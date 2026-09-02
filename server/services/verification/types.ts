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
  if (override === null) testOverrides.delete(purpose);
  else testOverrides.set(purpose, override);
}

export function __clearAllPurposePolicyOverridesForTests(): void {
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
  requester: { ipAddress: string | null };
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
  consumedByContext: string;
}

export interface ConsumeProofResult {
  ok: boolean;
  reason?: string;
  challengeId?: string;
  subjectRef?: string;
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
