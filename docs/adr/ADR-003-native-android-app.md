# ADR-003: Native Android App — Stack, Build Order and Machine Allocation

- Status: Accepted (stack and sequencing); implementation NOT started
- Date: 2026-09-21
- Owners: Platform / Kindred Core maintainers

## Context

The platform currently ships two iOS surfaces:

- `ios/App` — the Capacitor shell (`com.webyar.app`), a WKWebView hosting the
  same React bundle that ships to the web.
- `ios/WebyarNative` — a native SwiftUI app (`com.webyar.native`), 80 Swift
  files / ~18,450 lines, iOS 17, iPhone-only and portrait-only, with exactly
  one external dependency (LiveKit).

There is no Android client of any kind. There is no `android/` directory and
`@capacitor/android` is not installed.

The server, however, is already Android-aware and has been for some time:

- `server/services/push/devices.ts:21` — `type PushPlatform = 'ios' | 'android'`
- `server/services/push/fcm.ts:191` — android message block with `channel_id`
- `server/services/push/platformSettings.ts:204` — `android_channel_id` default
  `'webyar_messages'`
- `database/migrations/136_mobile_push.sql:23` — `CHECK (platform IN ('ios', 'android'))`
- `src/lib/native.ts:17` — `getNativePlatform(): 'ios' | 'android' | 'web'`

No server, schema or push work is required to support an Android client. The
gap is entirely on the client side.

## Problem

The product's market is Iran (Kavenegar SMS, ZarinPal gateway, Persian-first
UI, `fa` as the default language in the native app's own UI test suite). In
that market Android is the majority platform, not the minority one, and
distribution does not depend on a store Apple controls. The native iOS app
therefore serves the smaller half of the addressable market.

Two questions had to be settled before any code is written:

1. Does the existing iOS work port, and if not, what is actually being built?
2. Which machines build and test it?

On (1): SwiftUI is Apple-proprietary and does not exist on Android. None of the
18,450 lines port as code. What does carry over is the *contract and the
design*: the API surface proven by `Core/Networking/APIClient.swift`, the three
language catalogues in `Sources/Localization`, and — most valuably — the
reasoning recorded in the iOS source comments, each of which is a post-mortem
of a real shipped bug. The iOS app is the specification for the Android app.

On (2): Android, unlike iOS, is not tied to Apple hardware. The Android
emulator runs anywhere KVM is available; the iOS Simulator runs only on macOS
by Apple licensing. The Mac is therefore the scarce resource and must not be
spent on work Linux can do.

## Constraints

Three machines are attached to the account. All were measured on 2026-09-21
rather than assumed:

| Host | OS | CPU / RAM | Disk free | `/dev/kvm` | Role today |
|---|---|---|---|---|---|
| `rass-MacBook-Pro-7.local` | macOS | — | — | n/a | Development |
| `vps-50cc1602` | Ubuntu 24.04.5 | 4 cores / 7.6Gi (2.9Gi free) | 25G | **present**, 8 virt flags | **Production** |
| `analyticsme.site` | Ubuntu 24.04.3 | 4 cores / 5.8Gi (3.0Gi free) | 60G | **absent**, 0 virt flags | **Production** |

Both Linux hosts carry live workloads and are not spare capacity:

- `vps-50cc1602` runs Coolify, the full Supabase stack (auth/GoTrue, storage,
  realtime, supavisor, studio, meta) and the WordPress shop. Load 1.81 on 4
  cores. **Swap is 0B** — there is no headroom at all before the OOM killer.
- `analyticsme.site` runs Coolify, **the LiveKit server**, Centrifugo and nine
  application containers. Swap is 511Mi with **284Ki free** — swap is already
  effectively exhausted.

A Gradle daemon alone wants 2–4GB; an Android emulator wants ~4GB more. Neither
host has that to give, and the consequence of trying is an OOM kill of either
the database stack or the calls infrastructure. This reverses the provisional
plan of using a VPS as the Android CI runner.

Note also that `vps-50cc1602` running the Supabase stack with zero swap is a
pre-existing production risk independent of this decision.

## Decision

### 1. The app is native Kotlin + Jetpack Compose

Not Capacitor, not a shared-UI cross-platform framework. Compose only; no XML
layouts. A Capacitor Android build remains available as a separate, cheaper
option but is explicitly not what this ADR covers.

### 2. Locked technical choices

| Concern | Choice | iOS counterpart it replaces |
|---|---|---|
| UI | Jetpack Compose | SwiftUI |
| Module layout | Single module initially; split only when a real boundary appears | — |
| `minSdk` | 24 | — |
| Networking | Ktor Client | `Core/Networking/APIClient.swift` (hand-rolled URLSession) |
| Session token | DataStore + Android Keystore | `Core/Storage/TokenStore.swift` (Keychain) |
| Calls | LiveKit Android SDK — same rooms, same tokens as web and iOS | `Features/Calls` |
| Test identifiers | `Modifier.testTag()`, mirroring the iOS `A11y` list | `A11yID` in `UITests/UITestCase.swift` |

### 3. Test strategy: two layers, emulator only where it is required

- `src/test/` — Compose UI tests under Robolectric, on the JVM. No device, no
  KVM. This is where the majority of the suite lives.
- `src/androidTest/` — instrumented tests on an emulator, reserved for what
  Robolectric genuinely cannot answer: real IME/keyboard behaviour, which is
  precisely the class of bug `ios/WebyarNative/UITests/KeyboardTests.swift` and
  `DesignSystem/Components/PinnedScrollView.swift` exist for.

The identifier-drift guard already proven on iOS
(`src/test/ios/accessibilityIdentifiers.test.ts`, which fails in a second when
the app's identifiers and the test bundle's copy disagree) is to be extended to
cover Android test tags rather than reinvented.

### 4. Build order

Deliberately not starting with the UI:

1. **Gradle skeleton** — an empty Compose app that launches on an emulator and
   renders one `@Preview(locale = "fa")`. Its only job is to prove the
   toolchain end to end, including right-to-left.
2. **Port `Core`** — `Models`, `APIClient`, `TokenStore` to Kotlin. ~3,917
   lines, mechanical rather than design work because the API contract is
   already proven. Zero UI; fully testable on the JVM.
3. **Port `SampleAPI`** — the 810-line in-app sample backend. This is
   sequenced third on purpose: it is what allows the entire iOS UI suite to run
   with no account, no network and no credentials. Built early, every later
   test is cheap; built late, every test written before it is welded to a live
   backend.
4. **Localization** — `Sources/Localization` (~2,177 lines, three languages) to
   `strings.xml`. Mechanical.
5. **One vertical slice** — sign in → inbox list → open a chat → send a
   message. One path, complete. If it works, auth, token storage, the API
   client, right-to-left and the test harness are all proven together and the
   remaining features are repetition. If it does not, that is discovered in
   week one rather than week six.
6. **CI from the first commit**, not at the end.

Explicitly NOT the starting point: the design system / theme, and `Features/Chat`
(3,186 lines, the hardest screen on iOS).

### 5. Machine allocation

- **`rass-MacBook-Pro-7.local`** — iOS development; Android development
  (Android Studio, emulator, Compose previews); and the self-hosted runner for
  the iOS UI tests. The Mac is the only machine that can run the iOS Simulator,
  and using it as that runner is what removes GitHub's 10× macOS billing
  multiplier on this private repository.
- **Android CI — GitHub-hosted `ubuntu` runners.** Billed at 1×, 16GB against
  the 6–8GB these VPS hosts have, and no risk to anything in production. The
  persistent-Gradle-cache advantage of a self-hosted runner is recovered well
  enough by `gradle/actions/setup-gradle`.
- **`vps-50cc1602` and `analyticsme.site` — production only.** Neither becomes
  a build or test runner while it carries the Supabase stack and the LiveKit
  server respectively.

## Alternatives considered

- **Capacitor Android instead of native.** Rejected *for this ADR*, not on the
  merits — it is 3–7 days against 6–10 weeks and remains the right answer if
  time-to-market outweighs fidelity. It is a separate decision, not a
  competitor to this one.
- **A VPS as the self-hosted Android runner.** Rejected on measurement:
  `analyticsme.site` has no KVM at all, and `vps-50cc1602`, though it does have
  nested virtualisation enabled, has 2.9Gi free and zero swap while running the
  database stack.
- **Kotlin Multiplatform sharing UI with iOS.** Rejected: the iOS app is
  finished, native and not being rewritten, so there is no shared UI to gain —
  only a migration cost on the working platform.
- **Waiting for the iPad/macOS work first.** Rejected: iPad and macOS extend
  reach within Apple's share of an Android-majority market.

## Risks

- **Background execution.** The calls feature must survive the screen locking
  and app switching. Android's Doze and per-OEM process killers (Xiaomi, Huawei
  especially) are aggressive in ways iOS is not. This has no iOS counterpart to
  copy and is the single largest unknown.
- **The keyboard work does not port.** Android's IME insets model is unrelated
  to iOS safe areas; everything learned in `PinnedScrollView.swift` has to be
  re-learned, and by running it rather than by reasoning about it.
- **Device fragmentation.** iOS has roughly ten screen sizes; Android has
  thousands.
- **Right-to-left is expected to be easier**, not harder: `supportsRtl` plus
  Compose's `LayoutDirection` has no equivalent of the
  `UISemanticContentAttribute` problem recorded in
  `ios/WebyarNative/Sources/App/WindowDirection.swift`.

## Operational implications

- `capacitor.config.ts` carries an `ios:` block and no `android:` equivalent.
  This is untouched by this ADR and only matters if the Capacitor alternative
  above is ever taken.
- The four `scripts/ios/*` build scripts have no Android counterpart. If they
  are generalised rather than duplicated, that should happen at step 1 while
  the Gradle skeleton is still empty.
- Play Store distribution is not assumed. Direct APK and the local Iranian
  stores are the expected channels, which removes store review from the
  critical path.
