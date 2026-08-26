# Realtime Vendor Security Recommendation

**Status:** Formal recommendation, not yet enacted. The production default
provider registration (`src/providers/bootstrap.ts`:
`providerRegistry.setActive('realtime', 'supabase')`) has **not** been
changed by this document. This predates the GoTrue-off cutover work and is
recorded here per that closure pass's instruction to document it formally
without blocking the cutover on it.

## Finding

Supabase Realtime broadcast channels, as currently wired, are **not
authorized per-subscriber**. The practical access-control boundary for a
conversation's live message stream is knowledge of its channel name —
nothing else.

Evidence:

- Channel names are deterministic and computed client-side from two IDs
  neither of which is a secret to begin with:
  `ws:<workspace_id>:conv:<conversation_id>` — `buildChannelName()` in
  `server/services/realtime/types.ts:84-87`. `workspace_id` is embedded in
  the public widget loader/bootstrap payload; `conversation_id` is handed
  to the visitor's own browser and is also visible to any operator viewing
  the inbox.
- The client-side Supabase adapter (`src/realtime/providers/supabase.ts:29`)
  calls `supabase.channel(channel, { config: { broadcast: { self: false,
  ack: false } } })` and subscribes directly — no server-issued, per-channel
  token is requested or presented.
- No `realtime.messages` RLS policy or broadcast-authorization migration
  exists in this repository (`grep -rl "realtime.messages\|realtime_authorization\|broadcast.*authorization"
  database/migrations supabase/migrations` returns nothing), which is the
  mechanism Supabase Realtime uses to gate broadcast channel access.
  Without it, `supabase.channel(name)` succeeds for anyone holding a valid
  Supabase client (including the public anon key) who can name the
  channel.

Net effect: an actor who can enumerate or guess a `conversation_id` UUID
(36 hex characters — not brute-forceable, but potentially learnable from
logs, referrer leakage, a compromised extension, or a workspace member who
is not supposed to see a specific conversation) can subscribe to that
conversation's live message/typing/seen broadcast without ever being
checked against workspace membership.

## Contrast: Centrifugo

Centrifugo, the alternate realtime vendor already implemented in this
codebase, does not have this gap:

- Every operator connection is negotiated through
  `POST /api/realtime/operator-connect` /
  `operator-subscribe` / `operator-inbox-subscribe` /
  `operator-visitors-subscribe` (`server/routes/realtime.ts`), each gated
  by `authorizeOperator()` → `authorizeWorkspaceAccess()` — a first-party
  `gs_session` cookie check plus a `workspace_members` lookup, executed
  server-side, before any subscription token is issued
  (`server/routes/realtime.ts:364-368`).
- The token returned is scoped by the server to the specific channel(s)
  the caller is authorized for (`server/services/realtime/centrifugo.ts`),
  not a bare channel name the client can pick for itself.

This is the correct shape for a production authorization boundary; the
Supabase broadcast path is not.

## Recommendation

- **Production default: Centrifugo.** It should be the vendor new
  self-hosted deployments land on, and the one documented as supported.
- **Supabase Realtime: legacy/deprecated.** Keep the adapter
  (`src/realtime/providers/supabase.ts`) and the server-side publisher
  (`server/services/realtime/publishers/supabase.ts`) working — some
  self-hosted operators may not have a Centrifugo deployment available —
  but stop treating it as an equally-safe alternative. It should not be
  the default for new installs, and existing installs relying on it should
  be flagged as running with a weaker realtime authorization boundary
  until they either switch to Centrifugo or a Supabase Realtime broadcast
  authorization migration is added.

## Why this is not enacted in this pass

`src/providers/bootstrap.ts` currently sets `realtime` → `supabase` as the
active provider, and `docs/REALTIME_REGRESSION_CHECKLIST.md` documents a
**frozen baseline**: "do not refactor the widget runtime or realtime layer
unless a new, reproducible bug is filed against this checklist," and "all
scenarios must pass on both Centrifugo and Supabase realtime backends."
Switching the production default is a functional change to a frozen
subsystem and needs its own regression pass proving Centrifugo-by-default
is equivalent for every scenario in that checklist (visitor widget
bootstrap on both vendors, operator inbox live updates, typing/seen
receipts, reconnect/failover behavior, polling fallback). That is out of
scope for the GoTrue-off closure pass, which is about authentication
runtime dependencies, not realtime vendor selection — the auth migration
work does not touch or depend on which realtime vendor is active.

## Suggested follow-up (separate task)

1. Run the full `docs/REALTIME_REGRESSION_CHECKLIST.md` suite with
   `providerRegistry.setActive('realtime', 'centrifugo')` as the default
   and confirm parity with the current Supabase-default baseline.
2. Flip the default in `bootstrap.ts` once parity is confirmed.
3. Either add a Supabase Realtime broadcast-authorization migration
   (`realtime.messages` RLS) for installs that keep using it, or mark it
   explicitly deprecated in the admin Providers UI
   (`src/pages/admin/ProvidersPage.tsx` → `AdminRealtimeCard`) with a
   visible warning about the unauthenticated-channel gap documented above.
