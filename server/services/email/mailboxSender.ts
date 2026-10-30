/**
 * The display name a connected mailbox's replies go out under.
 *
 * A reply from the Email Inbox used to carry the bare address
 * (`support@shop.com`), which reads as less trustworthy than a name beside
 * it. Neither Google's nor Yahoo's sign-in gives us one: the connect flows
 * ask for the address only, and store it as the integration's display name
 * too. So the name is the integration's display name when someone has set a
 * real one, else the workspace's name, which is how the customer knows the
 * business. The address itself never changes: From stays the mailbox that
 * signs in, so alignment is unaffected.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import type { ChannelIntegration } from '../channels/integrations.js';

const MAX_NAME_LENGTH = 100;

/** One header-safe line: no CR/LF/NUL, no surrounding space, bounded. */
function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[\r\n\0]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return name || null;
}

/** Null when there is no name to give: the mail then goes out with the address alone, as before. */
export async function mailboxSenderName(
  config: ServerConfig,
  integration: Pick<ChannelIntegration, 'workspace_id' | 'display_name' | 'external_account_id'>,
): Promise<string | null> {
  const own = cleanName(integration.display_name);
  if (own && !own.includes('@')) return own;
  try {
    const { data } = await getServiceClient(config)
      .from('workspaces')
      .select('name')
      .eq('id', integration.workspace_id)
      .maybeSingle();
    return cleanName((data as { name?: unknown } | null)?.name);
  } catch {
    return null;
  }
}
