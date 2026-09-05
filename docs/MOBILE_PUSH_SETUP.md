# Native Push Notifications (iOS / Android)

Webyar's push stack is **self-hosted**: all logic runs in the project's own
Express backend (`server/services/push/*`). No Supabase Edge Function is used.
Firebase Cloud Messaging is only the delivery transport (FCM → APNs on iOS).

```
message committed → notifyInboundMessage() → recipient resolver (prefs, roles,
assignment, actor exclusion) → mobile_push_devices → FCM v1 → APNs → device
```

Delivery is best-effort and idempotent (`push_dispatch_log.dedupe_key`); a push
failure can never fail or roll back message ingestion.

## 1. Apple Developer (once)

1. Certificates, Identifiers & Profiles → **Identifiers** → the app id
   `com.webyar.app` → enable **Push Notifications**.
2. **Keys** → create an **APNs Auth Key (.p8)**. Note the *Key ID* and your
   *Team ID*, and download the `.p8` (Apple lets you download it once).
3. In Xcode → target **App** → *Signing & Capabilities* → add
   **Push Notifications** and **Background Modes → Remote notifications**.

## 2. Firebase Console (once)

1. Create/open the Firebase project → **Add app → iOS**, bundle id
   `com.webyar.app`. Download **`GoogleService-Info.plist`** and place it at
   `ios/App/App/GoogleService-Info.plist` (added to the Xcode target).
2. Project settings → **Cloud Messaging** → *Apple app configuration* → upload
   the `.p8` APNs key with its Key ID and Team ID.
3. Project settings → **Service accounts** → *Generate new private key* → this
   JSON is the **server** credential (never ships in the app).
4. Android (when shipped): add the Android app, place `google-services.json` in
   `android/app/`.

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

If none are set, `isPushConfigured()` is false and dispatch turns into a no-op —
the rest of the product is unaffected.

## 4. Build the app

```bash
git pull && npm install
npm run ios:prepare      # build + npx cap sync ios
npm run ios:open         # Xcode → Run on a physical device
```

Push does **not** work in the iOS Simulator; use a real device.

## Endpoints (first-party session auth)

| Method | Path                            | Purpose                              |
| ------ | ------------------------------- | ------------------------------------ |
| POST   | `/api/push/devices`             | register / rotate this device's token |
| POST   | `/api/push/devices/unregister`  | sign-out, disable this device         |
| POST   | `/api/push/devices/heartbeat`   | liveness for stale-device cleanup     |
| GET    | `/api/push/badge`               | server-authoritative unread badge     |

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
- The app icon badge is owned by `@capawesome/capacitor-badge`
  (`Badge.set` / `Badge.clear`) — `@capacitor-firebase/messaging` has no
  `setBadge`. `aps.badge` in the payload sets it on arrival, and
  `GET /api/push/badge` reconciles it after a read on any device.
- The Capacitor plugin config key for this plugin is `FirebaseMessaging`
  (not `PushNotifications`).
- `UNREGISTERED` / invalid-token responses disable the device row instead of
  retrying, keeping the token table clean.
