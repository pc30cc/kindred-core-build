/**
 * Targeted Inbox list refresh.
 *
 * A message anywhere in the workspace used to make every open dashboard
 * re-read its WHOLE conversation list (plus a network-profile batch for every
 * row on it). In the soak test that refetch was the largest share of the API's
 * load: one visitor message cost each operator a full list read, i.e. dozens
 * of queries.
 *
 * Instead, the conversations named by realtime pushes are re-read on their
 * own, through the same list endpoint narrowed with `?ids=` — the server
 * applies exactly the list's filters (queue, status tab, scope, the
 * resolved-thread ownership rule) and computes the preview, unread count and
 * needs-reply as it always does, so nothing is re-implemented here. For each
 * requested id the answer means:
 *   - row returned → upsert it into the cached list, in server order;
 *   - row absent   → it does not belong to this list (any more): remove it.
 *
 * Bursts are coalesced: ids collected within FLUSH_DELAY_MS go out as one
 * request per visible list, and at most one request per list is in flight.
 * Lists nobody is looking at are only marked stale. Anything unexpected — an
 * error, or an older server that ignores `ids` — falls back to the throttled
 * full refetch the Inbox used before.
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { conversationsApi } from '@/lib/conversations-api';
import { fetchVisitorNetworkForConversations } from '@/hooks/useVisitorNetwork';
import { invalidateThrottled } from '@/realtime/invalidationThrottle';

/** Long enough to fold a burst (a message plus its status event) into one read. */
export const FLUSH_DELAY_MS = 250;
/** The server answers at most this many ids per request (conversationIds.ts). */
const MAX_IDS_PER_REQUEST = 100;

type Row = { id: string; updated_at?: string | null; visitor_network?: unknown; [k: string]: unknown };

interface Pending {
  ids: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
}

const pendingByClient = new WeakMap<QueryClient, Map<string, Pending>>();

function pendingFor(qc: QueryClient, workspaceId: string): Pending {
  let byWs = pendingByClient.get(qc);
  if (!byWs) {
    byWs = new Map();
    pendingByClient.set(qc, byWs);
  }
  let p = byWs.get(workspaceId);
  if (!p) {
    p = { ids: new Set(), timer: null, running: false };
    byWs.set(workspaceId, p);
  }
  return p;
}

/** Whether any cached list of this workspace currently holds the conversation. */
export function isConversationCached(qc: QueryClient, workspaceId: string, conversationId: string): boolean {
  return qc
    .getQueriesData<Row[]>({ queryKey: ['conversations', workspaceId] })
    .some(([, rows]) => Array.isArray(rows) && rows.some((r) => r?.id === conversationId));
}

/**
 * Conversation ids this dashboard has already seen in a push, per workspace.
 * A message can only change the queue/tab counters when its conversation is
 * new; a thread the lists do not hold because it belongs to a colleague (the
 * "mine" view) is not new the second time. Bounded, so a long-open dashboard
 * does not grow it forever (clearing only costs one extra counter read).
 */
const MAX_SIGHTED = 5_000;
const sightedByClient = new WeakMap<QueryClient, Map<string, Set<string>>>();

/**
 * True the first time a conversation that no cached list holds is seen:
 * the one case where a message can have changed the counters.
 */
export function isFirstSighting(qc: QueryClient, workspaceId: string, conversationId: string): boolean {
  let byWs = sightedByClient.get(qc);
  if (!byWs) {
    byWs = new Map();
    sightedByClient.set(qc, byWs);
  }
  let seen = byWs.get(workspaceId);
  if (!seen) {
    seen = new Set();
    byWs.set(workspaceId, seen);
  }
  const cached = isConversationCached(qc, workspaceId, conversationId);
  const first = !cached && !seen.has(conversationId);
  if (seen.size >= MAX_SIGHTED) seen.clear();
  seen.add(conversationId);
  return first;
}

/**
 * Re-read these conversations in every visible list of the workspace
 * (coalesced). Safe to call for every push.
 */
export function refreshConversations(qc: QueryClient, workspaceId: string, conversationIds: Array<string | null | undefined>): void {
  const p = pendingFor(qc, workspaceId);
  for (const id of conversationIds) if (id) p.ids.add(id);
  if (p.ids.size === 0) return;
  schedule(qc, workspaceId, p);
}

function schedule(qc: QueryClient, workspaceId: string, p: Pending): void {
  if (p.timer || p.running) return; // the running flush reschedules itself
  p.timer = setTimeout(() => {
    p.timer = null;
    void flush(qc, workspaceId, p);
  }, FLUSH_DELAY_MS);
}

/** ['conversations', ws, queue, status, needsHuman, assignedToMe, scope] — see useConversations. */
function listParams(key: QueryKey) {
  const [, workspaceId, queue, status, needsHuman, assignedToMe, scope] = key as unknown[];
  if (typeof workspaceId !== 'string' || typeof queue !== 'string') return null;
  return {
    workspace_id: workspaceId,
    queue: queue as 'main' | 'automated' | 'spam',
    status: typeof status === 'string' ? status : undefined,
    needsHuman: needsHuman === true,
    assignedToMe: typeof assignedToMe === 'string' ? assignedToMe : null,
    scope: scope === 'all' ? ('all' as const) : ('mine' as const),
  };
}

async function flush(qc: QueryClient, workspaceId: string, p: Pending): Promise<void> {
  const ids = [...p.ids].slice(0, MAX_IDS_PER_REQUEST);
  for (const id of ids) p.ids.delete(id);
  if (ids.length === 0) return;
  p.running = true;
  try {
    const queries = qc.getQueryCache().findAll({ queryKey: ['conversations', workspaceId] });
    await Promise.all(
      queries.map(async (query) => {
        const params = listParams(query.queryKey);
        const rows = query.state.data as Row[] | undefined;
        // A list nobody is showing, or one that never loaded: just mark it
        // stale; it reads in full when it is next shown.
        if (!params || !Array.isArray(rows) || query.getObserversCount() === 0) {
          void qc.invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: 'none' });
          return;
        }
        try {
          const res = await conversationsApi.list({ ...params, ids });
          if (!Array.isArray(res.ids)) throw new Error('server ignored ids');
          const fresh = (res.conversations ?? []) as Row[];
          await enrichNetwork(workspaceId, fresh, rows);
          qc.setQueryData<Row[]>(query.queryKey, (current) => mergeRows(current, ids, fresh));
        } catch {
          invalidateThrottled(qc, query.queryKey);
        }
      }),
    );
  } finally {
    p.running = false;
    if (p.ids.size > 0) schedule(qc, workspaceId, p);
  }
}

/**
 * The network profile (country, device) is decorative and does not change
 * with a message: reuse what the row already had, and look up only rows the
 * list has never shown.
 */
async function enrichNetwork(workspaceId: string, fresh: Row[], existing: Row[]): Promise<void> {
  const known = new Map(existing.map((r) => [r.id, r]));
  const missing: string[] = [];
  for (const row of fresh) {
    const prev = known.get(row.id);
    if (prev && 'visitor_network' in prev) copyNetwork(row, prev);
    else missing.push(row.id);
  }
  if (missing.length === 0) return;
  try {
    const byConv = await fetchVisitorNetworkForConversations(workspaceId, missing);
    for (const row of fresh) {
      if (!missing.includes(row.id)) continue;
      const p = (byConv[row.id] ?? null) as { device?: { os?: string; device?: string }; geo?: { country_code?: string; country?: string } } | null;
      row.visitor_network = p;
      row.visitor_os = p?.device?.os ?? null;
      row.visitor_device = p?.device?.device ?? null;
      row.visitor_country_code = p?.geo?.country_code ?? null;
      row.visitor_country_name = p?.geo?.country ?? null;
    }
  } catch {
    /* decorative — never block the list */
  }
}

function copyNetwork(to: Row, from: Row): void {
  for (const k of ['visitor_network', 'visitor_os', 'visitor_device', 'visitor_country_code', 'visitor_country_name']) {
    to[k] = from[k];
  }
}

function time(r: Row): number {
  const t = r.updated_at ? Date.parse(String(r.updated_at)) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Replace/insert/remove the requested rows, keeping the server's order
 * (updated_at, newest first). Rows that were not requested are untouched.
 */
export function mergeRows<T extends Row>(current: T[] | undefined, requestedIds: string[], fresh: T[]): T[] | undefined {
  if (!Array.isArray(current)) return current;
  const requested = new Set(requestedIds);
  const kept = current.filter((r) => !requested.has(r.id));
  if (fresh.length === 0) return kept.length === current.length ? current : kept;
  const out = kept.slice();
  for (const row of fresh) {
    const t = time(row);
    let i = out.findIndex((r) => time(r) < t);
    if (i < 0) i = out.length;
    out.splice(i, 0, row);
  }
  return out;
}
