/**
 * Call Center — recording capability resolver (CC-2E).
 *
 * Computes whether call recording is "effectively enabled" for a workspace,
 * factoring in:
 *   - platform kill-switch (call_recording_enabled)
 *   - workspace toggle (recording_enabled)
 *   - consent-required policy (recording_consent_required)
 *   - provider support (provider implements startRecording/stopRecording)
 *   - provider configuration (LiveKit egress + storage credentials)
 *
 * STRICT: never returns secrets or storage paths.
 */
import type { ServerConfig } from '../../config.js';
import { loadLiveKitConfig } from '../calls/livekitConfig.js';
import { resolveEffectiveCallProvider } from '../calls/providerResolver.js';
import { checkEntitlementFromDB } from '../../middleware/featureGating.js';
import type {
  PlatformCallCenterSettings,
  WorkspaceCallCenterSettings,
} from './settings.js';

export interface RecordingCapability {
  enabled_by_platform: boolean;
  enabled_by_plan: boolean;
  enabled_by_workspace: boolean;
  consent_required: boolean;
  provider_supported: boolean;
  provider_configured: boolean;
  effective_enabled: boolean;
  reason?: string;
}

const EMPTY_DISABLED: RecordingCapability = {
  enabled_by_platform: false,
  enabled_by_plan: false,
  enabled_by_workspace: false,
  consent_required: false,
  provider_supported: false,
  provider_configured: false,
  effective_enabled: false,
  reason: 'platform_disabled',
};

export async function computeRecordingCapability(
  config: ServerConfig,
  workspaceId: string,
  platform: PlatformCallCenterSettings,
  workspace: WorkspaceCallCenterSettings,
): Promise<RecordingCapability> {
  const enabled_by_platform = !!platform.call_recording_enabled;
  const enabled_by_workspace = !!workspace.recording_enabled;
  const consent_required = !!workspace.recording_consent_required;

  // Plan-level entitlement. Fail closed on RPC error.
  let enabled_by_plan = false;
  try {
    const r = await checkEntitlementFromDB(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      workspaceId,
      'call_recording',
    );
    enabled_by_plan = !!r.allowed;
  } catch {
    enabled_by_plan = false;
  }

  let provider_supported = false;
  let providerId: string | null = null;
  try {
    const r = await resolveEffectiveCallProvider(config, workspaceId);
    providerId = r.id;
    const p: any = r.provider;
    // Source of truth: provider.supportsRecording(). Method existence is NOT enough.
    if (typeof p.supportsRecording === 'function') {
      try { provider_supported = !!p.supportsRecording(); } catch { provider_supported = false; }
    } else {
      provider_supported = false;
    }
  } catch {
    // provider not configured at all
  }

  let provider_configured = false;
  if (providerId === 'livekit') {
    try {
      const lk = await loadLiveKitConfig(config);
      const s = lk.recording_storage;
      provider_configured = !!(
        lk.egress_enabled && s && s.bucket && s.access_key && s.secret_key
      );
    } catch { /* leave false */ }
  } else {
    // No safe provider-specific configuration check available for non-livekit
    // providers in this pass — fail closed.
    provider_configured = false;
  }

  let reason: string | undefined;
  if (!enabled_by_platform) reason = 'platform_disabled';
  else if (!enabled_by_plan) reason = 'plan_forbidden';
  else if (!enabled_by_workspace) reason = 'workspace_disabled';
  else if (!provider_supported) reason = 'provider_not_supported';
  else if (!provider_configured) reason = 'provider_not_configured';

  const effective_enabled =
    enabled_by_platform && enabled_by_plan && enabled_by_workspace
    && provider_supported && provider_configured;

  return {
    enabled_by_platform,
    enabled_by_plan,
    enabled_by_workspace,
    consent_required,
    provider_supported,
    provider_configured,
    effective_enabled,
    reason,
  };
}

export function disabledRecordingCapability(): RecordingCapability {
  return { ...EMPTY_DISABLED };
}