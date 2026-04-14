// ============================================
// AUTH EMAIL SENDER — self-hosted
// Handles verification, password reset, welcome emails
// using the email_templates table + email service.
// This replaces Supabase default auth emails.
// ============================================

import type { ServerConfig } from '../../config.js';
import { sendEmail } from './index.js';
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
 * Uses email_templates table as the single source of truth.
 */
export async function sendAuthEmail(
  config: ServerConfig,
  params: AuthEmailParams
) {
  const { type, email, locale = 'en', variables, workspaceId } = params;
  const wsId = workspaceId || '00000000-0000-0000-0000-000000000000';

  return sendEmail(config, {
    workspaceId: wsId,
    to: email,
    templateSlug: type,
    templateData: variables,
    locale,
  });
}

/**
 * Generate a custom email verification token and send verification email.
 * This bypasses Supabase's built-in email verification.
 */
export async function sendVerificationEmail(
  config: ServerConfig,
  userId: string,
  email: string,
  locale: string = 'en',
  brandName: string = 'Platform'
) {
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);

  // Generate a verification link using Supabase Admin API
  const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
    type: 'signup',
    email,
  });

  if (linkError) {
    console.error('[auth-email] Failed to generate verification link:', linkError);
    return { success: false, error: linkError.message };
  }

  const actionUrl = linkData?.properties?.action_link || `${config.supabaseUrl}/auth/v1/verify`;
  
  // Get user profile for name
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
    variables: {
      name,
      brand: brandName,
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
  brandName: string = 'Platform'
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

  // Get user profile for name
  const { data: user } = await supabase.auth.admin.getUserByEmail(email).catch(() => ({ data: null })) as any;
  const name = user?.user?.user_metadata?.full_name || email.split('@')[0];

  return sendAuthEmail(config, {
    type: 'password_reset',
    email,
    locale,
    variables: {
      name,
      brand: brandName,
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
  brandName: string = 'Platform'
) {
  return sendAuthEmail(config, {
    type: 'welcome',
    email,
    locale,
    variables: {
      name,
      brand: brandName,
    },
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
  brandName: string = 'Platform',
  loginUrl: string = ''
) {
  const name = email.split('@')[0];
  return sendAuthEmail(config, {
    type: 'admin_created_user',
    email,
    locale,
    variables: {
      name,
      brand: brandName,
      email,
      temp_password: tempPassword,
      action_url: loginUrl || `${config.supabaseUrl.replace(/\/+$/, '')}/auth/login`,
    },
  });
}
