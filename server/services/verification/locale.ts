/**
 * Generic Verification Core v1 — locale resolution.
 *
 * Precedence (identical to the proven Workspace Invitations v5.1 rule —
 * server/routes/workspaceInvitations.ts's resolveEffectiveLocale — and
 * deliberately generalized rather than reimplemented differently):
 *   1. an explicit, caller-supplied locale (e.g. the user's own site/UI
 *      selection at the moment of the request)
 *   2. the bound workspace's configured locale (`panel_locale` then
 *      `default_locale`, same columns `workspaces` has carried since
 *      001_core_tables.sql)
 *   3. 'en'
 *
 * `Accept-Language` is NEVER consulted — callers must not pass it in as
 * the "explicit" locale. The resolved locale is meant to be persisted on
 * the challenge row at creation time (mirroring the v5.1 pattern of
 * freezing the locale so a notification sent hours later still matches
 * what was true when the user asked, not their browser state right now).
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import type { VerificationLocale } from './types.js';

const SUPPORTED: readonly VerificationLocale[] = ['fa', 'tr', 'en'];

function isSupportedLocale(value: unknown): value is VerificationLocale {
  return typeof value === 'string' && (SUPPORTED as readonly string[]).includes(value);
}

export async function resolveEffectiveLocale(
  config: ServerConfig,
  explicit: string | undefined,
  workspaceId: string | undefined,
): Promise<VerificationLocale> {
  if (isSupportedLocale(explicit)) return explicit;

  if (workspaceId) {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('workspaces')
      .select('panel_locale, default_locale')
      .eq('id', workspaceId)
      .maybeSingle();
    const candidate = data?.panel_locale || data?.default_locale;
    const primary = typeof candidate === 'string' ? candidate.split('-')[0] : undefined;
    if (isSupportedLocale(primary)) return primary;
  }

  return 'en';
}
