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
Persian in the International edition is only right-to-left Persian text:
never the Iranian brand, calendar, currency, gateways or time zone.

## What differs per edition

| Area | Iran | International | Where |
| --- | --- | --- | --- |
| Money | Toman (stored IRR), Iranian gateways, wallet, AI-credit top-up | USD (TRY on a Turkish-only site), international gateways only | phases 1–3, `shared/edition.ts` |
| Calendar / time zone | Jalali, Asia/Tehran | Gregorian (Persian digits kept), the viewer's zone or UTC | `src/lib/date.ts`, server formatters |
| Phone / SMS / Bale | +98, Iranian SMS vendors, Bale | no national default, no SMS verification, no Bale | phase 3 |
| Brand kit (logos, favicon, PWA icons, launch loader) | WebYar's (`src/assets`, `public/favicon.png`) | RESPOK's (`public/brand/intl`, `INTL_BRAND`) | `shared/internationalMode.ts`, `index.html`, `BrandLogo`, `BrandLoader`, `PlatformBrandingGate` |
| Panel colour scheme `respok` | never offered | offered | `shared/panelThemes.ts` |
| Brand in text | WebYar's fixed words ("Webyar", "وب‌یار", "Web Yar", info@webyar.ai, https://webyar.ai) | the platform's own name, site and support address | `shared/brand.ts`, `src/lib/brand.ts` |
| First paint (before the bundle) | as before | edition, brand, title and default language from `/api/platform/public/boot.js` on a first visit (loaded asynchronously, never blocking; see below), the cache after | `index.html`, `server/routes/platformPublic.ts` |
| Default UI language | `runtime-config.js` `defaultLocale` | the platform's `default_locale` (Super Admin → Languages) | `src/i18n/index.tsx` `getSiteDefaultLocale` |
| Chat widget template | `default` | `intl` (skin over the same renderer) | `shared/widgetTemplates.ts` |
| Call widget template | `default` | `intl` (own stylesheet, same markup) | `shared/widgetTemplates.ts` |
| Call widget "powered by" | "Powered by Web Yar" / «قدرت گرفته از وب یار» / "Web Yar tarafından desteklenmektedir", exactly | the localized label with the platform's logo in the brand's place (the RESPOK kit's horizontal mark, 14px, alt = platform name, the name if the image fails), its link, hidden by the platform switch or the plan gate (as the chat widget) | `server/routes/callWidget.ts`, `public/call-widget/runtime.js` |
| Chat widget credit | English `platform_name` as text (as before) | the label and the platform's logo (`poweredBy.logo`, absolute from the widget asset base; the name if the image fails) | `server/routes/widget.ts` |
| Widget dates (Persian) | Jalali, Tehran day boundaries | Gregorian, the visitor's zone | `calendar` / `timeZone` hints in the bootstrap |
| Push notification copy | "Webyar", "New message in Webyar", «پیام جدید در وب‌یار» | the platform's name | `server/services/push/dispatch.ts`, `platformSettings.ts` `defaultPushTemplates` |
| Legal pages (/privacy, /terms, /contact) | "Webyar", info@webyar.ai | the platform's name and support address | `src/pages/public/legal` |
| Desktop apps (Windows, Mac) | WebYar's builds: `Webyar.exe` / `Webyar.app`, feeds `pc30cc/webyar-desktop-releases` and `pc30cc/mac-os`, downloads on app.webyar.ai | RESPOK's builds of the same source: `Respok.exe` / `RESPOK.app`, feeds in `pc30cc/respok-releases`, downloads on app.respok.app; Super Admin → Windows app / macOS app default to them and never serve a WebYar feed, link or note (a cloned value is replaced) | `shared/nativeAppBrands.ts`, `windows-native/src/Webyar.Core/Config/Brand.cs`, `macos/Webyar/Core/Config/AppBrand.swift`, `deploy/app-downloads/` |

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

Today:

| Id | Edition | Chat widget | Call widget |
| --- | --- | --- | --- |
| `default` | Iran | `presentation-default.js` + `.css` + `-fonts.css` | `presentation-default.js` + `presentation-default.css` |
| `intl` | International | the same renderer and stylesheet, then the skin `presentation-intl.css` | the same script (registered as `intl` too, root class `ccw-presentation-intl`) + its own complete `presentation-intl.css` |

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
   presentation script).
3. Offer it to an edition in `EDITION_*_TEMPLATES` (`offered`), and make it
   the edition's `default` if it should be worn without a choice. The call
   widget settings page lists `offered`; `PUT /api/call-center/settings`
   accepts an id only when the edition offers it
   (`callWidgetTemplateIdSchema` lists every known id).
4. Never add a template to the Iranian edition's `offered` or change its
   `default` unless WebYar's look is meant to change.
5. Tests: `src/test/edition/phase4Widgets.test.ts` checks that every
   descriptor's files exist and match the browser registry.

An admin choice per workspace can be added later without changing the Iranian
output: store the id (`call_center_settings.widget_template_id` already
exists for the call widget; the chat widget reads `widget_template_id` from
the workspace or platform row when such a column is added) and the resolvers
honour it whenever the edition offers it.

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
| favicon / apple-touch → `/storage/brand/respok-icon.svg` | the kit's icons (`public/brand/intl`) from the cached edition, and on a first visit from `boot.js` (`index.html`, `PlatformBrandingGate`) | private window: the tab icon is RESPOK's from the first paint |
| bundled `webyar-logo` png → `/storage/brand/respok-mark.svg` | `BrandLogo` shows the kit's app icon in the International edition | sidebar fallback, auth screens and legal pages show the RESPOK mark |

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
