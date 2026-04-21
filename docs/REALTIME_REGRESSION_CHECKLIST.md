# Realtime Regression Checklist

**Status:** Frozen baseline — do not refactor the widget runtime or realtime
layer unless a new, reproducible bug is filed against this checklist.

Scope of the freeze:

- `public/widget/runtime.js`
- `public/widget/runtime-rt-centrifugo.js`
- `public/widget/runtime-rt-supabase.js`
- `public/widget/runtime-rt-resolver.js`
- `public/widget/loader.js`
- `src/realtime/providers/centrifugo.ts`
- `src/realtime/providers/supabase.ts`
- `src/realtime/providers/polling.ts`
- `src/realtime/index.ts`
- `server/services/realtime/**`
- `server/routes/realtime.ts`

Run the full checklist before shipping any change that touches the files
above, even if the change looks unrelated. All scenarios must pass on both
Centrifugo and Supabase realtime backends.

---

## How to enable debug logs

Logs are off by default in production. Enable per environment:

### Visitor widget (browser)

Any one of:

- Admin → Widget settings → toggle **Debug mode** (persistent, server-driven)
- DevTools console: `localStorage.setItem('gs:debug', '1')` then reload
- DevTools console: `window.__gs_debug = true` then reload

Disable with `localStorage.removeItem('gs:debug')` or unsetting the toggle.

All visitor logs are namespaced `[Widget Runtime]` and never include
tokens, JWTs, or PII — only IDs, vendor names, FSM state names, and
transition reasons.

### Operator inbox (browser)

- Per-tab: `localStorage.setItem('rt:debug', '1')` then reload
- Per-build: set `VITE_RT_DEBUG=1` before `vite build`

All operator logs are namespaced `[rt:<scope>]` (e.g. `[rt:centrifugo]`).

### Server (Node)

- Set `RT_DEBUG=1` in the server environment, restart the Express server.

Server logs are namespaced `[rt:server:<scope>]`. Warnings always print
regardless of the flag — they indicate a fallback or degraded transport.

---

## Regression scenarios (all must pass)

For each scenario, capture the visitor console, the operator console, and
the server log if you have one. Compare against the **expected** column.

### 1. First open (cold start)

- **Setup:** new incognito window, no prior session.
- **Action:** open a page with the widget, click the launcher, send one
  message.
- **Expected visitor lifecycle:**
  `idle → bootstrapping → restoring_session → connecting → subscribing → connected (driver:subscribed)`
- **Expected:** no `transport reconnect — refreshing history` during boot.
- **Expected:** message appears in the operator inbox in <1s.

### 2. Operator reply, then visitor reply

- **Setup:** scenario 1 completed, operator inbox open.
- **Action:** operator sends a reply; visitor sends a follow-up.
- **Expected:** visitor receives the operator reply with no FSM state
  change.
- **Expected:** visitor composer stays sendable; the follow-up arrives in
  the operator inbox in <1s.
- **Expected:** no `illegal transition` warnings.

### 3. Visitor refresh mid-conversation

- **Setup:** active conversation with messages in both directions.
- **Action:** visitor presses F5.
- **Expected lifecycle:**
  `idle → bootstrapping → restoring_session → connecting → subscribing → connected (driver:subscribed)`
- **Expected:** prior history reloads; composer is sendable; new messages
  flow both ways.
- **Expected:** no `transport reconnect — refreshing history` during the
  initial restore.

### 4. Operator refresh mid-conversation

- **Setup:** active conversation, operator viewing the thread.
- **Action:** operator presses F5.
- **Expected:** inbox list and the open conversation re-subscribe; no
  `socket_closed` per-channel error spam.
- **Expected (with debug on):** at most one
  `resubscribe loop aborted — connection stale` line if a prior socket was
  in flight; never a flood.
- **Expected:** operator can send a reply immediately after the inbox
  re-renders.

### 5. Background tab → return

- **Setup:** active visitor conversation, healthy connection.
- **Action:** switch to another tab for 30+ seconds, switch back.
- **Expected:** widget logs `[wake] skipped` (not a forced reconnect).
- **Expected:** no FSM transition; composer stays sendable.
- **Expected:** no `transport reconnect — refreshing history`.

### 6. Centrifugo restart

- **Setup:** active conversation on the Centrifugo backend.
- **Action:** restart the Centrifugo container/process.
- **Expected visitor:** transport drops, FSM transitions
  `connected → reconnecting → connecting → subscribing → connected`
  within the reconnect backoff window (≤30s).
- **Expected operator:** same recovery; `resubscribeAll` runs exactly
  once per successful socket open (verified by the per-connection
  generation guard).
- **Expected:** no token-refresh storm; at most one forced refresh per
  rejected connect.
- **Expected:** messages sent during the gap are flushed once
  `connected` is reached.

---

## Known invariants (do not break)

These are load-bearing properties verified by the scenarios above. If a
future change violates any of them, the change is wrong — fix the change,
do not amend the invariant.

1. **`onReconnect` means a real reconnect.** It must NOT fire on the first
   successful connect. (Widget: `firstConnectDone` in
   `runtime-rt-centrifugo.js`. Operator: same flag in
   `src/realtime/providers/centrifugo.ts`.)
2. **`subscribing → connected` requires a subscribe ack.** The driver
   must call `hooks.onSubscribed({ channel, conversationId })` and the
   FSM bridge must verify `conversationId` matches the active one.
3. **Wake events never reconnect a healthy `connected` socket.**
   `WAKE_RECOVERABLE` excludes `connected`. Recovery is owned by the
   driver's own ping/onclose.
4. **`resubscribeAll` is generation-guarded.** It captures
   `startGeneration` and bails the moment `conn.generation` advances or
   `conn.ws.readyState !== OPEN`. No per-channel spam on a dead socket.
5. **Centrifugo error code `105` (already subscribed) is benign.** Both
   widget and operator treat it as success. It must never set inbox
   status to `error` or trigger reconnect.
6. **`socket_not_open` during subscribe is deferred, not fatal.** The
   token is cached and the subscribe is retried by `resubscribeAll` on
   the next successful open.
7. **No Edge Functions.** All backend logic runs in the Express server
   under `server/`. See `.lovable/memory/features/architecture.md`.

---

## When a scenario fails

1. Enable debug logs on the affected side (visitor / operator / server).
2. Reproduce and capture the full log.
3. Identify which invariant above is violated.
4. Fix the root cause in the smallest possible diff. Do NOT widen the
   FSM transition table, do NOT add new wake triggers, and do NOT
   bypass the generation guard.
5. Re-run the entire checklist — not just the failing scenario.
6. Update this document if the fix introduces a new invariant worth
   protecting.
