# Widget template rules

Every template of the website chat widget (`public/widget/`) and of the call
center widget (`public/call-widget/`) follows these rules: the shipped ones,
and every new design added later. Each rule exists because the widget once
broke it, and the cost landed on every visitor of every customer site.

Most rules are enforced: `src/test/widget/templateRules.test.ts` runs them
against every template listed in `shared/widgetTemplates.ts`
(`CHAT_WIDGET_TEMPLATES`, `CALL_WIDGET_TEMPLATES`), so a new template is
checked the moment it is described there, in CI (`npm test`). The rest are
checked by the other tests named below, or are review rules.

How to add a template, step by step: `.claude/skills/widget-template/SKILL.md`
(the same procedure, for people and for Claude sessions). How editions pick
templates: `docs/operations/EDITIONS.md`.

## 1. What a template is

- Chat widget: a renderer `presentation-<id>.js` (pure functions: view-model
  in, HTML out), a stylesheet `presentation-<id>.css`, optionally a skin
  (`presentation-<id>.css` loaded after another template's stylesheet, for a
  restyle that reuses a renderer), and a fonts stylesheet
  (`presentation-<id>-fonts.css`, or the shared
  `presentation-default-fonts.css`).
- Call widget: a presentation `presentation-<id>.js` (or a registration in an
  existing one) and a stylesheet `presentation-<id>.css`.
- Chat widget, optionally: the renderer's extras `presentation-<renderer>-x.js`,
  its markup that no first paint needs (t1's emoji grid; the late surfaces of
  issue #340 as they come). It registers `window.__gs_mod_extras = { id, v,
  create(H) }`: `id` is the RENDERER's (a skin over t1 wears t1's file), `v`
  the version of its contract with the renderer, `create(H)` returns the
  surfaces, built on the renderer's helpers `H`. The renderer keeps a one-line
  delegate per surface (`function cardHtml(vm) { return x('cardHtml', [vm]); }`):
  until Core hands the file over (`renderer.extend(mod)`, which takes only its
  own id and version) `x()` draws nothing and notes the miss, and Core repaints
  once when the file is in. The chat frame is built once, before any extras: a
  frame surface in them (the emoji grid) is put in by Core when they come. Its
  rules stay in the template's stylesheet (no `-x.css`). Change `v` in both
  files whenever a surface's arguments or `H` change.
- The descriptor in `shared/widgetTemplates.ts` and the browser registry
  (`public/widget/presentation-registry.js`; the call widget registers in its
  presentation script) name the same files under the same id (`extras` too,
  null without).
- Prefer a skin over a new renderer: a skin is ~1 KB for its visitors and no
  second renderer to keep in step with every runtime feature.

## 2. Delivery and caching (never change these per template)

- The build content-hashes every `presentation-*.js|css` it finds
  (`scripts/widget-hash.js`, `scripts/call-widget-hash.js`). Never reference
  a template file by its fixed name in code, and never add `?v=` to a hashed
  URL: the hash in the name is its version.
- Hashed files are served `public, max-age=31536000, immutable` with ONE
  Cache-Control header (`expires off;` in the nested nginx location, which
  would otherwise inherit the parent's `expires -1`), CORS `*`, gzip_static,
  and a missing hashed file is a `no-store` 404 (`@missing_widget_asset`), so
  a rolling deploy can never pin a 404 for a year. Pinned by
  `src/test/perf/assetDelivery.test.ts`; check a change with a real nginx
  (`nginx -t` on the rendered template) before shipping it: a broken
  `nginx.conf.template` takes app.webyar.ai down at container start, and any
  `${` in it other than `${BACKEND_URL}`, even in a comment, stops the
  container (docker-entrypoint.sh).
- Chat widget: template files load only when the visitor opens the panel, a
  nudge shows, or the visitor shows an open intent (pointer over the
  launcher, a touch on it, keyboard focus: `onOpenIntent` in loader.js), never
  on a page view alone. Only the selected template's files are requested. An
  intent also preconnects (crossorigin) to the API and the fonts' host, the
  two uncredentialed connections a first open needs; runtime.init() still
  waits for a real open.
- Call widget: its presentation mounts at page load (the launcher lives in
  it), so every byte of a call template is paid on a first page view. l.js
  does not request its scripts early inside the host page's load (a script
  requested before the load event delays it by its download): at once on a
  loaded page, else at the load event or when the bootstrap answers,
  whichever is first (a bootstrap answering first still starts them inside
  the load, as it always did).
- Renderer features (chat): a behaviour a template needs beyond what Core
  does for `default` (search as you type, tab badges, a visible typing row,
  the home ask field, …) is declared by the renderer (`features` returned
  by `create()`) and lives in `public/widget/runtime-ext.js`, a lazy Core
  module (ModuleLoader name `ext`, content-hashed like the other modules).
  The template's descriptor says so (`coreFeatures: true` in
  `shared/widgetTemplates.ts`, checked against the renderer): /config then
  names the module (`config.modules.ext`, for such a template only, so the
  `default` and `intl` payloads are unchanged) and the loader requests it
  in the same pass as the template's files (after runtime.js), so it is in
  the browser's cache by init. runtime.js requests it again when such a
  renderer is mounted (a cache hit; the request the loader did not make,
  with the canonical-name retry) and holds that template's first paint on
  the skeleton until it is in, at most 1.5 s (a failed request releases at
  once, a late module repaints with what Core saw meanwhile). Painted
  without the module, the panel carries the class `ext-off` (removed when a
  late module mounts): the template's stylesheet sets aside the controls
  only the module answers (t1's home search; t2's ask field, which then
  opens a chat, and its topics), never a dead control. runtime.js,
  which every visitor of every template downloads on a first open, keeps
  only the hook points (`ext('<hook>', …)`, a no-op without the module):
  never put feature code there (`src/test/widget/runtimeExt.test.ts` checks
  both files agree, that `default` never requests the module and that the
  descriptors match the renderers; `loaderOpenIntent.test.ts` the loader's
  request). Sizes on 2026-10-17 (gzip 5, as shipped): runtime.js 54.6 KB,
  of which the hook points are 0.8 KB (53.8 KB before the first features);
  runtime-ext.js 6.2 KB; the loader's request 0.05 KB.
- The late pack: what a template draws only after its first paint (the
  extras, §1) and Core's code for it (`public/widget/runtime-late.js`,
  ModuleLoader name `late`, gated by `feat()` like runtime-ext.js). Both are
  hashed (`scripts/widget-hash.js`; the extras need no stylesheet of their
  own, but their renderer) and named by /config (`config.modules.extras`,
  `config.modules.late`) only for a template with `coreFeatures` and
  `extras`, so the `default` and `intl` payloads are unchanged. runtime-ext.js
  (never the loader) requests them together after the first paint (the
  browser's next idle moment, 2 s at most; 300 ms without
  `requestIdleCallback`), at once when the chat view is painted or a control
  needs them (t1's emoji button); a skeleton (`.wy-skeleton`) is not that
  paint, so nothing competes with the data it waits for. They load with the
  canonical-name retry, and runtime-ext applies them together or not at
  all: the renderer refuses extras of another
  template or version, runtime-ext a late module of another version
  (`v`), and then neither is used, so a canonical-name fallback from another
  deploy never half-applies. A feature of the pack is never a dead control
  before it is in or if it never comes: its markup is drawn only through the
  extras, and a base control that needs them (t1's emoji button) asks for
  them on a first press and goes if they fail or hold nothing for it
  (`hidden`; `.ext-off` without runtime-ext.js). runtime-late.js registers
  its handlers on runtime-ext's hooks (`api.on(hook, fn)`): runtime-ext's own
  handler runs first, then the late ones, each of which may consume or
  override its answer. The operator preview (`WidgetLivePreview.tsx`, which
  has no Core: the extras only) and the screenshot harness
  (`e2e/harness/templateScreens.ts`, both; `--late-after` shoots the live
  order instead) put them on the page before painting.
  `src/test/widget/runtimeExt.test.ts` checks who asks and when, the
  all-or-nothing rule and the one repaint. Sizes on 2026-10-18, after issue
  #340 and its follow-ups (gzip 5, as shipped, both brands): runtime.js
  55.5 KB (54.8 KB after rounds 1–4, +0.2 KB: round 2's closed-row guards,
  the hook points `send`, `away`, `inline`, `reaction`, `kbMeta`, `media`,
  the typing payload and the capability flips; then +0.8 KB for every
  template: the system rows' sentence in the visitor's language,
  `systemRowText`, `default`'s presence label, the hook point `autofocus`
  and the AI's built-in name read as none, `aiOwnName`), runtime-ext.js 7.4 KB (of 8; the pack's loader, the late
  module's API, those hooks' own empty handlers, the typing name, an
  article's author, the control the visitor is on and t1's pre-chat
  header), runtime-late.js
  10.4 KB (of 12: the rating card, the chat bar's menu, reactions, the
  pre-chat one question at a time, the message left while away, the place
  in the queue, the help articles offered while a first message is written,
  a download's progress, the emoji search), presentation-t1-x.js 4.8 KB and
  presentation-t2-x.js 5.9 KB (of 12 each; t1's emoji grid and its search
  field, t2's order card and articles tray, every late surface, out of the
  first paint); the renderers keep their first-open budgets (t1 19.5 KB,
  t2 20.0 KB (19,990 B) in the Iranian build, 19.4 / 19.8 KB in RESPOK's,
  of 20: t2 has 10 B left, so its next surface goes in its extras).
- The emoji search's keywords (`public/widget/runtime-emoji.js`, ModuleLoader
  name `emoji`, `config.modules.emoji` for a template with `coreFeatures`):
  pure data (the renderer rules apply: no network, storage or host), the
  words in English, Persian and Turkish of every emoji t1 and Core draw,
  from the Unicode CLDR annotations (Unicode License v3, noted in its
  header) with the Persian reviewed. runtime-late.js asks for it on the
  search field's first use only, so a visitor who never searches never
  downloads it; 3.8 KB of a 4 KB budget. An emoji added to a picker gets
  its words there too (`emojiSearch.test.ts` checks every one).
- The launcher's styles (`public/widget/runtime-fab.css`, issue #340: the
  pill with the launcher text inside, the classic bubble, two bubbles, the
  agent's face; `fab.shape` / `fab.icon` in `shared/launcherStyles.ts`):
  the launcher is the loader's in every template, so a style is not a
  template's. /config names the hashed file (`config.fabStyleUrl`) only for
  a workspace wearing one, and only then does the loader request it, into
  its shadow root (canonical-name retry), keeping the launcher (and the
  card beside it) unseen until it is in (3 s at most). It restyles the
  loader's own launcher (classes `fx fx-<icon> fx-<shape>`, the pill's text
  in `data-fx`, the agent's initial in `data-fi`, `dir`), so without it the
  launcher is today's, and a launcher without a style is byte for byte as
  before (`launcherStyles.test.ts`). It follows the stylesheet rules of §3 (no
  font, no host, small inline SVGs; `templateRules.test.ts` checks it with
  the template stylesheets) and moves nothing of its own. 1.2 KB of its
  2 KB. The operator preview (`WidgetLivePreview.tsx`) draws the same
  classes and texts and asks for the manifest's runtime-fab.css in its
  frame; `launcherLogoBootstrap.test.ts` follows a style from the
  dashboard's tile through the settings PATCH and /config to each brand's
  built loader and the hashed file it requests.
- A feature's server data is sent on request only, so the API serves
  `default` as before: the thread list's and a history's assigned operator
  (`operator=1`, which runtime.js `operatorQ()` adds only for a renderer
  declaring `conversationOperator`, `chatHeader` or `operatorTyping`; checked
  by `widgetOperatorFields.test.ts` and `operatorFieldsOptIn.test.ts`).
  Without it, `/conversations` and `/history` make no profile read and no
  workspace snapshot lookup of their own. Likewise the word search
  (`match=words` on `/api/widget/kb/search`, sent by runtime-ext.js for
  `kbSearch`; `kbWidgetSearch.test.ts`): without it the route keeps its
  one-phrase search, which every help center uses.
- Every hashed file has a one-time canonical-name fallback in the code that
  loads it (loader, runtime modules, the call module, call widget l.js): keep
  it when you touch loading code. A retried `<script>` is a NEW element
  (createElement): a cloneNode() copy keeps the "already started" flag and is
  never fetched (`src/test/widget/loaderOpenIntent.test.ts`).

## 3. Fonts (the 231 KB lesson)

The fonts stylesheet once inlined five faces as base64: 231 KB gzip on every
first open, 73% of the panel's bytes, the same Bold file twice, and a full
111 KB Inter for Persian visitors who never draw a Latin glyph in it.

- No font bytes in any stylesheet: no `data:font`, no base64.
- No `@font-face` in a template stylesheet or skin, and none in a call widget
  stylesheet (they live in a shadow root, where Chromium never fetches
  faces). Faces live ONLY in the template's fonts stylesheet, which the
  loader injects at DOCUMENT level.
- Every face: one `src: url(fonts/<file>.woff2) format('woff2')` (relative;
  the build hashes the file and rewrites the url), `font-display: swap`,
  `font-style: normal`, and a `unicode-range`, so a face is downloaded only
  when text on screen needs one of its characters. Only a family's LAST face
  may omit the range (the fallback for a browser without unicode-range). No
  face may claim emoji or symbol blocks.
- Font files: woff2 only, under `public/widget/fonts/`, at most 45 KB each,
  every file named by a fonts stylesheet (no dead weight), no two files with
  the same bytes (point two weights at one file instead).
- Licences: a licensed face (IRANSans) ships byte-for-byte unmodified. An OFL
  face (Inter, Figtree) may be subset; keep its copyright and licence names.
  Subsets are generated once and committed
  (`scripts/fonts/subset-widget-fonts.py`): the Docker build has no Python.
- No external font hosts (Google Fonts, CDNs): customer sites' CSP and
  privacy, and one more connection.
- Customer sites with a Content-Security-Policy must allow the widget's
  asset host in `font-src` (`https://app.webyar.ai`, `https://app.respok.app`).
  Until 2026-10 the faces were `data:` URIs, so `font-src 'self' data:` was
  enough; such a page now shows both widgets in the system font (they still
  work) and logs one CSP error per face. Say so to a customer who reports it.
- Prefer the shared faces (IRANSans for Persian, InterWY for Latin; Figtree
  for the International skins only): a new family is downloaded by every
  visitor of that template.
- Figtree (SIL OFL 1.1, no Reserved Font Name) is the Latin and Turkish face
  of the International edition's skins `t1-intl` / `t2-intl` only. It is
  variable (wght axis) and cut into two files in the shared
  `presentation-default-fonts.css`: `figtree-latin.woff2` (18,540 B: Basic
  Latin, Latin-1, the dotless ı and typographic punctuation) and
  `figtree-tr.woff2` (2,312 B: Ğ ğ İ Ş ş). Each is declared at weights
  400-800 against the same file (one download), with disjoint
  unicode-ranges, the Latin face last. The files are cut by
  `scripts/fonts/subset-widget-fonts.py --figtree <@fontsource-variable/figtree@5.2.10 files>`
  from sha256-pinned sources. The licence is
  `public/widget/fonts/OFL-Figtree.txt` (an OFL licence `.txt` is the only
  non-woff2 file allowed in `fonts/`). No other template names Figtree, so
  their visitors never download it. For an `-intl` id, prepare() warms the
  Latin file, and in Turkish the Turkish file too (that first paint draws
  ğ ş İ): en 18.5 KB, tr 20.9 KB. Code in articles is the system monospace
  (no DM Mono).
- `prepare(context)` (`context = { locale, templateId }`) warms only the faces
  the locale's FIRST paint draws, resolves within 500 ms even if a font never
  arrives, and never throws. A Persian first paint may cost at most 120 KB of
  fonts, an English or Turkish one 50 KB. Older loaders pass no context:
  behave as Persian. The loader runs prepare() once the fonts stylesheet has
  loaded (or failed, or 800 ms passed).

## 4. Renderers are pure presentation

- No network or storage: no `fetch`, `XMLHttpRequest`, `WebSocket`,
  `EventSource`, `sendBeacon`, `localStorage`, `sessionStorage`,
  `indexedDB`, `document.cookie`, dynamic `import()`, `eval`,
  `new Function`, and no address of any host. URLs a template shows
  (links, logos) come from the view-model.
- Interaction is expressed with `data-*` behaviour hooks the core binds;
  visual classes carry no behaviour. Never rename an existing `data-*` hook.
  A hook only a new template needs is a renderer feature (§2): Core's code
  for it goes in `runtime-ext.js`, not in `runtime.js`.
- Call widget: the presentation never calls the network or storage; the
  runtime never touches the DOM (`src/test/callWidgetPresentationContract.test.ts`).
- Shipped JS targets ES2017 (the build lowers it); no new npm dependencies
  in widget files.
- No forbidden template-system tokens (`src/test/widget/noTemplateSystem.test.ts`).
- A renderer's extras (§1) are renderer markup: the same rules, and the same
  scan (`templateRules.test.ts`).
- RTL and LTR from one stylesheet (logical properties), both editions,
  both brands: the RESPOK build must pass `scripts/build/brandAudit.mjs`
  (`src/test/widget/widgetBrandBuild.test.ts` runs it on every file).

## 5. Size budgets

Minified as shipped (`scripts/build/widgetBrand.mjs`), gzip level 5 (what
nginx sends). Numbers live in `BUDGETS` in `templateRules.test.ts`; raising
one is a decision, with the reason in the commit and here.

| File | Budget | Paid on |
| --- | --- | --- |
| chat `loader.js` | 24 KB | every page view of every site |
| chat renderer | 20 KB | first open |
| chat stylesheet | 18 KB | first open |
| chat skin | 6 KB | first open |
| chat fonts stylesheet | 3 KB | first open |
| chat template total (renderer + stylesheet + skin + fonts stylesheet) | 40 KB | first open |
| chat `runtime-ext.js` | 8 KB | first open of a t1/t2 template |
| chat `runtime-late.js` | 12 KB | after the first paint of a template with extras |
| chat renderer extras (each `presentation-<renderer>-x.js`; not in the template total) | 12 KB | after the first paint |
| chat `runtime-fab.css` | 2 KB | page views of a workspace wearing a launcher style |
| chat `runtime-emoji.js` | 4 KB | the emoji search's first use |
| call `l.js` | 3 KB | every page view |
| call `runtime.css` | 5 KB | first page view |
| call presentation | 10 KB | first page view |
| call stylesheet | 3 KB | first page view |
| one font file | 45 KB | when its text is on screen |
| Persian first-paint fonts / English or Turkish | 120 KB / 50 KB | first open |

Each brand's build is measured as it ships: the loader in both (the RESPOK
build leaves out the Iran region's kit), each chat template in the brand of
every edition that offers it (`EDITION_CHAT_WIDGET_TEMPLATES`: Iranian →
`iran`, International → `respok`), Core's modules in both.

The International skins on 2026-10-18: `presentation-t1-intl.css` 2.1 KB
and `presentation-t2-intl.css` 2.0 KB (of 6), in both builds.

A launcher look belongs to `loader.js` (every page view): a template that
wants its own launcher must fit the loader budget, or take its look from
config instead of new code. A launcher style that not every site wears
goes in `runtime-fab.css` (§2), never in the loader. Sizes on 2026-10-18,
after issue #340 (gzip 5, as shipped): the loader 23.1 KB in the Iranian
build (23.7 KB before: RESPOK's kit left out, the styles' wiring added),
22.6 KB in RESPOK's (22.1 KB before: the Open logo added).

The build supports a second kit marker, the mirror of the Iran region's
`@iran-kit` (left out of the RESPOK build): `/* @intl-kit:begin */ …
/* @intl-kit:end */` with the switch `var INTL_KIT = true;` is left out of
the Iran build (`scripts/build/widgetBrand.mjs`, the widgets' copy of the
dashboard's `SHIPS_INTL_KIT`; every build refuses malformed markers of
either kit; a name a deleted block defines must be used only inside
`if (INTL_KIT ...)` branches, or the Iran build fails). It holds
RESPOK-only loader code: RESPOK's launcher kit (`RESPOK_KIT_CSS`, its
Thread and Open glyphs, `respokKitOn`, `rpkOpen`, `ensureRespokKitStyle`;
the operator preview's copy is `shared/respokLauncher.ts`), whose uses
(the button, its badge, the shell's `lg-thread` / `lg-open`) sit behind
`INTL_KIT`, so the Iran loader does not pay for it. The edition is the
database's (`platform_settings.region_mode`, which the Super Admin may
switch; a missing row is International) and the brand the build's: an
Iran-brand deployment switched to the International edition then shows
the plain launcher instead of RESPOK's, with no other brand's art, as the
dashboard's Iran build goes without International-only extras (decided for
issue #340; `widgetBrandBuild.test.ts` pins both loaders and boots the Iran
one in the International edition). The build checks every name a deleted
block declares, each declarator of a `var a = 1, b = 2;` or `var a, b;`
included, and its function and class declarations, and refuses a
declaration it cannot read (a destructuring one).

## 6. Server side (no per-template work, but do not undo it)

- The server picks ONE template per request and sends only its asset URLs;
  per-template server cost is an in-memory lookup.
- Widget config is cached per workspace in each API process (60 s, with
  cross-node invalidation over Postgres LISTEN/NOTIFY), and the bootstrap
  returns it inline, so a page view costs one API request and no database
  query on a cache hit: `docs/operations/WIDGET_CONFIG_CACHE.md`. A template
  that needs new settings adds them to that snapshot, never a per-request
  query.
- Which template a workspace wears is the Super Admin's catalog
  (`widget_edition_settings.chat_templates`, in the platform snapshot) and
  the workspace's `widget_settings.widget_template_id` (migration 275,
  `shared/chatTemplateCatalog.ts`). A template in the edition's `offered` is
  disabled until the Super Admin enables it, so shipping one changes nothing
  for visitors. Its options (`CHAT_TEMPLATE_OPTIONS`) reach the renderer as
  `config.templateOptions`; its display names stay in the dashboard and never
  reach the widget. See `docs/operations/EDITIONS.md`, "The chat widget
  template catalog".

## 7. Before a template ships

1. `npx vitest run src/test/widget/templateRules.test.ts src/test/widget src/test/edition src/test/perf`
2. Build both brands in a scratch copy:
   `VITE_BRAND=iran node scripts/widget-hash.js && VITE_BRAND=iran node scripts/call-widget-hash.js`,
   the same with `VITE_BRAND=respok`, then
   `VITE_BRAND=respok node scripts/build/brandAudit.mjs dist`.
3. If `nginx.conf.template` changed: render it with
   `envsubst '${BACKEND_URL}'` and run `nginx -t` on it.
4. Open the template in a real browser for fa and en: the panel opens in its
   own typeface, and only the expected font files are requested.
5. The widget Playwright specs (`e2e/widget*.spec.ts`) locally: CI does not
   run them.
