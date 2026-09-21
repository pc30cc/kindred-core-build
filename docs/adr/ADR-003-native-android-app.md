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

Three machines are attached to the account. The two Linux hosts were measured
on 2026-09-21 — twice, because the first pass truncated the container listing
at fifteen rows and so could not support any claim about which host was busier:

| Host | OS | Cores | RAM total / **available** | Swap | Disk free | `/dev/kvm` | Containers |
|---|---|---|---|---|---|---|---|
| `rass-MacBook-Pro-7.local` | macOS | — | — | — | — | n/a | — |
| `vps-50cc1602` | Ubuntu 24.04.5 | 4 | 7751 MB / **2944 MB** | **0 MB** | 25G | **present**, 8 flags | **24** |
| `analyticsme.site` | Ubuntu 24.04.3 | 4 | 5925 MB / **2248 MB** | 511 MB, **0 free** | 60G | **absent**, 0 flags | **25** |

Neither host is idle, and they are within one container of each other. The
intuition that one of them was "the empty one" does not survive measurement:
the host with the shorter-looking service list, `analyticsme.site`, is in fact
the more constrained of the two — less available memory, and swap already
100% consumed.

What each carries:

- `vps-50cc1602` — Coolify, the full Supabase stack (auth/GoTrue, storage,
  realtime, supavisor, studio, meta) and the WordPress shop. Load 1.29.
- `analyticsme.site` — Coolify, **the LiveKit server**, Centrifugo and nine
  application containers. Load 1.52.

The workloads differ in how they fail under contention, and this decides the
host. Supabase and WordPress degrade gracefully: a query served 50ms slower is
invisible. LiveKit does not — it carries live audio and video, where CPU
contention becomes jitter the operator and the visitor both hear. Build load
belongs on the host that is not serving realtime media.

An unconstrained Gradle daemon wants 2–4GB and an Android emulator ~4GB more,
which is more than either host has spare. That is a reason to constrain the
build, not a reason to rent a runner: a capped heap, a cgroup ceiling and an
on-demand emulator bring the requirement inside what `vps-50cc1602` has, and
the swap it is missing has to be added regardless.

Note that `vps-50cc1602` running the Supabase stack with **zero swap** is a
pre-existing production risk independent of this decision. Adding swap is
listed below as a precondition of the CI work, but it is worth doing on its
own account.

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

### 5. Machine allocation — self-hosted throughout

No GitHub-hosted runner is used for either mobile platform. Both are billed
minutes against a private repository, and the macOS multiplier in particular
(10×, roughly 220 billed minutes per iOS run) exhausts a month's allowance in
eight or nine runs.

- **`rass-MacBook-Pro-7.local`** — iOS development; Android development
  (Android Studio, emulator, Compose previews); and the self-hosted runner for
  the iOS UI tests. The Mac is the only machine that can run the iOS Simulator
  at all, so this is both the cheapest and the only arrangement.
- **`vps-50cc1602` — the self-hosted Android CI runner.** It is chosen over
  `analyticsme.site` on three counts: it is the only one of the two with
  `/dev/kvm`, so it is the only one that can ever run an emulator; it has ~700MB
  more available memory; and its workload tolerates CPU contention in a way
  LiveKit's realtime media does not.
- **`analyticsme.site` — untouched.** It runs the calls infrastructure, has no
  nested virtualisation, and its swap is already fully consumed.

The existing `.github/workflows/ci.yml` (typecheck, lint, web tests, the
PostgreSQL and migration-chain jobs) stays on GitHub-hosted `ubuntu-24.04`.
This decision is about the mobile pipelines only.

### 6. Guardrails on the Android runner — preconditions, not optimisations

`vps-50cc1602` has 2944MB available and carries the Supabase stack. An
unconstrained build there would be answered by the OOM killer, and the OOM
killer does not know which process is production. Every item below is a
precondition of enabling the runner, not a later tuning pass:

1. **Add swap — 4GB.** The host currently has none, so any memory spike goes
   straight to an OOM kill. This is the single change that makes the rest safe,
   and it repairs the pre-existing production exposure noted above.
2. **Cap the build.** `org.gradle.jvmargs=-Xmx1g -XX:MaxMetaspaceSize=512m`,
   `org.gradle.daemon=false` in CI so nothing lingers between runs, and
   `org.gradle.workers.max=2` against 4 shared cores.
3. **Give the runner a cgroup ceiling.** `MemoryMax=2G` and `CPUWeight` below
   the default on the runner's systemd unit, so that when something has to be
   killed it is the build and never the database. This is the actual safety
   belt; items 1 and 2 only make hitting it unlikely.
4. **Emulator on demand only.** Robolectric JVM tests run on every push;
   instrumented emulator tests run on a schedule or by `workflow_dispatch`. The
   emulator's ~4GB does not coexist with a build and Supabase at once.
5. **Watch the disk.** 25G free, against roughly 14G for the Android SDK, one
   x86_64 system image, Gradle caches and build outputs, plus the 4GB swapfile.
   It fits with room to spare, but it is the resource that runs out silently.

## Alternatives considered

- **Capacitor Android instead of native.** Rejected *for this ADR*, not on the
  merits — it is 3–7 days against 6–10 weeks and remains the right answer if
  time-to-market outweighs fidelity. It is a separate decision, not a
  competitor to this one.
- **GitHub-hosted `ubuntu` runners for Android CI.** Rejected: billed minutes
  against a private repository, on top of what `ci.yml` already spends. Hardware
  already owned and already paid for does the same work, and the
  persistent Gradle cache on a long-lived host is faster than a cold runner
  restoring an archive on every run.
- **`analyticsme.site` as the Android runner.** Rejected on measurement. It has
  no `/dev/kvm`, so it could never run an emulator; it has less available memory
  than the host chosen; its swap is already fully consumed; and it serves
  LiveKit, where build contention is audible rather than merely slow.
- **Kotlin Multiplatform sharing UI with iOS.** Rejected: the iOS app is
  finished, native and not being rewritten, so there is no shared UI to gain —
  only a migration cost on the working platform.
- **Waiting for the iPad/macOS work first.** Rejected: iPad and macOS extend
  reach within Apple's share of an Android-majority market.

## Risks

- **CI shares a host with production.** This is the accepted cost of not
  renting runners, and it is a real one: `vps-50cc1602` serves the Supabase
  stack from the same 4 cores and 7.7GB the Android build runs on. The
  guardrails in Decision §6 are what keep a build from taking the database with
  it, and they are preconditions rather than advice. The first few runs should
  be watched rather than assumed, and the decision revisited if Supabase
  latency moves when a build is in flight.
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
