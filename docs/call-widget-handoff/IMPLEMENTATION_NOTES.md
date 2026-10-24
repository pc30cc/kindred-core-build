# Implementation notes (read before the handoff's own brief)

The handoff in this folder (`CLAUDE_CODE_BRIEF.md`, `README.md`, `shared/`, and per brand `webyar/` and `respok/`) was
implemented on 2026-10-19 on the branch that follows `6f8af41`, in seven rounds under one build contract. Where the
handoff and these notes disagree, these notes win: they record what the owner decided after the handoff was written,
and what the build had to decide where the handoff was silent or no longer matched the code.

The screens' PNGs (36.8 MB), the font files and the design sources (`source/*.dc.html`) were left out of the repository
on purpose: the text, the tokens, the icons, the brand files and the reference HTML are here (the visual gate re-renders
the reference HTML, see "Visual QA" below). The owner's full package is needed only for the comparison with the
acceptance PNGs (Tier B).

## Owner decisions (2026-10-19, binding)

1. **Replace the look in place.** WebYar's design is call template `default` (Iranian edition), Respok's is `intl`
   (International edition). No legacy template is kept, no new template id, no Super Admin catalog entry.
2. **Exactly the designs**, pixel for pixel against `*/screens/panels/` (81 PNGs per brand, at 2x). The call budgets
   may be raised to what the design needs (measured, plus a small headroom). Speed still matters: what only the panel
   needs loads on the visitor's first intent, where nothing visible changes and the open has no visible delay.
3. **Persian text is IRANSans only.** Respok uses Figtree (already shipped for the chat). Reference codes use the
   system monospace. No Vazirmatn, no DM Mono, anywhere.
4. **Two widgets never share a corner.** The call launcher stands 16px above the chat launcher when both sit on the same
   side.
5. Everything else in the brief applies: the nine states and their sub-states, the controller calls, media handling, no
   full rebuild per tick, forms and honeypot, the audio UI, footer variants, theme plumbing, Persian digits (and the
   bootstrap's calendar) in Persian, accessibility, reduced motion, the brief's §11 fixes and its §9 additions with their
   server data and settings.

## What overrides the brief

| The brief says | Implemented | Why |
|---|---|---|
| Vazirmatn for Persian, DM Mono for codes, fonts as `data:` URLs (brief §2.10, §6) | IRANSans 400/500/700 (600 → the 700 file, 800 → 700); WebYar Latin in InterWY, Respok Latin in Figtree; codes in `ui-monospace,'SF Mono',Menlo,Consolas,monospace`; faces only in the document-level `presentation-default-fonts.css` | Owner decision 3 and `docs/operations/WIDGET_TEMPLATE_RULES.md` §3 (no font bytes in stylesheets, `unicode-range`, ≤ 120 KB Persian / 50 KB Latin first paint) |
| One presentation file | The core renderer (page load) + a **lazy panel module and stylesheet** (first intent) | Owner decision 2: a page view pays only for the launcher |
| `call.*` budgets as they were | Raised per the contract's §7 (provisional caps, then measured + headroom in round 7) | Owner decision 2 |
| WebYar 18's summary chip may differ (new-hooks §5.6 decision 4) | Pixel-exact: keys `summary_phone` / `summary_video` (D21) | Exact design |
| The booked callback in `sessionStorage` (new-hooks) | `localStorage`, until its time (D15) | "Stays on the button until its time" across visits |
| `aria-pressed` on stars, segments, chips (the boards' markup) | Radio groups (`role=radiogroup` / `radio`, `aria-checked`, roving tabindex, arrows mirrored in RTL) | Brief §7 |
| `role="status"` on the ticking containers (`.mc`, `.mvid`, `.vtop`, `.pill`) | No live region on anything that ticks; every announcement goes through one `.ccw-live` region outside the panel | A status role on a timer is read every second |
| Respok README: "runtime.css holds the rest" | `runtime.css` (page load) + `presentation-default-panel.css` (first intent) | The lazy panel |
| `ui.labelDismissed` in the renderer's storage (new-hooks §3) | `controller.labelDismissed` / `dismissLabel()` in the engine (E14) | Renderers never touch storage |
| `logoDirection` a workspace-wide setting | Read from the workspace's chat template options (International edition only, default `thread`) (D18) | That is where it lives in the code |
| `rtc_unsupported` = "unsupported browser" | The media server lacks the v1 path; title `rtc_unsupported`, body the engine's localized `err_media_rtc_v1` (D22) | What the status really means |

## Decisions taken by the build (D1–D41)

Each was final for the build; the ones the owner may revisit are repeated under "Reported to the owner".

| # | Decision | Reason |
|---|---|---|
| D1 | `default` and `intl` stay the only call template ids; no catalog entry, no template migration, no new Super Admin setting | Owner decision 1; the handoff asks for none |
| D2 | Fidelity gate: Tier A = the live widget against a re-render of the handoff's reference HTML in the same Chromium (production fonts and the documented deviations applied); Tier B = side by side with the acceptance PNG, reviewed | A PNG made by another browser with other fonts cannot be pixel-gated |
| D3 | Fonts per brand and direction (above); InterWY is 500 only, so 600/700 are synthesised in WebYar English, as in the chat | WIDGET_TEMPLATE_RULES §3: an English first paint ≤ 50 KB (IRANSans first would cost 88 KB) |
| D4 | Two widgets: for every bottom placement the launcher and its minimised bars rise until their bottom stands 16px above a visible chat launcher whose span (widened by 16px) meets theirs; the open panel keeps its corner and covers the chat launcher (z-index `2147483647` over the chat's `…646`); `mobile_bar` beside a chat launcher becomes the pill; top placements and the edge tab never stack | Owner decision 4; the open panel at full height on 768–900px screens |
| D5 | Page load: loader, registry, engine, core renderer, `runtime.css`, the skin, the fonts stylesheet. First intent (hover, focus, press, touch): the panel module + its stylesheet; a call being restored loads them at mount; touch screens without hover at idle | Owner decision 2 |
| D6 | `round_label` online draws its label with the close `x`; the offline label (Sd) has none; `operator_face` has none; `round` shows the label without `x` on hover/focus; a dismissed label is `round` for the session | Board 01 is the component spec; board 03 Sd draws no `x` |
| D7 | Screen 06: one sound toggle (the dock's); in a call a second one beside the time only while the ring plays | Brief §11 |
| D8 | Dock labels are actions (`mute`/`unmute`, `camera_off`/`camera_on`) | As the screens draw |
| D9 | The call time keeps running across a transfer | Screen 10 draws ۳:۰۵ |
| D10 | Minimised: Se (queue; `connecting` during the request), Sf (operator face, the person silhouette since 2026-10-24, + first name + time + level bars + mute + end; the bar restores), Sg (the same remote video in 188×122) | Board 03 |
| D11 | Thanks = board 09's summary card with mini stars | Board 09 |
| D12 | Panel 400 × 660 | The prototype's 384 is not canonical |
| D13 | Bottom centre: the panel at the bottom offset, centred; the launcher leaves while open; centring with `inset-inline:0; margin-inline:auto`, never `translate` | `transform` stays free for motion; no old-Safari fallback |
| D14 | Phones: the chat's media query `(max-width:640px),(max-height:500px) and (pointer:coarse)`; `round_label` is the 56px pill; `mobile_bar` only on phones; the sheet and the full screen are modal (`aria-modal`, Tab contained, scrim and Escape collapse) | Both widgets switch together |
| D15 | `controller.callbackBooking` in localStorage until `scheduled_for` passes; ASAP makes none; Sh hides at its instant (one timer); clicking Sh shows screen 19 from the booking | "Stays on the button until its time" |
| D16 | Callback slots computed by the server from `business_hours` only when the new `callback_slots_enabled` is on (default off); the client groups them by the visitor-local day and shows the first four days; without slots the styled native `datetime-local` | No legacy `business_hours` value can change a live widget at deploy |
| D17 | `bootstrap.presence.any_available` (always) and `operators[]` (≤3, only for `card` / `operator_face`), memoised 30 s; online but unstaffed reads `no_operator_now` with grey dots (header, L4, and the home badge, which then drops its channel list: the sentence and the list do not fit its one line), the call tiles stay. **Changed 2026-10-21 (owner):** nobody available is offline (`runtime.js isOnline`), so the workspace's offline behaviour applies (hide, offline message, callback); the widget asks again each minute while offline for that reason (30 times at most, page shown) and comes online when an operator does. The Call Center header's "Set available" writes `call_center_agent_presence` (it used to write only `operator_call_availability`, which nothing visitor-facing reads) | Truthful status without a new query per page view |
| D18 | Respok's logo direction from the chat template options | Above |
| D19 | Dates follow the bootstrap's `calendar` / `time_zone` (Iran: Jalali, Asia/Tehran; International: Gregorian, the visitor's zone), like the chat; Persian digits in fa in both brands | "Like the chat widget" (brief §6) |
| D20 | WebYar footer: the designed mark + «قدرت گرفته از» + bold «وب‌یار»; Respok: "Powered by" + the Thread/Open lockup; every production variant (logo image, custom text, text only, empty row) still works | Exact design, nothing lost |
| D21 | Summary chip keys `summary_phone` / `summary_video` | Pixel-exact 18 |
| D22 | `rtc_v1_unsupported`: screen-12 layout, title `rtc_unsupported`, End call + Request callback | Above |
| D23 | Camera denied: the call goes on with the microphone (E7) and a `camera_denied` banner shows until the camera is on | Brief §11 A3.10 |
| D24 | Stored colours win; only unset ones take the design defaults | No rewrite of saved themes |
| D25 | `@supports not (color: color-mix(…))` redefines every derived token with the default accent's values; `@supports not (linear())` redefines `--spring` / `--bounce` | A plain declaration before a `var()` one is not a fallback |
| D26 | Closing an ended screen resets to home 420 ms after the close (rating: `skipRating()`) | As the live prototype does |
| D27 | Status privacy: `operator_name` from `full_name` only; `assigned_agent_id` carries an opaque per-call HMAC reference (same field name); unread fields dropped | The bootstrap and status are public (the Origin can be forged) |
| D28 | No plan gate for launcher styles or placements | The call widget has no appearance gate |
| D29 | Engine work limited to the brief's §9/§11 items and E19–E21; other defects listed as follow-ups (below) | Scope |
| D30 | The handoff text and reference HTML in `docs/call-widget-handoff/`; no PNG, no font, no `source/` | The visual gate needs the HTML |
| D31 | Turkish written for every new or changed string; listed below for review | Not blocking |
| D32 | A video call without the operator's picture shows the voice layout with a 4-button dock and the self-view | Composed, not drawn |
| D33 | Error screen title = `controller.error` (fallback `unknown`) | No `error_prefix` |
| D34 | No operator name: a headset glyph, the role label only; Sf / `.vtop` / 13 / 14 use `operator_label`. A named operator without a photo is the person silhouette (`.pp`), never an initial (owner, 2026-10-24) | Names come only from `full_name` (D27) |
| D35 | An outcome reached while minimised (ended, error, a failure, the microphone refused) opens the panel once, focus not moved (when the bar that goes held it, the outcome's heading takes it), the outcome announced; transfers and reconnecting keep the bar; ending from Sf/Sg opens the rating | A visitor never loses a call silently |
| D36 | `in_call` precedence: failure family → microphone refused → reconnecting → transferring → live (08 / 09 / D32, + camera banner) → joining family | One screen per render |
| D37 | `config.avatar_url` online: `round` and `round_label` wear the logo and flip to the call face on hover/focus; offline wins | Board 03 Sc |
| D38 | One error slot `p.msg.err[role=alert][data-error]` on every screen that can show while `controller.error` is set (01, 16, 17/18) | Composed: Tier B |
| D39 | The panel module follows the chat's late-pack rule: `PANEL_V` is bumped with the module's `v` whenever `H` or the instance contract changes; a module of another `v` is refused and the next intent retries. Two accepted deploy windows, below | Never half-applied |
| D40 | Screen 04's Cancel is live; the engine makes a cancel during the start request safe (E21) | As drawn |
| D41 | Hit areas: at least 44px under the phone layout or a coarse pointer; on a desktop with a fine pointer at least 24px (WCAG 2.5.8), and no control's hit area covers part of another's. The credit link `a.pw` therefore stays 40px tall on a desktop (it cannot grow over the action row right above it), grows to 44px downward on phones, and on a tablet (coarse pointer, desktop layout) is 44px tall, taking the 4px from the body above it (its text stays put; over the video it grows into the 4px under it). A body that scrolls on a short window (`.bd`, `.sb`) is a Tab stop of its own in Chromium and shows the ring inside its box | The behaviour spec's Tab walk asserts all three in every state, on a desktop, a phone and a 1024×768 tablet |

## Where things are

| Concern | Code |
| --- | --- |
| Loader | `public/call-widget/l.js`: page-load scripts unchanged (registry, core renderer, engine); `ensurePanel` (hashed name, then once the fixed name `?v=` as a new `<script>`; a failed attempt clears its waiters), passed to the engine as `loadPanel`; with a remembered active-call session it starts in the same pass as the page-load scripts |
| Engine | `public/call-widget/runtime.js`: only the E-items below; it never touches the DOM |
| Core renderer | `public/call-widget/presentation-default.js` (registers `default` and `intl`): host and stylesheets, theme and accent (`applyTheme`), digits and dates, launcher icons, UI state, the persistent `.ccw-launcher-wrap` / `.ccw-panel` / `.ccw-live` / `.ccw-media`, the nine launcher styles and their states, placement, the chat stacking (D4), intent detection, panel loading and readiness, the helpers `H` handed to the module |
| Panel module | `public/call-widget/presentation-default-panel.js` (`window.__ccw_panel = { v, create(H) }`): every screen (light and stage), header, footer, forms, media, the audio UI, the minimised bars Se/Sf/Sg, the phone sheet and full screen (page lock, visual viewport, Tab trap) |
| Stylesheets | `runtime.css` (tokens, launchers, placements, focus, reduced motion, `@supports` blocks; page load), `presentation-default-panel.css` (the panel; first intent), `presentation-default.css` (WebYar skin: its font stack), `presentation-intl.css` (Respok skin: tokens, `--signal`, every Respok rule, the lockup) |
| Beside the chat widget | The core reads the chat's launcher box (`gs-widget`'s open shadow root) for the stacking and writes nothing there. On a phone both widgets hold the page while their panel is open: a page the other widget already holds stays that one's (each restores only what it changed) and is watched, so the panel still open takes the hold over the moment the other lets go (call: the panel module's `phone()`; chat: `public/widget/loader.js` `applyMobileFullScreen`, the only chat file this build changed) |
| Template descriptors | `shared/widgetTemplates.ts`: `CallWidgetTemplate.panel = { script, style }` for both ids |
| Shared rules | `shared/callLauncherStyles.ts` (styles, positions, aliases), `shared/callbackSlots.ts` (time zones, slots) |
| Server | `server/routes/callWidget.ts` (bootstrap fields, presence, slots, panel asset URLs, callback window and slot validation, status privacy), `server/routes/callCenter.ts` (settings PUT/GET), `server/services/callCenter/{settings,presentation,publicPresence}.ts`, `server/services/widget/availability.ts` (its time helpers now in `shared/callbackSlots.ts`) |
| Migration | `database/migrations/277_call_widget_design.sql`: `launcher_style`, `callback_slots_enabled` (default false), `callback_slot_minutes`, `callback_days_ahead`, `callback_slot_capacity`, and `widget_position` default `right`. Metadata only, no data rewritten |
| Dashboard | Call Center → Settings (`src/pages/app/call-center/SettingsPage.tsx`): style picker `src/components/app/call-center/CallLauncherStylePicker.tsx`, five positions, edition colour defaults, "Callback hours" (`src/components/app/widget/WeeklyHoursEditor.tsx`, shared with the chat's availability), text overrides, the live preview; reference-code search in `src/pages/app/call-center/CallbacksPage.tsx`; API types `src/lib/call-center-api.ts` |
| Unit tests | `src/test/callWidget/` (states, launchers, a11y, theme, digits, i18n, panel loading, the E-items, the server items), `src/test/widget/{callWidgetLoader,templateRules,designContract,widgetBrandBuild}.test.ts` |
| Visual QA and behaviour | `e2e/harness/call*.ts`, `e2e/harness/pngDiff.ts`, `e2e/harness/callReferenceOverrides.css`, `e2e/callWidget{Screens,Behaviour,Placement}.spec.ts` (below) |

### State → screen (`data-screen` on `.ccw-panel .scr`)

| Engine state / sub-state | Screen |
|---|---|
| `loading` (request in flight) | 04 `connecting` |
| `online_available` | 01 `home` (phone: sheet 21) |
| `offline` (`show_callback` / `show_message` / `hide`) | 16 `offline` / 16 without the button / hidden |
| `pre_call_form` | 02 / 03 `precall` |
| `queue_waiting` position > 1 / = 1 (+ offer) | 05 / 06 `queue` (phone 22) |
| `in_call` before the media is up, `waiting_for_operator` | 07 `joining` |
| `in_call` `in_call` / `operator_connected` | 08 `voice` / 09 `video` (phone 23); D32 |
| `in_call` + `transferring` (E19) | 10 `transfer` |
| `in_call` `media_reconnecting` | 11 `reconnect` |
| `in_call` `microphone_permission_denied` | 12 `mic` |
| `in_call` camera refused | the live layout + the `camera_denied` banner (D23) |
| `in_call` failures (`operator_left`, `media_disconnected`, `token_expired`, `room_connect_failed`, `rtc_v1_unsupported`, `media_client_*`, `provider_client_*`, `media_not_configured`) | `fail` (12 layout) |
| `ended` with `callbackId` / unrated call / rated / else | 19 `scheduled` / 13 `rating` / 14 `thanks` / 14 without stars |
| `callback_form` | 17 / 18 `callback` (step 1 / 2) |
| `error` | 15 `error` |
| any + the booking view | 19 from `controller.callbackBooking` |
| any, panel closed | the launcher (Sa–Sd), Se, Sf, Sg or Sh |

`in_call` rows are matched in the D36 order. Names: D34. Error slots on undrawn screens: D38.

### Engine changes (each named in its commit, each with a test in `src/test/callWidget/`)

E1 five positions and their aliases (a stored `bottom-left` now shows left); E2 `skipRating()`; E3 `reset()` clears
`callbackId`; E4 `cancelCall()` returns a promise, never rejects, retries a failed POST once; E5 offer → callback form
after the cancel answered; E6 the ring stops when the operator joins; E7 camera refused keeps the call; E8 no English
custom text in another language; E9 `rtc_unsupported`; E10 time continuous across a transfer; E11 the booking in
localStorage; E12 `connectionQuality`; E13 `retryMicrophone()`; E14 `labelDismissed` / `dismissLabel()`; E15
`errorKey` (`err_future_time` returns to step 1); E16 Persian digits in the engine's own messages; E17 the new and
changed strings (no emoji, «وب‌یار» with ZWNJ); E18 `loadPanel` in the render context; E19 the transfer lifecycle
(screen 10 until the next operator joins, no `operator_left` meanwhile, 120 s timeout); E20 `audioMeterLive`; E21 a
cancel during the start request cancels the call it makes. No visitor endpoint gained a request field (an old server
keeps accepting the new widget).

## Corrections to `shared/production-map.md`

The production map describes the code before #337. Its loader, fonts and error sections are out of date:

- No stylesheet in the host page's head any more: only the shadow root links `runtime.css` and the skin; faces come from
  the document-level `#gs-presentation-fonts` link (separate hashed woff2 files with `unicode-range`, no `data:` fonts).
- The built loader requests content-hashed names (no query), starts the page-load scripts at the load event or when
  the bootstrap answers (whichever is first), retries the bootstrap once, remembers "off" in `localStorage
  ccw_off:<workspace>:<apiBase>`, and prefers the chat build's hashed LiveKit copy. It now also loads the panel module
  (`ensurePanel`).
- The engine localizes every message it writes (`err_failed_start`, `err_failed`, `mic_denied`, `camera_denied`, the
  connect failures); `friendlyConnectError` returns I18N keys. The bootstrap already sent `calendar` and `time_zone`;
  the widget now uses them.
- `GET calls/:id/status` never had a `muted` field; it now also stops sending the operator's user id and e-mail part
  (D27).
- `e2e/widgetCallSurface.spec.ts` and its unit tests are the **chat** widget's in-panel call surface, not this widget.

Its line citations no longer hold: the core renderer and the stylesheets were rewritten, the panel moved to its own
module, and the engine gained the E-items and the new strings (its I18N tables are still at its top). Search the
function names in the code rather than translating the map's numbers.

## Accepted deviations (Tier A; nothing else may differ)

Applied in `e2e/harness/callReferenceOverrides.css` or masked:

1. Fonts: IRANSans for Vazirmatn (WebYar), the repository's Figtree (Respok), the system monospace for DM Mono (Respok 19).
2. `.lbl .x { border:0; padding:0 }` (a defect of `cc.css`).
3. Screen 06: the timer row's second sound toggle is not drawn (D7).
4. The label's close `x` production draws on 03 Sb is masked (D6).
5. The feed and self-view pictures are the reference's own, exported and played through real `<video>` elements.
6. (WebYar 18's summary chip: no deviation any more, D21.)
7. Live data inside launchers, masked: the Sc business logo and the L8 operator photo (their frames, rings and badges
   stay gated).
8. The on-accent fixes (`#fff` on the accent → `--on-a`, translucent white overlays → `--on-a` mixes, Respok
   `.slots .chip.on` text `#fff`, `--a-ink: var(--ink)` for a light accent) applied to the reference too: identical at
   every preset, required for the light accent `#F5D90A`.
9. Respok Sh: the board writes "Tomorrow 4:30", `Intl` prints "Tomorrow 4:30 PM" (masked).
10. 07-09 (video call, both brands): the text line inside the `.vtop` pill is masked (`.vtop ::text`: the box of its
    contents, 2px around). Chromium rasterises that text inside the pill's `backdrop-filter` layer up to 2 device px
    lower in the live widget than in the reference, with the same layout on both sides (box probes equal; with the
    backdrop filter off on both sides the panel differs by 0.019%). It left Respok's 07-09 at 0.186–0.197% against the
    0.20% limit, so a different Chromium build could fail the gate on a raster detail. The pill itself (its edges,
    ends, glass and the band around the text) stays compared and its box probed (orchestrator, 2026-10-19).
11. Respok in a workspace colour other than Ink (the `--matrix` accents): the reference gets the same stage tint as
    production (`tint` and `--a-k` on `.cc`, the tokens and ground of `presentation-intl.css`; see "Owner requests
    of 2026-10-19"). At Ink and with no colour nothing changes.
12. WebYar in a colour lighter than its lightest preset (the `--matrix` light accent `#F5D90A`): the reference gets the
    same hold as production (`hold` and `--a-k` on `.cc`, the tokens of `presentation-default.css`'s hold block:
    cc.css's own stage formulas on the held colour; cc.css's stage ground reads them). At the default and every preset
    nothing changes.

13. The home's trust strip ("Secure line · Queue aware · Fast handoff", the boards' last row of the home body) is not
    drawn in either brand (owner, 2026-10-21): the reference hides it too (`callReferenceOverrides.css`); it sat last
    with `margin-top: auto`, so nothing above it moves. Its strings, styles and two icons are gone.

14. Faces (owner, 2026-10-24): an operator without a photo is the person silhouette (`.pp`: card L4, operator_face's
    `.pic`, the orb's core on 07/08/11, 10's `.xf`, 13/14's summary, Sf), and the business without a logo the
    storefront (`.lg.ws`, Respok's panels: WebYar's fixture wears the board's own «ف» tile as its logo). The boards
    draw letters there: each such face is masked (`FACE_MASKS` and the `.lg` mask in
    `e2e/harness/callScreensFixture.ts`); its box stays probed. The visitor's own contact card (05-03) keeps its
    initial. The glyphs are the platform's (`shared/avatarGlyphs.ts`): the person in `runtime.css`
    (`--ccw-person`, 4,794 of 4,900 B), the storefront in the panel's stylesheet (10,353 of 10,800 B); the core
    lost `initialOf` (9,797 B), the panel module grew by 15–20 B (16,900 iran / 17,317 respok).

Respok only: launcher tails as drawn; 14's summary centred as drawn; `.inl` renders 13.5px.

## Owner requests of 2026-10-19 (rounds 6b and 7b)

**Respok's call stage follows the workspace colour, held dark.** The first handoff kept Respok's stage fixed Ink
(`tokens.json` note, contract §2.7 step 2); the owner asked for it to follow the brand colour as board 12-02 ("any
brand colour") draws it, without breaking for any colour. What ships:

- A workspace with no primary colour, or with Respok's own Ink `#16142B` (any case), renders exactly as before: the
  renderer adds nothing and the Tier A default run is unchanged.
- Any other primary: the core renderer (`applyTheme`) adds the root class `tint` and `--a-k`, the share of the colour
  the stage keeps so that its luminance is at most .15 (`100 × min(1, ∛(.15 / L))` %, L its WCAG luminance; an OKLab
  mix with black at k scales linear RGB by k³). `presentation-intl.css` then redefines, inside
  `@supports (color: color-mix(in oklab, red, red))` only: `--a-st` = the colour mixed with black at `--a-k`;
  `--s1` / `--s2` = `--a-st` at 40% / 20% in `#0C0C10` (Ink's darkest without its violet, so the colour keeps its
  hue: a teal stays teal, an orange brown); `--s3` = 8% in Ink's darkest `#0D0C1C`; `--glow` = `--a-st` 55% in white
  (board 12-02's glow). The stage ground (the stage layer and the Se/Sf bars, `.stage-bg`) takes board 12-02's shape:
  the glow at 24% at 50% 30% over the three stops; the indigo corner light and the Signal haze belong to the Ink stage.
  Sg's video window keeps its black ground; the orb's core stays Respok's white disc with Ink (as on Respok's call
  screens; board 12-02's small stages draw it in the colour).
- Signal stays the live colour: the header's live dot, the `.pill` dots, End (`--end`), the focus ring, and the
  dark-square launcher's status dot (pinned to `--signal` under `tint`, since it reads `--glow`).
- Browsers without `color-mix()` skip the block: the fixed Ink stage, whatever the colour (D25's rule, here a whole
  `@supports` block; the token probe checks it by putting the skin back without that block).
- Contrast, computed in `src/test/callWidget/callWidgetTheme.test.ts` from the real stylesheets (the tint block, the
  stage ground's geometry, the stage's own text colours) and the renderer's `--a-k`, for 241 colours (the presets,
  board 12-02's, very light ones such as `#F5D90A`, `#FDE047`, `#FFFFFF` and pastels, pure saturated primaries,
  Signal's own family, black and a 6×6×6 grid of the cube): white ≥ 9.5:1 at the stage's lightest point (≥ 7
  required); the body copy `.sp` (white .68) ≥ 5.39:1 and the secondary lines (white .60) ≥ 4.58:1 everywhere
  (≥ 4.5); Signal against the header band ≥ 3.5:1, End against the dock ≥ 4.37:1 and against the middle of the Sf
  bar ≥ 3.25:1 (≥ 3, WCAG 1.4.11). For comparison the Ink stage itself measures about 10:1 at its lightest point.
  Read back from Chromium's own pixels (the stage layer without its grain, 442 colours: a hue wheel at seven
  saturation/value pairs, greys and the light ones) the same figures come out a little lower: white ≥ 9.4:1, `.sp`
  ≥ 5.3:1, the .60 lines ≥ 4.5:1 at the lightest point, which sits behind the orb. Measured where each text really
  sits (every text of the stage screens 04–12 and 22 and of the Se/Sf bars, the grain included, eleven colours from
  `#FFFFFF` to `#000000`), every tinted text keeps ≥ 4.7:1 (large text ≥ 3:1), at most about a fifth below its value
  on Ink; the one text under 4.5 on a stage, the queue's white "Cancel call" on End (4.1:1), is the design's on Ink
  too.
- The tinted stage is darker than board 12-02's own swatches (the board mixes 60% / 30% / 12% into WebYar's
  green-blacks: on the same geometry white measures 7.4–8.3:1 and the body copy 4.4–4.9:1 on its five bright colours,
  and 3.6:1 / 2.8:1 on `#F5D90A` / `#FFFFFF`); the hue is the board's. Side by side: board 12-02's six colours against
  the live stage (voice call and Sf bar), review sheet in the round's scratch notes.
- Gates: the board-12 token probe (`e2e/callWidgetScreens.spec.ts`) states the formulas itself and compares the live
  tokens for every preset, board 12-02's colours and `#F5D90A`, checks the mark (`tint`, `--a-k`) and the
  no-`color-mix()` fallback; the reference re-render carries the same tint (deviation 11), so the `--matrix` runs
  pixel-gate the tinted stage of Respok's presets and the light accent.

**WebYar's stage holds a colour lighter than its lightest preset** (round 7b, the owner's "fix the colour so nothing
goes wrong"). WebYar's stage follows its accent through `runtime.css`'s formulas (`--s1` / `--s2` / `--s3` = the colour
at 60% / 30% / 12% in its green-blacks, `--glow` = 42% in `#5CF2D6`), with no cap until now: a light custom colour
made the stage light (`#F5D90A`: white 3.69:1 at the lightest point, the body copy `.sp` 2.57:1; `#FFFFFF`: 2.83:1 /
2.11:1). What ships:

- A colour whose WCAG luminance is above .195 (the lightest preset, `#D9480F`, is .1942) is held at .195: the core
  renderer adds the root class `hold` and `--a-k` = `100 × ∛(.195 / L)` % (one decimal), the share of the colour the
  stage keeps (an OKLab mix with black at k scales linear RGB by k³). `presentation-default.css` then redefines, inside
  `@supports (color: color-mix(in oklab, red, red))` only: `--a-st` = the colour mixed with black at `--a-k`, and
  `--glow`, `--s1`, `--s2`, `--s3` = `runtime.css`'s own formulas with `--a-st` in place of `--a`. The glow is held
  too: with the design's glow on the held stage, white falls to about 6.0:1 and the body copy to 3.8:1. `runtime.css`
  is unchanged; Respok's `tint` is unchanged (a Respok root is never `hold`, a WebYar root never `tint`). Everything
  that reads these tokens follows the held colour, the dark-square launcher's status dot included (`.ln-q .ls` in
  `runtime.css` reads `--glow`). `--a-st` keeps the colour's OKLCH hue; the held glow leans a little further toward
  `#5CF2D6`'s teal, since a darker colour goes into the same 42% (`#F5D90A`'s glow 139° → 149°, `#00FF00`'s
  156° → 160°).
- No colour, the default teal and every preset of both brands (`#0B7D6C #2563EB #7C3AED #DB2777 #D9480F #111827`,
  `#16142B #2F5BFF #0F766E #C2410C`) are never held: their tokens are `runtime.css`'s, byte for byte, and Tier A's
  default and preset rows are unchanged. A lower line would hold `#D9480F` (and below .178 `#DB2777` too), which the
  owner wants exactly as designed.
- Browsers without `color-mix()` skip the block: `runtime.css`'s D25 stage (the default teal), as before.
- Contrast, computed in `src/test/callWidget/callWidgetTheme.test.ts` from the real stylesheets (the hold block,
  `runtime.css`'s tokens, the panel's `.stage-bg` ground and the stage's text colours) and the renderer's `--a-k`, for
  238 colours and no colour (both brands' presets, the pair either side of the line, light, pastel and saturated
  colours, black and a 6×6×6 grid of the cube, each once). The lowest any colour reaches, held or not, is on
  saturated azure blues exactly as light as `#D9480F` (`#0073FF` unheld, `#0074FE` held at `--a-k` 99.8%): white
  ≥ 7.41:1 at the lightest point, the body copy `.sp` (white .68) ≥ 4.35:1, the white .66 lines (the header's status,
  the Se/Sf bar's time, screen 12's microphone how-to) ≥ 4.19:1, the secondary lines (white .60) ≥ 3.75:1; a 32³
  sweep of the cube finds nothing lower. Light colours, once held, sit higher (`#F5D90A` 7.47 / 4.48, `#FFFFFF`
  7.46 / 4.48). The default and the presets: 7.58 / 4.52 / 4.36 / 3.90 at `#D9480F`, the lightest (the default teal
  7.99 / 4.66 / 4.49 / 4.00). The test requires white ≥ 7 and the body copy ≥ 4.3 for every colour, ≥ 4.5 for the
  default and the presets: 4.3, not 4.5, because the worst colours are the design's own formula at its lightest
  preset's luminance. The .66 and .60 lines are the design's own at the presets too, and so is End against the
  middle of the Sf bar: 2.94:1 at the default, 2.81:1 at `#D9480F`, 2.78:1 on held colours (WCAG 1.4.11 asks 3:1).
  These figures are for the ground itself. The stage layer's 6% grain (`.lv .dk::after`, overlay) lightens it by
  about 2.7% per channel on average (up to about 5%), which takes every colour's figures down by about 3%, the
  presets included (the body copy with the average grain: the default 4.53, `#D9480F` 4.39, the worst held colour
  4.23); the Se/Sf bars have no grain. Read back from Chromium's own pixels (the ground without its grain, 245
  colours and an 18³ cube), gradient dithering moves single pixels a little lower again (the lightest pixel: held
  white ≥ 7.29, the body copy ≥ 4.33; `#D9480F` 7.49 / 4.47); averaged along each row they come out at or above the
  computed figures.
- Gates: the board-12 token probe (`e2e/callWidgetScreens.spec.ts`) states the held formulas itself and compares the
  live tokens for `#F5D90A`, checks the mark (`hold`, `--a-k`; no `tint`) and the no-`color-mix()` fallback in two
  steps: the skin put back without its block (a held root then draws the unheld stage), then `runtime.css`, the panel
  stylesheet and the skin put back with their `color-mix()` conditions flipped (a held root, `hold` and `--a-k`
  still set, draws D25's default teal stage). The reference re-render carries the same hold (deviation 12), so the
  `--matrix` light-accent run pixel-gates the held stage.

**The home badge agrees with the header when nobody is available** (D17 above): online with nobody available the
badge read "Live now" / «آنلاین» over a grey dot while the header said no operator was available. It now reads the
header's own `no_operator_now` in every locale and both brands (no new string), and drops its channel list for as
long as nobody is available (measured: with the list the sentence needs 348–372px of the 364 the home body has in
Persian and English). Pinned by `src/test/callWidget/callWidgetBadge.test.ts` (both brands, fa/en/tr, both ways on an
open panel).

**The operator's user id and e-mail are out of the call room.** Everyone in a LiveKit room sees every participant's
identity, name and metadata, and the visitor is in every call room. Members used to join as `operator:<user id>`,
named by their profile name or, from the macOS and Windows apps, by their e-mail when they had no name. Now:

- A member (operator, admin, internal) joins as `<type>:<ref>`, `<ref>` being the opaque reference the status endpoint
  already sends as `call.assigned_agent_id` (`server/services/calls/operatorIdentity.ts`, used by
  `livekitProvider.createParticipantToken` for every member token). The visitor can match the operator to the status
  and learns nothing about who it is. Visitor tokens keep their form.
- The room shows the member's profile name (the status's `operator_name` rule) or nothing: the `display_name` a client
  sends for a member is ignored, and `POST /api/calls/:id/token` uses the caller's own name only (a token minted for
  another member's id carries none).
- The LiveKit webhook finds the user again from the identity (the participant row stored at the join, the call's own
  columns and queue entry, then the workspace's members) and still reads `operator:<user id>` for calls that began
  before the deploy; a database error there now answers non-2xx, so LiveKit retries the event.
- `POST /api/call-center/calls/:id/transfer` also answers `assigned_participant_identity` (null while a department has
  nobody picked yet), for the desktop apps to wait for that identity before stepping out after a transfer. The apps'
  side is not in this release (the owner holds app releases for now): it is kept as
  `docs/call-widget-handoff/desktop-transfer-handover.patch` (macOS and Windows, with a fallback to
  `operator:<user id>` against an older server), for the next desktop release.
- Pinned by `src/test/calls/operatorParticipantIdentity.test.ts` and
  `src/test/callWidget/operatorIdentityPrivacy.test.ts` (no user id, e-mail or `@` in any claim of the operator's or
  the visitor's tokens; the token's subject is `operator:` + the status's `assigned_agent_id`).

## Deploy windows (D39)

Both last seconds and fix themselves on a reload:

- (a) A page holding an **old** `l.js` (cached before the deploy) whose hashed names vanished mid-deploy falls back to
  the new fixed-name scripts without `loadPanel`: the panel cannot open on that page view (the launcher stays, no error).
- (b) A tab open across a deploy fetches a newer panel by its fixed name: refused when its `v` differs (the next intent
  tries again), otherwise a minor stylesheet skew until a reload.

## Rollout

- **Migration 277 needs the owner's go-ahead before it is applied to WebYar's database, and it must be applied before
  this code is merged** (CLAUDE.md procedure: folder `/root/webyar-migrate-277/`, dry run inside `BEGIN … ROLLBACK`,
  `docker cp` into `oqzy9q4ovntam9jgf7nxzqun`, `migrate-database.sh` as `postgres` with `lock_timeout=5s`; then the
  ledger line in CLAUDE.md). The code also runs without it: the new settings then answer `503 migration_pending` until
  it is applied. RESPOK's migrator applies it on push, racing its backend: every read defaults a missing column
  (`round_label`, false, 30, 4, null) and a settings save naming a new column answers `503 migration_pending` (the
  dashboard says "try again in a few minutes"), never 500.
- Before the merge, read (only read) RESPOK's `/data/respok/migrator/overlay.sql` for any write to
  `call_center_settings`.
- Rolling deploy (the frontend and backend apps deploy minutes apart, and dashboard tabs stay open across it): the new
  dashboard sends a 277 field only when the settings it loaded have it (an old backend's `.strict()` PUT never sees
  one); the new PUT accepts an old dashboard's untouched resend (`business_hours` `{}`, a valid hours object or the
  stored value unchanged; position aliases normalised); no visitor endpoint gained a request field, every new bootstrap
  field has a default, and the status payload keeps its field names (`assigned_agent_id` now carries the opaque
  reference, so an old widget still sees a transfer as a change of value). The widget's own two windows: D39 above.
- Rolling-deploy windows checked in round 6 and accepted (they end when the pages and tabs reload):
  - A page still running the previous release's widget (6f8af41) draws a stored `bottom-left` row on the left as soon
    as the new backend is live: the server now normalises the position, so E1's visible change arrives with the backend.
  - A previous-widget tab open after the owner turns slots on gets `409 slot_unavailable` for a time off the grid and
    shows its generic "failed" text; the form is kept.
  - With the platform's ringback on, a previous-widget page that is in a call while the backend deploys plays its
    transfer ring from the poll where `assigned_agent_id` turns from the user id into the opaque reference until the
    call ends (the old engine treats any change of that value as a transfer, as on every real transfer; name and call
    time are unaffected; nothing in this release can reach that page's code). This release's engine treats a change
    between the two spellings with an unchanged or absent name as the same operator (`pollOnce`), so a deploy or a
    `ROLLBACK=1` during a call is not a transfer (`callWidgetChain.test.ts`).
  - The previous dashboard on the new backend shows an empty position select for `top_right` / `top_left` /
    `bottom_center` and resends the stored value unchanged (the save is accepted). The new dashboard on the previous
    backend once 277 is applied (WebYar's order) gets the strict `400` and the "try again in a few minutes" toast only
    for a changed design setting; everything else saves.
  - The bootstrap memo (30 s) can still offer a slot that has just filled: the booking's re-check answers `409` and the
    visitor goes back to step 1 with the error.
- The operator's room identity (round 6b) in a rolling deploy: calls in progress keep `operator:<user id>`, which the
  new webhook reads; a console that rejoins after the deploy comes back as `operator:<ref>` while the status turns from
  the user id into the reference, and the widget shows no transfer (the `pollOnce` rule above). During a `ROLLBACK=1`
  the previous webhook cannot read the new form: those participant rows are saved without a user, and the in-call lock
  of those operators is neither set nor cleared until the next deploy. Rare, and only while deploying: a console that
  takes a fresh token in the middle of a call is two participants for LiveKit (old and new identity), and a late
  `participant_left` of the old one can release the operator's in-call lock while they are still in the call.
- The desktop apps (macOS and Windows, both brands) are not changed in this release: a merge that touches `macos/` or
  `windows-native/` publishes all four apps automatically, and the owner holds app releases for now. Their transfer
  step-out is kept as `docs/call-widget-handoff/desktop-transfer-handover.patch` (written in round 6b, not yet compiled:
  apply it with `git apply` in the next desktop release, whose `desktop-native.yml` and `macos.yml` builds must pass).
  Until then an installed app no longer steps out on its own after a transfer to a named colleague (on macOS also after
  a department transfer where the server picked someone): the operator presses Leave, which shows after every
  transfer. The call itself is not affected; iOS, Android and the web dashboard need no release.
- Read-only counts the owner sees before the merge (both databases, `SELECT` only): rows with a non-empty
  `business_hours`; rows whose `widget_position` is `bottom-left` / `left` (E1 moves them from the right to the left);
  rows whose `widget_theme` has a `primary` or `accent` (they keep their colours, D24).
- Visible at merge for every customer, with no setting changed: the new design; stored `bottom-left` rows on the left;
  WebYar's footer drawn as designed; WebYar English launchers in InterWY.

## Reported to the owner (decided here, reversible later)

DM Mono for Respok's reference code (a 1,780 B subset would give the exact glyphs on one element of one screen); the
Turkish strings (below); the label's close `x` on `round_label` online only (D6); the booked callback kept in the
visitor's browser until its time (D15; an operator completing it earlier is not reflected); operators' names and
photos published only for `card` / `operator_face`, their photo URLs carrying the storage folder id as the chat's team
stack already does (D17, D27); stored colours kept (D24); the WebYar footer drawn as designed instead of the logotype
image (D20); the bottom-centre panel taking the corner the launcher left rather than opening above it (D13); Respok in
Persian showing Gregorian dates with Persian digits, like the International chat (D19); the open call panel covering
the chat launcher instead of stacking (D4); `mobile_bar` becoming the pill beside a chat launcher (D4); "No operator
available right now" when channels are on but nobody is available (D17; the home badge says it too, without its channel
list); Respok's stage in a workspace colour held darker than board 12-02's swatches, the orb's core kept white, and
Respok workspaces that saved a primary (e.g. the old coral) now see their stage in it (D24 keeps stored colours); WebYar's
own stage follows its accent as the design draws it, and a colour lighter than the lightest preset is held at a
luminance of .195, just above that preset's .1942 (round 7b, under "Owner requests of 2026-10-19"; the default and the
presets unchanged); on WebYar's stage, the design's own white .66 and .60 lines (4.36:1 and 3.90:1 at `#D9480F`,
4.19:1 and 3.75:1 at worst) and End against the Sf bar (2.94:1 at the default, 2.81:1 at `#D9480F`; WCAG 1.4.11 asks
3:1) kept as drawn; WebYar English and Turkish in InterWY (D3); the extra " PM" on Respok's booked-callback chip; the
top placements' fixed 20px offset (a site with a fixed header may want a setting).

## Turkish strings for review (D31)

Every Turkish string that is new or changed since `6f8af41` (14 changed, 46 new). The Persian and English values are
the handoff's (`shared/new-hooks-and-settings.md` §5) and the build's (§6 of the contract).

| Key | | English | Turkish | Before |
|---|---|---|---|---|
| `enable_ringing_sound` | changed | Enable ringing sound | Zil sesini aç | 🔊 Zil sesini aç |
| `connected_waiting` | changed | Connected, waiting | Bağlandı, bekleniyor | Bağlandı — bekliyor |
| `recording_progress` | changed | Recording in progress | Kayıt devam ediyor | ● Kayıt devam ediyor |
| `mute` | changed | Mute | Sessize al | 🎙 Sessize al |
| `unmute` | changed | Unmute | Sesi aç | 🎙 Sesi aç |
| `camera_off` | changed | Camera off | Kamerayı kapat | 🎥 Kamerayı kapat |
| `camera_on` | changed | Camera on | Kamerayı aç | 🎥 Kamerayı aç |
| `callback_intro` | changed | Tell us how to reach you and our team calls back fast. | Size nasıl ulaşacağımızı yazın; ekibimiz hızlıca geri arar. | Size nasıl ulaşacağımızı yazın — ekibimiz hızlıca döner. |
| `phone` | changed | Phone | Telefon | 🎙 Telefon |
| `video` | changed | Video | Video | 🎥 Video |
| `contact_required_note` | changed | Email or phone is required so we can reach you. | Size ulaşabilmemiz için e-posta veya telefon gerekir. | * Size ulaşabilmemiz için e-posta veya telefon gerekir. |
| `schedule` | changed | Schedule | Planla | 🗓 Planla |
| `urgent` | changed | Urgent | Acil | 🔥 Acil |
| `consent_required` | changed | I consent to this call being recorded for quality and security. | Bu aramanın kalite ve güvenlik için kaydedilmesine izin veriyorum. | … izin veriyorum. (gerekli) |
| `open_widget` | new | Open the call widget | Arama widget'ını aç | |
| `close` | new | Close | Kapat | |
| `launcher_pill` | new | Call support | Desteği ara | |
| `launcher_tab` | new | Call us | Bizi arayın | |
| `queue_place_short` | new | #{n} in line | Sırada #{n} | |
| `queue_next_short` | new | Next | Sıradaki | |
| `restore_call` | new | Open the call | Aramayı aç | |
| `end_call` | new | End call | Aramayı bitir | |
| `video_minimized` | new | Video call, minimized | Görüntülü arama, küçültüldü | |
| `minimize` | new | Minimize | Küçült | |
| `widget_language` | new | Widget language | Widget dili | |
| `channel_voice` | new | Voice | Sesli | |
| `voice_tile_sub` | new | Uses your microphone | Mikrofonunuzu kullanır | |
| `video_tile_sub` | new | Camera and microphone | Kamera ve mikrofon | |
| `edit` | new | Edit | Düzenle | |
| `permission_note` | new | Your browser will ask to use the camera and microphone. | Tarayıcınız kamera ve mikrofonu kullanmak için izin isteyecek. | |
| `you` | new | You | Siz | |
| `eta_value_minutes` | new | ~{n} minutes | ~{n} dakika | |
| `eta_value_under_min` | new | Under 1 minute | 1 dakikadan az | |
| `recording_short` | new | Rec | Kayıt | |
| `quality_excellent` | new | Excellent connection | Bağlantı mükemmel | |
| `quality_good` | new | Good connection | Bağlantı iyi | |
| `quality_poor` | new | Poor connection | Bağlantı zayıf | |
| `quality_lost` | new | Connection lost | Bağlantı koptu | |
| `transfer_hold` | new | Please stay on the line. | Lütfen hatta kalın. | |
| `mic_denied_title` | new | Microphone permission denied | Mikrofon izni reddedildi | |
| `mic_denied_body` | new | Please allow access and try again. | Lütfen izin verip tekrar deneyin. | |
| `mic_denied_how` | new | Click the lock next to the site address and turn the microphone on. | Site adresinin yanındaki kilide tıklayın ve mikrofonu açın. | |
| `microphone` | new | Microphone | Mikrofon | |
| `retry` | new | Try again | Tekrar dene | |
| `rtc_unsupported` | new | Calls can't connect right now | Arama şu anda bağlanamıyor | |
| `rating` | new | Rating | Puan | |
| `error_callback_hint` | new | Leave a callback request and our team will call you as soon as possible. | Geri arama isteği bırakın, ekibimiz sizi en kısa sürede arasın. | |
| `step_of` | new | Step {n} of {total} | Adım {n} / {total} | |
| `asap_option` | new | As soon as possible | En kısa sürede | |
| `today` | new | Today | Bugün | |
| `tomorrow` | new | Tomorrow | Yarın | |
| `continue` | new | Continue | Devam | |
| `change` | new | Change | Değiştir | |
| `at_time` | new | at {time} | saat {time} | |
| `time` | new | Time | Saat | |
| `copy_code` | new | Copy code | Kodu kopyala | |
| `summary_phone` | new | Phone | Telefon | |
| `summary_video` | new | Video | Görüntülü | |
| `no_operator_now` | new | No operator available right now | Şu anda müsait operatör yok | |
| `copied` | new | Copied | Kopyalandı | |

## Follow-ups (not built)

Defects and wishes found while building, outside the scope the owner set (D29):

- Engine: `submitCallback`, `pollOnce`, `toggleMic` / `toggleCam` have no `.catch` (a network error or a non-JSON 503
  shows nothing; an unhandled rejection every 5 s while offline); `api()` rejects on any non-JSON body (Coolify's 503
  page while the backend is down); a failed `join-token` is never retried ("connecting" forever); the honeypot's fake
  id shows as a reference code; `reset()` leaves the queue and poll intervals running; `_remoteCount` can count an
  operator twice (ParticipantConnected and the post-connect scan).
- No grace period before `operator_left` when the **same** operator drops and rejoins.
- The remote audio's autoplay after a restored call (LiveKit `AudioPlaybackStatusChanged` + `room.startAudio()` from a
  gesture, shown as the `tap_to_hear` hint).
- The server reaps no abandoned queued call (the engine retries a failed cancel once, E4).
- Callback capacity is a soft check (two visitors may book the last place at once).
- Presence has no heartbeat: an operator who forgets to go "away" shows as available (the same truth call routing uses).
- A booking an operator completes or cancels before its time stays on Sh until then (D15).
- The top placements' 20px offset is fixed; a site with a fixed header may want a setting.

## Visual QA and behaviour specs (local gates, not in CI)

All three specs need Chromium (`PLAYWRIGHT_CHROMIUM_PATH` or `/opt/pw-browsers`) and run one worker:

```sh
# Tier A: every P/M/C state of both brands against the reference re-render (≤ 0.20% per panel, box probes ±0.5px),
# the eight placements by geometry, and board 12's tokens computed in the live widget (tokens.json, every accent,
# the radius sets, the @supports fallbacks), and the other direction (WebYar in English, Respok in Persian) as the
# mirror image of the drawn one (icons, buttons, dock, orb); nothing is pending any more: a state that does not pass fails
npx playwright test e2e/callWidgetScreens.spec.ts --workers=1
# the same with the matrix: every other preset accent, #F5D90A and radius sm/lg (about 6 minutes per run)
CALL_SCREENS_MATRIX=1 npx playwright test e2e/callWidgetScreens.spec.ts --workers=1 -g "matrix"
# with the owner's full package: the reference against the acceptance PNGs
CALL_HANDOFF_PACKAGE=<unpacked handoff> npx playwright test e2e/callWidgetScreens.spec.ts --workers=1 -g "reproduces"

# Behaviour (§8.4: ticks, minimise, forms, audio, a11y, motion, digits, fonts, phones, lazy panel, media fixes,
# docks, transfer, outcomes) and placement (the eight placements, two widgets, the page lock)
npx playwright test e2e/callWidgetBehaviour.spec.ts e2e/callWidgetPlacement.spec.ts --workers=1

# The harness by hand: PNGs and report.json per state (live, ref, diff), Tier B sheets with the package
npx tsx e2e/harness/callScreens.ts --brand webyar --out /tmp/call-shots
npx tsx e2e/harness/callScreens.ts --brand respok --states 05-01-home,09-13-rating --shipped
npx tsx e2e/harness/callScreens.ts --brand webyar --matrix            # every preset accent, #F5D90A, radius sm/lg
# Tier B: one sheet per acceptance PNG (81 per brand) in <out>/<brand>/tier-b: the P/M/C panels beside the live crop
# and its heat map, the placements beside the live screen closed and open, the review-only panels beside the state
# they show (board 04 on a 648×948 page), board 12's specification sheets on their own (their tokens are probed)
npx tsx e2e/harness/callScreens.ts --brand webyar --out /tmp/call-shots --compare-acceptance <unpacked handoff>
npx tsx e2e/harness/callScreens.ts --list
```

The live side boots the real `l.js` on `https://nilufar.store` (the boards' demo store) from `https://widget.test`,
in three modes: `--source` (the raw files), `--shipped` (each file as its brand ships it) and `--built <dist>` (a
scratch hashed build). Every request is answered in memory; a request to any other host is aborted and logged, and
that log must stay empty. The
behaviour and placement specs drive the same page through `e2e/harness/callSession.ts`: a call server whose status a
test changes between polls, a fake LiveKit room (`window.__lk`: operators join and leave, permissions are refused,
the connection quality changes; tracks are real `<video>`/`<audio>` elements), and the chat widget's real loader for
the two-widget checks. The fixture (`e2e/harness/callScreensFixture.ts`) holds the boards' demo data;
`src/test/callWidget/callScreensFixture.test.ts` checks every demo string against the reference HTML.

## Sizes

Measured in round 7 (2026-10-19; the core, WebYar's skin, `l.js` and the page-load totals again in round 7b, 2026-10-20,
after WebYar's stage hold), as each brand's build ships the files (`scripts/build/widgetBrand.mjs`, gzip level 5):
`default` in the `iran` build, `intl` in the `respok` build, the files both ship in both (the larger counts). `l.js` is
measured built: the table gives the `dist/call-widget/l.js` of a full scratch build of each brand (`npm run build`);
`templateRules.test.ts` writes the same names into it (`scripts/call-widget-hash.js`'s naming; only the fonts
stylesheet's hash differs, up to 2 B). The caps are measured + max(250 B, 6%), rounded up to 100 B (`BUDGETS.call` in
`src/test/widget/templateRules.test.ts`); the reasons per row are in `docs/operations/WIDGET_TEMPLATE_RULES.md` §5.

| Paid on | File | `default` (iran) | `intl` (respok) | `6f8af41` | Estimate (contract §7) | Cap |
|---|---|---|---|---|---|---|
| every page view | `l.js` built | 2,254 | 2,253 | 2,055 | 2,300–2,500 | 2,600 |
| page load | `presentation-registry.js` | 337 | 337 | 337 | — | — |
| page load | `runtime.js` (engine) | 19,863 | 19,792 | 17,105 | 20,500–22,500 | 21,100 |
| page load | `presentation-default.js` (core) | 9,816 | 9,816 | 7,821 | 5,500–8,500 | 10,500 |
| page load | `runtime.css` | 4,561 | 4,561 | 3,621 | 5,300–6,300 | 4,900 |
| page load | skin (`presentation-default.css` / `presentation-intl.css`) | 323 | 1,886 | 269 / 519 | ≤ 2,400 | 2,200 |
| page load | fonts stylesheet (shared with the chat) | 1,161 | 1,161 | 1,161 | — | (chat: 3,000) |
| **page load total** | | **38,315** | **39,806** | 32,369 / 32,555 | 37,000–42,000 | 42,200 |
| first intent | `presentation-default-panel.js` | 17,024 | 17,445 | — | 11,000–15,000 | 18,500 |
| first intent | `presentation-default-panel.css` | 10,167 | 10,167 | — | 10,300–12,000 | 10,800 |
| **first-open total** | | **27,191** | **27,612** | — | 21,000–27,000 | 29,300 |

Two files are above their estimates: the core (9.8 KB vs 8.5) and the panel module (17.4 KB vs 15). Round 7 searched
both for waste first (each function's share of the shipped gzip, unused names, lowered-syntax helpers): the bytes are
the drawn features (core: the nine launcher styles 1.0 KB, the chat stacking 0.6 KB, the theme pipeline 0.6 KB, the lazy
panel's loading 0.45 KB; module: some 60 screen and control builders of 0.05–0.8 KB each, the Respok build +0.4 KB for
its lockup); one dead statement was removed (18–22 B). `runtime.css` came in under its estimate, so the page-load total
stays inside its estimate; the first-open total does not (27,612 `intl` / 27,191 `default` vs 27,000: the panel module's
excess, partly offset by the panel stylesheet coming in under its own). Compared with `6f8af41`, a page view that never
opens the call panel pays +5.9 KB (`default`) / +7.3 KB (`intl`); the panel's 27.2–27.6 KB come on the visitor's first
intent (pointer over the launcher, focus, a press), before the click.

Fonts (woff2 bytes, requests logged in Chromium through the harness, shipped and source modes alike; the launcher is the
default `round_label`, which shows text):

| Brand, locale | Page load | First open adds | First panel paint |
|---|---|---|---|
| WebYar / Respok, fa | IRANSans 400 + 700 (61,256) | IRANSans 500 only | 88,264 (cap 120,000) |
| WebYar, en / tr | InterWY Latin `inter-500-latin` (20,908) | nothing | 20,908 (cap 50,000) |
| Respok, en | `figtree-latin` (18,540) | nothing | 18,540 (cap 50,000) |
| Respok, tr | `figtree-latin` + `figtree-tr` (20,852) | nothing | 20,852 (cap 50,000) |

No Vazirmatn, no DM Mono, no static Figtree file, no other host, and no panel file at page load, in either brand.
