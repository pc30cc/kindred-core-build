# Respok chat widget · Template 1 "Classic" — implementation spec

This folder is the Respok build (International edition, respok.app) of Template 1 "Classic". Home is an Ink hero with
the Respok mark and white cards floating over it. Home, Messages and Help sit in a floating bottom dock. The
conversation uses grouped bubbles and a visible typing bubble, and its composer box has one round button that is the
mic or the send button. The widget speaks English, left to right; a Respok widget that runs in Persian mirrors the
same layout and switches to Vazirmatn (`.cv.rp[dir=rtl]`). Per [brief §3](../../CLAUDE_CODE_BRIEF.md) this design
becomes production template **`intl`**: `presentation-intl.css` as a skin over the restyled `default` renderer. The
boards are drawn with the shared Template 1 stylesheet `widget.css` plus the Respok skin `respok.css`; §3.8 lists every
rule the skin changes, which is exactly what `presentation-intl.css` must contain. Respok has two logo directions,
**Thread** and **Open**; the shipped default is `logoDirection: "thread"` ([brand sheet](../README.md)), and both are
built (§4.1). Board 00 is drawn in Thread only and board 10 in Open only; every other board has both renders (the
Thread files end in `--thread`, §0). The Thread renders are the default acceptance targets; the Open renders are the
targets for `logoDirection: "open"`.

Read with: [brief](../../CLAUDE_CODE_BRIEF.md) (global rules, frame, accent pipeline, fonts, acceptance),
[production map](../../shared/production-map.md) (cited below as "map §n"), [brand sheet](../README.md),
[`tokens.json`](tokens.json). Production files are cited as `public/widget/<file>` with the map's aliases
(PD = `presentation-default.js`, CSS = `presentation-default.css`, INTL = `presentation-intl.css`, LD = `loader.js`).

## 0. Files in this folder

| Path | What it is | How to use it |
|---|---|---|
| [`source/`](source/) `NN-name.dc.html` | The 13 board sources (Claude Design). Markup with `{{holes}}`, `<sc-if>`, `<sc-for>`; a `class Component` script at the bottom (`renderVals()`, state, timers); `data-props` JSON = board options (accent, `logo` = Open/Thread, `nav` = menu mode) | Exact markup, copy and SVG paths. Timings of the live boards (00, 05, 09, 10) |
| [`reference/`](reference/) `NN-name.html` | Static render of each board in its default state. `NN-name--thread.html` (01–09, 11, 12) is the same board in the Thread direction: only the root class differs (`lg-open` → `lg-thread`; in 09 `st-open` → `st-thread`, and the board's Open/Thread toggle and New message tile text follow). `--open`, `--picker-open`, `--closed` are interactive states (in 00 and 09 `--open` means the panel is open, not the Open direction) | Open from disk in Chrome; read computed values in DevTools (all numbers in §2 were measured there) |
| [`reference/css/widget.css`](reference/css/widget.css) | Template 1 base stylesheet, byte-identical to the WebYar Template 1 copy | Base look of `default` (restyled by the WebYar Template 1 work) |
| [`reference/css/respok.css`](reference/css/respok.css) | The Respok skin, scope `.cv.rp`, logo direction on the root (`.lg-open` / `.lg-thread`) | §3.8: the content of `presentation-intl.css` |
| [`reference/css/fonts.css`](reference/css/fonts.css), [`reference/fonts/`](reference/fonts/) | Figtree 400–800, DM Mono 400/500, Vazirmatn 400–700 | Fonts asset (brief §6); licences in [`../../shared/fonts/`](../../shared/fonts/) |
| [`screens/panels/`](screens/panels/) | Every widget screen at 2x, with a 24px margin of board background around the panel (a sliver of the screen label shows at the top). Each screen of 01–08 and 11 has two crops: `NN-name--<label>--thread.png` (Thread, 27 files) and `NN-name--<label>.png` (Open). The 00 crops are Thread only | **Acceptance targets.** Thread crops (and 00) = default target (`logoDirection:"thread"`); unsuffixed crops = target for `logoDirection:"open"`. Compare the panel area only |
| [`screens/boards/`](screens/boards/) | Whole boards at 1x with the designer's title and explanation: `NN-name--thread.png` (01–09, 11, 12) and `NN-name.png` (Open; 00 is Thread, 10 is Open only) | Context; for 09 and 12, which have no crops, the boards are the targets (Thread board = default) |
| [`screens/states/`](screens/states/) | Interactive boards in another state (panel open, picker open, preview closed), one direction each: 00 `--open` is Thread; 05, 09 and 10 states are Open | Acceptance targets for those states |
| [`tokens.json`](tokens.json) | Every token with its CSS expression and the value for the Ink accent, plus the Ink hero override | §3 |

Board chrome is not product UI; ignore it: board titles and descriptions (`.cv-t`, `.cv-d`, `.bh`, `.bt`), screen
labels (`.tag`), layout wrappers (`.cv-row`, `.cv-col`), the component spec card of 04/3 (`.spec`, `.sg`, `.sc`,
`.flow`; its statements are transcribed in §4.8 and §6), the fake host website (`.frm`, `.site`, `.sb`, `.sp` in 00;
`.host`, `.hbar`, `.hblk` in 09 and 10), the 09 controls (`.seg` Open/Thread, Replay button, `.tile`, the `.mf` mini
window), the 10 settings controls (`.pn`, `.opts`, `.sws`, `.seg`, `.nvo`; documented as settings in §4.29 and §5.15), the
token sheet layout of 12 (`.pnl`; its values are in §3), phone chrome (`.w.mob` 44px corners, `.safe` home-bar
strip), the canvas background `.cv.rp{background:#E8E7EE}`, and the emoji live-preview stand-ins (`<output class="ta">`
and the blinking `.caret` replace a real textarea).

## 1. Screen inventory

IDs are `board/label` (labels repeat across boards). The screenshot and reference columns list the **Thread** render
first (default acceptance target, `logoDirection:"thread"`) and then the **Open** render (target for
`logoDirection:"open"`); the two differ only in the brand elements of §4.1 (checked: the reference pages differ only in
the root class). Work: Restyle = production markup kept, new look; Restyle + markup = production view with markup
changes; New = no production counterpart.

| ID | Screen | Screenshot (2x): Thread · Open | Reference page: Thread · Open | Production view (map §) | Work |
|---|---|---|---|---|---|
| 00/02 | Home (board 00 copy) | Thread only: [00-overview-live--02-home](screens/panels/00-overview-live--02-home.png) | [00-overview-live](reference/00-overview-live.html) (Thread) | `homeHtml` (§4.1) | Restyle + markup |
| 00/04 | Conversation with typing (board 00 copy) | Thread only: [00-overview-live--04-conversation](screens/panels/00-overview-live--04-conversation.png) | [00-overview-live](reference/00-overview-live.html) (Thread) | `chatFrameHtml`, `messagesHtml` (§4.2, §5.1, §5.6, §5.7) | Restyle + markup |
| 00/05 | Open and close, live: launcher, reply card, panel | Thread only. Closed: [00-overview-live--05-open-and-close-live](screens/panels/00-overview-live--05-open-and-close-live.png); panel open: [00-overview-live--open](screens/states/00-overview-live--open.png) | [00-overview-live](reference/00-overview-live.html), [00-overview-live--open](reference/00-overview-live--open.html) (Thread) | Panel frame (§2), launcher (§3.1, §3.3), nudge (§5.11) | Restyle + New |
| 00/site | Fake host website | [00-overview-live--site-mock](screens/panels/00-overview-live--site-mock.png) | — | Board chrome, ignore | — |
| 01/02 | Home | [Thread](screens/panels/01-home--02-home--thread.png) · [Open](screens/panels/01-home--02-home.png) | [Thread](reference/01-home--thread.html) · [Open](reference/01-home.html) | `homeHtml` (§4.1) | Restyle + markup |
| 01/03 | Home with a recent chat | [Thread](screens/panels/01-home--03-home-with-a-recent-chat--thread.png) · [Open](screens/panels/01-home--03-home-with-a-recent-chat.png) | [Thread](reference/01-home--thread.html) · [Open](reference/01-home.html) | `homeHtml` + compact row (§4.1, §4.3) | Restyle + markup |
| 01/08 | Team away | [Thread](screens/panels/01-home--08-team-away--thread.png) · [Open](screens/panels/01-home--08-team-away.png) | [Thread](reference/01-home--thread.html) · [Open](reference/01-home.html) | `homeHtml` with `isOnline=false` (§4.1) | Restyle + markup |
| 02/A | Bottom menu: icons + labels | [Thread](screens/panels/02-bottom-menu-modes--a-icons-and-labels--thread.png) · [Open](screens/panels/02-bottom-menu-modes--a-icons-and-labels.png) | [Thread](reference/02-bottom-menu-modes--thread.html) · [Open](reference/02-bottom-menu-modes.html) | none (navigation `data-view`) | New |
| 02/B | Bottom menu: icons, active label (default) | [Thread](screens/panels/02-bottom-menu-modes--b-icons-active-label-default--thread.png) · [Open](screens/panels/02-bottom-menu-modes--b-icons-active-label-default.png) | [Thread](reference/02-bottom-menu-modes--thread.html) · [Open](reference/02-bottom-menu-modes.html) | none | New |
| 02/C | Bottom menu: icons only | [Thread](screens/panels/02-bottom-menu-modes--c-icons-only--thread.png) · [Open](screens/panels/02-bottom-menu-modes--c-icons-only.png) | [Thread](reference/02-bottom-menu-modes--thread.html) · [Open](reference/02-bottom-menu-modes.html) | none | New |
| 02/D | Bottom menu: labels only | [Thread](screens/panels/02-bottom-menu-modes--d-labels-only--thread.png) · [Open](screens/panels/02-bottom-menu-modes--d-labels-only.png) | [Thread](reference/02-bottom-menu-modes--thread.html) · [Open](reference/02-bottom-menu-modes.html) | none | New |
| 02/E | No menu | [Thread](screens/panels/02-bottom-menu-modes--e-no-menu--thread.png) · [Open](screens/panels/02-bottom-menu-modes--e-no-menu.png) | [Thread](reference/02-bottom-menu-modes--thread.html) · [Open](reference/02-bottom-menu-modes.html) | `homeHtml` `button.home-link[data-view=list]` (§4.1) | New |
| 03/04 | Thread and typing | [Thread](screens/panels/03-conversation--04-thread-and-typing--thread.png) · [Open](screens/panels/03-conversation--04-thread-and-typing.png) | [Thread](reference/03-conversation--thread.html) · [Open](reference/03-conversation.html) | §4.2, §5.1, §5.6, §5.7 | Restyle + markup |
| 03/05 | Attachments, errors and typing | [Thread](screens/panels/03-conversation--05-attachments-errors-and-typing--thread.png) · [Open](screens/panels/03-conversation--05-attachments-errors-and-typing.png) | [Thread](reference/03-conversation--thread.html) · [Open](reference/03-conversation.html) | §5.5, §5.1 (failed), §5.7 (`att-preview`) | Restyle + markup |
| 03/06 | New conversation and topics | [Thread](screens/panels/03-conversation--06-new-conversation-and-topics--thread.png) · [Open](screens/panels/03-conversation--06-new-conversation-and-topics.png) | [Thread](reference/03-conversation--thread.html) · [Open](reference/03-conversation.html) | `emptyHtml` (§4.2), Q&A chips (§5.12) | Restyle + markup |
| 04/1 | Recording | [Thread](screens/panels/04-voice-messages--1-recording--thread.png) · [Open](screens/panels/04-voice-messages--1-recording.png) | [Thread](reference/04-voice-messages--thread.html) · [Open](reference/04-voice-messages.html) | §5.7 `rec-bar` | Restyle + markup |
| 04/2 | Preview before sending | [Thread](screens/panels/04-voice-messages--2-preview-before-sending--thread.png) · [Open](screens/panels/04-voice-messages--2-preview-before-sending.png) | [Thread](reference/04-voice-messages--thread.html) · [Open](reference/04-voice-messages.html) | §5.7 `vn-bar` | Restyle + markup |
| 04/3 | Button states (spec card) | [Thread](screens/panels/04-voice-messages--3-button-states--thread.png) · [Open](screens/panels/04-voice-messages--3-button-states.png) | [Thread](reference/04-voice-messages--thread.html) · [Open](reference/04-voice-messages.html) | §5.7 mic and send buttons | Restyle |
| 05/1 | Tap the emoji icon | [Thread](screens/panels/05-emoji-in-composer--1-tap-the-emoji-icon--thread.png) · [Open](screens/panels/05-emoji-in-composer--1-tap-the-emoji-icon.png) | [Thread](reference/05-emoji-in-composer--thread.html) · [Open](reference/05-emoji-in-composer.html) | §5.7 emoji button | Restyle |
| 05/2 | Emoji in the same box | [Thread](screens/panels/05-emoji-in-composer--2-emoji-in-the-same-box--thread.png) · [Open](screens/panels/05-emoji-in-composer--2-emoji-in-the-same-box.png) | [Thread](reference/05-emoji-in-composer--thread.html) · [Open](reference/05-emoji-in-composer.html) | §5.7 emoji picker | Restyle + markup |
| 05/3 | Live preview (picker closed); picker open state | Closed: [Thread](screens/panels/05-emoji-in-composer--3-live-preview--thread.png) · [Open](screens/panels/05-emoji-in-composer--3-live-preview.png); picker open, Open only: [05-emoji-in-composer--picker-open](screens/states/05-emoji-in-composer--picker-open.png) | [Thread](reference/05-emoji-in-composer--thread.html) · [Open](reference/05-emoji-in-composer.html); picker open: [05-emoji-in-composer--picker-open](reference/05-emoji-in-composer--picker-open.html) | §5.7 emoji picker | Restyle + markup |
| 06/07 | Pre-chat form with an error | [Thread](screens/panels/06-forms-away-messages--07-prechat-form-with-an-error--thread.png) · [Open](screens/panels/06-forms-away-messages--07-prechat-form-with-an-error.png) | [Thread](reference/06-forms-away-messages--thread.html) · [Open](reference/06-forms-away-messages.html) | `prechatFormHtml` (§4.5, §5.15) | Restyle + markup |
| 06/09 | Message while away | [Thread](screens/panels/06-forms-away-messages--09-message-while-away--thread.png) · [Open](screens/panels/06-forms-away-messages--09-message-while-away.png) | [Thread](reference/06-forms-away-messages--thread.html) · [Open](reference/06-forms-away-messages.html) | Offline chat (§4.2), contact fallback (§4.6) | Restyle + New |
| 06/13 | Messages (all conversations) | [Thread](screens/panels/06-forms-away-messages--13-messages-all-conversations--thread.png) · [Open](screens/panels/06-forms-away-messages--13-messages-all-conversations.png) | [Thread](reference/06-forms-away-messages--thread.html) · [Open](reference/06-forms-away-messages.html) | `conversationListHtml` (§4.3) | Restyle + markup |
| 07/A | Form card in the chat | [Thread](screens/panels/07-prechat-in-chat--a-form-card-in-the-chat--thread.png) · [Open](screens/panels/07-prechat-in-chat--a-form-card-in-the-chat.png) | [Thread](reference/07-prechat-in-chat--thread.html) · [Open](reference/07-prechat-in-chat.html) | `handoffPrechatCardHtml` `.hc-card` (§4.7) | Restyle + markup |
| 07/B | Step by step, like a chat | [Thread](screens/panels/07-prechat-in-chat--b-step-by-step-like-a-chat--thread.png) · [Open](screens/panels/07-prechat-in-chat--b-step-by-step-like-a-chat.png) | [Thread](reference/07-prechat-in-chat--thread.html) · [Open](reference/07-prechat-in-chat.html) | none | New |
| 07/C | After submitting | [Thread](screens/panels/07-prechat-in-chat--c-after-submitting--thread.png) · [Open](screens/panels/07-prechat-in-chat--c-after-submitting.png) | [Thread](reference/07-prechat-in-chat--thread.html) · [Open](reference/07-prechat-in-chat.html) | Routing pill (§5.2); summary is new | New |
| 08/10 | Help | [Thread](screens/panels/08-help-center--10-help--thread.png) · [Open](screens/panels/08-help-center--10-help.png) | [Thread](reference/08-help-center--thread.html) · [Open](reference/08-help-center.html) | `kbHtml` list (§4.4) | Restyle + markup |
| 08/12 | Article | [Thread](screens/panels/08-help-center--12-article--thread.png) · [Open](screens/panels/08-help-center--12-article.png) | [Thread](reference/08-help-center--thread.html) · [Open](reference/08-help-center.html) | `kbHtml` article + rating (§4.4, §5.14) | Restyle + markup |
| 09 | Launcher states and greeting | Boards: [Thread](screens/boards/09-launcher-and-greeting--thread.png) · [Open](screens/boards/09-launcher-and-greeting.png); panel open, Open only: [09-launcher-and-greeting--open](screens/states/09-launcher-and-greeting--open.png) | [Thread](reference/09-launcher-and-greeting--thread.html) · [Open](reference/09-launcher-and-greeting.html); panel open: [09-launcher-and-greeting--open](reference/09-launcher-and-greeting--open.html) | RESPOK kit (§3.1, §3.3), nudge (§5.11) | Restyle + New |
| 10 | Chat button and colour settings, live preview | Open only. Board: [10-launcher-and-color](screens/boards/10-launcher-and-color.png); preview closed: [10-launcher-and-color--closed](screens/states/10-launcher-and-color--closed.png) | [10-launcher-and-color](reference/10-launcher-and-color.html), [--closed](reference/10-launcher-and-color--closed.html) (Open) | Config (§1.5) | New (settings) |
| 11/14 | Mobile home | [Thread](screens/panels/11-mobile--14-home--thread.png) · [Open](screens/panels/11-mobile--14-home.png) | [Thread](reference/11-mobile--thread.html) · [Open](reference/11-mobile.html) | Mobile sheet (§2) | Restyle |
| 11/15 | Mobile conversation | [Thread](screens/panels/11-mobile--15-conversation--thread.png) · [Open](screens/panels/11-mobile--15-conversation.png) | [Thread](reference/11-mobile--thread.html) · [Open](reference/11-mobile.html) | Mobile sheet (§2) | Restyle |
| 12 | Design tokens (spec sheet) | Boards: [Thread](screens/boards/12-tokens--thread.png) · [Open](screens/boards/12-tokens.png) | [Thread](reference/12-tokens--thread.html) · [Open](reference/12-tokens.html) | — | Reference |

## 2. Frame and layout

### 2.1 Panel

| Property | Design (`.w`) | Production |
|---|---|---|
| Size | 400 × 720 | `.panel` (420 × 680 today, CSS:79-82) → 400 × 720; keep both viewport caps (brief §4) |
| Corners | 28px on all four corners. Board 00 alone adds `.en .w{border-end-end-radius:6px}` (00/02, 00/04 and the live panel show a 6px bottom-end corner) | 28px all corners (brief §4: Template 1 has no tail). The 6px corner in the 00 crops is a known difference, see §11 |
| Background | `#fff`: conversation, pre-chat, article, Messages list. `.w.bgw` = `var(--bg)` Paper `#F5F5F8`: Home, Help | Set on each view root, not on `.panel` |
| Shadow | `--sh-3` | `.panel` box-shadow |
| Clip | `overflow:hidden; isolation:isolate` | `.panel` already `overflow:hidden` |
| Base type | Figtree, 14px, line-height 1.5 (respok.css, LTR; widget.css 1.7), colour `--ink` | `.shell` font + `.panel` font-size/line-height |
| Layout | Flex column; exactly one screen | `.panel` flex column → `.body[data-body]` (flex column, padding 0 with a view) → one `.wy-view` filling it (flex column) |
| Open / close | Grows out of and shrinks back into the launcher corner: `transform-origin:100% 100%` at bottom right (`0 100%` at bottom left, board 10). Opens 380ms `cubic-bezier(.22,1,.36,1)` from `translateY(14px) scale(.96)` (token sheet), .2s after a launcher click; closes to `translateY(36px) scale(.9)` (§6) | Keep the origins of `.panel.bottom-right` / `.bottom-left` (CSS:104, 111; mobile sheet `bottom center`, CSS:132). Replace today's one transition for both directions (CSS:91-96, `.panel.visible` CSS:113) with §6 |

### 2.2 Regions, top to bottom

Numbers are y / height in the 720px panel, measured in the reference renders with the default copy.

**Home** (01/02; 00/02, 01/03, 01/08 and 02/A–E have the same skeleton)

| Region | Design class | y / height | Spec |
|---|---|---|---|
| Hero | `.hx` | 0 / 233.1 | `flex:none; overflow:hidden; padding:18px 20px 80px`; background `var(--hero)` + highlight `::after`; watermark `.hx-mk` |
| Hero top row | `.hx-top` | 18 / 48 | Logo tile 48 at the inline start, spacer, close button 36 (y 24) at the inline end; `gap:8px; z-index:1` |
| Greeting line | `.hx-hi` | 96 / 23.1 | `margin-top:30px` |
| Question | `.hx-q` | 123.1 / 30 | `margin-top:4px` (one line; 2 lines on mobile) |
| Card stack | `.bd` | 177.1 → 648 | `margin-top:-56px` (cards overlap the hero by 56px); `padding:0 14px; gap:12px; flex:1; z-index:2` |
| Card 1 | `.cd` | 177.1 / 131.8 (01/02) | Team card. Recent card 92 and CTA card 66 in 01/03; away card 201.3 in 01/08 |
| Card 2 | `.cd` (help) | 320.8 / 248 (01/02, 4 rows) | `padding:12px 14px 4px` |
| Footer | `.pw` | 616 / 32 | `margin-top:auto` (pinned to the bottom of the stack) |
| Bottom dock | `.tabs.vb` | 648 / 60 | `margin:0 12px 12px; z-index:3`. Height 64 in mode A (footer moves to 612). Absent in mode E (footer at 688) |

**Conversation** (03/04; 00/04, 03/05, 03/06, 04, 05, 06/09, 07 share it)

| Region | Design class | y / height | Spec |
|---|---|---|---|
| Header | `.hd` | 0 / 68 | `z-index:2`, white, `box-shadow:0 1px 0 var(--line)` |
| Thread | `.th` | 68 / 530 | `flex:1; padding:14px 14px 4px`; messages bottom-aligned (`justify-content:flex-end`); top 30px fades out (`mask-image:linear-gradient(to bottom,transparent 0,#000 30px)`). `.th.top` (03/06, 06/09): top-aligned, no mask |
| Composer | `.cmp` | 598 / 90 | `padding:8px 12px 0`; box `.cbox` at 606, 82 tall. Box height by state: pending attachment 134.9; emoji open 336; recording 75.3; voice preview 58; locked 45.5; step input 109.3 |
| Footer | `.pw` | 688 / 32 | Centered "Powered by" + lockup |

The last group of each thread carries `margin-bottom:6px` (inline in every board) instead of 14px, so the gap to the
composer box is 6 + 4 (thread padding) + 8 (composer padding) = 18px.

**Messages** (06/13): `.ttl` 0/64 · list 64 → 560 (`flex:1; min-height:0; padding:0 16px`) · button block 560/56
(`padding:8px 16px 0`, primary button 48) · footer 616/32 · dock 648/60.

**Help** (08/10): white top block 0/122 (`box-shadow:0 1px 0 var(--line)`: `.ttl` 64 + search block 58 = field 44
with `padding:0 16px 14px`) · card stack 122 → 648 (`.bd` with `margin-top:0; padding:14px 14px 0`) · footer 616/32
· dock 648/60.

**Article** (08/12): `.hd` 0/68 · `.art` 68/491 (`flex:1; padding:18px 22px 6px`) · feedback row `.fb` 559/53 ·
ask card 622/66 (`margin:10px 14px 0`) · footer 688/32.

**Pre-chat** (06/07): `.hd` 0/68 · `.fm` 68/620 (`flex:1; padding:20px 18px 8px; gap:16px`; the submit button and
privacy line sit at the bottom with `margin-top:auto`; button at 604.8) · footer 688/32.

### 2.3 Scrolling and stacking

The boards clip overflow (`overflow:hidden`); scrolling is not drawn. At 720px every designed state fits. In
production:

| Screen | Scroll region (production node) | Fixed |
|---|---|---|
| Home | Hero + card stack in `.wy-home-scroll` (suggestion: the hero scrolls with the cards; the close button is the shell-level `.panel-close` and stays put) | Footer, dock |
| Conversation | `.wy-chat-scroll[data-chat-messages]` = `.th` | Header, composer, footer |
| Messages | `.wy-list-scroll` = the list | Title bar, button block, footer, dock |
| Help | Card stack (`.wy-kb-scroll`) | Title bar + search block, footer, dock |
| Article | `.art` (`.wy-kb-scroll`) | Header, feedback row, ask card, footer (move `kbArticleFeedbackHtml` out of the scroll) |
| Pre-chat | `.fm` (`.wy-scroll.wy-body-pad`) | Header, footer |

When the panel is capped below 720 + 118px only these regions give up height (brief §4). In the thread use
`margin-top:auto` on `.messages` instead of `justify-content:flex-end` so a long thread still scrolls to its top.

Stacking inside the panel: hero watermark `.hx-mk` (absolute) < hero highlight `.hx::after` < hero content
(`z-index:1`) < card stack `.bd` (`z-index:2`) < dock `.tabs` (`z-index:3`). `.hd` is `z-index:2` above the thread.
Production layers stay: `.wy-jump` 4, `.panel-close` 20, `.gs-call-host` 30, lightbox (map §2).

### 2.4 Close button

Production keeps one shell-level `button.panel-close[data-panel-close]` (map §2). Give it the look and position of
the design's close button per screen; reserve 40px (36 + 4 gap) at the inline end of every header so titles never run
under it.

| Screen | Look | Box | top / inline-end |
|---|---|---|---|
| Home hero (desktop) | `.ib.dk`: `background:rgba(255,255,255,.15)`, hover `.25`, icon `#fff` | 36 × 36, radius 12 | 24 / 20 |
| `.hd` headers (conversation, pre-chat, article, away chat) | `.ib`: transparent, icon `--ink-2`; hover `background:var(--bg-2); color:var(--ink)` | 36 × 36, radius 12 | 16 / 10 |
| `.ttl` title bars (Messages, Help) | `.ib` | 36 × 36, radius 12 | 14 / 12 |
| Mobile hero | `.ib.dk` | 44 × 44, radius 14 | 43 / 20, plus `env(safe-area-inset-top)` |
| Mobile `.hd` | `.ib` | 44 × 44, radius 14 | 22 / 10, plus `env(safe-area-inset-top)` |

Icon: X `M6 6l12 12M18 6 6 18`, 20px (22 on mobile), stroke 1.9, round caps, `transition:background-color .15s,color .15s`.
Suggested selectors: `.panel[data-view="home"]`, `.panel[data-view="list"]`, `.panel[data-view="help"]:not(:has(.wy-head-article))`
for the hero / title-bar variants, the `.hd` variant otherwise.

### 2.5 Mobile sheet (11/14, 11/15)

The boards draw a 390 × 844 phone with 44px corners and a 28px home-bar strip (`.safe`); both are device chrome. In
production the sheet is `.shell.gs-mobile-open .panel` (full screen, radius 0, safe-area padding, map §2); apply the
`.w.mob` values there and, for the first frame, under `@media (max-width:640px)`.

| Item | Desktop | Mobile (`.w.mob` + inline styles of board 11) |
|---|---|---|
| Base font size | 14px | 15px |
| Hero | `padding:18px 20px 80px`, 233.1 tall | `padding:22px 20px 86px`, 299.3 tall; grab handle `.grab` 40 × 5, radius 3, `rgba(255,255,255,.5)`, `margin:0 auto 14px` above the top row (decorative, no drag behaviour specified: render `aria-hidden`) |
| Hero question | 25px | 28px (respok.css; widget.css 29px), wraps to 2 lines |
| Icon buttons `.ib` | 36, radius 12 | 44, radius 14 (also the composer tools) |
| Round button `.ra` | 38 | 46 |
| Header `.hd` | 68 tall | `height:auto; padding:22px 10px 10px` (76 tall); avatar 44; name 16px; subtitle 12.5px; icons 22px |
| Home primary button | 48, radius 14, 15px | 52, radius 16, 16px |
| Search field `.sr` | 44, 14px, icon 18 | 48, 15px, icon 20 |
| List rows `.li` | min-height 46, 14px | min-height 50, 15px |
| Bubbles `.bb` | 14.5px | 15px; composer textarea 15px |
| Dock `.tabs.vb` | 60 tall, `margin-bottom:12px` | 64 tall, `margin-bottom:34px` (34 = the home-indicator zone). Production: the panel already pads `env(safe-area-inset-bottom)`; suggestion `margin-bottom:max(0px, calc(12px - env(safe-area-inset-bottom,0px)))` so the dock sits on the safe area like the design |
| Tab label | 12.5px | 12.5px; mode A 12px, dock 68 tall |
| Footer | under the composer | under the composer; the `.safe` strip below it becomes `env(safe-area-inset-bottom)` |

## 3. Tokens

All values below come from `widget.css` and `respok.css`; resolved values for the Ink accent are in
[`tokens.json`](tokens.json). `--a` is the only colour the customer picks: define `--a: var(--gs-primary)` at the
template root (`:host, .shell`) and derive the rest exactly as written (brief §5).

### 3.1 Colour

| Token | CSS expression | Default (Ink) | Used for |
|---|---|---|---|
| `--a` | `var(--gs-primary)`; Respok default `#16142B` | `#16142B` | Primary button and visitor bubble gradients, hero, focus rings, logo-tile letter, read ticks, wave bars, step bar, preview ring |
| `--a-1` | `color-mix(in oklab,var(--a) 5%,#fff)` | `#F2F2F3` | Image placeholder stripes, tip callout fill |
| `--a-2` | `color-mix(in oklab,var(--a) 10%,#fff)` | `#E4E4E8` | Active tab capsule, `.ra` fill, `.lt` icon tiles, selected chip, emoji category/toggle, step numbers |
| `--a-3` | `color-mix(in oklab,var(--a) 19%,#fff)` | `#CDCDD3` | Hairline rings on tinted elements, `.ra` hover/press fill, focus halos (`0 0 0 4–5px`) |
| `--a-hi` | `color-mix(in oklab,var(--a) 92%,#fff)` | `#25233A` | Top stop of the primary button and visitor bubble gradients |
| `--a-ink` | `color-mix(in oklab,var(--a) 74%,#0B0D12)` | `#131224` | Text and icons on tints (active tab, `.ra` icon, `.more`, `.skip`, article links) |
| `--hero` | `linear-gradient(155deg,color-mix(in oklab,var(--a) 78%,#fff) 0%,var(--a) 55%,color-mix(in oklab,var(--a) 86%,#000) 100%)` | Ink brand override: `linear-gradient(155deg,#302C59 0%,#1E1B3B 50%,#16142B 100%)` | Home hero. Use the override when the accent is uncustomised (empty or `#3B82F6`) or Ink (`tokens.json` → `brandOverrides`, brief §5.2) |
| `--on-a` | brief §5.3: `var(--gs-on-primary,#fff)` | `#FFFFFF` | Use wherever the CSS writes `#fff` on the accent: `.btn-p` text, `.R .bb` text, `.ec .go` icon, hero text and hero close icon (hero translucent fills become `color-mix(in srgb,var(--on-a) 15%,transparent)` / 25%) |
| `--ink` | `#16142B` (widget.css `#0F1217`) | `#16142B` | Main text, card titles, Ink lockup |
| `--ink-2` | `#3D3B55` (widget.css `#434955`) | `#3D3B55` | Secondary text, icon buttons, `.l2`, note text |
| `--ink-3` | `#5E5C75` Slate (widget.css `#666D7A`) | `#5E5C75` | Meta, captions, placeholders of `.sr`, inactive tabs, composer tools |
| `--ink-4` | `#A9A7BC` (widget.css `#A3A9B4`) | `#A9A7BC` | Row chevrons, input hover ring |
| `--sig` | `#FF5A3C` Signal (new in respok.css) | `#FF5A3C` | Live dot, presence dot, Thread lockup/tab accent piece |
| `--sig-d` | `#D3361A` Signal Deep (new) | `#D3361A` | All unread badges, stop-recording icon |
| `--away` | `#A9A7BC` (new) | `#A9A7BC` | Away ring of `.live.off` and `.pr.off` |
| `--ok` | `#FF5A3C` (widget.css `#12A150`) | `#FF5A3C` | Presence/live (Respok sets them to `--sig` explicitly); agent-face online dot (board 10) |
| `--bad` | `#D3361A` (widget.css `#D33A43`) | `#D3361A` | Errors: required star, field error, "Not sent", "Try again", file-type label |
| `--rec` | `#FF5A3C` (widget.css `#E5484D`) | `#FF5A3C` | Recording dot, recording ring of the composer, stop button tint |
| `--bg` | `#F5F5F8` Paper (widget.css `color-mix(in oklab,var(--a) 3%,#F5F6F8)`) | `#F5F5F8` | `.w.bgw` screens, search field, note/intro/banner fills, row hover, kbd |
| `--bg-2` | `#EDECF2` (widget.css `color-mix(in oklab,var(--a) 5%,#EDEFF2)`) | `#EDECF2` | Icon-button hover, Resolved tag, speed chip, skeleton |
| `--line` | `#E4E3EC` Mist (widget.css `color-mix(in oklab,var(--a) 6%,#E7E9ED)`) | `#E4E3EC` | Hairlines, row dividers, header shadow line, day-divider rules |
| `--line-2` | `#D3D1DE` (widget.css `color-mix(in oklab,var(--a) 7%,#D4D8DE)`) | `#D3D1DE` | Composer and input rings, chips, feedback buttons, unplayed wave bars |
| `--op` | `#F0EFF5` (widget.css `color-mix(in oklab,var(--a) 6%,#F0F2F5)`) | `#F0EFF5` | Operator bubble |

In Respok the neutrals (`--bg`, `--bg-2`, `--line`, `--line-2`, `--op`) are fixed brand values and do **not** follow
the accent (in WebYar they are accent-tinted). Badges stay Signal Deep and status dots stay Signal for any accent.
Token-sheet names (board 12, "from one input"): Brand `--a`, Light 92% `--a-hi`, Ring 19% `--a-3`, Tint 10% `--a-2`,
Wash 5% `--a-1`, Text on tint `--a-ink`; Ink `--ink`, Text 2 `--ink-2`, Slate `--ink-3`, Agent bubble `--op`, Paper
`--bg`, "Signal · live" `#FF5A3C`, "Signal Deep · badge" `#D3361A`.

Fixed colours used by the Respok screens (not tokens):

| Value | Where |
|---|---|
| `#fff` | Panel, cards, header, composer box, inputs, chips, dock, logo tile, voice play button, badge rings, launcher badge border |
| `#FFEAE4` / `#A62A12` | "Open" status tag (respok.css) |
| `#FFF1ED` / `#A62A12` | "Your details are saved" summary header (respok.css) |
| `#16142B`, hover `#000` | "Powered by" lockup mark and wordmark (respok.css) |
| `#FF5A3C` (literal) | Accent piece of the lockups, the filled Thread Messages-tab icon and the greeting avatar glyph |
| `rgba(255,255,255,.88)` | Hero greeting line |
| `rgba(255,255,255,.16)` → transparent 62% | Hero highlight `radial-gradient(90% 70% at 0% 0%,…)` (LTR; `100% 0%` in RTL) |
| `rgba(255,255,255,.15)` / `.25` | Hero close button, hover |
| `#FCE3D4`/`#8A3410`, `#DCE6FB`/`#1C4A92`, `#D2EEDF`/`#145E39`, `#EBE1FA`/`#57309A` | Initial avatars `.c1`–`.c4` (background / letter) |
| `#7A808C` | Placeholder of composer textarea and `.inp` fields |
| `#272B34` | Article paragraphs and steps |
| `#EEF0F3` / `#AEB3BE` | Disabled round button `.ra.off` |
| `rgba(15,18,23,.58)` | Image caption pill |
| `rgba(15,18,23,.06)` / `rgba(255,255,255,.18)` | Inline code on operator / visitor bubbles |
| `rgba(15,18,23,.05)` / `rgba(255,255,255,.17)` | Quote block in operator / visitor bubbles |
| `#ECEBF2` | Greeting card hairline |

### 3.2 Typography

Families (brief §6): Latin `Figtree, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`; codes
`"DM Mono", ui-monospace, "SF Mono", Menlo, monospace`; RTL `"Vazirmatn", Tahoma, sans-serif`. Weights used: 400, 500,
600, 700 (Figtree 800 and DM Mono 500 are in the font files but not used by these screens). Line-heights marked (L)
are respok.css values that apply under `[dir=ltr]` only; in RTL the widget.css value in brackets applies.

| Role | Size / line-height / weight / letter-spacing | Classes |
|---|---|---|
| Hero question | 25px (L; [27]) / 1.2 (L; [1.45]) / 700 / -.015em (L). Mobile 28px | `.hx-q` |
| Hero greeting | 16.5px (L; [17]) / 1.4 (L; [1.6]) / 500, `rgba(255,255,255,.88)` | `.hx-hi` |
| Logo-tile initial | 21px / 700, colour `--a`, centred | `.logo` |
| Screen title | 19px / 1.5 / 700 | `.ttl h2` |
| Article title | 21px / 1.3 (L; [1.6]) / 700 / -.01em (L) | `.art h1` |
| Article subhead | 16px / 1.5 / 700 | `.art h2` |
| Article body, steps | 14.5px / 1.65 (L; [2] and [1.85]) / 400, `#272B34` | `.art p`, `.steps li` |
| New-conversation title | 17px / 1.5 / 700 | `.wel h3` |
| Card title | 15px / 1.35 (L; [1.45]) / 700 | `.t1` |
| Header name | 15px / 1.4 / 700 (mobile 16px) | `.hn` |
| Message | 14.5px / 1.5 (L; [1.75]) / 400 (mobile 15px) | `.bb` |
| Composer input | 14.5px / 26px / 400 | `.cbox textarea`, `.cbox input` |
| Field input | 14.5px / 400 (small 13.5px) | `.inp`, `.inp.sm` |
| Button | 15px / 600 (small 13.5px) | `.btn`, `.btn.sm` |
| List row | 14px / 1.4 (L; [1.55]) / 400 | `.li` |
| Row title | 14px / 1.4 (L; [1.5]) / 700; time 11.5px / 500 `--ink-3` | `.l1`, `.l1 time`, `.l1 .tm-s` |
| Row preview | 13px / 1.4 (L; [1.55]) / 400 `--ink-2`; unread 600 `--ink` | `.l2`, `.l2.u` |
| Row sub-line | 12px / 500 `--ink-3` | `.l3` |
| Section header | 13.5px / 1.5 / 700 | `.sh` |
| Form-card / intro title | 14px / 700 | `.fcard h4`, `.intro b` |
| Banner title | 13.5px / 1.5 / 700 | `.ban b` |
| Chip, feedback button | 13px / 600 | `.chip`, `.fbb button` |
| Field label | 13px / 600 (in the form card 12px `--ink-2`); "(optional)" 12px / 400 `--ink-3` | `.fld label`, `.fcard .fld label`, `.fld .op` |
| Intro text | 13px / 1.5 (L; [1.75]) `--ink-2` | `.intro` |
| Note text | 12.5px / 1.5 (L; [1.75]) `--ink-2` | `.note` |
| Card status line | 12.5px / 1.4 (L; [1.55]) `--ink-3` | `.t2` |
| Tip callout | 13px / 1.55 (L; [1.85]) `--ink-2` | `.tip` |
| Quote | 12.5px / 1.6; author 11.5px / 700, opacity .9 | `.qt`, `.qt b` |
| Link card | title 13px / 1.5 / 700; domain 11.5px / 1.4 `--ink-3` | `.lnk b`, `.lnk small` |
| Inline code | DM Mono 12.5px | `.code` |
| Tab label | 12.5px / 1.3 / 600 (respok.css; widget.css 12px); active label in `.vb` 13.5px / 700; mode A 11.5px / 1.4 / 600 (active 700); mode D 13.5px / 600 (active 700) | `.tab`, `.tl` |
| `.more` link | 12.5px / 700 `--a-ink` | `.more` |
| Caption | 12px / 700 `--ink-3` | `.cap` |
| Header subtitle | 12px / 1.45 `--ink-3` (mobile 12.5px) | `.hs` |
| Sender name | 11.5px / 1.4 (L; [1.5]) / 600 `--ink-3` | `.nm` |
| Day divider | 11.5px / 600 `--ink-3` | `.day` |
| Meta | 11px / 1.4 (L; [1.5]) / 400 `--ink-3` | `.mt` |
| Error | 12px / 600 `--bad`; in meta 11px / 700 | `.err`, `.mt .er`, `.retry` |
| Badge | 11px / 1 / 700 (tab badge 10.5px / 700; respok.css, widget.css 800) | `.nb`, `.tic .nb` |
| Status tag | 11px / 700 | `.tg` |
| Footer | 11.5px `--ink-3` | `.pw` |
| Recording timer | 13.5px / 700, tabular numbers | `.rtm` |
| Speed chip | 11.5px / 700, tabular numbers | `.spd` |
| Hints, privacy, step progress | 11.5px `--ink-3` (step progress 600) | `.hint`, `.priv`, `.prog` |
| Greeting card | name 13px / 1.3 / 700; text 14px / 1.4 | `.kgr-n`, `.kgr-s` (09: `.gt b`, `.gt span`) |
| Emoji grid | section header 11.5px / 1.7 / 700 `--ink-3`; emoji 23px in `"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif` | `.ep-h`, `.ep-e` |
| Launcher badge | `700 12px/18px Figtree` | `.kb`, `.rpk-badge` |

### 3.3 Radii

| Radius | Elements |
|---|---|
| 28 | Panel |
| 22 | Bottom dock `.tabs.vb` |
| 20 | Cards `.cd`, bubbles `.bb`, composer box `.cbox`, form card `.fcard` |
| 18 | Image `.img`, email card `.ec`, summary `.sum` |
| 16 | Tab capsule `.vb .tab`, intro `.intro`, banner `.ban`; mobile primary button |
| 15 | Logo tile |
| 14 | Button `.btn`, input `.inp`, search `.sr`, note, link card `.lnk`, tip; mobile `.ib` |
| 12 | Icon button `.ib`, chip, row `.li`, small button `.btn.sm`, small input `.inp.sm`, `.ec .go`, pending chip `.pend`, quote, emoji search |
| 11 | Icon tile `.lt`, feedback buttons, emoji cell |
| 10 | Composer tools `.tools .ib`, link icon tile, file download button, emoji category, badge (20 / 2) |
| 9 | File-type tile `.ft`, caption pill, form-card icon tile, `.more` |
| 8 | Step number, thumbnail, pending remove button, speed chip, skeleton bars |
| 6 | Bubble join corner, inline code, kbd |
| 99 | Status tag `.tg`, queue pill |
| 50% | Avatars, `.ra`, voice play button, live dot, launcher |
| Greeting tail | Thread `21px 21px 4px 21px`; Open `18px 18px 6px 18px` (the small corner faces the launcher) |

### 3.4 Shadows and elevation

| Token / element | Value |
|---|---|
| `--sh-1` | `0 0 0 1px rgba(15,18,23,.06),0 1px 2px rgba(15,18,23,.04)` |
| `--sh-2` (cards, in-chat cards) | `0 0 0 1px rgba(15,18,23,.05),0 1px 2px rgba(15,18,23,.04),0 10px 24px -14px rgba(15,18,23,.2)` |
| `--sh-3` (panel) | `0 0 0 1px rgba(15,18,23,.05),0 14px 32px -14px rgba(15,18,23,.22),0 50px 100px -40px rgba(15,18,23,.38)` |
| Card hover (`a.cd:hover`) | `0 0 0 1px rgba(15,18,23,.06),0 2px 4px rgba(15,18,23,.05),0 18px 34px -18px rgba(15,18,23,.3)` |
| Dock `.tabs.vb` | `0 0 0 1px rgba(15,18,23,.05),0 2px 4px rgba(15,18,23,.04),0 16px 32px -14px rgba(15,18,23,.32)` |
| Primary button `.btn-p` | `inset 0 1px 0 rgba(255,255,255,.2),inset 0 -1px 0 rgba(0,0,0,.1),0 1px 2px rgba(15,18,23,.16),0 10px 22px -12px color-mix(in oklab,var(--a) 90%,transparent)` |
| Visitor bubble | `0 1px 2px color-mix(in oklab,var(--a) 28%,transparent)` |
| Composer box | rest `0 0 0 1px var(--line-2),0 6px 16px -12px rgba(15,18,23,.25)`; focus `0 0 0 1.5px var(--a),0 0 0 5px var(--a-3)`; recording `0 0 0 1.5px color-mix(in oklab,var(--rec) 55%,#fff),0 0 0 5px color-mix(in oklab,var(--rec) 12%,#fff)` |
| Header `.hd` | `0 1px 0 var(--line)` |
| Logo tile | `0 6px 14px -6px rgba(0,0,0,.35)` |
| Voice play button | `0 2px 6px -2px rgba(15,18,23,.35)` |
| Avatar ring in stacks | `0 0 0 2.5px #fff` (welcome block 3px) |
| Launcher (kit) | rest `0 10px 28px rgba(22,20,43,.28)`; hover `0 16px 36px rgba(22,20,43,.36)`; press `0 5px 14px rgba(22,20,43,.24)` |
| Greeting / reply card | `0 14px 36px rgba(22,20,43,.18),0 0 0 1px #ECEBF2` |

### 3.5 Spacing rhythm

| Context | Value |
|---|---|
| Side gutters | Cards 14 (`.bd`), composer and dock 12, Messages list and its button 16, help search 16, forms 18, hero and title bars 20, article 22 |
| Card padding | Team card 16; help card `12px 14px 4px`; recent card `12px 14px 14px`; CTA card `14px 16px`; categories card `4px 14px` |
| Card stack gap | 12 |
| Hero rhythm | top 18, top row 48, 30 to greeting, 4 to question, 80 bottom (cards overlap 56) |
| Message groups | 14 between groups, 3 between bubbles of a group, avatar–bubble gap 8, meta `margin:2px 8px 0`, name `margin:0 12px 1px` |
| Rows | `.li` padding `10px 8px`, `margin:0 -8px`, gap 12; Messages rows `padding-block:12px` |
| Header | `.hd` padding `0 10px`, gap 4, identity gap 10 with `padding-inline:4px` |
| Composer | zone `8px 12px 0`; box `11px 6px 5px`, gap 2; tools gap 2 |
| Forms | field gap 6, form gap 16, form card gap 10 |

### 3.6 Icons

24-unit grid, round caps and joins, "soft corners · active = filled" (token sheet). Tab icons: 24px, stroke 1.7; the
active tab shows the filled twin (`.i-o` outline is hidden, `.i-f` filled is shown). UI icons: stroke 1.8–2.2 at the
sizes below. Copy SVG paths from the named board source.

| Icon | Size / stroke | Source board |
|---|---|---|
| Home (outline / filled with a white door) | 24 / 1.7 | 01 (`.tab`) |
| Messages, Open direction: round bubble with a square bottom-right corner + 3 dots (filled: white dots) | 24 / 1.7 | 01 (`.i-o.g-o`, `.i-f.g-o`) |
| Messages, Thread direction: two pills, a short one top-left (square bottom-left corner) and a long one bottom-right (square bottom-right corner); filled: first pill `currentColor`, answer pill Signal `#FF5A3C` | 24 / 1.7 | 01, 02, 06, 08, 10, 11 and the token sheet 12 (`.i-o.g-t`, `.i-f.g-t`); markup in §4.1. Board 00's single pill with 3 dots is an earlier drawing and is superseded |
| Help (open book; filled with a white spine) | 24 / 1.7 | 01 |
| Close X | 20 / 1.9 (greeting card 14 / 2.4) | all |
| Back chevron `m14 6-6 6 6 6` | 20 / 2 (mobile 22) | 03 |
| More options (3 dots) | 20 / 3 | 03 |
| Row chevron `m10 6 6 6-6 6` | 18 / 2 (`.more`: 16 / 2.2) | 01 |
| Search (circle r 6.5 + handle) | 18 / 1.9 (emoji search 16 / 2; mobile 20) | 01, 05 |
| Send plane (filled; mirrored in RTL via `.pl`) | 18 in buttons and cards, 19 in the composer | 01, 03 |
| Mic (filled capsule + stand) | 20 / 2 (mobile 22) | 03 |
| Emoji, Attach | 20 / 1.8 (mobile 22) | 03 |
| Stop (rounded square) | 13 (flow 11) | 04 |
| Trash | 19 / 1.8 | 04 |
| Play (filled triangle) | 15 | 03, 04 |
| Read (double tick) / Delivered (single tick) | 16 / 2 and 15 / 2.2 | 03 |
| Error (circle + !) | 14 / 2.2 | 03, 06 |
| Download | 16 / 1.9 | 03 |
| Image placeholder | 30 / 1.5 | 03 |
| Link arrow | 16 / 1.9 | 03 |
| Remove X (pending file) | 14 / 2.2 | 03 |
| Mail (away note), person (intro), moon (away banner) | 18 / 1.8 | 01, 06 |
| Person in form card | 15 / 1.9 | 07 |
| Lock (privacy 13 / 2, form card 12 / 2, locked composer 16 / 1.9) | — | 06, 07 |
| Check (`.go` 18 / 2.2), check-circle (summary 16 / 2.2) | — | 06, 07 |
| Help categories: box, card, tag | 18 / 1.8 | 08 |
| Thumb up / down (down = `scaleY(-1)`) | 16 / 1.8 | 08 |
| Info (tip) | 16 / 2 | 08 |
| Emoji categories: clock, smiley, person, heart, leaf, cup | 19 / 1.8 | 05 |
| Brand marks: hero watermark, lockups, launcher glyphs, launcher chevron (`M6 9l6 6 6-6`, stroke 2.5), greeting avatar glyph | — | 00, 01, 09; files in [`../../shared/brand/respok/`](../../shared/brand/respok/) |

### 3.7 Motion tokens

| Token | Value | Use |
|---|---|---|
| `--ease` | `cubic-bezier(.22,1,.36,1)` | Panel open (token sheet), buttons, cards, chevrons, tab icon press, emoji picker open, card cascade |
| Spring open | `cubic-bezier(.2,.9,.25,1)` | Greeting/reply card in, launcher entrance. The live boards 00 and 10 also open the panel with it; that is reference only (§6) |
| Accelerate | `cubic-bezier(.55,0,.75,.2)` | Panel close, launcher drop |
| Overshoot rise | `cubic-bezier(.3,1.35,.5,1)` | Launcher rising back after close |
| Pop | `cubic-bezier(.3,1.5,.5,1)` | Badge, Open dot pop |
| Slide | `cubic-bezier(.3,1.4,.5,1)` | Thread answer pill |
| Picker close | `cubic-bezier(.4,0,.6,1)` | Emoji picker fold |

Token-sheet durations (board 12, spec): "Panel opens · rises 14px, scales from 0.96" 380ms `cubic-bezier(.22,1,.36,1)`
(canonical: this is the panel open to build, as in WebYar Template 1); cards enter 420ms with a 60ms stagger; buttons
200ms (hover 106%, press 94%); typing dots 1300ms ease-in-out loop; mic turns into send 180ms ease-out with a 90° turn;
loading skeleton 1400ms linear shimmer. The live boards open the panel with other numbers (00 and 10: .4s
`cubic-bezier(.2,.9,.25,1)` from `translateY(36px) scale(.9)`); they are reference only. The panel close is not on the
token sheet and comes from the live boards. Both are in §6.

### 3.8 The Respok delta: what `presentation-intl.css` must contain

Every rule of [`respok.css`](reference/css/respok.css), what it changes against [`widget.css`](reference/css/widget.css),
and its production target. Production scope: `:host, .shell` for tokens; the same selectors the `default` template
adopts for the widget.css classes (§4 gives the mapping) for everything else. The Respok root class `.rp` maps to the
`intl` template itself (the skin only loads for `intl`), so drop `.rp` from the selectors. Write the `[dir=ltr]` rules
as `.panel:not([dir=rtl])` (Core writes `dir` on `.panel`; the chat view root never writes `ltr`, PD:954).

| # | respok.css | widget.css (base) | Production intl skin |
|---|---|---|---|
| 1 | `--ink:#16142B; --ink-2:#3D3B55; --ink-3:#5E5C75; --ink-4:#A9A7BC` | `#0F1217`, `#434955`, `#666D7A`, `#A3A9B4` | Token overrides at `:host, .shell` |
| 2 | `--sig:#FF5A3C; --sig-d:#D3361A; --away:#A9A7BC` | not defined | Add |
| 3 | `--ok:#FF5A3C; --bad:#D3361A; --rec:#FF5A3C` | `#12A150`, `#D33A43`, `#E5484D` | Override |
| 4 | `--bg:#F5F5F8; --bg-2:#EDECF2; --line:#E4E3EC; --line-2:#D3D1DE; --op:#F0EFF5` | accent-tinted `color-mix()` values | Override with the fixed values |
| 5 | `font-family: Figtree, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` | `"Vazirmatn", ui-sans-serif, system-ui, sans-serif` | Replace INTL:39-42 (`InterWY` stack); the intl fonts asset publishes `--gs-presentation-font` (brief §6) |
| 6 | `.cv.rp{background:#E8E7EE}` | canvas | Ignore (board chrome) |
| 7 | `.cv.rp[dir=rtl]{font-family:"Vazirmatn",Tahoma,sans-serif}` | — | `[dir=rtl]` font on `.panel` / views; add Vazirmatn to the intl fonts asset if Persian must render |
| 8 | `.rp.lg-open .g-t, .rp.lg-thread .g-o{display:none!important}` | — | Root class from `logoDirection` (§4.1) |
| 9 | `.rp[dir=ltr] .cv-t{…}`, `.cv-d{…}`, `.spec > p{…}` | — | Ignore (board chrome) |
| 10 | `[dir=ltr] .w{line-height:1.5}` | 1.7 | Panel / view base line-height |
| 11 | `[dir=ltr] .hx-hi{margin-top:30px;font-size:16.5px;line-height:1.4}` | 30px / 17px / 1.6 | Hero greeting |
| 12 | `[dir=ltr] .hx-q{margin-top:4px;font-size:25px;line-height:1.2;letter-spacing:-.015em}` | 2px / 27px / 1.45 / 0 | Hero question |
| 13 | `[dir=ltr] .w.mob .hx-q{font-size:28px}` | 29px | Mobile hero question |
| 14 | `[dir=ltr] .t1{line-height:1.35}` | 1.45 | Card title |
| 15 | `[dir=ltr] .t2, .l1, .l2, .li{line-height:1.4}` | 1.55, 1.5, 1.55, 1.55 | Status line, row title, row preview, row |
| 16 | `[dir=ltr] .bb{font-size:14.5px;line-height:1.5}` | 14.5px / 1.75 | Bubble (production `.msg`: INTL:95-102 today 14px / 20px) |
| 17 | `[dir=ltr] .nm, .mt{line-height:1.4}` | 1.5 | Sender name, meta |
| 18 | `[dir=ltr] .note, .intro{line-height:1.5}` | 1.75 | Away note, pre-chat intro |
| 19 | `[dir=ltr] .art h1{line-height:1.3;letter-spacing:-.01em}` | 1.6 / 0 | Article title |
| 20 | `[dir=ltr] .art p, .steps li{line-height:1.65}` | 2, 1.85 | Article body, steps |
| 21 | `[dir=ltr] .tip{line-height:1.55}` | 1.85 | Tip callout |
| 22 | `[dir=ltr] .wel p{line-height:1.55}` | inherits | New-conversation status line |
| 23 | `.rp .tab{font-size:12.5px}` | 12px | Tab label, every direction |
| 24 | `.rp .code{font-family:"DM Mono",ui-monospace,"SF Mono",Menlo,monospace}` | `ui-monospace,SFMono-Regular,Menlo,Consolas,monospace` | Inline code |
| 25 | `.rp .hx-mk{top:-46px;inset-inline-end:16px;width:150px;opacity:.1;transform:none}` | `top:-22px; inset-inline-end:-14px; width:156px; opacity:.11; transform:rotate(-10deg)` | Hero watermark (Respok mark, never rotated) |
| 26 | `.rp .hx-mk.g-t{top:-34px;width:156px}` | — | Thread watermark |
| 27 | `.rp .live{background:var(--sig);box-shadow:0 0 0 3px color-mix(in oklab,var(--sig) 22%,transparent)}` | `--ok`, 20% halo | Live dot |
| 28 | `.rp .live.off{background:#fff;box-shadow:inset 0 0 0 2px var(--away)}` | `#A3A9B4`, `0 0 0 3px #ECEEF1` | Away: empty ring |
| 29 | `.rp .av .pr{background:var(--sig)}` | `var(--ok)` | Presence dot |
| 30 | `.rp .av.sa.off{background:var(--away)}` | `#B5BAC4` | Store-logo avatar away (`.av.sa` is not used on these screens; keep for parity) |
| 31 | `.rp .av .pr.off{background:#fff;box-shadow:inset 0 0 0 2.5px var(--away),0 0 0 2.5px #fff}` | `#A3A9B4` fill | Presence away: empty ring |
| 32 | `.rp .nb, .rp .tic .nb{background:var(--sig-d);color:#fff}` | `.nb` `--a`/`#fff`; `.tic .nb` `#FFB423`/`#12141F` | All unread badges |
| 33 | `.rp .tic .nb{font-weight:700}` | 800 | Tab badge |
| 34 | `.rp .tg.open{background:#FFEAE4;color:#A62A12}` | `color-mix(in oklab,var(--ok) 12%,#fff)` / `#0F6B37` | "Open" status tag |
| 35 | `.rp .sum .sh2{background:#FFF1ED;color:#A62A12}` | `color-mix(in oklab,var(--ok) 9%,#fff)` / `#0F6B37` | Summary header |
| 36 | `.rp .typ i{width:7px;height:7px;border-radius:50%;transform:none;animation-name:rp-typ}` + `@keyframes rp-typ{0%,60%,100%{opacity:.45;transform:none}25%{opacity:1;transform:translateY(-3px)}}` | 6px diamonds (`border-radius:1.5px; rotate(45deg)`), `wy-typ` | Typing dots: three round dots (duration 1.3s ease-in-out infinite and delays 0/.16s/.32s stay from widget.css) |
| 37 | `.rp .ra.stop{color:var(--sig-d)}` | `var(--rec)` | Stop-recording icon |
| 38 | `.rp .pw{gap:5px}` | 6px | Footer |
| 39 | `.rp .pw .lk{width:49px;height:12px;color:#16142B}`; `.rp .pw .lk.g-t{width:53px}`; `.rp .pw:hover .lk{color:#000}` | WebYar mark `.pw svg` 11 × 15 `--ink-2` + bold name `.pw b` | Respok lockup (§4.26) |

Besides these CSS rules, the intl build differs from WebYar Template 1 only in brand SVGs and copy: every widget
screen board (01–08, 11, 12 against their WebYar twins) has the same markup class for class apart from the root
classes. The brand pieces are the hero watermark (§4.2), the Messages-tab icon (§4.12), the footer lockup (§4.26),
the launcher kit (§4.27, board 09 is Respok-only) and the kit options of the chat-button setting (§4.29). The
renderer is shared, so it picks these SVGs by template id and `logoDirection`.

## 4. Components

### 4.1 Logo direction (Open / Thread)

One root class switches every brand element: `lg-open` or `lg-thread` on the widget root; elements carry `g-o` (shown
only for Open) or `g-t` (shown only for Thread) (respok.css rule 8). Production: setting `logoDirection: "thread" |
"open"`, default `"thread"` (brief §5.6). Put `lg-<direction>` on `.shell` (so the launcher and the panel agree) and
emit both variants of each element, as the boards do, so the operator preview can switch without a re-render.

| Element | Open (`g-o`) | Thread (`g-t`) | Screenshot |
|---|---|---|---|
| Hero watermark `.hx-mk` | Open bubble only, viewBox `0 0 82 82`, 150px wide, `top:-46px` | Two pills, viewBox `0 0 104 92`, 156px wide, `top:-34px` | 01/02, both renders |
| Messages-tab icon | Round bubble, square bottom-right corner, 3 dots (filled: white dots) | Two pills (§3.6); outline stroke 1.7; filled: first pill `currentColor`, answer pill Signal `#FF5A3C` (fixed, also with a custom accent). Markup below | 01/03 (with badge) and 06/13 (active), both renders |
| "Powered by" lockup `.lk` | viewBox `0 -49.9 812.2 199.8`, 49 × 12 | viewBox `0 -42 804.8 184`, 53 × 12 | 01/02, both renders |
| Launcher glyph | Bubble + Signal dot, viewBox `0 0 108 108`, 47% wide | Two pills (production `RESPOK_KIT_CHAT_GLYPH`), viewBox `0 0 104 92`, 50% wide | 09, both boards; Thread also 00/05 |
| Launcher arrival | Dot pops 0.2 → 1.35 → 1 | Answer pill slides in from the right | 09, both boards |
| Greeting card | Corners `18 18 6 18`, placed diagonally off the launcher (§4.28) | Corners `21 21 4 21`, 16px above the launcher | 09, both boards; Thread also 00/05 |
| Greeting avatar glyph (09) | Open bubble 80 + Signal dot r 17 in viewBox 112 | Pills in viewBox 108 × 102 | 09, both boards |

Thread Messages-tab icon, copied from [`source/01-home.dc.html`](source/01-home.dc.html); the same paths in every
board that draws the dock (01, 02, 06, 08, 10, 11) and on the token sheet 12 ("Messages" and "Active"). This is the
decision: board 00 draws an earlier single pill with three dots (`M9.5 5.75H14.5A6.25 6.25 …`), which is superseded
and must not ship.

```html
<svg class="i-o g-t" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true">
  <path d="M5.75 3H9.75A3.75 3.75 0 0 1 13.5 6.75A3.75 3.75 0 0 1 9.75 10.5H3A1 1 0 0 1 2 9.5V6.75A3.75 3.75 0 0 1 5.75 3Z"/>
  <path d="M10.75 13.5H18.25A3.75 3.75 0 0 1 22 17.25V20A1 1 0 0 1 21 21H10.75A3.75 3.75 0 0 1 7 17.25A3.75 3.75 0 0 1 10.75 13.5Z"/>
</svg>
<svg class="i-f g-t" viewBox="0 0 24 24" aria-hidden="true">
  <path fill="currentColor" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M5.75 3H9.75A3.75 3.75 0 0 1 13.5 6.75A3.75 3.75 0 0 1 9.75 10.5H3A1 1 0 0 1 2 9.5V6.75A3.75 3.75 0 0 1 5.75 3Z"/>
  <path fill="#FF5A3C" stroke="#FF5A3C" stroke-width="1.7" stroke-linejoin="round" d="M10.75 13.5H18.25A3.75 3.75 0 0 1 22 17.25V20A1 1 0 0 1 21 21H10.75A3.75 3.75 0 0 1 7 17.25A3.75 3.75 0 0 1 10.75 13.5Z"/>
</svg>
```

Acceptance: with `logoDirection:"thread"` (default) compare the `--thread` crops and boards (and 00/*); with `"open"`
compare the unsuffixed ones (§0, §1). In 00/02 the Messages icon is the superseded single pill: that one detail of
the crop does not apply (§11).

### 4.2 Hero (Home header)

Design: `.hx > svg.hx-mk(.g-o/.g-t) + .hx-top(.logo + .hx-sp + close) + p.hx-hi + h2.hx-q`.
Production: `div.wy-head.wy-head-home` (map §4.1) becomes the hero; `section.home-greeting-block > h2.home-greeting +
p.home-welcome` moves into it (keep both classes: `h2.home-greeting` takes the `.hx-hi` look and
`p.home-welcome` the `.hx-q` look; or swap the elements if `homeGreeting` is the long line in the i18n table).
The workspace name and reply-time subtitle of today's home header are not shown in the hero (the reply time moves
into the team card, §4.5); keep the workspace name as the logo image `alt`.

| Part | Spec |
|---|---|
| Box | `position:relative; flex:none; overflow:hidden; padding:18px 20px 80px; color:#fff` (→ `--on-a`); `background:var(--hero)` |
| Highlight | `::after` absolute `inset:0`, `radial-gradient(90% 70% at 0% 0%,rgba(255,255,255,.16),transparent 62%)` (LTR; `100% 0%` in RTL); no pointer events |
| Watermark | `.hx-mk` absolute, `color:#fff`, `pointer-events:none`, `height:auto`; Open: `top:-46px; inset-inline-end:16px; width:150px; opacity:.1; transform:none`; Thread: `top:-34px; width:156px` |
| Top row | `.hx-top`: flex, `align-items:center; gap:8px; z-index:1`; logo tile (§4.3), spacer `.hx-sp{flex:1}`, close (§2.4) |
| Greeting | `.hx-hi` 16.5px / 1.4 / 500, `rgba(255,255,255,.88)`, `margin-top:30px`, `z-index:1`. Copy: "Hi there, welcome"; returning identified visitor "Welcome back, Ali" (new: needs the visitor's first name); board 00 shows "Hi there" |
| Question | `.hx-q` 25px / 1.2 / 700 / -.015em, `margin-top:4px`, `z-index:1`. Copy: "How can we help you today?" (`welcomeMessage` or `homeWelcome`). Board 00 sets `line-height:1.25` inline (ignore) |
| RTL | Watermark and close mirror to the left via logical properties; highlight moves to the top-right |

### 4.3 Logo tile

`.logo`: 48 × 48, `border-radius:15px`, `background:#fff`, initial in `--a` 21px / 700, centred, `box-shadow:0 6px
14px -6px rgba(0,0,0,.35)`. Production: `identityAvatarHtml('md')` (`span.wy-avatar`, map §4) with a new modifier
(suggested `.wy-avatar-tile`): `config.logoUrl` → the image fills the tile clipped to the 15px radius (image fit is
not specified; suggestion `object-fit:cover`); otherwise the workspace initial (fallback `W`). `showLogo === false`
→ no tile (production rule), the top row keeps only the close button.

### 4.4 Icon buttons

| Variant | Spec |
|---|---|
| `.ib` | 36 × 36, `border-radius:12px`, transparent, `color:var(--ink-2)`; hover `background:var(--bg-2); color:var(--ink)`; `transition:background-color .15s,color .15s`; icon 20px |
| `.ib.dk` (on the hero) | `background:rgba(255,255,255,.15); color:#fff`; hover `.25` |
| `.tools .ib` (composer) | 34 × 34, `border-radius:10px`, `color:var(--ink-3)` |
| Mobile | 44 × 44, `border-radius:14px` (also composer tools) |
| Circular `.ib` (recorder delete) | inline `border-radius:50%` |
| File download `.file .ib` | 32 × 32, `border-radius:10px`, `#fff`, `box-shadow:0 0 0 1px var(--line)`, icon 16px |

Production: `button.wy-back[data-view-back]` (back), `button.panel-close` (close), composer buttons (§4.17). "More
options" (⋯, 00/04, 03/04, 03/05, 05) has no menu in the design: do not ship it until a menu exists (§9).

### 4.5 Cards

| Card | Spec | Production |
|---|---|---|
| Base `.cd` | `display:block; padding:16px; border-radius:20px; background:#fff; box-shadow:var(--sh-2)`. Link cards `a.cd`: `transition:transform .2s var(--ease),box-shadow .2s`; hover `translateY(-1px)` + card-hover shadow (§3.4) | `section.home-section` / new wrappers |
| Team card (01/02) | `.tm` row (flex, center, gap 12): avatar stack (3 × 36px, §4.6) + `.t1` "Chat with our team" + `.t2` (live dot + "Online · replies in minutes"); then `.btn.btn-p` (`margin-top:14px`) "Start a conversation" + send plane | Avatars: `vm.teamMembers` (today only members with an uploaded photo; the design draws initials, §9). Button: `button.wy-btn.wy-btn-primary[data-home-action=chat]` with `homeStartChat`; the production `span.home-stack` moves out of the button into `.tm` |
| Away card (01/08) | Same, with `.avs.dim` (`filter:grayscale(1); opacity:.6`), `.t1` "We're away right now", `.t2` empty ring + "Back at 9:00 AM", `.note` (§4.22), button "Leave a message" (`margin-top:12px` after the note) | `isOnline=false`; `homeLeaveMessage`; "Back at …" is new data |
| Recent card (01/03) | `a.cd`, `padding:12px 14px 14px`: `.cap` "Recent message" (`margin:0 2px 8px`), then one `.rrow` (gap 12): avatar 40 with presence + `.lx` (`.l1` name + `.tm-s` time; `.l2.u` preview `<em>` ellipsised + `.nb` count) | `section.home-recent`: one compact row `button.conv-row.conv-row-compact[data-conversation-open]` (production shows up to 3; the design shows the latest one); this card is also the "continue" action, so the production `wy-btn-primary[data-conversation-open]` is not rendered separately (keep the hook on the card) |
| CTA card `.cd.cta` (01/03, 08/12) | `display:flex; align-items:center; gap:12px; padding:14px 16px`: avatar stack (28px) + `.lx` (`flex:1`) `.t1` + `.t2` + `.ra` with send plane (`aria-hidden`; the whole card is the link) | 01/03: `button[data-home-action=chat]` (`wyStartNew`); 08/12: `button[data-kb-action=switch-chat]` |
| Help card (01/02) | `padding:12px 14px 4px`: `.sr` search (§4.9) + `.ls` rows (`margin-top:4px`) of article titles + chevron | `section.home-section` with `button.home-chip[data-home-article]` per row (§4.10); `.home-chip-more[data-view=help]` stays in the DOM, hidden (the Help tab replaces it); `h3.home-section-title` hidden (not drawn) |
| Caption `.cap` | `display:block; margin:0 2px 8px; 12px/700; --ink-3` | `h3.home-section-title` |

### 4.6 Avatars, stacks, presence, live dot

| Element | Spec |
|---|---|
| `.av` | Circle, `display:grid; place-items:center`, 36px, 13px / 700, line-height 1. Sizes: s24 (10px), s28 (11px), s40 (15px), s44 (16px), s48 (17px). Colour pairs `.c1`–`.c4` (§3.1); with a photo the image fills the circle |
| Stack `.avs` | `display:flex`; each avatar after the first `margin-inline-start:-10px`, ring `0 0 0 2.5px #fff`. Welcome block: 48px, `-13px`, ring 3px |
| Presence `.av .pr` | Absolute `bottom:-1px; inset-inline-end:-1px`, 12 × 12 circle, Signal, ring `0 0 0 2.5px #fff`. Away `.pr.off`: `#fff` with `inset 0 0 0 2.5px var(--away)` + `0 0 0 2.5px #fff` |
| Live dot `.live` | 7 × 7 circle, Signal, halo `0 0 0 3px color-mix(in oklab,var(--sig) 22%,transparent)`. Away `.live.off`: `#fff` with `inset 0 0 0 2px var(--away)`. In the "Open" tag: 6 × 6, no halo (inline) |

Production: `span.wy-avatar` (`identityAvatarHtml`), `span.msg-avatar`, `home-stack-item`. Colour assignment of
`.c1`–`.c4` to people is not specified (suggestion: a stable hash of the name). A visible presence dot is new
(production's `[data-presence]` is screen-reader only and `.wy-online-dot` is never emitted).

### 4.7 Buttons

| Variant | Spec |
|---|---|
| `.btn` | `display:flex; align-items:center; justify-content:center; gap:8px; width:100%; height:48px; border:0; border-radius:14px; 15px/600; white-space:nowrap`; `transition:transform .16s var(--ease),filter .2s,box-shadow .2s,background-color .2s` |
| `.btn-p` | `color:#fff` (→ `--on-a`); `background:linear-gradient(180deg,var(--a-hi),var(--a) 70%)`; shadow §3.4. Hover `filter:brightness(1.06); transform:translateY(-1px)`; active `filter:brightness(.97); transform:none` |
| `.btn.sm` | 40 high, `border-radius:12px`, 13.5px |
| Trailing icon | Send plane 18px (`.pl`, mirrored in RTL) |
| Disabled | not drawn; suggestion: `.ra.off` colours (§4.8) |

Production: `.wy-btn.wy-btn-primary` (home CTA, pre-chat submit `[data-prechat-submit]`, fallback submit
`[data-fb-submit]`, `kb-feedback-cta`). Remove the inline accent background of the smart home-card CTA (PD:902,
brief §2.6).

### 4.8 Round action button `.ra` (mic, send, stop, play)

`display:grid; place-items:center; 38 × 38; border-radius:50%; background:var(--a-2); color:var(--a-ink);
box-shadow:inset 0 0 0 1px var(--a-3); transition:transform .2s var(--ease),background-color .2s`. Mobile 46.

| State | Spec (04/3 spec card text in quotes) |
|---|---|
| Mic | "Empty field": mic icon 20px |
| Hover | "106% · deeper tint": `background:var(--a-3); transform:scale(1.06)` |
| Pressed | "94%": `transform:scale(.94)` (spec card shows the `--a-3` fill) |
| Send | "While typing": send plane 19px |
| Disabled | "Sending": `.ra.off{background:#EEF0F3; color:#AEB3BE; box-shadow:none; cursor:default}`, no hover scale |
| Stop recording | "Soft Signal": `background:color-mix(in oklab,var(--rec) 10%,#fff)`, ring `inset 0 0 0 1px color-mix(in oklab,var(--rec) 24%,#fff)`, icon `--sig-d` 13px |
| Swap | "Only the icon changes once typing starts: a fade and a 90° turn in 180 ms. 38px on desktop, 46px on mobile." Flow: Empty → Typing → Recording |

Production: one visual spot at the inline end of the composer's tool row. `button.mic-btn[data-mic-btn]` shows while
the draft is empty, `button.send-btn[data-send-btn]` while there is a draft (`.input-bar.has-draft`); both take this
look (§4.17). Without voice notes the send button is always shown; its empty-draft look is not specified (suggestion:
`.ra.off` while there is no draft and no attachment).

### 4.9 Search field `.sr`

`display:flex; align-items:center; gap:10px; height:44px; padding:0 14px; border-radius:14px; background:var(--bg);
box-shadow:inset 0 0 0 1px var(--line); color:var(--ink-3); 14px`. Search icon 18px. Input: `flex:1; border:0;
background:transparent; color:var(--ink)`; placeholder `--ink-3`. Focus `.sr.fo`: `background:#fff;
box-shadow:inset 0 0 0 1.5px var(--a),0 0 0 4px var(--a-3)` (08/10). Mobile: 48 high, 15px, icon 20px.

Placeholders: Home "Search for help" (00/02: "Search help articles"), Home while away "Your answer may be in Help",
Help "Type your question…". Production: compose `kbSearchBarHtml` (`div.kb-search-wrap > input.kb-search`, PD:1345,
exported, never used) with a hook Core binds (suggested `data-kb-search`); typing on Home opens Help with results
(`kbHtml` state `searching` / `results`). New (§9).

### 4.10 List rows, icon tiles, badges, status tags

| Element | Spec |
|---|---|
| Row `.li` | `position:relative; display:flex; align-items:center; gap:12px; min-height:46px; margin:0 -8px; padding:10px 8px; border-radius:12px; color:var(--ink); 14px/1.4`; `transition:background-color .15s`; hover `background:var(--bg)` |
| Divider | `.li + .li::before`: absolute `top:0; inset-inline:8px; height:1px; background:var(--line)`; hidden on the hovered row and the one after it |
| Chevron `.ch` | 18px, `margin-inline-start:auto; color:var(--ink-4)`; row hover: `color:var(--a-ink); transform:translateX(3px)` (LTR; `-3px` in RTL), `.2s var(--ease)` |
| Icon tile `.lt` | 36 × 36, `border-radius:11px; background:var(--a-2); color:var(--a-ink)`, icon 18px. On grey cards (intro, banner) `#fff` with `box-shadow:0 0 0 1px var(--line)` |
| Text block `.lx` | `flex:1; min-width:0`: `.l1` (flex, baseline, space-between, gap 8) + `.l2` (flex, gap 8; `<em>` ellipsis) + `.l3` |
| Badge `.nb` | `min-width:20px; height:20px; padding:0 6px; border-radius:10px; background:var(--sig-d); color:#fff; 11px/1/700` |
| Tag `.tg` | `display:inline-flex; align-items:center; gap:5px; height:20px; margin-top:5px; padding:0 8px; border-radius:99px; 11px/700`. `.tg.open`: `#FFEAE4` / `#A62A12` with a 6px Signal dot; `.tg.done`: `var(--bg-2)` / `--ink-3` |

Production: Home article rows → `button.home-chip[data-home-article]` (gains the row look); Help rows →
`button.kb-article[data-kb-action=open][data-kb-slug]` with `span.kb-article-title` + `span.kb-article-chevron`;
conversation rows → `button.conv-row` (`.conv-name` = `.l1` text, `.conv-time` = time, `.conv-preview` = `<em>`,
`.conv-unread` = `.nb`, `.conv-status` = `.tg`; `.conv-status.is-resolved` = `.tg.done`; `.conv-status-dot` = the
6px dot, hidden when resolved). Unread count format: `fmtNum`, `99+` above 99 (production).

### 4.11 Section header and "All conversations" link

`.sh`: `display:flex; align-items:center; justify-content:space-between; gap:8px; margin:0 2px 6px; 13.5px/1.5/700`
("Most read", 08/10). `.more` (only with no bottom menu): `display:flex; align-items:center; align-self:flex-end;
gap:2px; height:30px; margin:-6px 2px -4px; padding-inline:8px 4px; border-radius:9px; 12.5px/700; color:var(--a-ink)`;
hover `background:var(--bg-2)`, `.15s`; chevron 16px stroke 2.2. Production: `button.home-link[data-view=list]` +
`span.home-link-chevron` (text "All conversations").

### 4.12 Bottom menu (dock)

Markup (design): `nav.tabs.vb[aria-label="Widget sections"] > a.tab(.on)[aria-label][aria-current=page] >
span.tic(svg.i-o + svg.i-f [+ span.nb]) + span.tl`. Suggested production markup (new, appended to `homeHtml`,
`conversationListHtml` and the `kbHtml` list/results states, after the footer):

```html
<nav class="wy-tabs tabs vb" aria-label="Widget sections">
  <button type="button" class="wy-tab tab on" data-view="home" aria-current="page" aria-label="Home">…</button>
  <button type="button" class="wy-tab tab" data-view="list" aria-label="Messages, 2 unread">…<span class="nb">2</span>…</button>
  <button type="button" class="wy-tab tab" data-view="help" aria-label="Help">…</button>
</nav>
```

Core navigation must accept `data-view="home"` (`list` and `help` exist, map §6.3). The Messages badge is the total
unread count (sum of `conversations[].unreadCount`; format suggestion: as conversation rows, `99+`); omit the badge at
0 and drop ", N unread" from the label.

| Part | Spec (`.vb`, floating dock; the only style drawn for Respok) |
|---|---|
| Bar | `position:relative; z-index:3; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:4px; flex:none; height:60px; margin:0 12px 12px; padding:6px; border-radius:22px; background:#fff`; shadow §3.4 |
| Tab | `display:flex; align-items:center; justify-content:center; gap:7px; border-radius:16px; 12.5px/1.3/600; color:var(--ink-3); white-space:nowrap`; `transition:color .2s,background-color .25s,box-shadow .25s`; label `.tl` hidden |
| Hover | `color:var(--ink-2); background:var(--bg)` |
| Active `.on` | `color:var(--a-ink); background:var(--a-2); box-shadow:inset 0 0 0 1px var(--a-3)`; filled icon; label shown 13.5px/700 |
| Icon box `.tic` | 24 × 24 grid, svg 24 × 24; press `.tab:active .tic{transform:scale(.9)}` (`.2s var(--ease)`). Icons §3.6; the Messages tab carries the Open and the Thread twins (`g-o`, `g-t`), Thread = the two-pill icon of §4.1 |
| Badge | `.tic .nb`: absolute `top:-6px; inset-inline-start:-10px`; `min-width:18px; height:18px; padding:0 5px`; Signal Deep, white, 10.5px/700; ring `0 0 0 2.5px #fff` (on the active capsule `0 0 0 2.5px var(--a-2)`) |

Modes (setting `navMode`, super-admin; class on each view root `.wy-view`; 02/A–E):

| Mode | Class | Changes |
|---|---|---|
| Icons + labels (A) | `nv-both` | Bar 64 high; tab is a column, gap 1; icon 22 × 22; label `display:block; 11.5px/1.4/600` (active 700); badge moves to `inset-inline-end:-12px` |
| Icons, active label (B, default) | none | As above |
| Icons only (C) | `nv-icon` | Active label hidden too |
| Labels only (D) | `nv-text` | Labels `13.5px/600` (active 700) on every tab; icons hidden; the badge sits after the label (`.tic{order:2}`, static, no ring); a `.tic` without a badge is not displayed |
| No menu (E) | `nv-none` | No dock (footer drops to the panel bottom); Home shows the `.more` link "All conversations" under the recent card; the Messages and Help title bars show their back button (`.ttl` `padding-inline-start:8px`, `.bk` displayed) |

Other bar styles exist in `widget.css` (`navStyle`): `.va` classic bar (70 high, white, top hairline, column tabs,
active `--a-ink` 700 with a 5px accent diamond under it), `.vc` segmented control (58 high, `--bg-2` track, active
white pill with an accent icon), `.vd` brand dock (62 high, `--hero` fill, active white pill). They are not drawn for
Respok; with the Respok badge rule they show a Signal Deep badge with 700 weight, ring white (`.va`, active `.vc`),
`--bg-2` (inactive `.vc`) or `color-mix(in oklab,var(--a) 85%,#000)` (`.vd`); the badge sits at `inset-inline-end:-10px`
in `.va` and at `inset-inline-start:-10px` in `.vb`, `.vc`, `.vd`. Mobile: dock 64 high (68 in mode A),
`margin-bottom:34px` (§2.5).

### 4.13 Screen headers

| Header | Spec | Production |
|---|---|---|
| `.hd` (conversation, pre-chat, article, away) | 68 high, `padding:0 10px; gap:4px`; white; `box-shadow:0 1px 0 var(--line)`; `z-index:2`. Back `.ib`; identity `.who` (flex, gap 10, `padding-inline:4px`): avatar s40 + presence, then `.hn` (15px/1.4/700, one line, ellipsis) and `.hs` (12px/1.45 `--ink-3`, one line, ellipsis); [more]; close | `div.header.wy-head.wy-head-chat[data-chat-header]` / `div.wy-head`: `button.wy-back` = back `.ib`, `span.wy-avatar.wy-avatar-md` = avatar, `span.wy-head-title` = `.hn`, `span.wy-head-sub` = `.hs`. Keep `div.presence.sr-only[data-presence]` |
| Header variants | Conversation: avatar of the agent + "Sara · Nilufar Store" + "Online · replies in minutes". New conversation (03/06): no avatar, "New conversation" + "Nilufar Store". Pre-chat (06/07): no avatar, "Connect to support" + "Nilufar Store". Away (06/09): store avatar `N` (`.c4`) + away presence, "Nilufar Store" + "Away · replies by email". In-chat pre-chat (07): avatar `S` + "Nilufar Store" + "Online · replies in minutes". Article (08/12): no avatar, category "Orders and shipping" + "5 articles" | The agent name in the title, the category in the article header and the header variants are new data (§9). Production title today: workspace name; subtitle `replyTimeText` |
| `.ttl` (Messages, Help) | `display:flex; align-items:center; gap:8px; height:64px; padding-inline:20px 12px; background:#fff`; `h2` `flex:1; margin:0; 19px/700`; close `.ib`. Back `.bk` hidden unless `nv-none` | `div.wy-head.wy-head-list` (`.wy-head-plain` = h2 text, `button.wy-back[data-view-back=home]` = `.bk`); Help list: `div.wy-head` |

### 4.14 Thread: day divider, groups, bubbles, meta, receipts

Design: `.th > .day + .grp.(L|R) > [.av.s28] + .stk > [.nm] + .bb… + .mt`. Production row contract (map §5.1): one
`.msg-row.(operator|visitor)` per bubble; a group is a run ending with `.msg-row.is-last`; `.msg-col > .msg-line >
.msg + .msg-actions`; `.msg-footline > .msg-meta` on `.is-last` only. Map the design onto it:

| Design | Spec | Production |
|---|---|---|
| Day divider `.day` | `display:flex; align-items:center; gap:10px; margin:4px 10px 14px; 11.5px/600 --ink-3`; `::before`/`::after` `flex:1; height:1px; background:var(--line)` | `div.msg-day > span` (INTL:164-172 today: a pill; replace) |
| Group `.grp` | `display:flex; align-items:flex-end; gap:8px; max-width:86%; margin-bottom:14px`; visitor `align-self:flex-end`, operator `flex-start` (physical in both directions). The 86% includes the operator avatar and gap | `.messages{gap:14px}` and `.msg-row:not(.is-last){margin-bottom:-11px}` (3px between bubbles); visitor `.msg-col{max-width:86%}`, operator `.msg-col{max-width:calc(86% - 36px)}` with an avatar (INTL today 78%); topics prompt group 92% (inline in 03/06) |
| Stack `.stk` | `flex column; gap:3px; min-width:0` | consecutive rows |
| Operator avatar | `.av.s28` beside the last bubble, `margin-bottom:21px` (its bottom edge is level with the last bubble's bottom; 21 ≈ meta line 15.4 + 2 + 3 gap) | `span.msg-avatar` on `.is-last` (+ spacer on earlier rows): on rows with a footline set `margin-bottom` to footline height + gap, which replaces INTL:153-161 (centred on the first line). Production shows an avatar only with an uploaded photo; the design draws initials (§9) |
| Sender name `.nm` | `margin:0 12px 1px; 11.5px/1.4/600 --ink-3`, above the first bubble of an operator group; boards show it only on the first group of an operator in a run (11/15 omits it on Sara's second group, 03/04 on the typing group) | New: `span.msg-sender-label` on the first row of an operator run (`is-first` = previous group key differs) |
| Bubble `.bb` | `width:fit-content; max-width:100%; padding:9px 14px; border-radius:20px; 14.5px/1.5; overflow-wrap:anywhere` | `.msg` |
| Operator bubble | `background:var(--op); color:var(--ink)` | `.msg.operator` |
| Visitor bubble | `color:#fff` (→ `--on-a`); `background:linear-gradient(180deg,var(--a-hi),var(--a) 70%)`; `box-shadow:0 1px 2px color-mix(in oklab,var(--a) 28%,transparent)` | `.msg.visitor`; remove the inline `style="background:<primaryColor>"` (PD:665) |
| Join corners | Operator: a bubble followed by another gets `border-bottom-left-radius:6px`, a bubble after another gets `border-top-left-radius:6px`; visitor the same on the right. The last bubble keeps its outer bottom corner at 20px (no tail); a single bubble is round on all corners. An operator bubble followed by a form card `.fcard` or email card `.ec` also joins: bubble bottom-left 6px, card top-left 6px | `.msg-row.operator:not(.is-last) .msg` → bottom-left 6; `.msg-row.operator:not(.is-last) + .msg-row.operator .msg` → top-left 6 (mirror for visitor). Replace INTL:124-127 (which squares every bubble's bottom corner); `.has-tail` gets no tail |
| Meta `.mt` | `display:flex; align-items:center; gap:4px; margin:2px 8px 0; 11px/1.4 --ink-3`: time, then receipt glyph or status | `.msg-footline > .msg-meta` |
| Read | Double tick 16px stroke 2, `color:var(--a)`, `role=img aria-label="Read"` | `span.msg-ticks.is-seen` |
| Delivered | Single tick 15px stroke 2.2, `--ink-3`, `aria-label="Delivered"` | design: delivered = single tick. Production today draws a double tick for `delivered`; follow the design |
| Sent (06/09) | Text "· Sent" after the time | new string for `sent` when the team is away (suggestion) |
| Sending | not drawn; keep production's spinner | `.msg-ticks.is-sending` |
| Failed | `.grp.fail .bb{opacity:.55}`; meta: error icon 14px + `span.er` "Not sent" (700, `--bad`) + " · " + `button.retry` "Try again" (`padding:0; border:0; background:none; 11px/700; --bad; underline, offset 2px`) | `span.msg-ticks.is-failed` (→ icon + `msgFailed`), `button.msg-retry-btn[data-msg-retry]` (`retry`) |
| Time format | "7:42 PM" | `formatMsgTime` uses `hour:'2-digit'` → "07:42 PM" in English; use `hour:'numeric'` for non-fa locales |
| Reply/copy actions | not drawn | keep `span.msg-actions` (hover/focus reveal, absolute beside the bubble, INTL:132-135) |

Rich content inside bubbles:

| Element | Spec | Production |
|---|---|---|
| Quote `.qt` | `display:block; margin:1px -6px 6px; padding:6px 10px; border-radius:12px; 12.5px/1.6`; visitor `rgba(255,255,255,.17)`, operator `rgba(15,18,23,.05)`; author line `b` 11.5px/700, opacity .9 ("Sara") | `span.msg-quote`; the author line is new (`replyTo` author; omit when unknown) |
| Link card `.lnk` | `display:flex; align-items:center; gap:10px; margin:8px -5px 2px; padding:8px 10px; border-radius:14px; background:#fff; color:var(--ink); box-shadow:0 0 0 1px var(--line)`; tile `.lt` 34 × 34 radius 10 with the link arrow; `b` title + `small` domain | `a.msg-link` (Core `linkifyHtml`). Title + domain need link-preview data (new); without it show the host as `b` and omit `small` (suggestion) |
| Inline code `.code` | `padding:1px 6px; border-radius:6px; background:rgba(15,18,23,.06)` (visitor `rgba(255,255,255,.18)`); DM Mono 12.5px; `white-space:nowrap; direction:ltr; unicode-bidi:isolate` | New formatting (tracking codes, inline code) |
| Mixed direction | `.ltr{direction:ltr;unicode-bidi:isolate}` for emails and file names | `.msg-text` keeps `unicode-bidi:plaintext; text-align:start` |

Entrance of new rows: not specified in the design; keep production `wy-msg-in .24s` (translateY 6px + fade).

### 4.15 Typing indicator

Operator group with the avatar, bubble `.bb.typ` (`display:flex; align-items:center; gap:6px; padding:15px 16px`;
operator colours) holding three round dots `i` (7 × 7, `--ink-3`, opacity .45; animation `rp-typ 1.3s ease-in-out
infinite`, delays 0 / .16s / .32s; keyframes: rest opacity .45, at 25% opacity 1 and `translateY(-3px)`), and the
meta line "Sara is typing…". New visible row (map §5.6): Core already calls `setOperatorTyping`; render
`div.msg-row.operator.is-last.typing-row` at the end of `[data-chat-messages]` (suggested data:
`view.operatorTyping {name, avatar}`), `aria-hidden="true"`, and keep `div.sr-only[data-typing-row]` for the
announcement. Restyle the AI thinking row (`.ai-thinking-bubble .typing-dots span`, production `wy-bounce`) with the
same dots.

### 4.16 Attachments

| Kind | Spec | Production (map §5.5) |
|---|---|---|
| Image (03/05) | No bubble. `.img`: 224 × 132, `border-radius:18px`, `overflow:hidden`; placeholder `repeating-linear-gradient(135deg,var(--a-1) 0 12px,var(--a-2) 12px 24px)` + `inset 0 0 0 1px var(--a-3)` with a 30px image icon in `--a-ink`; caption pill `.capn` (absolute `bottom:8px; inset-inline:8px`, 26 high, `padding:0 10px`, radius 9, `rgba(15,18,23,.58)`, `#fff` 11.5px, gap 6): file name (`.ltr`) + size at the inline end (opacity .8) | `button.msg-att-img-btn[data-att-preview]` (image `object-fit:cover` in the 224 × 132 frame; today max 168 × 190); the stripes are the loading/fallback look (`.is-loading`, `.msg-att-img-fallback`); keep `.msg-att-loading` + "Receiving…" for screen readers. Caption needs name + size (`att.name`, `humanSize`) |
| File (03/05) | Inside an operator bubble: `.bb.file` `display:flex; align-items:center; gap:10px; min-width:240px; padding:10px 10px 10px 12px`; type tile `.ft` 38 × 46, radius 9, `#fff`, `0 0 0 1px var(--line)`, label "PDF" 9.5px/700 `--bad` bottom-aligned (`padding-bottom:6px`); name `b` 13px/1.5/700; size `small` 11.5px `--ink-3`; download `.ib` (§4.4), `aria-label="Download invoice"` | `div.msg-att.msg-att-file > .msg-att-icon` (= `.ft`, label from the extension) + `.msg-att-meta(.msg-att-name + .msg-att-sub)` + `a.msg-att-action[data-att-download]` |
| Voice (03/05) | In a visitor bubble: `.bb.voice` `gap:10px; min-width:240px; padding:8px 14px; padding-inline-start:8px`; play `.pb` 36 circle `#fff`, icon 15px in `--a`, `box-shadow:0 2px 6px -2px rgba(15,18,23,.35)`; wave `.wave` (flex, gap 2.5px, 26 high): 18 bars 3px wide, radius 2, `currentColor`, unplayed bars `.d` opacity .42 (heights 8,14,20,12,18,24,16,10 played; 18,22,12,8,16,20,10,6,12,8 unplayed); time `.tm-s` 11.5px tabular, opacity .92 | `div.msg-att.msg-att-audio[data-audio-player][dir=ltr]`: `.wy-ap-play[data-audio-toggle]` = `.pb`; `.wy-ap-track[data-audio-seek]` + `[data-audio-progress]` drawn as the bar wave (bars before the progress point full, after it `.d`; real waveform data is new, use the design's static heights otherwise); `.wy-ap-time[data-audio-time]` = `.tm-s`. Rate `[data-audio-rate]` and download `.wy-ap-dl` are not drawn: keep the nodes, visually hidden. Fix `--wy-primary` (CSS:941) → `--a` |
| Pending attachment (03/05) | In the composer box above the textarea: `.pend` `display:inline-flex; align-items:center; gap:8px; align-self:flex-start; margin:0 4px 6px; padding:6px; border-radius:12px; background:var(--bg); box-shadow:inset 0 0 0 1px var(--line); 12.5px/1.4`; thumb 32 × 32 radius 8 (striped `--a-1`/`--a-2` 5px, ring `--a-3`); name + `small` size 11px `--ink-3`; remove 26 × 26 radius 8, `--ink-3`, hover `--bg-2`, X 14px | `div.att-preview[data-attach-preview]`: thumb `[data-attach-thumb]`, `[data-attach-name]`, `[data-attach-sub]`, progress `[data-attach-track]`/`[data-attach-bar]` (not drawn; suggestion: 4px bar like `.prog .bar i`), retry `[data-attach-retry]` (not drawn), remove `[data-attach-remove]`; `.is-error` not drawn (suggestion: `--bad` sub-line) |

### 4.17 Composer

| Part | Spec |
|---|---|
| Zone `.cmp` | `flex:none; padding:8px 12px 0; background:#fff` |
| Box `.cbox` | `display:flex; flex-direction:column; gap:2px; padding:11px 6px 5px; border-radius:20px; background:#fff`; shadow rest / focus `.fo` / recording `.rec` (§3.4); `transition:box-shadow .2s` |
| Textarea | `width:100%; height:26px; padding:0 9px; border:0; outline:0; resize:none; background:transparent; 14.5px/26px; --ink`; placeholder `#7A808C` "Write a message…" |
| Tools row `.tools` | `display:flex; align-items:center; gap:2px`: emoji `.ib`, attach `.ib`, then `.ra` (mic or send) pushed to the inline end (`margin-inline-start:auto`) |
| Locked `.cbox.lock` (07/A) | `flex-direction:row; align-items:center; gap:8px; padding:13px 14px; background:var(--bg); box-shadow:inset 0 0 0 1px var(--line); 13px --ink-3`; lock 16px + "Fill in the form above first" |

Production (map §5.7, keep every hook and the DOM order): `div.input-bar[data-input-bar]` → `.cmp` content;
`div.input-wrap[data-input-wrap]` → `.cbox` (`:focus-within` → `.fo`; `.input-bar.is-recording .input-wrap` → `.rec`
with `padding:8px 6px 6px`; `.is-voice-preview` → `padding:8px 6px`); `div.att-preview` stays before `div.input-row`.
Paint the fixed DOM order (`mic-btn`, `textarea`, `composer-actions > composer-actions-start > send-btn, attach-btn,
input[file], emoji-btn`) as the design rows with a grid on `.input-row` and `display:contents` on the two action
wrappers: textarea on row 1 spanning all columns; row 2 = emoji, attach, flexible gap, then the `.ra` cell holding
`mic-btn` (draft empty) or `send-btn` (`.has-draft`). Production send today is solid accent with a draft and opacity
.55 without; the design uses the `.ra` look in both cases (§4.8). Focus ring: the box ring replaces the input outline
(keep CSS:1437-1446, `.input-wrap .input:focus-visible{outline:none}`). Footer below the box (§4.26). The locked state is new
(suggested `.input-bar.is-locked` while a pre-chat card waits; Core keeps the textarea disabled).

### 4.18 Emoji picker (05)

Opens inside the composer box, above the textarea ("Tapping the emoji icon doesn't open a new screen: the composer
box itself grows upward and the emoji appear inside it. Tap again to fold it away.").

| Part | Spec |
|---|---|
| Panel `.epk` | Closed: `height:0; margin:0 3px -2px; padding:0; overflow:hidden; opacity:0`. Open (`.cbox.emo`): `height:246px; margin:0 3px 6px; padding:2px 0 8px; opacity:1`; flex column, gap 8; bottom rule `box-shadow:inset 0 -1px 0 var(--line)`; `role="dialog" aria-label="Emoji picker"` |
| Search `.ep-sr` | 36 high, `padding:0 12px; gap:8px; border-radius:12px; background:var(--bg); box-shadow:inset 0 0 0 1px var(--line); 13px --ink-3`; icon 16px; placeholder "Search emoji" |
| Categories `.ep-cats` | 6-column grid, gap 4; `role="tablist" aria-label="Emoji categories"`; each `.ep-cat` 32 high, radius 10, `--ink-3`, icon 19px; hover `--bg` / `--ink-2`; selected `.on` `background:var(--a-2); color:var(--a-ink); box-shadow:inset 0 0 0 1px var(--a-3)`, `role="tab" aria-selected` |
| Grid `.ep-grid` | `flex:1; min-height:0; overflow:hidden` (production: scroll), bottom fade `mask-image:linear-gradient(to bottom,#000 74%,transparent)` |
| Section header `.ep-h` | `margin:0 6px 2px; 11.5px/1.7/700 --ink-3`: "Frequently used", "Smileys" |
| Rows `.ep-row` | 8-column grid, gap 2, `margin-bottom:2px`; cell `.ep-e` 38 high, radius 11, emoji 23px; hover `background:var(--bg-2); transform:scale(1.14)`; just inserted `.hit` `background:var(--a-2); box-shadow:inset 0 0 0 1px var(--a-3)` |
| Toggle | `.tools .ib.on`: `background:var(--a-2); color:var(--a-ink); box-shadow:inset 0 0 0 1px var(--a-3)`, icon `rotate(-14deg) scale(1.06)`; label "Emoji" / "Close emoji"; `aria-expanded` |
| Insert | The chosen emoji goes into the same box at the caret ("Perfect, thank you" + U+1F60D) |

Content: categories Frequently used (8 emoji, `G.recent` in the board script), Smileys, People and hands, Hearts and symbols,
Nature, Food and drink (lists in the board script). Production: `div.emoji-picker[data-emoji-picker]` filled by Core
with 50 `button.emoji-item[data-emoji]` (map §5.7; 6 columns today). Suggested: render the picker node as the first
child of `div.input-wrap` so the box ring encloses it (verify Core's outside-click handling); otherwise draw the joined
ring on the picker and the box. `button.emoji-btn[aria-expanded=true]` → `.on`. Categories, search and "Frequently
used" are new; without them show the 50 items in the 8-column grid with no header.

### 4.19 Voice recorder and preview (04)

| Part | Recording (04/1) | Preview (04/2) |
|---|---|---|
| Box | `.cbox.rec`, `padding:8px 6px 6px` (75.3 tall) | `.cbox`, `padding:8px 6px` (58 tall), no focus ring |
| Row `.rbar` | flex, center, gap 6 | same |
| Left | Delete `.ib` round (36, `border-radius:50%`), trash 19px, "Cancel recording" | Same button, "Delete recording" |
| Time | `.rtm` (flex, gap 7, `min-width:56px`, 13.5px/700 tabular): red dot `.rdot` 9px `--rec` pulsing + "0:08" | Play: `.pring` ring 42 (`padding:2px; border-radius:50%; background:conic-gradient(var(--a) 0 35%,var(--a-3) 35% 100%)`) around `.ra` 38 with `box-shadow:0 0 0 2px #fff`, play icon 15px; "Play — 5 of 14 seconds" |
| Wave | `.wv.rt` (flex, gap 2, 30 high, `--a`): 20 bars 3px, radius 2 (heights 6,10,16,9,20,26,14,8,18,24,12,6,15,22,28,17,10,20,13,24); the last 6 bars pulse | `.wv` with `margin-inline:4px`: 18 bars, 7 played (`--a`), 11 unplayed `.d` (`--line-2`) |
| Right | `.ra.stop` "Stop recording" (§4.8), `.ra` send "Send voice message" | `.rtm` "0:14" (`min-width:34px; 600; --ink-3`), `.spd` "1×" (24 high, `padding:0 8px`, radius 8, `--bg-2`, 11.5px/700 `--ink-2`, "Playback speed"), `.ra` send "Send voice message" |
| Hint | `.hint` (flex, centered, gap 6, `margin-top:4px`, 11.5px `--ink-3`): `.kbd` "Esc" cancel · `.kbd` "Enter" send · up to 2 minutes; `.kbd{padding:0 6px; border-radius:6px; background:var(--bg); box-shadow:inset 0 -1px 0 var(--line-2),inset 0 0 0 1px var(--line); 11px --ink-2}` | — |

Production (map §5.7): `div.rec-bar[data-rec-bar]` → recording row (`rec-cancel[data-rec-cancel]` = delete,
`.rec-live > .rec-dot + .rec-time[data-rec-timer]` = `.rtm`, `.rec-wave` = `.wv.rt` (20 `i`), `rec-confirm[data-rec-stop]`
= `.ra.stop`, keep `[data-rec-sr]`). The direct "Send voice message" button while recording is new (suggested
`data-rec-send`; without it hide the button and stop → preview → send). `div.vn-bar[data-vn-bar][dir=ltr]` →
preview row (`vn-delete`, `vn-play[data-vn-toggle]` inside the ring; drive the ring from progress, e.g. a `--p`
custom property next to `[data-vn-progress]`; `vn-track[data-vn-seek]` = the wave; `vn-time`; `vn-send`). The speed
chip and the hint row are new (§9). `.vn-send:disabled` → `.ra.off`.

### 4.20 Form fields (06/07, 07)

| Part | Spec |
|---|---|
| Form `.fm` | flex column, gap 16, `flex:1; min-height:0; padding:20px 18px 8px` |
| Intro card `.intro` | flex, `align-items:flex-start; gap:12px; padding:14px; border-radius:16px; background:var(--bg); box-shadow:inset 0 0 0 1px var(--line); 13px/1.5 --ink-2`; tile `.lt` white with ring, person icon 18px; `b` title 14px/700 `--ink` on its own line |
| Field `.fld` | flex column, gap 6; label 13px/600 `--ink`; required `.rq` "*" `--bad` (`margin-inline-start:2px`); optional `.op` "(optional)" 12px/400 `--ink-3` |
| Input `.inp` | `width:100%; height:48px; padding:0 14px; border:0; border-radius:14px; outline:0; background:#fff; box-shadow:inset 0 0 0 1px var(--line-2); 14.5px --ink`; placeholder `#7A808C`; hover ring `--ink-4`; `transition:box-shadow .15s` |
| Focus `.fo` | `box-shadow:inset 0 0 0 1.5px var(--a),0 0 0 4px var(--a-3)` |
| Error `.er` | `box-shadow:inset 0 0 0 1.5px var(--bad),0 0 0 4px color-mix(in oklab,var(--bad) 12%,#fff)`; message `.err` (flex, gap 6, 12px/600 `--bad`) with the error icon 14px: "Enter a full email, like name@example.com" |
| Small `.inp.sm` | 42 high, `padding:0 12px; border-radius:12px; 13.5px` |
| LTR fields | Email and phone `dir=ltr`, left-aligned in English |
| Privacy `.priv` | flex, centered, gap 6, `margin:10px 0 0`, 11.5px `--ink-3`, lock 13px: "We only use your details to reply to you." |

Production (map §4.5, §5.15): `div.prechat-field[data-field] > label.prechat-label + span.prechat-req-mark` (= `.rq`)
+ `div.prechat-control > input.prechat-input` (= `.inp`) + `div.prechat-error[role=alert]` (= `.err`, hidden while
empty; add the icon when it has text). States: `:focus-within` on `.prechat-control` → `.fo`;
`[aria-invalid='true']` → `.er` (replaces `#e5484d`). Fix map Appendix A9: `.prechat-input[dir='ltr']` must be
left-aligned in an LTR widget. "(optional)" is new (render for fields that are asked but not required). The
privacy line uses the dead `.prechat-privacy*` classes (new markup).

### 4.21 Cards inside the conversation (07, 06/09)

| Card | Spec | Production |
|---|---|---|
| Form card `.fcard` (07/A) | Operator side, under the operator bubble (corners join): flex column, gap 10, `width:300px; padding:14px; border-radius:20px; background:#fff; box-shadow:var(--sh-2)`; `h4` (flex, gap 8, 14px/700) with tile `.lt` 28 × 28 radius 9 + "Your details"; fields with 12px `--ink-2` labels and `.inp.sm`; `.btn.btn-p.sm` "Start a conversation"; `.priv` "Only used to reply to you" (margin 0, lock 12px); meta "Just now" | `div.hc-card[role=group]` (`.hc-title` = `h4` text, `.hc-subtitle` = the operator bubble above it, `.prechat-fields.hc-fields`, `button.hc-submit[data-prechat-submit]`). Production renders it in a `.msg-row.visitor`; align it to the operator side with `.msg-row.visitor:has(> .hc-card){justify-content:flex-start}` (or render it as operator) |
| Email card `.ec` (06/09) | Operator side under the automated bubble: flex column, gap 8, `width:282px; padding:12px; border-radius:18px; background:#fff; box-shadow:var(--sh-2)`; label 12.5px/600 "Email for the reply"; row (gap 6): `.inp.sm` placeholder "name@example.com" + `.go` 42 × 42 radius 12 accent gradient, white check 18px, "Save email"; meta "Automated message" | New in-thread capture wired to the contact-fallback hooks (map §4.6): `input[data-fb=email]`, `button[data-fb-submit]` on `.go`, `div[data-fb-status]`; the visitor's thread message is the fallback message |
| Summary `.sum` (07/C) | Centered, `width:300px; margin-bottom:14px; overflow:hidden; border-radius:18px; background:#fff; box-shadow:var(--sh-2)`; header `.sh2` (flex, gap 8, `padding:10px 14px`, `#FFF1ED`, 13px/700 `#A62A12`, check-circle 16px) "Your details are saved" + `a` "Edit" (inline end, 12px/600 `--a-ink`); rows `.rw` (`justify-content:space-between; gap:10px; padding:9px 14px; box-shadow:0 -1px 0 var(--line); 12.5px`, label `--ink-3`, value bold) "Name"/"Email" | New (suggested hook `data-prechat-edit` on Edit) |
| Queue pill `.queue` (07/C) | Centered, flex, gap 8, `margin-bottom:14px; padding:4px 12px; border-radius:99px; background:var(--bg); box-shadow:inset 0 0 0 1px var(--line); 12px --ink-2`; live dot + "2nd in line · about 3 minutes" | Look for `div.msg-system-pill` (routing rows, map §5.2); position and wait time are new data |
| Step input (07/B) | In the composer box: `.prog` (flex, gap 10, `padding:0 8px 8px`, 11.5px/600 `--ink-3`) "Step 3 of 3 · optional" + bar (3 × 4px segments, gap 4, radius 2, done `--a`, todo `--line`) + `.skip` "Skip" (`margin-inline-start:4px; padding:0 4px; 12px/700 --a-ink`); `.ex` row: prefix `.pre` "+1" (`margin-inline-start:9px; padding-inline-end:8px; border-inline-end:1px solid var(--line-2); 14px --ink-2; direction:ltr`) + input "415 555 0132" (`dir=ltr`); tools: hint "For text updates" (`padding:0 9px; 12px --ink-3`) + `.ra.off` "Submit" | New |
| Step answers (07/B) | Invalid answer: visitor bubble `.fail` (opacity .55) + meta `span.er` "That email isn't complete" + " · e.g. name@example.com"; valid: meta "Saved" + check 15px in `--a` | New |

### 4.22 Away banner and note

`.ban` (06/09): flex, center, gap 12, `margin-bottom:16px; padding:12px 14px; border-radius:16px; background:var(--bg);
box-shadow:inset 0 0 0 1px var(--line)`; tile `.lt` white with ring, `--ink-2`, moon 18px; `b` 13.5px/1.5/700 "Our
team is away right now"; `small` 12px/1.5 `--ink-3` "Back at 9:00 AM · usually replies within 2 hours".
`.note` (01/08): flex, `align-items:flex-start`, gap 10, `margin:14px 0 0; padding:10px 12px; border-radius:14px;
background:var(--bg); box-shadow:inset 0 0 0 1px var(--line); 12.5px/1.5 --ink-2`, mail icon 18px `--ink-3`
(`margin-top:2px`).

### 4.23 New-conversation welcome and topic chips (03/06)

`.wel`: flex column, centered, `padding:22px 18px 4px; text-align:center`; stack of 48px avatars (`-13px`, ring 3px);
`h3` 17px/1.5/700 "Nilufar Store support" (`margin:12px 0 2px`); `p` (flex, gap 6, 12.5px/1.55 `--ink-3`) live dot +
"We usually reply in a few minutes". Separator `.sep`: 1px `--line`, `margin:18px 6px`. Then the operator group
(`max-width:92%`): "Hi! How can we help?" and "Pick a topic so we can connect you with the right person faster:" as
two bubbles, meta "Just now".
Chips `.chips` (flex, wrap, gap 8): `.chip` 36 high, `padding:0 14px; border-radius:12px; background:#fff;
box-shadow:inset 0 0 0 1px var(--line-2); 13px/600 --ink`; hover `--bg`; selected `.on` `background:var(--a-2);
color:var(--a-ink); box-shadow:inset 0 0 0 1.5px var(--a)`; `transition:background-color .15s,box-shadow .15s`.
Production: `emptyHtml` (`div.messages.welcome-only`) gains the `.wel` block (team = `config.teamMembers`, title new,
status = `replyTimeText`) and splits `welcomeMessage` lines into separate bubbles (suggestion); topics reuse
`div.qna-suggestions[data-qna]` (`button.qna-chip[data-qna-question]` = `.chip`, `.qna-title` visually hidden,
`.qna-more-btn` = chip "+N") or a new `data-topic` sent as the first message (brief §9).

### 4.24 Help center (08)

| Part | Spec |
|---|---|
| Top block | White, `box-shadow:0 1px 0 var(--line)`: `.ttl` "Help" + search block (`padding:0 16px 14px`) with `.sr` (focused state drawn: `.sr.fo`) |
| Categories card | `.cd` `padding:4px 14px`: rows with `.lt` icon tile (box, card, tag icons), `.l1` name 14px/700, `.l3` "5 articles" 12px/500 `--ink-3`, chevron; row height 56.4 |
| Most read card | `.cd` `padding:12px 14px 4px`: `.sh` "Most read" + title rows |
| Article `.art` | `h1` 21px/1.3/700 (`margin:0 0 8px`); meta `.am` (flex, gap 8, `margin-bottom:16px`, 12px `--ink-3`): avatar s24 + "Sara · 2 min read · Updated 3 days ago"; `p` 14.5px/1.65 `#272B34` (`margin:0 0 12px`); `h2` 16px/700 (`margin:16px 0 8px`); links `600; --a-ink; underline 1px, offset 3px`; steps `.steps` (column, gap 8, no bullets): `li` (flex, gap 10, 14.5px/1.65) with number `b` 24 × 24 radius 8 `--a-2` 12px `--a-ink` (`margin-top:3px`); tip `.tip` (flex, gap 10, `padding:12px 14px; border-radius:14px; background:var(--a-1); box-shadow:inset 0 0 0 1px var(--a-3); 13px/1.55 --ink-2`, info icon 16px `--a-ink`, `margin-top:3px`) |
| Feedback `.fb` | flex, center, space-between, gap 10, `padding:12px 18px 4px; border-top:1px solid var(--line)`; question 13px/600 "Was this article helpful?"; buttons (`.fbb`, gap 6): 36 high, `padding:0 12px; border-radius:11px; background:#fff; box-shadow:inset 0 0 0 1px var(--line-2); 13px/600 --ink-2`, thumb 16px, hover `--bg`: "Yes", "No" |
| Ask card | `.cd.cta.ask` (`margin:10px 14px 0`): avatars 28 (S, M) + "Still have a question?" + live dot "Chat with our support team" + `.ra` |

Production (map §4.4, §5.14): list → `kbHtml` with `kbHomeHtml` (`button.kb-article` rows = "Most read"); categories
exist in the view-model but are ignored today (new: category rows and a category view; without it hide the card);
search → `kbSearchBarHtml` + hook (§4.9). Article header → `div.wy-head.wy-head-article` keeps
`button.wy-back[data-view-back=back][data-view-back-fallback=home]`; the design shows the category + count in the
header and the article title as `h1` in the body (`vm.article.title`); hide the header `.wy-avatar`. Body =
`vm.article.contentHtml` (unescaped HTML): style `h1/h2/p/a/ol/ul` with the `.art` rules; mapping `ol` to `.steps`
(CSS counters) and a callout element to `.tip` is a suggestion (the KB editor's markup is not known). Meta line data
(author, read time, updated) is new. Feedback → `div.kb-feedback[data-kb-feedback]` (`.kb-feedback-q`, `.kb-rate[data-kb-rate=up|down][aria-pressed]`
labels "Yes"/"No"); selected state not drawn (suggestion: `.chip.on` look); `.kb-feedback-thanks` not drawn. The ask
card is `data-kb-action=switch-chat`, shown always (production shows its CTA only after a "down" rating).

### 4.25 Skeleton rows

`.sk` (06/13): flex, center, gap 12, `padding:12px 0`; bars `i` radius 8, `background:linear-gradient(90deg,var(--bg-2) 0%,var(--bg) 50%,var(--bg-2) 100%)`,
`background-size:200% 100%`, `animation:wy-sh 1.4s linear infinite` (`background-position` 200% 0 → -200% 0). Row:
44px circle + two lines 12px and 10px tall (widths 45% / 80%, then 35% / 70%, gap 8); the second row at opacity .55;
`aria-label="Loading"`. Production: `skeletonConvRowsHtml` and the `.wy-sk*` primitives (map §4.8; 1.6s shimmer today).
Other skeletons are not drawn: build each from its real view's new geometry (hero 233, header 68, title bar 64,
composer box 82 + footer 32, dock 60 + 12) so the crossfade does not jump (brief §2.7).

### 4.26 "Powered by" footer

`.pw`: flex, centered, gap 5 (respok.css), `flex:none; height:32px; 11.5px --ink-3`; "Powered by" + lockup `svg.lk`
(`role="img" aria-label="Respok"`): Open 49 × 12, Thread 53 × 12, mark and wordmark `#16142B` (hover `#000`), accent
piece `#FF5A3C`. On Home and Help it sits at the bottom of the card stack, above the dock; on other screens under the
composer or content.
Production (map §5.10): `div.wy-footer > span.wy-conn[data-conn-indicator] + a.wy-powered > span(label) +
img.wy-powered-logo[data-wy-brand-logo]`. An `<img>` cannot take `currentColor`, so either inline the lockup SVG in
place of the image when the platform is Respok (exact look, hover included; preferred), or serve lockup files whose
`currentColor` parts are filled `#16142B` at `height:12px` (INTL:47-53 today 14px). The wordmark is drawn, never typed
([brand sheet](../README.md)); files: [`respok-lockup-open.svg`](../../shared/brand/respok/respok-lockup-open.svg),
[`respok-lockup-thread.svg`](../../shared/brand/respok/respok-lockup-thread.svg). The connection indicator is not
drawn: keep the node (sibling, never inside the link) and its connecting/degraded animation; hide the dot in the
`online` state (suggestion). A view without a footer simply ends (production rule).

### 4.27 Launcher (RESPOK kit, 09)

Spec text of the board tiles in quotes.

| State | Spec | Production (`.launcher.rpk-kit`, map §3.3) |
|---|---|---|
| Rest | 60 × 60 circle, `background:var(--rpk-color,#16142B); color:var(--rpk-on,#fff)`; shadow `0 10px 28px rgba(22,20,43,.28)` ("Ink circle, white mark, Signal dot · shadow 0 10 28 Ink 28%") | Same (`.rpk-kit-brand`) |
| Glyph | Thread: viewBox `0 0 104 92`, 50% wide; main pill `--rpk-on`, answer pill `--rpk-accent` (`#FF5A3C`). Open: viewBox `0 0 108 108`, 47% wide; bubble `M41 0A41 41 0 0 1 82 41L82 78Q82 82 78 82L41 82A41 41 0 0 1 0 41A41 41 0 0 1 41 0Z` + dot `circle cx=96 cy=96 r=12` | Thread glyph = `RESPOK_KIT_CHAT_GLYPH` (identical, 50% × 44.23%). Open glyph is new: same classes (`.rpk-kit-q` bubble, `.rpk-kit-a` dot) so colour and away rules apply; size 47% × 47% |
| Hover / press | "Scale 1.06 with a deeper shadow · 160 ms; press 0.94 · 90 ms": hover `scale(1.06)` + `0 16px 36px rgba(22,20,43,.36)` (`.16s ease`); active `scale(.94)` + `0 5px 14px rgba(22,20,43,.24)`, `.09s` | Same |
| Keyboard focus | "3px white gap and a 3px Signal ring": `box-shadow:0 0 0 3px #fff,0 0 0 6px #FF5A3C,0 10px 28px rgba(22,20,43,.28)` | Same |
| New message | Thread: "The answer pill slides in · 360 ms". Open: "The dot pops 0.2 → 1.35 → 1 · 360 ms" (`transform-origin:96px 96px`). "the Signal Deep badge springs in": badge `top:-3px; inset-inline-end:-3px; min-width:22px; height:22px; padding:0 6px; border:2px solid #fff; border-radius:11px; #D3361A; #fff; 700 12px/18px Figtree` | `.rpk-kit-arrive` (Thread exists; add the Open pop keyframes); badge identical (`.rpk-kit-badge-in`, `.rpk-kit-bump`) |
| Team away | "The Signal part turns into an empty ring": accent piece `fill:none; stroke:#A9A7BC; stroke-width:7` | `.rpk-kit-away` (works for the dot too) |
| Open and close | "Hides while the widget is open, rises back in on close": drops in .26s; the panel waits .2s for it and then opens in 380ms from `translateY(14px) scale(.96)`. On close the panel folds away in .26s and the launcher rises back in .44s, starting at .2s (§6) | `.launcher.open` slide-out |
| Brand colour | "on any color but Ink the mark is one color": `--rpk-color` = accent, `--rpk-on` = `#FFFFFF` or `#16142B` by contrast (`lum()` in the 00 and 09 scripts; brief §5.3), `--rpk-accent` = Signal only for Ink, else `--rpk-on`. "Any brand color: text and icons flip to white or Ink, whichever contrasts more"; "on a light color the mark turns Ink" (example `#FFC83D`) | Custom accent today: glyph `currentColor` = `fab.iconColor` (default `#ffffff`). Use `--gs-on-primary` when `fab.iconColor` is not set |
| Reduced motion | "nothing moves or scales, everything fades in 120 ms" | Kit already: `.12s` opacity |
| Close glyph | Chevron `M6 9l6 6 6-6`, 43%, stroke 2.5; open state: glyph `rotate(90deg) scale(.6)` + opacity 0, chevron from `rotate(-90deg)` to none, `.2s ease` | Same (plays while the launcher slides away) |

Launcher `aria-label`: "Open chat", "Open chat, 1 unread message" (00), "Open chat, 2 unread" (09), "Open chat, team
away" (09); production composes "Open chat — N unread messages" from `LOADER_STRINGS` (keep), add the away suffix
(new). The kit is chosen by edition only (brief §3).

### 4.28 Greeting bubble and reply card

| Part | Spec |
|---|---|
| Card | `display:flex; align-items:flex-start; width:272px; background:#fff; box-shadow:0 14px 36px rgba(22,20,43,.18),0 0 0 1px #ECEBF2; text-align:start`; Thread `border-radius:21px 21px 4px 21px`, Open `18px 18px 6px 18px`; `transform-origin` = the corner next to the launcher (bottom right) |
| Position | Thread: inline end aligned with the launcher, bottom 16px above it (`bottom` = launcher size + 16). Open (09): bottom-right corner 5px diagonally off the launcher's top-left (`right` and `bottom` = launcher size + 5). Board 00 keeps the Thread position for Open and only changes the corners |
| Main button | `.kgr-m`: flex, gap 10, `padding:14px 2px 14px 14px; border-radius:16px; background:transparent; color:var(--ink)`; avatar 30 × 30; text column (gap 3): name 13px/1.3/700, message 14px/1.4 |
| Avatar | 00 (a reply from an agent): initial avatar `.av` 30px, 12px (`.c1`). 09 (proactive greeting): `.gav` 30px Ink circle with the Respok glyph at 52% (Open: bubble 80 + Signal dot r 17 in viewBox 112; Thread: pills in viewBox 108 × 102) |
| Dismiss | `.kgr-x` 44 × 44, radius 12, transparent, `--ink-3`, hover `--bg-2`; X 14px stroke 2.4, `aria-label="Dismiss message"` |
| Copy | 00: "Sara · Nilufar Store" / "You’re welcome! Anything else I can help with?"; 09: "Sara · Nilufar Store" / "Hi! Looking for the right size for these shoes? I can help." |
| Live region | `role="status"` |

Production: the greeting is the smart-engagement launcher nudge (map §5.11, `div.smart-nudge` built by LD
`surfaceHtml`): restyle it as this card (width 272 instead of max 288, no accent hairline `::before`, no tail
`::after`, the dismiss inside at the inline end). Put avatar + `.smart-title` + `.smart-body` inside the CTA button
(`button.smart-cta[data-smart-cta]` = `.kgr-m`, opens the chat), keep `button.smart-dismiss[data-smart-dismiss]`
(= `.kgr-x`, aria-label from `dismiss`). A rule's `ctaLabel` has no slot in the design (suggestion: use it as the
button's accessible name). Position relative to the launcher replaces "size + 12px above". The reply card (00/05, a
new reply arrives while the panel is closed) is new: Core must pass the latest unread message (sender name, avatar,
text) to the loader; without it show the badge only. Dismissing the card must not clear the unread badge
(suggestion; the board prototype clears both).

### 4.29 Launcher styles (10)

Option ids in the board script (production settings in §9): `open` "Respok Open" (Brand kit), `thread` "Respok Thread" (Brand kit · two
pills), `bubble` "Classic bubble" (Familiar and simple), `duo` "Two bubbles" (Feels like a chat), `headset` "Support
headset" (For service teams), `avatar` "Agent face" (More human), `pill` "Pill with text" (Gets the most clicks).

| Style | Spec (all 60px circles in the accent unless noted) |
|---|---|
| Kit (`open`, `thread`) | §4.27; `.ln.rk` shadow `0 10px 28px rgba(22,20,43,.28)` |
| Base `.ln` (other styles) | `color:#fff`; shadow `inset 0 1px 0 rgba(255,255,255,.22),inset 0 -2px 0 rgba(0,0,0,.08),0 12px 26px -8px color-mix(in oklab,var(--a) 60%,transparent),0 3px 8px rgba(18,20,31,.16)`; hover `translateY(-3px) scale(1.06)`, `.22s cubic-bezier(.2,.8,.2,1)` |
| Classic bubble | 36px white bubble with 3 dots in `--dot` (Signal for Ink, else the accent); dots wave `idle-wave 3s ease-in-out infinite` (translateY -2.5px at 10%), delays 0/.08s/.16s |
| Two bubbles | 36px: outline back bubble (stroke 1.8, opacity .75) + filled front bubble; drift `duo-b`/`duo-f` 3.2s |
| Support headset | 34px headset, stroke 2, filled ear cups; tilt 3.6s (−10°, 8°, −3°) |
| Agent face | Inner circle `calc(100% - 8px)` `#FCE3D4`/`#8A3410` 20px/700 initial; online dot 14px `--ok` (Signal) with 2.5px white border, pulse `onp` 2.4s (Signal halo 0 → 7px); typing bubble top-start (white, radius 10, `padding:5px 6px`, three 4px round dots in `--a`, 1.3s) |
| Pill with text | `width:auto; height:56px; border-radius:28px; padding-inline:6px 20px; gap:4px; 14px/600`: 46px glyph box (Open glyph at 52%) + text "Questions? Ask us" (`fab.label`) |
| Entrance (other styles) | `fab-in .62s cubic-bezier(.2,1.25,.4,1)` from `translateY(18px) scale(.6)` + glyph `body-in .5s cubic-bezier(.2,1.2,.4,1) .12s` |

Colour swatches: Respok Ink `#16142B` (hero override), Blue `#2F5BFF`, Indigo `#4F46E5`, Violet `#7C3AED`, Pink
`#DB2777`, Orange `#C2410C`, Green `#15803D`, Teal `#0F766E` (the same eight as brief §5.5; any hex must
work). Position: Bottom right / Bottom left (`position`). Bottom menu: the five modes of §4.12.
Board note (spec): "The chosen color also goes on the header, buttons, visitor bubbles, the bottom bar and focus
rings; Paper, Mist and the Signal dot stay Respok’s. Motion switches off for people who turn on Reduce motion."
Production today: `fab.icon` (`chat`, `message`, `help`, `headset`, `phone`, `sparkles`, `smile`), `fab.imageUrl`,
`fab.label`/`fab.subLabel` card, `fab.shape`, `fab.animation`, `primaryColor`, `position` (map §1.5). Only `headset`
has a production counterpart (different glyph); the others are new glyphs. The 10 preview loops the kit's arrival
animation every 3s (`rk-pop`, `rk-slide`); board 09 does not, so ship no idle loop for the kit.

### 4.30 Production elements this design does not draw

Keep their markup and hooks; the looks below are suggestions built from the specified components.

| Element (map §) | Suggestion |
|---|---|
| Jump to latest `button.wy-jump[data-chat-jump]` (§5.8) | White pill, `--sh-2`, icon and label `--ink-2` 12.5px/600; `.has-new` = `.btn-p` colours (`--a` gradient, `--on-a` text) |
| Reply preview `div.reply-preview[data-reply-preview]` (§5.7) | Inside the composer box above the textarea, like `.pend`, content in the operator `.qt` look (author bold 11.5px, text 12.5px), cancel = the `.pend` remove button |
| AI badge `span.msg-ai-badge`, sender `span.msg-sender` (§5.1) | In the meta line; badge in the `.tg.done` look (20 high, radius 99, `--bg-2` / `--ink-3`, 11px/700) |
| System rows `div.msg-system-pill` (§5.2) | `.queue` pill look, centered |
| Call invitation card, call surface (§5.3, §5.4) | Out of scope: unchanged (brief) |
| Image lightbox (§5.5) | Unchanged |
| Help empty / zero results `div.kb-empty` (§4.4) | Centered 40px icon `--ink-4`, text 13px `--ink-3`, `.btn-p` "switch to chat" |
| Messages empty / error `div.wy-empty` (§4.3) | Centered text 13px `--ink-3`; retry as `.btn-p` |
| Home conversations error `.home-conv-error` (§4.1) | A `.cd` with the message (13px `--ink-2`) and a `.more`-style retry |
| Smart home card `section.smart-home-card` (§5.11) | First `.cd` of the stack; CTA as `.btn-p` without the inline accent (PD:902) |
| Contact fallback form (§4.6) | Pre-chat form rules (this README §4.20): intro card for `prechat-intro`, `.inp` fields, textarea `.inp` with auto height, `.btn-p` submit, status line 12px |
| Launcher label card `div.gs-fab-label` (§3.1) | Unchanged look; the "Pill with text" style (this README §4.29) is the designed alternative |
| Error toast `div.error-toast` (§3.1) | Unchanged |

## 5. Screens

Content is the same in both logo directions: the Thread renders (`--thread`, §1) differ from the Open renders only in
the brand elements of §4.1.

### 5.1 Home, 00/02 · 01/02 · 01/03 · 01/08

Layout §2.2; hero §4.2; cards §4.5; dock §4.12; footer §4.26.

| Screen | Content top to bottom |
|---|---|
| 01/02 Home | Hero "Hi there, welcome" / "How can we help you today?" · team card: S M R, "Chat with our team", live dot "Online · replies in minutes", "Start a conversation" · help card: "Search for help", rows "How do I track my order?", "Shipping times and costs", "Returns and refunds", "Payment methods" · footer · dock (Home active, Messages without badge) |
| 00/02 Home (Thread) | As 01/02 in Thread with "Hi there", placeholder "Search help articles" and Messages badge 2. Its Messages icon is board 00's superseded single pill: build the two-pill icon (§4.1) |
| 01/03 Home with a recent chat | Hero "Welcome back, Ali" · recent card "Recent message": S (presence), "Sara · Nilufar Store", "10 min ago", "You're welcome! Anything else I can help with?" (bold, ellipsis), badge 2 · CTA card: S M R (28px), "Send us a message", live dot "Replies in minutes", round send · help card with 3 rows · footer · dock (Messages badge 2, label "Messages, 2 unread") |
| 01/08 Team away | Hero "Hi there, welcome" · away card: greyed S M R, "We're away right now", empty ring "Back at 9:00 AM", note "Leave a message and we'll email you the reply. You'll find it here too.", "Leave a message" · help card placeholder "Your answer may be in Help", rows "How do I track my order?", "Returns and refunds" · footer · dock |

Data: `vm.isOnline`, `vm.conversations` (latest one; `title`, `preview`, `timeLabel`, `unreadCount`, `status`),
`vm.teamMembers`, `vm.articles` (design shows up to 4 rows on the default home), `vm.welcomeMessage`,
`replyTimeText`. New: visitor first name, "Back at" time, home search. Interactions: team/away button →
`data-home-action=chat`; recent card → `data-conversation-open=<id>`; CTA card → `data-home-action=chat`; article
row → `data-home-article=<slug>`; search → Help results; Messages tab → `data-view=list`.
Production `homeHtml` restructure: hero; then `smart-home-card` as a `.cd` when present (not drawn; suggestion);
then the team card (or recent + CTA cards when a conversation exists; production rule: an unresolved one → the
recent card, otherwise the team card); the conversations error state (`.home-conv-error`, not drawn; suggestion:
a `.cd` with the message and a `.more`-style retry `[data-home-action=conversations-retry]`); the help card when
`kbEnabled` and articles exist; footer; dock. Keep all hooks listed in map §4.1.

### 5.2 Bottom menu modes, 02/A–E

Same Home content as 01/03 in each mode (§4.12). A: labels under icons, dock 64 tall, footer at 612. B (default):
active tab icon + "Home". C: icons only. D: labels only, badge after "Messages". E: no dock; "All conversations"
link right-aligned between the recent card and the CTA card; footer at the bottom edge (688). Messages and Help in
mode E: back button in the title bar (not drawn as a panel; rule from widget.css and the board description). Setting
`navMode` (super-admin), values `both` / `active` / `icon` / `text` / `none` (board 10 ids), default `active`.

### 5.3 Conversation, 03/04 · 00/04

Header §4.13 (agent avatar + presence, "Sara · Nilufar Store", "Online · replies in minutes", More options, close).
Thread (03/04): visitor "Hi! My tracking code still hasn't arrived." 7:42 PM Read · operator "Sara": "Hi Ali! Your
order shipped this morning. Tracking code: `TR-2290-5531`" + link card "Track shipment" / "nilufar.store", 7:54 PM ·
visitor with quote "Sara / Tracking code: TR-2290-5531" + "Perfect, thank you!" 7:58 PM Read · typing bubble with
"Sara is typing…". Composer empty: "Write a message…", emoji, attach, mic.
00/04 adds the day divider "Today" at the top and shows the composer focused with the draft "Can I change the
delivery address?" and the send button; its bubbles carry an inline `line-height:1.55` (ignore; use 1.5).
Production: `chatFrameHtml` + `messagesHtml`; hooks per map §4.2 and §5.7. New: agent name in the title, visible
presence dot, sender name, link card, inline code, quote author, typing bubble.

### 5.4 Attachments, errors, pending file, 03/05

Visitor image "IMG_2041.jpg" · "840 KB", 8:04 PM Read · operator file "PDF" "invoice-48213.pdf" "240 KB" with
download, 8:06 PM · visitor voice note 0:14, 8:07 PM Delivered (single tick) · failed visitor bubble "New address: 12
Rosewood Ave, Apt 4" with "Not sent · Try again". Composer focused (`.fo`, 134.9 tall) with the pending
"payment-receipt.jpg" "1.2 MB" (remove) above the draft "Can I change the delivery address?", send button.
Production §4.16, §4.14 (failed), §4.17.

### 5.5 New conversation and topics, 03/06

Header: back, "New conversation" / "Nilufar Store", close (no avatar). `.th.top`: welcome block, separator, operator
bubbles and topic chips (§4.23), selected chip "Track an order". Composer empty with mic. Production: `emptyHtml`
(new header variant while the thread is empty; topics §9).

### 5.6 Voice messages, 04/1 · 04/2 · 04/3

Header without More options. Thread: day "Today" · visitor "Hi, the shoes I got have a small defect." 11:55 PM Read
· operator "Sara": "Sorry about that! We'll look into it." + "If it's easier, you can describe it in a voice
message." 11:58 PM. 04/1: composer in recording mode; 04/2: preview mode (§4.19). 04/3 is the `.ra` state card
(§4.8). Production `rec-bar` / `vn-bar`.

### 5.7 Emoji in the composer, 05/1 · 05/2 · 05/3

Header with More options. Thread: visitor 7:42 PM Read · operator "Sara" "Hi Ali! … Tracking code: `TR-2290-5531`"
7:54 PM. 05/1: focused composer with "Perfect, thank you!", the emoji button in its tap highlight (`.ib.tap`:
`background:var(--a-2); color:var(--a-ink); box-shadow:0 0 0 4px color-mix(in oklab,var(--a) 14%,transparent)` plus
the pulse; a demo cue, not a product state). 05/2: picker open (§4.18), "Perfect, thank you" + U+1F60D in the box,
that emoji's cell marked `.hit`, toggle `.on` "Close emoji". 05/3: live loop of the board (900ms open, 2000ms adds
U+1F60D, 2900ms switches to Hearts and symbols, 3800ms adds U+2764 U+FE0F, 5600ms closes, 7400ms resets, repeats
every 8000ms): the panel shows it closed, the state
screenshot open.

### 5.8 Pre-chat form, 06/07

Header: back, "Connect to support" / "Nilufar Store", close. Form (§4.20): intro "Before we start, introduce
yourself" / "If you leave the site, we'll send you the reply."; Name* "Ali Rezaei"; Email* "ali@example" in the error
state with "Enter a full email, like name@example.com"; Phone (optional) focused, placeholder "(415) 555-0132"; at
the bottom "Start a conversation" + "We only use your details to reply to you."; footer. Production
`prechatFormHtml` (header title/subtitle swap: title `wyConnectOperator`, subtitle workspace name, no avatar;
`p.prechat-subtitle` becomes the intro card; `button.prechat-submit[data-prechat-submit]` = primary button). The
contact-fallback form (map §4.6) is not drawn: restyle it with the same field, intro and button rules.

### 5.9 Message while away, 06/09

Header: back, store avatar `N` with away presence, "Nilufar Store" / "Away · replies by email", close. `.th.top`:
away banner (§4.22) · visitor "Hi, do you offer discounts on bulk orders?" "11:10 PM · Sent" · operator `N`:
"Got your message! Leave your email and we'll send you the reply." + email card (§4.21) + "Automated message".
Composer empty with mic. Production: offline chat view (map §4.2; today only the welcome bubble and a disabled send
with title "Disabled while offline"); the banner, automated reply and in-thread email card are new.

### 5.10 Messages, 06/13

Title bar "Messages" + close (back only with no menu). Rows (§4.10): "Sara · Nilufar Store" 10 min ago, "You're
welcome! Anything else I can help with?" (unread, badge 2), tag Open, avatar 44 with presence · "Mehdi · Nilufar
Store" Yesterday, "Your refund has been sent to your account.", Resolved · "Reza · Nilufar Store" 5 days ago, "You:
Thanks for the quick help!", Resolved · two skeleton rows (loading more) · button "Send us a message" · footer · dock
(Messages active, filled icon, badge ring `--a-2`). Rows: `align-items:flex-start; padding-block:12px`.
Production `conversationListHtml`: `.wy-head-list` → `.ttl` (title `wyConversations`; the `+` `button.wy-fab[data-home-action=chat]`
becomes the full-width "Send us a message" button at the bottom); rows `button.conv-row`; loading
`skeletonConvRowsHtml`; empty state `div.wy-empty` and error state `.wy-conv-error` are not drawn (suggestion: centered
13px `--ink-3` text and a `.btn-p` retry). New: per-row agent avatar and presence, "You:" prefix.

### 5.11 Pre-chat inside the chat, 07/A · 07/B · 07/C

Header: back, avatar `S` + presence, "Nilufar Store" / "Online · replies in minutes", close.
A: operator bubble "Hi, welcome! Before we start, tell us who you are so the reply reaches you even if you leave." +
form card "Your details" (Name "Ali Rezaei", Email focused "name@example.com", Phone (optional) "(415) 555-0132",
"Start a conversation", "Only used to reply to you"), "Just now"; locked composer "Fill in the form above first".
B: operator "Hi! To start, what's your name?" · visitor "Ali Rezaei" · operator "Thanks, Ali. What's your email, so
we can send you our replies?" · visitor "ali@example" invalid · visitor "ali@example.com" Saved · operator "If you
like, add your phone number and we'll text you updates." · composer in step mode (§4.21).
C: summary card · operator "Thanks, Ali! A teammate will reply in a few minutes. Go ahead and ask your question."
"Just now" · queue pill "2nd in line · about 3 minutes" · visitor "Hi, order 48213 still has no tracking code." 11:48
PM Delivered · composer empty with mic.
Production: A = `handoffPrechatCardHtml` (§4.21); B and C are new (setting suggestion: `prechatMode: "card" |
"steps"`).

### 5.12 Help, 08/10

Title bar "Help" + close; focused search "Type your question…"; categories card "Orders and shipping" 5 articles,
"Payments and refunds" 4 articles, "Products and sizing" 3 articles; "Most read" card "How do I track my order?",
"Shipping times and costs", "Size guide"; footer; dock (Help active). Production §4.24.

### 5.13 Article, 08/12

Header: back, "Orders and shipping" / "5 articles", close. Article "How do I track my order?", meta "Sara · 2 min read
· Updated 3 days ago", body with a link "Account › Orders", subhead "Where's my tracking code?", steps 1–2, tip
"Tracking can take up to 24 hours to update." (article text is demo content). Feedback "Was this article helpful?"
Yes / No; ask card "Still have a question?" / "Chat with our support team"; footer. Production §4.24.

### 5.14 Launcher and greeting, 09

Two renders (§1): Thread (default; the board's Open/Thread toggle on Thread, New message tile "The answer pill slides
in · 360 ms", greeting card 16px above the launcher) and Open. Tiles (board chrome around them): Rest, Hover · press, Keyboard focus, New message (badge 2), Open and close (mini
window), Team away, Brand colour (board accent `#2F5BFF`), Reduced motion; the brand-colour row (Ink, `#2F5BFF`,
`#0F766E`, `#C2410C`, `#FFC83D` with an Ink mark); the host page with the greeting card and the launcher with badge
1. Spec §4.27, §4.28, motion §6. The board loops (`play` replays every 5000ms, the mini window toggles every 2600ms);
these are demo timers.

### 5.15 Chat button and colour, 10

Settings preview (board chrome: the controls). Semantics: chat button style (§4.29), colour (8 swatches + any hex),
position, bottom menu mode; the live preview opens and closes the widget with the launcher motion of §6 (preview
panel 380 × 710, scaled; not the product size). Its panel-open animation (`panel-in` .4s `cubic-bezier(.2,.9,.25,1)`
from `translateY(36px) scale(.9)`) is reference only: build the token-sheet open of §6. Pick behaviour of the board:
choosing a style while the preview is open closes it; choosing a colour, position or menu mode replays the open
animation.

### 5.16 Mobile, 11/14 · 11/15

11/14: Home (§5.1 content with four article rows) with the mobile values of §2.5, two-line question, grab handle,
dock 64 at 34 from the bottom. 11/15: header 76 (avatar 44, "Sara · Nilufar Store" 16px, subtitle 12.5px), day
"Today", visitor "Hi, I ordered shoes on Monday but still haven't received a tracking code." 7:42 PM · operator
"Sara": "Hi Ali, thanks for reaching out." + "Could you send me your order number?" 7:46 PM · visitor "Sure, it's
order 48213" 7:50 PM · operator "Thanks! Your order shipped this morning." + "Tracking code: `TR-2290-5531`" 7:54 PM
(no name: same operator) · visitor "Perfect, thank you!" 7:58 PM; composer 90 tall (tools 44, `.ra` 46), footer, home
indicator (chrome). Production `.shell.gs-mobile-open .panel`.

### 5.17 Tokens, 12

Spec sheet transcribed in §3 (colour swatches, type scale "Home header · 25/700", "Article title · 21/700", "Card
title · 15/700", "Message · 14.5/400 · 1.5", "Label · 12.5/600–700", "Meta · 11/400"; corners 6/12/14/20/28/circle;
shadows sh-1/2/3; icons; motion). The header sample is rendered at 27px inline on the sheet; the label and
respok.css say 25px.

## 6. Motion

| Interaction | Element | Property | Duration | Easing | Delay | Keyframes / values |
|---|---|---|---|---|---|---|
| Open panel | panel | opacity 0 → 1 and transform `translateY(14px) scale(.96)` → none; origin = launcher corner (`100% 100%` bottom right, `0 100%` bottom left) | 380ms | `cubic-bezier(.22,1,.36,1)` | .2s when opened from the launcher (it drops first; also a click on the greeting/reply card, which hides the launcher the same way); 0 otherwise | Token sheet, canonical (as WebYar Template 1). Today: .3s from `translateY(16px) scale(0.97)`, opacity .2s ease (CSS:91-96) |
| Close panel | panel | opacity → 0; transform → `translateY(36px) scale(.9)` | .2s; .26s | ease; `cubic-bezier(.55,0,.75,.2)` | 0 | From the live boards (00, 10; not on the token sheet); `visibility:hidden` after .26s |
| Open panel, live demos | panel | 00: opacity .24s ease + transform from `translateY(36px) scale(.9)` .4s `cubic-bezier(.2,.9,.25,1)`, both delayed .2s; 10: `panel-in` .4s, same start and curve | — | — | — | Reference only; do not implement |
| Launcher while open | launcher | `translateY(120px)` (00; preview 10: 140px), visibility hidden | .26s | `cubic-bezier(.55,0,.75,.2)` | 0 | production `--gs-fab-exit` (size + 56) |
| Launcher after close | launcher | back to none | .44s | `cubic-bezier(.3,1.35,.5,1)` | .2s | today 280ms rise |
| Content cascade on open (10) | hero greeting + question; cards 1, 2 | opacity 0, `translateY(10px)` → none (`rise`) | .42s | `cubic-bezier(.22,1,.36,1)` | .04s; .08s, .14s (60ms stagger). Opened from the launcher: panel .2s, text .24s, cards .28s, .34s | — |
| View change | `.wy-view` | — | not specified | — | — | keep production fade (`wy-view-in` .26s; crossfade 150ms) |
| New message row | `.msg-row` | — | not specified | — | — | keep `wy-msg-in .24s` |
| Card hover | `a.cd` | transform `translateY(-1px)`, shadow | .2s | `--ease` | — | — |
| Primary button | `.btn-p` | hover `brightness(1.06)` + `translateY(-1px)`; active `brightness(.97)` | .16s transform, .2s filter | `--ease` | — | — |
| Round button | `.ra` | hover `scale(1.06)` + `--a-3`; active `scale(.94)` | .2s | `--ease` | — | — |
| Mic ↔ send | `.ra` icon | opacity crossfade + 90° turn | 180ms | ease-out | — | angles not specified (suggestion: out 0 → 90deg, in −90deg → 0) |
| Row hover | `.li`, `.ch` | background; chevron `translateX(3px)` + `--a-ink` | .15s; .2s | —; `--ease` | — | — |
| Tab | `.tab`, `.tic` | colour .2s, background and shadow .25s; press `.tic` `scale(.9)` | .2s/.25s | `--ease` (press) | — | — |
| Icon button, chip, field, composer box | `.ib`, `.chip`, `.inp`, `.cbox` | background / colour / box-shadow | .15s / .15s / .15s / .2s | ease | — | — |
| Typing dots | `.typ i` | opacity .45 → 1, `translateY(-3px)` at 25% | 1.3s infinite | ease-in-out | 0, .16s, .32s | `rp-typ` |
| Recording dot | `.rdot` | box-shadow `0 0 0 0 color-mix(in oklab,var(--rec) 45%,transparent)` → 70% `0 0 0 7px transparent` | 1.4s infinite | — | — | `wy-pulse` |
| Live wave | last 6 bars of `.wv.rt` | `scaleY(.55)` ↔ `scaleY(1)` | .9s infinite alternate | ease-in-out | 2nd-last .15s, 4th-last .3s | `wy-lv` |
| Skeleton | `.sk i` | background-position 200% → −200% | 1.4s infinite | linear | — | `wy-sh` |
| Emoji picker open | `.epk` | height 0 → 246, padding, margin; opacity | .3s; .22s | `--ease`; ease | opacity .05s | — |
| Emoji picker close | `.epk` | height, padding, margin; opacity | .2s; .12s | `cubic-bezier(.4,0,.6,1)`; ease | — | — |
| Emoji picker content | `.ep-sr`, `.ep-cats`; `.ep-row` 1–4 | opacity 0, `translateY(10px)` → none | .3s; .34s | `--ease` | .05s; .08s, .11s, .14s, .17s | `ep-in` |
| Emoji toggle | toggle icon | `rotate(-14deg) scale(1.06)` | .28s | `--ease` | — | — |
| Emoji cell | `.ep-e` | hover `scale(1.14)`; background | .16s; .12s | `--ease` | — | `.hit` is static inside the open picker (`.cbox.emo .ep-e.hit{animation:none}`); the `ep-pulse` keyframes (1.6s ease-out infinite, box-shadow 0 → 7px) only drive the demo tap cue `.ib.tap` |
| Reply arrives while closed (00) | answer pill (Thread) | `translateX(34px)` + opacity 0 → 70% `translateX(-6px)` opacity 1 → none | .36s | `cubic-bezier(.3,1.4,.5,1)` | 0 (09: .3s) | `en-pill` / `rpk-answer` |
| Reply arrives (Open) | dot | `scale(.2)` → 60% `scale(1.35)` → none, origin `96px 96px` | .36s | `cubic-bezier(.3,1.5,.5,1)` | 0 (09: .3s) | `en-dot` / `rpk-dot` |
| Badge in | launcher badge | `scale(0)` → none | .34s | `cubic-bezier(.3,1.5,.5,1)` | .3s | out: `.2s ease` |
| Reply / greeting card in | card | opacity 0 → 1 (.3s ease); transform `scale(.6)` → none | .3s | `cubic-bezier(.2,.9,.25,1)` | .5s (00); .6s (09, `rpk-greet`) | origin bottom right |
| Card out (dismiss, open) | card | opacity, transform → `scale(.6)` | .16s | ease | 0 | visibility after .16s |
| Launcher entrance (kit) | launcher | opacity 0, `scale(.6)` → none | .28s | `cubic-bezier(.2,.9,.25,1)` | 0 | `rpk-in` (today: 280ms slide) |
| Launcher entrance (other styles, 10) | launcher; glyph | `translateY(18px) scale(.6)` + opacity → none; glyph `scale(.7)` + opacity → none | .62s; .5s | `cubic-bezier(.2,1.25,.4,1)`; `cubic-bezier(.2,1.2,.4,1)` | 0; .12s | `fab-in`, `body-in` |
| Launcher hover / press / open | §4.27 | — | .16s / .09s / .2s | ease | — | — |

Panel open and close (build note). The .2s delay applies when the launcher is on screen at the moment of opening,
because it drops first; when it is already down there is nothing to wait for (board 10: `late` is set only when the
preview opens from closed; colour, position and menu replays use no delay). The open starts at
`translateY(14px) scale(.96)` and the close ends at `translateY(36px) scale(.9)`, so one transition cannot do both
(production today uses one, CSS:96). Suggestion, after the board 10 preview CSS (`.w.pv.closed`, `.w.pv.pop`,
`.late`) with the token-sheet open values; the class `wy-after-fab` and its owner (Core or the loader) are suggestions:

```css
.panel { opacity: 0; visibility: hidden; transform: translateY(36px) scale(.9); pointer-events: none;
  transition: opacity .2s ease, transform .26s cubic-bezier(.55,0,.75,.2), visibility 0s linear .26s; }
.panel.visible { opacity: 1; visibility: visible; transform: none; pointer-events: auto; transition: visibility 0s;
  animation: wy-panel-in 380ms cubic-bezier(.22,1,.36,1) backwards; }
.panel.visible.wy-after-fab { animation-delay: .2s; } /* the launcher was on screen and drops first */
@keyframes wy-panel-in { from { opacity: 0; transform: translateY(14px) scale(.96); } }
```

The open state has no opacity or transform transition, so nothing competes with the keyframes. Keep the production
origins (§2.1) and the mobile sheet rules; extend `.shell.no-anim .panel{transition:none}` (CSS:114) with
`animation:none`.

Board 00 prototype loop (demo, not product): starts 2600ms after mount; closed with a reply → opens (stays 3800ms)
→ closes (2200ms) → reply arrives (2600ms) → …; clicking the card or launcher opens for 6000ms, the close button
schedules 3000ms, dismiss 4000ms.

Reduced motion (`prefers-reduced-motion: reduce`): every animation off and every transition replaced by `opacity
.15s ease` (`widget.css`: `.cv *,.cv *::before,.cv *::after{animation:none!important;transition:opacity .15s ease!important}`
→ scope to `.shell *`); the launcher fades in 120ms (09) and the kit already does. Keep the production opt-outs
(map §8.8).

## 7. Direction, language and numbers

| Topic | Rule |
|---|---|
| Direction | English, `dir=ltr` on the panel and every view root. A Respok widget in Persian renders `dir=rtl` with Vazirmatn (`.cv.rp[dir=rtl]`); the respok.css line-height and hero-size rules are `[dir=ltr]` only, so RTL falls back to the widget.css (Vazirmatn) values |
| Mirrors (logical properties) | Hero watermark (`inset-inline-end`), hero highlight (top-left in LTR, top-right in RTL), close button, header order, row chevrons (also translate −3px on hover in RTL), `.more`, tab badge (`inset-inline-start`), avatar stack overlap, presence dot, image caption, `.ex` prefix border, greeting dismiss, send plane (`[dir=rtl] .pl{transform:scaleX(-1)}`), `.mir` icons |
| Stays physical | Message sides (operator left, visitor right, `.grp.L/.R` alignment rules for both directions), bubble join corners, `.file` padding (`10px 10px 10px 12px`), voice and recorder rows (`dir=ltr`, timelines run left to right), launcher and panel anchoring (`position` setting), the 6px greeting corner on the launcher side (mirror with `position: bottom-left`, brief §4) |
| Mixed content | Emails, codes, file names, phone numbers: `direction:ltr; unicode-bidi:isolate` (`.ltr`, `.code`); bubbles keep `unicode-bidi:plaintext; text-align:start` |
| Digits | Latin digits in English (times, counts, badges, steps, "2nd in line"); Persian digits only when the widget runs in Persian (production rules, map §7) |
| Times | "7:42 PM": `hour:'numeric'` in English (§4.14); relative labels "10 min ago", "Yesterday", "5 days ago" come from Core (`timeLabel`); day labels "Today"/"Yesterday" are hard-coded in PD |
| Fonts by direction | LTR Figtree (+ DM Mono for `.code`); RTL Vazirmatn; emoji in the system emoji fonts |
| Copy style | Sentence case ("Start a conversation", "Powered by Respok"), middle dot `·` as separator, typographic ellipsis `…` in placeholders and "typing…" |

## 8. Accessibility

- Keep all production ARIA (map §8.5): panel `role=dialog`, live regions (`.connection-banner`, `[data-presence]`,
  `[data-typing-row]`, `[data-rec-sr]`, `[data-rec-timer][role=timer]`, `.msg-att-loading`, `[data-fb-status]`,
  `.prechat-error[role=alert]`), `.emoji-btn[aria-expanded]`, `.kb-rate[aria-pressed]`, field `aria-required` /
  `aria-invalid` / `aria-describedby`.
- Labels as designed: "Close", "Back", "More options", "Emoji" / "Close emoji", "Attach", "Send", "Record a voice
  message", "Cancel recording", "Stop recording", "Send voice message", "Delete recording", "Play — 5 of 14 seconds",
  "Playback speed", "Play voice message", "Download invoice", "Remove attachment", "Read", "Delivered", "Search for
  help", "Search emoji", "Message" (textarea), "Save email", "Phone number", "Submit", "Dismiss message", "Respok"
  (lockup `role=img`), navigation "Widget sections" with tab labels "Home", "Messages, 2 unread", "Help" and
  `aria-current="page"` on the active tab; emoji picker `role="dialog"` "Emoji picker", categories `role="tablist"`
  "Emoji categories" with `role="tab"` + `aria-selected`; forms "Contact details", "Email for the reply"; summary
  "Saved details"; skeleton "Loading"; greeting card `role="status"`. Decorative SVGs are `aria-hidden`.
- Typing: the visible bubble is `aria-hidden` (the board's `aria-label="Typing"` on a div is not announced); Core's
  sr-only `[data-typing-row]` keeps announcing. The tab badge count is in the tab's `aria-label`; the badge itself is
  `aria-hidden`.
- Bottom menu: buttons in DOM order Home, Messages, Help; `aria-current="page"` on the active one; in mode C/D the
  accessible name stays the full label.
- Focus: visible ring on every control (Template 1: `outline:2px solid var(--gs-primary); outline-offset:2px`, RT:42-49).
  On the Ink hero an accent ring is invisible; suggestion: `--on-a` ring for the hero close button. Composer and
  fields show focus with their own rings (`.cbox.fo`, `.inp.fo`, `.sr.fo`). Launcher ring: 3px white + 3px Signal.
- Contrast (Ink accent): Ink on white 17.96:1; Slate `#5E5C75` on white 6.43:1, on Paper 5.91:1, on the operator bubble
  5.63:1; white on Signal Deep (badges) 4.87:1; Signal Deep errors on white 4.87:1; `#A62A12` on `#FFEAE4` 6.13:1;
  white on the presets `#2F5BFF` 5.17, `#0F766E` 5.47, `#C2410C` 5.18. Below 4.5:1: placeholder `#7A808C` on white
  3.97:1 (placeholders only), chevrons `--ink-4` 2.35:1 (decorative, the row text carries the meaning), Signal dot
  3.10:1 (non-text, paired with text).
- Touch targets: desktop icon buttons 36 (composer tools 34, `.ra` 38); mobile 44 (`.ra` 46), tabs 48–52 high,
  chips 36, feedback buttons 36. Greeting dismiss 44.

## 9. New versus production

Canonical names for every hook, setting, view-model field and i18n key below (one name per concept, shared by
both brands and both templates): [`../../shared/new-hooks-and-settings.md`](../../shared/new-hooks-and-settings.md).

| Addition | Where | UI spec summary | Core / server / settings must provide | Suggested hook / config | If unavailable |
|---|---|---|---|---|---|
| Logo direction | all | §4.1 (Thread Messages-tab icon = the two pills of boards 01–12; board 00's single pill is superseded) | Setting | `config.logoDirection: "thread" \| "open"`, default `thread`; class `lg-*` on `.shell` | Thread |
| Bottom menu + unread badge | 01, 02, 06/13, 08/10 | §4.12 | Navigation to `home`; total unread | `nav.wy-tabs > button.wy-tab[data-view=home\|list\|help]`; settings `navMode` (`both`, `active`, `icon`, `text`, `none`; default `active`), `navStyle` (`va`, `vb`, `vc`, `vd`; default `vb`) | — (required for Template 1) |
| No-menu mode extras | 02/E | `.more` link on Home; back buttons in Messages/Help | — | `nv-none` class | — |
| Home hero with logo tile and greeting lines | Home | §4.2, §4.3 | `logoUrl`, `showLogo`, `welcomeMessage` | `.wy-head-home` restyle | — |
| Personal greeting "Welcome back, Ali" | 01/03, 02 | `.hx-hi` | Visitor first name (identify) | new i18n `homeGreetingBack` with `{name}` | "Hi there, welcome" |
| Team card with avatars + status | Home | §4.5 | Team members (initials when no photo) | `.tm` inside the first card | Hide avatars, keep title and button |
| Away card: back time + note | 01/08 | §4.5, §4.22 | Next opening time | `availability.nextOpenAt` (suggested) | Omit "Back at …" line, keep note |
| Recent message card | 01/03 | §4.5 | Latest conversation with title/avatar | compact row with avatar | Production compact row look |
| Home and Help search | Home, 08/10 | §4.9 | KB search | `kbSearchBarHtml` + `data-kb-search` | Hide the field |
| Help categories, "Most read", article meta, category header | 08 | §4.24 | Categories with counts, popularity, author, read time, updated date | `data-kb-category` (suggested) | Hide categories card and meta; header shows "Help" |
| Persistent "Still have a question?" card | 08/12 | §4.24 | — | `data-kb-action=switch-chat` | Production CTA after "down" |
| Agent name + avatar + presence in the chat header | 03, 04, 05, 07 | §4.13 | Assigned agent (name, avatar, online) | header title "Agent · Workspace" | Workspace identity |
| Header variants (new conversation, pre-chat, away) | 03/06, 06 | §4.13 | Thread empty / offline state | `.wy-head-chat.is-new` (suggested) | Standard header |
| "More options" header button | 00/04, 03, 05 | §4.4 | A menu (not designed) | — | Do not render |
| Sender name above operator groups | thread | §4.14 | `senderName` (exists) | `span.msg-sender-label` on first row of a run | — |
| Visible typing bubble | 00/04, 03/04 | §4.15 | `setOperatorTyping` + typist name | `view.operatorTyping`; `.typing-row` | sr-only announcement only |
| Link preview card | 00/04, 03/04 | §4.14 | Link title (unfurl) | `a.msg-link` card markup | Host as title |
| Inline code / tracking code | 00/04, 03, 05, 11 | §4.14 | Markdown-style code detection | `code.code` in `.msg-text` | Plain text |
| Quote author | 00/04, 03/04 | §4.14 | `replyTo` author | `.msg-quote > b` | Quote text only |
| Delivered = single tick, Sent label | 03/05, 06/09, 07/C | §4.14 | Status values | — | Production ticks |
| Image caption pill | 03/05 | §4.16 | File name + size | `.msg-att-image` caption | Image only |
| Voice waveform bubble | 03/05 | §4.16 | Waveform peaks (optional) | `[data-audio-seek]` bars | Static design heights |
| Send while recording, recorder hint, preview ring and speed | 04 | §4.19 | Esc/Enter handling, max length, playback rate | `data-rec-send`, `data-vn-rate`, `--p` | Hide send/speed/hint |
| Emoji search, categories, frequently used, picker inside the box | 05 | §4.18 | Emoji data by category, recents | picker as first child of `.input-wrap` | 50 items, 8 columns, no header |
| Welcome block + topic chips | 03/06 | §4.23 | Team, topics | `data-qna-question` or `data-topic` | Welcome bubble only |
| "(optional)" marker, privacy line, intro card | 06/07, 07/A | §4.20 | — | `.prechat-privacy` | — |
| Form card on the operator side + locked composer | 07/A | §4.21, §4.17 | Lock state while the card waits | `.input-bar.is-locked` | Composer stays usable |
| Step-by-step pre-chat | 07/B | §4.21 | Conversational field flow, validation | setting `prechatMode: "steps"` | Card mode |
| Saved-details summary + Edit | 07/C | §4.21 | Submitted contact | `data-prechat-edit` | Hide |
| Queue position and wait time | 07/C | §4.21 | Position, ETA | routing pill text | `routingInQueue` text |
| Away banner, automated reply, in-thread email capture | 06/09 | §4.21, §4.22 | Away state, opening time, reply SLA | `data-fb=email`, `data-fb-submit`, `data-fb-status` inside `.ec` | Contact fallback form (map §4.6) |
| Messages list: agent avatars + presence, "You:" prefix, bottom "Send us a message" button | 06/13 | §4.10, §5.10 | Per-conversation agent | `conv-row` avatar | Workspace avatar |
| Open launcher glyph + dot-pop arrival | 09, 10 | §4.27 | — | `logoDirection` in the loader | Thread glyph |
| On-colour flip for launcher and accent text | 09, 10 | §4.27, brief §5.3 | `--gs-on-primary` | loader | White |
| Kit entrance scale-in, overshoot rise after close | 00, 09 | §6 | — | loader animation | Production slide |
| Panel open waits .2s for the launcher to drop | 00, 10 | §6 | Core or loader: was the launcher on screen when the panel opened | `.panel.wy-after-fab` (suggested) | No delay |
| Greeting bubble look | 09 | §4.28 | — | restyled `.smart-nudge` | Production nudge |
| Reply preview card while closed | 00/05 | §4.28 | Latest unread message to the loader | extend `setUnread` with a preview | Badge only |
| Launcher styles (Classic bubble, Two bubbles, Support headset, Agent face, Pill with text) | 10 | §4.29 | Settings + glyphs | `fab.icon` new values `bubble`, `duo`, `avatar` (`headset` exists); `fab.shape` new value `pill` (text `fab.label`); the Respok Open / Thread tiles are the kit (`fab.icon: "chat"`) with `logoDirection` | Kit |
| Eight colour swatches | 10 | §4.29 | Settings UI | `primaryColor` | Any hex input |
| Mobile grab handle | 11/14 | §2.5 | — | decorative | Omit |

## 10. Copy deck

English UI strings as designed (demo content such as names, messages, article titles and file names is excluded
except where it shows the pattern). "Meaning" notes placeholders and usage. Keys from map §7; "new:" = suggested key.

| UI string as designed | Where | Meaning / note | Production key |
|---|---|---|---|
| Hi there, welcome | Home hero (00: "Hi there") | greeting line | `homeGreeting` (value in Core's table) |
| Welcome back, Ali | Home hero, identified visitor | `{name}` = visitor first name | new: `homeGreetingBack` |
| How can we help you today? | Home hero | question | `homeWelcome` / `welcomeMessage` |
| Chat with our team | Home team card | title | new: `homeTeamTitle` |
| Online · replies in minutes | Home team card, chat header | presence + reply time | new: `statusOnline` + `replyShort` |
| Start a conversation | Home button, pre-chat submit, form card | primary action | `homeStartChat` (all three) |
| Search for help | Home search (00: "Search help articles") | placeholder + aria-label | `searchKb` |
| Your answer may be in Help | Home search while away | placeholder | new: `searchKbAway` |
| Type your question… | Help search | placeholder | new: `searchKbHelp` |
| Recent message | Home recent card | caption | `wyRecentConversations` (today "Recent conversations"; update) |
| All conversations | Home, no-menu mode | link to Messages | `wyViewConversations` (today "View conversations") |
| Send us a message | Home CTA card; Messages bottom button | start a new chat | `wyStartNew` (both places) |
| Replies in minutes | Home CTA card | reply time | new: `replyShort` |
| We're away right now | Home away card | title | new: `homeAwayTitle` |
| Back at 9:00 AM | Home away card | `{time}` next opening | new: `homeBackAt` |
| Leave a message and we'll email you the reply. You'll find it here too. | Home away note | | new: `homeAwayNote` |
| Leave a message | Home away button | | `homeLeaveMessage` |
| Powered by | footer | followed by the drawn lockup | `poweredBy` |
| Respok | lockup `aria-label` | platform brand | `poweredBy.brand` / `platformName` |
| Home | tab | | new: `navHome` |
| Messages | tab, Messages title | | new: `navMessages`; title `wyConversations` (today "Conversations") |
| Help | tab, Help title | | `help` |
| Messages, 2 unread | tab `aria-label` | `{n}` unread | new: `navMessagesUnread` |
| Widget sections | nav `aria-label` | | new: `navLabel` |
| Close | close buttons | | `close` |
| Back | back buttons | | `back` |
| More options | chat header | not shipped (§9) | new: `moreOptions` |
| Online · replies in minutes / Away · replies by email | chat header subtitle | presence + reply mode | `replyTimeText`; new: `statusAwayEmail` |
| New conversation | chat header, empty thread | | `wyNewConversation` |
| Connect to support | pre-chat header | | `wyConnectOperator` (today "Connect to an operator") |
| Today | day divider | | hard-coded in PD (`Today`) |
| Sara is typing… | typing meta | `{name} is typing…` | Core typing label (`[data-typing-label]`); new: `typingNamed` |
| Read / Delivered | receipt `aria-label` | | new: `msgRead`, `msgDelivered` |
| Sent | away meta "11:10 PM · Sent" | | new: `msgSent` |
| Not sent | failed meta | | `msgFailed` |
| Try again | failed meta | | `retry` |
| Write a message… | composer placeholder | | `typeMsg` |
| Message | textarea `aria-label` | | new: `messageLabel` |
| Emoji / Close emoji | emoji toggle | | `emojiPicker`; new: `emojiPickerClose` |
| Attach | attach button | | `attachFile`; final wording in [the registry](../../shared/new-hooks-and-settings.md) §4.13: "Attach a file" |
| Send | send button | | `send` |
| Record a voice message | mic | | `recordVoice` |
| Remove attachment | pending file remove | | `remove` |
| Play voice message | voice bubble | | `playAudio` |
| Download invoice | file download | "Download" + file name | `download` |
| Cancel recording / Delete recording | recorder / preview delete | | `cancelRecording` / new: `deleteRecording` |
| Stop recording | recorder | | `stopRecording` |
| Send voice message | recorder, preview | | new: `sendVoice` |
| Esc · cancel · Enter · send · up to 2 minutes | recorder hint | keys + max length | new: `recHint` (`{max}`) |
| Play — 5 of 14 seconds | preview play | `{pos}` of `{total}` seconds | new: `playAudioProgress` |
| Playback speed / 1× | preview speed chip | | new: `playbackRate`; `1×` hard-coded |
| Search emoji | picker | placeholder | new: `emojiSearch` |
| Emoji picker / Emoji categories | picker labels | | new: `emojiDialog`, `emojiCategories` |
| Frequently used · Smileys · People and hands · Hearts and symbols · Nature · Food and drink | picker categories | | new: `emojiCat*` |
| Nilufar Store support | new-conversation title | `{workspace} support` | new: `wyTeamOf` |
| We usually reply in a few minutes | new-conversation status | | `replyTimeText` / `homeReplyFast` |
| Just now | meta | | new: `timeJustNow` |
| Before we start, introduce yourself | pre-chat intro title | | new: `prechatIntroTitle` |
| If you leave the site, we'll send you the reply. | pre-chat intro text | | `wyPrecontactDesc` / `prechatSubtitle` |
| Name / Email / Phone | field labels | | `name`, `email`, `phone` |
| * | required mark | | hard-coded (`required` for its label) |
| (optional) | optional fields | | new: `optional` |
| Enter a full email, like name@example.com | email error | | Core validation text; new: `errEmailIncomplete` |
| (415) 555-0132 / name@example.com / 415 555 0132 | placeholders | | `prechatPhonePh`, `prechatEmailPh`; step input new |
| We only use your details to reply to you. | pre-chat privacy | | new: `prechatPrivacy` |
| Our team is away right now | away banner | | new: `awayBannerTitle` |
| Back at 9:00 AM · usually replies within 2 hours | away banner | `{time}`, `{replyTime}` | new: `awayBannerSub` |
| Got your message! Leave your email and we'll send you the reply. | automated reply | server / Core text | new: `awayAutoReply` |
| Email for the reply | email card label | | new: `fallbackEmailLabel` |
| Save email | email card button | | new: `saveEmail` |
| Automated message | meta | | new: `msgAutomated` |
| Open / Resolved | status tags | | `wyStatusOpen` / `wyStatusResolved` |
| You: … | list preview of own message | prefix | `you` + ": " |
| Loading | skeleton `aria-label` | | new: `loading` |
| Hi, welcome! Before we start, tell us who you are so the reply reaches you even if you leave. | form-card bubble | handoff subtitle | handoff `subtitle` (Core) |
| Your details | form card title | | `prechatTitle` |
| Contact details | form card `aria-label` | | new: `prechatCardLabel` |
| Only used to reply to you | form card privacy | | new: `prechatPrivacyShort` |
| Fill in the form above first | locked composer | | new: `composerLockedPrechat` |
| Hi! To start, what's your name? / Thanks, Ali. What's your email, so we can send you our replies? / If you like, add your phone number and we'll text you updates. | step questions | `{name}` in the second | new: `prechatAskName`, `prechatAskEmail`, `prechatAskPhone` |
| That email isn't complete / · e.g. name@example.com | step error | | new: `prechatStepEmailInvalid`, `prechatStepEmailExample` |
| Saved | step answer meta | | new: `saved` |
| Step 3 of 3 · optional | step progress | `{n}`, `{total}` | new: `prechatStep` + `optional` |
| Skip | step progress | | new: `skip` |
| For text updates | step hint | | new: `prechatPhoneHint` |
| Submit | step submit `aria-label` | | new: `submit` |
| Your details are saved / Edit | summary | | new: `prechatSaved`, `edit` |
| Saved details | summary `aria-label` | | new: `prechatSavedLabel` |
| Thanks, Ali! A teammate will reply in a few minutes. Go ahead and ask your question. | after submit | system/auto text | new: `prechatThanks` |
| 2nd in line · about 3 minutes | queue pill | `{n}`, `{min}` | `routingInQueue` + new |
| 5 articles | category count | `{n} articles` | new: `kbArticleCount` |
| Most read | help section | | new: `kbPopular` |
| Sara · 2 min read · Updated 3 days ago | article meta | author, read time, updated | new: `kbReadTime`, `kbUpdated` |
| Was this article helpful? | article feedback | | `wyArticleHelpful` |
| Yes / No | feedback buttons | | `wyHelpfulYes` / `wyHelpfulNo` (today "Helpful" / "Not helpful") |
| Still have a question? | ask card title | | new: `kbStillQuestion` |
| Chat with our support team | ask card status | | `wyTalkToSupport` / `kbSwitchToChat` |
| Open chat / Close chat | launcher `aria-label` | | `openChat` / `closeChat` (loader) |
| Open chat, 1 unread message | launcher `aria-label` | production joins with " — " | `openChat` + `unreadOne` / `unreadMany` |
| Open chat, team away | launcher `aria-label` | | new: `openChatAway` (loader) |
| Dismiss message | greeting dismiss | | `dismiss` (loader, "Dismiss") |
| Questions? Ask us | pill launcher | workspace text | `fab.label` |

Settings UI copy (admin app, not widget i18n), board 10: Chat button; Respok Open (Brand kit); Respok Thread (Brand
kit · two pills); Classic bubble (Familiar and simple); Two bubbles (Feels like a chat); Support headset (For service
teams); Agent face (More human); Pill with text (Gets the most clicks); Color; Respok Ink, Blue, Indigo, Violet, Pink,
Orange, Green, Teal; Position; Bottom right; Bottom left; Bottom menu; Icons + labels; Icons, active label; Icons
only; Labels only; No menu; the colour note quoted in §4.29.

## 11. Acceptance checklist

In addition to [brief §10](../../CLAUDE_CODE_BRIEF.md):

- [ ] With `logoDirection:"thread"` (default), panels 01–08 and 11 match their `--thread` crops, 09 and 12 their
      `--thread` boards, and 00/02, 00/04 and the 00 open state match too, except what board 00 alone draws: the 6px
      bottom-end corner (the build uses 28px on all corners per brief §4), the single-pill Messages icon in 00/02, and
      the inline line-heights 1.25 / 1.55.
- [ ] With `logoDirection:"open"`, panels 01–08 and 11 match their unsuffixed crops, 09 and 12 their unsuffixed
      boards, and the 05, 09 and 10 state renders match.
- [ ] Switching `logoDirection` changes exactly: hero watermark, Messages-tab icon, lockup, launcher glyph and arrival
      animation, greeting corners/position/avatar glyph.
- [ ] The Thread Messages-tab icon is the two-pill icon of boards 01–12 and the token sheet (markup in §4.1; active:
      answer pill Signal `#FF5A3C`). Board 00's single pill with three dots is superseded and does not ship.
- [ ] Panel open: opacity 0 → 1 and `translateY(14px) scale(.96)` → none in 380ms `cubic-bezier(.22,1,.36,1)`,
      origin at the launcher corner, starting .2s after the open when the launcher is on screen (it drops first).
      Panel close: opacity .2s ease and transform .26s `cubic-bezier(.55,0,.75,.2)` to `translateY(36px) scale(.9)`,
      then hidden. The .4s / 36px / .9 open of the live boards 00 and 10 is not built.
- [ ] intl skin contains every rule of §3.8 and nothing WebYar-specific leaks: badges Signal Deep (tab badges too),
      dots Signal, away rings `#A9A7BC`, "Open" tag and summary in the `#A62A12` tints, round typing dots, Figtree.
- [ ] Neutrals stay Paper/Mist with a custom accent (`#2F5BFF`, `#0F766E`, `#C2410C`, a light `#FFC83D`): only
      accent-derived tokens change; hero uses the formula; text on the accent flips to Ink on `#FFC83D`.
- [ ] Home hero measures 233.1px with one-line copy; cards overlap it by 56px; footer at 616 and dock at 648–708 on
      a 720 panel; conversation header 68, composer box 82, footer 32.
- [ ] All five `navMode` values render as 02/A–E, including the no-menu back buttons and "All conversations".
- [ ] Bubble corners: single bubbles round on all corners, grouped bubbles join at 6px, no tail on the last bubble;
      14px between groups, 3px inside a group; times "7:42 PM" (no leading zero).
- [ ] Composer keeps the production DOM order (mic first, send → attach → emoji) yet paints emoji, attach … mic/send;
      recording, preview, emoji-open, pending-file and locked states match 04/1, 04/2, 05/2, 03/05, 07/A.
- [ ] `.panel-close` sits at the per-screen positions of §2.4 and never overlaps a header title.
- [ ] Launcher: Thread glyph identical to `RESPOK_KIT_CHAT_GLYPH`; Open glyph 47%; badge 22px Signal Deep; focus ring
      white + Signal; away ring; reply arrival animation; greeting card 272px with the direction's corners.
- [ ] Reduced motion: no transform animations anywhere (panel open and close, typing dots, wave, pulse, picker, card
      cascade, launcher); opacity fades of .15s (launcher .12s) only.
- [ ] Mobile 390 × 844: hero 299.3 with a two-line question, 44px icon buttons, 46px `.ra`, dock 64 clear of the
      home indicator, header 76.
