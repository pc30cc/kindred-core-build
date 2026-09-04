/**
 * AI Proactive Nudge — lifecycle state machine.
 *
 *   generated -> shown -> dismissed | clicked -> converted
 *   generated -> expired (never acknowledged before expires_at)
 *
 * "generated" != "shown": a candidate is only "shown" once the browser
 * acknowledges it actually attached the bubble to the page. Every
 * transition below is a single conditional UPDATE guarded by the allowed
 * prior states, so a stale, replayed, or out-of-order event can never move
 * a nudge backwards (e.g. dismissed -> shown) or skip a state (converted
 * without ever having been shown) and corrupt attribution analytics.
 */
export type NudgeStatus = 'generated' | 'shown' | 'dismissed' | 'clicked' | 'converted' | 'expired';

const ALLOWED_FROM: Record<NudgeStatus, NudgeStatus[]> = {
  generated: [],
  shown: ['generated'],
  dismissed: ['generated', 'shown'],
  clicked: ['generated', 'shown'],
  converted: ['generated', 'shown', 'clicked'],
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
