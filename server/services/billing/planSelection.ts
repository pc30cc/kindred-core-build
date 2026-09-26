/**
 * Which plan a workspace's subscription entitles it to right now.
 *
 * One rule, used by everything that answers "what does this workspace have":
 *   - getWorkspacePlanInfo() → GET /api/plans/workspace/:id/effective, which
 *     every client (web, mobile, desktop) renders its sections from;
 *   - public.check_workspace_entitlement (supabase/migrations/
 *     20260925120000_entitlement_plan_selection.sql), which server-side
 *     enforcement asks.
 * The two used to disagree: the UI kept an expired trial's plan forever while
 * enforcement demoted a past-due workspace to Free on day one of its grace
 * period. Change them together.
 *
 * The assigned plan applies while the subscription is:
 *   - active;
 *   - past_due and not yet fallen back (Billing V2 grace: service degrades
 *     only when the dunning worker records the free fallback);
 *   - trialing, until trial_end;
 *   - canceled at period end, until current_period_end.
 * Anything else — an expired trial, a fallback, an immediate cancel, no
 * subscription — gets the Free plan.
 */

export interface SubscriptionPlanState {
  status?: string | null;
  plan_id?: string | null;
  trial_end?: string | null;
  free_fallback_at?: string | null;
  cancel_at_period_end?: boolean | null;
  current_period_end?: string | null;
}

function isFuture(iso: string | null | undefined, now: number): boolean {
  if (!iso) return false;
  const at = Date.parse(iso);
  return Number.isFinite(at) && at > now;
}

export function assignedPlanApplies(sub: SubscriptionPlanState | null | undefined, now: number = Date.now()): boolean {
  if (!sub?.plan_id) return false;
  switch (sub.status) {
    case 'active':
      return true;
    case 'past_due':
      return !sub.free_fallback_at;
    case 'trialing':
      return !sub.trial_end || isFuture(sub.trial_end, now);
    case 'canceled':
    case 'cancelled':
      return sub.cancel_at_period_end === true && isFuture(sub.current_period_end, now);
    default:
      return false;
  }
}
