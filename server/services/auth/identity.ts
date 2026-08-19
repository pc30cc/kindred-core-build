/**
 * First-party identity lookup — `profiles` (the identity root as of auth
 * migration 026) joined with `user_credentials` (024). Replaces the old
 * `sb.auth.admin.getUserById`/`listUsers`-based lookups: those walked
 * `auth.users`, which is no longer this codebase's root of trust and won't
 * contain new first-party signups at all.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export interface Identity {
  id: string;
  email: string;
  fullName: string | null;
  phone: string | null;
  createdAt: string | null;
  passwordHash: string | null;
  emailVerifiedAt: string | null;
  status: 'active' | 'disabled';
}

/** Looks up an identity by normalized email. Returns null if no profile matches — never throws for "not found". */
export async function findIdentityByEmail(config: ServerConfig, email: string): Promise<Identity | null> {
  const sb = getServiceClient(config);
  const normalizedEmail = email.trim().toLowerCase();

  const { data: profile, error: profileError } = await sb
    .from('profiles')
    .select('id, email, full_name, phone, created_at')
    .eq('email', normalizedEmail)
    .maybeSingle();

  if (profileError) {
    throw new Error(`Failed to look up profile: ${profileError.message}`);
  }
  if (!profile?.id) return null;

  return identityFromProfileRow(config, profile);
}

/** Looks up an identity by profile id (== user_credentials.user_id). Returns null if no profile matches. */
export async function findIdentityById(config: ServerConfig, userId: string): Promise<Identity | null> {
  const sb = getServiceClient(config);
  const { data: profile, error: profileError } = await sb
    .from('profiles')
    .select('id, email, full_name, phone, created_at')
    .eq('id', userId)
    .maybeSingle();

  if (profileError) {
    throw new Error(`Failed to look up profile: ${profileError.message}`);
  }
  if (!profile?.id || !profile.email) return null;

  return identityFromProfileRow(config, profile);
}

interface ProfileRow {
  id: string;
  email: string | null;
  full_name: string | null;
  phone: string | null;
  created_at: string | null;
}

/**
 * Server-side email-verification gate — NEW-signup policy, deliberately
 * separate from legacy-user compatibility (029_backfill_legacy_email_
 * verification.sql corrects historical state; this function does not care
 * how a user got their verified/unverified state, only what it currently
 * is). Enforced, not just UI-nudged, on the specific abuse-relevant
 * operations named in the GoTrue-off closure review: creating a workspace
 * (an unverified/squatted account should not be able to become an owner)
 * and sending invitations (an unverified account should not be able to
 * pull other people into a workspace it controls). Everything else an
 * unverified account can already reach — existing memberships, the
 * dashboard itself — stays reachable, matching the documented decision not
 * to mass-lock-out every current user by gating login/session-restore on
 * this flag.
 */
export async function isEmailVerified(config: ServerConfig, userId: string): Promise<boolean> {
  const identity = await findIdentityById(config, userId);
  return !!identity?.emailVerifiedAt;
}

async function identityFromProfileRow(config: ServerConfig, profile: ProfileRow): Promise<Identity> {
  const sb = getServiceClient(config);
  const { data: cred, error: credError } = await sb
    .from('user_credentials')
    .select('password_hash, email_verified_at, status')
    .eq('user_id', profile.id)
    .maybeSingle();

  if (credError) {
    throw new Error(`Failed to look up credentials: ${credError.message}`);
  }

  return {
    id: profile.id,
    email: profile.email ?? '',
    fullName: profile.full_name ?? null,
    phone: profile.phone ?? null,
    createdAt: profile.created_at ?? null,
    passwordHash: cred?.password_hash ?? null,
    emailVerifiedAt: cred?.email_verified_at ?? null,
    status: (cred?.status as 'active' | 'disabled' | undefined) ?? 'active',
  };
}
