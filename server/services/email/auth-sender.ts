// ============================================
// AUTH EMAIL SENDER — self-hosted
// Uses runtime config resolver for all identity.
// No hardcoded brand names, URLs, or sender info.
// ============================================

import type { ServerConfig } from '../../config.js';
import { sendEmail } from './index.js';
import { resolveConfig, buildTemplateVariables } from '../config/resolver.js';
import { createClient } from '@supabase/supabase-js';

interface AuthEmailParams {
  type: 'email_verify' | 'password_reset' | 'magic_link' | 'welcome' | 'invite_member' | 'admin_created_user';
  email: string;
  locale?: string;
  variables: Record<string, string>;
  workspaceId?: string;
}

/**
 * Send an auth-related email through the self-hosted email system.
 * All identity (brand name, sender, URLs) comes from the config resolver.
 */
export async function sendAuthEmail(
  config: ServerConfig,
  params: AuthEmailParams
) {
  const { type, email, locale = 'en', variables, workspaceId } = params;
  const wsId = workspaceId || '00000000-0000-0000-0000-000000000000';

  // Resolve runtime config for identity
  const resolved = await resolveConfig(config, { workspaceId: wsId !== '00000000-0000-0000-0000-000000000000' ? wsId : undefined, locale });
  const configVars = buildTemplateVariables(resolved);

  // Merge config variables with auth-specific variables
  const mergedVars = { ...configVars, ...variables };
  // Ensure 'brand' variable maps to resolved platform name
  if (!mergedVars.brand) {
    mergedVars.brand = resolved.identity.platformName;
  }

  return sendEmail(config, {
    workspaceId: wsId,
    to: email,
    templateSlug: type,
    templateData: mergedVars,
    locale,
    from: `${resolved.email.senderName} <${resolved.email.senderEmail}>`,
  });
}

/**
 * Generate a custom email verification token and send verification email.
 */
export async function sendVerificationEmail(
  config: ServerConfig,
  userId: string,
  email: string,
  locale: string = 'en',
  workspaceId?: string
) {
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);

  const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
    type: 'signup',
    email,
    password: crypto.randomUUID(),
  } as any);

  if (linkError) {
    console.error('[auth-email] Failed to generate verification link:', linkError);
    return { success: false, error: linkError.message };
  }

  const actionUrl = linkData?.properties?.action_link || `${config.supabaseUrl}/auth/v1/verify`;

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', userId)
    .maybeSingle();

  const name = profile?.full_name || email.split('@')[0];

  return sendAuthEmail(config, {
    type: 'email_verify',
    email,
    locale,
    workspaceId,
    variables: {
      name,
      action_url: actionUrl,
      expiry_time: '60',
    },
  });
}

/**
 * Send password reset email through self-hosted system.
 */
export async function sendPasswordResetEmail(
  config: ServerConfig,
  email: string,
  locale: string = 'en',
  workspaceId?: string
) {
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);

  const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
    type: 'recovery',
    email,
  });

  if (linkError) {
    console.error('[auth-email] Failed to generate recovery link:', linkError);
    return { success: false, error: linkError.message };
  }

  const actionUrl = linkData?.properties?.action_link || '';

  let name = email.split('@')[0];
  try {
    const { data: { users } } = await supabase.auth.admin.listUsers();
    const found = users.find((u: any) => u.email === email);
    if (found?.user_metadata?.full_name) name = found.user_metadata.full_name;
  } catch {}

  return sendAuthEmail(config, {
    type: 'password_reset',
    email,
    locale,
    workspaceId,
    variables: {
      name,
      action_url: actionUrl,
    },
  });
}

/**
 * Send welcome email after successful signup.
 */
export async function sendWelcomeEmail(
  config: ServerConfig,
  email: string,
  name: string,
  locale: string = 'en',
  workspaceId?: string
) {
  return sendAuthEmail(config, {
    type: 'welcome',
    email,
    locale,
    workspaceId,
    variables: { name },
  });
}

/**
 * Send admin-created user notification.
 */
export async function sendAdminCreatedUserEmail(
  config: ServerConfig,
  email: string,
  tempPassword: string,
  locale: string = 'en',
  workspaceId?: string,
  loginUrl?: string
) {
  // Resolve config for login URL
  const resolved = await resolveConfig(config, { workspaceId, locale });
  const appBase = resolved.domains.appBaseUrl || '';

  const name = email.split('@')[0];
  return sendAuthEmail(config, {
    type: 'admin_created_user',
    email,
    locale,
    workspaceId,
    variables: {
      name,
      email,
      temp_password: tempPassword,
      action_url: loginUrl || `${appBase}/auth/login`,
    },
  });
}
