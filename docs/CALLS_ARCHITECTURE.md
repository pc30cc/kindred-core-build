# Voice / Video Call Architecture

This document describes the call subsystem at a level sufficient to
debug and review changes. The implementation is **frozen** — see
`docs/CALLS_REGRESSION_CHECKLIST.md`.

## High-level flow

Calls are **operator-initiated only**. The visitor widget can accept,
decline, or hang up — it never starts a call.

```
 Operator UI                Express server               Visitor widget
 ───────────                ──────────────               ──────────────
 click Call ─► POST /api/call-invitations
                  │
                  ├─► persist invitation
                  ├─► realtime fanout ──────────────────► invitation card
                  │
 FloatingOperatorCallWindow              accept ◄─── click Accept
 mounts, connects to LiveKit ◄── POST /api/widget/call-invitations/:id/accept
                                              │
                                              ├─► mint LiveKit token (visitor)
                                              ├─► realtime fanout ──► operator
                                              │
 Both sides connect to the LiveKit room ─────────────────► two-way media

 Hang up (either side) ─► POST /api/calls/:id/end
                              │
                              ├─► LiveKit room close
                              ├─► realtime call-end fanout
                              └─► insert call-summary system message
```

## Operator call flow

- `OperatorCallContext` (`src/features/calls/OperatorCallContext.tsx`)
  owns the active-call state machine for a workspace tab.
- `FloatingOperatorCallWindow` is the single UI surface for an
  in-progress call. It hosts:
  - `VideoCallStage` for video calls
  - `AudioCallStage` for audio-only calls
  - `LocalVideoPiP` for the operator's own preview
- `useLiveKitCall` (`src/hooks/useLiveKitCall.ts`) wraps the LiveKit
  client: connect, publish, subscribe, mute, hangup, and remote
  participant snapshot.
- Hangup paths (operator clicks, network drop, LiveKit
  disconnected event) all funnel through the same end-call API so
  the visitor and the system message stay consistent.

## Widget runtime call flow

`public/widget/runtime.js`:

- Subscribes to the workspace's call-invitation realtime channel.
- Renders `renderCallInvitationCard` when an invitation arrives.
- On Accept, fetches a visitor LiveKit token and mounts the call
  surface (`callSurfaceStore` + `renderCallSurface`).
- The dedicated player runtime lives in
  `public/widget/runtime-call.js` and handles LiveKit attach /
  detach, mute, hangup, and reconnect for the visitor.
- `tabDefs` only contains `chat` and `help`. **No `voice` or
  `video` tab.** Visitor-initiated call code has been removed.

## LiveKit env requirements

Required server env (see `.env.livekit.example`):

- `LIVEKIT_URL` — wss URL of the LiveKit deployment
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `LIVEKIT_WEBHOOK_KEY` (optional but recommended) — for
  `server/routes/livekitWebhook.ts`

The frontend never sees the API key/secret. Tokens are minted
server-side and returned only to the authenticated operator or to
the verified widget visitor for an active invitation.

## Video orientation

Centralized in `src/features/calls/videoOrientation.ts`:

- `CALL_VIDEO_ORIENTATION_CORRECTION_MODE` — single source of truth
  for the transform applied to local previews.
- `applyVideoOrientationClass(el, role, prefix)` — detects portrait
  / landscape / square from `videoWidth`/`videoHeight` and tags both
  the `<video>` element and its closest stage wrapper, so CSS can
  layout the blurred backdrop fill behind portrait remote video on
  a landscape stage.
- `LocalVideoPiP` mirrors the operator's own preview (the standard
  selfie convention). Remote video is **not** mirrored.

## Diagnostic logging

Two independent flags, both off in production:

| Flag | URL param | localStorage key | Scope |
|------|-----------|------------------|-------|
| Call signaling | `?callDebug=1` | `call_debug` | `[call:*]` |
| Video orientation | `?callOrientationDebug=1` | `call_orientation_debug` | `[call-ui]` |

Helpers: `callDebug` / `callWarn` in
`src/features/calls/callDebug.ts`. Warnings always print regardless
of the flag — they indicate degraded media or signaling.

## Known browser limitations

### iOS Safari (and all iOS browsers, including Chrome on iOS)

- All browsers on iOS use WebKit. Bugs and limitations apply
  uniformly.
- **Autoplay with sound** requires a user gesture. The Accept
  button itself counts as the gesture; do not defer track attach
  to a later async tick.
- **Background tab** suspends WebRTC after ~30s. The freeze
  watchdog will reattach when the tab returns to the foreground.
- **Camera switching** sometimes briefly drops the published
  track. The visitor widget reuses LiveKit's `replaceTrack` path
  to minimize this; remote sees a ~200–500ms freeze.
- **PiP / Picture-in-Picture** is not supported for getUserMedia
  streams on iOS Safari.
- **Low-power mode** can throttle frame rate to ~15fps. This is
  expected and not a bug.

### Desktop Safari

- Same autoplay-with-sound rule as iOS.
- `getUserMedia` requires HTTPS (or `localhost` for dev).

### Firefox

- Echo cancellation in audio-only calls can be more aggressive than
  Chrome; if the visitor reports being cut off, check
  `audio: { echoCancellation: true, noiseSuppression: true }` is
  set (it is, by default in `useLocalMediaPreview`).

### All browsers

- HTTPS is required for `getUserMedia` outside of `localhost`.
- A device with no camera will succeed for audio-only calls and
  fail with `NotFoundError` for video — surfaced to the user as a
  toast, not a silent black screen.

## Do not change without re-running the checklist

- LiveKit attach / detach pattern in `CallStage.tsx`
- Hangup propagation path (server end-call → realtime → both UIs)
- Call summary system message insertion
- Orientation helper signatures
- Debug-flag names
- Removal of visitor-initiated call tabs