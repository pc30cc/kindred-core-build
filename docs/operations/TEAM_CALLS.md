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
- the iOS and Android apps, and the web panel (owner, 2026-11-02: "the web
  too, on and off by the plan the same way"); the desktop apps neither ring
  nor call yet;
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
  the answer). Checked on create, like `/api/calls/create`, and the
  concurrency counted again inside the placement under a lock per workspace
  (`team_call_place()` with `p_max_concurrent`, migration 298), so two pairs
  placing at limit − 1 never both get through.
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
| `POST /` `{workspace_id, callee_id, channel}` | a member | Checks membership, plan, limits, busy; creates the row and the room; rings the callee; `201 {call}`. Errors: `400 invalid_params`, `403 upgrade_required` (`feature: 'team_calls'`), `403 not_a_member` (also when a pair hides the two from each other: `server/services/teamVisibility.ts`, migration 295), `409 callee_busy`, `409 caller_busy`, `429 too_many_calls`, `422 limit_reached` (`limit: 'max_concurrent_calls' | 'max_call_minutes_per_month'`). Rate limit: a caller rings at most 10 times a minute, a callee is rung at most 6 times a minute (by everyone together; an attempt that does not ring — busy, a failure — gives its ring back). The concurrency ceiling is read before the placement, as `/api/calls/create` reads it, and again inside it under the workspace's lock (migration 298): a placement that finds the limit met answers the same `422 limit_reached` (`limit: 'max_concurrent_calls'`, `reason: 'plan_limit_reached'`, `max`, `used`) with nothing written. |
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
member reconnected) changes nothing, for every call type. A room that starts
again, or is joined, after its call is over (LiveKit makes a room on a join
with a token that has not expired) is closed at once, so a kept token buys no
uncounted time.

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
- Ring state (owner, 2026-11-04): the callee's phone sends `POST /:id/rang`
  (`{device_id, platform: "ios"}`) once per call when CallKit accepts the
  report of the ring, never before or instead of that report; retried twice,
  3 s apart; `409`, `404` and `405` are ignored. The caller's screen says
  "Calling…" with no ringback until the call's `rang_at` is set (poll or
  realtime), then "Ringing…" with the ringback (the web's two-tone pattern,
  made in memory, `TeamCallRingback`). CallKit: started connecting at the
  start action, connected only when both are in the room.
- Busy with a visitor call: a colleague's VoIP ring is reported to CallKit
  and ended at once, and never touches the audio or sends `rang`, while this
  phone is in a visitor call. In the visitor's room (connecting or connected)
  it is also declined on the server (`POST /decline`), so the call ends
  `declined` for the caller and the member's other phones. While only
  inviting a visitor (the request, or an invitation not yet expired) it ends
  on this phone alone, and the other phones may still answer. A visitor
  screen left behind by suspension (an expired invitation, an ended call) is
  not busy (`VisitorCallScreens.busy`).
- Signing out with a colleague call on (reachable once it is minimised) ends
  it with the server told first, within 5 s, a call still being placed
  included. Deleting the account ends it on the server
  (`endTeamCallsOfMember` in `DELETE /api/account`, after the password and
  owner checks and before the sessions are revoked), for every client.
- The call screens (colleague and visitor) are opaque (`CallBackdrop`: black,
  the brand's deep tone, the caller's photo blurred), never the app behind.
- Minimise: the chevron shrinks the call's window to a draggable floating view
  (`TeamCallBubble`) so the rest of the app works; a tap, PiP's return or the
  app's return from the background opens the call full again.
- Picture-in-picture on a video call (colleague or visitor): the remote video
  in iOS's video-call PiP (`CallPictureInPicture`, LiveKit's `VideoView` in
  sample-buffer mode), started automatically when the app goes to the
  background. The member's own camera pauses in the background until the app
  holds Apple's `com.apple.developer.avfoundation.multitasking-camera-access`
  entitlement (not requested yet); with it, `CallCamera` turns multitasking on
  by itself.

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

## Web panel (owner, 2026-11-02)

- Same gate as the apps (`team_calls` + `voice_video` + the call's channel,
  `src/lib/planAccess.ts`'s one rule) and the same API; nothing new on the
  server for it but what is listed here.
- Entry: phone and video buttons in the colleague thread's header on the
  team chat page (`src/pages/app/TeamChatPage.tsx`), shown when the plan
  allows that kind of call, never for oneself.
- Ringing: every open panel tab of the callee rings, wherever the member is
  in the panel, from the realtime `team_call` event (`state: ringing`, the
  callee's own user channel), confirmed with `GET /api/team-calls/:id`. A
  ringing card above everything (the colleague's photo or the person
  silhouette, never a letter; their name; voice or video; Answer, Decline),
  a ringtone made in the page (Web Audio, no file), and a system
  notification through the Notification API when the tab is hidden and the
  member has allowed notifications (asked once, from the call button, never
  on page load). No web push: a closed panel does not ring; the phones do.
- Every tab has its own device id (`web-<random>`, kept in sessionStorage),
  sent as `device_id` on accept. The first answer wins on every surface:
  a tab, an iPhone or an Android phone; the others stop on the next
  realtime change (`state` past `ringing`, `answered_device_id` not theirs).
- The call: `POST /:id/token`, then LiveKit through the panel's existing
  call stack (`src/hooks/useLiveKitCall.ts`, `src/features/calls/CallStage.tsx`),
  microphone (and camera for video, answerable with it off), mute, camera,
  speaker selection where the browser has it, hang up. Ringback for the
  caller until the answer. A tab's call screen stays above the panel as the
  member moves around in it; closing the tab ends the call through the
  webhook.
- Ending follows the apps' rule: the caller hangs up (`/hangup`); the callee
  declines while it rings and hangs up once its answer went through.
- Missed: a toast in the open tabs (the push is the phones').
- Busy: a member in a visitor call in the panel is busy (the existing
  `operator_call_availability` rule).

## The call in the chat (owner, 2026-11-02)

Owner: "why isn't it recorded in the chat when a call is made or ended, or a
missed call?" Every colleague call leaves one line in the two members' team
chat, as WhatsApp does, on every surface (iPhone, Android, web panel).

### Server

- Migration `294_team_call_chat_records.sql`: `team_messages.call_session_id
  uuid NULL REFERENCES call_sessions(id) ON DELETE SET NULL`, with
  `UNIQUE (call_session_id)` (NULLs stay many), so one call has at most one
  line. It writes no data. No backfill: calls before it leave no line.
- Written once, by the server, when the call reaches its end (state no longer
  in `TEAM_CALL_LIVE_STATES`), from `announceTeamCall`
  (`server/services/calls/teamCallLifecycle.ts`), whichever path ended it
  (decline, cancel, hang-up, the ticker's missed, the webhook, a failure).
  The insert is idempotent (the unique key: a second attempt does nothing),
  best-effort, and never fails or delays the move. A missing column (the
  migration not applied) only logs.
- The row: `workspace_id` the call's, `sender_id` the caller,
  `recipient_id` the callee, `created_at` the call's `created_at` (it sits
  where the call rang, as WhatsApp places it), `attachment_id`/`reply_to_id`
  null, `body` a language-neutral fallback for apps that predate it: `📞` (voice)
  or `📹` (video), followed by ` m:ss` (or ` h:mm:ss`) for a completed call.
  `read_at`: null (unread for the callee, counted in their badge) for
  `missed` and `cancelled`; now for `completed`, `declined` and `failed`.
- After the insert: realtime `team_message` to both (the same envelope as a
  sent message: `{kind:'team_message', workspace_id, message_id, sender_id,
  recipient_id}`), so open threads and lists refresh. No team-message push:
  the missed call already has its own notification.
- API: every message of `GET /api/team-chat/thread` carries `call`: null, or
  `{ id, channel: 'audio'|'video', outcome:
  'completed'|'missed'|'declined'|'cancelled'|'failed', duration_seconds:
  number|null (ended_at − connected_at, completed only), caller_id }`;
  `last_message` of `GET /api/team-chat/colleagues` carries the same `call`
  (or null). Messages without a call are unchanged.
- Server details (`server/services/calls/teamCallChat.ts`): `call` is shown
  only for a call of that workspace, over, whose caller sent the line to its
  callee (anything else, or a call row deleted since, reads `call: null` and
  keeps its body); `call_session_id` itself never leaves the server. `POST
  /api/team-chat/messages` cannot set it (only the server writes a call's
  line), and the message it answers with carries `call: null`. Without
  migration 294 both reads fall back to the columns they had (every `call`
  null). The missed-call alert leaves after the line is written (not after its
  realtime nudge), so its badge counts it.

### The apps and the panel

- In the thread the line is a call bubble on the caller's side (the caller's
  own, outgoing; the callee's, incoming): the phone or video-camera icon, an
  arrow (out ↗ for the caller, in ↙ for the callee), the title, and the time
  with the duration for a completed call. Missed (and cancelled, for the
  callee) is drawn in the danger colour. It cannot be replied to, quoted,
  copied or forwarded. Its time is inside it, so it stands on its own: the
  apps end a run of bubbles at it, and the message just before it keeps its
  time underneath (the web panel times every bubble).
- Titles, by who is looking:

  | outcome | caller sees | callee sees |
  |---|---|---|
  | completed | `teamCallLogVoice`/`Video` + duration | the same |
  | missed | `teamCallLogNoAnswer` | `teamCallLogMissedVoice`/`Video` |
  | cancelled | `teamCallLogCancelled` | `teamCallLogMissedVoice`/`Video` |
  | declined | `teamCallLogDeclined` | `teamCallLogDeclined` |
  | failed | `teamCallLogFailed` | `teamCallLogFailed` |

- Tapping the bubble calls back with the same channel when the plan allows
  colleague calls (the same gate as the thread's call buttons, and not while
  another call is on); otherwise it does nothing. Its accessibility label is
  the title, the direction and the time, and its action `teamCallLogCallBack`.
  The direction is read out as `teamCallLogOutgoing` (the caller) or
  `teamCallLogIncoming` (the callee); the arrow is mirrored in a
  right-to-left language.
- The colleagues list previews a call line by its icon and title (from
  `last_message.call`), not its body.
- Strings (iOS `Strings.swift` fa/en/tr/ar and so Android's generated
  `Strings.kt`; the web's `src/i18n/locales/{en,fa,tr}.ts` as
  `teamCalls.log.*`):

  | Name | fa | en | tr | ar |
  |---|---|---|---|---|
  | `teamCallLogVoice` | تماس صوتی | Voice call | Sesli arama | مكالمة صوتية |
  | `teamCallLogVideo` | تماس تصویری | Video call | Görüntülü arama | مكالمة فيديو |
  | `teamCallLogMissedVoice` | تماس صوتی بی‌پاسخ | Missed voice call | Cevapsız sesli arama | مكالمة صوتية فائتة |
  | `teamCallLogMissedVideo` | تماس تصویری بی‌پاسخ | Missed video call | Cevapsız görüntülü arama | مكالمة فيديو فائتة |
  | `teamCallLogNoAnswer` | بی‌پاسخ | No answer | Cevap yok | لا رد |
  | `teamCallLogDeclined` | رد شد | Declined | Reddedildi | مرفوضة |
  | `teamCallLogCancelled` | لغو شد | Cancelled | İptal edildi | ملغاة |
  | `teamCallLogFailed` | تماس برقرار نشد | Call failed | Arama başarısız | تعذّر الاتصال |
  | `teamCallLogCallBack` | تماس دوباره | Call back | Geri ara | معاودة الاتصال |
  | `teamCallLogOutgoing` | خروجی | Outgoing | Giden | صادرة |
  | `teamCallLogIncoming` | ورودی | Incoming | Gelen | واردة |

## Media budget (2026-11-03)

What the camera sends on a call, the same numbers on iOS and Android. They
apply to every call each app makes or answers, colleague calls and visitor
(call-centre) calls alike: each app sets them as its rooms' defaults, in one
place (Android `CallVideoEncoding.kt`, given to the one room `LiveKitRoom.kt`
builds; iOS `CallMediaBudget.swift`, given to `CallSession`'s room and
`TeamCallRoom`'s). The camera is published with those defaults, never with
options of its own.

| | Size | Max bitrate (bps) | Max frame rate (fps) |
|---|---|---|---|
| Capture, front camera (as before) | 1280×720 | | 30 |
| Top layer, the track's own encoding | 1280×720 | 1 000 000 | 24 |
| Simulcast, middle layer | 640×360 | 400 000 | 20 |
| Simulcast, low layer | 320×180 | 120 000 | 15 |

Each is a ceiling, in LiveKit's units (bits and frames per second): at most
1.52 Mbps up with every layer sending, against about 2.3 Mbps at LiveKit's
defaults for a 720p camera, and a receiver drawing the picture full screen
takes the top layer alone (1 Mbps instead of 1.7). Simulcast, adaptive stream
and dynacast stay on, so a layer nobody takes is not sent. The codec is as
before: VP8 on Android, named in the code; the iOS app names none, as it never
did. Audio is unchanged. The web panel and the website widgets keep their own
settings (`src/lib/livekit-tuning.ts` and the widgets' copy of it); this does
not change them.

Why: measured on the production server on 2026-11-03, colleague video calls
between an iPhone in Turkey and an Android phone (Xiaomi, Android 16,
LiveKit Android SDK 2.29.0) on Iranian mobile data (MCI). The phone uploaded
about 2.3-2.4 Mbps, all three VP8 layers at LiveKit's defaults for a
1280×720 capture (320×180 at 160 kbps, 640×360 at 450 kbps, 1280×720 at
1.7 Mbps), although the other side shows one picture, and downloaded about
1.8-2 Mbps (the iPhone's 720p layer at 1.7 Mbps). About 4 Mbps through an
Iranian mobile link to a foreign server clogged it: the phone's packets
arrived 6 s and more late, the signalling WebSocket timed out (ping timeout),
the media's ICE dropped (`PEER_CONNECTION_DISCONNECTED`) and the call ended.
Voice calls, and the first, slower seconds of a video call, were fine.

- Android: LiveKit Android SDK 2.29.2 (`android/gradle/libs.versions.toml`)
  for the dynacast fix: in 2.29.0 a layer dynacast had paused started
  uploading again after any renegotiation, and a call renegotiates when the
  camera is published after the microphone; 2.29.2 keeps it paused. 2.29.1,
  included, seeds the bandwidth estimate (`x-google-start-bitrate`), so the
  picture is sharp in the first seconds instead of ramping up from about
  300 kbps. The numbers go in as the room's `videoTrackCaptureDefaults` and
  `videoTrackPublishDefaults`, because `setCameraEnabled` takes no options.
- iOS: the rooms' `defaultCameraCaptureOptions` and
  `defaultVideoPublishOptions`, read against client-sdk-swift 2.17.0 (the
  same in 2.19.0). The package's minimum is 2.19.0 (`ios/Webyar/project.yml`),
  which has the same dynacast fix as Android's 2.29.2, and 2.18.0's faster
  start; CI already resolved it, the minimum keeps a Mac's older package cache
  from building 2.17.0. Build 1.0.0 (5) carries it.
- Guards: `src/test/native/callMediaBudget.android.test.ts` and
  `src/test/native/callMediaBudget.ios.test.ts` hold the sources to these
  numbers and to the one place each app builds a room;
  `CallVideoEncodingTest.kt` checks them on the SDK's own types (CI's
  `android.yml`). Change the numbers in both apps, the tests and this table
  together.

## The Iran relay (owner, 2026-11-04)

On 2026-11-04 Iranian mobile data passed a call's signalling (through
Cloudflare) but no media to LiveKit abroad, its own TURN included. WebYar's
calls from Iran now carry their media through a coturn relay on a server
inside Iran, which forwards only to LiveKit. WebYar only: RESPOK's settings
list no relay. Server, firewall, probe and changes:
`deploy/iran-relay/README.md`.

- `POST /:id/token` answers `turn` with the relay's URLs and a credential of
  its own only when the caller's country (as Cloudflare saw it) is in the
  relay countries of Super Admin → Voice & Video → Channels and recording →
  RTC and TURN endpoints (WebYar: `IR`). Anyone else gets `turn.urls` empty,
  and `network.turn` says the same. The apps hand a non-empty `turn.urls` to
  LiveKit as the ICE servers, which replaces LiveKit's own (its TURN among
  them), and leave LiveKit's alone for an empty list: so a caller abroad
  keeps LiveKit's TURN, and the apps need no change.
- The credential: username `<expiry>:r<16 random hex>` (nothing about the
  call or the member), password the base64 HMAC-SHA1 of it under the relay's
  shared secret (`server/services/calls/turnAuth.ts`). It is valid for the
  page's credential lifetime, 6 hours by default (10 minutes to 24 hours),
  not for the LiveKit token's 10 minutes: the apps keep a call's ICE servers
  for the whole call and reuse them on every reconnect, and the relay refuses
  a new allocation once the username's expiry has passed. With the token's
  10 minutes, a call that changed network after that lost the relay.
- ICE still picks the path (`ice_policy` `all`): a phone that reaches LiveKit
  directly is not relayed. Signalling is unchanged (`ws_url`
  `wss://rt.webyar.ai`).

## Rollout

1. Migration `293_team_calls.sql` by hand on WebYar before the merge (App
   Review plan, the App Review seed, and the function `team_call_place()` the
   API places every call with); RESPOK by its migrator.
2. Merge: backends 25 and 32 deploy; nothing rings until an app sends a VoIP
   token or understands the new FCM types.
3. Super Admin → Plans: turn on "Colleague calls" in the plans that should
   have it.
4. iOS 1.0.0 (3) to App Store Connect; Android with its next release.
5. The call in the chat: migration `294_team_call_chat_records.sql` by hand
   on WebYar before its merge (a dry run inside `BEGIN … ROLLBACK` first);
   RESPOK by its migrator. Then the merge: the backends write the lines and
   the panel draws them; the apps with their next builds.
6. The media budget: nothing on the server. iOS with build 1.0.0 (5);
   Android with its next release (`versionCode` above 28, see
   `docs/ANDROID_RELEASE.md`). A call between an updated app and an older one
   is still lighter: the updated side sends less, so the other receives less.
7. The Iran relay: nothing in the apps. After the merge's backend (25) is
   live, the relay countries `IR` in Super Admin and a save (the steps are
   `deploy/iran-relay/README.md`, "Rollout").
8. The call state guards (audit 2026-11-04): migration
   `298_call_state_guards.sql` by hand on WebYar before the merge (its index
   built `CONCURRENTLY` first, as its header says; a dry run inside
   `BEGIN … ROLLBACK`); RESPOK by its migrator. It adds the nine-argument
   `team_call_place()` the API now calls (293's stays for the backend that
   runs until the merge) and the trigger that keeps an over call over. No app
   change: the answers are the ones this table lists.
