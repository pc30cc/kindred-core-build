# Native iOS app — configuration, build and App Store submission

Two Super Admin screens own everything about the native app:

| Screen | Path | Owns |
| --- | --- | --- |
| **Mobile app (iOS)** | `/admin/mobile-app` | Identity, build, capabilities, privacy strings, App Store requirements, review info, release policy |
| **Notifications** | `/admin/notifications` | Push policy, APNs delivery behaviour, action buttons, notification copy, delivery diagnostics |

Neither screen can read or write a credential. The FCM service account stays in
the server environment (`server/services/push/fcm.ts`) and the Apple demo
password stays in App Store Connect — that separation is what makes it safe to
expose the rest of this configuration to an admin UI at all.

## Where the settings actually take effect

```
Super Admin → Mobile App                config/ios-app.json  (committed)
        │  validates, scores, exports            │
        │                                        ▼
        │                        npm run ios:app-settings
        │                                        │
        ▼                                        ▼
mobile_app_settings (database)     ios/App/App/Info.plist
  • App Store readiness engine      ios/App/App/App.entitlements
  • the checklist an operator works  ios/App/App/PrivacyInfo.xcprivacy
                                     ios/generated.xcconfig
```

The build machine has no database access, and an archive has to be reproducible
from a commit alone. So the **committed `config/ios-app.json` is what a build is
made from**, and Super Admin is the editor that validates it, runs every App
Store requirement against it, and exports the exact file to commit (Mobile app →
Build & ship → Build configuration file).

`npm run ios:sync` (and therefore `npm run ios:prepare`) runs
`scripts/ios/apply-app-settings.ts` first, so the four generated files are always
in step with that JSON. None of them should be hand-edited: the next sync
overwrites them.

### Build settings precedence

`ios/generated.xcconfig` is the Release configuration's base, and
`ios/debug.xcconfig` `#include`s it so a debug run uses the same bundle id,
versions and team. The keys the xcconfig owns were **removed from the Xcode
target's own build settings** — a value set on the target wins over an xcconfig,
so leaving them there would have silently ignored everything configured in
Super Admin.

`APS_ENVIRONMENT` is the one setting that differs per configuration:
`App.entitlements` reads `aps-environment` as `$(APS_ENVIRONMENT)`, which
`debug.xcconfig` sets to `development` and `generated.xcconfig` to `production`.
Hardcoding either one breaks the other — codesign rejects an entitlement that
disagrees with the provisioning profile.

## The readiness engine

`server/services/mobileApp/readiness.ts` turns the settings row plus a few facts
about the deployment into one verdict per App Store requirement:

- **pass** — verified from the saved settings or from the project on disk
- **fail** — a value is missing or wrong; the UI names the exact fix
- **manual** — only a person can confirm it (screenshots uploaded, age-rating
  questionnaire answered, tested on a real device). Acknowledging one records
  who confirmed it and when, in `mobile_app_settings.checklist`.

A requirement whose evidence is a FILE degrades to `manual` when the server has
no `ios/` checkout — the API image does not ship an Xcode project, and failing a
file the server was never given would be a red mark nobody can clear.

The engine decides status only. Every string an operator reads comes from
`admin.mobileApp.checks.<id>.*` in all three locales, so the guidance is
translated and a CI check could reuse the same verdicts without the prose.

## Notification policy

`push_platform_settings` holds POLICY, not credentials:

- **Defaults** apply only to an operator who never saved their own notification
  preferences — a personal setting always wins (`policyDefaults()` merges
  *under* the saved row in `server/services/push/recipients.ts`).
- **APNs delivery** (priority, expiry, interruption level, relevance, thread id,
  collapse, badge, sound, mutable content) maps 1:1 onto documented `aps` keys
  and `apns-*` headers in `server/services/push/fcm.ts`.
- **Categories** connect two halves: the server attaches `aps.category`, and the
  app registers the matching `UNNotificationCategory` in
  `ios/App/App/NotificationCategories.swift`. An id that exists on only one side
  produces a banner with no buttons — never a crash.
- **Templates** are per event type and per locale, with a separate variant for
  a recipient who turned previews off. That private variant is the text that
  reaches a locked screen, so it must never contain the message body.

The master switch stops every notification immediately without touching
credentials, and `POST /api/admin/notifications/test` sends one real
notification through the real transport to the calling admin's **own** devices
— the only way to prove credentials, Firebase, APNs, the entitlement and the
device token all line up.

### Action buttons

`REPLY` and `MARK_READ` are handled in `src/lib/push/nativePush.ts` when iOS
hands the action back on resume. `REPLY` is a **foreground** action: a
background send would need a notification service extension, and a button that
silently fails is worse than one that opens the thread. The typed text arrives
as `inputValue` and is sent with an idempotency key, so a replayed action event
sends exactly once.

## Building

```bash
npm install
npm run ios:prepare      # build + apply settings + cap sync
npm run ios:open         # Xcode → Any iOS Device → Product → Archive
```

Push does not work in the Simulator — use a real device.

The full ordered procedure, from enrolling in the Apple Developer Program to
pressing "Add for Review", is in Super Admin → Mobile app → **Build & ship**,
where each step is written against the values you actually configured.

## Database

Migration `195_mobile_app_and_push_platform_settings.sql` adds both singleton
tables. Both are `service_role`-only and ship with defaults that reproduce the
previously hardcoded behaviour exactly, so applying it changes nothing until an
operator edits a value.
