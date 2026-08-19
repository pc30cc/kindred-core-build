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

async function resolveAppBaseUrl(config: ServerConfig) {
  const sb = getServiceClient(config);
  const { data: domains } = await sb
    .from('platform_domains')
    .select('app_base_url')
    .limit(1)
    .maybeSingle();

  return domains?.app_base_url || process.env.APP_BASE_URL || config.corsOrigins[0] || 'http://localhost:5173';
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
