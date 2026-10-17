# WebYar chat widget · Template 1 "Classic" — implementation spec

> **In this repository:** only this README, `tokens.json` and `reference/css/` (without `fonts.css`) were committed.
> The board sources (`source/`), the static reference pages (`reference/*.html`), the font files (`reference/fonts/`,
> `reference/css/fonts.css`) and the screenshots (`screens/`) were left out of the repository, so links into them do not
> open here; they are in the design handoff bundle. Read [IMPLEMENTATION_NOTES.md](../../IMPLEMENTATION_NOTES.md) first.

WebYar (وب‌یار) Template 1 is the Persian, right-to-left chat widget of the Iranian edition: a home screen with a brand
gradient hero and floating cards, a conversation view, a help center and a Messages list, tied together by a bottom
menu (Home / Messages / Help). Per [brief §3](../../CLAUDE_CODE_BRIEF.md) it becomes production template id `default`,
restyled in place (`public/widget/presentation-default.js` + `presentation-default.css`). The main idea: one accent
colour (`--a`) drives every tint through `color-mix()`, cards float over the hero, and the composer is a single rounded
box whose round action button turns from microphone to send.

Read with: [brief](../../CLAUDE_CODE_BRIEF.md) (global rules, frame, accent pipeline, fonts, acceptance) ·
[brand sheet](../README.md) · [production map](../../shared/production-map.md) · [tokens.json](tokens.json).

Conventions in this file:

- Values are CSS px at 1x. "Rendered" means the computed value in the reference page (what the screenshots show).
- "Not specified in the design" is followed by a suggestion only when it is marked **Suggestion**.
- Class names in `code` without a prefix are design classes from [reference/css/widget.css](reference/css/widget.css)
  (line numbers given as `widget.css:NN`) or from a board's own `<style>` (named). Production classes are given with
  the production file (`public/widget/presentation-default.js` = PD, `presentation-default.css` = CSS, `loader.js` = LD).
- Physical directions (left/right) are given for the RTL widget as drawn; logical properties are named where the CSS
  uses them.

---

## 0. Files in this folder

| Path | What it is | How to use it |
|---|---|---|
| [source/](source/) | 13 board sources (`NN-name.dc.html`): HTML template, `{{holes}}`, `<sc-if>`/`<sc-for>`, and a `class Component` script at the bottom (`renderVals()`, timers). `data-props` JSON = board options (accent presets, menu mode) | Exact markup, copy, inline styles, SVG paths, interactive behaviour and timings |
| [reference/](reference/) | Static render of each board (`NN-name.html`) and extra states (`06-…--picker-open.html`, `10-…--open.html`, `11-…--closed.html`). No scripts | Open from disk in Chrome; use DevTools for computed values |
| [reference/css/widget.css](reference/css/widget.css) | The design stylesheet (tokens on `.cv`, all components). The same file serves Respok with `respok.css` on top; this README documents WebYar only | Every number in this README comes from here or from a board's inline `<style>` |
| [reference/css/fonts.css](reference/css/fonts.css), [reference/fonts/](reference/fonts/) | Vazirmatn 400/500/600/700 (byte-identical to production `public/widget/fonts/`) | Font faces for the reference pages only; production loading is in brief §6 |
| [screens/panels/](screens/panels/) | Every widget screen at 2x (896 × 1536 = 400 × 720 panel + 24px canvas margin; mobile 876 × 1784 = 390 × 844 + 24px) | **The acceptance target** |
| [screens/boards/](screens/boards/) | Whole boards at 1x, with the designer's Persian title and explanation | Context; boards 02 and 13 have no panel crops, use the board image |
| [screens/states/](screens/states/) | Interactive boards captured in another state | 06 picker open, 10 open/close tile in the open state, 11 preview closed |
| [tokens.json](tokens.json) | Tokens resolved for the default accent `#0B7D6C`, plus `brandOverrides` (hand-tuned hero) | Do not duplicate; §3 summarises |

**Board chrome is not product UI.** Do not implement: board titles and descriptions (`.cv-t`, `.cv-d`, and `.bh`/`.bt`
in board 10), screen labels (`.tag`), layout wrappers (`.cv-row`, `.cv-col`, board 02's `.crop`/`.vrow`/`.vhead`/`.st3`/
`.cap3`), the component spec card in 05·3 (`.spec`, `.sg`, `.sc`, `.flow`; its *content* is spec, see §4.4 and §5.11), the fake host
website (`.host`, `.hbar`, `.hblk` in boards 10/11), the replay button (`.rp`), the settings controls of board 11
(`.pn`, `.opts`, `.opt`, `.sws`, `.seg`, `.nvo`, `.mini`, `.tnote`: documented as settings in §5.24), the token-sheet
panels of board 13 (`.pnl`…: transcribed in §3) and the phone chrome (`.safe`, the 390 × 844 frame radius 44).
Sample content (names سارا/مهدی/رضا/علی, store فروشگاه نیلوفر, order numbers, messages, article bodies, file names,
times) is demo data; UI strings are in §10.

---

## 1. Screen inventory

ID = board number · label printed on the board (Persian digits/letters transliterated: الف = a, ب = b, ج = c, د = d,
ه = e). Production-map sections link to [shared/production-map.md](../../shared/production-map.md).

| ID | Screen | Screenshot (2x) | Reference page | Production view (production-map §) | Work |
|---|---|---|---|---|---|
| 01·02 | Home (online, no history) | [01-home--02-home.png](screens/panels/01-home--02-home.png) | [01-home.html](reference/01-home.html) | §4.1 `homeHtml` (`.wy-view-home`) + new bottom menu | Restyle + markup |
| 01·03 | Home with a recent chat | [01-home--03-home-with-a-recent-chat.png](screens/panels/01-home--03-home-with-a-recent-chat.png) | [01-home.html](reference/01-home.html) | §4.1 + compact conversation row (§4.3) | Restyle + markup |
| 01·08 | Team away (offline home) | [01-home--08-team-away.png](screens/panels/01-home--08-team-away.png) | [01-home.html](reference/01-home.html) | §4.1 with `isOnline=false` (`homeReplySlow`, `homeLeaveMessage`) | Restyle + markup |
| 02·a–d | Bottom bar, four styles (each with Home / Messages / Help active) | [boards/02-bottom-bar-styles.png](screens/boards/02-bottom-bar-styles.png) (no panel crops) | [02-bottom-bar-styles.html](reference/02-bottom-bar-styles.html) | none | New |
| 03·a | Bottom menu: icons and labels (`.nv-both`) | [03-…--a-icons-and-labels.png](screens/panels/03-bottom-menu-modes--a-icons-and-labels.png) | [03-bottom-menu-modes.html](reference/03-bottom-menu-modes.html) | none | New |
| 03·b | Icons, label on the active tab (default) | [03-…--b-icons-active-label-default.png](screens/panels/03-bottom-menu-modes--b-icons-active-label-default.png) | same | none | New |
| 03·c | Icons only (`.nv-icon`) | [03-…--c-icons-only.png](screens/panels/03-bottom-menu-modes--c-icons-only.png) | same | none | New |
| 03·d | Labels only (`.nv-text`) | [03-…--d-labels-only.png](screens/panels/03-bottom-menu-modes--d-labels-only.png) | same | none | New |
| 03·e | No menu (`.nv-none`) | [03-…--e-no-menu.png](screens/panels/03-bottom-menu-modes--e-no-menu.png) | same | §4.1 `home-link[data-view=list]`; §4.3/§4.4 back buttons | New |
| 04·04 | Thread and typing | [04-conversation--04-thread-and-typing.png](screens/panels/04-conversation--04-thread-and-typing.png) | [04-conversation.html](reference/04-conversation.html) | §4.2 `chatFrameHtml`, §5.1 rows, §5.6 typing (visible bubble is new), §5.7 composer | Restyle + markup |
| 04·05 | Attachments, errors and typing | [04-conversation--05-attachments-errors-and-typing.png](screens/panels/04-conversation--05-attachments-errors-and-typing.png) | same | §5.1 failed + retry, §5.5 attachments, §5.7 `att-preview` | Restyle + markup |
| 04·06 | New conversation and topics | [04-conversation--06-new-conversation-and-topics.png](screens/panels/04-conversation--06-new-conversation-and-topics.png) | same | §4.2 `emptyHtml`, §5.12 Q&A chips | Restyle + markup |
| 05·1 | Recording | [05-voice-messages--1-recording.png](screens/panels/05-voice-messages--1-recording.png) | [05-voice-messages.html](reference/05-voice-messages.html) | §5.7 `rec-bar` | Restyle + markup |
| 05·2 | Preview before sending | [05-voice-messages--2-preview-before-sending.png](screens/panels/05-voice-messages--2-preview-before-sending.png) | same | §5.7 `vn-bar` | Restyle + markup |
| 05·3 | Button states (spec card) | [05-voice-messages--3-button-states.png](screens/panels/05-voice-messages--3-button-states.png) | same | §5.7 `mic-btn`, `send-btn`, `rec-confirm`, `vn-send` | Restyle |
| 06·1 | Tap the emoji icon | [06-emoji-in-composer--1-tap-the-emoji-icon.png](screens/panels/06-emoji-in-composer--1-tap-the-emoji-icon.png) | [06-emoji-in-composer.html](reference/06-emoji-in-composer.html) | §5.7 `.emoji-btn[aria-expanded]` | Restyle |
| 06·2 | Emoji in the same box | [06-emoji-in-composer--2-emoji-in-the-same-box.png](screens/panels/06-emoji-in-composer--2-emoji-in-the-same-box.png) | same | §5.7 `[data-emoji-picker]` | Restyle + markup |
| 06·3 | Live preview (+ state: picker open) | [06-emoji-in-composer--3-live-preview.png](screens/panels/06-emoji-in-composer--3-live-preview.png), [states/06-…--picker-open.png](screens/states/06-emoji-in-composer--picker-open.png) | [06-emoji-in-composer.html](reference/06-emoji-in-composer.html), [06-…--picker-open.html](reference/06-emoji-in-composer--picker-open.html) | §5.7 | Restyle + markup |
| 07·07 | Pre-chat form with an error | [07-forms-offline-messages--07-prechat-form-with-an-error.png](screens/panels/07-forms-offline-messages--07-prechat-form-with-an-error.png) | [07-forms-offline-messages.html](reference/07-forms-offline-messages.html) | §4.5 `prechatFormHtml`, §5.15 validation | Restyle + markup |
| 07·09 | Message while away | [07-forms-offline-messages--09-message-while-away.png](screens/panels/07-forms-offline-messages--09-message-while-away.png) | same | §4.2 offline chat (production screen 09) + §4.6 contact fallback hooks (`data-fb*`) | Restyle + markup (inline e-mail card is new) |
| 07·13 | Messages (all conversations) | [07-forms-offline-messages--13-messages-all-conversations.png](screens/panels/07-forms-offline-messages--13-messages-all-conversations.png) | same | §4.3 `conversationListHtml` | Restyle + markup |
| 08·a | Form card in the chat | [08-prechat-in-chat--a-form-card-in-the-chat.png](screens/panels/08-prechat-in-chat--a-form-card-in-the-chat.png) | [08-prechat-in-chat.html](reference/08-prechat-in-chat.html) | §4.7 `handoffPrechatCardHtml` (`.hc-card`) | Restyle + markup |
| 08·b | Step by step, like a chat | [08-prechat-in-chat--b-step-by-step-like-a-chat.png](screens/panels/08-prechat-in-chat--b-step-by-step-like-a-chat.png) | same | none | New |
| 08·c | After submitting | [08-prechat-in-chat--c-after-submitting.png](screens/panels/08-prechat-in-chat--c-after-submitting.png) | same | summary: none; queue pill: §5.2 `routing_in_queue` system row | New + Restyle |
| 09·10 | Help | [09-help-center--10-help.png](screens/panels/09-help-center--10-help.png) | [09-help-center.html](reference/09-help-center.html) | §4.4 `kbHtml` (list); `kbSearchBarHtml` (exists, not composed) | Restyle + markup |
| 09·12 | Article | [09-help-center--12-article.png](screens/panels/09-help-center--12-article.png) | same | §4.4 article + §5.14 rating | Restyle + markup |
| 10 | Launcher and greeting (+ state: open/close tile open) | [boards/10-launcher-and-greeting.png](screens/boards/10-launcher-and-greeting.png), [states/10-…--open.png](screens/states/10-launcher-and-greeting--open.png) | [10-launcher-and-greeting.html](reference/10-launcher-and-greeting.html), [10-…--open.html](reference/10-launcher-and-greeting--open.html) | §3.1/§3.2 launcher (WebYar kit, verbatim); §5.11 smart nudge = greeting | Launcher: none; greeting: Restyle + markup |
| 11 | Launcher and colour (settings + live preview; + state: closed) | [boards/11-launcher-and-color.png](screens/boards/11-launcher-and-color.png), [states/11-…--closed.png](screens/states/11-launcher-and-color--closed.png) | [11-launcher-and-color.html](reference/11-launcher-and-color.html), [11-…--closed.html](reference/11-launcher-and-color--closed.html) | §1.5 config (`fab.*`, `primaryColor`, `position`) + new settings | New (settings) |
| 12·14 | Mobile home | [12-mobile--14-home.png](screens/panels/12-mobile--14-home.png) | [12-mobile.html](reference/12-mobile.html) | §2 mobile sheet (`.shell.gs-mobile-open .panel`) | Restyle |
| 12·15 | Mobile conversation | [12-mobile--15-conversation.png](screens/panels/12-mobile--15-conversation.png) | same | §2 mobile sheet | Restyle |
| 13 | Design tokens (sheet) | [boards/13-tokens.png](screens/boards/13-tokens.png) | [13-tokens.html](reference/13-tokens.html) | n/a | Spec (§3) |

The screen numbers 02–15 deliberately match the production captures cited in the production map (`[shot fa-02]` …
`fa-15`).
The panel PNGs match the reference pages (pixel diff checked at 2x; only animation frames differ).

---

## 2. Frame and layout

### 2.1 Panel

| Property | Value | Source |
|---|---|---|
| Size | 400 × 720 (production today 420 × 680; brief §4) | `.w` widget.css:43 |
| Radius | 28px, all four corners, no tail | `.w` |
| Shadow | `--sh-3` = `0 0 0 1px rgba(15,18,23,.05), 0 14px 32px -14px rgba(15,18,23,.22), 0 50px 100px -40px rgba(15,18,23,.38)` | `.w`, tokens.json |
| Overflow / stacking | `overflow:hidden; isolation:isolate`; flex column | `.w` |
| Base text | Vazirmatn 14px / 1.7 (23.8px), `--ink` | `.w`, `.cv` |
| Background | `#fff`; screens with floating cards use `.bgw` = `--bg` (`#EFF2F4`): home (01, 03, 11, 12·14) and help list (09·10). Chat, forms, Messages list, article: white | widget.css:43-44 |
| Viewport caps, anchor, open/close origin | unchanged from production (brief §4) | — |

When the viewport cap shrinks the panel (brief §4), only the scrolling middle gives up height; hero, headers,
composer, footer and bottom menu keep their size.

### 2.2 Regions per screen type (desktop, measured in the reference pages)

**Home** (01·02 shown; `.w.bgw`):

| Region | Design class | Top (y) | Height | Spec |
|---|---|---|---|---|
| Hero | `.hx` | 0 | 244.3 (content-driven) | `padding:18px 20px 80px`; `background:var(--hero)`; `color:#fff`; `overflow:hidden`; highlight `::after` (§4.2) |
| Hero top row | `.hx-top` | 18 | 48 | logo (inline-start, right) · spacer · close (inline-end, left); `z-index:1` |
| Greeting | `.hx-hi` | 96 | 27.2 | `margin:30px 0 0` |
| Question | `.hx-q` | 125.2 | 39.15 per line | `margin:2px 0 0`; wraps if longer |
| Body | `.bd` | 188.3 | flex 1 (459.7) | `margin-top:-56px` (cards overlap the hero by 56px), `padding:0 14px`, column, `gap:12px`, `z-index:2` |
| Cards | `.cd` | 188.3 → | per card | see §5.1–5.3 |
| Footer | `.pw` | 616 | 32 | `.bd > .pw{margin-top:auto}`: pinned to the bottom of the body |
| Bottom menu | `.tabs.vb` | 648 | 60 + 12 margin | `margin:0 12px 12px` |

**Conversation** (04·04): header `.hd` 0–68 · thread `.th` 68–598 (flex 1) · composer `.cmp` 598–688 (8px top
padding + 82px box) · footer `.pw` 688–720. No bottom menu.

**Messages list** (07·13, white): `.ttl` 0–64 · list 64–560 (flex 1, `padding:0 16px`) · CTA wrapper 560–616
(`padding:8px 16px 0`, 48px button) · footer 616–648 · bottom menu 648–708 (+12).

**Help** (09·10, `.bgw`): white header group 0–122 (`box-shadow:0 1px 0 var(--line)`: `.ttl` 64 + search wrapper
`padding:0 16px 14px` with a 44px field) · body `.bd` 122–648 (`margin-top:0; padding:14px 14px 0`) with footer at its
bottom (616–648) · bottom menu 648–708.

**Form** (07·07, white): `.hd` 0–68 · `.fm` 68–688 (`padding:20px 18px 8px`, column, `gap:16px`; the submit block has
`margin-top:auto`) · footer 688–720.

**Article** (09·12, white): `.hd` 0–68 · `.art` 68–556 (flex 1) · feedback `.fb` 556–609 · ask card `.ask` 619–688
(`margin:10px 14px 0`) · footer 688–720.

**Scrolling regions** (production): home cards area, thread, Messages list, help body, article body, form body. The
board CSS uses `overflow:hidden` (static boards); in production these are the `.wy-scroll` containers
(`.wy-home-scroll`, `[data-chat-messages]`, `.wy-list-scroll`, `.wy-kb-scroll`, the pre-chat `.wy-scroll`). On home,
keep the footer and bottom menu outside the scroller (brief §4: footer never shrinks): wrap the cards in the scroller
and leave `.pw` as a `flex:none` sibling at the bottom of the body column.

**Z-order:** hero highlight `.hx::after` (pointer-events none) < hero content (`z-index:1`) < body cards (`.bd`
`z-index:2`) ; headers `.hd` `z-index:2` (their hairline sits over the thread's top fade) ; bottom menu `z-index:3`.
Production keeps `.panel-close` at `z-index:20` and `.wy-jump` at 4.

### 2.3 Mobile (12·14, 12·15)

The boards draw the sheet in a 390 × 844 phone frame with radius 44 and a home bar (`.safe`, 28px): device chrome. In
production the open sheet is `.shell.gs-mobile-open .panel` (full screen, radius 0, `env(safe-area-inset-top/bottom)`
padding; production map §2). Apply the `.w.mob` rules (widget.css:393-409) under `.shell.gs-mobile-open .panel` and,
for the first frame, under `@media (max-width:640px)`:

| Design rule | Value | Production selector |
|---|---|---|
| `.w.mob` base | font-size 15px (radius 44 = frame, ignore) | `.shell.gs-mobile-open .panel` |
| `.w.mob .hx` | `padding:22px 20px 86px`; hero 276.2 tall; cards start at y 220.2 | home hero |
| `.grab` | 40 × 5, radius 3, `rgba(255,255,255,.5)`, `margin:0 auto 14px`, above the top row | decorative handle: render only if swipe-to-close is implemented (not specified in the design); otherwise omit (the top row then starts 19px higher than the screenshot) |
| `.w.mob .ib` | 44 × 44, radius 14 (close X 22px; back chevron 22px) | all icon buttons, `.panel-close` |
| `.w.mob .hx-q` | 29px | hero question |
| `.w.mob .bb` | 15px | bubbles |
| `.w.mob .li` | min-height 50px, 15px | list rows |
| `.w.mob .tools .ib` | 44 × 44 | composer emoji/attach |
| `.w.mob .ra` | 46 × 46 | round action button |
| `.w.mob .hd` | `height:auto; padding:22px 10px 10px` → 76px tall with a 44px avatar | chat header |
| `.w.mob .tabs.va` | height 92, `padding-bottom:32px` | classic bar |
| `.w.mob .tabs.vb/.vc/.vd` | height 64, `margin-bottom:34px` | floating bars |
| `.nv-both .w.mob .tabs.vb` | height 68; labels 12px | icons-and-labels mode |
| `.w.mob .tab` | 12.5px | tab labels |
| Inline overrides in 12·14 | CTA `.btn`: height 52, radius 16, 16px; search `.sr`: height 48, 15px, icon 20px; close icon 22px | home |
| Inline overrides in 12·15 | header avatar 44 (`.s44`), name 16px, subtitle 12.5px; textarea 15px; composer icons 22px | chat |

Safe areas: the 34px under the floating bar equals the iPhone bottom inset, and the 28px `.safe` under the chat footer
is the home bar. **Suggestion:** on views with a bottom menu use `margin-bottom:max(12px, env(safe-area-inset-bottom))`
for the bar and drop the panel's own bottom inset padding there so the inset is not counted twice; on home let the hero
gradient run under the status bar (hero `padding-top: calc(22px + env(safe-area-inset-top))`, panel top padding 0 on
home) so no white strip appears above it. Keyboard / `visualViewport` behaviour is unchanged (production §2).

---

## 3. Tokens

Define the tokens on `:host, .shell` (brief §5) with `--a: var(--gs-primary)`; the design defines them on `.cv`
(widget.css:8-29). Full list with resolved values: [tokens.json](tokens.json).

### 3.1 Colour

| Token | CSS expression | Default (accent `#0B7D6C`) | Used for |
|---|---|---|---|
| `--a` | `var(--gs-primary)` | `#0B7D6C` | accent: focus rings, read ticks, live wave, progress bars, `.nb`, `.logo` letter, tab icon in `.vc` |
| `--a-1` | `color-mix(in oklab,var(--a) 5%,#fff)` | `#F4F8F7` | tip callout, image placeholder stripes |
| `--a-2` | `color-mix(in oklab,var(--a) 10%,#fff)` | `#E9F2EF` | soft fills: `.ra`, `.btn-s`, `.lt` tiles, active `.vb` capsule, `.chip.on`, step numbers |
| `--a-3` | `color-mix(in oklab,var(--a) 19%,#fff)` | `#D6E6E1` | focus halo, rings on soft fills, hover of `.ra`/`.btn-s` |
| `--a-hi` | `color-mix(in oklab,var(--a) 92%,#fff)` | `#2F8777` | top stop of primary gradients |
| `--a-ink` | `color-mix(in oklab,var(--a) 74%,#0B0D12)` | `#165D53` | text and icons on tints, links |
| `--ink` / `--ink-2` / `--ink-3` / `--ink-4` | literals | `#0F1217` / `#434955` / `#666D7A` / `#A3A9B4` | text, secondary, muted, chevrons |
| `--bg` | `color-mix(in oklab,var(--a) 3%,#F5F6F8)` | `#EFF2F4` | `.bgw` panels, search, notes, hover |
| `--bg-2` | `color-mix(in oklab,var(--a) 5%,#EDEFF2)` | `#E3E9EB` | icon-button hover, `.vc` bar, resolved tag, skeleton |
| `--line` / `--line-2` | `color-mix(in oklab,var(--a) 6%,#E7E9ED)` / `…7%,#D4D8DE)` | `#DBE2E5` / `#C8D2D6` | hairlines / control rings |
| `--op` | `color-mix(in oklab,var(--a) 6%,#F0F2F5)` | `#E4EBEC` | operator bubble |
| `--ok` / `--bad` / `--rec` | literals | `#12A150` / `#D33A43` / `#E5484D` | online, errors, recording |
| `--hero` | `linear-gradient(155deg, color-mix(in oklab,var(--a) 78%,#fff) 0%, var(--a) 55%, color-mix(in oklab,var(--a) 86%,#000) 100%)` | stops `#54998A`, `#0B7D6C`, `#076557` | hero, `.vd` bar, `.av.sa` |
| **Brand override** `--hero` | `linear-gradient(155deg,#1DB99D 0%,#0F927D 46%,#0B7D6C 100%)` | — | only when the accent is uncustomised (empty or `#3B82F6`) or `#0B7D6C` (brief §5.2; boards set it when accent = `#0B7D6C`) |

Literal colours used by the components (not tokens):

| Value | Where |
|---|---|
| `#fff` | panel, cards, headers, composer, inputs; text on accent: `.btn-p`, `.R .bb`, `.nb`, `.go`, hero (`.hx`, `.ib.dk`), inactive `.vd` tabs (`rgba(255,255,255,.78)`). Replace `#fff`-on-accent with `--on-a` (brief §5.3) |
| `rgba(255,255,255,.88)` / `.15` / `.25` / `.16` | hero greeting / close button / its hover / hero highlight |
| `#FFB423` on `#12141F`, ring `#fff` 2.5px | tab badge (same yellow as the launcher badge) |
| `#A3A9B4` + halo `#ECEEF1` | offline `.live.off`; `.pr.off` |
| `#B5BAC4` | `.av.sa.off` (defined, unused) |
| Avatar tiles | `.c1` `#FCE3D4`/`#8A3410` · `.c2` `#DCE6FB`/`#1C4A92` · `.c3` `#D2EEDF`/`#145E39` · `.c4` `#EBE1FA`/`#57309A` |
| `#7A808C` | input and composer placeholders |
| `#272B34` | article paragraphs and steps |
| `#0F6B37` | open tag text, summary header text |
| `color-mix(in oklab,var(--ok) 12%,#fff)` = `#E7F4E9` | open tag bg |
| `color-mix(in oklab,var(--ok) 9%,#fff)` = `#EDF7EF` | summary header bg |
| `color-mix(in oklab,var(--ok) 20%,transparent)` | 3px halo of `.live` |
| `color-mix(in oklab,var(--rec) 10%,#fff)` = `#FFEEED`, ring `…24%,#fff` = `#FFD6D3` | stop button |
| `color-mix(in oklab,var(--rec) 55%,#fff)` = `#F9A09C`, halo `…12%,#fff` = `#FFEBE9` | recording composer ring |
| `color-mix(in oklab,var(--bad) 12%,#fff)` = `#FDE9E7` | error input halo |
| `#EEF0F3` / `#AEB3BE` | disabled round button bg / icon |
| `rgba(15,18,23,.58)` + white | image caption bar |
| `rgba(15,18,23,.05)` / `rgba(255,255,255,.17)` | quote block in operator / visitor bubble |
| `rgba(15,18,23,.06)` / `rgba(255,255,255,.18)` | code chip in operator / visitor bubble |

### 3.2 Typography

Font stack: `"Vazirmatn", ui-sans-serif, system-ui, sans-serif` (weights 400/500/600/700; 600 is used heavily: labels,
tabs, buttons). Monospace (code chip only): `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`. No letter-spacing
anywhere (token sheet: «وزیرمتن · بدون فاصله حروف»). Weight 800 (tab badge) has no face and renders with the 700 face.

| Role | Size / line-height / weight | Classes |
|---|---|---|
| Hero question | 27 / 1.45 / 700 (mobile 29) | `.hx-q` |
| Article title | 21 / 1.6 / 700 | `.art h1` |
| Screen title | 19 / 1.7 (inherited, 32.3px) / 700 | `.ttl h2` |
| Hero greeting | 17 / 1.6 / 500, `rgba(255,255,255,.88)` | `.hx-hi` |
| New-conversation team title | 17 / 1.5 / 700 | `.wel h3` |
| Article h2 | 16 / 1.7 / 700 | `.art h2` |
| Card title, header name | 15 / 1.45 / 700; 15 / 1.4 / 700 | `.t1`; `.hn` |
| Primary button | 15 / 1.7 / 600 | `.btn` (rendered as `<a>`) |
| Message | 14.5 / 1.75 / 400 (25.4px) | `.bb`; composer textarea 14.5 / 26px |
| Article body | 14.5 / 2 (29px) / 400, `#272B34`; steps 14.5 / 1.85 | `.art p`, `.steps li` |
| Body, list row | 14 / 1.55 / 400 | `.li`; `.l1` 14 / 1.5 / 700 |
| Section header | 13.5 / 1.5 / 700 | `.sh` |
| Active tab label | 13.5 / 1.3 / 700 | `.vb .tab.on .tl`, `.vd …` |
| Secondary line | 13 / 1.55, `--ink-2` (unread: 600, `--ink`) | `.l2` |
| Field label | 13 / 600 | `.fld label` |
| Status line | 12.5 / 1.55, `--ink-3` | `.t2` |
| Header subtitle, caption, `.l3` | 12 / 1.45; 12 / 700; 12 / 500 | `.hs`; `.cap`; `.l3` |
| Tab label (inactive) | 12 / 1.3 / 600, `--ink-3` | `.tab` |
| Footer, day divider, name | 11.5 / 400; 11.5 / 600; 11.5 / 1.5 / 600 | `.pw`; `.day`; `.nm` |
| Meta | 11 / 1.5 / 400, `--ink-3` | `.mt` |
| Badges | 11 / 700 (`.nb`); 10.5 / 800 (tab badge); 11 / 700 (`.tg`) | |

**Button font override (affects what the screenshots show).** The board CSS has `.cv button{font:inherit}`
(widget.css:31, specificity 0,1,1). It beats single-class font declarations on `<button>` elements, so these render
with inherited values. Implement the rendered values (they are in the acceptance PNGs); the declared values never
applied (confirm with the designer before switching):

| Element | Declared | Rendered |
|---|---|---|
| `button.chip` (04·06) | 13px / 600 | 14px / 400, line-height 23.8px |
| `button.btn.btn-p.sm` (08·a) | weight 600 | 13.5px / 400 |
| `button.retry` (04·05) | 11px / 700 | 11px / 400 |
| `button.skip` (08·b) | 12px / 700 | 11.5px / 600 (from `.prog`) |
| `button.spd` (05·2) | 11.5px / 700 | 14px / 400 |
| `button.ep-e` emoji cell (06) | 23px, emoji font stack | 14px, Vazirmatn stack (system emoji glyph fallback) |

`<a>`-based elements (`a.btn`, `a.tab`, `a.li`, `a.cd`, `a.more`) are unaffected. Production uses `<button>` for most of
these: give them the rendered values above, not whatever a production button reset would produce.

### 3.3 Radii

| Radius | Used by |
|---|---|
| 1–3 | `.va` diamond 1, typing diamonds 1.5, wave bars and step segments 2, grab handle 3 |
| 6 | joined bubble corners; code chip; `kbd` chips (token sheet: «۶ · اتصال حباب») |
| 8 | pending-file thumb and remove button, step number, speed button |
| 9 | image caption bar, file-type tile, `.more` link, form-card icon tile, greeting close |
| 10 | composer `.tools .ib`, link-card tile, file download button, emoji category tab, `.nb` badges |
| 11 | list tile `.lt`, rating buttons, emoji cells, greeting quick replies |
| 12 | icon button `.ib`, chips, list rows, quote, pending file, small button/input, `.go`, emoji search (token sheet: icon button) |
| 14 | button `.btn`, field `.inp`, search `.sr`, note, link card, tip, `.va`/`.vc` tabs; mobile `.ib` (token sheet: button and field) |
| 15 | hero logo |
| 16 | intro box, offline banner, `.vb`/`.vd` tabs, mobile CTA |
| 18 | image, e-mail card, summary card |
| 19 | `.vc` bar |
| 20 | cards `.cd`, bubbles `.bb`, composer box, form card, greeting bubble (token sheet: card and bubble) |
| 22 | `.vb`, `.vd` bars |
| 28 | panel |
| 31% | store avatar `.av.sa` (unused) |
| 50% | avatars, round action button, play button, presence dots |
| 99px | status tags, queue pill |

### 3.4 Shadows and elevation

| Token / value | Used by |
|---|---|
| `--sh-1` `0 0 0 1px rgba(15,18,23,.06), 0 1px 2px rgba(15,18,23,.04)` | hairline elevation (token sheet: «مرز») |
| `--sh-2` `0 0 0 1px rgba(15,18,23,.05), 0 1px 2px rgba(15,18,23,.04), 0 10px 24px -14px rgba(15,18,23,.2)` | cards, form card, e-mail card, summary (token sheet: «کارت») |
| `--sh-3` (see §2.1) | panel (token sheet: «پنل») |
| `0 0 0 1px rgba(15,18,23,.06), 0 2px 4px rgba(15,18,23,.05), 0 18px 34px -18px rgba(15,18,23,.3)` | `a.cd:hover` |
| `0 0 0 1px rgba(15,18,23,.05), 0 2px 4px rgba(15,18,23,.04), 0 16px 32px -14px rgba(15,18,23,.32)` | `.vb` bar |
| `inset 0 1px 0 rgba(255,255,255,.2), inset 0 -1px 0 rgba(0,0,0,.1), 0 1px 2px rgba(15,18,23,.16), 0 10px 22px -12px color-mix(in oklab,var(--a) 90%,transparent)` | primary button |
| `0 1px 2px color-mix(in oklab,var(--a) 28%,transparent)` | visitor bubble |
| `0 0 0 1px var(--line-2), 0 6px 16px -12px rgba(15,18,23,.25)` | composer box (rest) |
| `0 6px 14px -6px rgba(0,0,0,.35)` | hero logo |
| `0 -1px 0 var(--line)` / `0 1px 0 var(--line)` | `.va` bar top hairline / header bottom hairline |
| `0 2px 6px -2px rgba(15,18,23,.35)` | voice play button |
| `0 0 0 1px rgba(17,19,26,.06), 0 18px 40px -14px rgba(17,19,26,.3)` | greeting bubble (board 10) |

### 3.5 Spacing rhythm

| Context | Value |
|---|---|
| Panel side gutter | 14px (home body, thread), 16px (Messages list, help search, CTA wrapper), 18px (form), 22px (article), 12px (composer, floating bars) |
| Between cards | 12px (`.bd` gap) |
| Card padding | 16px (`.cd`); 12px 14px 4px (cards that start with a search field or list); 12px 14px 14px (recent card); 14px 16px (`.cta`); 4px 14px (category card) |
| Between message groups | 14px (`.grp` margin-bottom); last group 6px (inline style on every board) |
| Between bubbles in a group | 3px (`.stk` gap) |
| Avatar to bubble | 8px (`.grp` gap); avatar `margin-bottom:21px` to align with the last bubble above the meta line |
| Form fields | 16px between fields, 6px label → input |
| Icon + text | 6–12px (`.t2` 6, `.note` 10, `.tm` 12, `.li` 12, `.who` 10) |
| List row | `padding:10px 8px; margin:0 -8px`, min-height 46 |

### 3.6 Icons

All inline SVG, `viewBox="0 0 24 24"` unless noted, `fill="none" stroke="currentColor"`, round caps and joins. The token
sheet states «شبکه ۲۴ · خط ۱٫۷ · گوشه‌های نرم · فعال = توپُر» (24 grid, stroke 1.7, soft corners, active = filled):
1.7 applies to the tab icons; other UI icons use the stroke listed. Take the paths from the board line given.

| Icon | Size / stroke | Source (board:line) | Notes |
|---|---|---|---|
| WebYar mark watermark | `viewBox="17 13.5 26 33.5"`, filled | 01-home:27 | `.hx-mk` |
| WebYar mark with dots (footer) | `viewBox="17 13.5 26 33.5"`, 11 × 15, filled, evenodd | 01-home:46 | `.pw svg` |
| Close X | 20 / 1.9 (mobile 22) | 01-home:28; 12-mobile:29 | |
| Send (paper plane) | 18, 19, 16 (sm); filled | 01-home:35; 04-conversation:97; 08:39 | class `.pl`: mirrored in RTL (`[dir=rtl] .pl{transform:scaleX(-1)}`) |
| Search | 18 / 1.9 (mobile 20; emoji search 16 / 2) | 01-home:38; 06:112 | |
| List chevron | 18 / 2, path `m14 6-6 6 6 6` (points left = forward in RTL) | 01-home:40 | `.ch` |
| More-link chevron | 16 / 2.2 (size from CSS) | 01-home:70 | `.more svg` |
| Tab: home / messages / help, outline | 24 / 1.7 | 01-home:49-51 (`.i-o`) | messages = the launcher bubble with three diamonds |
| Tab: home / messages / help, filled | 24, fill + 1.7 stroke, white inner details | 01-home:49-51 (`.i-f`) | active state |
| Envelope | 18 / 1.8 | 01-home:106 | offline note |
| Back chevron | 20 / 2, path `m10 6 6 6-6 6` (points right = back in RTL) (mobile 22) | 04-conversation:27; 12:62 | see §7 for the production flip |
| More (three dots) | 20 / 3 | 04-conversation:29 | |
| Double tick (read) | 16 / 2, `role="img" aria-label="خوانده شد"` | 04-conversation:35 | `.rd` = accent |
| Single tick (delivered) | 15 / 2.2, `aria-label="تحویل شد"` | 04-conversation:84 | |
| Check (saved) | 15 / 2.2, accent | 08-prechat-in-chat:74 | |
| Link arrow | 16 / 1.9 | 04-conversation:40 | link card |
| Emoji | 20 / 1.8 (mobile 22) | 04-conversation:55 | |
| Paperclip | 20 / 1.8 (mobile 22) | 04-conversation:56 | |
| Microphone | 20, filled capsule + 2 stroke (mobile 22) | 04-conversation:57 | |
| Image | 30 / 1.5 | 04-conversation:75 | image placeholder |
| Download | 16 / 1.9 | 04-conversation:79 | |
| Play | 15, filled | 04-conversation:83; 05:82 (with `margin-inline-start:2px`) | never mirrored |
| Error circle | 14 / 2.2 | 04-conversation:88; 07:34 | |
| Small X | 14 / 2.2 | 04-conversation:92 | remove file, greeting close |
| Trash | 19 / 1.8 | 05-voice-messages:46 | cancel / delete recording |
| Stop square | 13, filled `rx="4"` | 05-voice-messages:49 | |
| Emoji categories (clock, smile, person, heart, leaf, cup) | 19 / 1.8 | 06-emoji-in-composer:114-119 | |
| Person | 18 / 1.8 (form-card 15 / 1.9) | 07:32; 08:35 | |
| Lock | 13 / 2; 12 / 2; 16 / 1.9 | 07:38; 08:40; 08:45 | |
| Moon | 18 / 1.8 | 07-forms-offline-messages:54 | offline banner |
| Check (submit e-mail) | 18 / 2.2 | 07-forms-offline-messages:61 | |
| Check circle | 16 / 2.2 | 08-prechat-in-chat:99 | |
| Box, card, tag (categories) | 18 / 1.8 | 09-help-center:33-35 | |
| Info | 16 / 2 | 09-help-center:73 | tip callout |
| Thumb up / down | 16 / 1.8; down = same path with `transform:scaleY(-1)` | 09-help-center:76-77 | |
| Launcher kit glyph | `viewBox="0 0 60 60"` | 10-launcher-and-greeting:87 | identical to production `WEBYAR_KIT_CHAT_GLYPH` |
| Launcher styles: bubble, two bubbles, headset | 36, 36, 34 | 11-launcher-and-color:126, 130, 134 | new (§4.24) |

### 3.7 Motion tokens

| Token | Value |
|---|---|
| `--ease` | `cubic-bezier(.22,1,.36,1)` (same curve as production's panel transition) |
| Fast colour change | `.15s` (icon buttons, rows, chips, inputs) |
| Button press | `.16s var(--ease)` (`.btn` transform) |
| Hover lift, round button, composer ring | `.2s` |
| Tab background | `.25s` |

Token-sheet motion table (board 13, «همه با prefers-reduced-motion خاموش می‌شوند», all switched off under
prefers-reduced-motion): panel open: rise 14px and scale 0.96,
`380ms cubic-bezier(.22,1,.36,1)`; card entrance: 60ms stagger, `420ms cubic-bezier(.22,1,.36,1)`; buttons: hover 106%,
press 94%, `200ms cubic-bezier(.22,1,.36,1)`; typing indicator (three diamonds): `1300ms ease-in-out loop`; microphone
to send: rotate 90°, `180ms ease-out`; loading skeleton: `1400ms linear shimmer`. All interactions: §6.

---

## 4. Components

Each component: design classes → production element; anatomy; dimensions; states; RTL notes. Keep every production
hook and state class (brief §2); where a design element replaces a production element, the production element gains
the new look.

### 4.1 Panel close button (`button.panel-close[data-panel-close]`)

Production keeps one absolutely positioned close button in the shell (PD:920). The design draws it inside each
header, so position and look vary per view (`.panel[data-view]`, Core-written):

| View | Look | Size | Position (top / inline-end) | Mobile |
|---|---|---|---|---|
| `home` | on the hero, `.ib.dk`: bg `rgba(255,255,255,.15)`, hover `.25`, `color:#fff`, X 20/1.9 | 36 × 36, r 12 | 24px / 20px | 44 × 44 r 14, X 22; top 43px (with the grab handle) / 20px |
| `chat` (thread, pre-chat form, offline, pre-chat in chat) and help article | `.ib`: transparent, `--ink-2`; hover `--bg-2` + `--ink` | 36 × 36, r 12 | 16px / 10px | 44 × 44 r 14; top 22px / 10px |
| `list`, `help` (list/results) | `.ib` as above | 36 × 36, r 12 | 14px / 12px | 44 × 44 derived from `.w.mob .ib` (no mobile board) |

The article is `data-view="help"` too: select it by its header (e.g. `.panel:has(.wy-head-article) .panel-close`).
Headers must leave the close slot free: chat header content ends 50px from the inline-end edge (10 + 36 + 4 gap).
`aria-label` «بستن». Production focus ring stays (§8).

### 4.2 Hero (home) → `div.wy-head.wy-head-home`

- `.hx`: `position:relative; overflow:hidden; padding:18px 20px 80px; color:#fff; background:var(--hero)`.
- Highlight `.hx::after`: `inset:0; radial-gradient(90% 70% at 100% 0%, rgba(255,255,255,.16), transparent 62%)`
  (top-right in RTL; `[dir=ltr]` moves it to `0% 0%`).
- Watermark `.hx-mk`: WebYar mark, `position:absolute; top:-22px; inset-inline-end:-14px; width:156px;
  color:#fff; opacity:.11; transform:rotate(-10deg)`; rendered box 188.5 × 225 at x −30, y −34 (left side in RTL).
- Top row `.hx-top` (`z-index:1`, flex, gap 8): logo · spacer `.hx-sp{flex:1}` · close (§4.1).
- Logo `.logo` → production identity avatar (`identityAvatarHtml`, `.wy-avatar`): 48 × 48, radius 15, `#fff`,
  letter `var(--a)` 21px/700, shadow `0 6px 14px -6px rgba(0,0,0,.35)`. Content: workspace initial (production
  fallback `W`) or `logoUrl` image (not specified how it fits; **Suggestion:** `object-fit:cover`, radius 15).
  `showLogo:false` → no logo (keep the 48px row height so the hero does not shrink).
- Greeting `.hx-hi` → production `h2.home-greeting` (`homeGreeting`); question `.hx-q` → `p.home-welcome`
  (`vm.welcomeMessage` or `homeWelcome`). Move `section.home-greeting-block` into the hero (no hooks on it).
  Sizes §3.2. The workspace name and reply time are not shown in the hero.

### 4.3 Cards

| Class | Spec |
|---|---|
| `.cd` | `padding:16px; border-radius:20px; background:#fff; box-shadow:var(--sh-2)` |
| `a.cd` (clickable card) | `transition: transform .2s var(--ease), box-shadow .2s`; hover `translateY(-1px)` + shadow §3.4 |
| `.cta` | row card: `display:flex; align-items:center; gap:12px; padding:14px 16px`; text `.lx{flex:1}`; ends with `.ra` |
| `.tm` | team row: avatars + text, gap 12; `.tm + .btn{margin-top:14px}` |
| `.cap` | caption above content: 12px/700 `--ink-3`, `margin:0 2px 8px` |
| `.note` | `display:flex; gap:10px; margin:14px 0 0; padding:10px 12px; border-radius:14px; background:var(--bg); box-shadow:inset 0 0 0 1px var(--line)`; 12.5px/1.75 `--ink-2`; icon 18px `--ink-3`, `margin-top:2px`; `.note + .btn{margin-top:12px}` |

### 4.4 Buttons

| Class | Spec | States |
|---|---|---|
| `.btn` | flex, centred, gap 8, `width:100%; height:48px; border-radius:14px`, 15px/600, no wrap; transition `transform .16s var(--ease), filter .2s, box-shadow .2s, background-color .2s` | — |
| `.btn-p` (primary) | `color:#fff; background:linear-gradient(180deg,var(--a-hi),var(--a) 70%)`; shadow §3.4; trailing send icon 18px | hover `filter:brightness(1.06); translateY(-1px)`; active `brightness(.97)`, no translate |
| `.btn-s` (soft) | `color:var(--a-ink); background:var(--a-2); box-shadow:inset 0 0 0 1px var(--a-3)` | hover bg `--a-3` (defined, unused on boards) |
| `.btn-g` (ghost) | `color:var(--ink); background:#fff; box-shadow:inset 0 0 0 1px var(--line-2)` | hover bg `--bg` (defined, unused) |
| `.btn.sm` | height 40, radius 12, 13.5px (rendered weight 400 on `<button>`, §3.2) | |
| `.ib` (icon button) | 36 × 36, radius 12, transparent, `--ink-2`; transition `background-color .15s, color .15s` | hover bg `--bg-2`, `--ink` |
| `.ib.dk` (on hero) | bg `rgba(255,255,255,.15)`, `#fff` | hover `rgba(255,255,255,.25)` |
| `.tools .ib` (composer) | 34 × 34, radius 10, `--ink-3` (mobile 44 × 44) | hover as `.ib` |
| `.ra` (round action) | 38 × 38 circle, bg `--a-2`, `--a-ink`, `box-shadow:inset 0 0 0 1px var(--a-3)`; transition `transform .2s var(--ease), background-color .2s` (mobile 46) | hover bg `--a-3` + `scale(1.06)`; active `scale(.94)`; `.off` (disabled) bg `#EEF0F3`, icon `#AEB3BE`, no ring, no hover; `.stop` bg `#FFEEED`, `--rec`, ring `#FFD6D3` |
| `.go` (e-mail submit) | 42 × 42, radius 12, `#fff` check 18px on the primary gradient | no hover specified |

The 05·3 spec card states the `.ra` family: «میکروفون» (microphone: empty composer), «هاور» (hover: 106%, stronger tint;
`.ra.hv` = hover look), «توقف ضبط» (stop recording: soft red), «ارسال» (send: while typing), «فشرده» (pressed: 94%;
`.ra.pr` = pressed look), «غیرفعال» (disabled: while sending); flow empty → typing → recording. Icon change only,
«محو و چرخش ۹۰ درجه در ۱۸۰ میلی‌ثانیه» (fade and 90° rotation in 180ms); size «۳۸ پیکسل روی دسکتاپ و ۴۶ روی موبایل»
(38px on desktop, 46 on mobile).

Production mapping: `.btn-p` → `.wy-btn.wy-btn-primary` (home CTA, pre-chat submit, KB CTAs); `.ra` → `.mic-btn`,
`.send-btn`, `.rec-confirm`, `.vn-send`, and the home/article CTA cards' trailing circle (decorative, `aria-hidden`).

### 4.5 Chips (topics) → `button.qna-chip`

`.chips{display:flex; flex-wrap:wrap; gap:8px}`; `.chip`: height 36, `padding:0 14px`, radius 12, `#fff`,
`box-shadow:inset 0 0 0 1px var(--line-2)`, rendered 14px/400 `--ink` (§3.2); transition `background-color .15s,
box-shadow .15s`. Hover bg `--bg`. Selected `.chip.on`: bg `--a-2`, `--a-ink`, `box-shadow:inset 0 0 0 1.5px var(--a)`.
Chips wrap from the inline-start (right).

### 4.6 Search field (new wiring)

`label.sr`: flex, gap 10, height 44, `padding:0 14px`, radius 14, bg `--bg`, `box-shadow:inset 0 0 0 1px var(--line)`,
icon colour `--ink-3`, 14px; `input` flex 1, transparent, `--ink`, placeholder `--ink-3`. Focused `.sr.fo`: bg `#fff`,
`box-shadow:inset 0 0 0 1.5px var(--a), 0 0 0 4px var(--a-3)` (09·10 shows the focused look). Mobile: height 48, 15px,
icon 20. Production: compose `kbSearchBarHtml` (`div.kb-search-wrap > input.kb-search[type=search]`, PD:1345-1351)
and add a hook (suggested `data-kb-search`, brief §9) that Core binds; the query opens the help results view.

### 4.7 Lists

| Class | Spec |
|---|---|
| `.ls` | column |
| `.li` | flex, centre, gap 12, min-height 46, `margin:0 -8px; padding:10px 8px`, radius 12, `--ink`, 14px/1.55; hover bg `--bg` (transition .15s) |
| Separator | `.li + .li::before`: `top:0; inset-inline:8px; height:1px; background:var(--line)`; hidden on the hovered row and the next one |
| `.ch` chevron | 18px, `margin-inline-start:auto` (inline-end = left), `--ink-4`; row hover → `--a-ink` and `translateX(-3px)` in RTL (`3px` in LTR); transition `transform .2s var(--ease), color .15s` |
| `.lt` tile | 36 × 36, radius 11, bg `--a-2`, icon `--a-ink` 18px (link card: 34 × 34 r 10; form card: 28 × 28 r 9; intro/banner: `#fff` + `0 0 0 1px var(--line)`) |
| `.lx` / `.l1` / `.l2` / `.l3` | text column (flex 1) / title row 14/700 with `time` 11.5/500 `--ink-3` at inline-end / preview 13/1.55 `--ink-2`, ellipsis in `em`, unread `.u` 600 `--ink` / sub 12/500 `--ink-3` |
| `.sh` | section header 13.5/700, `margin:0 2px 6px` (a trailing link `.sh a` 12.5/600 `--a-ink` is defined, unused) |
| `.rrow` | recent row: 40px avatar + `.lx`, gap 12 |

Production: home article rows → `button.home-chip[data-home-article]`; help rows → `button.kb-article[data-kb-action=open]
[data-kb-slug]`; Messages rows → `button.conv-row[data-conversation-open]` (§5.17). Production chevrons are flipped by
`[dir='rtl'] .kb-article-chevron svg{transform:scaleX(-1)}` (CSS:1773): either use a right-pointing source path with that
flip or drop the flip and use the design path; the hover `translateX` must then be combined with the flip on the same
element (e.g. `scaleX(-1) translateX(3px)`) or applied to a wrapper.

### 4.8 Avatars, presence, live dot

- `.av`: circle, grid-centred initial, 700, line-height 1. Sizes: 36 (13px), `.s24` (10px), `.s28` (11px), `.s40`
  (15px), `.s44` (16px), `.s48` (17px). Palette `.c1`–`.c4` (§3.1). The brand rule: people never get photos; team members
  are an initial on a soft tile; the store is its logo or initial ([brand sheet](../README.md)). The boards use `.c1`
  for سارا, `.c2` مهدی, `.c3` رضا and `.c4` for the store initial in the offline header. Colour assignment rule is not
  specified (**Suggestion:** stable hash of the member id or name, modulo 4).
- Stack `.avs`: overlap `margin-inline-start:-10px`, ring `0 0 0 2.5px #fff`; `.avs.dim` (offline): `filter:grayscale(1);
  opacity:.6`. Welcome stack (`.wel`): 48px, overlap −13px, ring 3px.
- Presence `.av .pr`: 12 × 12 circle at `bottom:-1px; inset-inline-end:-1px` (bottom-left in RTL), `--ok`, ring
  `0 0 0 2.5px #fff`; `.pr.off` `#A3A9B4`.
- Live dot `.live` (inline in status lines): 7 × 7 `--ok` with `0 0 0 3px color-mix(in oklab,var(--ok) 20%,transparent)`;
  `.live.off` `#A3A9B4` with `0 0 0 3px #ECEEF1`. In status tags: 6 × 6, no halo (inline style).
- Store avatar `.av.sa` (radius 31%, `--hero`, white letter; `.off` `#B5BAC4`): defined, not used on any board.
- Production: `.wy-avatar` (store), `.msg-avatar` (operator in the thread), `.home-stack-item` (team stack, today image-only)
  → initial tiles as above.

### 4.9 Badges and tags

| Class | Spec | Production |
|---|---|---|
| `.nb` | min 20 × 20, `padding:0 6px`, radius 10, `--a` bg, `#fff`, 11px/700, Persian digits | `.conv-unread` (`fmtNum`, `99+` above 99) |
| Tab badge `.tic .nb` | min 18 × 18, `padding:0 5px`, radius 10, `#FFB423` / `#12141F`, 10.5px/800, ring `0 0 0 2.5px #fff` (on the active `.vb` capsule `--a-2`; inactive `.vc` tab `--bg-2`; `.vd` `#076356`); `top:-6px`; `.va`: `inset-inline-end:-10px` (left of the icon); `.vb/.vc/.vd`: `inset-inline-start:-10px` (right of the icon) | new |
| `.tg` | inline-flex, gap 5, height 20, `margin-top:5px; padding:0 8px`, radius 99, 11px/700. `.tg.open`: `#E7F4E9` / `#0F6B37` with a 6px live dot; `.tg.done`: `--bg-2` / `--ink-3` | `.conv-status` (+ `.is-resolved`), dot `.conv-status-dot` |

### 4.10 Bottom menu (new)

One markup, four styles and five label modes. Markup per tab (board 01-home:48-52):
`nav.tabs[aria-label] > a.tab[.on][aria-current=page][aria-label] > span.tic > svg.i-o + svg.i-f + [span.nb] ; span.tl`.
Production markup (new; class names free, **Suggestion:** `nav.wy-tabs > button.wy-tab[data-view]`): Home
`data-view="home"` (new value Core must handle), Messages `data-view="list"`, Help `data-view="help"` (both exist).
Render it at the end of the three root views (home, list, help list/results); not on chat, pre-chat, fallback or article.
The unread badge = total unread (sum of `conversations[].unreadCount`, or Core's unread count), `fmtNum` Persian digits
(cap not specified; **Suggestion:** `99+` like conversation rows). Active tab: filled icon `.i-f`, `aria-current="page"`.

Base: `.tabs{position:relative; z-index:3; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:4px}`;
`.tab`: flex centred, gap 7, 12px/1.3/600, `--ink-3`, no wrap, transition `color .2s, background-color .25s,
box-shadow .25s`; `.tic` 24 × 24 (transition `transform .2s var(--ease)`; `.tab:active .tic{transform:scale(.9)}`).

| Style (setting `navStyle`) | Bar | Tab | Active tab |
|---|---|---|---|
| `va` classic bar, diamond marker («کلاسیک دقیق») | height 70, `padding:6px 10px 10px`, `#fff`, `box-shadow:0 -1px 0 var(--line)`, full width at the panel bottom | column, gap 3, radius 14; label always shown; hover `--ink-2` | `--a-ink`, 700; diamond `::after` 5 × 5, radius 1, `--a`, `rotate(45deg)`, centred at the tab bottom |
| `vb` floating dock, active capsule («داک شناور با کپسول») **default** | height 60, `margin:0 12px 12px; padding:6px`, radius 22, `#fff`, shadow §3.4 | radius 16; label hidden; hover `--ink-2` on `--bg` | `--a-ink` on `--a-2`, `inset 0 0 0 1px var(--a-3)`; label shown 13.5/700 |
| `vc` segmented («سگمنت») | height 58, `margin:0 12px 12px; padding:5px`, radius 19, `--bg-2`, `inset 0 0 0 1px var(--line)` | radius 14, 13px, label shown; hover `--ink-2` | `--ink` on `#fff`, 700, `0 1px 2px rgba(15,18,23,.08), 0 6px 14px -6px rgba(15,18,23,.2)`; icon `--a` |
| `vd` brand dock («داک برند») | height 62, `margin:0 12px 12px; padding:6px`, radius 22, `--hero`, `inset 0 1px 0 rgba(255,255,255,.18), 0 16px 32px -14px color-mix(in oklab,var(--a) 75%,transparent), 0 2px 6px rgba(15,18,23,.12)` | radius 16, `rgba(255,255,255,.78)`, label hidden; hover `#fff` on `rgba(255,255,255,.12)` | `--a-ink` on `#fff`, `0 6px 14px -6px rgba(0,0,0,.3)`; label 13.5/700 |

Measured (`vb`, desktop): bar 376 × 60 at y 648; tabs 118.7 × 48, gap 4. Mobile §2.3.

Label modes (setting `navMode`, super-admin; widget.css:411-437). The `nv-both`, `nv-icon` and `nv-text` rules exist
**for `vb` only**; how those three modes look with `va`/`vc`/`vd` is not specified (`nv-none` works for every style).

| Mode | Class | Spec |
|---|---|---|
| Icons + label of the active tab (default) | none | as `vb` above |
| Icons and labels | `.nv-both` | bar height 64; tab column, gap 1; icon 22 × 22; label 11.5px/600/1.4 on every tab (active 700); badge moves to `inset-inline-end:-12px` (left). Mobile: bar 68, labels 12px |
| Icons only | `.nv-icon` | active label hidden |
| Labels only | `.nv-text` | label 13.5/600 (active 700) on every tab; icons hidden; the badge stays, `position:static`, no ring, after the label (`.tic{order:2}`) |
| No menu | `.nv-none` | bar hidden; home shows `.more` «همه گفتگوها»; Messages and Help titles show the back button `.ttl .bk` and get `padding-inline-start:8px`. Mobile: the `.safe` area returns (device chrome) |

`.more` (home, `nv-none` only): flex, `align-self:flex-end` (left in RTL), gap 2, height 30, `margin:-6px 2px -4px;
padding-inline:8px 4px`, radius 9, 12.5px/700 `--a-ink`, chevron 16px; hover bg `--bg-2`. Production:
`button.home-link[data-view=list]` restyled. **Suggestion** (not in the design): in `nv-none` the help list has no entry
point besides search; keep `.home-chip-more[data-view=help]` visible as a second `.more` link.

Put the mode class on each view root (e.g. `.wy-view.nv-both`) and the style class on the nav; rewrite the board
selectors (`.nv-both .vb …`) accordingly.

### 4.11 Screen headers

| Class | Spec | Production |
|---|---|---|
| `.hd` | flex, centre, gap 4, height 68, `padding:0 10px`, `#fff`, `box-shadow:0 1px 0 var(--line)`, `z-index:2`. Order: back `.ib` · `.who` · [more `.ib`] · close (§4.1) | `div.header.wy-head.wy-head-chat[data-chat-header]`; `div.wy-head` (pre-chat, fallback, article) |
| `.who` | flex 1, gap 10, `padding-inline:4px`; avatar (40, or none) + text | identity block (`headerIdentityHtml`) |
| `.hn` / `.hs` | 15/1.4/700 / 12/1.45 `--ink-3`, both single-line ellipsis | `.wy-head-title` / `.wy-head-sub` |
| `.ttl` | flex, centre, gap 8, height 64, `padding-inline:20px 12px`, `#fff`; `h2` flex 1, 19/700; back `.bk` hidden unless `nv-none` | `.wy-head-list` (list) and the KB list header: keep `button.wy-back[data-view-back=home]` in the DOM, hidden by default |
| Back button | `.ib` with chevron (§3.6) | `button.wy-back[data-view-back]` |
| More (⋯) | `.ib`, `aria-label` «گزینه‌های بیشتر», on 04·04/05 and 06 only | new; behaviour not specified. **Suggestion:** render only when a menu exists |

### 4.12 Powered-by footer (`.wy-footer` → `.pw`)

`.pw`: flex, centred, gap 6, height 32, 11.5px `--ink-3`; mark svg 11 × 15 `--ink-2` before the text; label
«قدرت گرفته از» then brand `<b>` «وب‌یار» 700 `--ink-2`. (`.pw i`, a 15 × 15 badge, is defined, unused.) On `.bgw`
screens it sits on `--bg`, elsewhere on white. Production: keep `.wy-footer > .wy-conn[data-conn-indicator] +
(a or span).wy-powered` and its anchor attributes (production §5.10); render the inner content as mark svg + `span(label)`
+ `b(platform)` instead of one span. The connection dot `.wy-conn` is not drawn in the design: keep the node;
**Suggestion:** hide it while `data-conn-state="online"` and keep production's look for the other states. Without a
footer (config) the view extends to the bottom edge.

### 4.13 Thread and messages

Container `.th` → `.wy-chat-scroll[data-chat-messages]`: `padding:14px 14px 4px`, `#fff`, column; messages anchor to the
bottom (`justify-content:flex-end`) and the top edge fades: `mask-image:linear-gradient(to bottom,transparent 0,#000 30px)`.
`.th.top` (new conversation, offline): anchored to the top, no mask. In a scrolling container use
`.messages{margin-top:auto}` instead of `justify-content:flex-end` (which makes overflowing content unreachable).

Day divider `.day` → `div.msg-day > span`: flex, gap 10, `margin:4px 10px 14px`, 11.5px/600 `--ink-3`, hairlines
`::before`/`::after` (flex 1, 1px `--line`) on both sides.

Group `.grp` (one author run): flex, `align-items:flex-end`, gap 8, `max-width:86%` (92% inline in 04·06),
`margin-bottom:14px`. Operator `.grp.L`: on the physical **left** (RTL: `align-self:flex-end`, avatar `order:2`);
visitor `.grp.R`: on the **right**. Stack `.stk`: column, gap 3, aligned to the group's side. Avatar 28px (`.s28`) on
operator groups only, `margin-bottom:21px` (aligns with the last bubble above the meta line; without a meta line, as
in 08·b, the avatar sits 21px higher).

Production rows are one `.msg-row` per message (production §5.1); map without new wrappers:

| Design | Production |
|---|---|
| bubble gap 3px, group gap 14px | `.msg-row` spacing 3px; `.msg-row.is-last` 14px (replaces `margin-bottom:-9px` rule) |
| joined corners | `.msg-row.operator:not(.is-last) .msg{border-bottom-left-radius:6px}`; `.msg-row.operator:not(.is-last) + .msg-row.operator .msg{border-top-left-radius:6px}`; visitor: same with the right corners |
| avatar on the last bubble, spacer on others | `span.msg-avatar` on `.is-last` operator rows (initial tile, §4.8); `span.msg-avatar.msg-avatar-spacer` 28px on the others. Production renders operator avatars only when `senderAvatar` exists: render the initial always (markup change, PD:671-710) |
| name `.nm` above the first bubble of a run | new: emit the sender name in the first operator row of a run (`.nm`: 11.5/1.5/600 `--ink-3`, `margin:0 12px 1px`). Shown on the first operator run in 04·04, 05·1/2, 06 and 12·15 (not on the second run of the same agent in 12·15); not shown in 04·05, 04·06, 07·09 and 08. The rule is not specified (**Suggestion:** show it when the sender differs from the previous operator run, never on automated messages) |
| meta `.mt` under the last bubble | `.msg-footline > .msg-meta` (`.is-last` only) |

Bubble `.bb` → `.msg`: `width:fit-content; max-width:100%; padding:9px 14px; border-radius:20px`, 14.5px/1.75,
`overflow-wrap:anywhere`. Operator `.L .bb`: `--op` bg, `--ink`. Visitor `.R .bb`: `#fff` on
`linear-gradient(180deg,var(--a-hi),var(--a) 70%)`, shadow `0 1px 2px color-mix(in oklab,var(--a) 28%,transparent)`.
Remove the inline visitor background from the renderer (PD:665, brief §2.6). Keep `.msg-text{unicode-bidi:plaintext}`.

Meta `.mt`: flex, gap 4, `margin:2px 8px 0`, 11/1.5 `--ink-3`: time (Persian digits), then the tick after it (left of the
time in RTL). Ticks (production keeps its three states, PD:686-695):

| Production status | Design glyph |
|---|---|
| `sending` | not specified (keep the production spinner, `--ink-3`) |
| sent (single) | single tick 15/2.2, `--ink-3` (the board labels it «تحویل شد») |
| `delivered` | double tick 16/2 in `--ink-3` (not drawn in the boards; same glyph as read) |
| `seen` | double tick `.rd` `--a`, `aria-label` «خوانده شد» |

In 07·09 the offline visitor message shows text instead: «۲۳:۱۰ · ارسال شد».

Failed message `.grp.R.fail` → `.msg-ticks.is-failed` + `button.msg-retry-btn[data-msg-retry]`: bubble `opacity:.55`;
meta = error icon 14/2.2 `--bad` + «ارسال نشد» (700 `--bad`) + « · » + `button.retry` «تلاش دوباره» (11px/400 rendered,
`--bad`, underline, `text-underline-offset:2px`, no padding). Shown even with receipts off (production rule).

Quote `.qt` → `span.msg-quote`: block, `margin:1px -6px 6px; padding:6px 10px`, radius 12, 12.5/1.6; bg
`rgba(255,255,255,.17)` in visitor bubbles, `rgba(15,18,23,.05)` in operator bubbles; author `b` 11.5/700, opacity .9.

Link card `.lnk` → `a.msg-link`: flex, gap 10, `margin:8px -5px 2px; padding:8px 10px`, radius 14, `#fff`, `--ink`,
`box-shadow:0 0 0 1px var(--line)`; tile 34 × 34 r 10 (`--a-2`, arrow 16) + `b` title 13/1.5/700 + `small` domain
11.5/1.4 `--ink-3`. Production has no link preview data: **Suggestion:** title = the link text or `msgOpenLink`, domain =
hostname; keep `target=_blank`, `rel`, `dir=auto`.

Code chip `.code`: `padding:1px 6px`, radius 6, monospace 12.5px, no wrap, `direction:ltr; unicode-bidi:isolate`; bg
`rgba(15,18,23,.06)` (operator) or `rgba(255,255,255,.18)` (visitor). New: production has no inline-code markup (needs a
rule such as backticks from Core); otherwise render plain text inside an LTR isolate.

### 4.14 Typing bubble (new visible row)

Operator group with the 28px avatar, bubble `.bb.typ` (`--op`, `padding:15px 16px`, flex, gap 6; 62 × 36) holding three
diamonds `i`: 6 × 6, radius 1.5, `--ink-3`, opacity .45, `rotate(45deg)`, animation `wy-typ 1.3s ease-in-out infinite`
(delays 0, .16s, .32s; keyframes §6). Meta below: «سارا در حال نوشتن…» = `{name} در حال نوشتن…`. Last group margin 6px.
Production: Core knows typing (`setOperatorTyping`, `[data-typing-row]` sr-only). Core passes it to the renderer as
`view.operatorTyping {name, avatar}` (the `view` argument of `messagesHtml`), which renders the visible row last
(`div.msg-row.operator.is-last.typing-row`; the production class `.typing-row` is unused today). Keep the sr-only announcer; mark the visible row `aria-hidden="true"`
to avoid a double announcement (**Suggestion**; the board puts `aria-label` «در حال نوشتن» on the bubble). **Suggestion:**
use the same diamonds for the AI thinking row (`.ai-thinking-bubble > .typing-dots`).

### 4.15 Attachments in messages

| Type | Design | Production |
|---|---|---|
| Image | `.img`: 224 × 132, radius 18, no bubble; placeholder `repeating-linear-gradient(135deg,var(--a-1) 0 12px,var(--a-2) 12px 24px)` + inset 1px `--a-3` + image icon 30/1.5 `--a-ink`. Caption `.capn`: `position:absolute; bottom:8px; inset-inline:8px`, height 26, `padding:0 10px`, radius 9, `rgba(15,18,23,.58)`, `#fff` 11.5px; file name in `.ltr` at inline-start, size (Persian, «۸۴۰ کیلوبایت») at inline-end, opacity .8 | `.msg-att-image > button.msg-att-img-btn[data-att-preview]`; image `object-fit:cover` in the 224 × 132 box (production max 168 × 190). **Suggestion:** use the striped placeholder for `.is-loading` and the fallback. Caption is new (needs name and size) |
| File | inside an operator bubble `.bb.file`: flex, gap 10, min-width 240, `padding:10px 10px 10px 12px`; type tile `.ft` 38 × 46 r 9, `#fff`, ring `0 0 0 1px var(--line)`, «PDF» 9.5/700 `--bad` at the bottom (`padding-bottom:6px`); name `b` 13/1.5/700; size `small` 11.5 `--ink-3`; download `.ib` 32 × 32 r 10, `#fff`, ring, icon 16, at inline-end | `.msg-att-file > .msg-att-icon + .msg-att-meta(.msg-att-name + .msg-att-sub) + a.msg-att-action[data-att-download]`. Type colour for non-PDF not specified |
| Voice | visitor bubble `.bb.voice`: flex, gap 10, min-width 240, `padding:8px 14px; padding-inline-start:8px`; play `.pb` 36 × 36 `#fff` circle, `--a` icon 15, shadow `0 2px 6px -2px rgba(15,18,23,.35)`; waveform `.wave` (flex 1, height 26, gap 2.5): 18 bars 3px wide, radius 2, `currentColor`, unplayed `.d` opacity .42 (bar heights in the board are demo data); time `.tm-s` 11.5, tabular, opacity .92, Persian digits | `.msg-att-audio[data-audio-player]` (`.wy-ap-play[data-audio-toggle]`, `.wy-ap-track[data-audio-seek]` with `.wy-ap-progress`, `.wy-ap-time`); draw the bars as a mask on the track and fill the played part via `.wy-ap-progress`. Rate `1×` and download are not drawn: keep the nodes, hidden. Direction: controls as drawn, track `dir="ltr"` (§7, brief §7a) |

File sizes print Persian digits and Persian units («کیلوبایت», «مگابایت», decimal separator «٫»); production prints
Latin `B/KB/MB` (PD:260-265).

### 4.16 Composer

`.cmp` → `.composer-zone[data-composer-zone]`: `padding:8px 12px 0`, `#fff`. Box `.cbox` → `.input-wrap[data-input-wrap]`:
column, gap 2, `padding:11px 6px 5px`, radius 20, `#fff`, shadow `0 0 0 1px var(--line-2), 0 6px 16px -12px
rgba(15,18,23,.25)`, transition `box-shadow .2s`. Height 82 at rest (textarea 26 + tools row 38).

| Part | Spec | Production |
|---|---|---|
| Textarea | full width row, height 26, `padding:0 9px`, 14.5px/26px, `--ink`, placeholder `#7A808C` «پیام خود را بنویسید…» | `textarea.input[data-msg-input]`; Core's inline auto-height must start from 26px (max not specified; **Suggestion:** keep production's 15rem) |
| Tools row `.tools` | flex, centre, gap 2: emoji `.ib`, attach `.ib` (inline-start = right), then `.ra` at inline-end (`margin-inline-start:auto`, left) | `.composer-actions-start` holds send → attach → emoji in DOM order (PD:1038-1043) |
| Focus `.cbox.fo` | `box-shadow:0 0 0 1.5px var(--a), 0 0 0 5px var(--a-3)` | `.input-wrap:focus-within` |
| Pending file `.pend` (above the textarea) | inline-flex, gap 8, `align-self:flex-start` (right), `margin:0 4px 6px; padding:6px`, radius 12, bg `--bg`, inset 1px `--line`, 12.5/1.4; thumb 32 × 32 r 8 (image or striped placeholder); name + `small` size 11 `--ink-3`; remove 26 × 26 r 8, `--ink-3` X 14 (hover `--bg-2`) | `.att-preview[data-attach-preview]` with thumb, name, sub, remove. Upload progress, retry and `.is-error` are not drawn (keep production behaviour) |
| Locked `.cbox.lock` (08·a) | row, gap 8, `padding:13px 14px`, bg `--bg`, inset 1px `--line`, 13px `--ink-3`, lock 16: «اول فرم بالا را تکمیل کنید» | new state while the pre-chat card is pending (**Suggestion:** `.input-bar.is-locked` set by Core) |

One action slot (mic or send): keep both production buttons (`.mic-btn` first in `.input-row`, `.send-btn` in the
actions; brief §2.1) and show one: mic while the draft is empty, send with `.input-bar.has-draft` or a pending file.
Icon change: fade + 90° rotation, 180ms ease-out. Without voice notes (no mic) the empty state is not specified
(**Suggestion:** show send in the `.ra.off` look). Layout **Suggestion:** grid on `.input-row` with
`.composer-actions, .composer-actions-start{display:contents}` and areas `"input input input input" / "emoji attach . action"`;
mic and send share `action`; `rec-bar`/`vn-bar` span the full row.

### 4.17 Emoji picker (inside the composer box)

Board 06 `<style>` (source/06-emoji-in-composer.dc.html:14-47). The picker `.epk` is the first child of the composer box:
the box grows upward and the thread gives up height (06·2: box 336 tall, thread 276).

| Part | Spec |
|---|---|
| `.epk` closed | `height:0; margin:0 3px -2px; padding:0; opacity:0; overflow:hidden`; `box-shadow:inset 0 -1px 0 var(--line)` (hairline above the textarea) |
| `.cbox.emo .epk` open | `height:246px; margin:0 3px 6px; padding:2px 0 8px; opacity:1`; column, gap 8 |
| Search `.ep-sr` | height 36, `padding:0 12px`, radius 12, bg `--bg`, inset 1px `--line`, 13px `--ink-3`, icon 16/2; placeholder «جستجوی شکلک» |
| Categories `.ep-cats` | grid 6 columns, gap 4; `.ep-cat` height 32, radius 10, `--ink-3` (icons 19/1.8); hover `--bg`/`--ink-2`; `.on` `--a-2`/`--a-ink` + inset 1px `--a-3`; `role=tab`, `aria-selected` |
| Grid `.ep-grid` | flex 1, overflow hidden (scroll in production), bottom fade `mask-image:linear-gradient(to bottom,#000 74%,transparent)` |
| Section header `.ep-h` | 11.5/1.7/700 `--ink-3`, `margin:0 6px 2px` |
| Row `.ep-row` | grid 8 columns, gap 2, `margin-bottom:2px` |
| Cell `.ep-e` | height 38 (43 wide), radius 11, transparent; emoji rendered 14px (§3.2); hover `--bg-2` + `scale(1.14)`; just picked `.hit`: `--a-2` + inset 1px `--a-3` for 420ms |
| Emoji button | open `.on`: `--a-2`, `--a-ink`, inset 1px `--a-3`, icon `rotate(-14deg) scale(1.06)`; `aria-expanded`, label «شکلک‌ها» / «بستن شکلک‌ها» |

Content in the design: «پرکاربرد» (8 emoji, board script `G.recent`) then «چهره‌ها» (first 16); other categories 24 each (full lists in the
board script, `renderVals()` `G`). Picking inserts the emoji at the end of the draft with a space before it; the picker
stays open; tapping the emoji button again closes it. 06·1 `.ib.tap` (halo + pulse) is the board's tap indicator, not a
resting state.

Production: `div.emoji-picker[data-emoji-picker]` is a sibling **above** `.input-bar` and Core fills it with 50
`button.emoji-item[data-emoji]` (no categories, no search). To draw it inside the box, move the node to be the first child
of `.input-wrap` (before `att-preview`) after confirming in `runtime.js` that Core finds it by attribute; otherwise keep it
in place and join it visually to the box. Search, categories and section headers need emoji data in Core (new); without
it, render Core's items in the 8-column grid and hide search and tabs.

### 4.18 Voice recorder and preview

Recording (05·1) → `div.rec-bar[data-rec-bar]` (`.input-bar.is-recording`): box `.cbox.rec` with `padding:8px 6px 6px`,
ring `0 0 0 1.5px #F9A09C, 0 0 0 5px #FFEBE9`; height 77.5.

| Part (inline-start → end, right to left) | Spec | Production |
|---|---|---|
| Cancel | `.ib` 36 × 36 round (`border-radius:50%`), trash 19/1.8 | `button.rec-cancel[data-rec-cancel]` |
| Timer `.rtm` | flex, gap 7, min-width 56, 13.5/700 tabular; dot `.rdot` 9 × 9 `--rec` with `wy-pulse 1.4s infinite`; «۰:۰۸» (Persian) | `.rec-live > .rec-dot + .rec-time[data-rec-timer]` (prints `0:00` Latin today) |
| Live wave `.wv.rt` | flex 1, height 30, gap 2, `--a`; 20 bars 3px r 2; last 6 bars animate `wy-lv` | `.rec-wave` (10 `i` today) |
| Stop | `.ra.stop` with stop square 13 | `button.rec-confirm[data-rec-stop]` (stop → preview) |
| Send | `.ra` with send 19 | new: stop and send at once (**Suggestion:** `data-rec-send`) |
| Hint `.hint` (second row) | centred, gap 6, `margin-top:4px`, 11.5 `--ink-3`; `kbd` chips: `padding:0 6px`, r 6, bg `--bg`, `inset 0 -1px 0 var(--line-2), inset 0 0 0 1px var(--line)`, 11px `--ink-2`: «Esc لغو · Enter ارسال · حداکثر ۲ دقیقه» | new (keyboard handling and a 2-minute cap must exist; otherwise drop that part of the hint) |

Preview (05·2) → `div.vn-bar[data-vn-bar]` (`.is-voice-preview`): box `padding:8px 6px`, normal ring, height 58.

| Part | Spec | Production |
|---|---|---|
| Delete | `.ib` round, trash | `button.vn-delete[data-vn-delete]` |
| Play with progress ring `.pring` | 42 × 42, `padding:2px`, circle, `conic-gradient(var(--a) 0 35%, var(--a-3) 35% 100%)` (35% = 5 of 14 s); inner `.ra` 38 × 38 with `0 0 0 2px #fff`, play 15 | `button.vn-play[data-vn-toggle]` (+ ring is new) |
| Waveform `.wv` | `margin-inline:4px`, 18 bars; played `--a`, unplayed `.d` `--line-2` | `.vn-track[data-vn-seek] > .vn-progress[data-vn-progress]` |
| Time `.rtm` | min-width 34, 600, `--ink-3`, «۰:۱۴» | `span.vn-time[data-vn-time]` |
| Speed `.spd` | height 24, `padding:0 8px`, r 8, `--bg-2`, `--ink-2`, tabular, 14px/400 rendered, «۱×», `aria-label` «سرعت پخش» | new |
| Send | `.ra` send | `button.vn-send[data-vn-send]` (`:disabled` → `.ra.off`) |

Production makes the preview row `dir="ltr"` on purpose (PD:1083-1090); the design draws it right to left. See §7.

### 4.19 Form fields (pre-chat, 07·07)

| Class | Spec | Production |
|---|---|---|
| `.fm` | column, gap 16, `padding:20px 18px 8px`, flex 1 | `.wy-view-precontact .wy-scroll.wy-body-pad` |
| Intro `.intro` | flex, gap 12, `padding:14px`, r 16, bg `--bg`, inset 1px `--line`, 13/1.75 `--ink-2`; tile `.lt` 36 (`#fff` + ring) with person 18; title `b` block 14/700 `--ink` | `p.prechat-subtitle` restyled + title (new markup) |
| Field `.fld` | column, gap 6 | `div.prechat-field[data-field]` |
| Label | 13/600 `--ink`; required `.rq` `*` `--bad`, `margin-inline-start:2px`; optional `.op` «(اختیاری)» 12/400 `--ink-3` | `label.prechat-label` + `span.prechat-req-mark`; optional suffix new |
| Input `.inp` | height 48, `padding:0 14px`, r 14, `#fff`, `inset 0 0 0 1px var(--line-2)`, 14.5px, placeholder `#7A808C`; transition `box-shadow .15s` | `input.prechat-input[data-prechat]` |
| Hover / focus / error | `inset 0 0 0 1px var(--ink-4)` / `.fo`: `inset 0 0 0 1.5px var(--a), 0 0 0 4px var(--a-3)` / `.er`: `inset 0 0 0 1.5px var(--bad), 0 0 0 4px #FDE9E7` | `:hover` / `:focus` / `[aria-invalid='true']` |
| Error text `.err` | flex, gap 6, 12/600 `--bad`, error icon 14 before the text | `div.prechat-error[role=alert]` (Core writes the text; icon via CSS) |
| E-mail, phone | `dir=ltr` with `text-align:right` (inline in the board) | production `dir=ltr` already |
| Small `.inp.sm` | height 42, `padding:0 12px`, r 12, 13.5px | form card, e-mail card |
| Privacy `.priv` | centred flex, gap 6, `margin:10px 0 0`, 11.5 `--ink-3`, lock 13/2 | new (the production CSS has an unused `.prechat-privacy*`) |

### 4.20 Inline cards in the thread

| Card | Spec | Production |
|---|---|---|
| Offline banner `.ban` (07·09) | flex, gap 12, `margin-bottom:16px; padding:12px 14px`, r 16, bg `--bg`, inset 1px `--line`; tile `.lt` `#fff` + ring, moon 18 `--ink-2`; `b` 13.5/1.5/700; `small` 12/1.5 `--ink-3` | new |
| E-mail capture `.ec` (07·09) | `<form>`, column, gap 8, width 282, `padding:12px`, r 18, `#fff`, `--sh-2`; label 12.5/600; row `.rw` gap 6: `.inp.sm` (LTR) + `.go` | contact-fallback hooks: `input.prechat-input#fb-email[data-fb=email]`, `button[data-fb-submit]`, `div.fallback-status[data-fb-status]` |
| Form card `.fcard` (08·a) | `<form>`, column, gap 10, width 300, `padding:14px`, r 20, `#fff`, `--sh-2`; `h4` flex gap 8, 14/700 with tile 28 r 9 (person 15); labels 12/600 `--ink-2`; `.inp.sm`; `button.btn.btn-p.sm`; `.priv` `margin:0` | `.hc-card[role=group]` (§5.18) |
| Joined corners | operator bubble followed by `.fcard` or `.ec`: bottom-left 6px; card top-left 6px | |
| Step progress `.prog` (08·b, in the composer) | flex, gap 10, `padding:0 8px 8px`, 11.5/600 `--ink-3`; bar flex 1 of 3 segments, gap 4, height 4, r 2, `--line`, done `.on` `--a`; `.skip` `margin-inline-start:4px; padding:0 4px`, `--a-ink`, 11.5/600 rendered | new |
| Prefixed input `.ex` | flex; `.pre` «+۹۸» 14px `--ink-2`, `direction:ltr`, divider `border-inline-end:1px solid var(--line-2)` (see §7 for the side), then the input (26px row) | new |
| Summary `.sum` (08·c) | width 300, centred, `margin-bottom:14px`, r 18, `#fff`, `--sh-2`, overflow hidden; head `.sh2` flex gap 8, `padding:10px 14px`, `#EDF7EF`, 13/700 `#0F6B37`, check-circle 16, edit link «ویرایش» 12/600 `--a-ink` at inline-end; rows `.rw` space-between, `padding:9px 14px`, top hairline, 12.5px, label `--ink-3`, value bold (e-mail `.ltr`) | new |
| Queue pill `.queue` (08·c) | flex, gap 8, centred, `margin-bottom:14px; padding:4px 12px`, r 99, bg `--bg`, inset 1px `--line`, 12px `--ink-2`, live dot | `div.msg-row.system > div.msg-system-pill` (`routing_in_queue`). **Suggestion:** same look for every system pill |
| Welcome block `.wel` + `.sep` (04·06) | column centred, `padding:22px 18px 4px`; stack 48px; `h3` `margin:12px 0 2px` 17/1.5/700; `p` flex gap 6, 12.5 `--ink-3` with live dot; separator 1px `--line`, `margin:18px 6px` | new, inside `.messages.welcome-only` before the welcome row |

### 4.21 Help: categories, article, rating, ask card

| Element | Spec | Production |
|---|---|---|
| Category row | `.li` with `.lt` icon tile, `.l1` name, `.l3` count «۵ مقاله», chevron; card `padding:4px 14px`; rows 59.6 tall | new (categories exist in the KB view-model but are ignored, PD:1387-1392); icon per category is new data (**Suggestion:** a default icon) |
| Popular card | `.cd` `padding:12px 14px 4px`: `.sh` «پربازدیدترین‌ها» + `.li` rows | `button.kb-article[data-kb-action=open][data-kb-slug]` |
| Article body `.art` | flex 1, `padding:18px 22px 6px`; `h1` `margin:0 0 8px` 21/1.6/700; meta `.am` flex gap 8, `margin-bottom:16px`, 12 `--ink-3` with avatar 24; `p` `margin:0 0 12px` 14.5/2 `#272B34`; `a` 600 `--a-ink`, underline 1px, offset 3px; `h2` `margin:16px 0 8px` 16/700 | `.kb-article-view > .kb-article-body` (KB HTML): style its `h1/h2/p/a/ol` |
| Steps `ol.steps` | no list style, column, gap 8, `margin:0 0 12px`; `li` flex gap 10, 14.5/1.85 `#272B34`; number `b` 24 × 24 r 8 `--a-2`/`--a-ink` 12/700, `margin-top:3px` | KB `ol > li`: draw the numbers with a CSS counter (Persian digits, e.g. `counter(n, persian)`) |
| Tip `.tip` | flex, gap 10, `padding:12px 14px`, r 14, `--a-1`, inset 1px `--a-3`, 13/1.85 `--ink-2`; info 16 `--a-ink`, `margin-top:3px` | needs a KB callout element (e.g. `blockquote` or a class), else not used |
| Rating `.fb` | flex space-between, gap 10, `padding:12px 18px 4px`, top border 1px `--line`, flex none; question 13/600; buttons `.fbb button` height 36, `padding:0 12px`, gap 6, r 11, `#fff`, inset 1px `--line-2`, 13/600 `--ink-2`, thumb 16; hover `--bg` | `.kb-feedback[data-kb-feedback]`, `button.kb-rate[data-kb-rate=up/down][aria-pressed]`. Selected and thanks states are not drawn (**Suggestion:** pressed = `.chip.on` look) |
| Ask card `.cd.cta.ask` | `margin:10px 14px 0`; two 28px avatars, «هنوز سؤال دارید؟», live dot + «با تیم پشتیبانی گفتگو کنید», `.ra` send | `[data-kb-action=switch-chat]` (today only after a "down" rating); hide with `hideChatCta` |

### 4.22 Skeleton

`.sk` (07·13): flex, gap 12, `padding:12px 0`; `i` blocks radius 8 (circle 44 for the avatar), background
`linear-gradient(90deg,var(--bg-2) 0%,var(--bg) 50%,var(--bg-2) 100%)` at `background-size:200% 100%`, animation
`wy-sh 1.4s linear infinite`; bars 12px (45%) and 10px (80%), gap 8; the second row at opacity .55 (35%/70%). Apply to
production's `.wy-sk` primitives and keep skeleton parity with the new headers, paddings and composer (brief §2.7).

### 4.23 Launcher (WebYar kit) — unchanged

Board 10's kit CSS and glyph are identical, character for character, to production `WEBYAR_KIT_CSS` /
`WEBYAR_KIT_CHAT_GLYPH` (LD:673-674, checked). Brand mode: `linear-gradient(140deg,#22D3B4,#0B7D6C)`, 60 × 60 circle, shadow `0 12px 28px rgba(11,125,108,.36),
0 3px 8px rgba(18,20,31,.16)`, dots `#18AD94`, ring `#16C7A8`; badge 24 × 24 `#FFB423`/`#12141F` 800 13px/24px, ring 3px
`#fff`, `top:-6px; right:-6px`, Persian digits; offline `#12141F` ground, `#16C7A8` bubble, `#12141F` dots. States and
timings: §6 and production map §3.2. Custom accent (board 10 «رنگ اختصاصی مشتری — رنگ ساده، بدون گرادیان», customer colour: plain, no gradient):
plain accent background, dots in the accent, shadow `0 12px 26px -8px color-mix(in oklab,var(--gs-primary) 60%,transparent),
0 3px 8px rgba(18,20,31,.16)` (new; production uses `--gs-shadow`).

### 4.24 Launcher style options (board 11, new)

Board 11 `.ln` (source/11-launcher-and-color.dc.html:34-67): 60 × 60, circle, `#fff` content, background = accent (brand:
the kit gradient), shadow `inset 0 1px 0 rgba(255,255,255,.22), inset 0 -2px 0 rgba(0,0,0,.08), 0 12px 26px -8px
color-mix(in oklab,var(--a) 60%,transparent), 0 3px 8px rgba(18,20,31,.16)`; transition `transform .22s
cubic-bezier(.2,.8,.2,1), box-shadow .22s ease, border-radius .25s ease`; hover `translateY(-3px) scale(1.06)`.

| Option | Spec |
|---|---|
| «وب‌یار اصلی» · «کیت برند» (WebYar original · brand kit) | the kit (§4.23) |
| «وب‌یار مربعی» · «گوشه گرد ۱۸» (WebYar square · corner radius 18) | kit glyph, `border-radius:18px` (production `.square` is 16px) |
| «حباب کلاسیک» · «آشنا و ساده» (classic bubble · familiar and simple) | white filled bubble 36px with three dots (r 1.25) in `--dot` (brand `#18AD94`, else the accent) |
| «دو حباب» · «حس گفتگو» (two bubbles · feels like a conversation) | back bubble outline (stroke 1.8, opacity .75) + front filled bubble, 36px |
| «هدست پشتیبانی» · «برای خدمات» (support headset · for services) | headset, 34px, stroke 2, filled ear cups |
| «چهره اپراتور» · «انسانی‌تر» (agent face · more human) | inner disc `calc(100% - 8px)` `#FCE3D4`/`#8A3410` 20/700 initial; online dot 14 × 14 `--ok`, 2.5px white border, `bottom:1px; inset-inline-end:1px`; the option card also shows a typing chip (white pill `top:-5px; inset-inline-start:-5px`, `padding:5px 6px`, r 10, three 4 × 4 accent diamonds) |
| «کپسول با متن» · «بیشترین کلیک» (pill with text · most clicks) | `width:auto; height:56px; border-radius:28px`, flex, gap 4, `padding-inline:6px 20px`, 14/600, no wrap; 46 × 46 kit glyph + «سؤالی دارید؟ بپرسید» (Have a question? Ask) |

The settings board scales the kit glyph by 1.14 and uses the `.ln` shadow on the kit too: preview approximations; the
kit follows §4.23. The option cards also loop idle animations (§6), shown only in this settings board.

### 4.25 Greeting bubble (smart nudge, board 10)

Board 10 `.nud` (source/10-launcher-and-greeting.dc.html:51-61); this board uses its own local tokens: `--ink:#11131A`,
`--ink3:#666C7B`, `--wash:#F4F5F8`, `--ok:#16A35A`, `--as` = `color-mix(in oklab,var(--a) 9%,#fff)` (`#EBF3F1`),
`--at` = `color-mix(in oklab,var(--a) 70%,#11131A)` (`#195B52`).

| Part | Spec |
|---|---|
| Bubble | width 300, `padding:14px 16px`, radius 20, `#fff`, shadow §3.4; bottom edge 104px above the host bottom = 20px above the 60px launcher (production: `size + 12px`); anchored to the launcher side |
| Tail `::after` | 14 × 14 `#fff`, `rotate(45deg)`, `bottom:-7px; inset-inline-start:22px` (centred over the launcher), `border-radius:0 0 3px 0`, `box-shadow:3px 3px 6px -3px rgba(17,19,26,.12)` |
| Close `.x` | inside, `top:10px; inset-inline-end:10px`, 28 × 28, r 9, `--wash`, `--ink3`, X 14; `aria-label` «بستن اعلان» |
| Head `.tp` | flex, gap 10, `margin-bottom:8px`; avatar 34 × 34 `#FBE3D6`/`#8F3711` 13/700 with online dot 11 × 11 `--ok`, 2px white border; name `strong` 13/1.4/700; subtitle `small` 11.5/1.4 `--ink3` «فروشگاه نیلوفر · آنلاین» |
| Message `p` | 14/1.75, `margin:0 0 12px` |
| Quick replies `.qr` | flex wrap, gap 6; `a` height 34, `padding:0 12px`, r 11, `--as` bg, `--at` text, 12.5/600 |

Production: `div.smart-nudge > button.smart-dismiss[data-smart-dismiss] + div.smart-title + div.smart-body +
button.smart-cta[data-smart-cta]` (LD:2698-2730). Map title → name line, body → message, CTA → first quick reply. New:
agent avatar + presence + subtitle, a second quick reply, the close button inside the bubble at the inline-end (today
outside at the top-right), width 300 (today max 288), gap 20 (today 12).

---

## 5. Screens

Measurements are from the reference pages at 1x (y = top edge inside the 400 × 720 panel). Sample content is demo data.

### 5.1 Home · 01·02

- **Purpose:** first screen when the widget opens; team online, no conversation yet.
- **Layout:** §2.2. Hero. Card 1, team card (`.cd`, 372 × 135 at y 188): `.tm` = 36px stack `.c1 .c2 .c3` + `.t1` and
  `.t2` (live dot + status), then `a.btn.btn-p` with the send icon, 14px below. Card 2, help card (`padding:12px 14px 4px`,
  372 × 248 at y 335.5): `.sr` search, then `.ls` (`margin-top:4px`) with 4 rows of 46px. Footer at y 616; bottom menu
  `vb` with Home active.
- **Copy:** «سلام، خوش آمدید» · «چطور می‌توانیم کمکتان کنیم؟» · «گفتگو با تیم پشتیبانی» · «آنلاین · پاسخ در چند دقیقه» ·
  «شروع گفتگو» · placeholder «جستجو در راهنما» · footer «قدرت گرفته از» «وب‌یار». Article titles are KB data.
- **Data:** logo = `logoUrl` or workspace initial; greeting = `homeGreeting`; question = `vm.welcomeMessage` or
  `homeWelcome`; stack = online `vm.teamMembers` as initials (`vm.showTeamAvatars:false` hides it); status = «آنلاین» +
  `replyTimeText(true)` (short form, §10); rows = `vm.articles` when `vm.kbEnabled`.
- **States and interactions:** CTA → `[data-home-action=chat]`; row → `[data-home-article=<slug>]` (hover §4.7); search
  → help results (§4.6). Article rows: 4 here, 3 in 01·03, 2 in 01·08 (what fits at 720px; inferred rule: 4 without a
  recent card, 3 with one, 2 offline).
- **Production:** `homeHtml` (PD:1176-1287). The hero replaces `.wy-head-home` (§4.2); the team card + CTA replace
  `.wy-actions` (the production avatar stack inside the CTA moves into `.avs`; remove the inline smart-CTA background,
  PD:902); the help card replaces the chips section (`.home-chip` → rows; `.home-chip-more` kept, hidden). The
  `section.smart-home-card` is not drawn (**Suggestion:** a `.cd` between the team card and the help card).

### 5.2 Home with a recent chat · 01·03

- **Purpose:** home for a returning visitor with an open conversation.
- **Layout:** hero; card 1 recent (`a.cd`, `padding:12px 14px 14px`, 372 × 95.5 at y 188): `.cap`, then `.rrow`: avatar
  40 `.c1` + presence `.pr`, `.l1` name + time, `.l2.u` preview (ellipsis) + `.nb`. Card 2 CTA (`a.cd.cta`, 372 × 69 at
  y 296): 28px stack, `.t1`, `.t2` (live dot + status), `.ra` with the send icon (decorative). Card 3 help card with 3
  rows (y 377). Messages tab badge.
- **Copy:** «سلام دوباره، علی» (greeting with the visitor's name) · «پیام اخیر» · «ارسال پیام جدید» · «پاسخ در چند دقیقه».
  Demo: «سارا · فروشگاه نیلوفر» (agent · store), «۱۰ دقیقه پیش», the preview, «۲».
- **Data:** the most recent conversation (one card): agent name, agent online, store name (new VM fields; fallback
  `title` and the store initial), `timeLabel`, `preview`, `unreadCount` (`fmtNum`); visitor name for the greeting
  (identify / contact; fallback «سلام، خوش آمدید»).
- **States and interactions:** recent card → `[data-conversation-open=<id>]` (hover lift §4.3); CTA card →
  `[data-home-action=chat]`.
- **Production:** compact row (PD:1153-1157) gains avatar and name and replaces the "continue last conversation" button;
  the outline «گفتگوی جدید» button becomes the CTA card; `section.home-recent` keeps one row; its
  `home-link[data-view=list]` becomes `.more` (only in `nv-none`, §5.5).

### 5.3 Team away · 01·08

- **Purpose:** home while the team is offline.
- **Layout:** team card 372 × 211: `.avs.dim`, `.t1`, `.t2` with `.live.off`, `.note` (envelope 18 + text), `a.btn.btn-p`
  12px below the note. Help card with 2 rows (y 411).
- **Copy:** «الان آفلاین هستیم» · «از ساعت ۹ صبح پاسخ می‌دهیم» · «پیامتان را بگذارید؛ پاسخ را به ایمیلتان می‌فرستیم و همین‌جا هم می‌بینید.» ·
  «پیغام بگذارید» · placeholder «جوابتان شاید در راهنما باشد».
- **Data:** `vm.isOnline=false`; next opening time (new; fallback `homeReplySlow`).
- **States and interactions:** CTA → `[data-home-action=chat]` (production offline CTA).
- **Production:** same view as online (production screen 08).

### 5.4 Bottom bar styles · 02

Board 02 draws each bar under the end of a list card in a 400 × 196 crop (board chrome), three times: Home, Messages and
Help active, Messages badge «۲». Purpose: the `navStyle` setting (brief §9). Production: new markup (§4.10).

#### 02·a Classic bar, diamond marker («کلاسیک دقیق»)

Full-width bar 70px, icon over label on every tab, small diamond under the active tab (§4.10 `va`); the board's line
«نوار تمام‌عرض، آیکن و برچسب زیر هم، لوزی کوچک زیر بخش فعال» says exactly this.

#### 02·b Floating dock, active capsule («داک شناور با کپسول») — default

Floating bar 60px; the active tab is a tinted capsule with icon and label, the others icon only (§4.10 `vb`). Marked
«اعمال‌شده» (applied) and used on every other board.

#### 02·c Segmented («سگمنت»)

Grey track 58px; every tab labelled; the active tab is a raised white segment (§4.10 `vc`).

#### 02·d Brand dock («داک برند»)

Floating bar in the hero gradient, same family as the launcher; the active tab is a white capsule (§4.10 `vd`).

### 5.5 Bottom menu modes · 03

All five panels are 01·03 with a different `navMode` (super-admin setting). Production: new (§4.10).

#### 03·a Icons and labels («آیکون و نوشته», `.nv-both`)

Bar 64px (y 644); icon 22px over an 11.5px label on every tab; badge at the left of the icon; footer at y 612.

#### 03·b Icons, label on the active tab («آیکون + نوشته فعال · پیش‌فرض») — default

As 01·03.

#### 03·c Icons only («فقط آیکون», `.nv-icon`)

As 03·b without the active label.

#### 03·d Labels only («فقط نوشته», `.nv-text`)

Labels 13.5px, no icons; the Messages badge follows the label «پیام‌ها» (static, no ring).

#### 03·e No menu («بدون منو», `.nv-none`)

Bar removed; footer at y 688; `.more` «همه گفتگوها» (y 290, left edge) between the recent card and the CTA card →
`button.home-link[data-view=list]`. The board text: with no menu, home gets «همه گفتگوها» and the Messages and Help screens
get a back button (`.ttl .bk`, §4.11).

### 5.6 Thread and typing · 04·04

- **Purpose:** an active conversation with the agent typing.
- **Layout:** header 68 (back · avatar 40 + presence · name/status · ⋯ · close); thread 68–598 anchored to the bottom with
  the 30px top fade: visitor group (y 128), operator group with name (y 207), visitor group with a quote (y 394), typing
  group (y 530, `margin-bottom:6px`); composer at rest (y 606, box 82); footer.
- **Copy:** «آنلاین · پاسخ در چند دقیقه» · «سارا در حال نوشتن…» (= `{name} در حال نوشتن…`) · placeholder «پیام خود را بنویسید…».
  Demo: «سارا · فروشگاه نیلوفر», messages, «TR-2290-5531», «پیگیری مرسوله», «post.ir», times.
- **Data:** assigned agent name and presence (new; fallback store avatar + workspace name); messages from Core
  (`messagesHtml`); typing from `setOperatorTyping`.
- **States and interactions:** read ticks (accent); link card opens in a new tab; composer empty (mic in the action slot).
- **Production:** `chatFrameHtml` (PD:950-1140) + `messagesHtml` (PD:630-796); hooks unchanged; new: name label, initial
  avatars, link card, code chip, visible typing row (§4.13, §4.14); presence is sr-only today (`[data-presence]`): add a
  visible `.pr` fed by `availability.state` or Core presence.

### 5.7 Attachments, errors and typing · 04·05

- **Purpose:** media in the thread, a failed message, and a draft with a pending file.
- **Layout:** visitor image (y 114, 224 × 132) + read tick; operator file bubble (y 281, 240 × 66); visitor voice bubble
  (y 383, 240 × 52) + single tick; failed visitor message (y 470) with error meta; composer focused (`.fo`, box 135 tall at
  y 553) with the pending file row, the draft and send in the action slot; thread 477 tall.
- **Copy:** «ارسال نشد» · «تلاش دوباره» · `aria-label` «دانلود فاکتور», «پخش پیام صوتی», «حذف پیوست». Sizes use Persian
  digits and units: «۸۴۰ کیلوبایت», «۲۴۰ کیلوبایت», «۱٫۲ مگابایت». Demo: file names, «۰:۱۴», the address, the draft.
- **Data:** attachment name, size, type (Core); message status `failed` + `localId`.
- **States and interactions:** image → lightbox (`[data-att-preview]`); download (`[data-att-download]`); play
  (`[data-audio-toggle]`); retry (`[data-msg-retry]`); remove the pending file (`[data-attach-remove]`).
- **Production:** §4.15, §4.16. File names: isolate Latin names (`.ltr`); the board does it for the image caption only,
  so the PDF name is not isolated and its `pdf.` extension is drawn at the left end, before the Persian name (§7).

### 5.8 New conversation and topics · 04·06

- **Purpose:** an empty conversation that asks the visitor to pick a topic.
- **Layout:** header without avatar or ⋯ (title + subtitle); `.th.top`: welcome block (y 82, 135 tall), separator
  (y 235), operator run (`max-width:92%`, y 254) of two bubbles with meta, chips (y 404, two lines of 36px, gap 8);
  composer at rest.
- **Copy:** «گفتگوی جدید» · «فروشگاه نیلوفر» (workspace name) · «تیم پشتیبانی فروشگاه نیلوفر» (= `تیم پشتیبانی {workspace}`) ·
  «معمولاً در چند دقیقه پاسخ می‌دهیم» · «همین حالا». Welcome bubbles: «سلام! چطور می‌تونیم کمکتون کنیم؟» and «برای اینکه
  سریع‌تر به نفر درست وصل بشید، موضوع رو انتخاب کنید:» (workspace welcome text). Chips «پیگیری سفارش», «مشاوره خرید»,
  «مرجوعی و بازگشت وجه», «پشتیبانی فنی» are workspace data.
- **Data:** team members (initials), workspace name, `homeReplyFast` / `replyTimeText`, `welcomeMessage`, topics.
- **States and interactions:** chip `.on` = the chip just pressed (inferred); picking sends the topic.
- **Production:** `emptyHtml()` (PD:215-237) renders one welcome bubble (lines joined with `<br>`): add the welcome block
  (§4.20) and **Suggestion:** one bubble per paragraph. Topics: `.qna-suggestions[data-qna] > .qna-chips >
  button.qna-chip[data-qna-question]` (hide `.qna-title`; the question is in the bubble) or a new `data-topic` sent as the
  first message (brief §9).

### 5.9 Recording · 05·1

- **Purpose:** the composer while a voice message is being recorded.
- **Layout:** thread with day divider «امروز» (y 322); composer box `.cbox.rec` 77.5 tall (y 610.5): `.rbar` (38) +
  `.hint` (19.5, `margin-top:4px`). Thread 534.5 tall.
- **Copy:** «Esc لغو · Enter ارسال · حداکثر ۲ دقیقه»; `aria-label` «لغو ضبط», «توقف ضبط», «ارسال پیام صوتی»; timer «۰:۰۸».
- **Data:** elapsed time (Core `[data-rec-timer]`); recording limit (new).
- **States and interactions:** cancel, stop (→ 05·2), send immediately (new); Esc / Enter (new); dot pulse and live wave
  (§6).
- **Production:** `div.rec-bar[data-rec-bar]` with `.input-bar.is-recording` (§4.18).

### 5.10 Preview before sending · 05·2

- **Purpose:** listen back to the recording before sending it.
- **Layout:** composer box 58 tall (y 630): delete, play with progress ring, waveform, time, speed, send. Thread 554.
- **Copy:** `aria-label` «حذف ضبط», «پخش — ۵ از ۱۴ ثانیه» (position of length), «سرعت پخش», «ارسال پیام صوتی»; «۰:۱۴», «۱×».
- **Data:** length, position (Core `[data-vn-time]`, `[data-vn-progress]`); playback rate (new).
- **States and interactions:** play / pause (`[data-vn-toggle]`, `.is-playing`), seek (`[data-vn-seek]`), speed (new),
  delete (`[data-vn-delete]`), send (`[data-vn-send]`, `:disabled` while uploading → `.ra.off`).
- **Production:** `div.vn-bar[data-vn-bar]` with `.is-voice-preview` (§4.18). Production keeps every mode at 46px rows;
  follow the design heights (82 at rest, 77.5 recording, 58 preview). Direction: §7.

### 5.11 Button states · 05·3

- **Purpose:** spec card (board chrome) for the round action button; its content is spec.
- **Content:** title «یک دکمه، چند حالت» (one button, several states); text «با شروع تایپ فقط آیکن عوض می‌شود: محو و چرخش
  ۹۰ درجه در ۱۸۰ میلی‌ثانیه. اندازه ۳۸ پیکسل روی دسکتاپ و ۴۶ روی موبایل.» (when typing starts only the icon changes: fade
  and 90° rotation in 180ms; 38px on desktop, 46 on mobile); six states «میکروفون» («کادر خالی», empty box), «هاور»
  («۱۰۶٪ · تنالیته پررنگ‌تر», 106% · stronger tint), «توقف ضبط» («قرمز ملایم», soft red), «ارسال» («هنگام تایپ», while
  typing), «فشرده» («۹۴٪», pressed 94%), «غیرفعال» («در حال ارسال», disabled while sending); flow «خالی» → «تایپ» → «ضبط»
  (empty → typing → recording).
- **Spec:** §4.4 `.ra` (hover = `.ra.hv`, pressed = `.ra.pr`, `.stop`, `.off`); icon swap 180ms ease-out (§6).
- **Production:** `.mic-btn`, `.send-btn`, `.rec-confirm`, `.vn-send` share this look (§4.16).

### 5.12 Tap the emoji icon · 06·1

- **Purpose:** the moment the visitor taps the emoji button.
- **Layout:** as 04·04 with a short thread; composer focused with the draft «عالیه، خیلی ممنون» and send in the action slot;
  emoji button in the board's tap indicator (`.ib.tap`: `--a-2`, `--a-ink`, 4px halo
  `color-mix(in oklab,var(--a) 14%,transparent)`, pulse) — not a resting state.
- **Production:** `.emoji-btn[data-emoji-btn][aria-expanded=false]` (§4.17).

### 5.13 Emoji in the same box · 06·2

- **Purpose:** the picker open inside the composer box.
- **Layout:** composer box 336 tall (y 352); picker 246 (search 36, categories 32, grid 152 with section headers and 8-column
  rows of 38); thread 276. First emoji highlighted (`.hit`); the picked emoji (U+1F60D) is appended to the draft; emoji button `.on`.
- **Copy:** «جستجوی شکلک» · «پرکاربرد» · «چهره‌ها»; `aria-label` «انتخاب شکلک», «دسته‌های شکلک», tab labels (§10),
  «بستن شکلک‌ها».
- **Data:** emoji sets per category (new in Core).
- **States and interactions:** pick inserts at the end of the draft with a space before it; the picker stays open; the
  emoji button toggles; category tabs switch the grid.
- **Production:** §4.17 (move or join `[data-emoji-picker]`).

### 5.14 Live preview · 06·3 (+ state: picker open)

- **Purpose:** prototype of the open/close motion.
- **Script loop (demo):** open at 900ms, add U+1F60D at 2000ms, switch to «قلب‌ها و نمادها» at 2900ms, add U+2764 U+FE0F at 3800ms, close at
  5600ms, reset at 7400ms, repeat every 8000ms; picking, a category tab or the emoji button stops the loop. The selected
  emoji keeps `.hit` for 420ms.
- **Screenshots:** the panel shows the closed state; [states/06-…--picker-open.png](screens/states/06-emoji-in-composer--picker-open.png)
  shows the picker open over the original draft.
- **Production:** product behaviour = toggle on the emoji button, insert on pick; motion §6.

### 5.15 Pre-chat form with an error · 07·07

- **Purpose:** contact details before the chat starts, with a validation error.
- **Layout:** header (back · title/subtitle · close, no avatar); `.fm`: intro box (y 88, 75 tall), name field (y 179),
  e-mail field in error (y 271, with the error line), phone field focused (y 390); bottom block (y 602.5): primary button +
  privacy note; footer.
- **Copy:** «اتصال به پشتیبان» · «فروشگاه نیلوفر» (workspace name) · «قبل از شروع، خودتان را معرفی کنید» · «اگر از سایت رفتید،
  پاسخ را برایتان می‌فرستیم.» · «نام» + «*» · «ایمیل» + «*» · «ایمیل کامل نیست؛ مثلاً name@example.com» · «شماره موبایل» +
  «(اختیاری)» · placeholder «۰۹۱۲ ۳۴۵ ۶۷۸۹» · «شروع گفتگو» · «اطلاعات شما فقط برای پاسخگویی استفاده می‌شود.»
- **Data:** asked/required fields from `identity.isAsked/isRequired` (server); error text and `aria-invalid` from Core.
- **States and interactions:** field hover, focus, error (§4.19); submit `[data-prechat-submit]`.
- **Production:** `prechatFormHtml` (PD:823-842). Header today: workspace name + «اتصال به اپراتور» (`wyConnectOperator`):
  swap to title = connect label, subtitle = workspace name.

### 5.16 Message while away · 07·09

- **Purpose:** the visitor writes while the team is offline and leaves an e-mail for the reply.
- **Layout:** header (avatar `.c4` + `.pr.off`); `.th.top`: banner (y 82), visitor group (y 160) with text meta, operator run
  (y 239): bubble + e-mail card (282 × 95) + meta; composer at rest (enabled).
- **Copy:** «آفلاین · پاسخ از طریق ایمیل» · «تیم ما الان آفلاین است» · «از ساعت ۹ صبح پاسخ می‌دهیم · معمولاً تا ۲ ساعت» ·
  «ارسال شد» (meta after the time) · «پیامتون ثبت شد. ایمیلتون رو بگذارید تا پاسخ رو براتون بفرستیم.» · «ایمیل برای دریافت پاسخ» ·
  placeholder «name@example.com» · «پیام خودکار»; `aria-label` «ایمیل برای پاسخ», «ثبت ایمیل».
- **Data:** offline state, next opening and typical reply time (new); automated reply (Core or workspace text).
- **States and interactions:** e-mail submit (`.go`); validation as §4.19.
- **Production:** today the offline chat shows the welcome bubble with send disabled ("Disabled while offline") or Core
  shows the contact-fallback form (`.wy-view-fallback`, production §4.6). The design needs the composer enabled offline,
  the visitor's message kept as the fallback message, an automated reply, and the card wired to `data-fb=email`,
  `data-fb-submit`, `data-fb-status` (§4.20). If Core cannot do this, keep the fallback form styled with §4.19.

### 5.17 Messages · 07·13

- **Purpose:** all conversations (Messages tab).
- **Layout:** `.ttl` (64; back hidden unless `nv-none`); list (`padding:0 16px`) of `a.li` rows with
  `align-items:flex-start; padding-block:12px` (91.8 tall): avatar 44 (+ `.pr` when the agent is online), `.lx` with `.l1`
  (name + `time`), `.l2` (preview; `.u` + `.nb` when unread) and `.tg`; two skeleton rows (y 338 and 406); CTA wrapper
  (y 560); footer; bottom menu with Messages active.
- **Copy:** «پیام‌ها» · «باز» · «حل شده» · «شما: » prefix when the visitor sent the last message · «ارسال پیام جدید»;
  skeleton `aria-label` «در حال بارگذاری». Demo: names, previews, «دیروز», «۵ روز پیش».
- **Data:** `vm.conversations` (status, preview, `timeLabel`, `unreadCount`), agent name and presence (new), last-sender
  flag (new), `vm.loading`.
- **States and interactions:** row → `[data-conversation-open]` (hover §4.7); CTA → `[data-home-action=chat]`; loading rows.
  Empty and error states are not drawn (keep production behaviour with the new tokens).
- **Production:** `conversationListHtml` (PD:1292-1326): `.wy-head-list` → `.ttl`; the header `.wy-fab[data-home-action=chat]`
  becomes the bottom CTA (same hook); `button.conv-row` gains the agent name/avatar and the tag look; loading =
  `skeletonConvRowsHtml(6)`.

### 5.18 Form card in the chat · 08·a

- **Purpose:** pre-chat details collected inside the conversation as a card.
- **Layout:** header with avatar; operator run (y 133): bubble (94 tall) joined to the form card (300 × 371: title row,
  three fields 68 tall, button 40, privacy) and meta «همین حالا»; composer locked (box 48 at y 640).
- **Copy:** «سلام! خوش اومدید. قبل از شروع خودتون رو معرفی کنید تا اگه از سایت رفتید هم جواب‌تون برسه.» · «مشخصات شما» ·
  «نام» · «ایمیل» · «موبایل» + «(اختیاری)» · placeholders «name@example.com», «۰۹۱۲ ۳۴۵ ۶۷۸۹» · «شروع گفتگو» ·
  «فقط برای پاسخگویی استفاده می‌شود» · «اول فرم بالا را تکمیل کنید»; card `aria-label` «مشخصات تماس».
- **States and interactions:** e-mail field focused (`.inp.sm.fo`); submit `[data-prechat-submit]`; composer locked until
  submitted (new).
- **Production:** `handoffPrechatCardHtml` (PD:798-816) puts `.hc-card` in a **visitor** row (right); the design puts it in
  the operator run (left): render it in an operator row with joined corners; keep `role=group`, `aria-label`, field hooks;
  the subtitle (typewriter host) can become the bubble above the card.

### 5.19 Step by step, like a chat · 08·b

- **Purpose:** the same details asked one question at a time.
- **Layout:** alternating operator questions (no names, no meta) and visitor answers; a failed answer (`.fail`, `.ltr`)
  with an error meta; an accepted answer with «ثبت شد» + check; composer focused (box 111.5): `.prog` row, prefixed input
  `.ex`, tools row with hint and the disabled submit.
- **Copy:** «سلام! برای شروع، اسم‌تون چیه؟» · «ممنون علی جان. ایمیل‌تون رو هم بنویسید تا جواب‌ها رو براتون بفرستیم.» ·
  «ایمیل کامل نیست» + «· مثلاً name@example.com» · «ثبت شد» · «اگه بخواید شماره موبایل‌تون رو هم بدید تا پیامکی خبرتون کنیم.» ·
  «مرحله ۳ از ۳ · اختیاری» · «رد کردن» · «+۹۸» · placeholder «۹۱۲ ۳۴۵ ۶۷۸۹» · «برای پیامک پیگیری»; `aria-label` «شماره موبایل»,
  «ثبت».
- **States and interactions:** step progress (3 segments, done = accent); skip optional steps; submit disabled until the
  value is valid (inferred).
- **Production:** new Core mode over the same identity fields (§9).

### 5.20 After submitting · 08·c

- **Purpose:** the conversation continues after the details are saved.
- **Layout:** summary card (300 wide, y 242, centred), operator group with meta, queue pill (y 481, centred), visitor
  message with single tick; composer at rest.
- **Copy:** «مشخصات شما ثبت شد» · «ویرایش» · «نام» · «ایمیل» · «نفر ۲ در صف · حدود ۳ دقیقه»; summary `aria-label`
  «مشخصات ثبت‌شده». Demo: «ممنون علی! یکی از همکارهام تا چند دقیقه دیگه جواب می‌ده. سؤال‌تون رو بنویسید.» (automated
  message), values.
- **Data:** submitted values; queue position and wait (new in `routing_in_queue`).
- **States and interactions:** «ویرایش» reopens the details (new).
- **Production:** summary is new (§4.20); queue pill = `div.msg-system-pill` of the `routing_in_queue` system row
  (production §5.2).

### 5.21 Help · 09·10

- **Purpose:** help center home (Help tab).
- **Layout:** white header group (0–122): `.ttl` + search (focused look); body on `--bg` (`padding:14px 14px 0`): category
  card (y 136, 3 rows of 59.6), popular card (y 335, `.sh` + 3 rows); footer; bottom menu with Help active.
- **Copy:** «راهنما» · placeholder «سؤالتان را بنویسید…» · counts «۵ مقاله» (= `{n} مقاله`) · «پربازدیدترین‌ها». Categories and
  article titles are KB data.
- **Data:** `vm.categories` (name, icon (new), article count (new)), popular articles (`vm.articles`), `vm.query`.
- **States and interactions:** search (§4.6), category row (category list screen not drawn; **Suggestion:** reuse the
  09·12 header with a `.cd` of `.li` rows), article row → `[data-kb-action=open][data-kb-slug]`. Results and empty states
  are not drawn (**Suggestion:** results as `.li` rows in a `.cd`; empty = `.kb-empty` with the new tokens).
- **Production:** `kbHtml` list state (PD:1431-1463): header identity → `.ttl`; compose `kbSearchBarHtml`; render
  categories (ignored today) and the `kbHomeHtml` rows in the popular card.

### 5.22 Article · 09·12

- **Purpose:** reading one article.
- **Layout:** header (back · category / count · close, no avatar); `.art` (68–556): title, meta, paragraphs, h2, steps, tip;
  rating bar `.fb` (556–609); ask card (619–688); footer.
- **Copy:** «این مقاله مفید بود؟» · «بله» · «نه» · «هنوز سؤال دارید؟» · «با تیم پشتیبانی گفتگو کنید»; meta pattern
  «سارا · ۲ دقیقه مطالعه · به‌روز شده ۳ روز پیش» (author · reading time · updated). Title, body, «سفارش و ارسال», «۵ مقاله» are
  KB data.
- **Data:** `vm.article` (title, `contentHtml`), category name and count, author, reading time, updated date (new; hide
  when missing), `vm.feedback`.
- **States and interactions:** rate (`[data-kb-rate]`, `aria-pressed`), ask card → `[data-kb-action=switch-chat]`; back
  `data-view-back=back` with fallback home.
- **Production:** `.wy-head-article` (back + avatar + article title) → category header, the article title moves into the
  body as `h1`; KB HTML styled as §4.21.

### 5.23 Launcher and greeting · 10 (+ state: open)

- **Purpose:** the launcher kit with all its motion, the custom-colour variant and the greeting bubble on a host page.
- **Tiles (board chrome around real launchers):** «ورود» (entrance) 620ms; «هاور» (hover) 3px up, 106%, dots wave, 220ms;
  «پشتیبان در حال نوشتن» (agent typing) dots 1.3s; «جلب توجه» (attention) ring twice, 6s after the entrance; «باز و بسته»
  (open and close) the launcher drops while the widget is open and returns on close (miniature, §6); «پیام خوانده‌نشده»
  (unread message) saffron badge with a Persian number and a small shake; «آفلاین» (offline) ink `#12141F` ground,
  turquoise bubble; «کاهش حرکت» (reduced motion) nothing moves, fades only. Custom colours row: plain
  colour, no gradient (§4.23).
- **Greeting:** host page (board chrome) with the greeting bubble over the launcher and badge «۱» (§4.25).
- **Script (demo):** replays every 5000ms; toggles the open/close tile every 2600ms; `wy-kit-closing` 700ms. The state
  screenshot shows the open/close tile open.
- **Production:** kit unchanged (§4.23); greeting = smart nudge (§4.25).

### 5.24 Launcher and colour settings · 11 (+ state: closed)

- **Purpose:** the admin settings for the launcher and colour, with a live preview (settings UI is board chrome; the
  preview widget is drawn at 380 × 710, the real panel is 400 × 720).

| # | Setting | Options (default first) | Config |
|---|---|---|---|
| ۱ | «دکمه شناور» (floating button) launcher style | «وب‌یار اصلی», «وب‌یار مربعی», «حباب کلاسیک», «دو حباب», «هدست پشتیبانی», «چهره اپراتور», «کپسول با متن» (meanings in §4.24) | `fab.shape` `circle` (kit) or `square` (WebYar square), new `pill`; `fab.icon` `chat` (kit) or `headset` (exist), new `bubble`, `duo`, `avatar` (agent face); pill text via `fab.label` |
| ۲ | «رنگ» (colour) | «فیروزه‌ای وب‌یار» (WebYar turquoise) `#0B7D6C` (swatch = kit gradient), «آبی» (blue) `#2563EB`, «نیلی» (indigo) `#4F46E5`, «بنفش» (violet) `#7C3AED`, «صورتی» (pink) `#DB2777`, «نارنجی» (orange) `#D9480F`, «سبز» (green) `#15803D`, «مشکی» (black) `#111827` | `primaryColor` (brief lists 6 presets without indigo and green) |
| ۳ | «جایگاه» (position) | «پایین راست» (bottom right), «پایین چپ» (bottom left) | `position` (exists) |
| ۴ | «منوی پایین» (bottom menu) | «آیکون + نوشته فعال» (icons + active label, default), «آیکون و نوشته» (icons and labels), «فقط آیکون» (icons only), «فقط نوشته» (labels only), «بدون منو» (no menu) | `navMode` (new) |

- **Note under the settings (spec):** the chosen colour also applies to the header, buttons, visitor bubbles, bottom menu
  and focus ring, and the greys take a tint of it; motion is off for users with reduced motion. Bar style (`navStyle`) is
  not in this board (board 02).
- **Preview behaviour:** tapping the launcher opens the widget; the launcher drops and stays hidden; the widget's close
  button brings it back up (§6). Closed state: only the launcher, bottom-right.

### 5.25 Mobile home · 12·14

- **Purpose:** home on a phone (full-screen sheet).
- **Layout:** as 01·02 with §2.3 sizes: hero 276 (padding 22/20/86, grab handle, close 44, question 29px), cards from y 220
  (CTA 52 tall r 16 16px; search 48), 4 article rows of 50, footer at y 714, bar 64 + 34 bottom space.
- **Copy and data:** as 01·02. Board text: touch targets 44px or more, 15px text, a safe gap under the bottom bar.
- **Production:** `.shell.gs-mobile-open .panel` (§2.3).

### 5.26 Mobile conversation · 12·15

- **Purpose:** a conversation on a phone.
- **Layout:** header 76 (padding 22/10/10; back 44, avatar 44, name 16px, subtitle 12.5px, close 44; no ⋯); thread 610 with
  day divider «امروز»; composer 98 (box 90: textarea 15px, icons 22 in 44 buttons, `.ra` 46); footer 32; home bar (device
  chrome).
- **Copy and data:** as 04·04 (thread content is demo).
- **Production:** `.shell.gs-mobile-open .panel` (§2.3).

### 5.27 Tokens · 13

Transcribed in §3: colour swatches with their Persian names («برند» brand `--a`, «روشن ۹۲٪» light 92% `--a-hi`, «حلقه ۱۹٪»
ring 19% `--a-3`, «ته‌رنگ ۱۰٪» tint 10% `--a-2`, «محو ۵٪» faint 5% `--a-1`, «متن روی ته‌رنگ» text on tint `--a-ink`, «متن» text
`--ink`, «متن دوم» secondary text `--ink-2`, «کم‌رنگ» muted `--ink-3`, «حباب اپراتور» operator bubble `--op`, «زمینه»
background `--bg`, «آنلاین» online `#12A150`, «نشان» badge `#FFB423`), type scale, radii, shadows, icons, motion table.

---

## 6. Motion

All values from widget.css, the board `<style>` blocks and scripts. Production values in brackets where they change.

| Interaction | Element | Property | Duration | Easing | Delay | Keyframes / values |
|---|---|---|---|---|---|---|
| Panel open | `.panel` | opacity, transform | 380ms | `cubic-bezier(.22,1,.36,1)` | 0 (opened from the launcher: .2s, after the launcher drops) | from `translateY(14px) scale(.96)` (token sheet) [production 16px / .97, .3s]. Board 11 preview uses `.4s cubic-bezier(.2,.9,.25,1)` from `translateY(36px) scale(.9)` |
| Panel close | `.panel` | opacity / transform | .2s / .26s | `ease` / `cubic-bezier(.55,0,.75,.2)` | 0 | to `translateY(36px) scale(.9)` (board 11; not on the token sheet) |
| Home entrance | hero texts | opacity, transform | 420ms | `cubic-bezier(.22,1,.36,1)` | .04s (from launcher .24s) | `rise`: from opacity 0, `translateY(10px)` |
| Home entrance | cards 1, 2 | same | 420ms | same | .08s, .14s (from launcher .28s, .34s): 60ms stagger | `rise` |
| Launcher hides on open | launcher | transform, visibility | .26s | `cubic-bezier(.55,0,.75,.2)` | 0 | drops below the edge, hidden at .26s [production .28s `cubic-bezier(.22,1,.36,1)` by `--gs-fab-exit`] |
| Launcher returns on close | launcher | transform | .44s | `cubic-bezier(.3,1.35,.5,1)` | .2s | back to rest [production 280ms WAAPI] |
| Launcher entrance (kit) | button / body / dots | transform, opacity | .62s / .5s / .32s | `cubic-bezier(.2,1.25,.4,1)` / `(.2,1.2,.4,1)` / `(.3,1.45,.5,1)` | 0 / .12s / .45, .65, .85s | from `translateY(18px) scale(.6)`, body `scale(.7)`, dots `scale(.4)`; class removed after 1400ms (unchanged) |
| Launcher hover (kit) | button / dots | transform, shadow / transform | .22s / .62s | `cubic-bezier(.2,.8,.2,1)` / ease-in-out | 0 / 0, .08, .16s | `translateY(-3px) scale(1.06)`; dots `translateY(-2.5px)` at 35% |
| Launcher typing (kit) | dots | transform, opacity | 1.3s infinite | ease-in-out | 0, .16, .32s | 25%: `translateY(-2.5px)`, opacity 1; 0/60/100%: opacity .55 |
| Launcher ping (kit) | ring | transform, opacity | 1.8s × 2 | `cubic-bezier(.2,.6,.3,1)` | 6s after entrance | scale 1 → 1.75, opacity .6 → 0; cleared after 3.8s |
| Launcher open/close glyphs (kit) | chat / chevron | transform, opacity | .2s / .26s | `cubic-bezier(.4,0,1,1)` / `cubic-bezier(.2,.9,.3,1.2)` | 0 / .06s | chat → `rotate(-35deg) scale(.3)`; chevron from `rotate(45deg) scale(.6)`; closing dots .26s at .12, .2, .28s; `wy-kit-closing` 700ms |
| Unread badge (kit) | badge / button | transform | .45s / .6s | `cubic-bezier(.3,1.6,.5,1)` / ease-in-out | 0 | scale 0 → 1.18 (60%) → 1; wiggle −10° (20%), 8° (45%), −4° (70%) |
| Greeting bubble in/out | `.smart-nudge` | — | not specified | — | — | keep production `gs-smart-in` .38s / `gs-smart-out` .24s |
| View change | `.wy-view` | opacity | not specified | — | — | keep production fade .26s; skeleton crossfade 150ms |
| Message entrance | `.msg-row` | — | not specified | — | — | keep production `wy-msg-in` .24s |
| Typing bubble | `.typ i` | opacity, transform | 1.3s infinite | ease-in-out | 0, .16, .32s | `wy-typ`: 0/60/100% opacity .45 `rotate(45deg)`; 25% opacity 1 `translateY(-3px) rotate(45deg)` |
| Mic ↔ send swap | `.ra` icon | opacity, rotate | 180ms | ease-out | 0 | fade and rotate 90° |
| Round button | `.ra` | transform, background | .2s | `var(--ease)` | 0 | hover `scale(1.06)`, active `scale(.94)` |
| Primary button | `.btn` | transform / filter, shadow, bg | .16s / .2s | `var(--ease)` / ease | 0 | hover `translateY(-1px)` + `brightness(1.06)`; active `brightness(.97)` |
| Card link hover | `a.cd` | transform, shadow | .2s | `var(--ease)` | 0 | `translateY(-1px)` |
| List row hover | `.li` / `.ch` | background / transform, colour | .15s / .2s | — / `var(--ease)` | 0 | chevron `translateX(-3px)` RTL |
| Tab | `.tab` / `.tic` | color, background-color, box-shadow / transform | .2s, .25s, .25s / .2s | ease / `var(--ease)` | 0 | press: icon `scale(.9)` |
| Inputs, composer focus | `.inp` / `.cbox` | box-shadow | .15s / .2s | ease | 0 | |
| Recording dot | `.rdot` | box-shadow | 1.4s infinite | ease | 0 | `wy-pulse`: 0% `0 0 0 0 color-mix(in oklab,var(--rec) 45%,transparent)`; 70% `0 0 0 7px transparent`; 100% none |
| Live wave | last 6 bars of `.wv.rt` | transform | .9s infinite alternate | ease-in-out | 2nd-last .15s, 4th-last .3s | `wy-lv`: `scaleY(.55)` → `scaleY(1)` |
| Emoji picker open | `.epk` | height 0 → 246, padding, margin / opacity | .3s / .22s | `var(--ease)` / ease | 0 / .05s | |
| Emoji picker close | `.epk` | height, padding, margin / opacity | .2s / .12s | `cubic-bezier(.4,0,.6,1)` / ease | 0 | |
| Emoji picker content | search + tabs / rows 1–4 | opacity, transform | .3s / .34s | `var(--ease)` | .05s / .08, .11, .14, .17s | `ep-in`: from opacity 0, `translateY(10px)` |
| Emoji button open | icon | transform | .28s | `var(--ease)` | 0 | `rotate(-14deg) scale(1.06)` |
| Emoji cell | `.ep-e` | transform / background | .16s / .12s | `var(--ease)` | 0 | hover `scale(1.14)`; `.hit` 420ms |
| Skeleton | `.sk i` | background-position | 1.4s infinite | linear | 0 | `wy-sh`: `200% 0` → `-200% 0` |
| Settings previews only (board 11) | new launcher styles | transform, box-shadow | 3s / 3.2s / 3.6s / 2.4s / 1.3s | ease-in-out / ease-out | dots .08, .16s | dots `idle-wave` (10%: `translateY(-2.5px)`); two bubbles `duo-b`/`duo-f` (±1px at 50%); headset `tilt` (72% −10°, 80% 8°, 88% −3°, origin 50% 40%); agent dot `onp` (0 → 7px ring `rgba(18,161,80,.45)`); typing chip `td`. Entrance of every style = kit entrance |

**Reduced motion** (`prefers-reduced-motion: reduce`, widget.css:439-441): every animation off and every transition
replaced by `opacity .15s ease` (the board applies it to `.cv *`; apply it to the widget root). The launcher kit already
removes animations and swaps glyphs with a .15s fade. Keep production's existing opt-outs (production §8.8).

---

## 7. Direction, language and numbers

- **Direction:** the widget is `dir="rtl"` (`fa`). Layout mirrors through logical properties (`inset-inline-*`,
  `margin-inline-*`, `padding-inline`). Explicit `[dir=ltr]` rules in widget.css: hero highlight position, list chevron
  hover direction, message group alignment; `[dir=rtl]` rules: send icon flip (`.pl`), group alignment, avatar order.
- **Stays physical:** panel and launcher anchoring (bottom-right / bottom-left by `position`); message sides (operator
  left, visitor right) and their joined corners (left corners for operators, right for visitors); the `.va` diamond centre;
  the file bubble padding (`10px 10px 10px 12px`).
- **Icons:** the send plane mirrors in RTL; list and more chevrons are drawn pointing left and the back chevron pointing
  right (RTL forms, no flip in the boards). Production flips `.wy-back svg`, `.home-link-chevron svg` and
  `.kb-article-chevron svg` with `scaleX(-1)` under `[dir='rtl']` (CSS:282, 529, 1773), so with those rules keep
  production's source orientation (back `M15 18l-6-6 6-6`, chevron `M9 18l6-6-6-6`) or remove the flips and use the
  design paths; never both. Play, mic, emoji, attach, search, close, download, thumbs and ticks never mirror.
- **Voice timelines (decided, [brief §7a](../../CLAUDE_CODE_BRIEF.md)):** the design lays out the voice bubble and the
  preview bar right to left (play at the right, progress filling from the right, time at the left). Production forces
  `dir="ltr"` on `.msg-att-audio` and `.vn-bar` (PD:295, PD:1083-1090) and Core's seek and progress widths assume a
  left-anchored track. Build it this way: keep the controls where the design puts them (play at the inline-start = right,
  time at the inline-end = left), but keep the track itself (`[data-audio-seek]`, `[data-vn-seek]`) `dir="ltr"`, so
  progress fills from the left. Move the forced `dir="ltr"` from the whole player to the track. This is the one accepted
  difference from the 04·05 and 05·2 screenshots.
- **Mixed content:** Latin fragments go in an LTR isolate (`.ltr` / `.code`: `direction:ltr; unicode-bidi:isolate`):
  tracking codes, e-mails (08·b bubbles, 08·c summary), image file names. The PDF name in 04·05 is not isolated, so its
  `pdf.` extension is drawn at the left end before the Persian name: isolate file names in production. Message text keeps
  `unicode-bidi:plaintext`.
  Inputs for e-mail and phone are `dir=ltr` with `text-align:right`. The «+۹۸» prefix has `direction:ltr` on the element
  itself, which flips its logical properties: the divider (`border-inline-end`) ends up on the outer right edge and the
  9px margin on the left (visible in 08·b). **Suggestion:** isolate only the text so the divider sits between prefix and
  number; confirm with the designer since the PNG shows the flipped side.
- **Digits:** Persian digits for every number the UI prints: times (`۱۹:۴۲`), durations (`۰:۱۴`, `۰:۰۸`), counts and badges
  (`۲`, `۵ مقاله`), sizes with Persian units and decimal separator `٫` (`۱٫۲ مگابایت`), step numbers, «مرحله ۳ از ۳», queue
  numbers, «+۹۸», speed «۱×», phone placeholders (`۰۹۱۲ ۳۴۵ ۶۷۸۹`). Production still prints Latin digits for file sizes,
  audio and recorder timers and the loader's `{n}` (production §7): extend `fmtNum`. Latin stays Latin: «Esc», «Enter»,
  «PDF», e-mails, URLs, codes.
- **Separator:** « · » (U+00B7 with spaces). Next to a Persian digit it can read as «۰» (e.g. 09·12 meta); keep the spaces.
- **Fonts by direction:** Vazirmatn for all text in both directions (Respok's LTR rules are in its own README).
- **ZWNJ:** keep zero-width non-joiners in copy (`می‌توانیم`, `پیام‌ها`, `وب‌یار`).

---

## 8. Accessibility

- **Focus:** the design draws focus only for inputs (`.inp.fo`, `.sr.fo`, `.cbox.fo`: 1.5px accent + 4–5px `--a-3`
  halo). Every button, tab and link keeps production's `:focus-visible` ring `2px solid var(--gs-primary)` (brief §7).
  **Suggestion:** a white ring for controls on the hero and on the `vd` bar, where an accent ring is invisible.
- **Landmarks and state:** bottom menu `nav` with `aria-label` «بخش‌های ویجت»; active tab `aria-current="page"`; every
  tab keeps an `aria-label` (needed in icons-only mode): «خانه», «پیام‌ها» or «پیام‌ها، ۲ خوانده‌نشده», «راهنما».
- **Labels in the board markup:** close «بستن»; back «بازگشت»; more «گزینه‌های بیشتر»; emoji «ایموجی» (04, 07, 08, 12) or
  «شکلک‌ها» / «بستن شکلک‌ها» with `aria-expanded` (06; the registry fixes «شکلک‌ها» for all boards, §10); attach «پیوست»; mic «ضبط پیام صوتی»; send «ارسال»;
  textarea «پیام»; search «جستجو در راهنما»; ticks `role="img"` «خوانده شد» / «تحویل شد»; typing «در حال نوشتن»; play
  voice «پخش پیام صوتی»; download «دانلود فاکتور» (= download + file name); remove file «حذف پیوست»; cancel recording
  «لغو ضبط»; stop «توقف ضبط»; send voice «ارسال پیام صوتی»; delete recording «حذف ضبط»; play preview «پخش — ۵ از ۱۴ ثانیه»;
  speed «سرعت پخش»; emoji picker `role="dialog"` «انتخاب شکلک», search «جستجوی شکلک», tabs `role="tablist"`
  «دسته‌های شکلک» with `role="tab"` + `aria-selected`; e-mail card `<form aria-label>` «ایمیل برای پاسخ», submit «ثبت ایمیل»;
  form card «مشخصات تماس»; step input «شماره موبایل», step submit «ثبت» (`disabled`); summary «مشخصات ثبت‌شده»; skeleton
  «در حال بارگذاری» (first row; the second `aria-hidden`); greeting close «بستن اعلان»; launcher «باز کردن گفتگو»,
  «۳ پیام خوانده‌نشده», «پشتیبان در حال نوشتن», «گفتگو — آفلاین». Production's existing labels and live regions stay
  (production §8.5); the board's `aria-live="polite"` on the recording timer is replaced by production's
  `[data-rec-timer][role=timer]` + `[data-rec-sr][role=status]`.
- **Keyboard:** emoji picker keyboard model not specified (**Suggestion:** arrow keys in the grid, Esc closes and returns
  focus to the emoji button). Recording hint promises Esc = cancel, Enter = send.
- **Contrast (default accent, WCAG):** `--ink` on white 18.8; `--ink-2` 9.0; `--ink-3` 5.2 on white, 4.6 on `--bg`, 4.3 on
  `--op` (11px meta in operator context stays on white); placeholder `#7A808C` 4.0; `--a-ink` on `--a-2` 6.8; white on the
  accent 5.0, on `--a-hi` 4.3 (gradient top); tab badge 10.3; open tag 5.8; `--bad` on white 4.7. Hero: the 27px/700
  question is large text (3:1 needed; white on the mid stop `#0F927D` 3.9); the 17px/500 greeting at 88% white reaches only
  2.2–3.4 on the light part of the brand gradient (design choice; flag for review). Chevrons `--ink-4` 2.4 (decorative,
  next to text).
- **Touch targets:** mobile enlarges icon buttons to 44 and the round button to 46; tabs are 115 × 52. Not enlarged in
  the design: pending-file remove 26 × 26, speed button 24 tall, `.more` 30 tall, «رد کردن», «تلاش دوباره», «ویرایش»
  text links. **Suggestion:** extend their hit area to 44px with padding or a pseudo-element.

---

## 9. New versus production

Canonical names for every hook, setting, view-model field and i18n key below (one name per concept, shared by
both brands and both templates): [`../../shared/new-hooks-and-settings.md`](../../shared/new-hooks-and-settings.md).

| Addition | Where | UI spec summary | Core / server / settings must provide | Suggested hook or config key | If unavailable |
|---|---|---|---|---|---|
| Bottom menu with unread badge | 01, 03, 07·13, 09·10, 11, 12 | §4.10 | navigation to `home` via `data-view`; total unread | `data-view="home"`; settings `navStyle` (`va`/`vb`/`vc`/`vd`, default `vb`), `navMode` (default `active`: icons + active label) | none: the menu is template-only once `data-view=home` works |
| Label modes incl. no menu | 03 | §4.10 | setting (super-admin) | `navMode`: `both`, `active`, `icon`, `text`, `none` (default `active`) | default mode |
| Help search on home and in help | 01, 09·10, 12·14 | §4.6 | KB search query → results view | `data-kb-search` on `kbSearchBarHtml` input | hide the field |
| Recent conversation card with agent | 01·03 | §5.2 | per conversation: agent name, agent online, store name | VM `conversations[].operatorName`, `.operatorOnline` | `title` + store initial, no presence dot |
| Returning greeting with name | 01·03 | «سلام دوباره، علی» | visitor name (identify / contact) | new key `homeGreetingBack` `{name}` | default greeting |
| Offline: next reply time and note | 01·08, 07·09 | §5.3, §5.16 | business hours / next opening; typical reply time | `availability.nextOpenAt`; new keys | `homeReplySlow`; hide the banner sub-line |
| Agent identity + presence in the chat header | 04, 05, 06, 08, 12·15 | §5.6 | assigned agent name, presence | visible `.pr` next to the sr-only `[data-presence]` | store avatar + workspace name (production) |
| More options (⋯) in the chat header | 04·04/05, 06 | `.ib` | a menu to show | none (behaviour not specified) | hide |
| Visible typing bubble | 04·04 | §4.14 | `setOperatorTyping` + agent name | `view.operatorTyping` → `.typing-row` | sr-only only (production) |
| Operator name above runs, initial avatars | 04, 05, 06, 12·15 | §4.13 | sender name per message | renderer: first-of-run name, initial tiles | name hidden; spacer only |
| Link preview card | 04·04 | §4.13 | optional unfurl title | — | link text + hostname |
| Inline code chip | 04·04, 06, 12·15 | §4.13 | code detection | backtick rule in Core | plain text, LTR isolate |
| Image caption, Persian sizes | 04·05 | §4.15 | attachment name and size | — | caption hidden |
| Voice waveform, Persian timers, controls in RTL order | 04·05, 05·2 | §4.15, §4.18, §7 | none: the track stays LTR (brief §7a) | `dir="ltr"` on the track only | production LTR player restyled |
| Send while recording + hint | 05·1 | §4.18 | stop-and-send, Esc/Enter keys, 2-minute cap | `data-rec-send` | hide the send button and the hint parts not supported |
| Preview progress ring + speed | 05·2 | §4.18 | playback position, rate control | `data-vn-rate` (new) | ring = static `--a-3`; hide speed |
| One mic/send slot | 04–08, 12·15 | §4.16 | none (CSS on `.has-draft`) | — | — |
| Emoji picker in the box, categories, search | 06 | §4.17 | emoji data with categories and names | Core fills `[data-emoji-picker]` with groups | 8-column grid of Core's 50 items, no search/tabs |
| New-conversation welcome block | 04·06 | §4.20 | team members, workspace name, reply time | renderer (`emptyHtml`) | welcome bubble only |
| Topic chips | 04·06 | §4.5 | topics list; send the choice | `.qna-chip[data-qna-question]` or `data-topic` | no chips |
| Pre-chat intro, optional suffix, privacy note | 07·07 | §4.19, §5.15 | strings | new keys | production subtitle |
| Offline chat with inline e-mail capture | 07·09 | §5.16 | accept messages offline; automated reply; fallback submit with the thread message | `data-fb=email`, `data-fb-submit`, `data-fb-status` inside `.ec` | production contact-fallback view, restyled |
| Messages list CTA, status tags, «شما:» prefix | 07·13 | §5.17 | last-sender flag | — | no prefix |
| Handoff card in an operator row + locked composer | 08·a | §5.18 | composer lock while pending | `.input-bar.is-locked` | production card in a visitor row |
| Step-by-step pre-chat | 08·b | §5.19 | step flow, validation, skip, country code | new Core mode | form card (08·a) |
| Summary card after submit | 08·c | §4.20 | submitted values; edit action | `data-prechat-edit` | no summary |
| Queue position pill | 08·c | §4.20 | position and wait time in `routing_in_queue` | `routingInQueue` + `{n}`/`{min}` | production queue text |
| Help categories, popular, counts | 09·10 | §5.21 | categories with icons and counts; popular list | VM `categories[]` icon, count | flat article list in one card |
| Article meta, category header, steps, tip, ask card | 09·12 | §4.21 | author, reading time, updated date, category | — | hide meta; header shows the article title |
| Launcher styles | 11 | §4.24 | settings | `fab.shape` (`square` 18px; new `pill`), `fab.icon` (new `bubble`, `duo`, `avatar`; `headset` exists), `fab.label` (pill text) | kit |
| Custom-accent launcher shadow | 10 | §4.23 | none | — | production shadow |
| Greeting bubble look | 10 | §4.25 | smart rule: agent, two CTAs | `data-smart-cta` ×2 (index) | one CTA, no avatar |
| Colour presets | 11 | 8 swatches | settings UI | `primaryColor` | any hex works |

---

## 10. Copy deck

UI strings as designed (verbatim, ZWNJ kept). "Key" = production i18n key (production map §7) when one exists. "Current"
values are today's Persian strings as seen in captures of the production widget (production map `[snap]`) or in
`LOADER_STRINGS` (LD:851-897); "verify value" = key exists but its Persian value was not visible. Demo content is listed
at the end.

| UI string | Where | Meaning | Key |
|---|---|---|---|
| خانه | tab, tab `aria-label` | Home | new: `navHome` |
| پیام‌ها | tab; Messages title | Messages | new: `navMessages`; Messages title `wyConversations` (current «گفتگوها»; update) |
| راهنما | tab; Help title | Help | `help` (verify its fa value) |
| بخش‌های ویجت | nav `aria-label` | Widget sections | new: `navLabel` |
| پیام‌ها، ۲ خوانده‌نشده | Messages tab `aria-label` | Messages, 2 unread | new: `navMessagesUnread` `{n}` |
| همه گفتگوها | home link, no-menu mode | All conversations | `wyViewConversations` (current «مشاهده گفتگوها»; update) |
| بستن | close buttons | Close | `close` |
| بازگشت | back buttons | Back | `back` |
| گزینه‌های بیشتر | chat header ⋯ | More options | new: `moreOptions` |
| سلام، خوش آمدید | hero greeting | Hello, welcome | `homeGreeting` (current: «سلام» + waving-hand emoji; update) |
| سلام دوباره، علی | hero greeting, returning | Hello again, {name} | new: `homeGreetingBack` `{name}` |
| چطور می‌توانیم کمکتان کنیم؟ | hero question | How can we help you? | `homeWelcome` / `welcomeMessage` (current: «سلام» + waving-hand emoji + «چطور می‌تونیم کمکتون کنیم؟») |
| گفتگو با تیم پشتیبانی | team card title | Chat with the support team | new: `homeTeamTitle` (`wyTalkToSupport` is the KB CTA today; verify its value) |
| آنلاین · پاسخ در چند دقیقه | team card, chat header | Online · reply in a few minutes | new: `statusOnline` «آنلاین» + `replyShort`, or `replyTimeText` |
| پاسخ در چند دقیقه | CTA card | Reply in a few minutes | new: `replyShort` |
| شروع گفتگو | home CTA, pre-chat submits | Start a conversation | `homeStartChat` |
| جستجو در راهنما | home search placeholder and `aria-label` | Search the help center | `searchKb` (verify value) |
| پیام اخیر | recent card caption | Recent message | `wyRecentConversations` (current «گفتگوهای اخیر»; update) |
| ارسال پیام جدید | CTA card, Messages CTA | Send a new message | `wyStartNew` (current «گفتگوی جدید»; update) |
| الان آفلاین هستیم | offline team card | We are offline right now | new: `homeAwayTitle` |
| از ساعت ۹ صبح پاسخ می‌دهیم | offline status | We reply from 9 am | new: `homeBackAt` `{time}`; fallback `homeReplySlow` |
| پیامتان را بگذارید؛ پاسخ را به ایمیلتان می‌فرستیم و همین‌جا هم می‌بینید. | offline note | Leave your message; we e-mail the reply and you also see it here | new: `homeAwayNote` |
| پیغام بگذارید | offline CTA | Leave a message | `homeLeaveMessage` |
| جوابتان شاید در راهنما باشد | offline search placeholder | Your answer may be in the help center | new: `searchKbAway` |
| قدرت گرفته از · وب‌یار | footer | Powered by · WebYar | `poweredBy` + platform name |
| پیام خود را بنویسید… | composer placeholder | Write your message… | `typeMsg` (current «پیام خود را بنویسید...» with three dots; use «…») |
| پیام | textarea `aria-label` | Message | new: `messageLabel` |
| ایموجی | emoji button (04, 07, 08, 12) | Emoji | `emojiPicker` (current «شکلک»); final wording in [the registry](../../shared/new-hooks-and-settings.md) §4.13: «شکلک‌ها» |
| شکلک‌ها | emoji button (06) | Emojis | `emojiPicker`: the boards disagree; final wording in [the registry](../../shared/new-hooks-and-settings.md) §4.13: «شکلک‌ها» |
| بستن شکلک‌ها | emoji button when open | Close emojis | new: `emojiPickerClose` |
| پیوست | attach button | Attach | `attachFile` (current «پیوست فایل») |
| ضبط پیام صوتی | mic button | Record a voice message | `recordVoice` |
| ارسال | send button | Send | `send` |
| در حال نوشتن | typing bubble `aria-label` | Typing | new: `simpleTyping` |
| سارا در حال نوشتن… | typing meta | {name} is typing… | Core typing label (`[data-typing-label]`); new: `typingNamed` `{name}` |
| خوانده شد | read tick | Read | new: `msgRead` |
| تحویل شد | single tick | Delivered | new: `msgDelivered` |
| ارسال شد | offline meta | Sent | new: `msgSent` |
| ارسال نشد | failed meta | Not sent | `msgFailed` (verify value) |
| تلاش دوباره | retry link | Try again | `retry` (current «تلاش مجدد»; update or new) |
| دانلود فاکتور | file download `aria-label` | Download {file} | `download` + file name |
| پخش پیام صوتی | voice play `aria-label` | Play voice message | `playAudio` |
| حذف پیوست | pending file remove | Remove attachment | `remove` (current «حذف») |
| کیلوبایت / مگابایت | file sizes | KB / MB | new: `unitKB`, `unitMB` (production hard-codes `KB`/`MB`) |
| امروز | day divider | Today | hard-coded in the renderer (PD:545-547) |
| همین حالا | meta | Just now | new: `timeJustNow` |
| گفتگوی جدید | new-conversation header | New conversation | `wyNewConversation` |
| تیم پشتیبانی فروشگاه نیلوفر | welcome block | Support team of {workspace} | new: `wyTeamOf` `{workspace}` |
| معمولاً در چند دقیقه پاسخ می‌دهیم | welcome block | We usually reply in a few minutes | `homeReplyFast` (same value today) |
| لغو ضبط | recorder cancel | Cancel recording | `cancelRecording` (current «لغو») |
| توقف ضبط | recorder stop | Stop recording | `stopRecording` |
| ارسال پیام صوتی | recorder / preview send | Send voice message | new: `sendVoice` |
| Esc لغو · Enter ارسال · حداکثر ۲ دقیقه | recorder hint | Esc cancel · Enter send · max 2 minutes | new: `recHint` `{max}` |
| حذف ضبط | preview delete | Delete recording | new: `deleteRecording` |
| پخش — ۵ از ۱۴ ثانیه | preview play `aria-label` | Play — 5 of 14 seconds | new: `playAudioProgress` `{pos}` `{total}` |
| سرعت پخش | speed button | Playback speed | new: `playbackRate` |
| ۱× | speed button | 1× | hard-coded `1×` (Persian digit) |
| انتخاب شکلک | picker dialog `aria-label` | Choose an emoji | new: `emojiDialog` |
| جستجوی شکلک | picker search | Search emoji | new: `emojiSearch` |
| دسته‌های شکلک | category tablist `aria-label` | Emoji categories | new: `emojiCategories` |
| پرکاربرد · چهره‌ها · آدم‌ها و دست‌ها · قلب‌ها و نمادها · طبیعت · غذا و نوشیدنی | category tabs and headers | Frequent · Faces · People and hands · Hearts and symbols · Nature · Food and drink | new: `emojiCat*` |
| اتصال به پشتیبان | pre-chat header title | Connect to support | `wyConnectOperator` (current «اتصال به اپراتور») |
| قبل از شروع، خودتان را معرفی کنید | pre-chat intro title | Before starting, introduce yourself | new: `prechatIntroTitle` (the pre-chat view has no title today) |
| اگر از سایت رفتید، پاسخ را برایتان می‌فرستیم. | pre-chat intro text | If you leave the site, we send you the reply | `wyPrecontactDesc` → `prechatSubtitle` (PD:835; current «راه ارتباطی خود را وارد کنید تا اپراتور به گفتگو بپیوندد.») |
| نام · ایمیل | field labels | Name · E-mail | production labels (same) |
| شماره موبایل · موبایل | phone label (form · card) | Mobile number · Mobile | production phone label (current «شماره تلفن») |
| (اختیاری) | optional suffix | (optional) | new: `optional` |
| * | required mark | Required | `required` (`aria-label` «الزامی») |
| ایمیل کامل نیست؛ مثلاً name@example.com | e-mail error | E-mail is incomplete; e.g. name@example.com | Core validation text; new: `errEmailIncomplete` |
| ایمیل کامل نیست · مثلاً name@example.com | step-by-step error | same, split | new: `prechatStepEmailInvalid` + `prechatStepEmailExample` |
| name@example.com · ۰۹۱۲ ۳۴۵ ۶۷۸۹ | placeholders | — | `prechatEmailPh`, `prechatPhonePh` |
| اطلاعات شما فقط برای پاسخگویی استفاده می‌شود. | pre-chat privacy | Your details are only used to reply | new: `prechatPrivacy` |
| فقط برای پاسخگویی استفاده می‌شود | form card privacy | Only used to reply | new: `prechatPrivacyShort` |
| آفلاین · پاسخ از طریق ایمیل | offline chat header | Offline · reply by e-mail | new: `statusAwayEmail` |
| تیم ما الان آفلاین است | offline banner | Our team is offline now | new: `awayBannerTitle` |
| از ساعت ۹ صبح پاسخ می‌دهیم · معمولاً تا ۲ ساعت | offline banner | We reply from 9 am · usually within 2 hours | new: `awayBannerSub` `{time}` `{replyTime}` |
| پیامتون ثبت شد. ایمیلتون رو بگذارید تا پاسخ رو براتون بفرستیم. | automated reply | Your message is saved. Leave your e-mail so we can send the reply | new: `awayAutoReply` |
| ایمیل برای دریافت پاسخ | e-mail card label | E-mail to receive the reply | new: `fallbackEmailLabel` |
| ایمیل برای پاسخ · ثبت ایمیل | e-mail card form / submit `aria-label` | E-mail for the reply · Submit e-mail | new: `fallbackEmailFormLabel`; submit `saveEmail` |
| پیام خودکار | automated message meta | Automated message | new: `msgAutomated` |
| باز · حل شده | status tags | Open · Resolved | `wyStatusOpen`, `wyStatusResolved` (same values) |
| شما: | preview prefix | You: | `you` + «:» |
| در حال بارگذاری | skeleton `aria-label` | Loading | new: `loading` |
| سلام! خوش اومدید. قبل از شروع خودتون رو معرفی کنید تا اگه از سایت رفتید هم جواب‌تون برسه. | form-card intro bubble | Hi, welcome. Introduce yourself first so the reply reaches you even if you leave | the `.hc-subtitle` text (a parameter of `handoffPrechatCardHtml`, PD:798-816; supplied by Core) |
| مشخصات شما | form card title | Your details | `prechatTitle` (PD:810; verify value) |
| مشخصات تماس | form card `aria-label` | Contact details | today also `prechatTitle` (PD:809); new: `prechatCardLabel` |
| اول فرم بالا را تکمیل کنید | locked composer | Fill in the form above first | new: `composerLockedPrechat` |
| سلام! برای شروع، اسم‌تون چیه؟ | step 1 question | Hi! To start, what is your name? | new: `prechatAskName` |
| ممنون علی جان. ایمیل‌تون رو هم بنویسید تا جواب‌ها رو براتون بفرستیم. | step 2 question | Thanks {name}. Write your e-mail so we can send the replies | new: `prechatAskEmail` `{name}` |
| اگه بخواید شماره موبایل‌تون رو هم بدید تا پیامکی خبرتون کنیم. | step 3 question | If you like, give your mobile number so we can text you | new: `prechatAskPhone` |
| مرحله ۳ از ۳ · اختیاری | step progress | Step 3 of 3 · optional | new: `prechatStep` `{n}` `{total}` + `optional` |
| رد کردن | step skip | Skip | new: `skip` |
| +۹۸ | phone prefix | Iran country code | new (config) |
| ۹۱۲ ۳۴۵ ۶۷۸۹ | step phone placeholder | — | new: `prechatPhonePhLocal` |
| برای پیامک پیگیری | step hint | For follow-up texts | new: `prechatPhoneHint` |
| ثبت | step submit `aria-label` | Submit | new: `submit` |
| ثبت شد | accepted answer meta | Saved | new: `saved` |
| مشخصات شما ثبت شد | summary header | Your details were saved | new: `prechatSaved` |
| ویرایش | summary link | Edit | new: `edit` |
| مشخصات ثبت‌شده | summary `aria-label` | Saved details | new: `prechatSavedLabel` |
| ممنون علی! یکی از همکارهام تا چند دقیقه دیگه جواب می‌ده. سؤال‌تون رو بنویسید. | after-submit message | Thanks {name}! A colleague replies in a few minutes. Write your question | automated message: new `prechatThanks` `{name}` or workspace text |
| نفر ۲ در صف · حدود ۳ دقیقه | queue pill | 2nd in queue · about 3 minutes | `routingInQueue` + new `{n}`, `{min}` |
| سؤالتان را بنویسید… | help search placeholder | Write your question… | new: `searchKbHelp` |
| ۵ مقاله | category count | 5 articles | new: `kbArticleCount` `{n}` |
| پربازدیدترین‌ها | popular card | Most viewed | new: `kbPopular` |
| سارا · ۲ دقیقه مطالعه · به‌روز شده ۳ روز پیش | article meta | {author} · {n} min read · updated {time} | new: `kbReadTime`, `kbUpdated` |
| این مقاله مفید بود؟ | rating question | Was this article helpful? | `wyArticleHelpful` (current «آیا این مقاله مفید بود؟») |
| بله · نه | rating buttons | Yes · No | `wyHelpfulYes`, `wyHelpfulNo` (current «مفید بود», «مفید نبود») |
| هنوز سؤال دارید؟ | ask card title | Still have a question? | new: `kbStillQuestion` |
| با تیم پشتیبانی گفتگو کنید | ask card line | Chat with the support team | `wyTalkToSupport` → `kbSwitchToChat` (PD:1416; verify value) |
| باز کردن گفتگو | launcher `aria-label` | Open chat | `openChat` (LOADER_STRINGS, same value) |
| ۳ پیام خوانده‌نشده · ۱ پیام خوانده‌نشده | launcher `aria-label` with badge | {n} unread messages | `unreadMany` / `unreadOne` (same values; `{n}` needs Persian digits) |
| پشتیبان در حال نوشتن | launcher `aria-label` while typing | Agent is typing | new: `launcherTyping` |
| گفتگو — آفلاین | launcher `aria-label` offline | Chat — offline | new: `openChatAway` |
| بستن اعلان | greeting close | Dismiss notification | `dismiss` (current «بستن»); final wording in [the registry](../../shared/new-hooks-and-settings.md) §4.13: «بستن پیام» |
| فروشگاه نیلوفر · آنلاین | greeting subtitle | {workspace} · online | new: `{workspace}` + `statusOnline` |
| سؤالی دارید؟ بپرسید | pill launcher text | Have a question? Ask | default of `fab.label` for the pill style |

Settings labels (board 11, admin UI): see §5.24.

Demo content (do not ship): people and store names (سارا, مهدی, رضا, علی, علی رضایی, فروشگاه نیلوفر, ف/س/م/ر initials),
all message bodies, «TR-2290-5531», «۴۸۲۱۳», «post.ir», «پیگیری مرسوله», file names and sizes, times and relative times,
article titles, categories and bodies, topic chip texts, the greeting message and its quick replies («بله، کمک می‌خوام»,
«راهنمای سایز»), e-mail values, wave bar heights.

---

## 11. Acceptance checklist

In addition to [brief §10](../../CLAUDE_CODE_BRIEF.md):

- [ ] Every PNG in `screens/panels/` matches at 400 × 720 (mobile 390 × 844), DPR 2, with the demo data; boards 02 and 13
      checked against `screens/boards/`.
- [ ] Home: hero 244px tall with default copy, cards overlap it by 56px, footer pinned above the bottom menu; article rows
      4 / 3 / 2 per state.
- [ ] Brand default (accent empty, `#3B82F6` or `#0B7D6C`) uses the hand-tuned hero; any other accent uses the formula; all
      eight palette colours and a light custom accent keep readable text (`--on-a`).
- [ ] Bottom menu: four styles × five modes render as §4.10 (`vb` + default mode out of the box); badge shows Persian digits
      and is announced in the tab `aria-label`; hidden on chat, pre-chat, fallback and article.
- [ ] No-menu mode shows «همه گفتگوها» on home and back buttons on Messages and Help.
- [ ] Close button sits at the per-view positions of §4.1 and keeps `[data-panel-close]`.
- [ ] Message rows keep the production contract; operators left with initial avatars, visitors right; joined corners 6px;
      meta and ticks as §4.13; failed + retry works.
- [ ] Typing shows the visible bubble and still announces once to screen readers.
- [ ] Composer: one action slot swaps mic ↔ send with the 180ms rotate; focus ring; pending file row; recording and preview
      bars as §4.18; all production composer hooks present in the same DOM order.
- [ ] Emoji picker opens inside the composer box (246px, motion §6) and closes on the second tap.
- [ ] Button-type texts use the rendered sizes of §3.2 (chips 14/400, etc.) unless the designer confirms the declared ones.
- [ ] Persian digits in times, durations, counts, sizes, steps; Latin codes, e-mails and file names isolated LTR.
- [ ] Voice direction decision (§7) applied consistently to the bubble and the preview bar.
- [ ] Launcher kit unchanged; greeting bubble matches board 10; custom-accent launcher shadow as §4.23.
- [ ] Mobile: `.mob` sizes under `.shell.gs-mobile-open`, safe areas not double counted, grab handle only with swipe-to-close.
- [ ] Reduced motion: no transform animation anywhere in the template; opacity fades ≤ .15s.
