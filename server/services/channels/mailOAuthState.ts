/**
 * The single-use `state` of a mailbox OAuth connect (Gmail, Yahoo Mail),
 * bound to the member who started it.
 *
 * The provider's redirect lands on one fixed, unauthenticated callback, so a
 * state alone proved only that SOMEONE started a connect for a workspace. An
 * attacker could start one in their own workspace and send a victim the
 * consent link ("connect our shared inbox"): the victim's consent connected
 * the victim's mailbox (read, modify, send) to the attacker's workspace.
 *
 * Now the callback exchanges nothing. It hands the code and state to the web
 * panel, which finishes the connect with the signed-in member's own session
 * (POST /api/plugins/{gmail,yahoo}/oauth/complete); the state is consumed
 * only by the member who started it (`initiated_by`), and the code is worth
 * nothing without the platform's client secret.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type MailOAuthProvider = 'gmail' | 'yahoo';

export interface MailOAuthStateRow {
  token: string;
  workspace_id: string;
  installation_id: string;
  initiated_by: string | null;
  consumed_at: string | null;
  expires_at: string;
}

/** The state, while it is still usable (not consumed, not expired); else null. */
export async function readMailOAuthState(
  config: ServerConfig,
  provider: MailOAuthProvider,
  token: string,
): Promise<MailOAuthStateRow | null> {
  if (!token) return null;
  const { data, error } = await getServiceClient(config)
    .from('channel_oauth_states')
    .select('token, workspace_id, installation_id, initiated_by, consumed_at, expires_at')
    .eq('token', token)
    .eq('provider', provider)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as MailOAuthStateRow;
  if (row.consumed_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

/**
 * Consumes the state for the member who started it. Null when the state is
 * unusable, belongs to another member, or another request consumed it first.
 */
export async function consumeMailOAuthState(
  config: ServerConfig,
  provider: MailOAuthProvider,
  token: string,
  userId: string,
): Promise<MailOAuthStateRow | null> {
  const row = await readMailOAuthState(config, provider, token);
  if (!row || !userId || row.initiated_by !== userId) return null;
  // Mark used before anything else, so a retried or duplicated completion
  // can never replay the same code twice.
  const { error, count } = await getServiceClient(config)
    .from('channel_oauth_states')
    .update({ consumed_at: new Date().toISOString() }, { count: 'exact' })
    .eq('token', token)
    .eq('provider', provider)
    .eq('initiated_by', userId)
    .is('consumed_at', null);
  if (error || !count) return null;
  return row;
}
