# Chat routing

How a chat (a website widget conversation, or a channel conversation such as
Telegram) gets an operator, which settings change that and where they live,
the background tickers, how a quiet widget conversation is closed, and how to
roll the database side out.

Code: `server/services/chatRouting.ts` (the decisions),
`server/services/chatRoutingTicker.ts` (the clock),
`server/services/chatRoutingPrechat.ts` (the pre-chat wait),
`server/services/conversationAssignment.ts` (assigning by hand),
`server/services/conversationIdleCloseTicker.ts` (the inactivity close),
`shared/chatRoles.ts` (who may do what), `shared/inactivityClose.ts` (the
inactivity close's bounds and markers). The SQL is in migrations 278, 278b
and 280b (`chat_route_claim` and its helpers) and 284 (the inactivity close).

## How it works

**Who receives chats.** `shared/chatRoles.ts` is the only list:

- The owner and the team roles (`agent`, `team_lead`, `support_agent`,
  `sales_agent`) are the only people routing gives chats to
  (`ROUTABLE_CHAT_ROLES`), and only while their "Receive chats" switch is on
  (on by default, also for the owner).
- Staff (`admin`, `marketing_manager`, `seo_manager`, `analyst`, `developer`,
  `billing`, `viewer`) never receive chats automatically. Of them, only
  `admin` may open the Inbox (`INBOX_ROLES`): the others get 403
  `inbox_not_allowed` and the panel hides the Inbox. Nor do they get what
  carries its conversations: no phone push for a customer message, a note,
  a handoff, an assignment, an email or a mention in a conversation (a
  colleague's direct message still reaches them), no conversation in the
  app icon's badge, no realtime conversation or inbox channel (403
  `inbox_not_allowed`), and no unread digest email.
- Supervisors (`owner`, `admin`, `team_lead`) see "All conversations" and may
  move anyone's chat. Everyone else may take an unassigned chat or transfer
  their own.
- A suspended, seat-paused or removed member is never routed a chat. When a
  member is removed, suspended or moved to a role without the Inbox, their
  open chats are released (278b); those active in the last 24 hours are
  routed again at once, older ones wait in Unassigned until the visitor
  writes.

**When a chat is routed.** At the visitor's first message, unless an AI will
answer it (the AI is off by default; `suggest_only` never answers;
`auto_reply_when_offline` answers only while nobody is online). When the AI
does answer, the chat is routed when it hands over. A message left in the
widget's leave-a-message form is routed too (no visitor notice: the form
confirmed it), waiting for the ticker when nobody can take it. The away
thread's first message while the visitor has a live conversation joins that
one as its next message: routed (or left to the AI that answers it) like any
other, again with no notice, since the away card told the visitor. If the
visitor is asked the pre-chat form (the form they actually get: the Super
Admin's policy, the plan and the workspace's own, timing not "never"; never
on a channel), routing waits for it, once per conversation, and routes
anyway two minutes later if the form never comes; a form sent, even empty,
is never waited for again. A claim that fails (a database blip) is retried
by the ticker. If the plan cannot be read for a moment, the stored mode
stands rather than Manual.

**Who gets it**, in this order:

1. **The same operator as before** ("last-agent routing"): the most recent
   of the contact's other conversations in the last N days (default 30),
   among their five most recent, that a person handled; its operator (its
   assignee, else the last operator who wrote in it). Conversations only the
   AI answered, or that hold only the AI's greeting, are passed over: with a
   fresh conversation after every close (one current conversation per
   visitor, 2026-10-24) they often lie between two visits. If that operator
   still receives chats, is online and active (not away), is under their
   maximum and belongs to the chosen department, they get it straight away.
   Otherwise routing goes on at once; it never waits for them. Not in Manual
   mode.
2. **The chosen department's operators** who receive chats and are available.
   If none is available, the whole team, unless the Super Admin turned "Use
   the general pool" off (then the chat waits for the department). No
   department chosen: the whole team.
3. Among them, by the workspace's **mode**:
   - **Auto**: the one with the fewest open and waiting-on-visitor
     conversations right now (not spam); on a tie, whoever received one
     longest ago.
   - **Round robin**: turns, with one rotation per department (and one for
     the whole team), continuing after the last pick.
   - **Manual**: nobody is assigned; the chat waits in Unassigned and the
     visitor sees their place in the queue. A plan without
     `widget_assignment_routing` always routes as Manual, whatever is stored.
4. **Available** means: their own availability says so ("Appear offline" off,
   "Show me as available to visitors" on, not "Away from desk", inside their
   schedule if they use one), the panel, the desktop app or the Android app
   is open, and they hold fewer chats than their maximum (workspace default
   5, a member may have their own). Active operators come first; an operator
   idle for less than 30 minutes is used only when no active one is free. An
   operator who chose "Away from desk" in the account menu (282) gets nothing
   new, not as the previous operator nor as the owner fallback, keeps the
   chats they hold, and does not make the widget online. "Open" ends as soon
   as the operator closes their last panel tab (the tab's beacon, 282b), not
   up to 5 minutes later; their other tabs, the desktop app and the phone
   keep them here.
5. **Owner fallback**: when nobody above can take it, the owner gets it if the
   Super Admin's global advanced-routing policy allows the owner fallback for
   chats (the same policy calls use) and the owner receives chats and is
   online.
6. **Nobody**: the chat waits unassigned. The visitor is told which case it
   is: "nobody is online right now" (`routing_no_agent_available`, reason
   `nobody_online`) or "everyone is busy, you are in the queue"
   (`routing_in_queue`, reason `all_busy`). The ticker hands it out as soon as
   someone comes online or frees up. Only Manual mode shows the visitor a
   place number (`GET /queue` counts the manual queue, per department since
   280b); a chat waiting in Auto or Round robin gets the notice without one.

The pick and the assignment are one SQL call, `chat_route_claim`, under a
per-workspace advisory lock that also counts each candidate's load, so chats
arriving at the same moment spread out instead of all landing on one person.

**After assignment.**

- **"X joined"** (owner, 2026-10-23): the visitor reads "X joined the
  conversation" (fa "X به گفتگو پیوست") right before X's first message
  after the AI, or before the first human answer in a chat the AI never
  had. The operator's reply writes it (`POST
  /api/conversations/send-message`, `server/services/operatorReplyJoin.ts`),
  once per stretch since the AI's newest message; a colleague who writes
  next gets their own line, someone who already wrote in that stretch none.
  Nothing is written at an assignment (routing, a claim, Take over, a
  transfer), so the line never names someone who has not written and never
  comes after their message. A transfer is an Inbox-only line ("A
  transferred this conversation to B", internal). A new chat the operator
  opens from the Visitors page gets no line: the visitor has not written
  yet. A platform admin who holds an Inbox seat in the workspace claims an
  unassigned chat on reply like any member; one without a seat claims
  nothing, but the visitor still reads who joined.
- **First-response timeout** (default 5 minutes, 0 = off, Auto and Round
  robin only): if the operator routing chose has not written in the chat by
  then, it goes to the next available operator (never back to them for that
  chat), or back to Unassigned if nobody is free.
- **By hand**: the first operator reply to an unassigned chat claims it;
  Take over and self-assign are atomic (409 `already_assigned` with the
  holder when someone was faster); a reassignment from a stale screen gets
  409 `assignment_changed`. `POST /api/conversations/:id/transfer` moves a
  chat to a person or to a department (a department transfer unassigns it
  and routes it inside that department only: not the whole team, not the
  owner fallback; nobody there, it waits for them, until the thread ends or
  someone gives it to a person). Assigning to a suspended member, a
  non-member or staff is refused (400 `invalid_target`). Assigning an
  AI-handled chat to a person is a human takeover.
- **Unassign** routes the chat again, in every mode.
- **Reopen** (the visitor writes in a resolved chat): it stays with its
  operator only if they are available, under their maximum and the reopen is
  inside the last-agent window; otherwise it is unassigned and routed.
  Resolving resets the AI's state, so the AI may answer a later thread that
  nobody holds; a thread its operator keeps (or reopens by hand) is a human
  takeover, and the AI, in either auto mode, never answers a conversation an
  operator holds.
- **Reaching out** (Visitors → Start chat, `POST
  /api/conversations/start-from-visitor`, R-29): the operator writes in the
  visitor's live conversation (open, pending or resolved), never a second
  one beside it; with none, a new one, theirs. The operator reaching out is
  who the visitor's answer goes to: an unassigned one becomes theirs (a
  claim), and a resolved one is reopened and taken from whoever resolved it
  (method `manual`, source `visitor_outreach`, with the Inbox's transfer
  line), theirs to continue, so the visitor's answer is not routed again. A
  platform admin reaching out takes nothing: the reopened chat keeps its
  operator, who is looked at again, as for any reopen, when the visitor
  answers. A chat the plan locked (past its retention) is never continued:
  the outreach starts a new conversation.
- **Phones**: a customer message in an unassigned chat reaches those whose
  push scope is "All conversations"; "Assigned to me" (`push_scope`
  `assigned`, the wording of the phone and desktop apps) is their own
  conversations only. "The AI handed this conversation to your team" is sent
  only for a real handoff (`ai_handoff_at`), never for a chat the AI never
  had.
- Every assignment and unassignment is a timeline event with its method
  (`auto`, `round_robin`, `last_agent`, `owner_fallback`, `timeout_reassign`,
  `take_over`, `first_reply`, `manual`, `manual_claim`, and the release
  reasons such as `member_removed`).

**The visitor's online/offline** (the widget's status) counts only members
who would be routed a chat: routable roles with "Receive chats" on, not
suspended, seat-paused or staff.

## Settings and where they live

| Setting | Where | Stored in | Default |
|---|---|---|---|
| Mode: Auto / Round robin / Manual | Workspace: Widget → Behaviour → Conversation assignment | `widget_settings.assignment_mode` | Auto |
| Return returning visitors to the same operator | Same section | `widget_settings.last_agent_routing_enabled` | on |
| Look back (days) | Same section | `widget_settings.last_agent_window_days` (1–365) | 30 |
| Maximum open conversations per operator | Same section | `widget_settings.default_max_concurrent_chats` (1–50) | 5 |
| First-response timeout (minutes) | Same section | `widget_settings.first_response_timeout_minutes` (0–60) | 5 |
| Close a quiet conversation after (hours) | Same section (every plan, every mode) | `widget_settings.inactivity_close_hours` (1–48, empty = the platform default) (284) | empty |
| Receive chats (per member, owner included) | Workspace: Team & departments | `workspace_members.receives_chats` | on |
| Max (per member) | Team & departments | `workspace_members.max_concurrent_chats` (1–50, empty = the workspace default) | empty |
| Departments and their members | Team & departments | `workspace_departments`, `workspace_department_members` | none |
| My availability (Appear offline, Show me as available to visitors, schedule) | Each operator: Availability | `user_availability_prefs` | available, no schedule |
| My status: Online / Away from desk / Offline | Each operator: the account menu | `user_availability_prefs.manual_away` (282) with `force_offline` | Online |
| Use the general pool | Super Admin → Widget settings → Routing | global advanced-routing policy, `general_pool_enabled` | on |
| Return returning visitors to the same operator (platform) | Same page | `last_agent_routing_enabled` (off = off for every workspace) | on |
| Workspace-owner fallback (master and per channel) | Same page | `owner_fallback_enabled`, `owner_fallback_for_chat` | on |
| Close quiet widget conversations (platform switch) | Same page, "Quiet conversations" | `widget_platform_settings.inactivity_close_enabled` (284; off = nothing closes automatically anywhere) | on (284 sets it off once on a database with live conversations; the backlog commit turns it on) |
| Default window of quiet conversations (hours) | Same group | `widget_platform_settings.inactivity_close_default_hours` (1–48) | 24 |
| Assignment routing in the plan | Super Admin → Plans | plan capability `widget_assignment_routing` | per plan |

The workspace switch for last-agent routing works only while the platform
switch is on. The workspace panel reads the platform policy through
`GET /api/workspace-departments/:workspaceId/routing-policy`, the same
`loadGlobalAdvancedRouting` routing reads, so the panel says what the
server does; the same answer carries `inactivity_close_enabled` and
`inactivity_close_default_hours` (`loadInactivityCloseSettings`; off and 24
before 284 or when unreadable). The Super Admin's two inactivity settings are
saved through `PATCH /api/widget-settings/platform/config`, the workspace's
window through `PATCH /api/widget-settings/:workspaceId` (not plan gated);
before 284 a save naming them answers 409
`inactivity_close_migration_required`.

## The routing ticker

`server/services/chatRoutingTicker.ts`, started by the backend
(`server/index.ts`): every 30 seconds (first pass 45 seconds after boot)
one replica takes the `chat_routing` lease (`tickerLease`, as the other
tickers) and asks `chat_routing_due()` for up to 100 due rows of each kind:

- `prechat`: the pre-chat wait ran out (two minutes): route anyway;
- `waiting`: a chat nobody could take: try again. The rows whose retry fell
  due longest ago go first, so more than 100 waiting chats take turns; a
  pass's rows are tried oldest wait first, and a workspace where nobody was
  online is skipped for the rest of that pass. A wait that saw activity (the
  visitor wrote, the chat was handed back) in the last hour is retried every
  25 seconds, an older one every 2 minutes; one that nothing but the ticker
  touched for 24 hours is forgotten (it stays in Unassigned, and the
  visitor's next message routes it again), as released chats are;
- `timeout`: an assignee missed the first-response timeout: reassign.

Every step is idempotent (the assignment is `chat_route_claim`'s
compare-and-set; due rows are handed out under `SKIP LOCKED`), so the lease
only avoids duplicate work. Before migration 278 the function is missing and
a pass does nothing. Nothing needs to be deployed for it besides the
backend.

## Closing quiet conversations

A website-widget conversation in which neither the visitor nor the team (a
person or the AI) has exchanged anything for N hours is closed (status
`closed`) by the system (owner, 2026-10-23/24; migration 284). The AI never
closes anything. N is the workspace's "Close a quiet conversation after"
(1–48 hours), else the Super Admin's default (24); a workspace has no off,
only the Super Admin's switch stops it, for every workspace at once.

- **Widget only.** No channel recorded, or `widget`. Never Telegram, Bale,
  WhatsApp, Instagram, email or platform support, never spam.
- **The last exchange** is the newest of: the visitor's turn, a person's
  answer, the AI's answer (needsReply.ts's rules, in SQL as
  `conversation_message_turn`: system rows, routing notices, menu taps,
  echoes, failed deliveries and the AI's hand-over line do not count), and a
  connected call (its end; now while it lasts, that is while the `call`
  guard below believes it live: a call whose end was never recorded counts
  its connect after 12 h). With none, when the conversation was created. Open, pending and resolved conversations all use
  the same N.
- **Never while the team owes an answer** (`conversation_idle_check`):
  - `needs_reply`: open, and the visitor's turn is the newest, with no answer
    and no call connected after it (a tie is owed; a bare "thanks" stays owed
    until someone resolves it, as the Inbox badge says);
  - `ai_handoff`: `needs_human`, `human_assigned` or a handoff requested;
  - `routing`: `routing_pending`, the manual queue, a routing wait, a
    pre-chat deadline or a first-response timeout running;
  - `call`: a call ringing or live (started in the last 12 h), an invitation
    or a call queue entry still open;
  - `callback`: a callback request requested, scheduled or in progress;
  - `guidance`: the AI asked the team and waits.
  Guards only a person clears (a callback, a guidance request, an old
  `routing_pending`) can pile up: the backlog script's dry run lists them,
  and can be run again at any time.
- **What a close writes** (`conversation_close_if_idle`, row-locked, a
  compare-and-set on `updated_at`, the decision taken again): status `closed`;
  the close markers (`shared/inactivityClose.ts` `CLOSED_KEYS`:
  `closed_reason` `inactivity`, `closed_by` `system`, `closed_at`,
  `closed_from`, `closed_source`, `closed_idle_hours`,
  `closed_last_exchange_at`, `closed_outcome`, `closed_line_id`,
  `closed_prev_stamps`); the two thread-end stamps (`routing_thread_ended_at`,
  `ai_thread_reset_at`: the widget's `endedAt` and the next thread's start);
  one timeline event, as the Inbox's PATCH files a close (`resolved` with
  `to: closed` from open or pending, `status_changed` from resolved; actor
  `system`; read "Closed · Automatically, after N h without messages").
- **What it never writes**: `updated_at` (retention locks, the Resolved lists
  and the visitor's history go by it), the AI's hold (`ai_state`,
  `managed_by_ai`, the handoff and takeover keys: an AI-only conversation
  stays in no Inbox queue but the web panel's Closed box, whose Reopen takes
  it over first, as Take over does, so it lands with that operator, not
  back with the AI), `routing_pending`, routing's state or skip list, an
  audit row. No push, no transcript, no e-mail.
- **The visitor's line and the rating.** When the visitor ever wrote, the
  close inserts the nameless closed line in the same transaction (`kind`
  `conversation_closed`, `by` `system`, `agent_name` null, `closed_reason`
  `inactivity`; body "The conversation was closed"): the widget draws «گفتگو
  به پایان رسید» and, where the template's rating is on, the card. The line
  is prepared before the close; when a read for it fails the conversation
  is left for the next pass, never closed without it. It goes out live once
  the race grace (below) is over, and only if the close still stands. The
  line names the operator the rating is about (the assignee if they wrote,
  else the newest person who wrote), or nobody. A person answered when one
  wrote or a call connected (the card is theirs); only the AI when it gave a
  real answer, never by its greeting alone: then the card asks about the AI
  (`subject` `ai`, kept out of every operator's satisfaction). A thread that
  already ends with a closed line keeps it (`closed_line_id` null). The
  Inbox thread shows the line as «گفتگو پس از مدتی بی‌پیامی به‌طور خودکار
  بسته شد». The lists move as for the PATCH (`conversation_resolved` from
  open or pending, `conversation_updated` from resolved, actor null) and the
  open timeline reloads.
- **The race.** A visitor message within 60 seconds of the close
  (`INACTIVITY_CLOSE_RACE_GRACE_SECONDS`) goes back into that conversation
  as it was (`conversation_reopen_after_idle_close`: `closed_from`, the
  stamps as they were, the markers removed, the line it wrote retracted with
  `metadata.internal`, a `reopened` event with reason
  `customer_replied_after_inactivity_close`); its lifecycle, routing and the
  AI then run as for any message. A message being inserted while the close
  runs holds it back (its foreign key's lock) and keeps the conversation
  open. Since the line reaches an open widget only after those 60 seconds,
  a realtime widget never shows a line the server took back; a widget in
  polling mode can fetch it in between and keeps it on screen until its
  next history load. Later than 60 seconds, or after an operator's close: a
  new conversation, as before.
- **The ticker**: `server/services/conversationIdleCloseTicker.ts`, every 5
  minutes (first pass 2 minutes after boot), one replica (the
  `conversation_idle_close` lease; not in `TICKER_CYCLE_SECONDS`, the
  compare-and-set makes passes idempotent), at most 50 closes a pass, the
  longest untouched first; rows the team owes never use up the batch. Log:
  `[idle-close] pass due=… closed=… skipped={…}`, or `[idle-close] pass off`.
- **The 30-day bound.** The timer never closes a conversation untouched
  (`updated_at`) for more than 30 days: that is the backlog, closed by hand.
  One that stopped being owed after more than 30 days without anything
  touching it is listed by the backlog script's dry run; closing it needs the
  owner's go, as for the first backlog.
- **Latency.** The switch is read by the SQL itself (`conversation_idle_due`
  and the close), so nothing closes the moment it is off; the ticker's own
  cached copy (60 s, cleared at once by the save and on every process by the
  cache bus) only decides whether it takes the lease. In polling mode the
  widget's heartbeat touches `updated_at` while a page is open, which delays
  the close (never makes it early).
- **The backlog** already quiet when 284 shipped is closed once, silently and
  by hand: `database/backfill/284_inactivity_backlog_close.sql` (its header
  has the commands). The dry run lists every live widget conversation with
  its verdict (counts by verdict and workspace, one row each: no message
  text, no contact data), writes the due ids to a CSV, closes them inside the
  transaction, checks and rolls back. The commit closes the reviewed ids only
  (each checked again), writes no visitor line and turns the switch on in the
  same transaction; a reviewed file that is missing or empty stops it before
  anything changes.
- **Reports** (`conversationEndOf`): "Closed automatically" counts the
  system's closes of open or pending conversations; a resolved conversation
  the system closed later stays its operator's resolve; a close by an
  operator (`closed_reason` `operator`, written by the PATCH) or by an older
  server (no markers) is an operator's. The same rule counts operator
  activity's "resolved" and the weekly summary e-mail's. A PATCH or reply
  that reopens a closed conversation nulls every marker.

## Rollout checklist

WebYar's database is migrated by hand (CLAUDE.md, "Migrations"); RESPOK's
migrator applies the same files on every push to `main`. Do WebYar first,
before merging the code.

1. **Pre-checks**, on both databases:
   - what is already applied:
     `SELECT filename, applied_at FROM public._schema_migrations WHERE filename >= '278' ORDER BY 1;`
   - no invalid index left by an earlier attempt:
     `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;`
   - 279: `SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = 'widget_settings_validate_offline_mode';`
   - 279b: `SELECT primary_color, count(*) FROM public.widget_settings GROUP BY 1;`
     (and confirm RESPOK's `/data/respok/migrator/overlay.sql` does not write
     `widget_settings.primary_color`). 279b converts CSS names, rgb()/hsl()
     and #RRGGBBAA to #RRGGBB, and keeps every value it changes in
     `widget_primary_color_backup_279b`; its header has the restore
     statement.
2. **Build the indexes CONCURRENTLY first** (WebYar, outside a transaction,
   one statement at a time; the files then find them and build nothing).
   From the 278 header:
   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_open_assignee_idx
     ON public.conversations (workspace_id, assigned_to)
     WHERE assigned_to IS NOT NULL AND status IN ('open', 'pending') AND is_spam = false;
   CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_contact_recent_idx
     ON public.conversations (workspace_id, contact_id, updated_at DESC)
     WHERE contact_id IS NOT NULL;
   ```
   From the 281 header:
   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS widget_smart_events_ws_created_idx
     ON public.widget_smart_events (workspace_id, created_at);
   ```
   An interrupted build leaves an invalid index: `DROP INDEX CONCURRENTLY` it
   and build it again (the files stop with a message if they find one).
3. **Dry-run** the files of step 4 (and 283 of step 8), in that order, inside one
   `BEGIN … ROLLBACK` (each later file needs the earlier ones: 278b uses
   278's tables, 280b replaces 276's queue functions).
4. **Apply in this order** (the order `migrate-database.sh` uses, `LC_ALL=C`):
   `278_chat_routing_distribution.sql`, `278b_chat_routing_member_release.sql`,
   `279_widget_offline_mode_values.sql`, `279b_widget_primary_color_brand.sql`,
   `280_widget_visitor_forms.sql`, `280a_widget_kb_search_fold.sql`,
   `280b_widget_queue_per_department.sql`, `281_widget_visitor_privacy.sql`,
   `282_operator_manual_away.sql`, `282b_operator_presence_sources.sql`,
   with the CLAUDE.md procedure: the folder with `scripts/` and
   `database/migrations/`, `docker cp` into the database container,
   `migrate-database.sh` as `postgres` with
   `PGOPTIONS='-c lock_timeout=5s'`. Each file also sets `lock_timeout` itself;
   a statement stopped by it is simply run again. **Leave
   `283_offline_message_template_phone.sql` out of this folder**: it is
   step 8.
5. **Check**: a second run applies nothing; `chat_route_claim`,
   `chat_routing_due` and `chat_routing_release_member` exist and are
   executable by `service_role` only (`\df+` or `has_function_privilege`);
   `chat_queue_status` keeps its grants; the five visitor retention policies
   of 281 are there and **disabled**, and
   `visitor_data_retention_delete_batch` is fenced like 171's
   `data_retention_delete_batch` (`retention_cleanup_not_ready`): even an
   enabled policy deletes nothing until the owner lifts migration 171's
   fence in a reviewed migration of its own.
6. **Ledger**: add each file with its UTC time to the migrations list in
   CLAUDE.md, and take it off the pending list there.
7. Merge. After the backend deploys, a new chat with the AI off is assigned
   at its first message, and the visitor reads "X joined" when X first
   writes.
8. **After the backend of this release is live**, apply
   `283_offline_message_template_phone.sql` the same way (a folder with it
   alone; `migrate-database.sh` skips what the ledger has). It adds
   `{contact_phone}` to the owners' "new offline message" mail, which only
   the new backend fills: applied earlier, the old backend's mails would read
   "Phone: {contact_phone}". Ledger it in CLAUDE.md as the others. (RESPOK's
   migrator applies it on push with the rest: a few minutes of the raw
   placeholder at worst, in an internal mail.)

On RESPOK the migrator builds the same indexes without CONCURRENTLY (its
tables are small) and applies the files on push; run the pre-checks there
too before merging.

### Rollout of 284 (the inactivity close)

WebYar by hand before the merge; RESPOK by its migrator on push. The order
matters: 284 sets the switch off on a database with live conversations, the
backlog is closed by hand after the owner's go, and its commit turns the
switch on.

0. **Measure** (read only, the owner's go), on both databases: live widget
   conversations by quiet age and by verdict, and the monthly returns after
   more than 24 h (the extra conversations to expect: a return after a close
   is a new counted conversation). Counts only.
1. **Pre-checks**, on both databases:
   - the ledger has 283;
   - no `conversations_live_updated_idx`, or a valid one:
     `SELECT indexrelid::regclass, indisvalid FROM pg_index WHERE indexrelid = to_regclass('public.conversations_live_updated_idx');`
   - `/data/respok/migrator/overlay.sql` writes neither
     `widget_platform_settings.inactivity_*`,
     `widget_settings.inactivity_close_hours` nor `conversation_ratings.subject`
     (grep it; dry-run it with `ROLLBACK` after 284).
2. **WebYar dumps** into `/root/webyar-migrate-284/`: `widget_settings`,
   `widget_platform_settings` and `conversation_ratings`, plus a schema dump.
3. **WebYar: the index CONCURRENTLY first** (outside a transaction), then
   check `indisvalid`:
   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_live_updated_idx
     ON public.conversations (updated_at)
     WHERE status IN ('open', 'pending', 'resolved') AND is_spam = false;
   ```
4. **WebYar: 284.** Dry-run it inside `BEGIN … ROLLBACK`; apply it with the
   CLAUDE.md procedure (the folder `/root/webyar-migrate-284/` with
   `scripts/`, `database/migrations/` holding 284 alone and
   `database/backfill/`; `docker cp` to `/tmp/m284`;
   `migrate-database.sh` as `postgres` with `PGOPTIONS='-c lock_timeout=5s'`;
   then remove `/tmp/m284`). Check: the switch reads `false`; the five
   functions (and `conversation_inbox_counters`) are executable by
   `service_role` only; the ledger row is there.
5. **WebYar backlog dry run**: dump the live widget conversations,
   `conversation_events` and `chat_routing_state` into the same folder; run
   the script without commit, with `-v out=…/backlog.csv`; write the Persian
   summary for the owner's knowledge base (counts per workspace and verdict,
   owed rows by reason; no text, no ids). The owner reviews it.
6. Open or refresh the PR with the 284 ledger entry in CLAUDE.md; CI green.
7. **Merge.** WebYar's 24/25 deploy; RESPOK's 32/33/40 deploy and migrator 40
   applies 284 (its index built in the file; the switch goes off). About 15
   minutes in all (check `application_deployment_queues` before assuming a
   failure). The backend logs show `[idle-close] pass off`.
8. **RESPOK**: dumps, the backlog dry run and its Persian summary (2
   conversations expected).
9. **Smoke test** on an owner-authorized test workspace of each brand: set
   its window to 1 h (its own value) with the switch still off, and check
   `conversation_idle_check` says `due` for a test chat after an hour.
10. **After the owner's go**, per brand: copy the folder with the reviewed
    `backlog.csv` back into the container (`/tmp/m284` was removed in step
    4), then the backlog commit (`-v commit=1 -v ids=/tmp/m284/backlog.csv`).
    It closes exactly the reviewed ids, silently, and turns the switch on.
    A missing or empty file stops it before anything changes (psql itself
    would read a missing file as no id and carry on). When the dry run found
    nothing due there is nothing to commit: turn the switch on in the Super
    Admin's "Quiet conversations" instead. Note the time and the counts.
11. **Watch**: the `[idle-close] pass` lines; in each template (default, t1,
    t2; intl, t1-intl, t2-intl on RESPOK) on the test workspace a live close
    shows «گفتگو به پایان رسید» and the card, a rating reaches the timeline,
    and the Inbox timeline reads «بسته شد · خودکار، پس از … ساعت بی‌پیامی»;
    a kill-switch drill (off, the next pass logs `off`, on again); then set
    the test workspace back to the platform default.
12. A docs-only follow-up PR records the backlog commits (times, counts) in
    the CLAUDE.md ledger.

**Rollback**: switch the close off (immediate: the SQL reads it), then
`ROLLBACK=1` through `/root/webyar-move/deploy.php` if needed. 284 stays: it
is harmless with the old code (nullable or constant-default columns, functions
nobody calls, the switch off).
