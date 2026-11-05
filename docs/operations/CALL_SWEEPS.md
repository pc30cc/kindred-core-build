# Calls the server ends on its own (call sweeps)

A call (call-centre or chat; colleague calls have their own room check,
`server/services/calls/teamCallTicker.ts`) normally ends through the API
(`endSession.ts`) or LiveKit's `room_finished` webhook
(`server/routes/livekitWebhook.ts`). When neither comes, the row would stay
live for ever: it fills the plan's `max_concurrent_calls` (pending, ringing,
connecting and active all count), holds its operator's in-call marker, and
an end written later would bill up to that later moment. Three timers end
such calls; each runs on one replica at a time (`tickerLease.ts`).

| Sweep | Calls | After | Becomes | Billed |
|---|---|---|---|---|
| `queue.ts` `sweepStalePendingCalls` (in the queue's pass) | call-centre `pending` nobody answered | 1 h since created | `missed` | nothing |
| `staleConnectingSweep.ts` (lease `call_stale_connecting`, every minute) | `connecting`, no `connected_at` | 2 h since created | `failed` (`end_reason` `failed`) | nothing |
| `staleActiveSweep.ts` (lease `call_stale_active`, every minute) | `active` | 10 min with no sign of life | `ended` (`ended_by` `system`, `end_reason` `system_ended`) | up to the last leave |

The last two hold the call against its LiveKit room (`listRoomIdentities`):
anyone in the room keeps the call (its webhooks were lost, the call is
real); LiveKit not answering keeps it for a later pass; a provider with no
room listing is never read; an empty or gone room (or no room at all) means
nobody is in the call. Each pass reads up to 200 calls after an id cursor
that wraps, so kept calls never hold others back.

## Calls left `active` (owner, 2026-11-05)

"Close the stuck call with the last participant's leave time."

- **End time** (`endTimeOf`): the latest `lk.participant_left` in
  `call_events`, leaving out a leave with `disconnect_reason`
  `DUPLICATE_IDENTITY` (a connection the same identity's new one replaced,
  which the webhook logs but is not a leave). If an `lk.participant_joined`
  came after that leave, that join (its own leave was lost too). With no
  leave recorded, the latest event that shows someone in the call, else
  `connected_at`/`started_at`. Only these events count, an allow-list
  (`PRESENCE_EVENTS`): `lk.room_started`, `lk.participant_joined`,
  `lk.participant_left` (that exclusion kept), `visitor_joined`,
  `call_accepted`, `call_assigned_on_accept`, `call_takeover`,
  `call_transferred`. An operator's wrap-up written while the server still
  has the call live (`operator_note_added`, `call_marked_spam`,
  `call_unmarked_spam`, recording or transfer requests) and LiveKit's egress
  events (an egress ends after its upload, after the room) never move the
  end, and so never the bill. Never before `connected_at` (else
  `started_at`), and never the time of the pass.
  `call_participants.left_at` holds the same moment, but a rejoin clears it,
  so the event log is what is read.
- **Bound** (`STALE_ACTIVE_QUIET_MS`, 10 min): no `call_events` row of any
  type (same exclusion), `connected_at` or `started_at` within it (a note
  only delays the sweep; it does not move the end). LiveKit closes a
  room 20 s after its last participant leaves and an unjoined one after
  `empty_timeout` 300 s, then sends `room_finished`; 10 minutes leaves the
  webhook and its retries every chance first. The wait costs no minutes,
  only a concurrency slot.
- **Move**: a compare-and-set on `state = 'active'` with `ended_at` that end
  time and `duration_seconds` from `connected_at` (else `started_at`) to it.
  `tg_call_sessions_bill_minutes` bills CEIL((ended_at − connected_at)/60)
  once on the move into `ended`, and migration 298's trigger keeps an over
  call over, so a second pass or a late `room_finished` bills nothing.
- **Then**, as for any end: the room is closed, an `ended` call event is
  written (`payload.reason` `stale_active`, `end_time_source`), in-call
  markers still pointing at the call are cleared (`clearInCallOf`), the
  call-centre operator's count is set right (`syncAgentActiveCallCount`),
  `call:ended` goes to the operators only (`skipConversationChannel`: the
  visitor's widget would draw a line for a call long over), and the call
  centre gets `call_ended`.
- **Tests**: `src/test/integration/staleActiveSweep.pg.test.ts`
  (and `staleConnectingSweep.pg.test.ts` for the other one).
- **Rollout**: no migration; deploy the backend (WebYar 25, RESPOK 32).
