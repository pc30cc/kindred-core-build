/**
 * Members of one workspace who never see each other (owner, 2026-11-04:
 * "mahmod sees only Maryam and Mojtaba, not Golpari; the same for Golpari").
 *
 * A pair in `workspace_member_hidden_pairs` (migration 295) hides the two
 * members from each other, both ways, on every surface a member is shown to
 * a teammate:
 *   - the team chat: the colleague list (web panel, iPhone, Android), the
 *     thread and sending (as if the other were not a member);
 *   - colleague calls: neither can ring the other;
 *   - the team list (GET /api/workspace-members) and the team's presence
 *     (GET /api/availability/team/:workspaceId), for the two of them only.
 * Everyone else, the owner and admins included, still sees both. A pair
 * goes with either membership (ON DELETE CASCADE).
 *
 * The rule is this file. Before migration 295 there are no pairs (the table
 * is missing, nobody is hidden); any other failed read throws, so a list is
 * never served on a guess.
 */
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';

const TABLE = 'workspace_member_hidden_pairs';

type PairRow = { user_a: string; user_b: string };

/** The table is not there yet (migration 295 not applied). */
function isMissingTable(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null | undefined;
  const code = String(e?.code ?? '');
  if (code !== '42P01' && code !== 'PGRST205') return false;
  return String(e?.message ?? '').includes(TABLE);
}

/**
 * The members of [workspaceId] hidden from [userId] (and who [userId] is
 * hidden from: a pair works both ways). Empty for nearly everyone.
 */
export async function hiddenMembersFor(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
): Promise<Set<string>> {
  const hidden = new Set<string>();
  if (!workspaceId || !userId) return hidden;
  // A workspace has a handful of pairs at most: read them all, keep [userId]'s.
  const { data, error } = await getServiceClient(config)
    .from(TABLE)
    .select('user_a, user_b')
    .eq('workspace_id', workspaceId);
  if (error) {
    if (isMissingTable(error)) return hidden;
    throw new Error(`team_visibility_read_failed: ${(error as { message?: string }).message ?? 'unknown'}`);
  }
  for (const row of (data ?? []) as PairRow[]) {
    if (row.user_a === userId && row.user_b) hidden.add(row.user_b);
    else if (row.user_b === userId && row.user_a) hidden.add(row.user_a);
  }
  return hidden;
}

/** Whether [a] and [b], members of [workspaceId], are hidden from each other. */
export async function areHiddenFromEachOther(
  config: ServerConfig,
  workspaceId: string,
  a: string,
  b: string,
): Promise<boolean> {
  if (!a || !b || a === b) return false;
  return (await hiddenMembersFor(config, workspaceId, a)).has(b);
}
