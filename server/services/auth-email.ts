import crypto from 'crypto';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { sendEmail } from './email/index.js';

const PLATFORM_WORKSPACE_FALLBACK = '00000000-0000-0000-0000-000000000000';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return crypto.randomUUID();
}

/** True only for a real absolute http(s) URL — rejects '', undefined, and the '*' wildcard. */
function isValidHttpUrl(value: string | null | undefined): value is string {
  if (!value || value === '*') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Resolves the base URL used to build verification/reset links.
 *
 * `config.corsOrigins` defaults to `['*']` when CORS_ORIGINS is unset
 * (server/config.ts) — the old fallback chain's last resort,
 * `config.corsOrigins[0]`, could therefore silently become the literal
 * wildcard string, producing a broken link (wildcard immediately followed
 * by "/auth/...") in a real email with no error anywhere. Preference order now:
 *   1. `platform_domains.app_base_url` (operator-configured in the admin UI)
 *   2. `APP_BASE_URL` server env var
 *   3. a configured CORS origin, but ONLY if it's a real absolute http(s)
 *      URL — never the '*' wildcard
 *   4. `http://localhost:5173`, but ONLY outside production
 * In production, if none of 1–3 resolve to a real URL, this throws rather
 * than ever returning '*' or silently defaulting to localhost — callers
 * (issueVerificationEmail/issueRecoveryEmail) already catch and report
 * failures as `{ success: false, error }` instead of sending a broken link.
 */
export async function resolveAppBaseUrl(config: ServerConfig): Promise<string> {
  const sb = getServiceClient(config);
  const { data: domains } = await sb
    .from('platform_domains')
    .select('app_base_url')
    .limit(1)
    .maybeSingle();

  if (isValidHttpUrl(domains?.app_base_url)) {
    return stripTrailingSlash(domains.app_base_url);
  }

  const envBaseUrl = process.env.APP_BASE_URL;
  if (isValidHttpUrl(envBaseUrl)) {
    return stripTrailingSlash(envBaseUrl);
  }

  const corsOrigin = config.corsOrigins.find(isValidHttpUrl);
  if (corsOrigin) {
    return stripTrailingSlash(corsOrigin);
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'No valid application base URL is configured — refusing to send an auth ' +
        'email with a broken link. Set platform_domains.app_base_url (admin UI) ' +
        'or the APP_BASE_URL server environment variable to your dashboard\'s ' +
        'public https URL.',
    );
  }

  return 'http://localhost:5173';
}

async function resolveWorkspaceId(config: ServerConfig) {
  const sb = getServiceClient(config);
  const { data: workspace } = await sb.from('workspaces').select('id').limit(1).maybeSingle();
  return workspace?.id || PLATFORM_WORKSPACE_FALLBACK;
}

async function resolveBrandName(config: ServerConfig, locale: string = 'en'): Promise<string> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('platform_branding_localized')
    .select('platform_name')
    .eq('locale', locale)
    .maybeSingle();
  if (data?.platform_name) return data.platform_name;
  if (locale !== 'en') {
    const { data: fallback } = await sb
      .from('platform_branding_localized')
      .select('platform_name')
      .eq('locale', 'en')
      .maybeSingle();
    if (fallback?.platform_name) return fallback.platform_name;
  }
  return 'Platform';
}

interface VerificationEmailOptions {
  userId: string;
  email: string;
  fullName?: string | null;
  locale?: string;
  ipAddress?: string | null;
}

interface RecoveryEmailOptions {
  userId: string;
  email: string;
  fullName?: string | null;
  locale?: string;
}

/**
 * Localized "valid for N hours" label used inside auth email templates.
 * The templates only interpolate {{expiry_time}}, so the string itself must
 * already be in the recipient's language — otherwise Persian/Turkish emails
 * show an English duration.
 */
function expiryLabel(locale: string | undefined, hours: number): string {
  switch ((locale || 'en').slice(0, 2)) {
    case 'fa':
      return `${hours} ساعت`;
    case 'tr':
      return `${hours} saat`;
    default:
      return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
}


export async function issueVerificationEmail(
  config: ServerConfig,
  options: VerificationEmailOptions,
): Promise<{ success: boolean; error?: string }> {
  try {
    const sb = getServiceClient(config);

    await sb.from('auth_verify_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', options.userId)
      .is('used_at', null)
      .is('revoked_at', null);

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const { error: tokenInsertError } = await sb.from('auth_verify_tokens').insert({
      user_id: options.userId,
      email: options.email,
      token_hash: tokenHash,
      expires_at: expiresAt,
      ip_address: options.ipAddress || null,
    });

    if (tokenInsertError) {
      return { success: false, error: tokenInsertError.message };
    }

    const [appBaseUrl, workspaceId, brandName] = await Promise.all([
      resolveAppBaseUrl(config),
      resolveWorkspaceId(config),
      resolveBrandName(config, options.locale),
    ]);

    const verifyUrl = `${appBaseUrl}/auth/email-confirmed?token=${rawToken}`;
    const userName = options.fullName || options.email.split('@')[0];

    const result = await sendEmail(config, {
      workspaceId,
      to: options.email,
      templateSlug: 'email_verify',
      templateData: {
        name: userName,
        brand: brandName,
        action_url: verifyUrl,
        email: options.email,
        expiry_time: '24 hours',
        year: new Date().getFullYear().toString(),
        support_email: `support@${options.email.split('@')[1] || 'example.com'}`,
      },
      locale: options.locale || 'en',
    });

    if (!result.success) {
      return { success: false, error: result.error };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to send verification email' };
  }
}

/**
 * Issue a password recovery email using fully self-hosted token system.
 * No Supabase generateLink — uses auth_reset_tokens table + custom frontend URL.
 */
export async function issueRecoveryEmail(
  config: ServerConfig,
  options: RecoveryEmailOptions,
): Promise<{ success: boolean; error?: string }> {
  try {
    const sb = getServiceClient(config);

    // Revoke any existing unused reset tokens for this user
    await sb.from('auth_reset_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', options.userId)
      .is('used_at', null)
      .is('revoked_at', null);

    // Generate and store custom reset token
    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    const { error: tokenInsertError } = await sb.from('auth_reset_tokens').insert({
      user_id: options.userId,
      email: options.email,
      token_hash: tokenHash,
      expires_at: expiresAt,
      ip_address: null,
    });

    if (tokenInsertError) {
      return { success: false, error: tokenInsertError.message };
    }

    const [appBaseUrl, workspaceId, brandName] = await Promise.all([
      resolveAppBaseUrl(config),
      resolveWorkspaceId(config),
      resolveBrandName(config, options.locale),
    ]);

    const resetUrl = `${appBaseUrl}/auth/reset-password?token=${rawToken}`;
    const userName = options.fullName || options.email.split('@')[0];

    const result = await sendEmail(config, {
      workspaceId,
      to: options.email,
      templateSlug: 'password_reset',
      templateData: {
        name: userName,
        brand: brandName,
        action_url: resetUrl,
        email: options.email,
        expiry_time: '1 hour',
        year: new Date().getFullYear().toString(),
        support_email: `support@${options.email.split('@')[1] || 'example.com'}`,
      },
      locale: options.locale || 'en',
    });

    if (!result.success) {
      return { success: false, error: result.error };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to send recovery email' };
  }
}
