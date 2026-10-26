/**
 * The inactivity close (owner, 2026-10-23/24 and 2026-10-26; migrations 284,
 * 285 and 286).
 *
 * A conversation of any chat channel — the website widget, Telegram, Bale,
 * WhatsApp, Instagram, X and platform support (both kinds) — in which neither
 * the customer nor the team (people or the AI) has exchanged anything for its
 * workspace's window (widget_settings.inactivity_close_hours, 1–48; else the
 * Super Admin's default, 24) is closed by the system: never by the AI, never
 * the App Review account's (its workspace, and the support threads it opens),
 * and never while the team still owes the customer something
 * (conversation_idle_check: needs_reply, an AI handoff, routing, a call, a
 * callback, an AI guidance request). The e-mail inbox keeps no conversations
 * and is not touched.
 *
 * Every five minutes one replica (the lease) asks conversation_idle_due()
 * for what fell due — nothing while the Super Admin's switch is off, never a
 * conversation untouched for 30 days (that backlog was closed by hand,
 * silently: database/backfill/284_inactivity_backlog_close.sql) — and closes
 * each with conversation_close_if_idle(), a row-locked compare-and-set on
 * updated_at that takes the decision again. A close:
 *   - status closed, the close markers (shared/inactivityClose.ts
 *     CLOSED_KEYS: closed_reason 'inactivity', closed_by 'system', …) and the
 *     two thread-end stamps (the widget's endedAt). Never updated_at, never
 *     the AI's state: an AI-only conversation stays out of every Inbox queue;
 *   - one timeline event, filed as the Inbox's PATCH files a close (read
 *     "Closed · Automatically, after N h without messages"), actor 'system';
 *   - in a widget conversation the visitor ever wrote in, the visitor's
 *     nameless closed line («گفتگو به پایان رسید», then the template's rating
 *     card), prepared here (conversationClosedNotice.ts prepareClosedLine; a
 *     failed read leaves the conversation for the next pass, never closes it
 *     without its line), written in the close's transaction and published
 *     like a message once the race grace is over (below). Every other
 *     channel's close is silent (owner, 2026-10-26): prepareClosedLine
 *     prepares no line for it, so no row is written into the conversation
 *     and nothing reaches the Telegram, Bale, WhatsApp, Instagram or X
 *     customer (the channel outbox only sends the team's and the AI's
 *     messages, never a system row); the customer's next message, once the
 *     race grace (INACTIVITY_CLOSE_CHANNEL_RACE_GRACE_SECONDS, below) is
 *     over, starts a new conversation. A support requester's apps draw the
 *     end and their own rating from the status;
 *   - the Inbox lists move as for the PATCH (conversation_resolved from open
 *     or pending, conversation_updated from resolved, actor null), the open
 *     timeline reloads (timeline_event), and a platform-support requester's
 *     devices read their chat again (support_update,
 *     platformSupport/changes.ts; nothing for any other conversation). No
 *     push, no transcript, no e-mail, no audit row, no other notice to
 *     anyone, and no AI.
 * A customer message that races a close puts it back as it was
 * (idleCloseRace.ts reopenAfterIdleCloseRace: routes/widget.ts within
 * INACTIVITY_CLOSE_RACE_GRACE_SECONDS, a channel's or a support requester's
 * message within INACTIVITY_CLOSE_CHANNEL_RACE_GRACE_SECONDS), and retracts
 * the widget's line (it turns internal). So the line goes to the visitor's
 * open widget only when that grace is over, and only while the close stands:
 * a message in flight at the close (its insert waits on the close's row
 * lock, then reopens) or written in the meantime never meets a line on
 * screen that the server has already taken back.
 *
 * The lease is a duplication guard only: the close is a compare-and-set, so
 * a second replica's pass closes nothing twice and writes nothing twice
 * (which is also why this ticker is not in TICKER_CYCLE_SECONDS). Switched
 * off (loadInactivityCloseSettings, 60 s cache) a pass takes no lease and
 * calls nothing; the SQL reads the switch itself, so nothing closes the
 * moment it is off. Before migration 284 the functions are missing (42883)
 * and a pass is a no-op.
 */
import type { ServerConfig } from '../config.js';
import { acquireTickerLease, releaseTickerLease } from './observability/tickerLease.js';
import { getServiceClient } from '../supabase.js';
import { buildMessageEnvelope, publishConversationEvent, publishOperatorEvent } from './realtime/publish.js';
import { prepareClosedLine, type PreparedClosedLine } from './conversationClosedNotice.js';
import { loadInactivityCloseSettings } from './widget/platformSettings.js';
import { onSupportConversationChanged } from './platformSupport/changes.js';
import { INACTIVITY_CLOSE_RACE_GRACE_SECONDS } from '../../shared/inactivityClose.js';

const LEASE_NAME = 'conversation_idle_close';

/** Five minutes: a conversation closes within that of its window running out. */
const TICK_MS = 5 * 60 * 1000;
/** After the routing ticker's first pass (45 s), so a chat routing still owes is handed out first. */
const FIRST_RUN_MS = 2 * 60 * 1000;
/** Closes per pass; the rest come on the next pass (oldest first). */
const BATCH = 50;
/** How long the visitor's line waits before it goes out live: the race grace. */
let lineDelayMs = INACTIVITY_CLOSE_RACE_GRACE_SECONDS * 1000;

let timer: ReturnType<typeof setInterval> | null = null;

/** Tests: the wait before the visitor's line is published (the grace by default). */
export function __setIdleCloseLineDelayForTests(ms: number | null): void {
  lineDelayMs = ms ?? INACTIVITY_CLOSE_RACE_GRACE_SECONDS * 1000;
}

export function startConversationIdleCloseTicker(config: ServerConfig): void {
  if (timer) return;
  setTimeout(() => void runConversationIdleCloseOnce(config), FIRST_RUN_MS);
  timer = setInterval(() => void runConversationIdleCloseOnce(config), TICK_MS);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

export function stopConversationIdleCloseTicker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

interface DueRow {
  due_conversation_id: string;
  due_workspace_id: string;
  due_status: 'open' | 'pending' | 'resolved';
  due_updated_at: string;
  due_last_exchange_at: string | null;
  due_has_visitor_turn: boolean;
  due_idle_hours: number;
  due_closed_outcome: string | null;
}

interface CloseRow {
  closed: boolean;
  outcome: string;
  workspace_id: string | null;
  from_status: string | null;
  closed_at: string | null;
  event_id: string | null;
  event_type: string | null;
  event_created_at: string | null;
  line_id: string | null;
  line_created_at: string | null;
  closed_outcome: string | null;
}

export interface IdleClosePass {
  /** Conversations conversation_idle_due handed this pass. */
  due: number;
  /** Conversations this pass closed. */
  closed: number;
  /** Why the others were not (changed, recent, needs_reply, …, error). */
  skipped: Record<string, number>;
}

const firstRow = <T>(data: unknown): T | null => (Array.isArray(data) ? (data[0] as T) ?? null : (data as T) ?? null);

/** "Function does not exist" (before migration 284): Postgres 42883, PostgREST PGRST202. */
export function isFunctionMissing(error: { code?: string | null } | null | undefined): boolean {
  const code = String(error?.code ?? '');
  return code === '42883' || code === 'PGRST202';
}

/** One pass. Exported for its tests; the timer calls it. Never throws. */
export async function runConversationIdleCloseOnce(config: ServerConfig): Promise<IdleClosePass> {
  const pass: IdleClosePass = { due: 0, closed: 0, skipped: {} };
  // Switched off (or before 284, or unreadable): not even the lease is taken.
  const platform = await loadInactivityCloseSettings(config).catch(() => null);
  if (!platform?.enabled) {
    console.info('[idle-close] pass off');
    return pass;
  }

  let leased = false;
  try {
    leased = await acquireTickerLease(config, LEASE_NAME);
  } catch {
    return pass; // another replica, or a database blip: skip this pass
  }
  if (!leased) return pass;

  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb.rpc('conversation_idle_due', { p_limit: BATCH });
    if (error) {
      // Before migration 284 (42883; PGRST202 through the data layer) this
      // is simply not there yet.
      if (!isFunctionMissing(error)) console.warn('[idle-close] due rows unreadable:', error.message);
      return pass;
    }
    const rows = (Array.isArray(data) ? data : data ? [data] : []) as DueRow[];
    for (const row of rows) {
      pass.due++;
      try {
        // The visitor's line only when they ever wrote: a greeting nobody
        // answered, or an opening line, closes silently, and so does every
        // conversation of another channel (prepareClosedLine: none). A
        // failed read is not "no line due": closed now, it would stay closed
        // without its line for good, so it waits for the next pass.
        let line: PreparedClosedLine | null = null;
        if (row.due_has_visitor_turn) {
          try {
            line = await prepareClosedLine(config, { workspaceId: row.due_workspace_id, conversationId: row.due_conversation_id, by: 'system' });
          } catch (err) {
            pass.skipped.error = (pass.skipped.error || 0) + 1;
            console.warn('[idle-close] line not prepared, left for the next pass:', (err as { message?: string } | null)?.message || String(err));
            continue;
          }
        }
        const { data: res, error: closeErr } = await sb.rpc('conversation_close_if_idle', {
          p_conversation_id: row.due_conversation_id,
          p_expected_updated_at: row.due_updated_at,
          p_source: 'timer',
          p_line_body: line?.body ?? null,
          p_line_metadata: line?.metadata ?? null,
        });
        const closed = closeErr ? null : firstRow<CloseRow>(res);
        if (!closed?.closed) {
          if (closeErr) console.warn('[idle-close] close failed:', closeErr.message);
          const why = closeErr ? 'error' : (closed?.outcome || 'unknown');
          pass.skipped[why] = (pass.skipped[why] || 0) + 1;
          continue;
        }
        pass.closed++;
        announceIdleClose(config, row, closed);
      } catch (err) {
        pass.skipped.error = (pass.skipped.error || 0) + 1;
        console.warn('[idle-close] close threw:', err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    console.error('[idle-close] ticker pass failed', { message: err instanceof Error ? err.message : String(err) });
  } finally {
    await releaseTickerLease(config, LEASE_NAME).catch(() => {});
  }
  console.info(`[idle-close] pass due=${pass.due} closed=${pass.closed} skipped=${JSON.stringify(pass.skipped)}`);
  return pass;
}

/**
 * The echoes of a close the database already holds, the PATCH's envelopes
 * with a null actor. Fire-and-forget, never throws.
 */
function announceIdleClose(config: ServerConfig, row: DueRow, r: CloseRow): void {
  const ws = row.due_workspace_id;
  const cid = row.due_conversation_id;
  const from = r.from_status || row.due_status;
  // The Inbox lists: as the PATCH moves them (routes/conversations.ts):
  // open/pending → closed is a resolve for the lists, resolved → closed an
  // update. updated_at did not move.
  void publishOperatorEvent(config, {
    kind: from === 'resolved' ? 'conversation_updated' : 'conversation_resolved',
    conversation_id: cid,
    workspace_id: ws,
    actor_id: null,
    changes: { status: { from, to: 'closed' } },
    reason: 'inactivity',
    updated_at: row.due_updated_at,
  }).catch(() => undefined);
  // The open timeline: recordConversationEvent's echo, for the event the SQL wrote.
  if (r.event_id) {
    void publishOperatorEvent(config, {
      kind: 'timeline_event',
      conversation_id: cid,
      workspace_id: ws,
      actor_id: null,
      event_id: r.event_id,
      event_type: r.event_type,
      actor_type: 'system',
      created_at: r.event_created_at,
    }).catch(() => undefined);
  }
  // A platform-support requester's devices read their chat again, so the
  // apps show the end and the rating now, not on their next poll (as the
  // PATCH tells them). One primary-key read for any other conversation.
  void onSupportConversationChanged(config, { workspaceId: ws, conversationId: cid });
  // The visitor: the closed line, live (Core draws it, and the rating card
  // where the template's csat is on), once the race grace is over and only
  // while this close stands: a racing message reopened the conversation and
  // retracted the line (metadata.internal, closed_line_id gone), or a
  // person's reply reopened it. A line written a moment ago has not been
  // seen (and seen_at is not in every chain, migration 216), so it is not
  // read. A restart in the meantime loses only the live copy: the line is
  // in the thread's history.
  if (r.line_id) {
    const lineId = r.line_id;
    const publishLine = async () => {
      const sb = getServiceClient(config);
      const [{ data: msg }, { data: now }] = await Promise.all([
        sb.from('conversation_messages')
          .select('id, conversation_id, sender_type, body, created_at, metadata')
          .eq('id', lineId)
          .maybeSingle(),
        sb.from('conversations').select('status, metadata').eq('id', cid).maybeSingle(),
      ]);
      const lineMeta = (msg?.metadata as Record<string, unknown> | null) ?? null;
      const convMeta = (now?.metadata as Record<string, unknown> | null) ?? null;
      if (!msg || lineMeta?.internal === true) return;
      if (now?.status !== 'closed' || convMeta?.closed_line_id !== lineId) return;
      await publishConversationEvent(config, ws, cid, buildMessageEnvelope({
        id: msg.id as string,
        conversation_id: cid,
        sender_type: 'system',
        body: msg.body as string,
        created_at: msg.created_at as string | null,
        metadata: lineMeta,
        seen_at: null,
      }));
    };
    const send = () => void publishLine().catch(() => undefined);
    if (lineDelayMs <= 0) {
      send();
    } else {
      const wait = setTimeout(send, lineDelayMs);
      if (typeof (wait as { unref?: () => void }).unref === 'function') (wait as { unref: () => void }).unref();
    }
  }
}
