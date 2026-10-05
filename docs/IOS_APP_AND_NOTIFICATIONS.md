# Native iOS app — configuration, build and App Store submission

Two Super Admin screens own everything about the native app:

| Screen | Path | Owns |
| --- | --- | --- |
| **Mobile app (iOS)** | `/admin/mobile-app` | Identity, build, capabilities, privacy strings, App Store requirements, review info, release policy |
| **Notifications** | `/admin/notifications` | Push policy, APNs delivery behaviour, action buttons, notification copy, delivery diagnostics |

Neither screen can read or write a credential. The APNs key stays in the server
environment (`server/services/push/apns.ts`) and the Apple demo password stays
in App Store Connect — that separation is what makes it safe to
expose the rest of this configuration to an admin UI at all.

## Where the settings actually take effect

The native app is `ios/Webyar`. Its Xcode project is generated from
`ios/Webyar/project.yml` by XcodeGen and is not committed; that spec is
where the bundle identifier, team, versions, Info.plist keys (purpose strings,
orientation, launch screen, export compliance), entitlements and background
modes live. The privacy manifest is `ios/Webyar/Resources/PrivacyInfo.xcprivacy`,
written by hand and checked against the Swift sources by
`src/test/ios/privacyManifest.test.ts`.

Super Admin → Mobile app does not write into the project. It holds the App
Store record and what App Store Connect expects (versions, review details,
privacy answers), scores the App Store requirements against it, and serves the
in-app switches the installed app reads from `GET /api/mobile-app/public-config`.
The build guide there puts the marketing version and build number on the
archive's command line (`MARKETING_VERSION=… CURRENT_PROJECT_VERSION=…`), so a
new upload needs no edit to `project.yml`.

`aps-environment` comes from the `APS_ENVIRONMENT` build setting: `development`
for Debug, `production` for Release. Hardcoding either one breaks the other —
codesign rejects an entitlement that disagrees with the provisioning profile.

## The readiness engine

`server/services/mobileApp/readiness.ts` turns the settings row plus a few facts
about the deployment into one verdict per App Store requirement:

- **pass** — verified from the saved settings or from the project on disk
- **fail** — a value is missing or wrong; the UI names the exact fix
- **manual** — only a person can confirm it (screenshots uploaded, age-rating
  questionnaire answered, tested on a real device). Acknowledging one records
  who confirmed it and when, in `mobile_app_settings.checklist`.

A requirement whose evidence is a FILE (the icon, the privacy manifest, the
push entitlement, the background modes) is read from `ios/Webyar` when
the project is checked out. The API image does not ship `ios/`, so a deployed
server reads the same facts from `server/services/mobileApp/iosProjectFacts.json`,
written by `npm run ios:project-facts`; `project.test.ts` fails CI while that
file and the project disagree. With neither, those checks degrade to `manual`.

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
  `ios/Webyar/Sources/Core/Push/PushController.swift`. An id that exists on only one side
  produces a banner with no buttons — never a crash.
- **Templates** are per event type and per locale, with a separate variant for
  a recipient who turned previews off. That private variant is the text that
  reaches a locked screen, so it must never contain the message body.

The master switch stops every notification immediately without touching
credentials, and `POST /api/admin/notifications/test` sends one real
notification through the real transport to the calling admin's **own** devices
— the only way to prove credentials, APNs, the entitlement and the device
token all line up.

### Action buttons

`REPLY` and `MARK_READ` are handled in
`ios/Webyar/Sources/Core/Push/PushController.swift` when iOS hands the
action back. `REPLY` is a **foreground** action: a
background send would need a notification service extension, and a button that
silently fails is worse than one that opens the thread. The typed text arrives
as `inputValue` and is sent with an idempotency key, so a replayed action event
sends exactly once.

## Building

```bash
brew install xcodegen
cd ios/Webyar
xcodegen generate              # after every pull: the project is not committed
open Webyar.xcodeproj    # Any iOS Device → Product → Archive
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
