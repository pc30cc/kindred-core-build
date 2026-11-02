# The mobile app as a plan feature

Owner, 2026-11-02: the Super Admin turns the iPhone and Android apps on or off
per plan. When a workspace's plan has the app off, a member who signs in to
that workspace on a phone sees the whole app faded behind one message, and
nothing in it works. Both brands (WebYar, RESPOK), both apps.

This file is the contract between the server and the two apps. Change it with
the code.

## Plan

- Registry key `mobile_app` (`server/services/billing/capabilityRegistry.ts`):
  type `feature`, group `mobile`, label "Mobile App", default **`true`**,
  `planConfigurable: true`, `workspaceOverridable: false`, user visible.
  The default keeps every existing plan, and a workspace without a plan, as it
  is: a plan without the key resolves to the default
  (`effectiveEntitlements.ts`), so nobody is locked out by the rollout. No
  migration.
- Labels: `src/lib/capability-i18n.ts` (en/fa/tr), the customer plan card
  (`PlanFeatures.tsx`, `billing.plans.feat.mobile_app`): "Mobile apps (iPhone
  and Android)" / «اپ موبایل (آیفون و اندروید)» / "Mobil uygulamalar (iPhone ve
  Android)".
- The App Review plan stays on: `app_review_seed_plan()` switches on every key
  any plan carries (migration 272/293), and the default is on.
- The web panel and the desktop apps never read this key.

## The apps

- The snapshot is the one both apps already read for every plan gate,
  `GET /api/plans/workspace/:id/effective`: `features.mobile_app.value`.
- **Locked only on an explicit `false`** for the workspace the app is showing.
  Loading, a failed read, or a missing key never locks (unlike the other
  gates, which fail closed): a network blip must not lock a whole team out.
  Read again at sign-in, on a workspace switch, on coming back to the
  foreground and on every snapshot refresh the app already does.
- Locked: every screen of the app stays where it is but is drawn faded
  (blurred, iOS `.blur` + dimmed; Android `Modifier.blur` on API 31+, a dim
  scrim below) and takes no input; tabs, buttons, pull to refresh, deep links
  and notification taps do nothing. Above it, one card:
  - the brand mark (never a letter), title `Str.appLockedTitle`, body
    `Str.appLockedBody`;
  - **iPhone:** for a member who is not the workspace owner, also
    `Str.appLockedAskOwner`. **No link, no button and no mention of a
    website or of buying** (App Store Review Guideline 3.1.1 and 3.1.3(f);
    owner's choice, 2026-11-02);
  - **Android** (both brands): also `StrAndroid.appLockedVisitWebsite` and a
    button `StrAndroid.appLockedOpenWebsite` that opens the web panel's
    billing page (`<panel origin>/app/billing`) in the browser;
  - `Str.appLockedSwitchWorkspace` when the member belongs to more than one
    workspace (opens the existing workspace picker), and the existing sign
    out (`Str.signOut`).
- While locked the app stops its own background work for that workspace
  (realtime, polling, sync); the push device stays registered (the server
  decides what to send, below), so unlocking needs no new permission.
- A colleague call already on is never cut by a lock (deny on create, allow
  on continuity). An incoming colleague ring for a locked workspace is
  reported to CallKit as iOS requires and ended at once; Android does not
  show it.

## Server

Pushes to phones follow the switch, so a locked app is never woken for
nothing: for a workspace whose effective `mobile_app` is `false`, no alert
push (messages, assignments, team chat, missed calls), no colleague ring
(VoIP to iPhones, FCM to Android) and no call-centre ring (FCM) is sent to
its members' phones. The read is cached briefly (a minute is enough) and
**fails open**: if the plan cannot be read, the push is sent as before. The
API itself is not refused: the web panel uses the same API, and the apps'
lock is the product's answer.

## Strings

Shared (iOS `Strings.swift`, generated into Android's `Strings.kt` by
`scripts/android/strings-from-ios.mjs`):

| Name | fa | en | tr | ar |
|---|---|---|---|---|
| `appLockedTitle` | اپ موبایل در پلن این فضای کاری نیست | The mobile app isn't in this workspace's plan | Mobil uygulama bu çalışma alanının planında yok | تطبيق الجوال غير مشمول في خطة مساحة العمل هذه |
| `appLockedBody` | تا وقتی پلن این فضای کاری شامل اپ موبایل نباشد، بخش‌های اپ در دسترس نیستند. | Until this workspace's plan includes the mobile app, the app's sections aren't available. | Bu çalışma alanının planı mobil uygulamayı içerene kadar uygulamanın bölümleri kullanılamaz. | لن تتوفر أقسام التطبيق حتى تشمل خطة مساحة العمل هذه تطبيق الجوال. |
| `appLockedAskOwner` | برای اطلاعات بیشتر با مالک فضای کاری تماس بگیرید. | For more, contact the workspace owner. | Ayrıntılar için çalışma alanı sahibiyle iletişime geçin. | لمزيد من المعلومات، تواصل مع مالك مساحة العمل. |
| `appLockedSwitchWorkspace` | تغییر فضای کاری | Switch workspace | Çalışma alanını değiştir | تبديل مساحة العمل |

Android only (`StringsAndroid.kt`):

| Name | fa | en | tr | ar |
|---|---|---|---|---|
| `appLockedVisitWebsite` | برای فعال‌سازی، از طریق وب‌سایت اقدام کنید. | To turn it on, visit the website. | Etkinleştirmek için web sitesini ziyaret edin. | لتفعيله، تفضل بزيارة الموقع. |
| `appLockedOpenWebsite` | باز کردن وب‌سایت | Open the website | Web sitesini aç | فتح الموقع |

## The sign-in screen's site address (owner, 2026-11-02)

Both apps, both brands: the sign-in screen has a small link under the form,
labelled with the word "Website" in the app's language (the Settings
website row's label: `appState.websiteLabel`, i.e. Super Admin's website name
for that language, else `SettingsStr.website`; Android the same rule), **not
the address itself** (owner: "don't show the address, make it a link").
Tapping it opens the brand's site in the app's language in the browser:
WebYar follows the language like the Settings links (Persian at the root,
`https://webyar.ai`; `/en`, `/tr`, `/ar`), RESPOK opens its site as
configured. iOS takes the URL from `SiteLinks` (`AppState.siteWebsiteURL`);
Android gets the same rule (`SiteLinks.kt`, brand flag
`AppBrand.localizedSitePaths`: WebYar true, RESPOK false), from the site root
the app already knows (the app config's website link, else the platform's
canonical site); no link when neither is known. On the iPhone it is a link
to the site, not a call to buy: it names no plan, price or activation.

The iPhone sign-in screen is redesigned at the same time (owner: "more
beautiful and professional"), keeping what it does: email and password,
the existing links (forgot password, privacy, terms), the language picker,
the brand mark, both brands, RTL for fa/ar, Dynamic Type, dark mode.

## Rollout

1. Merge: backends 25 and 32 deploy; the key appears in Super Admin → Plans
   switched on for every plan. Nothing changes until the Super Admin turns it
   off somewhere.
2. iOS 1.0.0 (4) to App Store Connect; Android with its next release. An
   older app ignores the key; the server's push rule still applies to it.
