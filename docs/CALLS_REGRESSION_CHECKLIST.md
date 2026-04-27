# Voice / Video Call Regression Checklist

**Status:** Frozen baseline — do not refactor call signaling, LiveKit
attach/detach, the widget call runtime, video orientation handling,
hangup propagation, or call-ended summaries unless fixing a verified
bug filed against this checklist.

Scope of the freeze:

- `src/features/calls/FloatingOperatorCallWindow.tsx`
- `src/features/calls/OperatorCallContext.tsx`
- `src/features/calls/CallStage.tsx`
- `src/features/calls/videoOrientation.ts`
- `src/features/calls/callDebug.ts`
- `src/hooks/useLiveKitCall.ts`
- `src/hooks/useLocalMediaPreview.ts`
- `public/widget/runtime.js` (operator-call invitation + surface only)
- `public/widget/runtime-call.js`
- `server/routes/callInvitations.ts`
- `server/routes/widgetCallInvitations.ts`
- `server/routes/calls.ts`
- `server/routes/callQueue.ts`
- `server/routes/callAvailability.ts`
- `server/routes/livekitWebhook.ts`
- `server/services/calls/**`

Run the full checklist before shipping any change touching the files
above, even if the change looks unrelated.

---

## Enabling debug logs

Off by default in production. Enable per tab — no rebuild required.

### Operator (browser)

```js
localStorage.setItem('call_debug', '1');            // call signaling
localStorage.setItem('call_orientation_debug', '1'); // orientation/transform
// or per URL:
//   ?callDebug=1
//   ?callOrientationDebug=1
```

Logs are namespaced `[call:<scope>]` and `[call-ui]`. They never include
LiveKit tokens, JWTs, or room secrets — only IDs, role names, and event
types.

### Visitor widget (browser)

```js
localStorage.setItem('gs:debug', '1');
```

Reuses the widget runtime debug flag (see
`docs/REALTIME_REGRESSION_CHECKLIST.md`).

### Server (Node)

Set `RT_DEBUG=1` for realtime fanout. LiveKit webhook events log at
`info` regardless.

Disable any flag with `localStorage.removeItem(...)` or by removing
the URL parameter.

---

## Regression scenarios (all must pass)

For each scenario capture the operator console, the visitor console,
and the relevant server log.

### 1. Operator starts video call

- **Setup:** operator open on a conversation; visitor widget open on
  the same conversation; both with healthy realtime.
- **Action:** operator clicks the video-call action in the inbox.
- **Expected operator:** floating call window mounts, local camera
  preview appears, status reads "Ringing…".
- **Expected visitor:** call invitation card appears in the widget
  with Accept / Decline buttons and the correct localized headline.
- **Expected:** no raw i18n keys (no `ciHeadline*`, `csControl*`
  literals visible).

### 2. Visitor joins video call

- **Action:** visitor accepts the invitation.
- **Expected:** both sides transition to the in-call surface within
  ~2s; remote video tile appears on each side; audio levels register
  on both ends.
- **Expected:** operator FloatingOperatorCallWindow shows duration
  ticking from 00:00.

### 3. Two-way media

- **Action:** speak on both sides; wave hand in front of each camera.
- **Expected:** each side hears the other (no echo, no one-way).
- **Expected:** each side sees the other's video without freezing for
  more than ~3s (the 1Hz freeze watchdog in `CallStage.tsx` re-attaches
  on stagnation).

### 4. Mobile portrait camera (visitor)

- **Setup:** visitor on a real iOS or Android phone in portrait.
- **Action:** start the call with the front camera.
- **Expected operator:** visitor tile renders **portrait** inside the
  call surface — no black side bars cropping it to landscape, no
  squished aspect.
- **Expected:** floating operator call window adapts: controls,
  duration, and labels stay legible at the portrait size.

### 5. Visitor rear camera switch

- **Action:** visitor taps the camera-flip control to switch to the
  rear camera mid-call.
- **Expected:** operator continues to receive video without the call
  dropping; orientation reapplies (front camera is mirrored, rear is
  not, per the SDK).
- **Expected:** local visitor preview also flips correctly.

### 6. Desktop visitor landscape

- **Setup:** visitor on a desktop browser with a webcam.
- **Expected operator:** visitor tile renders **landscape**, fills the
  stage with `object-contain` plus the blurred backdrop fill — no
  letterbox-on-letterbox.

### 7. Operator ends call → visitor exits

- **Action:** operator clicks Hang Up.
- **Expected operator:** floating window closes; inbox returns to
  normal.
- **Expected visitor:** call surface unmounts within ~1s; widget
  returns to chat with the call-ended system message in the timeline.

### 8. Visitor ends call → operator exits

- **Action:** visitor clicks Hang Up.
- **Expected operator:** FloatingOperatorCallWindow unmounts within
  ~1s; inbox shows the call-ended system message.
- **Expected visitor:** widget returns to chat with the same system
  message.

### 9. Audio-only call

- **Action:** operator starts an audio-only call; visitor accepts.
- **Expected:** both sides show the `AudioCallStage` orb + animated
  EQ bars — never the black `VideoCallStage` background.
- **Expected:** mute / unmute works on both sides; no video tracks
  are published or requested.

### 10. Call summary system message

- **After every successful call (scenarios 7–9):** the chat timeline
  contains a system message summarizing the call: type (audio /
  video), duration, who ended it. Localized in fa, en, tr.
- **No raw keys:** never `callEndedSummary`, `callDurationLabel`,
  etc., visible in the UI.

### 11. No raw i18n keys anywhere

- **Action:** sweep all call surfaces (invitation card, in-call
  controls, ended summary, error toasts) in fa / en / tr.
- **Expected:** every visible string is translated. If a key falls
  through, file a bug — do not paper over it with a hardcoded
  fallback.

---

## Known invariants (do not break)

1. **Visitor widget never initiates a call.** Only operators start
   calls. The widget exposes Accept / Decline / Hang-Up only.
2. **Track attach/detach uses `track.attach(el)` / `track.detach(el)`.**
   Never assign `el.srcObject` manually for LiveKit tracks (breaks the
   freeze watchdog and the audio path).
3. **Audio uses a separate `<audio>` element per remote.** Video mute
   or stall must not tear down audio.
4. **Freeze watchdog runs at 1Hz.** On `currentTime` stagnation for
   ≥3s with a live `MediaStreamTrack`, detach + reattach. Never
   reconnect the room.
5. **Orientation correction is centralized** in
   `videoOrientation.ts` (`CALL_VIDEO_ORIENTATION_CORRECTION_MODE`,
   `applyVideoOrientationClass`). Do not inline transforms.
6. **Hangup propagates via the realtime call-end channel**, not via
   chat messages. The chat system message is a side effect, not the
   trigger.
7. **Debug logs are gated.** `[call-ui]` orientation logs and
   `[call:*]` signaling logs only print when their flag is set.

---

## When a scenario fails

1. Enable the relevant debug flag(s) on the affected side.
2. Reproduce and capture the full console + server logs.
3. Identify which invariant above is violated.
4. Fix the root cause in the smallest possible diff. Do NOT widen
   the call FSM, do NOT re-introduce visitor-initiated calls, and do
   NOT bypass the orientation helper.
5. Re-run the entire checklist — not just the failing scenario.
6. Update this document if the fix introduces a new invariant worth
   protecting.