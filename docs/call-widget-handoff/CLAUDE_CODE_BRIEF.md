# Implementation brief: WebYar and Respok call-center widget

**Audience:** Claude Code (or an engineer) working in the call-widget codebase (`public/call-widget/*`: the loader
`l.js`, the engine `runtime.js`, the renderer `presentation-default.js`, the stylesheets `runtime.css`,
`presentation-default.css`, `presentation-intl.css`, the registry `presentation-registry.js`; the fonts asset shared with
the chat widget `public/widget/presentation-default-fonts.css`; `shared/widgetTemplates.ts`; the widget settings on the
server).

**Goal:** ship the new call-center designs in this package so that the live widget on a customer's website matches the
screenshots in `*/template-1-call-center/screens/panels/` pixel for pixel, in both brands, both directions, desktop and
mobile, without breaking the call engine (states, controller calls, media, ringback, timers, polling).

**Scope:** the website **call-center widget** only (voice call, video call, callback request). The chat widget has its own
handoff package; the two must feel like one family (same fonts, accent logic, footer, motion language).

Read in this order:

1. This brief (global rules, architecture, order of work, acceptance).
2. [`shared/production-map.md`](shared/production-map.md): how the production call widget is built today (loader,
   presentation lifecycle, the 9 states and every sub-state with its markup, the controller calls, media hooks, timers,
   ringback, forms, `--ccw-*` tokens, i18n, what a re-render must preserve, known bugs). Line refs point into
   `public/call-widget/*` (aliases in its §0: `PD` renderer, `RT` engine, `RCSS` runtime.css, `FA`, `INTL`, `LD`, `REG`,
   `WT`).
3. The brand sheet, then the design spec:

| Brand | Language, direction | Design spec | Production template id |
|---|---|---|---|
| WebYar (webyar.ai, Iranian edition) | Persian `fa`, RTL | [`webyar/template-1-call-center/README.md`](webyar/template-1-call-center/README.md) | `default` |
| Respok (respok.app, International edition) | English `en`, LTR | [`respok/template-1-call-center/README.md`](respok/template-1-call-center/README.md) | `intl` |

Brand sheets: [`webyar/README.md`](webyar/README.md), [`respok/README.md`](respok/README.md). Canonical names for every new
hook, controller call, setting, view-model field and i18n key: [`shared/new-hooks-and-settings.md`](shared/new-hooks-and-settings.md).

---

## 1. What is in a design folder

```
<brand>/template-1-call-center/
  README.md        the implementation spec (screens, layout, tokens, components, call states, motion, copy, mapping)
  tokens.json      every design token: CSS expression, value for the brand's default accent, and the 3 radius sizes
  source/          NN-name.dc.html: the design source of each board (HTML template + a small logic class at the bottom)
  reference/       NN-name.html: static render of each board; NN-name--state.html: extra states
    css/           cc.css: the exact stylesheet of every board (both brands), fonts.css
    fonts/         the font files
  screens/
    panels/        every screen, launcher style, placement and state card cropped at 2x: THE acceptance target
    boards/        whole boards at 1x (with the board title and the explanation written on the canvas)
    states/        the live prototype in its states, and the radius variants, at 1x
```

The 12 boards: 01 call buttons (9 launcher styles) · 02 placement on the page (8 positions) · 03 button states and motion
· 04 live prototype · 05 starting a call (screens 01–03) · 06 waiting in line (04–06) · 07 on a call (07–09) · 08 during
the call (10–12) · 09 after the call (13–15) · 10 callback (16–19) · 11 mobile (20–23) · 12 design system.

- **Reference pages** open from disk in Chrome. They are static (handlers and timers removed). The live prototype
  (board 04) is exported closed plus `--open-home`, `--queue`, `--call`, `--minimized-call`, `--rating`, `--thanks` and
  four launcher style/position variants (`--button-c-br`, `--button-p-bl`, `--button-r-br`, `--button-t-tr`); board 05
  also as `--radius-sm` and `--radius-lg`.
- **Source boards** (`source/*.dc.html`): plain HTML with `{{holes}}`, `<sc-if>`, `<sc-for>`; the
  `class Component extends DCLogic` script at the bottom computes the values and holds the timers and the step machine of
  the live prototype; `data-props` holds the board options (accent, radius, Respok logo direction). They do not render on
  their own; view the reference pages.
- **Board chrome is not product UI:** kicker, titles and descriptions, `.tag` labels, layout wrappers, the card frames of
  boards 01–03, the fake website and control buttons of board 04, phone chrome on board 11, the card frames of board 12.
  The card captions, the motion list (`.mn`) of board 04 and the design-system board are spec content; the READMEs
  transcribe them.
- **Sample content is not copy:** the store (فروشگاه نیلوفر / Nilufar Store), the operator (سارا محمدی / Sara
  Mohammadi), order numbers, emails and reference codes are demo data. UI strings are in each README's copy deck.

## 2. Ground rules (do not break these)

1. **Presentation lifecycle** (production map §1.3, §9.2): register `default` and `intl` with `contractVersion: 1` and
   `createHost`, `mount`, `update`, `destroy`; `createHost` creates `#call-center-widget-host` with an open shadow root,
   loads the stylesheets inside it and the shared `#gs-presentation-fonts` link in `document.head`.
2. **Controller calls** (map §5, §9.3). The renderer drives the controller directly today (the `intents` object and view
   model are built but unused). Keep making the same calls with the same arguments: `toggleOpen`, `startCall('voice' |
   'video')`, `openCallback`, `submitCall`, `submitCallback`, `cancelCall`, `reset`, `setLocale`, `toggleMic`,
   `toggleCam`, `submitRating`, `render`, and the writes to `formData.*`, `ratingValue`, `ratingComment`. **Starting a call
   stays synchronous inside the click** (ringback needs the user activation).
3. **The 9 states and every sub-state stay** (`loading`, `online_available`, `offline`, `pre_call_form`,
   `queue_waiting`, `in_call` with its 20 `connectStatus` cases, `ended` with its 3 variants, `callback_form`, `error`;
   the hide policy). Every design screen is a view of one of them (each README maps them); none becomes a new engine state
   unless §9 says so.
4. **Media** (map §6.1): append every `controller._attachedTracks` element and `controller._localVideoEl` as the **same
   instances**, keep them in the document while they play (removing a playing element pauses it), keep `data-track-sid`
   and the `prepareMediaElement` attributes. The voice call must mount its remote `<audio>` too (hidden). The design's
   voice level bars may be driven by setting `controller._waveBars` (the engine already writes `scaleY` on them).
5. **No full rebuild every second.** Production rebuilds the whole panel and launcher on every 1 s tick (map §4.0), which
   restarts animations, drops focus and re-parents media. The designs rely on continuous motion (rings, orb pulse, level
   bars) and on focus staying put: build the structure once per state and update the changing text (timers, queue
   position, ETA, status) in place. Keep `ccw-launcher-wrap` and `ccw-panel` as persistent nodes.
6. **Forms** (map §6.6, §9.6): keep the `<form>` submit path, `type=button` on other buttons, the honeypot
   `input[name=company_website][tabindex=-1][aria-hidden=true][autocomplete=off]` positioned off-screen (not
   `display:none`), the time trap, the custom schema field types with their required marker, and a place for
   `controller.error`.
7. **Audio UI** (map §6.5, §9.7): the sound toggle calls `audio.setMuted` and, on unmute with `needsGesture()`,
   `audio.startFromGesture(...)` inside the click, with `stopPropagation`; the "tap to enable sound" hint shows whenever
   `needsGesture()` is true.
8. **The "Powered by" footer** with all five variants (map §4.11) on light and dark (stage) screens; views must also look
   right with the empty footer.
9. **Theme plumbing** (map §1.8, §7): keep the `--ccw-*` names, the HSL-channel format, inline application on `.ccw-root`,
   `data-radius` and `data-density` on the root, `[hidden]` forced to `display:none`, and the `left` / `right` classes on
   the wrap and the panel. Keep `lang` and `dir` on `.ccw-root`.
10. **No external requests and no emoji icons:** fonts as `data:` URLs in the shared fonts asset; icons inline SVG from
    [`shared/icons/`](shared/icons/README.md). Remove the emoji from the translated strings (map §8).
11. **Test both directions on every change.** WebYar is RTL, Respok is LTR; one renderer serves both.

## 3. Architecture: where the design lives

- Templates per `shared/widgetTemplates.ts`: `default` (Iranian edition) and `intl` (International). Both use the same
  script `presentation-default.js`; `default` loads `runtime.css` + `presentation-default.css`, `intl` loads `runtime.css`
  + `presentation-intl.css` **instead of** the Persian stylesheet (map §1.4).
- **Recommended:** restyle both in place: the WebYar design becomes `default`, the Respok design becomes `intl`. Put the
  shared design CSS (everything in `cc.css` that is not under `.b-wy` / `.b-rp`) in `runtime.css`, the WebYar specifics in
  `presentation-default.css` and the Respok specifics (`.b-rp` rules) in `presentation-intl.css`. One design per brand,
  so no settings migration. If the owner wants the current look kept as a fallback, register it as `legacy` /
  `legacy-intl` first.
- **Rewrite the renderer** (`presentation-default.js`) against the same lifecycle and controller calls: the designs change
  the markup substantially (dark call stage, docked controls, minimised call inside the launcher, two-step callback form,
  bottom sheet on mobile) and §2.5 asks for in-place updates. Keep engine (`runtime.js`) changes to the additions in §9 and
  the bug fixes in §11.

## 4. Frame, placement and mobile

| Property | Production today (map §2–§3) | Design (implement this) |
|---|---|---|
| Desktop panel | 368 × 508 | **400 × 660**, radius `--r-panel` (26px; 16px with radius `sm`, 34px with `lg`) |
| Viewport caps | `max-width: calc(100vw - 24px)`, `max-height: calc(100vh - 130px)` | keep both, with `dvh` instead of `vh` |
| Tail corner | none | the panel corner on the launcher side uses `--tail`: WebYar = `--r-panel` (no visible tail), Respok = **8px**; physical corner of the anchor (bottom-right placement → bottom-right corner) in both directions |
| Shadow | `0 25px 50px -12px hsl(0 0% 0%/.25)` | `--sh-panel` (tokens.json) |
| Launcher | 52px round button + floating pill, offsets 20px | the 9 styles of board 01 (default: round with a label); offsets and sizes in the README |
| Placement | bottom right / bottom left | the 8 placements of board 02 (default bottom right; panel opening direction per placement) |
| Launcher while open | stays | leaves the corner while the panel is open and comes back after it closes (board 03 film: opening 520ms, closing 500ms); closing lives on the panel |
| Minimised during a call | the launcher does not reflect a call (map A3.19) | collapsing the panel during the queue or a call turns the launcher into a call bar (place in line + waiting time, or operator + time + mute + end) or, for video, a small floating video window; a booked callback stays on the launcher until its time (board 03) |
| Mobile | ≤480px: a 370 × 508 floating card | ≤640px (the chat widget's breakpoint, so both widgets switch together): the launcher in the corner or as a bottom bar; home as a **bottom sheet**; queue and call **full screen** with controls pinned to the bottom (board 11); `env(safe-area-inset-*)` instead of the notch and home bar drawn on the boards; `visualViewport` handling like the chat widget |
| Closed panel | transparent but still focusable | `inert` (or `hidden`) when closed |

If both widgets are embedded on one page, they must not share a corner (map §3: both default to bottom right). The
designs do not draw this case; ask the owner which placement the call widget takes then (suggestion: stack it above the
chat launcher with a 16px gap).

## 5. Accent, theme and radius

Production writes `config.widget_theme` on `.ccw-root` as HSL channels (`applyTheme`, PD:54-65: `primary` →
`--ccw-primary`, `accent` → `--ccw-accent`, `surface` → `--ccw-surface` and `--ccw-panel`, `text` → `--ccw-ink`, `muted` →
`--ccw-muted`, `danger` → `--ccw-danger`; `data-radius`; `data-density`). Only `#rrggbb` is accepted.

1. **`--a` (the design's single accent) = the workspace primary.** In `applyTheme`, also set `--a` from the primary hex
   (no HSL rounding), falling back to `hsl(var(--ccw-primary))`. Every accent shade and the WebYar call stage
   (`--s1..--s3`, `--glow`) derive from `--a` exactly as in `cc.css`. Production's derived tints that ignore the theme
   (map A3.16) disappear with this.
2. **Brand defaults** when no primary is set: WebYar `#0B7D6C` (channels `171 84% 27%`), Respok **Ink `#16142B`**
   (`245 37% 12%`). For Respok this is a change: production `intl` uses Signal coral (`9 100% 62%`) as primary; the design
   uses Ink as the primary and keeps Signal `#FF5A3C` for live states, focus and highlights, like the Respok chat widget.
   Respok's call stage is fixed Ink (`#2E2A5E` / `#1A1838` / `#0D0C1C`), not derived from a custom accent.
3. **Text on the accent** (`--on-a`): `#FFFFFF` when white has at least as much WCAG contrast against the accent as Ink
   `#16142B`, otherwise `#16142B` (the boards' `lum()` / `renderVals()`); set it in `applyTheme` next to `--a`. A few board
   rules hard-code `#fff` on the accent (the READMEs list them); use `--on-a` there.
4. **The other theme colours** map onto design tokens: `accent` → `--live`, `danger` → `--end` and `--bad`, `text` →
   `--ink`, `muted` → `--ink-3`, `surface` → the light panel background. Unset values keep the design defaults.
5. **Radius** `sm | md | lg` → the design's radius rules (`--r-panel` 16 / 26 / 34, `--r-card` 12 / 20 / 26, `--r-ctl`
   9 / 14 / 19), keyed on production's `data-radius` (the boards use `data-r`).
6. **Density** `compact` is not drawn: keep production's rule (body padding 10px, button min-height 34px) translated to
   the new classes.
7. **Respok logo direction** `logoDirection` (`thread` default | `open`): changes the "Powered by" lockup, as in the chat
   widget.

## 6. Fonts and numbers

The call widget shares `#gs-presentation-fonts` with the chat widget. The chat handoff replaces IRANSans + InterWY with
**Vazirmatn** (WebYar) and **Figtree + DM Mono** (Respok); the call widget uses the same families
([`shared/fonts/`](shared/fonts/)). Production prints **no** Persian digits (map §8): in fa every number becomes Persian
(timers, queue position, ETA, durations, star labels, error seconds, callback date and time, which also moves to the
Jalali calendar in `Asia/Tehran` like the chat widget). Reference codes, emails and URLs stay Latin in an LTR isolate.
Replace `rem` units with `px` (shadow DOM does not isolate the host's root font size).

## 7. Motion and accessibility

- Motion: durations, curves and delays are in each README §6. **Where the captions (the motion list of board 04, the
  film of board 03, the motion card of board 12) and `cc.css` disagree, `cc.css` wins**: it is what the prototype actually
  plays (e.g. the call stage spreads in 700 ms and folds in 550 ms; closing is a 260 ms fold, then the launcher returns
  over 550 ms after 200 ms). `--spring` and `--bounce` are `linear()` curves (fallback `cubic-bezier(.2,.9,.25,1)`).
- `prefers-reduced-motion: reduce`: no movement (rings, waves, orb pulses, launcher wiggle, springs); short opacity fades
  only. Keep the global opt-out at least as strong as production's.
- Add what production lacks (map §9.8): `aria-expanded` on the launcher, `role="dialog"` + label on the panel, `inert` on
  the closed panel, polite live regions for queue position, call status and errors (not for the per-second timers),
  label/field association, radio semantics for stars and segmented controls, Escape collapses the panel.
- Focus: a visible ring on every control (WebYar accent, Respok Signal `#FF5A3C`; white on the dark stage).
- Touch targets ≥ 44px; the call controls on the stage are larger (README).

## 8. Order of work

1. Foundations: fonts (shared with chat), tokens and accent pipeline (§5), the new renderer skeleton with persistent
   nodes and in-place updates (§2.5), panel frame and placement (§4), footer variants, icons.
2. WebYar `default`, state by state: home (online / offline), pre-call form (+ error, returning visitor), connecting,
   queue (+ next, callback offer, sound toggle and hint), operator joining, voice call (+ level bars), video call (feed,
   self-view, docked controls), transfer, reconnect, permission errors and the other `connectStatus` cases, rating,
   thanks, error, callback steps 1–2, callback scheduled.
3. Launcher: the default style and its states (ready, hover flip, business logo, offline / callback), the minimised
   queue / call / video and the booked callback.
4. Respok `intl` skin (Ink stage, Signal accents, Figtree, tail corner, lockup).
5. Launcher styles and placements as settings (§9), mobile (bottom sheet, full-screen queue and call).
6. Motion pass, accessibility pass, RTL pass, digit pass; visual QA against `screens/panels` (§10).

## 9. What the designs add beyond production

Each README §9 lists its additions with the data the engine and the server must provide; canonical names are in
[`shared/new-hooks-and-settings.md`](shared/new-hooks-and-settings.md). If a capability is not available, ship the UI
behind a flag and render nothing (never a broken control).

## 10. Acceptance

- [ ] Every PNG in `screens/panels/` is reproduced by the live widget with the same data at 2x (desktop panel 400 × 660;
      mobile in a 390 × 844 viewport). Differences allowed only for live data (video, names) and device chrome.
- [ ] All 9 states and every sub-state render as designed, in fa (RTL, Persian digits everywhere) and en.
- [ ] Every preset accent and a light custom accent work (text on accent readable; the WebYar stage re-tints).
- [ ] Radius sm / md / lg and both directions verified.
- [ ] Video: controls always visible (docked over the feed), on desktop and mobile; the self-view never covers controls;
      the remote video is not mirrored.
- [ ] Minimise during the queue and a call keeps the call alive; restoring returns to the same state; focus and
      animations survive the 1 s ticks.
- [ ] Mobile: full screen during the queue and the call, bottom sheet for home, safe areas respected.
- [ ] Ringback toggle and "tap to enable sound" hint; permission errors, reconnect and transfer behave as in production.
- [ ] Keyboard and screen reader: every control reachable and labelled; visible focus; live regions announce state
      changes only.
- [ ] `prefers-reduced-motion` removes movement; no console errors; no requests to font or icon CDNs.

## 11. Known issues

**Production bugs to fix while re-rendering** (map Appendix A3; each is small and touches code you will be in anyway):

| Bug | Fix |
|---|---|
| `callbackId` is never cleared, so after one callback request every later call ends on "Callback scheduled" (A3.2) | clear it in `reset()` (the launcher's booked callback lives on in `controller.callbackBooking`) |
| Ringback can keep sounding during a call (after a resumed call or a transfer) (A3.6) | stop it whenever the state is `in_call` with the operator joined; offer the sound toggle in the call too |
| The remote video is mirrored like a selfie (A3.7) | mirror only the local self-view |
| "Skip" on the rating calls an undefined `skipRating` (A3.5) | add `skipRating()` (no API call, then `reset()`) |
| `rtc_v1_unsupported` is unmapped and shows "connecting" forever (A3.9) | map it to an "unsupported browser" message (new i18n key `rtc_unsupported`) with the callback as the way out, like the design's error screen |
| Camera denied with the operator present leaves only End, no mute (A3.10) | show the voice-call controls |
| Offer-card race between `cancelCall` and `openCallback` (A3.3); `cancelCall` without `.catch` (A3.4) | chain `openCallback` after `cancelCall` resolves; handle the failure |
| A `custom_texts.en` override leaks into fa / tr (A3.12) | apply custom texts per locale |
| The collapse chevron is labelled "Back" (A3.14) | label it `minimize` ("Minimize" / «کوچک کردن») as designed |

**Design issues and decisions** (details in each README §9 / §11; build as designed unless the owner decides otherwise):

| Issue | Decision |
|---|---|
| The live prototype draws the panel 384 × 660 to fit its fake site | Boards 05–10 are canonical: **400 × 660** |
| Minimised call: board 03 shows mute + end and the first name; the prototype shows restore + end and the full name | Board 03 is the spec (mute + end, first name); the whole bar restores the panel on click and carries the `restore_call` label |
| Screen 06 draws two sound toggles | Keep one: the one in the dock |
| The business-logo launcher loops its flip on board 03; the caption says it flips on hover | Flip on hover and focus only; both faces are in `screens/panels` (`--c-business-logo.png`, `--c-business-logo-flipped.png`) |
| A few rules hard-code `#fff` on the accent (Respok: cc.css 157, 276, 567, 583, 599, 616, 620, 628, 659; the selected time slot at 325 keeps `--on-a` on Ink) | Use `--on-a` (§5.3) |
| The label close button `.lbl .x` misses `border:0; padding:0` (a ring shows in the round-with-label crop) | Reset the button border |
| Respok's font stack in `cc.css` has no Vazirmatn | Add `"Vazirmatn"` before the generic families for RTL |
| The reference code is bold, but DM Mono ships 400 / 500 | Use DM Mono 500 |
| White on the end-call red is 4.06:1 (Respok `#E5432A`) for the 15px "Cancel call" / "End call" labels | Ship as designed; if an audit flags it, darken `--end` for text buttons only |
| The header shows "operators available" on the "no operator available" error | Show the real presence in the header |
| Production states the boards do not draw (13 other `connectStatus` cases: camera denied, operator left, media disconnected, token expired, room failed, unsupported browser, the connecting family; the "message only" offline behaviour; muted video-dock buttons; single-channel home; custom form fields; footer variants; compact density) | Compose them from the drawn patterns as each README's state map proposes (WebYar §5.24, Respok §1.2): the edge screens of board 08 for failures, the stage for connecting phases, the error screen of board 09 for terminal errors |
| Forms, rating, thanks, error and the callback confirmation have no mobile drawing | Use the desktop layout full width inside the mobile bottom sheet |
| The boards clip content (`overflow:hidden`) | In production the body of light screens scrolls; the call stage never scrolls and keeps its dock visible |

---

Where a design README and this brief disagree, this brief wins for architecture and integration; the design README wins
for visual values.
