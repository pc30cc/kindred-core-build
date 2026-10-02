/**
 * Who is asking: the operator's account as the support team needs it, written
 * as an internal notice at the top of every new support conversation
 * (docs/PLATFORM_SUPPORT.md, "Who is asking").
 *
 * A snapshot, as of the first message: the person (name, email, phone,
 * company, member since, the app they wrote from) and each workspace they
 * belong to — its plan and its state, its operators, and this month's usage
 * against the plan's limits. `metadata.internal`, so the operator never sees
 * it; the inbox draws it from the metadata as a card, and the English body is
 * the fallback for a client that does not know the kind.
 */
import type { getServiceClient } from '../../supabase.js';

type ServiceClient = ReturnType<typeof getServiceClient>;

export const REQUESTER_KIND = 'platform_support_requester';

/** More than this and the card is a list nobody reads; the count still says how many. */
const WORKSPACE_LIMIT = 10;

/** A used amount against its limit; `limit` null when the plan sets none, -1 when unlimited. */
export interface Metered {
  used: number;
  limit: number | null;
}

export interface RequesterWorkspace {
  id: string;
  name: string;
  role: string;
  status: string | null;
  created_at: string | null;
  plan: {
    name: string;
    /** The plan's names by language, as Super Admin wrote them (`billing_plans.localized`). */
    names: Record<string, string>;
    slug: string | null;
    is_free: boolean;
    status: string | null;
    /**
     * When the period being paid for began — the plan bought or last renewed:
     * the active billing period's start, as the billing screen shows it, else
     * the subscription's own `current_period_start`.
     */
    period_start: string | null;
    /** When that period ends: the plan's expiry, or its renewal. */
    period_end: string | null;
    trial_end: string | null;
    cancel_at_period_end: boolean;
    /** `monthly`, `yearly`… as the subscription is billed. */
    billing_interval: string | null;
    /** When the workspace first subscribed to a plan. */
    started_at: string | null;
  } | null;
  operators: Metered;
  contacts: Metered;
  /** This calendar month (UTC), as `workspace_usage_counters` keeps it. */
  usage: {
    period: string;
    conversations: Metered;
    visitors: Metered;
    messages: number;
    ai_credits: Metered;
    call_minutes: number;
    storage_bytes: number;
    storage_limit_gb: number | null;
  };
}

export interface RequesterSnapshot {
  kind: typeof REQUESTER_KIND;
  internal: true;
  user: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    company: string | null;
    website: string | null;
    member_since: string | null;
    client_platform: string;
    /** The workspace they wrote from, when the app said. */
    source_workspace: string | null;
  };
  workspace_count: number;
  workspaces: RequesterWorkspace[];
  captured_at: string;
}

type Row = Record<string, unknown>;

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** A plan limit: the number, -1 for unlimited, null when the plan does not set it. */
function limitOf(limits: Row | null, key: string): number | null {
  const raw = limits?.[key];
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function planNames(localized: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!localized || typeof localized !== 'object') return out;
  for (const [lang, entry] of Object.entries(localized as Row)) {
    const name = text((entry as Row | null)?.name);
    if (name) out[lang] = name;
  }
  return out;
}

async function rows(query: PromiseLike<{ data: unknown }>): Promise<Row[]> {
  const { data } = await query;
  return Array.isArray(data) ? (data as Row[]) : [];
}

/** The snapshot for [userId], read with the service client; the caller decides whether it is shown. */
export async function requesterSnapshot(
  sb: ServiceClient,
  input: { userId: string; client: string; sourceWorkspaceName: string | null; now?: Date },
): Promise<RequesterSnapshot> {
  const now = input.now ?? new Date();
  const period = now.toISOString().slice(0, 7);

  const [profileRows, membershipRows] = await Promise.all([
    rows(
      sb
        .from('profiles')
        .select('id, email, full_name, phone, company_name, website_domain, created_at')
        .eq('id', input.userId)
        .limit(1),
    ),
    rows(
      sb
        .from('workspace_members')
        .select('workspace_id, role, created_at')
        .eq('user_id', input.userId)
        .order('created_at', { ascending: true }),
    ),
  ]);
  const profile = profileRows[0] ?? {};

  // Owned workspaces first: those are the ones whose plan the person pays for.
  const memberships = [...membershipRows].sort(
    (a, b) => Number(b.role === 'owner') - Number(a.role === 'owner'),
  );
  const shown = memberships.slice(0, WORKSPACE_LIMIT);
  const ids = shown.map((m) => String(m.workspace_id));

  let workspaces: RequesterWorkspace[] = [];
  if (ids.length) {
    const [workspaceRows, subscriptionRows, periodRows, memberRows, counterRows, contactCounts] = await Promise.all([
      rows(sb.from('workspaces').select('id, name, status, created_at').in('id', ids)),
      rows(
        sb
          .from('workspace_subscriptions')
          .select(
            'workspace_id, plan_id, status, billing_interval, current_period_start, current_period_end, trial_end, cancel_at_period_end, created_at',
          )
          .in('workspace_id', ids),
      ),
      // The period being paid for, as the billing screen reads it
      // (billing/customer/readModels.ts): the active one wins over the
      // subscription's own dates, which a v2 renewal does not move.
      rows(
        sb
          .from('billing_subscription_periods')
          .select('workspace_id, period_start, period_end')
          .in('workspace_id', ids)
          .eq('status', 'active'),
      ),
      rows(sb.from('workspace_members').select('workspace_id').in('workspace_id', ids)),
      rows(
        sb
          .from('workspace_usage_counters')
          .select(
            'workspace_id, conversations_count, messages_count, visitors_count, ai_credits_used, storage_bytes, call_minutes_used',
          )
          .in('workspace_id', ids)
          .eq('period', period),
      ),
      Promise.all(
        ids.map(async (id) => {
          const { count } = await sb.from('contacts').select('id', { count: 'exact', head: true }).eq('workspace_id', id);
          return [id, count ?? 0] as const;
        }),
      ),
    ]);
    const planIds = [...new Set(subscriptionRows.map((s) => s.plan_id).filter(Boolean).map(String))];
    const planRows = planIds.length
      ? await rows(sb.from('billing_plans').select('id, name, slug, localized, is_free, limits').in('id', planIds))
      : [];

    const byId = <T extends Row>(list: T[], key: string) => new Map(list.map((r) => [String(r[key]), r]));
    const workspaceById = byId(workspaceRows, 'id');
    const subscriptionByWorkspace = byId(subscriptionRows, 'workspace_id');
    const periodByWorkspace = byId(periodRows, 'workspace_id');
    const planById = byId(planRows, 'id');
    const counterByWorkspace = byId(counterRows, 'workspace_id');
    const contactsByWorkspace = new Map(contactCounts);
    const operatorsByWorkspace = new Map<string, number>();
    for (const m of memberRows) {
      const id = String(m.workspace_id);
      operatorsByWorkspace.set(id, (operatorsByWorkspace.get(id) ?? 0) + 1);
    }

    workspaces = shown.map((membership): RequesterWorkspace => {
      const id = String(membership.workspace_id);
      const workspace = workspaceById.get(id) ?? {};
      const subscription = subscriptionByWorkspace.get(id) ?? null;
      const billingPeriod = periodByWorkspace.get(id) ?? null;
      const plan = subscription ? planById.get(String(subscription.plan_id)) ?? null : null;
      const limits = (plan?.limits as Row | null) ?? null;
      const counter = counterByWorkspace.get(id) ?? {};
      return {
        id,
        name: text(workspace.name) ?? id,
        role: String(membership.role ?? 'member'),
        status: text(workspace.status),
        created_at: text(workspace.created_at),
        plan: plan
          ? {
              name: text(plan.name) ?? String(plan.slug ?? ''),
              names: planNames(plan.localized),
              slug: text(plan.slug),
              is_free: plan.is_free === true,
              status: text(subscription?.status),
              period_start: text(billingPeriod?.period_start) ?? text(subscription?.current_period_start),
              period_end: text(billingPeriod?.period_end) ?? text(subscription?.current_period_end),
              trial_end: text(subscription?.trial_end),
              cancel_at_period_end: subscription?.cancel_at_period_end === true,
              billing_interval: text(subscription?.billing_interval),
              started_at: text(subscription?.created_at),
            }
          : null,
        operators: { used: operatorsByWorkspace.get(id) ?? 0, limit: limitOf(limits, 'max_agents') },
        contacts: { used: contactsByWorkspace.get(id) ?? 0, limit: limitOf(limits, 'max_contacts') },
        usage: {
          period,
          conversations: { used: num(counter.conversations_count), limit: limitOf(limits, 'max_conversations') },
          visitors: { used: num(counter.visitors_count), limit: limitOf(limits, 'max_visitors') },
          messages: num(counter.messages_count),
          ai_credits: { used: num(counter.ai_credits_used), limit: limitOf(limits, 'ai_credits_per_month') },
          call_minutes: num(counter.call_minutes_used),
          storage_bytes: num(counter.storage_bytes),
          storage_limit_gb: limitOf(limits, 'storage_gb'),
        },
      };
    });
  }

  return {
    kind: REQUESTER_KIND,
    internal: true,
    user: {
      id: input.userId,
      name: text(profile.full_name),
      email: text(profile.email),
      phone: text(profile.phone),
      company: text(profile.company_name),
      website: text(profile.website_domain),
      member_since: text(profile.created_at),
      client_platform: input.client,
      source_workspace: input.sourceWorkspaceName,
    },
    workspace_count: memberships.length,
    workspaces,
    captured_at: now.toISOString(),
  };
}

function metered(m: Metered): string {
  if (m.limit === null) return String(m.used);
  return `${m.used}/${m.limit < 0 ? '∞' : m.limit}`;
}

/**
 * The same, as plain English lines: the stored body, for a client that does
 * not draw the card (the inbox draws it from the metadata, in its language).
 */
export function requesterBody(snapshot: RequesterSnapshot): string {
  const u = snapshot.user;
  const head = [u.name, u.email, u.phone, u.company].filter(Boolean).join(' · ');
  const since = u.member_since ? ` · member since ${u.member_since.slice(0, 10)}` : '';
  const lines = [`Site user: ${head || u.id}${since} · via ${u.client_platform}`];
  lines.push(`${snapshot.workspace_count} workspace${snapshot.workspace_count === 1 ? '' : 's'}`);
  for (const w of snapshot.workspaces) {
    const span = w.plan && (w.plan.period_start || w.plan.period_end)
      ? ` ${w.plan.period_start?.slice(0, 10) ?? '…'} → ${w.plan.period_end?.slice(0, 10) ?? '…'}`
      : '';
    const plan = w.plan ? `${w.plan.name}${w.plan.status ? ` (${w.plan.status})` : ''}${span}` : 'no plan';
    lines.push(
      `• ${w.name} (${w.role}) — ${plan} · operators ${metered(w.operators)} · ` +
        `conversations ${metered(w.usage.conversations)} · visitors ${metered(w.usage.visitors)} · ` +
        `contacts ${metered(w.contacts)} · AI credits ${metered(w.usage.ai_credits)} this month`,
    );
  }
  return lines.join('\n');
}
