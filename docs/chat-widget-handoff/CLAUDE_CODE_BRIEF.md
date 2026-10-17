# Implementation brief: WebYar and Respok chat widget, Templates 1 and 2

**Audience:** Claude Code (or an engineer) working in the widget codebase (`public/widget/*`, `shared/*Launcher.ts`,
`shared/widgetTemplates.ts`, the widget Core `runtime.js`, and the widget settings on the server).

**Goal:** ship the new chat-widget designs in this package so that the live widget on a customer's website matches the
screenshots in `*/*/screens/panels/` pixel for pixel, in both brands, both directions, desktop and mobile, without
breaking any behaviour Core relies on.

**Scope:** the website **chat widget** only. The call-center widget is not in this package. Inside the chat widget, the
existing call invitation card and call surface (production map §5.3 and §5.4) stay exactly as they are.

Read in this order:

1. This brief (global rules, architecture, order of work, acceptance).
2. [`shared/production-map.md`](shared/production-map.md): how the production widget is built today (mounting, panel
   frame, launcher kits, every view's markup, all 119 `data-*` hooks, i18n, what a re-skin must preserve). Line refs such
   as `PD:1176` point at `public/widget/presentation-default.js` (PD), `loader.js` (LD), `presentation-default.css` (CSS),
   `presentation-intl.css` (INTL).
3. The brand sheet, then the design spec of the template you are building:

| Brand | Language, direction | Template 1 · Classic (bottom menu) | Template 2 · Simple home (no bottom menu) |
|---|---|---|---|
| WebYar (webyar.ai, Iranian edition) | Persian `fa`, RTL | [`webyar/template-1-classic/README.md`](webyar/template-1-classic/README.md) | [`webyar/template-2-simple-home/README.md`](webyar/template-2-simple-home/README.md) |
| Respok (respok.app, International edition) | English `en`, LTR | [`respok/template-1-classic/README.md`](respok/template-1-classic/README.md) | [`respok/template-2-simple-home/README.md`](respok/template-2-simple-home/README.md) |

Brand sheets: [`webyar/README.md`](webyar/README.md), [`respok/README.md`](respok/README.md).

---

## 1. What is in a design folder

```
<brand>/<template>/
  README.md        the implementation spec for this design (screens, layout, tokens, components, motion, copy, mapping)
  tokens.json      every design token: the CSS expression and the value it resolves to for the brand's default accent
  source/          NN-name.dc.html: the design source of each board (HTML template + a small logic class at the bottom)
  reference/       NN-name.html: static render of each board; NN-name--state.html: extra states of interactive boards
    css/           the exact stylesheets the boards use (widget.css + respok.css for Template 1, t2.css for Template 2)
    fonts/         the font files those stylesheets load
  screens/
    panels/        every widget screen cropped at 2x: THE acceptance target
    boards/        whole boards at 1x (with the board title and the explanation written on the canvas)
    states/        interactive boards captured in other states (open, greeting, picker open, ...)
```

- **Reference pages** open straight from disk in Chrome (`reference/01-home.html`). They are static: event handlers and
  canvas scripts were removed, and each one shows the default state. Use DevTools on them to read any computed value.
  Respok Template 1 also has `NN-name--thread.html` pages (and `*--thread.png` screenshots) for the Thread logo.
- **Source boards** (`source/*.dc.html`) are the editable originals from Claude Design. Markup is plain HTML with
  `{{holes}}`, `<sc-if value="{{x}}">` and `<sc-for list="{{items}}" as="item">`; the `class Component extends DCLogic`
  script at the bottom computes the hole values (`renderVals()`) and holds the timers of the interactive boards, and the
  `data-props` JSON on that script holds the board's options (accent presets, menu mode, Respok logo direction). Read
  these for exact markup, copy and SVG icons. They do not render on their own (they expect the design tool's runtime);
  view the reference pages instead.
- **Board chrome is not product UI.** Do not implement: the board title and description (`.cv-t`, `.cv-d`, `.t2-h`,
  `.t2-d`), screen labels (`.tag`), layout wrappers (`.cv-row`, `.cv-col`, `.t2-row`, `.t2-col`), component spec cards
  (`.spec`, `.sg`, `.sc`, `.flow`), the fake host website (`.site`, `.sbar`, `.page`), the prototype control buttons
  (`.ctl`) and motion-note lists (`.mn`), and mobile device chrome (notch, home bar, `.safe`).
- **Sample content is not copy.** Customer names, order numbers, messages and article text in the boards are demo data.
  UI strings (labels, buttons, placeholders, empty states) are listed in each design README's copy deck.

## 2. Ground rules (do not break these)

1. **Keep every behaviour hook.** All `data-*` attributes in production map §6 keep their element and value contract,
   including nodes that are hidden. Keep the composer's fixed control set and DOM order, the mic as first child of
   `.input-row`, `att-preview` before `input-row` inside `input-wrap`, and `rec-bar` / `vn-bar` as siblings
   (production map §8.1).
2. **Keep the structural and state classes** Core and the loader query or toggle (production map §8.2), the message row
   contract `.msg-row.(visitor|operator)[.is-last] > .msg-col > .msg-line > .msg + .msg-actions` and
   `.msg-footline > .msg-meta` (§8.3), the label/error IDs (§8.4), all ARIA (§8.5), the footer structure (§8.6), focus
   management (§8.7) and every reduced-motion opt-out (§8.8).
3. **Add, do not rename.** New design classes may be added next to production classes. Where a design element replaces
   a production element, the production element keeps its classes and hooks and gains the new look.
4. **Physical sides for messages:** operator on the left, visitor on the right, in both directions (already true in
   production and in both designs).
5. **No external requests at runtime:** fonts and icons ship with the widget assets (fonts as `data:` URLs, the current
   convention; see §6).
6. **Inline styles from the renderer win over CSS.** Remove the inline accent backgrounds the renderer writes today
   (visitor bubble PD:665, home smart CTA PD:902) and let the stylesheet paint them from the accent token (§5).
7. **Skeleton parity:** each skeleton must match its view's new header height, paddings and composer box (production
   map §8.10).
8. **Test both directions on every change.** WebYar is RTL, Respok is LTR; one stylesheet per template serves both, so
   use logical properties except where this brief or a design README says a side is physical.

## 3. Architecture: where each template lives

The registry (`presentation-registry.js`) already supports several templates ("Adding a template later = add ONE entry
here and in `shared/widgetTemplates.ts` + its asset files"). Recommended mapping:

| Template | WebYar (Iranian edition) | Respok (International edition) | Assets |
|---|---|---|---|
| **Template 1 · Classic** | `default` (restyled in place) | `intl` (skin over `default`, restyled in place) | `presentation-default.js`, `presentation-default.css`, `presentation-intl.css` |
| **Template 2 · Simple home** | new id `simple` | new id `simple-intl` (skin over `simple`) | new `presentation-simple.js`, `presentation-simple.css`, `presentation-simple-intl.css` |

- Template 1 keeps production's information architecture (home, messages, help) and adds a bottom menu, so upgrading
  `default`/`intl` in place gives every existing workspace the new design with no settings migration. If the owner wants
  the old look kept as a fallback, copy today's files to a `legacy` / `legacy-intl` entry first.
- Template 2 has a different home and navigation model, so it gets its own renderer. Start from a copy of
  `presentation-default.js`, keep the same `create(env)` contract and every exported view function and hook, register it
  as `window.__gs_presentation_simple = { id: 'simple', create, prepare }`, and point the registry entry's `globalKey` at it.
  Verify in `runtime.js` that Core resolves the renderer through the registry descriptor (the registry comment says so);
  if anything hard-codes `__gs_presentation_default`, make it read the descriptor.
- **Launcher kits** are chosen in the loader by edition *and* template id today (LD:681-685 for WebYar: edition `iran` and
  template `default` or empty; LD:729-731 for Respok: edition `international` and template `intl`). Change both
  conditions to depend on the edition only, so `simple` and `simple-intl` keep their brand launcher.
- Add the new ids to `shared/widgetTemplates.ts` (which edition may wear which template) and to the widget settings so a
  workspace can choose Template 1 or Template 2. The settings that the designs introduce are listed in §9.

## 4. Panel frame, placement and mobile (both templates)

| Property | Production today | Design (implement this) |
|---|---|---|
| Desktop size | 420 × 680 (CSS:79-82) | **400 × 720** |
| Viewport caps | `max-height: calc(100dvh - 118px)`, `max-width: calc(100vw - 24px)` | keep both caps |
| Corner radius | 20px default, 18px intl | **28px** (Template 1 all corners; Template 2 all corners except the "tail", see below) |
| Shadow | `var(--wy-shadow)` | Template 1 `--sh-3`, Template 2 `--sh-panel` (values in each `tokens.json`) |
| Anchor | `.shell` fixed at bottom/right 24px (left with `position: bottom-left`); panel corner on the launcher corner, `transform-origin` at that corner | unchanged |
| Mobile (≤640px, open) | `.shell.gs-mobile-open`: full screen, radius 0, safe-area top/bottom padding | unchanged; apply the design's mobile sizes (below) |

- **Template 2 tail corner.** The panel corner that sits on the launcher is `--tail`: 28px for WebYar (no visible
  difference) and **8px for Respok** (the Respok "Open" logo idea: the bubble's square corner points at the button). The
  board CSS writes it as `border-end-end-radius`, which is only correct for LTR + bottom-right. In production use the
  physical corner of the anchor: `.panel.bottom-right { border-bottom-right-radius: var(--tail) }`,
  `.panel.bottom-left { border-bottom-left-radius: var(--tail) }`, in both directions. Mirror the greeting bubble's tail
  the same way.
- **When the viewport is shorter than 720 + 118px**, the cap shrinks the panel: only the scrolling middle (home body,
  thread, lists, article) gives up height. Headers, hero top row, composer, bottom menu and footer never shrink.
- **Launcher while open:** production slides the launcher off-screen (`.launcher.open`, `--gs-fab-exit`). Both designs
  keep that; Template 2 specifies its own timing (drop .26s ease-in, rise .5s spring after .22s; see its README).
- **Mobile.** The design's mobile boards draw the sheet inside a phone frame (390 × 844, rounded corners, notch, home
  bar). Those are device chrome. In production the open sheet stays full screen with no radius, and
  `env(safe-area-inset-top/bottom)` replaces the notch and home-bar space. The larger mobile sizes in the designs
  (`.w.mob ...` in Template 1, `.p.mob ...` in Template 2) apply under `.shell.gs-mobile-open .panel` and, for the first
  frame before that class arrives, under `@media (max-width: 640px)`.
- **Close button:** production's `button.panel-close[data-panel-close]` (absolute, top 12px, inline-end 12px) keeps its
  hook and position logic; each design README gives its look per screen (on the hero it is the translucent white
  button, on white headers the plain icon button).
- **Launcher look: the production kits are the source of truth.** The WebYar kit (`.wy-kit`) and the Respok kit
  (`.rpk-kit`) already draw the brand glyphs used in the boards (identical paths). Where a board's launcher preview
  differs from the kit (colours computed from the accent, badge size, a scaled glyph, a different shadow, an idle dot
  wave), keep the kit. Take from the boards only what the kits do not have yet: the greeting bubble look, the launcher
  style options of the "launcher and colour" boards, the Respok **Open** glyph (for `logoDirection: "open"`), the
  on-accent colour flip, and the open/close timing each design README specifies.

## 5. Accent and colour pipeline

Each design is one accent colour away from any customer brand: `--a` is the only colour the customer picks, every other
accent shade is derived from it with `color-mix(in oklab, ...)` (see `tokens.json` → `tokens`).

1. **`--a` comes from the loader's `--gs-primary`.** Define `--a: var(--gs-primary)` at the template root
   (`:host, .shell`), and derive the rest exactly as in the design CSS.
2. **Brand default.** The loader already treats an empty accent or `#3B82F6` as "uncustomised" (LD:686-689; it switches
   the launcher kits to brand mode). For the templates, when uncustomised:
   - set `--gs-primary` to the edition's brand accent: WebYar **`#0B7D6C`**, Respok **`#16142B`** (Ink);
   - add a class to `.shell` (suggested `gs-accent-brand`) and, under it, apply the hand-tuned brand overrides listed in
     each `tokens.json` → `brandOverrides` (Template 1: the hero gradient; Template 2: hero stops and glow).
   The boards' own scripts only test for the brand hex itself; production applies the overrides in both cases.
3. **Text on the accent** (`--on-a`): `#FFFFFF` when white has at least as much WCAG contrast against the accent as Ink
   `#16142B` has, otherwise `#16142B`. For all preset accents it is white, so screenshots do not change; it keeps light
   custom colours readable. Use it for every text or icon drawn on a background derived from the accent: Template 2
   mostly does already, but a few rules still hard-code `#fff` (the hero's glass buttons `.gb`, the voice play button
   `.voice .pb`, the "still need help" card on the WebYar hero gradient, the hero focus ring); Template 1 writes `#fff`
   on the accent throughout. Compute it once in the loader (next to `--gs-shadow`, LD:1088-1107) and publish it as
   `--gs-on-primary`; the templates read `--on-a: var(--gs-on-primary, #fff)`. Reference implementation: `lum()` /
   `renderVals()` in `*/template-2-simple-home/source/01-home.dc.html`.
4. **Fix the known accent leaks** while restyling: `--wy-primary` is undefined (voice player, CSS:941/944/972) and several
   `rgba(31,147,255,...)` tints ignore the accent (production map §1.4, Appendix A7-A8). In the new CSS everything accent
   coloured reads `--a` or a token derived from it.
5. **Colour palette in the settings UI** (the "launcher and colour" boards; any hex must still work):

   | WebYar | Respok |
   |---|---|
   | فیروزه‌ای وب‌یار `#0B7D6C` (default) · آبی `#2563EB` · نیلی `#4F46E5` · بنفش `#7C3AED` · صورتی `#DB2777` · نارنجی `#D9480F` · سبز `#15803D` · مشکی `#111827` | Respok Ink `#16142B` (default) · Blue `#2F5BFF` · Indigo `#4F46E5` · Violet `#7C3AED` · Pink `#DB2777` · Orange `#C2410C` · Green `#15803D` · Teal `#0F766E` |

   (The shorter accent lists in the boards' `data-props` are only the canvas preview options.)
6. **Respok logo direction.** Respok has two official logo directions, Open and Thread. Every Respok board supports both
   with one root class (`lg-open` / `lg-thread`; elements marked `g-o` / `g-t`). Implement both behind one setting
   `logoDirection`, default `thread`, which matches the launcher kit that ships today. Details:
   [`respok/README.md`](respok/README.md).

## 6. Fonts

| Brand | Families and weights | Notes |
|---|---|---|
| WebYar | **Vazirmatn** 400, 500, 600, 700 | all text, Persian and Latin |
| Respok | **Figtree** 400, 500, 600, 700, 800; **DM Mono** 400, 500 | DM Mono only for inline code / tracking numbers. When a Respok widget runs RTL (Persian), text switches to Vazirmatn |

- Production loads fonts from the template's `fonts` asset (`presentation-default-fonts.css`, faces inlined as `data:`
  URLs, published at document level through `<link id="gs-presentation-fonts">`, because `@font-face` inside a shadow
  root is ignored). Today it ships IRANSans + InterWY. Replace with the families above, keeping the same mechanism: one
  fonts asset per brand (e.g. Vazirmatn-only for `default` and `simple`; Figtree + DM Mono for `intl` and `simple-intl`;
  add Vazirmatn there too if the International edition must render Persian). Each fonts asset publishes
  `--gs-presentation-font` at `:root` with the brand stack from the design CSS.
- Update `prepare()` (the font gate, PD:1781-1791) to wait for the new families (WebYar: Vazirmatn 400/500/700 with a
  Persian sample; Respok: Figtree 400/600/700 with a Latin sample), still capped at 500 ms.
- The font files and their licences (all SIL OFL 1.1, free to bundle commercially) are in [`shared/fonts/`](shared/fonts/).
  The Vazirmatn files are byte-identical to the ones already in production `public/widget/fonts/`.
- The Persian design uses Persian digits for every number the UI prints (times, counts, badges, dates, step numbers).
  Production already converts in several places (production map §7, "Persian digits"); extend it to every new number
  in the designs. Codes, URLs, emails and phone numbers stay Latin and LTR inside RTL text (`unicode-bidi: isolate`).

## 7. Motion and accessibility (both templates)

- Durations, easings and keyframes are specified per design (README §6 in each design folder). Where boards disagree,
  the canonical source is: **Template 1** the token sheet (board 13 WebYar / 12 Respok), e.g. panel opening 380ms
  `cubic-bezier(.22,1,.36,1)` from `translateY(14px) scale(.96)`; **Template 2** the motion list of the live prototype
  (board 06). The other live demo boards are illustrations.
- Template 2 uses `linear()` spring curves (`--spring`, `--bounce` in its `tokens.json`); `linear()` is supported in
  current Chrome, Edge, Safari and Firefox. If you must support older browsers, fall back to `cubic-bezier(.2,.9,.25,1)`.
- `prefers-reduced-motion: reduce`: both designs turn every animation off and keep only short opacity fades
  (`.15s`); keep production's existing opt-outs too.
- Focus: visible ring on every interactive element (Template 1: production's `2px solid var(--gs-primary)`; Template 2:
  `outline: 2px solid var(--a); outline-offset: 2px`, Respok Signal `#FF5A3C`, white on the hero).
- Touch targets ≥ 44px on mobile. Template 1's mobile spec enlarges icon buttons to 44px (round action 46px).
  Template 2's mobile spec keeps 36–38px buttons and only enlarges chips to 40px: give its small controls an invisible
  44px hit area (padding or a pseudo-element) without changing what is drawn.
- Contrast: body text on white meets WCAG AA in both palettes; text on the accent uses `--on-a` (§5.3). Known weak
  spots are listed in §11.

## 7a. Behaviour rules that apply to both templates

- **Message status** keeps production's meaning (production map §5.1): sending → spinner, sent → single tick,
  delivered → double tick, seen → double tick in the accent, failed → "!" + retry. The designs restyle the glyphs only
  (one board labels the single tick "delivered"; follow production).
- **Voice notes** keep production's flow: record → stop (`[data-rec-stop]`) → preview (`[data-vn-bar]`) → send. A
  "send straight from the recorder" button where a design draws one is an addition (suggested `data-rec-send`); without
  it, the recorder's confirm button stops and shows the preview. Template 2 does not draw the preview: build it from its
  recorder row (same height and ring) with the voice-bubble player inside, as its README describes.
- **Media timelines run left to right in every language.** The progress tracks of the voice bubble and of the
  voice-note preview (`[data-audio-seek]`, `[data-vn-seek]`) keep production's `dir="ltr"`: Core's seek maths assumes it,
  and a media timeline is time, not reading order. Place the play button, time and actions where each design draws them.
  Where a Persian screenshot shows the progress filling from the right, this rule wins.
- **Navigation:** the bottom menu's five label modes are defined for the floating dock (`vb`), the design default. The
  other three bar styles (`va`, `vc`, `vd`) are optional alternatives shown with icons and labels as drawn on WebYar
  board 02; if offered, they ignore the label-mode setting.
- **Article rating:** where a design shows three faces, they map to `data-kb-rate="down" | "neutral" | "up"`.
  `neutral` is a new value; until the knowledge-base API stores it, render only the two outer faces.
- **Skeletons stay `aria-hidden`** even where a board gives a skeleton row an `aria-label`.
- **Board defects:** a few board rules contradict their own screenshots or motion notes (listed in each README, e.g. the
  Template 2 prototype hides the typing dots in the step meant to show them). Build the intent described in the README.

## 8. Order of work

1. **Foundations** (shared by everything): fonts asset + font gate (§6); accent pipeline incl. brand default and
   `--on-a` (§5); panel frame size, radius, shadow, tail, mobile sizing (§4); footer and close button look.
2. **Template 1 · WebYar (`default`, fa/RTL):** restyle every existing view to the design: home, chat (messages,
   attachments, composer, emoji picker, recorder, voice preview), conversation list, help list + article + rating,
   pre-chat form, offline/contact fallback, handoff card, skeletons, smart home card. Then the new pieces (§9).
3. **Template 1 · Respok (`intl`, en/LTR):** port the Respok skin (`respok.css` deltas over `widget.css`): Ink palette,
   Signal status colours, Figtree, logo direction, typing dots, badges, lockup in the footer.
4. **Launcher and greeting** for both kits: confirm the kits match the launcher boards; restyle the smart-engagement
   nudge as the greeting bubble; add the launcher style options from the "launcher and colour" boards that production
   does not have yet.
5. **Template 2** (`simple`, `simple-intl`): new renderer + stylesheets + registry entries; then its new features.
6. **Mobile pass**, **motion pass**, **accessibility pass**, **RTL pass** for each template.
7. **Visual QA** against `screens/panels` (§10).

## 9. What the designs add beyond production (needs Core, server or settings work)

Canonical names for every new hook, setting, view-model field and i18n key (one name per concept, shared by both brands
and both templates): [`shared/new-hooks-and-settings.md`](shared/new-hooks-and-settings.md).

Each design README §9 lists its additions with the exact UI, suggested hooks and the data Core must provide. Summary:

| Addition | Template | Needs |
|---|---|---|
| Bottom menu (Home / Messages / Help) with unread badge; 4 bar styles; 5 label modes | 1 | Renderer markup + Core navigation for `data-view="home"` (`list`, `help` exist); settings `navStyle` (`va`, `vb`, `vc`, `vd`; design default `vb`, the floating dock) and `navMode` (`both`, `active`, `icon`, `text`, `none`; design default `active`, icons + label on the active tab) |
| Search field on home and in help | 1, 2 | Compose `kbSearchBarHtml` (exists, unused) with a hook Core binds (suggested `data-kb-search`), query → help results view |
| Visible "operator is typing" bubble in the thread | 1, 2 | Core already knows (`setOperatorTyping`, `[data-typing-row]`); pass it to the renderer as `view.operatorTyping` and render the visible `.typing-row` next to the sr-only one |
| Topic chips in a new conversation / on home | 1, 2 | Reuse Q&A chips (`.qna-suggestions`, `data-qna-question`) or new `data-topic` sent as the first message |
| Pre-chat inside the conversation (form card, step by step, summary) | 1 | Handoff card exists (`.hc-card`, `data-prechat-*`); step-by-step mode and the summary card are new |
| Ask field on home (type the first message on home) | 2 | Start a conversation with the typed text (`data-home-action="chat"` + the draft in `textarea[data-home-ask]`) |
| Order card with delivery progress, "Track order" row | 2 | Commerce data (the loader already supports a store context, `data-commerce-*`); otherwise hide |
| Reactions on messages | 2 | Server + Core support; otherwise hide |
| Instant answers while typing (help articles that match the draft) | 2 | KB search as you type, results with matched words highlighted |
| Help categories grid, article reading progress, face rating | 2 | Categories exist in the KB view-model but are ignored today; three faces map onto `data-kb-rate` incl. new `neutral` (§7a) |
| Rating card after a conversation (CSAT) | 2 | New: production has no conversation rating UI or API |
| Launcher style options, greeting bubble, live motion | 1, 2 | `fab.shape` and `fab.icon` exist; new values `fab.shape: "pill"` (text from `fab.label`) and `fab.icon` `bubble`, `duo`, `avatar`; the Respok Open / Thread tiles set `logoDirection`; the greeting look is new |

If a backend capability is not available yet, ship the UI behind a flag and render nothing (never a broken control).

## 10. Acceptance

For every design folder:

- [ ] Each PNG in `screens/panels/` is reproduced by the live widget with the same data, at the same size
      (desktop 400 × 720; mobile in a 390 × 844 viewport), compared at device scale factor 2. Differences allowed only
      for live data, the device chrome listed in §1, the rules of §7a and the wording decisions of §11. Respok Template 1 has two sets: `*--thread.png`
      for the default `logoDirection: "thread"`, the plain names for `"open"`.
- [ ] Works in both directions; WebYar in Persian with Persian digits, Respok in English.
- [ ] Works with every preset accent and with a light custom accent (text on accent stays readable).
- [ ] All 119 `data-*` hooks are still emitted where Core expects them (diff the hook list before and after).
- [ ] Keyboard: every control reachable in a sensible order, visible focus everywhere, existing keyboard behaviour unchanged.
- [ ] Screen reader: live regions still announce new messages, typing, recording and errors.
- [ ] `prefers-reduced-motion` removes movement.
- [ ] Mobile ≤640px: full-screen sheet, safe areas, keyboard (visualViewport) behaviour unchanged.
- [ ] Skeleton → content crossfade does not jump.
- [ ] Launcher, unread badge, greeting and open/close motion match the launcher boards and the state screenshots.
- [ ] No console errors; no network requests to font or icon CDNs.

## 11. Known design issues (build as designed unless the owner decides otherwise)

| Issue | Where | Recommendation |
|---|---|---|
| The small greeting line on the brand-default hero is low contrast (white at 88% on the light end of the gradient: about 2.2–3.4:1; Template 2 about 3.1:1, its presence line 4.1:1) | WebYar hero, both templates | Ship as designed; if accessibility review flags it, raise that line to 100% white |
| Placeholders below 4.5:1 (Template 1 `#7A808C` 4.0:1; Template 2 `--ink-4` 2.35:1) | composers, fields | Ship as designed; if an accessibility audit requires AA for placeholders, use `--ink-3` |
| `.cv button{font:inherit}` in the Template 1 board CSS made some buttons render with inherited type (e.g. topic chips 14px/400 instead of the declared 13px/600) | Template 1 | Build what the screenshots show (the WebYar Template 1 README lists every case) |
| A few strings are worded differently on different boards (e.g. the emoji button «ایموجی» / «شکلک‌ها», «حل شده» / «حل شد», «گفتگوی جدید» / «گفتگوی تازه») | WebYar and Respok, both templates | One wording per key is fixed in [`shared/new-hooks-and-settings.md`](shared/new-hooks-and-settings.md) §4.13; screenshots that show the other wording are accepted differences |
| Template 2's returning greeting «سلام علی، خوش برگشتی 👋» is informal singular, unlike the rest of the copy | WebYar Template 2 | Keep, or switch to the polite plural «خوش برگشتید» if the owner prefers |
| Board 00 of Respok Template 1 is an earlier overview: a 6px tail corner, slightly different line-heights and copy, a one-pill Messages icon | Respok Template 1 | Boards 01–12, the token sheet and this brief win; the README notes the differences |
| Which home rows show for a returning visitor (Template 2 drops "Track an order") is not specified | Template 2 home | Show "Track an order" only when a store context exists; otherwise hide it |
| English times are drawn as "7:42 PM"; production's formatter gives "07:42 PM" | Respok | Use `hour: 'numeric'` for English |

---

### Notes for whoever runs this

- `screens/boards/*.png` include the board titles and explanations the designer wrote on the canvas (Persian for
  WebYar boards, English for Respok boards). They are useful context but the panels are the spec.
- Where a design README and this brief disagree, this brief wins for architecture and integration; the design README
  wins for visual values.
