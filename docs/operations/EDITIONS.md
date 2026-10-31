# Editions: one codebase, two products

The same code runs two products that must never look like each other:

| | Iranian edition | International edition |
| --- | --- | --- |
| Product | WebYar (`*.webyar.ai`) | RESPOK (`*.respok.app`) |
| Rule | `platform_settings.region_mode = 'iran'` | any other value (`multi`, `global`, `turkey`) or no row |
| Code | `edition === 'iran'` | `edition === 'international'` |

The rule lives in one place, `shared/edition.ts` (`resolveEdition`), and is
read on the server by `getPlatformEdition` / `getPlatformEditionOrNull`
(`server/services/platformRegion.ts`) and on the client by `useEdition()` /
`knownEdition()` (`src/hooks/useEdition.ts`, `src/lib/edition.ts`).

**An edition that cannot be known behaves as Iran.** A failed settings read on
the server (`getPlatformEditionOrNull` → `null`), a browser that has never
seen the platform, a widget bootstrap from an older backend: all of them get
exactly what WebYar had before editions existed. Money paths refuse instead of
guessing (`EditionUnavailableError`, HTTP 503).

The Iranian edition is frozen: every change behind an edition check leaves
its output byte-identical, and guard tests pin it (`src/test/edition/`).
The deliberate exceptions are WebYar's own brand kit and the chat widget's
message-layout polish (below), asked for by the owner and pinned by their own
tests.
Persian in the International edition is only right-to-left Persian text:
never the Iranian brand, calendar, currency, gateways or time zone.

## What differs per edition

| Area | Iran | International | Where |
| --- | --- | --- | --- |
| Money | simple billing: a prepaid account in Toman (stored IRR), Iranian gateways, AI credit packs (billing v2's Rial wallet and AI top-up were retired in phase 7; their records are in `billing_v2_archive`) | simple billing in USD (TRY on a Turkish-only site), international gateways only; billing v2's cloned Rial records were never converted | phases 1–3, `shared/edition.ts`, `docs/billing/SIMPLE_BILLING.md` |
| Calendar / time zone | Jalali, Asia/Tehran | Gregorian (Persian digits kept), the viewer's zone or UTC | `src/lib/date.ts`, server formatters |
| Phone / SMS / Bale | +98, Iranian SMS vendors, Bale | no national default, no SMS verification, no Bale | phase 3 |
| Brand kit (logos, favicon, PWA icons, launch loader) | WebYar's official kit (`public/brand/webyar`, `WEBYAR_BRAND`; see below) | RESPOK's (`public/brand/intl`, `INTL_BRAND`) | `shared/webyarBrand.ts`, `shared/internationalMode.ts`, `index.html`, `BrandLogo`, `BrandLoader`, `PlatformBrandingGate`, `server/routes/manifest.ts` |
| The platform's own logo and symbol (Super Admin → Branding → Visual identity) | an upload wins over WebYar's kit everywhere the logo shows; without one, the kit as before | an upload wins over RESPOK's kit the same way; without one, the kit as before | see "The platform's own logo" below |
| Chat widget floating button | WebYar's kit launcher (every template, `edition: 'iran'` only) | RESPOK's kit launcher, the Thread chat button, or the Open one for `t1-intl` / `t2-intl` with `logoDirection: 'open'` (every template, `edition: 'international'` only; the RESPOK build's loader only, `@intl-kit`) | `public/widget/loader.js`, `shared/localKitLauncher.ts`, `shared/respokLauncher.ts` |
| Panel colour scheme `respok` | never offered | offered | `shared/panelThemes.ts` |
| Brand in text | WebYar's fixed words ("Webyar", "وب‌یار", "Web Yar", info@webyar.ai, https://webyar.ai) | the platform's own name, site and support address | `shared/brand.ts`, `src/lib/brand.ts` |
| First paint (before the bundle) | as before | edition, brand, title and default language from `/api/platform/public/boot.js` on a first visit (loaded asynchronously, never blocking; see below), the cache after | `index.html`, `server/routes/platformPublic.ts` |
| Dashboard's languages | Persian by default; the Super Admin may add English and Turkish, pick the default and show or hide the switcher, and the brand stays WebYar (see "The dashboard's languages" below) | the same settings | `shared/panelLanguages.ts` |
| Default UI language | the panel's default once the browser knows it, before that `runtime-config.js` `defaultLocale` | the panel's default (Super Admin → Branding → General) | `src/i18n/index.tsx` `getSiteDefaultLocale` |
| Chat widget template | `default` (and `t1`, `t2` once the Super Admin enables them) | `intl` (skin over the same renderer; and `t1-intl`, `t2-intl`, RESPOK's skins over Templates 1 and 2, once enabled) | `shared/widgetTemplates.ts` |
| Call widget template | `default`: WebYar's 2026-10 design (skin `presentation-default.css`; IRANSans, InterWY for Latin; Jalali dates in Tehran) | `intl`: Respok's 2026-10 design, the same core renderer, panel module and markup with its own skin `presentation-intl.css` (Figtree; Gregorian in the visitor's zone; the Thread or Open lockup as the chat template's `logoDirection`) | `shared/widgetTemplates.ts`, `docs/call-widget-handoff/IMPLEMENTATION_NOTES.md` |
| Call widget "powered by" | an uploaded logo, when there is one, as an image in the brand's place (`powered_by_logo` with `powered_by_logo_custom: true`); else the designed lockup drawn inline in WebYar's build: WebYar's mark + «قدرت گرفته از» + bold «وب‌یار» (English and Turkish: the mark and the localized words around a bold "Web Yar"); a workspace's own "powered by" text keeps the mark only when it names the brand, else it is plain text; without the edition (an older backend) the words as text, no mark (`powered_by_logo` is no longer drawn) | "Powered by" + an uploaded logo as an image (`powered_by.custom: true`), else the platform's Thread (or Open) lockup drawn inline in the RESPOK build, else the platform's logo image (alt = platform name, the name if the image fails); its link, hidden by the platform switch or the plan gate (as the chat widget) | `server/routes/callWidget.ts`, `public/call-widget/runtime.js`, `public/call-widget/presentation-default-panel.js` |
| Chat widget credit | the label and WebYar's Persian logotype (`poweredBy.logo`, absolute from the widget asset base, 16px; the name if the image fails), or the uploaded logo (absolute on the storage provider); an unknown edition keeps the English `platform_name` as text | the label and the platform's logo (`poweredBy.logo`, absolute from the widget asset base; the name if the image fails), or the uploaded logo in every template and logo direction | `server/services/widget/configSnapshot.ts` |
| Widget dates (Persian) | Jalali, Tehran day boundaries | Gregorian, the visitor's zone | `calendar` / `timeZone` hints in the bootstrap |
| Push notification copy | "Webyar", "New message in Webyar", «پیام جدید در وب‌یار» | the platform's name (also in place of a stored line that names WebYar) | `server/services/push/dispatch.ts`, `platformSettings.ts` `defaultPushTemplates` |
| Legal pages (/privacy, /terms, /contact) | "Webyar", info@webyar.ai | the platform's name and support address | `src/pages/public/legal` |
| Desktop apps (Windows, Mac) | WebYar's builds: `Webyar.exe` / `Webyar.app`, feeds `pc30cc/webyar-desktop-releases` and `pc30cc/mac-os`, downloads on app.webyar.ai | RESPOK's builds of the same source: `Respok.exe` / `RESPOK.app`, feeds in `pc30cc/respok-releases`, downloads on app.respok.app; Super Admin → Windows app / macOS app default to them and never serve a WebYar feed, link or note (a cloned value is replaced) | `shared/nativeAppBrands.ts`, `windows-native/src/Webyar.Core/Config/Brand.cs`, `macos/Webyar/Core/Config/AppBrand.swift`, `deploy/app-downloads/` |
| Mobile apps (iOS, Android) | WebYar's: `com.webyar.ai` (the native iOS and Android apps; Super Admin's iOS record keeps its old default `com.webyar.app`), name "Webyar", Xcode scheme `Webyar`, Gradle flavor `webyar` (`-Pwebyar.version…`), the Android app opens in Persian, `Webyar-Android.apk` / `.json` | RESPOK's: `com.respok.app`, name "RESPOK", scheme `Respok`, flavor `respok` (`-Prespok.version…`), opens in English, `RESPOK-Android.apk` / `.json` (no shipped version until that sidecar exists); Super Admin → Mobile app defaults to them (a new RESPOK row is written with all of them, the columns' defaults being WebYar's) and never shows a name, privacy string, link or note that names WebYar (a cloned one is replaced by RESPOK's default or cleared). Identifiers (bundle id, package, URL scheme, associated domains, Firebase ids, push category ids) are never rewritten; the Android push channel is the edition's own (`android_channel_id`: Iran keeps the stored `webyar_messages`, International sends `messages`, the channel RESPOK's brand-neutral Android app creates), and the App Review account `apple@webyar.ai` is kept | `shared/nativeAppBrands.ts`, `server/services/mobileApp/settings.ts` (`mobileAppDefaults`, `mobileSettingsForEdition`), `androidRelease.ts`, `src/components/admin/mobile/nativeBuild.ts` |
| Native apps' settings (Super Admin → Windows app, macOS app, Mobile app, Notifications; desktop ads and announcements) | the Iranian edition's own rows | the International edition's own rows | one row per edition, see below |

### The dashboard's languages (both editions; owner, 2026-10-31)

The language the dashboard is shown in never changes the brand or the
edition: a WebYar panel in English or Turkish is still WebYar, with Toman,
the Iranian gateways, +98 phones and WebYar's words ("Webyar" in Latin
text). Only the Jalali calendar follows Persian text (`src/lib/date.ts`).

Super Admin → Branding → Platform settings sets it, for both editions, in
the columns that already existed (no migration):

| Setting | Column | Where |
| --- | --- | --- |
| Which languages the panel may be in | `active_locales` (English, Persian, Turkish; the other languages listed there are branding text only) | Languages |
| The language it opens in | `default_locale` | General → Default language |
| Whether people see a switcher | `site_mode`: `multi_language` shown, `single_language` hidden (everyone sees the default) | General → Language switcher |

`shared/panelLanguages.ts` (`panelLanguagesFor`) is the one rule: Türkiye and
Global still pin one language; Iran and Multi use the three settings (Iran
with none picked is Persian). The panel means the dashboard, its sign-in
pages and Super Admin (`usePanelLanguages()` in
`src/hooks/usePlatformRegion.ts`, read by the top bar, the Art theme's
menu, Settings → Interface and Profile, Super Admin's layout and Users page,
and the sign-in pages' `LanguageSelector`), and an operator's push and API
texts (`server/services/operatorLocale.ts`, via `getPlatformPanelLanguages`).
A language someone picks in a switcher is kept (`app-locale-choice`,
`src/i18n/config.ts`) and outranks the default; a browser where nobody
picked one follows the default, including when the Super Admin changes it;
one outside the panel's languages is switched to the default and forgotten.
`app-locale` is only the language the page was last shown in (index.html's
title, the build's locale preload, the Inbox). The `app-locale` a browser
kept before the choice key existed is read once
(`app-locale-choice-migrated`): it is a pick in the International edition
and the native shell, which always had switchers; in the Iranian edition
English or Turkish there is a pick (only #376's switcher wrote them) and
Persian is not: it was the old region lock's, and it kept the owner's new
English default from showing (2026-10-31). Nothing changes before
the platform's settings have arrived, and a failed settings read never
moves the dashboard's language: the browser keeps the last good settings,
or waits for the first (`usePlatformRegionSettings`). On the server a
failed read offers every language, so an operator's own choice is kept.

What visitors and customers read keeps the region's rule
(`getPlatformAllowedLocales`, `clampLocaleToPlatformRegion`,
`allowedLocalesFor`): in Iran the chat widget, AI replies, Telegram, e-mail
templates, knowledge base and canned responses stay Persian, whatever the
panel's languages are. So do these, though operators or the public reach
them from the panel:

- E-mails to operators (transcripts, digests, offline messages) are written
  in their template's language, which is a visitor language (Persian in
  Iran): an operator whose panel is English still gets the Persian
  template, and every value written into it is Persian too
  (`operatorMailLocale` in `server/services/operatorLocale.ts`). Their push
  and the operator API texts follow the dashboard's languages.
- The public help center served by the backend (a workspace's help domain:
  `/help` opens in the default language kept inside the visitors'
  languages, `server/routes/kb.ts`), the operator's AI-assist drafts (they
  go to a visitor), the AI knowledge-base builder, the AI playground and the
  widget previews (`contentLocaleFor` in `src/lib/region.ts`). The
  platform's own help center on app.* (`src/App.tsx`) does the same since
  2026-10-31: `/help`, and a help page in an unknown language, open in the
  visitors' default (`src/components/help/useHelpDefaultLocale.ts`; WebYar
  `/help/fa`, RESPOK `/help/en`; a browser that has seen the platform
  answers at once from its cached region); it used to send everyone to
  `/help/en`. The backend's help pages read an unknown language the same way
  (`helpLocaleOf` in `server/routes/kb.ts`), and the contact page links to
  `/help`.
- An invitation: its e-mail values and its SMS are in the mail's language
  (a visitor language; Persian in Iran), whatever the inviter's dashboard
  language; the delivery failure the inviter reads stays in theirs
  (`server/services/invitations/worker.ts`).
- The installed web app's manifest follows the dashboard's languages
  (`server/routes/manifest.ts`), like the dashboard itself.

The phone country stays Iran (+98) in the Iranian edition whatever the
dashboard's language (`src/lib/phone-countries.ts`, `EDITION_PROFILE`).

In Multi (RESPOK) the active languages are the visitors' and customers' too:
to limit only the dashboard, set General → Language switcher to Hidden and
choose its default language (the Languages tab says which of the two its
list decides in each region). In Iran the default-language list offers
every language the dashboard is translated into, and one that is not active
is turned on with it (and off again if another default is picked before
saving); in Multi it keeps to the active languages, which are the visitors'
too. Saving a new default forgets the Super Admin's own pick, and once the
new settings are read the guard moves their dashboard to it, as it does for
everyone who has not picked a language in a switcher (with the switcher
hidden, for everyone); the toast says which. Clicking the region already chosen changes
nothing; picking Iran from another region presets Persian only without a
switcher. A stored default the dashboard cannot open in (a legacy `ar`, a
tagged `fa-IR`) is shown, and saved with the next save, as the one it
opens in.

On 2026-10-31 at 07:58 UTC WebYar's row was saved as
`iran | {fa,tr,ar,en} | fa | single_language` (earlier that day `{fa}`), and
RESPOK's was `multi | {en,tr} | en | multi_language`. Both read exactly as
before: WebYar's switcher is hidden, so its dashboard stays Persian only,
and Arabic has no dashboard translation (branding text only). Note that
Turkish and English are already ticked there: turning General → Language
switcher to Shown offers Persian, Turkish and English at once; untick the
ones not wanted under Languages first.

Before offering English on WebYar's dashboard: on 2026-10-31 WebYar had 7
profiles, 3 of them with `preferred_locale = 'en'`. Accounts from before
migration 158 may carry an `en` they never chose; while the panel is
Persian only it is ignored, but once English is one of the dashboard's
languages those operators get their push and the operator API texts the
native apps print in English until they pick Persian (Settings → Profile,
or the top bar's language switcher, which writes the same field). Their
panel in the browser follows the browser's own choice, not this field.

### The native apps' settings are kept per edition

`desktop_app_settings`, `macos_app_settings`, `mobile_app_settings` and
`push_platform_settings` hold one row per edition, and every
`desktop_app_campaigns` row belongs to one edition (`edition` column,
`database/migrations/257_app_settings_per_edition.sql`). A switch of
`region_mode` therefore shows Super Admin and the apps that edition's own
settings, never the other's; switching back finds the first edition's
settings as they were left. An edition that has saved nothing yet is served
its own brand's defaults (above), and the first save of its Super Admin page
creates its row. Every server read and write names the edition
(`server/services/editionSettings.ts`): the apps' loaders serve the defaults
without a read while the edition cannot be told, and Super Admin answers 503
(`EDITION_UNAVAILABLE`) rather than show or write a guessed edition's row.
Caches are kept per edition. 257 put the rows that existed in the edition the
deployment ran when it was applied; `public.platform_edition()` (the same
rule as `resolveEdition`) is the column's default, for code that does not name
the edition. The App Review demo account is one per database: its status
reports the latest seed of either edition, and a seed records the account in
the running edition's App Store record only.

### WebYar's brand kit (Iranian edition only)

The owner's official kit (v1, Mehr 1405) is worn only when
`platform_settings.region_mode = 'iran'` — `isWebyarKitEdition()` in
`shared/webyarBrand.ts`. Every other region mode (multi, global, turkey) and an
edition that is not known keep exactly what they showed before; guard tests
prove it (`src/test/edition/webyarBrandKit.test.tsx`,
`src/test/widget/webyarLauncher.test.ts`, `phase5Brand`, `internationalMode`).
The Iranian edition is Persian-only, so only the Persian logotype is used.

- Files: `public/brand/webyar/` (favicon.svg, apple-touch-icon, PWA 192/512 and
  maskable, Safari mask icon, og-image, the Persian logotype for light and dark,
  the turquoise symbol). The kit's other files (latin logos, PDFs, Lottie,
  videos, desktop and mobile app icons, social avatars) are not in the repo.
- Panel: `index.html` dresses the splash (the kit's loader, the logotype at the
  foot) and the head (favicon, touch icon, mask icon, theme colour #0B7D6C,
  og:image) once the edition is known to be Iran (cache or `boot.js`);
  `BrandLogo` shows the symbol, `BrandLockup` / `BrandWordmark` / `BrandFooter`
  the logotype, `BrandLoader` the kit's loader. A logo or symbol the Super
  Admin uploaded wins over the kit (below); an operator's old favicon or PWA
  icon URL or colour (Super Admin → Branding) still wins over the kit, in the
  same order as before; the seeded `#3B82F6` counts as "not chosen". Note that
  og:image is set by script, which link-preview crawlers do not run.
- Chat widget launcher: every template wears the kit's button when the
  bootstrap says `edition: 'iran'`: gradient 140deg #22D3B4 → #0B7D6C, the
  bubble with three dots, entrance (the button springs in, the bubble grows,
  the dots appear one by one; replaces the slide-up), hover (lift, dots
  wave), operator typing (the dots bob while the runtime shows "Support is
  typing…", via the optional `shell.setOperatorTyping` the loader hands the
  runtime), ping (a turquoise ring spreads twice, once, 6s after the entrance
  if the chat is still closed), open (bubble turns away, chevron turns in,
  per the kit's open Lottie, in CSS) and close (the dots arrive again),
  unread (saffron badge, Persian digits in Persian, one nudge), offline (ink
  ground, turquoise bubble), 60px at 100%; the kit's timings and easings;
  motion off with prefers-reduced-motion. Without a colour of its own (Widget
  → Appearance "Brand colour": NULL, sent as the seeded `#3B82F6`,
  shared/widgetColor.ts) the panel's accent is the kit's deep turquoise
  #0B7D6C too, so the button and the panel agree (loader.js
  applyConfigToShell; RESPOK's Ink #16142B the same way). A workspace colour other than `#3B82F6` keeps
  its own solid colour (no gradient, no offline recolouring); its icon colour,
  a custom icon, image, shape, size, label and position work as before. The
  panel opens from the same corner as before, so the launcher still slides
  away while it is open (the chevron is seen during that motion).
- "Powered by": the Persian logotype in the brand's place in both widgets.

### The platform's own logo (both editions; migration 290)

The owner's rule (2026-10-30): the logo is read from one place, for WebYar and
RESPOK alike, so changing it once changes it everywhere.

- Where it is set: Super Admin → Branding → Visual identity. A logo for light
  backgrounds, an optional one for dark backgrounds (the light one stands in;
  it waits for a light one and keeps its shape, within 2%, because an email
  draws the dark PNG at the light one's size; a new light logo of another
  shape puts the dark one back to the light one, and resetting the light one
  resets both), and an optional square symbol. SVG, PNG or WebP, at most 2 MB; an SVG passes a
  strict allowlist (static drawing only; a script, `foreignObject`, an `on*`
  attribute, an external reference or an `@import`/`url()` other than
  `#local` is refused). Each control previews its file on a light and a dark
  tile (what light and dark surfaces wear) and puts the brand's default back.
  The old logo, favicon and PWA icon URL fields are gone from the page; their
  columns are kept, and a value in them works as before wherever no upload
  replaces it: the card lists such a value, read-only, with "Clear".
- Stored: storage keys only (`platform/brand/<uuid>-<variant>.<ext>`, twelve
  nullable columns on `platform_branding`, the email PNGs' sizes among them),
  never a URL; the URLs are derived for whichever storage provider is
  primary. Uploads live in each brand's own storage and database, never in
  `dist`. A replaced or reset file is deleted, except the email PNGs: every
  email already sent shows its logo from that URL, so they stay in storage
  (a few KB each, one key per upload; nothing cleans them up).
- PNG copies: email clients show no SVG, and the backend has no image library,
  so the Super Admin's browser draws them when the file is uploaded
  (`src/lib/brandRaster.ts`): the logo's email copy (120 px high, 3x the 40 px
  an email shows) and the symbol's icons (180 px opaque on the PWA background
  colour, 192 and 512 px). The server checks their PNG headers only. The
  kits' email PNGs are committed (`public/brand/webyar/email/`, removed from
  the RESPOK build with the rest of WebYar's folder; `public/brand/intl/email/`).
- Who follows it: the panel (`BrandLogo`, `BrandLockup`, `BrandWordmark`,
  `BrandFooter`, the receipt, the mobile sign-in, the boot splash from the
  cached `wy-brand-assets`), the favicon, home-screen icon, PWA manifest and
  browser notifications (from the symbol), the chat and call widgets'
  "powered by", the platform's own help center (an uploaded logo at its head
  and an uploaded symbol as its tab icon, at app.<brand>/help, which is the
  SPA, `src/pages/public/kb/HelpBrandHead.tsx`, and on the server-rendered
  pages, `server/routes/kb.ts`; it never wore the kit's, so without an upload
  it is as before, and a customer's help center shows nothing of the
  platform's), and the emails (`resolveBrandAssets(config).logoPng`).
- What stays kit art: the animated launcher glyphs, the splash loader, the
  t1/t2 hero watermarks and marks, and the call widget panel's inline lockups
  when nothing was uploaded. The native apps' icons and in-app marks stay in
  their binaries.
- One resolver on each side: `server/services/platformBrandAssets.ts`
  (`resolveBrandAssets`, memoised with the public config and cleared by the
  `platform` cache bus; `brand_assets` in the public config carries the
  uploads' URLs only) and `src/lib/brandAssets.ts` (`useBrandAssets`,
  `BrandImage`). Tests: `src/test/branding/`,
  `src/test/widget/uploadedLogoCredit.test.ts`,
  `src/test/integration/platformBrandAssets290.pg.test.ts`.
- Rollout: WebYar applies 290 by hand before the merge; RESPOK's migrator on
  push. Before 290 the code reads no upload and everything shows the kit.

### RESPOK's chat button (International edition only)

Every template wears the RESPOK kit's Thread chat button
(`Shared/Code/widget/respok-launcher.js` v1.0.0, `style: 'thread'`) when the
bootstrap says `edition: 'international'`; the Iranian edition, an unknown
edition and an older backend never do
(`src/test/widget/respokLauncher.test.ts`). It is ported into the loader's
own launcher the same way as WebYar's (`shared/respokLauncher.ts`, the same
strings in `loader.js`, its own `<style data-rpk-kit>` only when worn; no
extra global, no inline handler, no font request): Ink #16142B ground with the
white question pill and the Signal #FF5A3C answer pill, 60px at 100%; hover
scale 1.06, pressed .94, keyboard focus ring (white gap + Signal); open turns
the glyph away and the chevron in; unread is the Signal Deep #D3361A badge
(springs in, bumps on the next message) and a new message slides the answer
pill in; outside working hours the answer pill is an outline in Away #A9A7BC.
prefers-reduced-motion: no movement, 120ms fades. A workspace colour other
than `#3B82F6` keeps its own solid colour and the pills are drawn in its icon
colour (away outlines in that colour); its own icon, image, shape, size,
label and position work as before. The panel still opens from the same
corner and the launcher still slides away while it is open. The kit's 48px
phone size is not used: the loader keeps the configured size on phones.

RESPOK's chat button is in the loader's `@intl-kit` block: the Iran (WebYar)
build leaves it out, so a WebYar deployment switched to the International
edition shows the plain launcher with no other brand's art; RESPOK's build
keeps it. The marker is the widgets' copy of the dashboard's `SHIPS_INTL_KIT`
(`shared/buildBrand.ts`; `scripts/build/widgetBrand.mjs`,
WIDGET_TEMPLATE_RULES.md §5), so the dashboard's live preview and launcher
picker draw RESPOK's kit in RESPOK's build only, as the loader does. With
the `t1-intl` / `t2-intl` option `logoDirection: 'open'`, the button draws
the Open logo (a bubble; the Signal dot springs in with a new message), the
shell gets `lg-open` (else `lg-thread`), and the credit uses
`respok-open-horizontal-color.svg`. `intl` reads no option and stays Thread.
The launcher styles (`runtime-fab.css`, WIDGET_TEMPLATE_RULES.md §2) dress the
kit's button like any other; the kit's square (18px) is the Iranian kit's
only.

The call widget has no platform-branded button (its launcher shows the
workspace's logo or a phone), so it is unchanged. The favicon and PWA icons
in `public/brand/intl/` are already the kit's Thread `signal` web set,
byte for byte.

### Message layout (both editions)

The message-list polish of #286 (quote/copy buttons beside the bubble instead
of in the layout, meta flush with the bubble, grouped corners and rhythm,
own-direction text with `unicode-bidi: plaintext`, avatar on the last bubble,
quieter day divider, composer hairline) is in `presentation-intl.css` for
RESPOK and, in WebYar's measures and colours (ink #12141F, a borderless
#EEF1F4 operator bubble, a 22px Persian line box), at the end of
`presentation-default.css` for WebYar. Every selector of the latter is also
set by the intl skin, which loads after it, so RESPOK's rendering does not
move (`phase4Widgets.test.ts`).

### Where the International brand comes from

No new column was needed. The International edition's words come from what the
Super Admin already maintains:

- **Product name** — `platform_branding_localized.platform_name`, per
  language (Super Admin → Branding), the same source as the panel title,
  e-mails and the chat widget credit. A language without a row uses English,
  then any row, then the site's host name. WebYar's name is never a fallback.
- **Site address** — `platform_domains.canonical_base_url`, else
  `public_base_url`, else `https://<primary_domain>` (Super Admin → Domains).
- **Support e-mail** — `support@<site host>` (without `www.`), from the same
  row.

### First paint on a first visit

`index.html` asks for `/api/platform/public/boot.js` only when the browser has
no cached edition, and never blocks on it: the script is `async`, the page and
the bundle start at once. Until it answers — at most 1.5 s — the splash keeps
its brand area hidden (`html.wy-boot-pending`), so neither brand flashes; the
answer dresses it (RESPOK's kit, or WebYar's as always) and is remembered. A
failure or a timeout shows today's default splash; an answer after the
timeout is only remembered (for the app and the next visit). Returning
visitors read their cache and send no request. If the bundle mounts before a
late answer, the first screen follows the default until the public config
arrives.

`shared/brand.ts` (`brandTokensFor`, `brandContactFromDomains`) derives them;
the public config (`GET /api/platform/public/config`, new `brand` block) and
`boot.js` carry them to the browser, which caches them in localStorage
(`wy-edition`, `wy-brand`, `wy-default-locale`, `gs_title:<locale>`).

The Iranian edition's words are fixed in `IRAN_BRAND` and are not read from
the database, so WebYar's text cannot change whatever its branding rows say.

### Brand tokens in text

Translations and other copy carry the brand as tokens, filled by `t()` for
every translation (and by `fillBrandTokens` elsewhere):

| Token | Iran (en / fa / tr) | International |
| --- | --- | --- |
| `{{brand}}` | Webyar / وب‌یار / Webyar | `platform_name` in the language |
| `{{brandLatin}}` | Webyar | English `platform_name` |
| `{{brandPlugin}}` (the WordPress / OpenCart / WHMCS plugin's name) | Web Yar | English `platform_name` |
| `{{supportEmail}}` | info@webyar.ai | support@<site host> |
| `{{siteUrl}}` | https://webyar.ai | the site address |

Each token was placed where the old literal had exactly that spelling, so the
Iranian text is the old text byte for byte.
`src/test/edition/fixtures/iranBrandLines.json` pairs every changed line with
the line it replaced and `phase5Brand.test.tsx` proves the pairs, and that no
locale line carries a token the fixture does not cover. **When adding copy
that names the product, write a token, never "Webyar"** (and add the line to
the fixture only if it replaces an existing Iranian string).

Deliberately left as they are, because they are names of real things, not the
brand in prose: repository paths and project names in the Super Admin's iOS
guide (`ios/Webyar`, `Webyar.xcodeproj`, the `Webyar` scheme), file names
(`Webyar-Android.apk`, `webyar.ocmod.zip`, `modules/addons/webyar/`,
`/downloads/webyar-*.zip`), the App Store review account (`apple@webyar.ai`),
the native app's user agent label in Security (`Webyar`), plugin protocol
paths (`/wp-json/webyar/v1`, `X-WebYar-Correlation`), storage keys, push
channel ids and other internal identifiers, and code comments. The commerce
plugins themselves still call themselves "Web Yar" inside WordPress, OpenCart
and WHMCS until brand-parameterised builds exist.

## Widget templates per edition

`shared/widgetTemplates.ts` is the registry for both widgets:

- `CHAT_WIDGET_TEMPLATES` / `CALL_WIDGET_TEMPLATES` — each template's asset
  file names.
- `EDITION_CHAT_WIDGET_TEMPLATES` / `EDITION_CALL_WIDGET_TEMPLATES` — per
  edition, its `default` and every template it `offered`s.
- `resolveChatWidgetTemplate(edition, requested)` /
  `resolveCallWidgetTemplateForEdition(edition, requested)` — a stored or
  requested id is worn only when the edition offers it; anything else is the
  edition's default. `null` (unknown) is Iran.

For the chat widget, `offered` is what the edition's build ships; which of
those a workspace may wear is the Super Admin's catalog (below).

Today:

| Id | Edition | Chat widget | Call widget |
| --- | --- | --- | --- |
| `default` | Iran | `presentation-default.js` + `.css` + `-fonts.css` | `presentation-default.js` + `presentation-default.css`, and on the visitor's first intent the panel pair `presentation-default-panel.js` + `.css` |
| `t1`, `t2` | Iran (offered; disabled until the Super Admin enables them) | `presentation-t1.js` + `.css`, `presentation-t2.js` + `.css`, over the shared `presentation-default-fonts.css` | — |
| `intl` | International | the same renderer and stylesheet, then the skin `presentation-intl.css` | the same core script (registered as `intl` too, root class `ccw-presentation-intl`) and panel pair + its skin `presentation-intl.css` |
| `t1-intl`, `t2-intl` | International (offered; disabled until the Super Admin enables them) | Template 1's / Template 2's renderer, stylesheet and extras unchanged, then the skin `presentation-t1-intl.css` / `presentation-t2-intl.css` (RESPOK's tokens, Ink accent, Signal rings, Figtree, the brand art as CSS masks), over the shared `presentation-default-fonts.css` | — |

The `-intl` skins follow the handoff's RESPOK boards
(`docs/chat-widget-handoff/IMPLEMENTATION_NOTES.md`, "RESPOK"). The
renderers know nothing of RESPOK: an uncustomised accent (empty, `#3B82F6`
or unparseable) writes no inline colour and puts the class `gs-accent-brand`
on the view roots and the panel's close button, so each stylesheet gives its
own brand colour and hero (Template 1 and 2: WebYar's teal `#0B7D6C`; the
`-intl` skins: Ink `#16142B`); a chosen colour is written inline as before.
Latin text in the `-intl` skins is Figtree (variable, one Latin file and one
Turkish-letters file in `presentation-default-fonts.css`, each face fetched
only when its letters are on screen; SIL OFL, `public/widget/fonts/OFL-Figtree.txt`,
cut by `scripts/fonts/subset-widget-fonts.py --figtree`); Persian stays
IRANSans with Template 1's / 2's line heights; code is the system
monospace. `prepare()` warms Figtree instead of Inter for an `-intl` id (in
Turkish both files: that first paint draws ğ, ş, İ).

### The chat widget template catalog and the workspace's choice

Migration `275_widget_template_catalog.sql`; the rules are
`shared/chatTemplateCatalog.ts` (server and dashboard alike).

- **Super Admin → Widget settings → Widget templates**
  (`GET` / `PUT /api/admin/widget-catalog`, `server/routes/adminWidgetCatalog.ts`):
  per edition (`widget_edition_settings.chat_templates`, one row per edition,
  service_role only), for each template the edition offers: enabled or not,
  display names in fa / en / tr, the order, the option defaults, and which one
  is the default. Only the running edition's row (`getPlatformEdition`; 503
  while unknown) and only its offered ids. A save is audited
  (`admin.widget_catalog.changed`) and publishes `platform`; the page shows
  how many workspaces chose each template and how many follow the default,
  and asks before disabling a template in use or moving the default.
- **No row, a template never saved: disabled**, except the edition's default
  (`default` / `intl`). A deploy, and a new template in `offered`, therefore
  change nothing for any visitor until the Super Admin enables it. At least
  one template stays enabled, and the catalog's default is an enabled one.
- **Display names are dashboard labels only**: they live in the catalog,
  never in an id, a file name, a class or the widget config, and the Super
  Admin renames at any time. Unnamed, the dashboard shows its i18n default
  (`widgetCatalog.names`: «آشنا» / «فیروزه» / «نسیم», Familiar / Turquoise /
  Breeze, Tanıdık / Turkuaz / Esinti; for `t1-intl` / `t2-intl` «کلاسیک» /
  «ساده», Classic / Simple, Klasik / Sade), brand-neutral like every locale
  text. No catalog row is seeded for them: RESPOK's Super Admin enables them.
- **Workspace → Widget → Appearance → Widget template**
  (`GET /api/widget-settings/:workspaceId/templates`; the choice through the
  ordinary settings `PATCH`): the picker shows only with two or more
  templates enabled; with a single one, the card shows only that template's
  own options (if it has any). `widget_settings.widget_template_id` (NULL =
  follow the default; picking the entry badged "Default" stores NULL, and so
  does a click on it while the stored choice is unavailable, which clears
  that choice) is worn while enabled and while the plan allows
  `widget_appearance`; otherwise the catalog's default. A disabled choice is kept and comes back when the
  template is enabled again. The `PATCH` refuses an id that is not enabled
  (400 `template_not_available`) and answers 409 `migration_required` before
  275; a plan without the Appearance editor gets 403 `plan_upgrade_required`
  (the card is shown disabled with the upgrade hint).
- **Template options** (`widget_settings.widget_template_options`, one flat
  object; unknown keys dropped, invalid values refused): Template 1 reads
  `navStyle` (`vb` default, `va`, `vc`, `vd`), `navMode` (`active` default,
  `both`, `icon`, `text`, `none`), `topics` (up to 4 × `{label ≤ 24, icon}`),
  `prechatMode` (`card` default, `steps`) and `transcriptEmail` (boolean,
  default on); Template 2 `topics`, `askExamples` (up to 2 × ≤ 60
  characters), `csat` (the rating after a chat, boolean, default on) and
  `transcriptEmail`. `t1-intl` and `t2-intl` read their base template's keys
  plus `logoDirection` (`thread` default, `open`): the brand kit's logo
  direction. The loader puts `lg-thread` / `lg-open` on the shell and draws
  that direction's chat button, the server names that direction's lockup
  for the footer's credit, and the skins draw that direction's art (the home
  header's watermark, Template 1's greeting avatar and Messages tab icon, the
  launcher greeting's corner and place). Topic icons: `truck`, `return`, `ruler`, `card`, `box`,
  `chat`, `help`, `gift`, `clock`, `tag`. Merged code defaults → the Super
  Admin's option defaults → the workspace's, they reach the widget as
  `config.templateOptions` (`{}` for `default`) next to `templateId`. The
  dashboard's live preview renders the same effective template and options.
  The server reads the same effective template and options
  (`configSnapshot.ts` `workspaceChatTemplate`) before it writes the closed
  line (only for a template whose descriptor has `closedNotice`) or serves a
  rating or a transcript, so it never treats a `default` / `intl` workspace
  as wearing Template 2. Both editions run the same code and their own
  email template rows (`visitor_conversation_transcript`, migration 276).
- **Order of deploys:** every read tolerates a database without 275 (no
  table: no catalog, i.e. today's look; no column: the choice reads as none),
  so RESPOK's backend may start before its migrator. WebYar's database is
  migrated by hand before the merge.

The bootstrap names the assets, so the browser never guesses:

- chat widget (`GET /api/widget/config`): `templateId`, `presentationUrl`,
  `presentationStyleUrl`, `presentationFontsUrl` as before, plus the additive
  `presentationSkinUrl` (null in Iran), `edition`, `platformBrandName`,
  `calendar` (`jalali` / `gregorian`) and `timeZone` (`Asia/Tehran` / null).
  `POST /api/widget/bootstrap` adds `edition`.
- call widget (`GET /api/call-widget/bootstrap`): `assets.presentation_*_url`
  and `config.widget_template_id` for the edition's template, plus the
  additive `edition`, `calendar`, `time_zone` and, in the International
  edition only, `platform_brand.names` and `powered_by` (the Iranian runtime
  keeps its own fixed credit, so nothing is read for it).

Embeds on customer sites keep working unchanged: the loader URLs, the embed
snippets and every existing bootstrap field are as they were. A loader that
predates the skin field ignores it and shows the base look; a missing skin
file is never fatal.

### Adding a template for an edition

Every template follows `docs/operations/WIDGET_TEMPLATE_RULES.md` (fonts,
caching, pure renderers, size budgets), enforced for every descriptor by
`src/test/widget/templateRules.test.ts`; the step-by-step procedure is the
`widget-template` skill (`.claude/skills/widget-template/SKILL.md`).

1. Ship the assets in `public/widget/` (chat) or `public/call-widget/` (call),
   named `presentation-<id>.js` / `presentation-<id>.css` (the build hashes
   every `presentation-*.js|css` it finds; a script needs a stylesheet of the
   same name, a stylesheet alone is fine).
   - A restyle of an existing renderer: only a stylesheet. Chat widget: a
     skin (`skin`), loaded after the base stylesheet, overriding the `--wy-*`
     tokens. Call widget: a complete stylesheet, plus a `registry.register('<id>', …)`
     in the presentation script it reuses.
   - A new renderer: its own script registering
     `window.__gs_presentation_<id>` (chat) or
     `CallWidgetPresentations.register('<id>', …)` (call).
2. Describe it in `shared/widgetTemplates.ts` (`CHAT_WIDGET_TEMPLATES` /
   `CALL_WIDGET_TEMPLATES`) and add the same entry to the browser registry
   (`public/widget/presentation-registry.js`; the call widget registers in its
   presentation script). A chat renderer that declares Core features
   (`features` from `create()`) has `coreFeatures: true`: /config then names
   Core's lazy module runtime-ext.js for it (`modules.ext`) and the loader
   fetches it with the template's files (WIDGET_TEMPLATE_RULES.md §2). Its
   markup no first paint needs goes in its **extras**,
   `presentation-<renderer>-x.js` (descriptor `extras`; a skin names its
   renderer's file, and the handshake id is the renderer's): /config then
   also names `modules.extras` and Core's late module `modules.late`
   (runtime-late.js), which runtime-ext.js requests after the first paint
   and applies together or not at all; the loader is not involved. A
   renderer that draws the closed line and its rating card also sets
   `closedNotice: true` (the server writes that row only for such
   templates). `coreFeatures`, `extras` and `closedNotice` must match the
   renderer, and its `csat` / `chatMenu` features the template's `csat` /
   `transcriptEmail` options the server checks
   (`src/test/widget/runtimeExt.test.ts`); `default` and `intl` have none
   of them, so their payloads stay byte-identical.
3. Offer it to an edition in `EDITION_*_TEMPLATES` (`offered`), and make it
   the edition's `default` if it should be worn without a choice. The call
   widget settings page lists `offered`; `PUT /api/call-center/settings`
   accepts an id only when the edition offers it
   (`callWidgetTemplateIdSchema` lists every known id). A chat widget template
   in `offered` is still disabled until the Super Admin enables it in the
   catalog; if it has options, list them in `CHAT_TEMPLATE_OPTIONS`
   (`shared/chatTemplateCatalog.ts`) and name it in `widgetCatalog.names` /
   `descriptions` (`src/i18n/widgetCatalog.ts`). No migration is needed.
4. Never change the Iranian edition's `default` unless WebYar's look is meant
   to change for everyone who never chose. Adding to its `offered` changes
   nothing for visitors until the Super Admin enables the template and a
   workspace picks it (or the Super Admin makes it the default).
5. Tests: `src/test/edition/phase4Widgets.test.ts` checks that every
   descriptor's files exist and match the browser registry;
   `src/test/widget/chatTemplateCatalog.test.ts` the catalog rules.

The call widget keeps its per-workspace id
(`call_center_settings.widget_template_id`), honoured whenever the edition
offers it; it has no Super Admin catalog.

## start.sh is obsolete — checklist

RESPOK's frontend container rewrote the built bundle at start with `sed`. Each
rule is now done at run time from the edition and the platform's own
settings. After deploying this code, check each line on RESPOK, then retire
`start.sh`.

**Prerequisites on RESPOK's database** (no migration; Super Admin screens):
`platform_settings.region_mode` is not `iran`; `platform_branding_localized`
has `platform_name = 'RESPOK'` for each language it serves;
`platform_domains.primary_domain = 'respok.app'` (or `canonical_base_url =
https://respok.app`), which gives `support@respok.app`; `default_locale` is
the language a first visit should open in (`en`).

| start.sh rule | Now | How to check on RESPOK |
| --- | --- | --- |
| `WEBYAR AI` → `RESPOK` | the launch screen's label is the platform's name in the International edition (`index.html` boot script, `BrandLoaderScreen`); "WEBYAR AI" is Iran-only | private window → app.respok.app: the splash's `aria-label` is RESPOK |
| `"WEBYAR"` → `"RESPOK"` | `BrandLogo`'s default alt and `BrandLockup`'s alt are the platform's name abroad | sign-in page: logo alt is RESPOK |
| `>WEBYAR<` → `>RESPOK<` | the wordmark is drawn from the RESPOK kit in the International edition (`BrandFooter`, `BrandWordmark`, splash footer) | splash and auth pages show the RESPOK logo, no "WEBYAR" text |
| remove the "AI" suffix span (`wy-ai`) | the "AI" suffix exists only in the Iranian wordmark; the International footer is the kit's image | no "AI" next to the logo |
| `Web Yar` / `WebYar` / `Webyar` → `RESPOK` | brand tokens in every translation, push copy, legal pages, the call widget credit, the mobile sign-in fallback, the notification template preview and the admin test push | Plugins → WooCommerce/OpenCart/WHMCS steps, Settings → Notifications hints, a privacy-mode push, /privacy, the call widget footer all say RESPOK |
| `info@webyar.ai` → `support@respok.app` | `{{supportEmail}}` = support@<site host> from `platform_domains` | /contact and /privacy show support@respok.app; the form opens a mail to it |
| `(e.g. https://webyar.ai)` → `(e.g. https://respok.app)` | `{{siteUrl}}` | Super Admin → Mobile app → website URL hint |
| Persian toasts → English (new version / refresh / intro message on, off, saved / saving failed) | i18n keys `appUpdate.*` and `aiAgent.settings.texts.*` (the whole AI agent settings card, not only its toasts) in the reader's language | AI agent → Settings in English: toggle and save the intro message; the PWA update prompt is English |
| `runtime-config.js` `defaultLocale` fa → en | the International edition opens in the platform's `default_locale` (from `boot.js` on a first visit, the public config after); the deployment file's value is used by the Iranian edition only | private window → app.respok.app opens in English (boot.js answered before the bundle mounted) |
| favicon / apple-touch → `/storage/brand/respok-icon.svg` | the kit's icons (`public/brand/intl`) from the cached edition, and on a first visit from `boot.js` (`index.html`, `PlatformBrandingGate`); a symbol uploaded in Super Admin → Branding replaces them (no `/storage/brand/...` file is used) | private window: the tab icon is RESPOK's from the first paint |
| bundled `webyar-logo` png → `/storage/brand/respok-mark.svg` | `BrandLogo` shows the kit's app icon in the International edition, or the uploaded symbol | sidebar fallback, auth screens and legal pages show the RESPOK mark |

Also new for RESPOK, with no start.sh rule before: the chat and call widgets
wear the `intl` template, the call widget credits RESPOK (or nothing, per the
platform switch and plan gate), and Persian widget dates are Gregorian in the
visitor's time zone.

Quick server checks:

```sh
curl -s https://app.respok.app/api/platform/public/boot.js
# window.__PLATFORM_BOOT__={"edition":"international",...,"names":{"en":"RESPOK",...},"supportEmail":"support@respok.app",...};
curl -s 'https://api.respok.app/api/widget/config?workspace_id=<id>' | jq '{templateId, presentationSkinUrl, edition, calendar, timeZone}'
# {"templateId":"intl","presentationSkinUrl":".../presentation-intl.<hash>.css","edition":"international","calendar":"gregorian","timeZone":null}
```

On WebYar the same calls give `"edition":"iran"`, `templateId` `default`,
`presentationSkinUrl` null, `calendar` `jalali`, `timeZone` `Asia/Tehran`.

Note: the shared bundle still contains WebYar's words (they are the Iranian
edition's defaults), so grepping the RESPOK bundle for "Webyar" is not a
test; the checks above are.
