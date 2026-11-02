# Colleague calls (team calls)

Voice and video calls between two members of one workspace, from the team
chat, on the phones. Owner, 2026-11-01:

- a colleague call rings like a phone call, also when the phone is locked or
  its screen is off (Telegram / WhatsApp): iOS through PushKit and CallKit,
  Android through a high-priority data FCM and a full-screen call
  notification;
- it is a plan feature the Super Admin turns on or off per plan;
- its minutes and its concurrency count in the plan, like every other call
  ("both in the plan");
- this release: the iOS and Android apps only. The web panel and the desktop
  apps neither ring nor call;
- the iPhone rings for colleague calls only. Call-centre (visitor) calls do
  not ring an iPhone yet.

This file is the contract between the server and the two apps. Change it
together with the code.

## Product rules

- 1:1 only. The caller and the callee are two different members of the same
  workspace, both active (not suspended, not seat-locked). Anyone who may
  message a colleague in the team chat may call them (team chat has no role
  rule; neither has this).
- A call is `audio` or `video`. A video call may be answered with the camera
  off.
- The ring lasts 45 s (`TEAM_CALL_RING_SECONDS`). Unanswered → `missed`, and
  the callee gets a "missed call" notification that opens the thread.
- The callee may decline (`declined`): the caller's call ends at once. The
  caller may cancel before an answer (`cancelled`): the callee's phones stop,
  and the callee gets the missed-call notification.
- Busy: a member in a colleague call that is ringing, connecting or active, or
  in any other live call (`operator_call_availability` busy), cannot be rung.
  The caller is told `callee_busy` at once; a caller already in a call gets
  `caller_busy`. A live row older than 12 h holds nobody (its end never
  reached the server). The check and the insert run together in
  `team_call_place()` (migration 293), under a lock per member, so two calls
  placed at the same moment that share a member never both ring.
- Every phone of the callee rings. The first to answer wins; the others stop
  (`answered_elsewhere`). The caller's own other phones are not rung.
- Either side hangs up → `ended` for both. A participant whose app dies is
  ended by the LiveKit webhook when it leaves the room, or by the ticker's
  room check when that webhook is lost.

## Plan

- New registry key `team_calls` (`server/services/billing/capabilityRegistry.ts`):
  type `feature`, group `calls`, default `false`, `planConfigurable: true`,
  `workspaceOverridable: false`, user visible. Labels in
  `src/lib/capability-i18n.ts` (en/fa/tr) and the customer plan card
  (`PlanFeatures.tsx`, `billing.plans.feat.team_calls`).
- A call is allowed when, all together: `team_calls` is on in the plan, the
  plan's `voice_video` module is on, the plan's channel for the call is on
  (`voice` for audio, `video` for video), and the runtime switches allow it
  (control plane: platform and workspace voice/video). Deny on create, allow
  on continuity: an in-flight call is never cut by a plan change.
- Limits: `max_concurrent_calls` (rows in pending/ringing/connecting/active
  count, colleague calls included) and `max_call_minutes_per_month` (the
  billing trigger counts from `connected_at`, which a colleague call sets at
  the answer). Checked on create, like `/api/calls/create`.
- The App Review plan carries `team_calls: true` (migration 293).

## Data

`call_sessions` row per call, no new table:

- `entry_source = 'team_call'`, `context_type = 'internal'`, `context_id = NULL`
  (so `endCallSession` writes no conversation line).
- `state`: `ringing` → `connecting` (answered) → `active` (both in the room) →
  `ended`; or `ringing` → `missed` | `cancelled` | `ended` (declined/busy).
- `metadata.team_call`: `{ caller_user_id, callee_user_id, channel, outcome,
  answered_device_id, answered_at, rung_android_device_ids: [], rung_ios_device_ids: [] }`.
  `outcome` ∈ `completed | declined | cancelled | missed | failed`.
- `connected_at` is stamped at the answer (billing).
- No user id, e-mail or name goes into LiveKit room metadata; members join as
  `internal:<opaque ref>` with their profile name only
  (`server/services/calls/operatorIdentity.ts`).
- The CallKit handle is the call id (opaque), never an e-mail or a user id;
  `includesCallsInRecents` is off.

## API (`/api/team-calls`, session auth)

`TeamCall` (every response):

```json
{
  "id": "uuid", "workspace_id": "uuid", "channel": "audio|video",
  "state": "ringing|connecting|active|ended|missed|cancelled",
  "outcome": null, "role": "caller|callee",
  "peer": { "user_id": "uuid", "name": "Daniel Carter", "avatar_url": null },
  "answered_device_id": null,
  "created_at": "…", "answered_at": null, "ended_at": null, "expires_at": "…"
}
```

| Method and path | Who | Does |
|---|---|---|
| `POST /` `{workspace_id, callee_id, channel}` | a member | Checks membership, plan, limits, busy; creates the row and the room; rings the callee; `201 {call}`. Errors: `400 invalid_params`, `403 upgrade_required` (`feature: 'team_calls'`), `403 not_a_member`, `409 callee_busy`, `409 caller_busy`, `429 too_many_calls`, `422 limit_reached` (`limit: 'max_concurrent_calls' | 'max_call_minutes_per_month'`). Rate limit: a caller rings at most 10 times a minute, a callee is rung at most 6 times a minute. |
| `GET /:id` | caller or callee | `{call}`; `404` for anyone else. |
| `POST /:id/accept` `{device_id?}` | callee | `ringing` → `connecting` with a compare-and-set (first answer wins); stamps `connected_at`, `answered_at`, `answered_device_id`; stops the callee's other phones; `{call}`. `409 not_ringing` with `{call}` when it is no longer ringing. |
| `POST /:id/decline` | callee | `ringing` → ended, outcome `declined`. Idempotent. |
| `POST /:id/cancel` | caller | `ringing` → `cancelled`, outcome `cancelled`; missed-call notification to the callee. Idempotent. |
| `POST /:id/hangup` | either | ends the call (outcome `completed` once answered); idempotent. |
| `POST /:id/token` | either, state connecting/active | The LiveKit token for this user only, in the same shape as `POST /api/calls/:id/token`'s answer (`token`, `expires_at`, `provider`, `rtc_url`, `ws_url`, `turn`, `ice_policy`, `network`, `warnings`). Identity and name come from the session, never from the body. `409 not_connected` with `{call}` before the answer. A member whose seat was paused during the call keeps getting tokens. |

The generic `/api/calls/:id/*` routes (token, state, invite, accept, reject,
hangup, end, recording) and the call centre's `GET /calls/:id` answer `404`
for a `team_call` row.

Other answers: `401` without a session, `403 forbidden` for the wrong side
(the caller calling accept), `404 not_found`, `503
entitlement_status_unavailable` when the plan cannot be read. The `403
upgrade_required` adds `capability` and `reason` (`plan` | `runtime`); the
`422` adds `reason`, `max`, `used`. The apps show each of these as a failed
call.

The apps end a call this way: the caller sends `hangup` (before the answer
the server turns it into a cancel; Android may send `cancel` and then
`hangup` if the answer crossed it); the callee sends `decline` while it rings
on that phone and `hangup` once its own answer went through; while its answer
is in flight it waits for the server's verdict and hangs up only if that phone
won, so it never ends a call its other phone answered.

## Ring and its stop

| | Ring | Stop |
|---|---|---|
| iOS | VoIP push (PushKit), `apns-push-type voip`, topic `<APNS_BUNDLE_ID>.voip`, priority 10, expiry 45 s, to every enabled `mobile_push_devices` row of the callee with a `voip_token`: `{"kind":"team_call","event":"incoming","call_id","workspace_id","workspace_name","channel","caller_name","caller_avatar_url","caller_user_id","expires_at"}`; `expires_at` is Unix seconds as a JSON number (the app also reads a numeric or ISO string), `workspace_name` and `caller_avatar_url` may be null | **Never a VoIP push** (each one must become a CallKit call). The ringing app polls `GET /api/team-calls/:id` every 2 s and listens on its user channel; it ends the CallKit call on any state but `ringing`, or at `expires_at`. |
| Android | data-only FCM, priority HIGH, ttl 45 s, collapse key = call id: `{type:"team_call_incoming", callId, workspaceId, workspaceName, channel, callerName, callerAvatarUrl, callerUserId, expiresAt}`; `expiresAt` is Unix seconds as a string; `workspaceName` and `callerAvatarUrl` are left out when there is none (FCM data values are strings) | `{type:"team_call_cancel", callId, reason}` with reason `answered_elsewhere | declined | cancelled | missed | ended`, only to the Android devices that were rung (`rung_android_device_ids`), never to the one that answered. |
| Both apps in the foreground | realtime `{type:"event", payload:{kind:"team_call", workspace_id, call_id, state, outcome}}` on `ws:<workspace>:user:<uid>` for the caller and the callee, on every change | |
| Missed | alert push `team_call_missed` to the callee (data `{type:"team_call_missed", workspaceId, peerId, callId, channel}`, localized "Missed voice call" / "Missed video call" with the caller's name), opening the thread | |

Call-centre rings on iOS are off (`server/services/push/callRing.ts`): an
iPhone that registers a VoIP token for colleague calls is never rung, and
never sent a VoIP cancel, for a visitor call.

Ring timeout: `server/services/teamCallTicker.ts`, leased (`team_call_ring`),
every 5 s: a `team_call` row still `ringing` past `expires_at` becomes
`missed` (cancel to the rung Android devices, realtime to both, missed alert
to the callee). `GET /:id` does the same for a ring it reads past its end.

Room check: the same ticker, on its own lease (`team_call_room`), every 60 s,
asks LiveKit who is in the room of each `connecting` or `active` call answered
more than 90 s ago. Both members there: nothing ends (a `connecting` one
becomes `active`). A member missing or the room gone: the call ends,
`completed`. LiveKit cannot be asked: nothing changes, except that a call
still `connecting` 5 minutes after the answer ends.

LiveKit webhook (`server/routes/livekitWebhook.ts`) for `team_call` rows:
`room_started` changes nothing; `participant_joined` makes the row `active`
once both members are in; `participant_left` after the answer ends the call
(outcome `completed`); `room_finished` never rewrites an ended row. A
`participant_left` whose `disconnectReason` is `DUPLICATE_IDENTITY` (the same
member reconnected) changes nothing, for every call type.

## iOS

- `UIBackgroundModes`: `audio`, `voip` (both targets). Purpose strings name
  colleagues too.
- PushKit registry created in `AppDelegate.didFinishLaunching`, before any
  scene; the VoIP token is uploaded with the device (`voip_token`), without
  needing notification permission; released on sign-out.
- Every VoIP push is reported to CallKit synchronously, before the
  completion handler returns. One that is not a valid, unexpired colleague
  ring for the signed-in user is reported and ended at once.
- `CallManager` (one, app-wide) owns the CXProvider (video, one call, generic
  handle = call id, recents off, the brand mark as icon), the CXCallController
  for outgoing calls, the polling and the LiveKit room; the call screen is
  drawn above everything from its state, so a call answered on the lock
  screen has a screen when the app opens.
- Cold start from a VoIP push: the session token comes from the Keychain;
  the API works without a scene.
- CallKit owns the audio session: LiveKit's automatic audio-session setup is
  off during a CallKit call and the engine starts on `didActivate`. Voice
  calls use the earpiece (proximity on), video calls the speaker. Voice-note
  recording and playback stop when a call starts.
- Entry: phone and video buttons in the colleague thread's toolbar, shown when
  the plan allows that kind of call.
- The missed-call notification (`team_call_missed`) opens the thread.

## Android

- `IncomingCallRouter` handles `team_call_incoming` and `team_call_cancel`
  besides the call-centre types; the ring is the existing CallStyle
  full-screen notification with the colleague's name and photo (silhouette
  without one).
- Answer → `POST accept` → `POST token` → LiveKit. Decline → `POST decline`
  from the notification, without opening the app.
- Outgoing from the thread's top bar (phone and video), with a ringback tone
  until the answer.
- A foreground service (microphone, and camera for video) with an ongoing
  call notification keeps the call alive with the screen off.
- Without the notification permission (Android 13+) a ring cannot show:
  the thread's call button explains it and opens the setting.
- The missed-call notification opens the thread.

## Rollout

1. Migration `293_team_calls.sql` by hand on WebYar before the merge (App
   Review plan, the App Review seed, and the function `team_call_place()` the
   API places every call with); RESPOK by its migrator.
2. Merge: backends 25 and 32 deploy; nothing rings until an app sends a VoIP
   token or understands the new FCM types.
3. Super Admin → Plans: turn on "Colleague calls" in the plans that should
   have it.
4. iOS 1.0.0 (3) to App Store Connect; Android with its next release.
