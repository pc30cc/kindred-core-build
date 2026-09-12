/**
 * SIGNUP VERIFICATION POLICY — one platform-wide source of truth.
 *
 * Two orthogonal operator choices, stored on `platform_settings`
 * (database/migrations/152_signup_verification_policy.sql) and edited in
 * Super Admin → Branding → Settings:
 *
 *   method: 'link' | 'otp'   — how the verification is delivered.
 *   gate:   'before' | 'after' — whether a workspace exists before the
 *                                email is verified.
 *
 * Every consumer (signup route, OTP routes, workspace provisioning gate,
 * the public policy endpoint the signup page reads) resolves the policy
 * through THIS module, never by reading the columns itself — so the
 * fail-closed default below is the only fallback in the system.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type SignupVerificationMethod = 'link' | 'otp';
export type SignupVerificationGate = 'before' | 'after';

export interface SignupVerificationPolicy {
  method: SignupVerificationMethod;
  gate: SignupVerificationGate;
}

/** Historical behaviour: emailed link, no workspace until verified. */
export const DEFAULT_SIGNUP_POLICY: SignupVerificationPolicy = { method: 'link', gate: 'before' };

const CACHE_TTL_MS = 30_000;
let cached: { value: SignupVerificationPolicy; at: number } | null = null;

/** Test/admin hook: drop the memo so the next read hits the database. */
export function invalidateSignupPolicyCache(): void {
  cached = null;
}

export async function getSignupVerificationPolicy(config: ServerConfig): Promise<SignupVerificationPolicy> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('platform_settings')
      .select('signup_verification_method, signup_verification_gate')
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);

    const rawMethod = (data as any)?.signup_verification_method;
    const rawGate = (data as any)?.signup_verification_gate;
    const value: SignupVerificationPolicy = {
      method: rawMethod === 'otp' ? 'otp' : 'link',
      gate: rawGate === 'after' ? 'after' : 'before',
    };
    cached = { value, at: Date.now() };
    return value;
  } catch (err) {
    // Never let a settings read failure change auth behaviour silently in
    // the permissive direction: fall back to the strict historical policy.
    console.error('[signup-policy] Falling back to default policy:', err);
    return DEFAULT_SIGNUP_POLICY;
  }
}
