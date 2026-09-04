/**
 * AI Proactive Nudge — lifecycle state machine.
 *
 *   generated -> shown -> dismissed | clicked -> converted
 *   generated -> expired (never acknowledged before expires_at)
 *
 * This table is intentionally strict: no skipped or backwards transitions,
 * ever. Out-of-order arrival (e.g. a CTA click racing ahead of the shown
 * ack) is NOT handled by loosening this table — it's handled server-side,
 * atomically, by ai_nudge_apply_lifecycle_event() (see the migration),
 * which backfills the implied "shown" transition before applying the
 * requested one, in the same transaction as the canonical, idempotent
 * event insert. That RPC is the only path allowed to drive
 * shown/dismissed/clicked for 'ai_proactive' events — see
 * smartEngagement.ts's recordSmartEvent().
 *
 * transitionNudgeStatus() below remains a simple guarded UPDATE (no event
 * insert) for the one call site that has no analytics event of its own:
 * the /message handler's generated-by-attribution 'converted' transition,
 * which is not racy (it only ever follows an already-'clicked' nudge).
 */
export type NudgeStatus = 'generated' | 'shown' | 'dismissed' | 'clicked' | 'converted' | 'expired';

const ALLOWED_FROM: Record<NudgeStatus, NudgeStatus[]> = {
  generated: [],
  shown: ['generated'],
  dismissed: ['shown'],
  clicked: ['shown'],
  converted: ['clicked'],
  expired: ['generated'],
};

/**
 * Attempts a guarded status transition. Returns true only if a row was
 * actually updated — i.e. the nudge existed, belonged to this workspace,
 * and was in an allowed prior state. False is a safe, silent no-op for a
 * duplicate/stale/out-of-order event, never an error.
 */
export async function transitionNudgeStatus(
  supabase: any,
  args: { nudgeId: string; workspaceId: string; to: NudgeStatus; requireNotExpired?: boolean },
): Promise<boolean> {
  const from = ALLOWED_FROM[args.to];
  if (!from.length) return false;

  const patch: Record<string, unknown> = { status: args.to };
  if (args.to === 'shown') patch.shown_at = new Date().toISOString();

  let q: any = supabase
    .from('widget_ai_nudges' as any)
    .update(patch)
    .eq('id', args.nudgeId)
    .eq('workspace_id', args.workspaceId)
    .in('status', from);
  if (args.requireNotExpired) q = q.gt('expires_at', new Date().toISOString());

  const { data, error } = await q.select('id');
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}
