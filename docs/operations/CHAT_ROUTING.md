# Chat routing

How a chat (a website widget conversation, or a channel conversation such as
Telegram) gets an operator, which settings change that and where they live,
the background ticker, and how to roll the database side out.

Code: `server/services/chatRouting.ts` (the decisions),
`server/services/chatRoutingTicker.ts` (the clock),
`server/services/chatRoutingPrechat.ts` (the pre-chat wait),
`server/services/conversationAssignment.ts` (assigning by hand),
`shared/chatRoles.ts` (who may do what). The SQL is in migrations 278, 278b
and 280b (`chat_route_claim` and its helpers).

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
confirmed it), waiting for the ticker when nobody can take it. If the
visitor is asked the pre-chat form (the form they actually get: the Super
Admin's policy, the plan and the workspace's own, timing not "never"; never
on a channel), routing waits for it, once per conversation, and routes
anyway two minutes later if the form never comes; a form sent, even empty,
is never waited for again. A claim that fails (a database blip) is retried
by the ticker. If the plan cannot be read for a moment, the stored mode
stands rather than Manual.

**Who gets it**, in this order:

1. **The same operator as before** ("last-agent routing"): if the contact had
   another conversation in the last N days (default 30) and its operator (its
   assignee, else the last operator who wrote in it) still receives chats, is
   online and active (not away), is under their maximum and belongs to the
   chosen department, they get it straight away. Otherwise routing goes on at
   once; it never waits for them. Not in Manual mode.
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
| Receive chats (per member, owner included) | Workspace: Team & departments | `workspace_members.receives_chats` | on |
| Max (per member) | Team & departments | `workspace_members.max_concurrent_chats` (1–50, empty = the workspace default) | empty |
| Departments and their members | Team & departments | `workspace_departments`, `workspace_department_members` | none |
| My availability (Appear offline, Show me as available to visitors, schedule) | Each operator: Availability | `user_availability_prefs` | available, no schedule |
| My status: Online / Away from desk / Offline | Each operator: the account menu | `user_availability_prefs.manual_away` (282) with `force_offline` | Online |
| Use the general pool | Super Admin → Widget settings → Routing | global advanced-routing policy, `general_pool_enabled` | on |
| Return returning visitors to the same operator (platform) | Same page | `last_agent_routing_enabled` (off = off for every workspace) | on |
| Workspace-owner fallback (master and per channel) | Same page | `owner_fallback_enabled`, `owner_fallback_for_chat` | on |
| Assignment routing in the plan | Super Admin → Plans | plan capability `widget_assignment_routing` | per plan |

The workspace switch for last-agent routing works only while the platform
switch is on. The workspace panel reads the platform policy through
`GET /api/workspace-departments/:workspaceId/routing-policy`, the same
`loadGlobalAdvancedRouting` routing reads, so the panel says what the
server does.

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
   at its first message and the visitor reads "X joined".
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
