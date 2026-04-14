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

interface VerificationEmailOptions {
  userId: string;
  email: string;
  fullName?: string | null;
  locale?: string;
  ipAddress?: string | null;
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

    const [appBaseUrl, workspaceId] = await Promise.all([
      resolveAppBaseUrl(config),
      resolveWorkspaceId(config),
    ]);

    const verifyUrl = `${appBaseUrl}/auth/email-confirmed?token=${rawToken}`;

    const result = await sendEmail(config, {
      workspaceId,
      to: options.email,
      templateSlug: 'email_verify',
      templateData: {
        name: options.fullName || options.email.split('@')[0],
        brand: 'Platform',
        action_url: verifyUrl,
        email: options.email,
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