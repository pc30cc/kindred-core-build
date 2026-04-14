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
  // fallback to English
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

interface SignupLinkEmailOptions {
  email: string;
  password: string;
  fullName?: string | null;
  website?: string | null;
  locale?: string;
}

interface RecoveryLinkEmailOptions {
  email: string;
  fullName?: string | null;
  locale?: string;
}

async function generateActionLink(
  config: ServerConfig,
  params: {
    type: 'signup' | 'recovery';
    email: string;
    password?: string;
    redirectPath: string;
    data?: Record<string, unknown>;
  },
): Promise<{ actionLink: string; userId?: string }> {
  const sb = getServiceClient(config);
  const appBaseUrl = await resolveAppBaseUrl(config);
  const redirectTo = `${appBaseUrl}${params.redirectPath}`;

  const { data, error } = await sb.auth.admin.generateLink({
    type: params.type,
    email: params.email,
    password: params.password,
    options: {
      data: params.data,
      redirectTo,
    },
  });

  if (error) {
    throw new Error(error.message || `Failed to generate ${params.type} link`);
  }

  const rawActionLink = data.properties?.action_link;
  if (!rawActionLink) {
    throw new Error(`Missing ${params.type} action link`);
  }

  try {
    const parsed = new URL(rawActionLink);
    parsed.searchParams.set('redirect_to', redirectTo);
    return { actionLink: parsed.toString(), userId: data.user?.id };
  } catch {
    return { actionLink: rawActionLink, userId: data.user?.id };
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

export async function issueSignupLinkEmail(
  config: ServerConfig,
  options: SignupLinkEmailOptions,
): Promise<{ success: boolean; userId?: string; error?: string }> {
  try {
    const normalizedWebsite = options.website?.trim() || '';
    const metadata = {
      full_name: options.fullName?.trim() || '',
      website: normalizedWebsite,
      website_url: normalizedWebsite,
      locale: options.locale || 'en',
    };

    const [{ actionLink, userId }, workspaceId] = await Promise.all([
      generateActionLink(config, {
        type: 'signup',
        email: options.email,
        password: options.password,
        redirectPath: '/auth/email-confirmed',
        data: metadata,
      }),
      resolveWorkspaceId(config),
    ]);

    const result = await sendEmail(config, {
      workspaceId,
      to: options.email,
      templateSlug: 'email_verify',
      templateData: {
        name: options.fullName || options.email.split('@')[0],
        brand: 'Platform',
        action_url: actionLink,
        email: options.email,
      },
      locale: options.locale || 'en',
    });

    if (!result.success) {
      return { success: false, error: result.error };
    }

    return { success: true, userId };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to send signup email' };
  }
}

export async function issueRecoveryEmail(
  config: ServerConfig,
  options: RecoveryLinkEmailOptions,
): Promise<{ success: boolean; error?: string }> {
  try {
    const [{ actionLink }, workspaceId] = await Promise.all([
      generateActionLink(config, {
        type: 'recovery',
        email: options.email,
        redirectPath: '/auth/reset-password',
      }),
      resolveWorkspaceId(config),
    ]);

    const result = await sendEmail(config, {
      workspaceId,
      to: options.email,
      templateSlug: 'password_reset',
      templateData: {
        name: options.fullName || options.email.split('@')[0],
        brand: 'Platform',
        action_url: actionLink,
        email: options.email,
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