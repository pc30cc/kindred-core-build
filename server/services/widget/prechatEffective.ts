/**
 * The pre-chat form a workspace's visitors are asked, from the cached
 * snapshots: the Super Admin's policy (platform snapshot), the plan's
 * `widget_prechat_form` (workspace snapshot) and the workspace's own row.
 * The rule itself is shared/prechatPolicy.ts; this only gathers its inputs
 * for GET /identity/me, GET and POST /identity/prechat and the workspace's
 * PUT /api/widget-settings/:id/prechat.
 */
import type { ServerConfig } from '../../config.js';
import type { ServiceClient } from '../../supabase.js';
import { getWidgetPlatformSnapshot, getWorkspaceWidgetSnapshot } from './configSnapshot.js';
import { effectivePrechat, type EffectivePrechat, type PrechatPrivacyRow, type PrechatSettingsRow } from '../../../shared/prechatPolicy.js';

export interface PrechatPolicyInputs {
  /** The platform policy as stored (normalized by shared/prechatPolicy.ts). */
  policy: unknown;
  /** False only when the plan readably denies `widget_prechat_form`. */
  planAllowsForm: boolean;
}

/**
 * The policy and the plan's answer. A snapshot that cannot be built (or a
 * plan that cannot be read) keeps the workspace's own form under the
 * columns' default policy: what visitors were asked before these checks
 * existed, never a form taken away by a passing read error.
 */
export async function prechatPolicyInputs(config: ServerConfig, workspaceId: string): Promise<PrechatPolicyInputs> {
  const [platform, snap] = await Promise.all([
    getWidgetPlatformSnapshot(config).catch(() => null),
    getWorkspaceWidgetSnapshot(config, workspaceId).catch(() => null),
  ]);
  const ent = snap?.entitlements ?? null;
  const planAllowsForm = !(ent && !ent.degraded && ent.features.widget_prechat_form === false);
  return { policy: platform?.preChatPolicy ?? null, planAllowsForm };
}

/** The workspace's stored row (its privacy line too, migration 281), or null (none, or unreadable). */
export async function readPrechatRow(supabase: ServiceClient, workspaceId: string): Promise<(PrechatSettingsRow & PrechatPrivacyRow) | null> {
  const { data } = await supabase
    .from('widget_prechat_settings')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  return (data as (PrechatSettingsRow & PrechatPrivacyRow) | null) ?? null;
}

/** What the workspace's visitors are asked now. */
export async function loadEffectivePrechat(
  config: ServerConfig,
  supabase: ServiceClient,
  workspaceId: string,
): Promise<EffectivePrechat> {
  const [row, inputs] = await Promise.all([
    readPrechatRow(supabase, workspaceId),
    prechatPolicyInputs(config, workspaceId),
  ]);
  return effectivePrechat(row, inputs.policy, { planAllowsForm: inputs.planAllowsForm });
}

/**
 * Keeps the visitor's consent (the box of the form's privacy line, P-01) on
 * their contact, `metadata.privacy_consent`: when, from which form, and the
 * policy the line linked to then, so the workspace can show it was given.
 * Best-effort: the form was accepted either way.
 */
export async function recordPrivacyConsent(
  supabase: ServiceClient,
  workspaceId: string,
  contactId: string | null | undefined,
  source: 'prechat' | 'offline_form',
  policyUrl: string | null,
): Promise<void> {
  if (!contactId) return;
  try {
    const { data } = await supabase
      .from('contacts').select('metadata').eq('id', contactId).eq('workspace_id', workspaceId).maybeSingle();
    const raw = (data as { metadata?: unknown } | null)?.metadata;
    const metadata = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    await supabase
      .from('contacts')
      .update({ metadata: { ...metadata, privacy_consent: { at: new Date().toISOString(), source, policy_url: policyUrl } } })
      .eq('id', contactId)
      .eq('workspace_id', workspaceId);
  } catch { /* best-effort */ }
}
