/**
 * The clock behind chat routing (DECISIONS §4 f, g; R-11, R-24).
 *
 * Every 30 seconds, one replica (the lease) asks chat_routing_due()
 * (migration 278) for what fell due and does it:
 *
 *   prechat  routing waited for the pre-chat form and the visitor never sent
 *            it: route the conversation anyway (two minutes after the wait
 *            began);
 *   waiting  routing found nobody (nobody online, or everyone at capacity):
 *            try again, oldest first, so a waiting chat goes out as soon as
 *            someone comes online or frees up;
 *   timeout  routing gave the chat to someone who has not written in it
 *            within the workspace's first-response timeout: it goes to the
 *            next operator (never back to them).
 *
 * The lease is a duplication guard, as for every ticker here: every step is
 * idempotent on its own (the assignment is chat_route_claim's compare-and-set,
 * the due rows are handed out under SKIP LOCKED and pushed back before they
 * are returned). Before 278 the function is missing and a pass is a no-op.
 */
import type { ServerConfig } from '../config.js';
import { acquireTickerLease, releaseTickerLease } from './observability/tickerLease.js';
import { getServiceClient } from '../supabase.js';
import {
  createRoutingCache,
  reassignAfterFirstResponseTimeout,
  routeConversationToOperator,
} from './chatRouting.js';

const LEASE_NAME = 'chat_routing';

/** Half a minute: a waiting chat goes out within that of someone freeing up. */
const TICK_MS = 30 * 1000;
/** Late enough that the app is serving (and presence is known) before it routes. */
const FIRST_RUN_MS = 45 * 1000;
/** Rows of each kind per pass; the rest come on the next pass. */
const BATCH = 100;

let timer: ReturnType<typeof setInterval> | null = null;

export function startChatRoutingTicker(config: ServerConfig): void {
  if (timer) return;
  setTimeout(() => void runChatRoutingOnce(config), FIRST_RUN_MS);
  timer = setInterval(() => void runChatRoutingOnce(config), TICK_MS);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

export function stopChatRoutingTicker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

interface DueRow {
  due_conversation_id: string;
  due_workspace_id: string;
  due_kind: 'prechat' | 'waiting' | 'timeout';
  due_assignee: string | null;
}

export interface ChatRoutingPass {
  prechat: number;
  waiting: number;
  timeout: number;
  /** Conversations this pass gave to someone. */
  assigned: number;
}

/** One pass. Exported for its tests; the timer calls it. Never throws. */
export async function runChatRoutingOnce(config: ServerConfig): Promise<ChatRoutingPass> {
  const pass: ChatRoutingPass = { prechat: 0, waiting: 0, timeout: 0, assigned: 0 };
  let leased = false;
  try {
    leased = await acquireTickerLease(config, LEASE_NAME);
  } catch {
    return pass; // another replica, or a database blip: skip this pass
  }
  if (!leased) return pass;

  try {
    const { data, error } = await getServiceClient(config).rpc('chat_routing_due', { p_limit: BATCH });
    if (error) {
      // Before migration 278 (42883) this is simply not there yet.
      if (error.code !== '42883') console.warn('[chat-routing] due rows unreadable:', error.message);
      return pass;
    }
    const rows = (Array.isArray(data) ? data : data ? [data] : []) as DueRow[];
    if (!rows.length) return pass;
    const cache = createRoutingCache();
    // A workspace where nobody was online for its oldest waiting chat has
    // nobody for the next ones either this pass.
    const nobodyOnline = new Set<string>();

    for (const row of rows) {
      const args = { workspaceId: row.due_workspace_id, conversationId: row.due_conversation_id };
      if (row.due_kind === 'prechat') {
        pass.prechat++;
        const r = await routeConversationToOperator(config, args, { cache });
        if (r.assignedTo && r.outcome.startsWith('assigned_')) pass.assigned++;
      } else if (row.due_kind === 'waiting') {
        if (nobodyOnline.has(row.due_workspace_id)) continue;
        pass.waiting++;
        const r = await routeConversationToOperator(config, args, { cache, fromTicker: true });
        if (r.outcome === 'no_eligible_agent') nobodyOnline.add(row.due_workspace_id);
        if (r.assignedTo && r.outcome.startsWith('assigned_')) pass.assigned++;
      } else if (row.due_kind === 'timeout' && row.due_assignee) {
        pass.timeout++;
        const r = await reassignAfterFirstResponseTimeout(config, { ...args, from: row.due_assignee }, { cache });
        if (r.assignedTo && r.assignedTo !== row.due_assignee && r.outcome.startsWith('assigned_')) pass.assigned++;
      }
    }
  } catch (err) {
    console.error('[chat-routing] ticker pass failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await releaseTickerLease(config, LEASE_NAME).catch(() => {});
  }
  return pass;
}
