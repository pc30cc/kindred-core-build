# Native Push Notifications (iOS / Android)

Webyar's push stack is **self-hosted**: all logic runs in the project's own
Express backend (`server/services/push/*`). No Supabase Edge Function is used.
The delivery transport is Firebase Cloud Messaging for the Android app and
Apple's push service (APNs) directly for the native iOS app
(`server/services/push/apns.ts`); each device row says which (`transport`).

```
message committed → notifyInboundMessage() → recipient resolver (prefs, roles,
assignment, actor exclusion) → mobile_push_devices → FCM v1 | APNs → device
```

A colleague's direct message in team chat takes the same road from its own
door: `POST /api/team-chat/messages` → `notifyTeamMessage()` → the recipient's
own preferences (scope `none` and "disable all" silence it; quiet hours give way
as for a mention) → their devices. Its `data` carries `type: team_message` and
`peerId` (the colleague) instead of a `conversationId`; the apps open that
colleague's thread on a tap.

What else reaches an operator's phone, each under the same per-operator
settings and in the operator's language:

| Event | Sent from | `type` | Who |
|---|---|---|---|
| Customer message (widget, bot channels, widget "leave a message") | `notifyInboundMessage` | `new_message` | assignee, or everyone following all conversations |
| Internal note | `POST /api/conversations/:id/notes` | `internal_note` | the same people, never the author |
| Conversation assigned (by a colleague, or by routing) | `notifyAssignment` | `assignment` | the new assignee |
| New email (Gmail / Yahoo, received in the last 15 minutes) | `notifyEmailMessage` | `email_message` + `threadId` | everyone following everything |
| Callback request | `notifyCallbackRequest` | `callback_request` + `callbackId` | everyone following everything |
| Call-centre call | `ringOperators` / `cancelRing` | `call_incoming` / `call_cancel` (Android, data-only) | the agent routed to, or every available agent |

A call rings iPhones over PushKit and Android phones with a data-only,
high-priority FCM message: the app draws a full-screen incoming call with
Answer and Decline. Answer takes the call through
`POST /api/call-center/calls/:id/accept`; Decline only silences that phone —
the call centre's own reject would hang up on the caller for everyone. A ring
that stops with nobody having answered it leaves a missed-call notification.

Delivery is best-effort and idempotent (`push_dispatch_log.dedupe_key`); a push
failure can never fail or roll back message ingestion.

## 1. Apple Developer (once)

1. Certificates, Identifiers & Profiles → **Identifiers** → the app id
   `com.webyar.ai` → enable **Push Notifications**.
2. **Keys** → create an **APNs Auth Key (.p8)**. Note the *Key ID* and your
   *Team ID*, and download the `.p8` (Apple lets you download it once).
3. The app already declares the capability: `aps-environment` under
   `entitlements` in `ios/Webyar/project.yml`. It deliberately has no
   *Remote notifications* background mode: it sends no silent pushes.

## 2. Firebase Console (once)

Firebase serves the Android app only; the iOS app has no Firebase
configuration file.

1. Project settings → **Service accounts** → *Generate new private key* → this
   JSON is the **server** credential (never ships in the app).
2. Android: **Add app → Android**, package `com.webyar.ai`. Download its
   `google-services.json` and read it into **Super Admin → Mobile App →
   Android → Identity → Push notifications (Firebase)** ("Read
   google-services.json"), then save. Installed apps read the four values from
   `GET /api/mobile-app/config` (`firebase`), keep them and start Firebase with
   them — no new build, and nothing is placed in `android/app/`. A build made
   with `WEBYAR_FIREBASE_*` keeps its own project instead (see
   `docs/ANDROID_RELEASE.md`).

## 3. Server environment

Set on the Express backend only (never in the frontend bundle, the database or
logs):

```
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account", ... }
# or, equivalently:
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

and, for the iOS app:

```
APNS_KEY_ID=...
APNS_TEAM_ID=...
APNS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
APNS_BUNDLE_ID=com.webyar.ai
# APNS_ENVIRONMENT=sandbox only for builds run straight from Xcode
```

That is WebYar's backend. RESPOK's backend (the International edition) serves
the RESPOK app, the `Respok` target of `ios/Webyar` with its own bundle id, so
it needs `APNS_BUNDLE_ID=com.respok.app` (and `APNS_NATIVE_BUNDLE_ID`, where
set, the same). A value copied from WebYar's makes Apple refuse every RESPOK
push (`DeviceTokenNotForTopic`). The same `.p8` key works for both apps only
while both are under the same Apple team.

If neither transport is configured, dispatch turns into a no-op — the rest of
the product is unaffected. Super Admin → Mobile app → Overview shows whether
the server holds each key.

## 4. Build the app

```bash
cd ios/Webyar
xcodegen generate        # the Xcode project is generated from project.yml
open Webyar.xcodeproj   # scheme Webyar or Respok; run on a physical device
```

Push does **not** work in the iOS Simulator; use a real device.

## Endpoints (first-party session auth)

| Method | Path                            | Purpose                              |
| ------ | ------------------------------- | ------------------------------------ |
| POST   | `/api/push/devices`             | register / rotate this device's token |
| POST   | `/api/push/devices/unregister`  | sign-out, disable this device         |
| POST   | `/api/push/devices/heartbeat`   | liveness for stale-device cleanup     |
| GET    | `/api/push/badge`               | server-authoritative unread badge     |

## Where an operator changes this

Everything below that is POLICY rather than a credential is editable in
**Super Admin → Notifications**: the defaults for new operators, quiet hours,
the APNs delivery semantics (priority, expiry, interruption level, grouping,
badge, sound), the notification categories and their action buttons, and the
per-event copy in each language. There is also a device-fleet summary, a real
test send to your own devices, and the delivery log.

The Apple-facing side of the app — bundle id, team, capabilities, privacy
strings and every App Store requirement — lives in **Super Admin → Mobile app**.
See `docs/IOS_APP_AND_NOTIFICATIONS.md` for how those settings reach the Xcode
project.

Credentials are deliberately NOT editable there: the FCM service account and
the APNs key are read from the server environment only.

## Behaviour

- Permission is requested on the first authenticated app launch; a denial is
  stored and never re-prompted in a loop.
- Tap routing carries `workspaceId` / `conversationId` as **hints only** — the
  conversation loads through the normal authorized API, which re-checks access.
- `push_scope` (`all | assigned | mentions | none`), `push_preview` and quiet
  hours are enforced **server-side** in the recipient resolver, so a device can
  never opt itself into notifications it should not see. Quiet hours use
  `quiet_hours_enabled/start/end/timezone` on `user_notification_prefs`, support
  windows that wrap past midnight, and are bypassed only by a direct @mention;
  an unparsable window or timezone never mutes.
- `aps.badge` in the payload sets the app icon badge on arrival, and
  `GET /api/push/badge` reconciles it after a read on any device
  (`ios/Webyar/Sources/Core/Push/PushController.swift`).
- `UNREGISTERED` / invalid-token responses disable the device row instead of
  retrying, keeping the token table clean.
