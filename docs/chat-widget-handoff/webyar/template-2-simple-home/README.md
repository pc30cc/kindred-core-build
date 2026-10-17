# WebYar chat widget · Template 2 "Simple home" — implementation spec

Template 2 of the WebYar (وب‌یار) website chat widget. There is no bottom menu: the visitor types the first message
straight into an ask field on the home card, or taps a topic chip, and reaches the help center and earlier conversations
through quiet rows underneath. The widget is Persian (`fa`), right to left, set in Vazirmatn. Per
[brief §3](../../CLAUDE_CODE_BRIEF.md) it becomes the new production template id **`simple`** (new renderer
`presentation-simple.js` + `presentation-simple.css`, registered as `window.__gs_presentation_simple`; Respok's
`simple-intl` is a skin over it). The idea: one elevated element (the ask card), everything else quiet, and the home
content cascading in when the widget opens.

Read with: brand sheet [`../README.md`](../README.md), global rules [`../../CLAUDE_CODE_BRIEF.md`](../../CLAUDE_CODE_BRIEF.md),
production reference [`../../shared/production-map.md`](../../shared/production-map.md) (cited below as "production-map §N";
`PD:`, `LD:`, `CSS:`, `RT:` line refs point into `public/widget/presentation-default.js`, `public/widget/loader.js`,
`public/widget/presentation-default.css`, `public/widget/runtime.css`). Values in this file come from
[`reference/css/t2.css`](reference/css/t2.css), the board markup in `source/` and the board scripts; anything not specified
by the design is marked **not specified** and any suggestion is marked **suggestion**.

---

## 0. Files in this folder

| Path | What it is | How to use it |
|---|---|---|
| [`source/`](source/) `NN-*.dc.html` | Board sources: markup, copy, inline SVG icons, and the `class Component` script (`lum()` + `renderVals()` accent maths on every board; board 06 also holds the prototype step machine and every timer) | Read for exact markup, copy and icon paths. `{{holes}}` are filled by `renderVals()` |
| [`reference/`](reference/) `NN-*.html` | Static renders of each board (scripts removed, default accent `#0B7D6C`). Board 06 has three extra states: `--greeting`, `--open-home`, `--open-chat` | Open from disk in Chrome; use DevTools for computed values |
| [`reference/css/t2.css`](reference/css/t2.css) | The exact stylesheet. Self-contained: board chrome, both brands, all components and motion. WebYar = root `.t2.b-wy`, Respok = `.t2.b-rp` | Byte-identical to Respok's copy. Brand-specific rules: §3.8 |
| [`reference/css/fonts.css`](reference/css/fonts.css), [`reference/fonts/`](reference/fonts/) | Vazirmatn 400 / 500 / 600 / 700 | Same files as [`../../shared/fonts/`](../../shared/fonts/) |
| [`screens/panels/`](screens/panels/) | Every widget screen at 2x: **the acceptance target**. Each crop includes a 24px (1x) margin around the 400 × 720 panel (390 × 844 for mobile), so the top edge shows part of the board's screen label; ignore it | Compare at device scale factor 2 |
| [`screens/boards/`](screens/boards/) | Whole boards at 1x with the designer's Persian title and explanation (translated in §5) | Context |
| [`screens/states/`](screens/states/) | Board 06 captured in three states (1x) | Launcher, greeting, open home, open chat |
| [`tokens.json`](tokens.json) | Every token with its CSS expression and value for `#0B7D6C`, plus `brandOverrides` | Summarised in §3; do not duplicate |

**Board chrome is not product UI** (ignore): board title and description `.t2-h`, `.t2-d`; screen labels `.tag`; layout
`.t2-row`, `.t2-col`; the `aria-label` on each `section.p` (it is the board's screen name); the fake website `.site`,
`.sbar`, `.page`, `.stage`; prototype buttons `.ctl`; phone chrome `.notch`, `.homebar` and the 46px phone radius of
`.p.mob`; the board root's size, padding and background. **Exception:** the motion-note list `.mn` on board 06 is spec
content and is transcribed in §6.3. The launcher `.wl`, greeting `.greet`, panel open/close, `.scr` view transition,
`.cas` cascade, `.dm` demo messages and the `.lw` drop-out on board 06 are spec (§4.23, §4.24, §6).

---

## 1. Screen inventory

Production views per [production-map](../../shared/production-map.md). Work: **Restyle** (CSS only), **Restyle + markup**
(new renderer markup around existing hooks), **New** (no production equivalent).

| ID | Screen | Screenshot (2x) | Reference page | Production view (production-map §) | Work |
|---|---|---|---|---|---|
| 01 | Home · first visit (اولین بازدید) | [01-home--01-first-visit.png](screens/panels/01-home--01-first-visit.png) | [01-home.html](reference/01-home.html) | §4.1 `homeHtml` | Restyle + markup; ask field and track-order row New |
| 02 | Home · returning visitor (بازدید دوباره) | [01-home--02-returning-visitor.png](screens/panels/01-home--02-returning-visitor.png) | [01-home.html](reference/01-home.html) | §4.1 (continue CTA, recent conversations) | Restyle + markup |
| 03 | Home · team away (تیم آفلاین) | [01-home--03-team-away.png](screens/panels/01-home--03-team-away.png) | [01-home.html](reference/01-home.html) | §4.1 offline home | Restyle + markup |
| 04 | Live chat (گفتگوی زنده) | [02-conversation--04-live-chat.png](screens/panels/02-conversation--04-live-chat.png) | [02-conversation.html](reference/02-conversation.html) | §4.2, §5.1, §5.6, §5.7 | Restyle + markup; visible typing, order card, operator header New |
| 05 | Photos, files and voice (عکس، فایل و صدا) | [02-conversation--05-photos-files-and-voice.png](screens/panels/02-conversation--05-photos-files-and-voice.png) | [02-conversation.html](reference/02-conversation.html) | §5.1 failed send, §5.5, §5.7 recorder | Restyle + markup; reaction New |
| 06 | New conversation (گفتگوی تازه) | [02-conversation--06-new-conversation.png](screens/panels/02-conversation--06-new-conversation.png) | [02-conversation.html](reference/02-conversation.html) | §4.2 `emptyHtml`, §5.12, §5.7 | Restyle + markup; instant-answer tray New |
| 07 | Help search (جستجو در راهنما) | [03-help-and-conversations--07-help-search.png](screens/panels/03-help-and-conversations--07-help-search.png) | [03-help-and-conversations.html](reference/03-help-and-conversations.html) | §4.4 results | Restyle + markup; search wiring, categories New |
| 08 | Article (مقاله) | [03-help-and-conversations--08-article.png](screens/panels/03-help-and-conversations--08-article.png) | [03-help-and-conversations.html](reference/03-help-and-conversations.html) | §4.4 article, §5.14 | Restyle + markup; reading progress, face rating New |
| 09 | Your conversations (گفتگوهای شما) | [03-help-and-conversations--09-your-conversations.png](screens/panels/03-help-and-conversations--09-your-conversations.png) | [03-help-and-conversations.html](reference/03-help-and-conversations.html) | §4.3 | Restyle + markup |
| 10 | Asking for an email (پرسیدن ایمیل) | [04-details-and-feedback--10-asking-for-an-email.png](screens/panels/04-details-and-feedback--10-asking-for-an-email.png) | [04-details-and-feedback.html](reference/04-details-and-feedback.html) | §4.7 handoff card, §5.15 | Restyle + markup; skip link New |
| 11 | Message while away (پیام در زمان آفلاین) | [04-details-and-feedback--11-message-while-away.png](screens/panels/04-details-and-feedback--11-message-while-away.png) | [04-details-and-feedback.html](reference/04-details-and-feedback.html) | §4.2 offline chat, §4.6 contact fallback | Restyle + markup; in-thread offline flow New |
| 12 | Rating after a chat (نظرسنجی پایان گفتگو) | [04-details-and-feedback--12-rating-after-a-chat.png](screens/panels/04-details-and-feedback--12-rating-after-a-chat.png) | [04-details-and-feedback.html](reference/04-details-and-feedback.html) | §5.13 (production has no conversation rating) | New |
| 13 | Mobile · home (خانه) | [05-mobile--13-home.png](screens/panels/05-mobile--13-home.png) | [05-mobile.html](reference/05-mobile.html) | §2 mobile + §4.1 | Restyle |
| 14 | Mobile · conversation (گفتگو) | [05-mobile--14-conversation.png](screens/panels/05-mobile--14-conversation.png) | [05-mobile.html](reference/05-mobile.html) | §2 mobile + §4.2 | Restyle |
| 06a | Live prototype · closed (launcher on the page) | [06-live-prototype--site-mock.png](screens/panels/06-live-prototype--site-mock.png) | [06-live-prototype.html](reference/06-live-prototype.html) | §3.1, §3.2 launcher kit | Restyle (kit) |
| 06b | Live prototype · greeting + unread badge | [06-live-prototype--greeting.png](screens/states/06-live-prototype--greeting.png) (1x board) | [06-live-prototype--greeting.html](reference/06-live-prototype--greeting.html) | §5.11 nudge, §3.2 badge | Restyle + markup |
| 06c | Live prototype · open on home | [06-live-prototype--open-home.png](screens/states/06-live-prototype--open-home.png) (1x board) | [06-live-prototype--open-home.html](reference/06-live-prototype--open-home.html) | §2 panel open, §3.1 launcher while open | Motion |
| 06d | Live prototype · open in a conversation | [06-live-prototype--open-chat.png](screens/states/06-live-prototype--open-chat.png) (1x board) | [06-live-prototype--open-chat.html](reference/06-live-prototype--open-chat.html) | §2, §4.2 view change, §5.1 message entrance | Motion |
| 06m | Motion notes (spec content) | [06-live-prototype.png](screens/boards/06-live-prototype.png) | [06-live-prototype.html](reference/06-live-prototype.html) | — | Transcribed in §6.3 |

---

## 2. Frame and layout

### 2.1 Panel

| Property | Design (`t2.css` `.p`) | Production (`.panel`, created by Core) |
|---|---|---|
| Size | 400 × 720 | `width:400px; height:720px`; keep `max-height: calc(100dvh - 118px)` and `max-width: calc(100vw - 24px)` (brief §4) |
| Radius | `--r-panel` 28px on all corners; the board writes the tail as `border-end-end-radius: var(--tail)` (`--tail` = 28px for WebYar, so no visible difference) | `.panel.bottom-right{border-bottom-right-radius:var(--tail)}`, `.panel.bottom-left{border-bottom-left-radius:var(--tail)}` in both directions (brief §4) |
| Background | `#fff`; home (`.p.home`) `var(--paper)` = `#EEF2F4` | Paint it on the view root (`.wy-view-home` → `--paper`, every other view `#fff`) |
| Shadow | `var(--sh-panel)` = `0 0 0 1px rgba(15,18,23,.05), 0 16px 36px -16px rgba(15,18,23,.24), 0 56px 110px -44px rgba(15,18,23,.4)` | same |
| Clip and stacking | `overflow:hidden; isolation:isolate` | same (`isolation` keeps the hero glow `z-index:-1` inside) |
| Layout | `display:flex; flex-direction:column` | `.body[data-body]` already becomes a flex column when it holds a view (production-map §2); each view root is a full-height flex column |
| Base type | `font-size:14px; line-height:1.6`; family `--font` | on the view root |
| Open / close motion | §6.1 (board 06) | replaces production's `translateY(16px) scale(.97)` transition (CSS:91-96, 113) |

### 2.2 Home (01–03, 13)

Measured on [`reference/01-home.html`](reference/01-home.html), y from the panel's top edge.

| Region | Element | 01 | 02 | 03 | Values |
|---|---|---|---|---|---|
| Hero | `.hero` | 0–320 | 0–320 | 0–320 | `flex:none; overflow:hidden; padding:18px 20px 80px; z-index:0`; height comes from its content (2-line question) |
| · top row | `.hero .top` | 18–66 | same | same | flex, `align-items:center; gap:10px`: `.logo` 48 × 48 (inline-start), `.sp{flex:1}`, close 38 × 38 at y 23 (inline-end) |
| · greeting | `.hi` | 100–123 | same | same | `margin:34px 0 0` |
| · question | `.hq` | 125–198 | same | same | `margin:2px 0 0`; 2 lines × 36.45 |
| · presence | `.pres` | 212–240 | same | same | `margin-top:14px`; 28 tall |
| Ask card | `.ask` | 268–394 | 268–394 | 268–381 | `position:relative; z-index:1; margin:-52px 14px 0` (overlaps the hero's last 52px); `padding:12px` |
| Rows card | `.list` | 410–546 (2 rows) | 410–610 (3 rows) | 397–533 (2 rows) | `margin:16px 14px 0` |
| Footer | `.pw` | 680–720 | same | same | `height:40px; margin-top:auto` (pinned to the bottom); `--paper` shows between the rows card and the footer |

### 2.3 Conversation (04–06, 10–12, 14)

| Region | Element | Box (y) | Values |
|---|---|---|---|
| Header | `.bar` | 0–68 | `position:relative; z-index:3; height:68px; padding:0 10px; gap:6px`; `background:rgba(255,255,255,.86)`; `backdrop-filter:saturate(1.4) blur(14px)`; bottom hairline `box-shadow:0 1px 0 var(--line)` |
| Thread | `.thread` | 68–588 with the idle composer; 68–622 while recording (05); 68–434 when the tray is shown (06); 68–680 with no composer (12) | `flex:1; min-height:0; display:flex; flex-direction:column; justify-content:flex-end; padding:14px 14px 6px`; top fade `mask-image: linear-gradient(to bottom, transparent 0, #000 34px)`. `.thread.top` (06, 11): `justify-content:flex-start`, no mask |
| Instant answers | `.tray` | 434–580 (06) | `margin:0 12px 8px; z-index:2` (a flex item: it takes height from the thread) |
| Composer | `.cmp` | 588–680 (box 594–680); recorder 622–680 | `flex:none; padding:6px 12px 0; z-index:2`. The box ends on the footer's top edge (no bottom padding) |
| Footer | `.pw` | 680–720 | as home |

### 2.4 Help, article, conversation list (07–09)

| Screen | Regions (y) |
|---|---|
| 07 Help search | `.bar` 0–68 · `.sfield` 82–132 · `.cnt` 146–165 · `.res` 171–377 (rows 62.2 / 81.4 / 62.2) · `.sec` 395–415 · `.cats` 425–556 (2 × 2, tiles 181 × 60.8) · footer 680–720 |
| 08 Article | `.bar` 0–68 with `.prog` on its bottom edge (y 67–69) · `.art` 68–533 (`flex:1; min-height:0; overflow:hidden; padding:20px 22px 0`; bottom fade `mask-image: linear-gradient(to bottom, #000 82%, transparent)`) · `.fb` 533–596 · `.cta` 596–676 (+4 margin) · footer 680–720 |
| 09 Your conversations | `.bar` 0–68 · `.inbox` 68–680 (`flex:1; min-height:0; overflow:hidden; padding:8px 10px`; rows 76–363 at 95.6 each; skeleton rows 363–499) · `.fab` 620–668 floating (`position:absolute; bottom:52px`, 12px above the footer) · footer 680–720 |

### 2.5 What scrolls, and shrinking below 720px

The boards are static frames (`overflow:hidden`). In production (brief §4: only the scrolling middle gives up height):

| View | Scroll container | Fixed |
|---|---|---|
| Home | **not specified**; suggestion: one scroll container holding hero + ask card + rows (`.wy-home-scroll`), footer fixed. With the panel's minimum practical height the close button always stays over the hero | footer |
| Chat | the thread = `div.wy-chat-scroll[data-chat-messages]`, bottom-anchored like `.thread`; keep the 34px top fade on the scroll container | header, tray, composer, footer |
| Help (07) | **not specified**; suggestion: keep `.sfield` under the header and scroll everything below it | header, footer |
| Article (08) | `.art` (keep its bottom fade) | header with `.prog`, `.fb`, `.cta`, footer (all `flex:none` in the design) |
| List (09) | `.inbox`; suggestion: give it bottom padding ≥ 60px (48px FAB + 12px) so the last row can scroll clear of the FAB | header, `.fab`, footer |

### 2.6 Z-order inside the panel

`.hero .aur` and `.hero .mk` `z-index:-1` (behind hero content, inside the hero) → `.hero` `0` → `.ask` `1` → `.cmp`, `.tray` `2` →
`.bar` `3` → `.fab` `4` → production `button.panel-close` `20` (CSS:1826) → call host `30` → lightbox (production-map §2).

### 2.7 Close button per view

Production keeps one close control, `button.panel-close[data-panel-close]` (PD:920, absolute, `inset-inline-end`), with its
hook and position logic (brief §4). Give it the design's look and position per view (Core writes `.panel[data-view]`). The
board draws the close inside each header; reserve that slot in the header (an empty 38px item after the last header button)
so the absolute button lands on it.

| View | Look | Position | Icon |
|---|---|---|---|
| `home` (on the hero) | `.gb`: 38 × 38, `border-radius:12px`, `background:rgba(255,255,255,.14)`, `box-shadow: inset 0 0 0 1px rgba(255,255,255,.12)`, `backdrop-filter:blur(10px)`, `color:#fff`; hover `rgba(255,255,255,.24)`; active `scale(.92)` | top 23px, inline-end 20px | X `M6 6l12 12M18 6 6 18`, 20px, stroke 1.9 |
| `chat`, `help`, `list` (white headers) | `.ib`: 38 × 38, `border-radius:12px`, transparent, `color:var(--ink-2)`; hover `var(--paper)`; active `scale(.92)` | top 15px, inline-end 10px | same |
| Mobile | same looks | top = `env(safe-area-inset-top)` + 23px on home (board: 63 = 23 + 40 status bar), + 15px elsewhere (board: 55) | same |

The hero close is hard-coded white (`.gb{color:#fff}`), not `--on-a`; see §8 for light accents.

### 2.8 Mobile (13, 14)

Production: `.shell.gs-mobile-open .panel` stays full screen, radius 0, no shadow, with `env(safe-area-inset-top/bottom)`
padding (production-map §2). Apply these `.p.mob` deltas under `.shell.gs-mobile-open` and, for the first frame, under
`@media (max-width: 640px)` (brief §4).

| `.p.mob` rule | Board value | Production |
|---|---|---|
| `.p.mob` | `width:390px; height:844px; border-radius:46px; font-size:15px` | full screen, radius 0 (46px is phone chrome); keep `font-size:15px` |
| `.p.mob .hero{padding-top:58px}` | 18px + 40px of phone status bar | 18px + `env(safe-area-inset-top)`. Suggestion: on home, move the panel's safe-area top padding into the hero padding so the hero colour reaches the top edge as in [13](screens/panels/05-mobile--13-home.png) |
| `.p.mob .bar{height:auto; padding:54px 10px 10px}` | header 104 tall (54 = 14 + 40 status bar; bottom 10 instead of 14) | `padding:14px 10px 10px` below the safe-area inset |
| `.p.mob .pw{margin-bottom:20px}` | home-indicator space | already provided by the panel's `padding-bottom: env(safe-area-inset-bottom)`; do not add 20px |
| `.p.mob .chips` | one row, `flex-wrap:nowrap; overflow-x:auto; margin-inline:-12px; padding-inline:12px; scrollbar-width:none` (and `::-webkit-scrollbar{display:none}`); edge fade `mask-image: linear-gradient(to var(--fade-to,left), transparent 0, #000 28px, #000 calc(100% - 12px), transparent)`, `[dir=ltr]` sets `--fade-to:right` → a 28px fade at the inline-start edge, 12px at the inline-end edge | same |
| `.p.mob .chip` | `height:40px; padding-inline:12px 14px; font-size:13.5px` | same |
| `.notch`, `.homebar`, `.p.mob .hero .homebar` | phone chrome | ignore |

Measured (13): hero 0–360 (top row 58–106), ask card 308–440 (132 tall: chips row 40), rows 456–592, footer 784–824.
(14): header 0–104, thread 104–692, composer 692–784, footer 784–824. Icon buttons are **not** enlarged on mobile in
`t2.css` (see §8 touch targets).

---

## 3. Tokens

All tokens are defined on the board root `.t2` (L11-42 of `t2.css`). In production define them on `:host, .shell` with
`--a: var(--gs-primary)` and `--on-a: var(--gs-on-primary, #fff)` (brief §5).

### 3.1 Colour

Values for `--a = #0B7D6C` from [`tokens.json`](tokens.json).

| Token | CSS expression | Default | Used for |
|---|---|---|---|
| `--a` | `#0B7D6C` → production `var(--gs-primary)` | `#0B7D6C` | accent: gradient ends, step progress, focus ring, fake carets, read ticks, logo initial, search/composer/email focus ring, selected face ring, chip icons, `.fcard .ok` |
| `--a-1` | `color-mix(in oklab,var(--a) 5%,#fff)` | `#F4F8F7` | chip hover fill, `.tip` fill |
| `--a-2` | `color-mix(in oklab,var(--a) 10%,#fff)` | `#E9F2EF` | icon tiles (`.r .it`, `.tray a .it`, `.res a .it`), `.pill`, `.card .cf .go`, idle `.act`, step-number tiles, face hover/selected, `.ck`, focus halos |
| `--a-3` | `color-mix(in oklab,var(--a) 20%,#fff)` | `#D3E4E0` | chip hover ring, `.card .th` gradient end, `.go:hover`, `.tip` ring, article link underline, current-step halo |
| `--a-hi` | `color-mix(in oklab,var(--a) 88%,#fff)` | `#3A8C7C` | top stop of every accent gradient (`.send`, visitor bubble, `.voice`, `.act.on`, `.fab`, `.csat .btn`) |
| `--a-ink` | `color-mix(in oklab,var(--a) 72%,#0B0D12)` | `#165B51` | text/icons on `--a-2`/`--a-1`, typing status, retry link, article links, `.tip` text |
| `--ink` | `#0F1217` | | primary text |
| `--ink-2` | `#434955` | | header icons, chip text, article body, form labels, footer mark |
| `--ink-3` | `#666D7A` | | secondary text, meta, ask placeholder, tool icons, face icons |
| `--ink-4` | `#A3A9B4` | | chevrons, composer/email/comment placeholders, note icon |
| `--paper` | `color-mix(in oklab,var(--a) 3%,#F4F6F8)` | `#EEF2F4` | home background, ask field, hover fills, day pill, category tiles, faces, comment box, away notice, skeleton base |
| `--paper-2` | `color-mix(in oklab,var(--a) 5%,#ECEFF2)` | `#E2E9EB` | resolved pill, search clear button, category hover, skeleton highlight |
| `--line` | `color-mix(in oklab,var(--a) 7%,#E6E9ED)` | `#D9E1E3` | hairlines and 1px rings (rows card, dividers, header edge, cards, step track, ask field) |
| `--line-2` | `color-mix(in oklab,var(--a) 8%,#D3D8DE)` | `#C5D1D4` | chip ring, ask field hover, composer ring, to-do step ring |
| `--bubble` | `color-mix(in oklab,var(--a) 6%,#F0F2F5)` | `#E4EBEC` | operator bubble, typing bubble, file card |
| `--live` | `#12A150` | | presence dots (`.pr`, `.ondot`, `.welc p i`) |
| `--away` | `#A3A9B4` | | offline presence ring |
| `--bad` | `#D33A43` | | failed send |
| `--rec` | `#E5484D` | | recorder |
| `--unread` / `--unread-ink` | `#FFB423` / `#12141F` | | `.nb` unread badge |
| `--glow` | `color-mix(in oklab,var(--a) 35%,#7CF5DF)` | `#58C9B5` | hero aurora |
| `--h1` | `color-mix(in oklab,var(--a) 70%,#2FE0C0)` | `#169A84` | hero and `.cta` gradient start, hero radial highlight |
| `--h2` | `var(--a)` | `#0B7D6C` | hero and `.cta` gradient middle; base of the presence-avatar ring |
| `--h3` | `color-mix(in oklab,var(--a) 70%,#04211C)` | `#0A5F52` | hero and `.cta` gradient end |
| `--on-a` | `#fff` in the CSS; computed by the board script | `#FFFFFF` | text and icons on the accent (§3.1.1) |
| `--r-panel`, `--tail` | `28px`, `28px` | | panel radius, tail corner |

#### 3.1.1 Accent logic (board scripts, identical in every `source/*.dc.html`)

The board root carries `style="--a: {{accent}}; --on-a: {{onA}}; --kon: {{onA}}; --kac: {{kac}}; {{heroVars}} …"`:

```js
lum(hex) {                       // WCAG relative luminance
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) { h = h.replace(/(.)/g, '$1$1'); }
  if (h.length !== 6) { return 0; }
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
renderVals() {
  const accent = this.props.accent ?? '#0B7D6C';
  const def = String(accent).toUpperCase() === '#0B7D6C';
  const L = this.lum(accent);
  const on = 1.05 / (L + 0.05) >= (L + 0.05) / (this.lum('#16142B') + 0.05) ? '#FFFFFF' : '#16142B';
  return { accent, onA: on, kac: def ? '#22D3B4' : on,
    heroVars: def ? '--h1: #22C4A6; --h2: #0F927D; --h3: #08594E; --glow: #7CF5DF;' : '' };
}
```

- `--on-a`: white when white's contrast against the accent (`1.05 / (L + .05)`) is at least the accent's contrast against
  Ink `#16142B` (L = 0.00845); otherwise `#16142B`. White wins while L ≤ 0.1977. All six presets give white (`#0B7D6C`
  5.04:1, `#2563EB` 5.17, `#7C3AED` 5.70, `#DB2777` 4.60, `#D9480F` 4.30, `#111827` 17.74), and so do the two other colours of the settings palette (brief §5.5: `#4F46E5` 6.29,
  `#15803D` 5.02). Production: compute once in the
  loader next to `--gs-shadow` (LD:1088-1107), publish `--gs-on-primary` (brief §5.3).
- **Brand overrides** (`def`): when the accent is `#0B7D6C` — and, per [`tokens.json`](tokens.json) `brandOverrides.when`,
  also when uncustomised (empty or `#3B82F6`, LD:686-689) — set `--h1 #22C4A6`, `--h2 #0F927D`, `--h3 #08594E`,
  `--glow #7CF5DF` (suggested class `.shell.gs-accent-brand`, brief §5.2). Any other accent uses the formulas above.
- `--kac` (`#22D3B4` with the brand default, else `--on-a`) and `--kon` (= `--on-a`) are set on every WebYar board but read
  only by the Respok launcher `.kl` (`t2.css` L509-515). WebYar has no consumer of either.

#### 3.1.2 Derived and literal colours not in `tokens.json`

Resolved in Chromium for the default accent with brand overrides.

| Expression / value | Where | Resolves to |
|---|---|---|
| `color-mix(in oklab,var(--a) 22%,#fff)` | `mark` (search and tray highlights) | `#CFE2DD` |
| `color-mix(in oklab,var(--h2) 92%,#000)` | `.pres .avs .av` 2px ring | `#0C826F` |
| `color-mix(in oklab,var(--h1) 85%,transparent)` | hero radial highlight | `#22C4A6` at 85% |
| `color-mix(in oklab,var(--glow) 60%,#fff)` | second aurora blob | `#B8FAEC` |
| `color-mix(in oklab,var(--a) 80% / 75% / 36% / 25%,transparent)` | `.send` and `.fab` shadow / `.act.on` shadow / launcher shadow / visitor-bubble shadow | `#0B7D6C` at that alpha |
| `color-mix(in oklab,var(--rec) 45%,#fff)` / `10%` / `70%` | recorder ring / halo / wave bars | `#FCB2AD` / `#FFEEED` / `#F48581` |
| `color-mix(in oklab,var(--a) 55%,#3DF0CF)` | launcher gradient start (`.wl`) | `#22AF97` |
| `color-mix(in oklab,var(--a) 70%,#22D3B4)` | launcher dots (`.wl .dt`) | `#129681` |
| `.c1` `#FCE3D4`/`#8A3410` · `.c2` `#DCE6FB`/`#1C4A92` · `.c3` `#D2EEDF`/`#145E39` · `.c4` `#EBE1FA`/`#57309A` | avatar tiles (background / initial) | — |
| `var(--live-on-hero,#6EF0B4)` | `.pres .dot` (the variable is never defined, so `#6EF0B4`) | `#6EF0B4` |
| `rgba(255,255,255,.7)` inset 2px | `.pres.off .dot` hollow ring | — |
| `#D33A43` | `.file .ft` type label | — |
| `#E5484D` | `.react` heart | — |
| `rgba(10,12,16,.45)` + `blur(6px)` | `.img .cap` | — |
| `linear-gradient(135deg,#F7D8C4,#E9B79A 45%,#C98A6C)`, `rgba(255,255,255,.9)` icon | `.img` placeholder (demo stand-in for a photo) | — |
| `rgba(255,255,255,.22)` / `.95` / `.42` | `.voice .pb` fill / played bars / unplayed bars | — |
| `rgba(255,255,255,.16)` | `.cta .go` | — |
| `rgba(15,18,23,.06)` | `.code` chip (not used on WebYar boards) | — |
| `#FFB423` / `#12141F`, ring `#fff` | launcher badge `.wl .bdg` | — |

### 3.2 Typography

Family: `--font: "Vazirmatn", ui-sans-serif, system-ui, sans-serif` for Persian and Latin (brief §6). Weights used: 400, 500,
600, 700 and 800 (`.nb`, `.file .ft`, `.wl .bdg`); no 800 face ships, so 800 renders with the 700 face, as in the screenshots.
Panel base 14px / 1.6 (mobile 15px).

| Role | Size / line-height / weight / tracking | Classes |
|---|---|---|
| Hero question | 27px / 1.35 / 700 / -.01em, `text-wrap:balance` | `.hq` |
| Hero greeting | 15.5px / 1.5 / 500, opacity .86 | `.hi` |
| Logo initial | 21px / 700 | `.logo` |
| Presence line | 13px / 1.45 / 500 (text span opacity .92) | `.pres` |
| Ask placeholder | 15px / 24px / 400 | `.field .ph` |
| Home chip | 12.5px / 1 / 600 (in thread 13px; mobile 13.5px) | `.chip`, `.qr .chip`, `.p.mob .chip` |
| Offline note | 12.5px / 1.5 | `.note` |
| Row title / sub / end | 14.5px / 1.45 / 600 · 12.5px / 1.5 / 400 (unread 500, `--ink`) · 11.5px | `.r .t1`, `.r .t2x`(`.u`), `.r .end` |
| Unread badge | 11px / 1 / 800 | `.nb` |
| Footer | 11.5px; brand word 700 | `.pw`, `.pw b` |
| Header name / status | 15px / 1.35 / 700 · 12.5px / 1.4 | `.who .nm`, `.who .st` |
| Screen title | 17px / 1.4 / 700 | `.ttl` |
| Day pill | 11.5px / 1.6 / 600 | `.day` |
| System divider | 12px | `.sys` |
| Sender label | 11.5px / 1.5 / 600 | `.who-l` |
| Bubble | 14.5px / 1.65 / 400 | `.b` |
| Meta | 11px / 1.5; error 700; retry 11px / 700 | `.meta`, `.meta .er`, `.meta .retry` |
| Order card | title 13.5px / 1.45 / 700 · sub 12px / 1.5 · pill 11px / 1 / 700 · step 11px / 1.3 / 600 · footer 12.5px (link 700) | `.card .tt b`, `.card .tt small`, `.pill`, `.steps span`, `.card .cf` |
| Attachments | caption 11px · type label 10px / 800 / .02em · file name 13px / 1.5 / 600 · size 11.5px · voice time 11.5px tabular-nums | `.img .cap`, `.file .ft`, `.file .fx b`, `.file .fx small`, `.voice .tm` |
| Reaction | 11px / 700 | `.react` |
| Welcome block | 15.5px / 1.45 / 700 · 12.5px / 1.5 | `.welc h3`, `.welc p` |
| Tray | title 12px / 1.5 / 700 · row 13.5px / 1.45 / 600 · meta 11.5px / 1.5 / 500 | `.tray h4`, `.tray .tt`, `.tray small` |
| Composer text | 14.5px / 26px | `.box .in` |
| Recorder time | 13px / 700, tabular-nums | `.rec .tm` |
| Search field | 15px | `.sfield` |
| Result count / section label | 12px / 600 · 12.5px / 700 | `.cnt`, `.sec` |
| Result title / snippet | 14px / 1.5 / 600 · 12px / 1.6, 2-line clamp | `.res .tt`, `.res small` |
| Category | 13.5px / 1.45 / 700 · 11.5px / 1.5 | `.cat b`, `.cat small` |
| Article | h1 22px / 1.5 / 700 / -.01em · meta 12px · p 14.5px / 1.95 · h2 16px / 1.5 / 700 · list 14px / 1.75 · step number 12px / 700 · tip 13px / 1.75 | `.art h1`, `.am`, `.art p`, `.art h2`, `.ol li`, `.ol li b`, `.tip` |
| Article feedback | 13px / 600 | `.fb` |
| Help CTA | 14px / 1.45 / 700 · 12px / 1.5 / 500, opacity .82 | `.cta .tx`, `.cta .tx small` |
| Conversation row | name 14px / 1.5 / 700 · time 11.5px / 500 · preview 13px / 1.55 (unread 600 `--ink`) | `.ci .l1`, `.ci .l1 time`, `.ci .l2`(`.u em`) |
| New-conversation button | 14px / 700 | `.fab` |
| Email card | label 12px / 700 · input 14px · skip 12.5px / 600 · done 13px / 1.55 | `.fcard label`, `.fcard .fi span`, `.fcard .skip`, `.fcard.done` |
| Away notice | 13.5px / 1.5 / 700 · 12px / 500 | `.away span`, `.away small` |
| CSAT | title 16px / 1.5 / 700 · sub 12.5px · comment 13px / 1.6 · button 14px / 700 · link 12.5px / 600 | `.csat h3`, `.csat p`, `.csat .ta`, `.csat .btn`, `.lnk2` |
| Greeting | title 13px / 1.4 / 700 · body 13.5px / 1.55 / 400 | `.greet .gm span`, `.greet .gm small` |
| Launcher badge | 12px / 22px / 800 | `.wl .bdg` |
| Avatar initials | 36px default 13px / 1 / 700; `.s24` 10px, `.s28` 11px, `.s30` 12px, `.s40` 15px, `.s44` 16px | `.av` |

### 3.3 Radii

| Value | Where |
|---|---|
| 28px (`--r-panel`, `--tail`) | panel |
| 24px | ask card `.ask` |
| 22px | rows card `.list`, composer `.box`, recorder `.rec`, CSAT card |
| 20px | bubbles, order card, file card, email card (with the 6px tail rules, §4.9), typing bubble, tray, `.cta`, greeting (`20 20 6 20`) |
| 18px | ask field `.field`, home row `.r`, category tile, conversation row `.ci`, away notice |
| 16px | search field `.sfield`, result row, `.tip` |
| 15px | `.logo`, CSAT face |
| 14px | order thumb `.th`, tray row, email input `.fi`, CSAT comment and button |
| 13px | row icon tile `.r .it` |
| 12px | `.gb`, `.ib`, article face, away icon tile |
| 11px | composer tool `.ib`, result/category icon tile, `.fcard .ok`, launcher badge |
| 10px | `.card .cf .go`, tray icon tile, `.nb` (20px tall) |
| 9px | file type tile `.ft` |
| 8px | step-number tile `.ol li b`, skeleton bars |
| 6px | bubble tails and joins; `.code` |
| 3px | `mark` |
| 999px / 50% | chips, pills, day pill, reaction, caption, `.fab`, avatars, `.send`, `.act`, `.ring`, `.pb`, `.stop`, `.sfield .x`, `.ck`, `.cta .go`, presence dots, launcher |

### 3.4 Shadows and elevation

| Token / value | Where |
|---|---|
| `--sh-panel` (see §2.1) | panel |
| `--sh-card` = `0 0 0 1px rgba(15,18,23,.045), 0 2px 4px -1px rgba(15,18,23,.05), 0 18px 40px -18px rgba(15,18,23,.28)` | ask card (the one elevated element on home) |
| `0 0 0 1px var(--line)` | rows card `.list`, react base, order card base, file tile, ring, category icon, away icon |
| `inset 0 0 0 1px var(--line)` → hover `var(--line-2)` | ask field |
| `inset 0 0 0 1px var(--line-2)` → hover `inset 0 0 0 1px var(--a-3)` | chip |
| `0 1px 0 var(--line)` | header bottom edge |
| `0 8px 18px -8px rgba(0,0,0,.45)` | `.logo` |
| `0 6px 14px -6px color-mix(…--a 80%…), inset 0 1px 0 rgba(255,255,255,.22)` | `.send` |
| `0 1px 2px color-mix(…--a 25%…)` | visitor bubble |
| `0 0 0 1px var(--line), 0 3px 8px -3px rgba(15,18,23,.18)` | reaction |
| `0 0 0 1px var(--line), 0 8px 20px -14px rgba(15,18,23,.3)` | order card |
| `0 0 0 1px var(--line-2), 0 8px 20px -14px rgba(15,18,23,.3)` → focus `0 0 0 1.5px var(--a), 0 0 0 6px var(--a-2), 0 8px 20px -14px rgba(15,18,23,.3)` | composer box → `.box.fo` |
| `0 6px 14px -6px color-mix(…--a 75%…)` | `.act.on` |
| `0 0 0 1.5px #FCB2AD, 0 0 0 6px #FFEEED` (rec mixes) | recorder |
| `0 0 0 1px var(--line), 0 14px 30px -18px rgba(15,18,23,.35)` | tray |
| `0 0 0 1.5px var(--a), 0 0 0 6px var(--a-2)` | search field (focused) |
| `0 0 0 1.5px var(--a), 0 0 0 5px var(--a-2)` | email input (focused) |
| `inset 0 0 0 1px var(--a-3)` | `.tip` |
| `0 12px 24px -16px rgba(15,18,23,.6)` | `.cta` |
| `0 14px 28px -12px color-mix(…--a 80%…), inset 0 1px 0 rgba(255,255,255,.2)` | `.fab` |
| `0 0 0 1px var(--line), 0 10px 24px -16px rgba(15,18,23,.3)` | email card |
| `0 0 0 1px var(--line), 0 16px 34px -20px rgba(15,18,23,.35)` | CSAT card |
| `inset 0 0 0 1.5px var(--a)` | selected CSAT face |
| `0 16px 36px -10px rgba(15,18,23,.28), 0 0 0 1px rgba(15,18,23,.05)` | greeting |
| `0 12px 28px color-mix(…--a 36%…), 0 3px 8px rgba(18,20,31,.16)` | launcher `.wl` |
| rings `0 0 0 2.5px #fff` (`.avs .av`, `.av .pr`, launcher badge), `0 0 0 3px #fff` (`.welc .av`), `0 0 0 2.5px rgba(255,255,255,.9)` (`.cta .av`), `0 0 0 2px #0C826F` (`.pres .av`) | avatars and badges |

### 3.5 Spacing rhythm

- Side gutters: 14px for home cards (`.ask`, `.list`), the thread (`padding:14px 14px 6px`), the search field and the
  category grid; 12px for the composer and the tray; 10px for headers (`.bar`), result and conversation lists; 20px inside
  the hero; 22px for article text and help section labels.
- Vertical: hero 18 top / 80 bottom; ask card −52 overlap; rows card +16; 14px between message groups; 3px between stacked
  bubbles; meta +2; day pill 14 below; composer +6 above the box; footer 40 tall.
- Gaps: header items 6; row items 12; home chips 6; thread topic chips 8; category grid 10; CSAT faces 8; article faces 8.

### 3.6 Icons

Inline SVG, `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`, `stroke-linecap/linejoin="round"`,
`aria-hidden="true"`, coloured by `currentColor`. Copy the paths from the board named; they replace production's `ICON` set
(PD:72-94). The boards draw direction-dependent chevrons as separate RTL paths (§7).

| Icon | Size / stroke | Where | Board |
|---|---|---|---|
| Close X `M6 6l12 12M18 6 6 18` | 20 / 1.9; 14 / 2.2 (`.sfield .x`); 15 / 2.4 (`.greet .gx`) | `.gb`, header close, search clear, greeting close | 01–06 |
| Back chevron, RTL `m10 6 6 6-6 6` (points right) | 20 / 2 | header back `.ib` | 02, 03, 04, 05, 06 |
| Forward chevron, RTL `m14 6-6 6 6 6` (points left) | 18 / 2 | `.r .ch`, `.tray .ch`, `.cta .go` | 01, 02, 03, 05, 06 |
| More `M5 12h.01M12 12h.01M19 12h.01` | 20 / 3 | chat header | 02, 04, 05 |
| Send arrow `M12 19V5M5.5 11.5L12 5l6.5 6.5` | 20 / 2.2 | `.send`, `.act.on`, `.rec .stop` | 01, 02 |
| Microphone (filled capsule + stand) | 20 / 2 | idle `.act` | 02 |
| Emoji, paperclip | 20 / 1.8 | composer tools | 02 |
| Trash | 20 / 1.8 | recorder delete | 02 |
| Truck | 16 / 1.8 (chip); 18 / 1.7 (`.card .cf`) | topic chip, order footer | 01, 02 |
| Return arrow | 16 / 1.8; 18 / 1.7 | chips, category | 01, 02, 03 |
| Ruler | 16 / 1.8 | chips | 01, 02 |
| Book | 20 / 1.7 (row); 18 / 1.7 (tray, results) | help row, tray, results | 01, 02, 03 |
| Box | 20 / 1.7 (row); 16 / 1.8 (chip); 18 / 1.7 (category) | track-order row, topic, category | 01, 02, 03 |
| Two bubbles | 20 / 1.7; 16 / 1.8 | conversations row, "other topic" chip | 01, 02 |
| Mail | 16 / 1.8 | `.note`, `.lnk2` | 01, 04 |
| Double tick `m2.5 12.5 4 4 8-9M10.5 15.5l1 1 8-9` | 16 / 2 | read tick `.meta .rd` | 02, 04 |
| Error circle | 14 / 2.2 | failed meta | 02 |
| Shoe (product art, demo) | 26 / 1.6 (order thumb); 64 / 1.2 (image placeholder) | order card, image | 02 |
| Image | 13 / 2 | `.img .cap` | 02 |
| Download | 16 / 2 | `.ring` | 02 |
| Progress arc `circle cx=17 cy=17 r=15`, viewBox 0 0 34 34 | 34 / 2.5 | `.ring .arc` | 02 |
| Heart (filled) | 12 | `.react` | 02 |
| Pause (filled bars) | 15 | `.voice .pb` | 02 |
| Sparkle | 16 / 1.7 | `.tray h4` | 02 |
| Search | 20 / 1.9 | `.sfield` | 03 |
| Card, person | 18 / 1.7 | categories | 03 |
| Clock | 15 / 1.8 | article meta | 03 |
| Info | 18 / 1.9 | `.tip` | 03 |
| Faces sad / neutral / happy | 22 / 1.7 | article `.face` | 03 |
| Faces ×5 | 26 / 1.6 | CSAT `.faces` | 04 |
| Plus `M12 5v14M5 12h14` | 20 / 2.2 | `.fab` | 03 |
| Check `m5 12.5 4 4 10-10` | 18 / 2.4 (`.fcard .ok`); 16 / 2.4 (`.ck`) | email card | 04 |
| Moon | 18 / 1.8 | `.away .it` | 04 |
| WebYar mark (viewBox `17 13.5 26 33.5`, filled) | 172px wide | hero watermark `.hero .mk` | 01 = [`webyar-mark.svg`](../../shared/brand/webyar/webyar-mark.svg) |
| WebYar mark with dots (evenodd) | 11 × 15 | footer `.pw .wm` | all = [`webyar-mark-dots.svg`](../../shared/brand/webyar/webyar-mark-dots.svg) |
| Launcher glyph (viewBox `0 0 60 60`) | 60 | `.wl` | 06 = [`webyar-launcher-glyph.svg`](../../shared/brand/webyar/webyar-launcher-glyph.svg) (identical to production `WEBYAR_LAUNCHER_CHAT_GLYPH`, LD:674) |

### 3.7 Motion tokens

| Token | Value | Character |
|---|---|---|
| `--ease` | `cubic-bezier(.2,.9,.25,1)` | decelerate; most transitions |
| `--ease-in` | `cubic-bezier(.55,0,.75,.2)` | accelerate; anything leaving (launcher drop, panel close) |
| `--spring` | `linear(…)` in [`tokens.json`](tokens.json) | overshoots to 1.083 at 54.2%, settles at 1; panel open, cascade, message entrance, `.fab`, greeting, launcher rise |
| `--bounce` | `linear(…)` in [`tokens.json`](tokens.json) | overshoots to 1.179 at 33.3%; buttons, pops, badge |

Older-browser fallback for both `linear()` curves: `cubic-bezier(.2,.9,.25,1)` (brief §7). Keyframes (`t2.css` L561-581):
`t2-drift`, `t2-ping`, `t2-ph`, `t2-caret`, `t2-wave`, `t2-rise`, `t2-msg`, `t2-pop`, `t2-fill`, `t2-now`, `t2-sheen`,
`t2-dl`, `t2-bar`, `t2-blink`, `t2-read-in`, `t2-shim`, `t2-fab`, `t2-pick`, `t2-dots`, plus the Respok-only `t2-pill`,
`t2-dotpop`. Their frames are listed in §6.1.

### 3.8 Brand-specific rules in `t2.css`

- **WebYar only:** `.b-wy .cta{background:linear-gradient(165deg,var(--h1),var(--h2) 60%,var(--h3))}` (Respok paints the
  card `--ink`) and the `.wl` launcher.
- **Respok only:** every `.b-rp …` selector (50): the token block (L43-54: ink/paper/line/bubble, Signal status colours,
  hero stops, `--tail:8px`, Figtree), hero/aurora/watermark/greeting sizes, chip outline, row tiles, typing colour, bubble
  line-height and flat visitor bubble, tick colour, code font, order-card tiles, voice, composer focus and caret
  (`#FF5A3C`), `.act`, tray, `mark`, search focus, result/category tiles, article type, `.tip`, `.fab`, email card,
  selected face, CSAT button, greeting radius, `.mn`, `.curve`, focus colour; plus `.kl`, `.lk`, `.g-o`/`.g-t`.
- Production: shared rules with WebYar values in `presentation-simple.css`; the `.b-rp` deltas in
  `presentation-simple-intl.css` (brief §3).

---

## 4. Components

Use the design class names as written (they are scoped to the template's shadow root). Where a production element exists,
it keeps its production classes and hooks and gains the design class (brief §2.3). Buttons drawn as `<a href="#">` in the
boards (rows, results, categories, tray rows, `.cta`, conversation rows) become `<button type="button">` unless they really
navigate away (`.card .cf .go` tracking link, `.pw` platform link, links inside article HTML).

### 4.1 Panel shell

See §2.1 and §2.7. The shell's `.panel-close` is the only close control on every view.

### 4.2 Home hero `.hero`

| Part | Values |
|---|---|
| Box | `position:relative; z-index:0; flex:none; overflow:hidden; padding:18px 20px 80px; color:var(--on-a)` |
| Background | `radial-gradient(120% 90% at 100% 0%, color-mix(in oklab,var(--h1) 85%,transparent), transparent 62%), linear-gradient(165deg, var(--h1) 0%, var(--h2) 52%, var(--h3) 100%)` (the radial sits at the physical top-right in both directions) |
| Aurora `.aur` (`aria-hidden`) | `position:absolute; inset:0; z-index:-1; pointer-events:none; overflow:hidden`; two `i` blobs `border-radius:50%; filter:blur(26px)`: (1) `top:-120px; inset-inline-end:-80px; 300 × 260; radial-gradient(closest-side, var(--glow), transparent); opacity:.55`, drift 16s; (2) `bottom:-140px; inset-inline-start:-90px; 300 × 240; radial-gradient(closest-side, color-mix(in oklab,var(--glow) 60%,#fff), transparent); opacity:.26`, drift 22s (§6.1) |
| Watermark `.mk` | WebYar mark, `position:absolute; z-index:-1; top:-30px; inset-inline-end:-26px; width:172px; color:#fff; opacity:.08; pointer-events:none` (RTL: top-left) |
| Top row `.top` | `display:flex; align-items:center; gap:10px` → `.logo` · `.sp{flex:1}` · close slot |
| `.logo` | 48 × 48, `border-radius:15px; background:#fff; color:var(--a)`; initial 21px / 700; `box-shadow:0 8px 18px -8px rgba(0,0,0,.45)`. Production: `identityAvatarHtml` (PD:106-119): workspace logo image inside the tile, otherwise the workspace initial; `showLogo === false` removes it (the spacer keeps the close at the end) |
| `.hi` greeting | §3.2; `margin:34px 0 0` |
| `.hq` question | §3.2; `margin:2px 0 0`; the copy carries an explicit line break (`<br>`) |
| `.pres` presence | `display:flex; align-items:center; gap:10px; margin-top:14px` → `.avs` (3 × 28px, initials 11px, ring `0 0 0 2px #0C826F`, overlap −9px) + `span` (opacity .92) starting with `i.dot` |
| `.pres .dot` | 8 × 8 circle, `margin-inline-end:6px; vertical-align:1px; background:var(--live-on-hero,#6EF0B4)`; `::after` = same colour, ping animation |
| `.pres.off` | dot `background:transparent; box-shadow:inset 0 0 0 2px rgba(255,255,255,.7)`, no ping; avatars `filter:grayscale(1) brightness(1.05); opacity:.8` |

Production: replaces `div.wy-head.wy-head-home` + `section.home-greeting-block` (PD:1266-1279). Team avatars follow
production's `showTeamAvatars` opt-out (PD:1195). People are drawn as initials on `.c1`–`.c4` tiles, never photos (brand
sheet); tile assignment is **not specified** (the boards give `.c1` to the first member, `.c2` second, `.c3` third, `.c4`
to the store) — suggestion: by position in `teamMembers`.

### 4.3 Avatars and presence

| Element | Values |
|---|---|
| `.av` | `display:grid; place-items:center; flex:none; width/height 36px; border-radius:50%`; 13px / 1 / 700; sizes `.s24` `.s28` `.s30` `.s40` `.s44` (§3.2); colour tile `.c1`–`.c4` |
| `.av .pr` presence | 12 × 12 circle, `position:absolute; bottom:-1px; inset-inline-end:-1px; background:var(--live); box-shadow:0 0 0 2.5px #fff` (RTL: bottom-left of the avatar) |
| `.av .pr.off` | `background:#fff; box-shadow: inset 0 0 0 2.5px var(--away), 0 0 0 2.5px #fff` |
| `.avs` stack | `display:flex; flex:none`; each `.av` after the first `margin-inline-start:-9px`; ring `0 0 0 2.5px #fff` (later avatars paint over earlier ones) |
| `.ondot` | 7 × 7 circle `--live`, before the header status text |

### 4.4 Ask card `.ask`

| Part | Values |
|---|---|
| Card | `position:relative; z-index:1; margin:-52px 14px 0; padding:12px; border-radius:24px; background:#fff; box-shadow:var(--sh-card)` |
| `.field` | `display:flex; align-items:center; gap:8px; height:56px; padding-inline:16px 8px; border-radius:18px; background:var(--paper); box-shadow:inset 0 0 0 1px var(--line); cursor:text`; transition `box-shadow .2s ease, background-color .2s ease`; hover ring `--line-2` |
| `.ph` placeholder stack | `position:relative; flex:1; min-width:0; height:24px; overflow:hidden`; 15px / 24px `--ink-3`; three `span`s `position:absolute; inset:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; opacity:0`, rotating (§6.1) |
| Fake caret `.ph::before` | `top:3px; inset-inline-start:0; width:1.5px; height:18px; border-radius:1px; background:var(--a); z-index:1`, blinking |
| `.field.static` (offline) | one span, `position:static; opacity:1`, no animation, no caret |
| `.send` | 42 × 42 circle at the field's inline-end, `background:linear-gradient(180deg,var(--a-hi),var(--a)); color:var(--on-a)`; shadow §3.4; hover `translateY(-1px) scale(1.05)`; active `scale(.92)` (transition `transform .2s var(--bounce)`). Arrow icon is direction-neutral |
| `.chips` | `display:flex; flex-wrap:wrap; gap:6px; margin-top:12px` (mobile: one scrolling row, §2.8) |
| `.chip` | `display:inline-flex; align-items:center; gap:6px; height:34px; padding-inline:10px 12px; border-radius:999px; background:#fff; box-shadow:inset 0 0 0 1px var(--line-2)`; 12.5px / 600 `--ink-2`, `white-space:nowrap`; 16px icon `color:var(--a)`; hover `background:var(--a-1)`, ring `--a-3`, text `--a-ink`; active `scale(.95)` |
| `.note` (offline, replaces the chips) | `display:flex; align-items:center; gap:8px; margin:12px 4px 2px`; 12.5px / 1.5 `--ink-3`; 16px mail icon `--ink-4` |

Production: new. The field holds a real `<textarea rows="1">` (suggested hook `data-home-ask`); the `.ph` stack is an
overlay shown only while the input is empty. Focus look **not specified**; suggestion: the composer's focused ring
(`.box.fo`, §4.16) on `.field:focus-within`, and hide the fake caret while the real one shows. Send (button or Enter) →
`data-home-action="chat"` with the draft: Core opens a new conversation and sends the text as its first message (brief §9).
Topic chips: suggested hook `data-topic="<label>"` → open a conversation with the topic as the first message (prototype:
every chip opens the conversation). With no topics configured, suggestion: render up to three article chips in the same
look with production's `data-home-article=<slug>` (keeps that hook emitted); with neither, render no `.chips`. Fewer than
three placeholder lines → render `.field.static` (suggestion).

### 4.5 Home rows `.list > .r`

| Part | Values |
|---|---|
| `.list` | `margin:16px 14px 0; padding:4px; border-radius:22px; background:#fff; box-shadow:0 0 0 1px var(--line)` |
| `.r` | `position:relative; display:flex; align-items:center; gap:12px; min-height:64px; padding:10px 12px; border-radius:18px; color:var(--ink)`; hover `background:var(--paper)` (`.18s ease`) |
| Divider | `.r + .r::before{top:0; inset-inline:62px 12px; height:1px; background:var(--line)}`; hidden when either neighbouring row is hovered |
| `.it` icon tile | 40 × 40, `border-radius:13px; background:var(--a-2); color:var(--a-ink)`; 20px icon, stroke 1.7 |
| `.tx` | column, `flex:1; min-width:0`: `.t1` title, `.t2x` sub (one line, ellipsis); `.t2x.u` = unread preview (`--ink`, 500) |
| `.ch` chevron | 18px, `--ink-4`; hover `translateX(3px)`, RTL `translateX(-3px)` (`.2s var(--ease)`) |
| `.end` (continue row) | column, `gap:5px`, 11.5px `--ink-3`, `align-items:flex-end` (RTL `flex-start`): time label, then `.nb` |

| Row | Leading | Title / sub | Trailing | Hook |
|---|---|---|---|---|
| Continue a conversation (02) | operator avatar `.av.s40` + `.pr` (when the operator is online) | `ادامه گفتگو با {name}` / last message preview (`.u` while unread) | `.end`: time label + `.nb` | `data-conversation-open=<unresolved id>` |
| Your conversations (02) | two-bubbles tile | `گفتگوهای شما` / `{n} گفتگو، یکی باز است` | `.ch` | `data-view="list"` |
| Help center (01–03) | book tile | `مرکز راهنما` / online `{n} مقاله درباره {categories}`, offline `بیشتر پاسخ‌ها همین‌جاست، همیشه در دسترس` | `.ch` | `data-view="help"` |
| Track order (01, 03; new, commerce) | box tile | `پیگیری سفارش` / `با شماره سفارش، وضعیت را همین‌جا ببینید` | `.ch` | new, suggested `data-home-action="track-order"`; behaviour **not specified** |

Row order and count are **not specified** as a rule. The three boards are reproduced by: rows in the order continue →
your conversations → help center → track order, each only when available, at most three (suggestion). Conversation load
error (production `home-conv-error`, PD:1227-1234) is **not drawn**; suggestion: the conversations row with the error text
as its sub and `data-home-action="conversations-retry"`.

### 4.6 Unread badge `.nb`

`display:inline-grid; place-items:center; min-width:20px; height:20px; padding:0 6px; border-radius:10px;`
`background:var(--unread); color:var(--unread-ink)`; 11px / 1 / 800; Persian digits (production `fmtNum`, `99+` cap, PD:1147-1150).

### 4.7 Powered-by footer `.pw`

`display:flex; align-items:center; justify-content:center; gap:6px; flex:none; height:40px; margin-top:auto`; 11.5px `--ink-3`;
`.wm` 11 × 15 `--ink-2` (WebYar mark with dots); then `قدرت گرفته از` and the brand word in `b` (700, `--ink-2`). RTL order:
mark (inline-start), label, brand. Production: `div.wy-footer > span.wy-conn[data-conn-indicator] + a.wy-powered` (PD:127-165)
— render the inner as `svg.wm` + `span(label)` + `b(platform)`; keep the anchor attributes and the indicator as a sibling.
The design shows no connection dot: suggestion: keep `span.wy-conn` but give it no visible size while
`data-conn-state="online"`; its other states are **not specified** (suggestion: production's dot and ring). With no
`poweredBy` payload the view extends to the bottom edge (production-map §8.6).

### 4.8 Top bar `.bar`, icon buttons, identity, title, reading progress

| Part | Values |
|---|---|
| `.bar` | §2.3 |
| `.ib` | 38 × 38, `border-radius:12px; background:transparent; color:var(--ink-2)`; hover `--paper`; active `scale(.92)` (`background-color .18s ease, transform .18s var(--ease)`); `[dir=rtl] .ib .dirf{transform:scaleX(-1)}` exists for mirrored glyphs |
| Order (RTL, right → left) | back `.ib` · `.who` (flex 1) · more `.ib` (chat only, not on 06) · close slot |
| `.who` | `display:flex; align-items:center; gap:10px; flex:1; min-width:0; padding-inline:2px` → avatar `.av.s40` (+ `.pr`) or `.avs` of three `.s28` (06), then `.nm` over `.st` |
| `.st` variants | online: `.ondot` + `آنلاین`; typing: `.st.typ` (`color:var(--a-ink)`) `در حال نوشتن` + three 4px dots (wave); new conversation: reply-time text; offline store: `آفلاین؛ پاسخ با ایمیل`; prototype: `.ondot` + workspace name |
| `.ttl` (help, article, list) | `flex:1; margin:0; padding-inline:4px`; 17px / 1.4 / 700 |
| `.prog` (article) | `position:absolute; bottom:-1px; inset-inline-start:0; height:2px; width:100%; background:var(--a); transform-origin:var(--ps,right) center` (`[dir=ltr]` `--ps:left`); `transform:scaleX(.36)` in the board = 36% read; intro `t2-read-in` |

Production: chat → `div.header.wy-head.wy-head-chat[data-chat-header]` keeping `div.presence.sr-only[data-presence]`
(PD:958-969); back → `button.wy-back[data-view-back="home"]` (article: `data-view-back="back"` + `data-view-back-fallback="home"`).
Chat identity is new (assigned operator name, presence, typing; §9); fallback suggestion: workspace avatar + name + reply
time. The more button's menu is **not specified**: do not render it until it has actions (suggestion).

### 4.9 Thread: day pill, system divider, groups, bubbles, meta

| Part | Values |
|---|---|
| `.day` | `align-self:center; margin:2px 0 14px; padding:3px 10px; border-radius:999px; background:var(--paper)`; 11.5px / 1.6 / 600 `--ink-3`. Production `div.msg-day > span` (PD:556-560) |
| `.sys` | `display:flex; align-items:center; gap:10px; margin:6px 6px 14px`; 12px `--ink-3`; `::before`/`::after` `flex:1; height:1px; background:var(--line)`. Production `div.msg-row.system > div.msg-system-pill` (PD:358-361) |
| `.g` group | `display:flex; align-items:flex-end; gap:8px; max-width:86%; margin-bottom:14px`; with an order card `max-width:94%` |
| Sides (physical, both directions) | visitor `.g.R` on the right, operator `.g.L` on the left with the avatar outermost. RTL: `.g.L{align-self:flex-end; flex-direction:row-reverse}`, `.g.R{align-self:flex-start}`; LTR the reverse (`t2.css` L206-209) |
| `.s` stack | `display:flex; flex-direction:column; gap:3px; min-width:0`; items align to the group's outer side |
| Operator avatar | `.av.s28` initial tile, `margin-bottom:22px` (sits beside the last bubble, above the meta) |
| `.who-l` sender label | first item of an operator run, `margin:0 12px 1px`; 11.5px / 1.5 / 600 `--ink-3` |
| `.b` bubble | `width:fit-content; max-width:100%; padding:9px 14px; border-radius:20px; overflow-wrap:anywhere; text-align:start`; 14.5px / 1.65 |
| Operator bubble | `background:var(--bubble); color:var(--ink)` |
| Visitor bubble | `background:linear-gradient(180deg,var(--a-hi),var(--a) 75%); color:var(--on-a); box-shadow:0 1px 2px color-mix(in oklab,var(--a) 25%,transparent)` |
| Tail and joins | operator items (`.b`, `.card`, `.file`, `.fcard`): `20px 20px 20px 6px`; any of them that follows another item in the stack gets `border-top-left-radius:6px` — including the first bubble when the sender label precedes it. Visitor items (`.b`, `.img`, `.voice`): `20px 20px 6px 20px`, following items `border-top-right-radius:6px` |
| `.meta` | `display:flex; align-items:center; gap:4px; margin:2px 8px 0`; 11px / 1.5 `--ink-3`: time, then read tick `.rd` (16px double tick, `--a`) on visitor messages |
| Failed (`.g.fail`) | bubble `opacity:.72`; meta = error icon `.er` (14px, `--bad`) + `span.er` `ارسال نشد` (700, `--bad`) + `button.retry` `تلاش دوباره` (no background, 11px / 700 `--a-ink`, underline, offset 2px) |

Production mapping (message contract, production-map §5.1, must stay): one `.msg-row` per message.
- A run = consecutive `.msg-row`s with the same group key (PD:638-643). Rows inside a run: `margin-bottom:3px`; the
  `.is-last` row: `margin-bottom:14px`. `max-width` 86% applies to the row.
- Operator avatar on the `.is-last` row (`span.msg-avatar`, here an initial tile, 28px) and a 28px spacer on earlier rows
  of the run — for every operator, not only those with `senderAvatar` (production drops the layer, PD:704-710).
- Sender label: new `span.msg-sender-label` (suggested) in the first row of an operator run (needs a first-of-run flag the
  renderer can compute from the same group keys).
- `.b` = `div.msg`; remove the inline visitor background (PD:665, brief §2.6). `.meta` = `.msg-footline > .msg-meta`
  (`.msg-time`, `.msg-ticks`, `.msg-ticks.is-failed` + `button.msg-retry-btn[data-msg-retry]`).
- Tick states other than "read" are **not specified**; suggestion: `sending` spinner and single tick in `--ink-3`,
  delivered double tick `--ink-3`, seen double tick `--a` (as drawn).
- Reply/copy actions (`.msg-actions`), quotes, links, AI badge: **not drawn** (§4.26).

### 4.10 Typing indicator

| Where | Values |
|---|---|
| Thread row `.typing` (new group, operator side) | `display:flex; align-items:center; gap:4px; height:38px; padding:0 15px; border-radius:20px; border-bottom-left-radius:6px; background:var(--bubble)`; three 7 × 7 dots `--ink-3`, wave 1.2s, delays 0 / .15s / .3s; avatar `.av.s28` beside it (no meta, so the avatar sits 22px up) |
| Header `.st.typ` | `در حال نوشتن` + three 4 × 4 dots `currentColor` (`--a-ink`), same wave |

Production: new visible row (brief §9). Keep `div.sr-only[data-typing-row]` for announcements; render the visible row as the
thread's last item while Core reports operator typing (`setOperatorTyping`, LD:705-708): Core passes it to the renderer
as `view.operatorTyping {name, avatar}` and `messagesHtml` renders `div.msg-row.operator.is-last.typing-row`; mark it `aria-hidden="true"`. The board's `aria-label="در حال نوشتن"` on the
row is covered by the sr-only region.

### 4.11 Reaction badge `.react`

On the bubble (`.b.rel{position:relative; margin-bottom:10px}`): `position:absolute; bottom:-10px; inset-inline-end:10px;`
`display:flex; align-items:center; gap:3px; height:22px; padding:0 7px; border-radius:999px; background:#fff`; shadow §3.4;
11px / 700 `--ink-2`; filled heart 12px `#E5484D`; count in Persian digits (`۱`). RTL: bottom-left of the operator bubble.
New (server + Core); render nothing when unavailable.

### 4.12 Order card `.card`

| Part | Values |
|---|---|
| Card | `width:296px; max-width:100%; overflow:hidden; background:#fff`; ring + shadow §3.4; operator tail radii (§4.9) |
| `.ch1` | `display:flex; align-items:center; gap:12px; padding:12px 14px` |
| `.th` thumb | 46 × 46, `border-radius:14px; background:linear-gradient(140deg,var(--a-2),var(--a-3)); color:var(--a-ink)`; product icon 26px (demo; suggestion: product image when available) |
| `.tt` | column, `flex:1; min-width:0`: `b` `سفارش {number}`, `small` item summary |
| `.pill` status | `display:inline-flex; align-items:center; gap:5px; height:22px; padding:0 9px; border-radius:999px; background:var(--a-2); color:var(--a-ink)`; 11px / 1 / 700; `white-space:nowrap`. `.pill.done`: `--paper-2` / `--ink-3` |
| `.steps` | `position:relative; display:flex; justify-content:space-between; margin:2px 18px 0; padding-top:12px` |
| Track | `::before` and `::after`: `position:absolute; top:17px; inset-inline:28px; height:3px; border-radius:2px; background:var(--line)`; `::after` = progress: `inset-inline-end:auto; width:calc((100% - 56px) * .6667); background:var(--a); transform-origin` inline-start (fill animation). Fraction = done segments / (steps − 1); the board shows step 3 of 4 → .6667 |
| Step | `span`: `position:relative; z-index:1; display:flex; flex-direction:column; align-items:center; gap:7px; width:56px`; 11px / 1.3 / 600 `--ink-3`, centered; done and current labels `--ink` |
| Step dot `i` | 13 × 13 circle: to do `background:#fff; box-shadow:inset 0 0 0 3px var(--line-2)`; done `.ok` `background:var(--a); box-shadow:0 0 0 3px #fff`; current `.now` `background:#fff; box-shadow:inset 0 0 0 4px var(--a), 0 0 0 4px var(--a-3)` + pulse |
| `.cf` footer | `display:flex; align-items:center; gap:8px; margin-top:12px; padding:10px 14px; border-top:1px solid var(--line)`; 12.5px `--ink-3`; truck 18px; `تحویل:` + `b` day (`--ink`, 700) |
| `.go` | `margin-inline-start:auto; display:inline-flex; align-items:center; gap:5px; height:32px; padding:0 12px; border-radius:10px; background:var(--a-2); color:var(--a-ink)`; 12.5px / 700; hover `--a-3`. A real link to the carrier's tracking page (suggestion: `target="_blank" rel="noopener"`) |

New: needs order data in the message (suggested `metadata.kind === 'order_status'`: number, summary, status label, steps,
current index, delivery day, tracking URL), from the store context the loader already supports (`data-commerce-*`). Without
it, render nothing.

### 4.13 Attachments

| Kind | Values | Production (production-map §5.5) |
|---|---|---|
| Image `.img` (visitor) | `position:relative; display:grid; place-items:center; width:224px; height:168px; overflow:hidden`; visitor tail radii; demo gradient + 64px icon stand in for the photo; `::after` sheen (`linear-gradient(110deg, transparent 30%, rgba(255,255,255,.35) 50%, transparent 70%)`, loops); caption `.cap`: `position:absolute; bottom:8px; inset-inline-start:8px; display:flex; align-items:center; gap:6px; height:24px; padding:0 9px; border-radius:999px; background:rgba(10,12,16,.45); backdrop-filter:blur(6px)`; 11px `#fff`; image icon 13px + file name | `button.msg-att-img-btn[data-att-preview] > img[data-att-media-src]` fills 224 × 168 (`object-fit:cover`, suggestion). The sheen runs forever on the board; suggestion: run it only while `.is-loading`. Keep the loading and fallback spans |
| File `.file` (operator) | `display:flex; align-items:center; gap:12px; width:250px; padding:10px 12px; background:var(--bubble)`; operator tail radii; `.ft` 40 × 46, `border-radius:9px; background:#fff; box-shadow:0 0 0 1px var(--line)`, type label 10px / 800 `#D33A43`, `letter-spacing:.02em` (`PDF`); `.fx` column: name 13px / 600 one line ellipsis, size 11.5px `--ink-3` (`۲۴۰ کیلوبایت`); `.ring` download 34 × 34 circle `#fff`, `color:var(--a-ink)`, ring `--line`, 16px download icon; `.arc` 34 × 34 rotated −90°, circle r 15, stroke `--a` 2.5 round, `stroke-dasharray:94`, offset 94 → 24 | `div.msg-att.msg-att-file`: `.msg-att-icon` = `.ft` (label from the extension), `.msg-att-meta` = `.fx`, `a.msg-att-action[data-att-download][data-att-download-name]` = `.ring`. Size in Persian digits and Persian units (production prints `240 KB`, PD:260-265). The arc is download progress (new); without progress data show the ring without the arc (suggestion) |
| Voice `.voice` (visitor) | `display:flex; align-items:center; gap:10px; width:244px; padding:8px 14px 8px 8px` (RTL `8px 8px 8px 14px`); visitor gradient, `color:var(--on-a)`; `.pb` 34 × 34 circle `rgba(255,255,255,.22)`, `#fff` 15px icon (board shows pause = playing); `.wave` `display:flex; align-items:center; gap:2px; flex:1; height:28px; direction:ltr`; bars `flex:1; max-width:3px; min-height:4px; border-radius:2px`, played `rgba(255,255,255,.95)`, unplayed `.d` `.42`; 24 bars with inline heights 8, 10, 10, 6, 20, 22, 12, 16, 18 (played) / 8, 14, 7, 16, 20, 10, 14, 18, 6, 12, 12, 12, 8, 9, 24; played bars bounce while playing; `.tm` 11.5px tabular-nums, opacity .9 (`۰:۱۴`) | `div.msg-att.msg-att-audio[data-audio-player]`: `.pb` = `button.wy-ap-play[data-audio-toggle]` (play/pause icons swap with `.is-playing`), `.wave` = `div.wy-ap-track[data-audio-seek]` with progress = played share, `.tm` = `span.wy-ap-time[data-audio-time]` (Persian digits). The play button sits at the inline-start and only the wave runs LTR, so do not put `dir="ltr"` on the whole player (production does, PD:295); keep the track LTR. `data-audio-rate` and `a.wy-ap-dl` are **not drawn**: keep both nodes (hooks), suggestion `display:none`. Bar heights without waveform data: **not specified** (suggestion: the board's 24 heights as a fixed pattern) |

### 4.14 New-conversation welcome and quick topics

| Part | Values |
|---|---|
| `.welc` | `display:flex; flex-direction:column; align-items:center; gap:6px; margin:6px 10px 16px; text-align:center`: `.avs` of three 40px avatars (15px initials, ring `0 0 0 3px #fff`), `h3` `تیم پشتیبانی {workspace}` (`margin:4px 0 0`), `p` (`display:flex; align-items:center; gap:7px`) with an 8px `--live` dot + `آنلاین هستیم` |
| Welcome bubble | normal operator group (avatar, no sender label): `config.welcomeMessage` or `t('intro')` (PD:220-222) |
| `.qr` topics | `display:flex; flex-wrap:wrap; gap:8px; max-width:92%; margin:0 0 6px`, on the visitor side (RTL `align-self:flex-start; justify-content:flex-start`; LTR `flex-end`); chips as §4.4 at `height:36px; padding-inline:12px 14px; font-size:13px`, staggered rise |

Production: `emptyHtml()` (PD:215-237) gains the `.welc` block above the welcome row. Topics = Q&A chips
(`div.qna-suggestions[data-qna] > button.qna-chip[data-qna-question]`, PD:239-258) in the `.qr` look, or the suggested
`data-topic`; production's `.qna-title` is not drawn (omit or `sr-only`); `qna-more` + `+N` is **not drawn** (suggestion:
a chip in the same look). The last chip `موضوع دیگر` (other topic) — behaviour **not specified**; suggestion: focus the
composer.

### 4.15 Instant-answer tray `.tray`

| Part | Values |
|---|---|
| Box | `position:relative; z-index:2; margin:0 12px 8px; padding:6px; border-radius:20px; background:#fff`; shadow §3.4; rises in |
| `h4` | `display:flex; align-items:center; gap:7px; margin:4px 8px 6px`; 12px / 1.5 / 700 `--ink-3`; sparkle 16px `--a`: `پاسخ‌های آماده از مرکز راهنما` |
| Row `a` | `display:flex; align-items:center; gap:10px; padding:8px; border-radius:14px; color:var(--ink)`; hover `--paper`; `.it` 32 × 32 `border-radius:10px; background:var(--a-2); color:var(--a-ink)` (book 18px); `.tt` 13.5px / 600 one line ellipsis; `small` 11.5px / 500 `--ink-3` `{n} دقیقه مطالعه`; `.ch` 18px `--ink-4` |
| `mark` | `padding:0 1px; border-radius:3px; background:color-mix(in oklab,var(--a) 22%,#fff); color:inherit` — matched words of the draft |

New: KB search as the visitor types (brief §9). Render as the first child of `div.composer-zone[data-composer-zone]`, shown
while the draft has matches; the board shows two rows (maximum **not specified**). Row → open the article (suggestion:
`data-kb-action="open" data-kb-slug` if Core binds them outside the help view, else a new hook). Highlight by wrapping
escaped matches in `mark` (never inject raw HTML).

### 4.16 Composer and recorder

| State | Values |
|---|---|
| `.cmp` | §2.3 |
| `.box` (= `div.input-wrap[data-input-wrap]`) | `display:flex; flex-direction:column; gap:2px; padding:12px 8px 6px; border-radius:22px; background:#fff`; idle ring `0 0 0 1px var(--line-2)` + drop (`box-shadow .22s ease`) |
| Focused / typing `.box.fo` | ring `0 0 0 1.5px var(--a), 0 0 0 6px var(--a-2)` + drop — apply on `:focus-within` |
| `.in` (= `textarea.input[data-msg-input]`) | `min-height:26px; padding:0 10px`; 14.5px / 26px `--ink`; placeholder `--ink-4` (`پیامتان را بنویسید…`). The board's `.in.ty::after` caret (1.5 × 17, `--a`) imitates the real caret; production uses the real one. Max height **not specified** (production: 15rem) |
| `.tools` row | `display:flex; align-items:center; gap:2px`, 40px tall: emoji `.ib` and attach `.ib` (36 × 36, `border-radius:11px; color:var(--ink-3)`) at the inline-start, `.sp{flex:1}`, then `.act` at the inline-end |
| `.act` idle = mic | 40 × 40 circle `background:var(--a-2); color:var(--a-ink)`; `transform .25s var(--bounce), background-color .2s ease`; active `scale(.9)`; `aria-label="ضبط پیام صوتی"` |
| `.act.on` = send | `background:linear-gradient(180deg,var(--a-hi),var(--a)); color:var(--on-a)`; shadow §3.4; pops in (`t2-pop .45s var(--bounce)`); `aria-label="ارسال"` |
| Recording `.rec` (replaces the box) | `display:flex; align-items:center; gap:8px; height:52px; padding:0 6px 0 8px` (physical, not mirrored); `border-radius:22px; background:#fff`; rings `#FCB2AD` 1.5px + `#FFEEED` 6px. Children (RTL right → left): delete `.ib` 38 × 38 (trash), `.dot` 10 × 10 `--rec` (`margin-inline-start:6px`, blink), `.tm` 13px / 700 tabular-nums `--ink` (`۰:۰۸`), `.wave` 24px tall, 24 bars `#F48581` animated, `.stop` 40 × 40 circle `--rec` with `#fff` send arrow (`aria-label="ارسال پیام صوتی"`) |
| Offline (11) | same idle composer, placeholder `اگر چیزی اضافه دارید بنویسید…` |
| Closed conversation (12) | no composer |

Production (production-map §5.7; fixed control set and DOM order must stay): `div.input-bar[data-input-bar]` = `.cmp`;
`input-wrap` = `.box`. Lay `div.input-row[data-input-row]` out as a two-row grid — textarea across row 1; row 2 =
emoji, attach, flexible gap, mic/send — with `.composer-actions` and `.composer-actions-start` set to `display:contents`
so their buttons become grid items (DOM order `mic, textarea, send, attach, file input, emoji` stays). `mic-btn[data-mic-btn]`
= idle `.act`; `send-btn[data-send-btn]` = `.act.on`; both occupy the same cell: hide the send while `.input-bar` lacks
`.has-draft` and the mic is present, hide the mic once `.has-draft` is set (board 02: "the record button turns into the
send button once something is typed"). Without voice notes, suggestion: the send button stays in the cell, idle look until
a draft exists. `.input-bar.is-recording`: the wrap takes the `.rec` look and `div.rec-bar[data-rec-bar]` shows (delete =
`rec-cancel[data-rec-cancel]`, `.dot` = `rec-dot`, `.tm` = `rec-time[data-rec-timer][role=timer]`, `.wave` = `rec-wave`
with 24 `i`, `.stop` = `rec-confirm[data-rec-stop]`). Production's stop opens the voice preview (`vn-bar`), which is
**not drawn**, while the design's button reads "send voice message" — a flow decision for the owner (§9). Recorder time in
Persian digits (production prints `0:00`, production-map §7). Suppress the textarea's own outline inside the wrap
(`RT:42-62` already does it for some wrappers).

### 4.17 Help search, results, categories

| Part | Values |
|---|---|
| `.sfield` | `display:flex; align-items:center; gap:10px; height:50px; margin:14px 14px 0; padding:0 8px 0 14px` (RTL `0 14px 0 8px`); `border-radius:16px; background:#fff`; 15px `--ink`; drawn focused: ring `0 0 0 1.5px var(--a), 0 0 0 6px var(--a-2)` (idle look **not specified**; suggestion: `0 0 0 1px var(--line-2)` like the composer); search icon 20px `--ink-3`; `.q` `flex:1` (board caret `::after` 1.5 × 18 `--a`); clear `.x` 28 × 28 circle `background:var(--paper-2); color:var(--ink-3)`, X 14px, `aria-label="پاک کردن"` |
| `.cnt` | `margin:14px 22px 6px`; 12px / 600 `--ink-3`: `{n} مقاله پیدا شد` |
| `.res` | `display:flex; flex-direction:column; margin:0 10px`; row `a`: `display:flex; align-items:flex-start; gap:12px; padding:11px 12px; border-radius:16px`; hover `--paper`; `.it` 34 × 34 `border-radius:11px; margin-top:1px; --a-2/--a-ink`; `.tt` 14px / 1.5 / 600; `small` 12px / 1.6 `--ink-3`, 2-line clamp; both with `mark` |
| `.sec` | `margin:18px 22px 10px`; 12.5px / 700 `--ink-3`: `یا از یک موضوع شروع کنید` |
| `.cats` | `display:grid; grid-template-columns:1fr 1fr; gap:10px; margin:0 14px` |
| `.cat` | `display:flex; align-items:center; gap:12px; padding:12px; border-radius:18px; background:var(--paper)`; hover `--paper-2` + `translateY(-2px)`; `.it` 36 × 36 `border-radius:11px; background:#fff; color:var(--a-ink); box-shadow:0 0 0 1px var(--line)` (18px icon); `b` name; `small` `{n} مقاله` |

Production (`kbHtml`, PD:1431-1463): the header becomes `.bar` with `.ttl` `مرکز راهنما` (production shows the identity
block). Compose `kbSearchBarHtml` (PD:1345-1351) as `.sfield` with the new hook `data-kb-search` on the input (brief §9);
keep `aria-label` from `t('searchKb')`. Results rows = `button.kb-article[data-kb-action="open"][data-kb-slug]` in the
`.res a` look (production's chevron is not drawn). `searching` state: skeleton rows in the `.sk` look (§4.19). Empty query
(help home) is **not drawn**; suggestion: `.sfield` + `.sec` + `.cats`. Zero results (`kbEmptyHtml`, PD:1353-1364) **not
drawn**; suggestion: `.cnt` with the empty text + the `.cta` card. Category tile → its article list (new, suggested
`data-kb-category`); category icons are not in the KB data (**not specified**; suggestion: book icon as default).

### 4.18 Article, feedback faces, still-need-help card

| Part | Values |
|---|---|
| Header | `.bar` with back, `.ttl` = the article's category name (`سفارش و ارسال`), close slot, `.prog` |
| `.art` | §2.4; `h1` 22px / 1.5 / 700 / −.01em, `text-wrap:balance`; `.am` `display:flex; align-items:center; gap:14px; margin:12px 0 16px`, 12px `--ink-3`, items `inline-flex; gap:6px`: author `.av.s24` + name, clock 15px + `{n} دقیقه مطالعه` |
| Body | `p` `margin:0 0 14px`, 14.5px / 1.95 `--ink-2`; `p a` `color:var(--a-ink); font-weight:600; text-decoration:underline; text-decoration-color:var(--a-3); text-underline-offset:3px`; `h2` `margin:4px 0 10px`, 16px / 1.5 / 700 |
| `.ol` numbered steps | `display:flex; flex-direction:column; gap:10px; margin:0 0 14px; padding:0; list-style:none`; `li` `display:flex; gap:10px`, 14px / 1.75 `--ink-2`; number tile `b` 24 × 24, `border-radius:8px; margin-top:1px; background:var(--a-2)`, 12px / 700 `--a-ink`, Persian digits |
| `.tip` | `display:flex; gap:10px; padding:12px 14px; border-radius:16px; background:var(--a-1); box-shadow:inset 0 0 0 1px var(--a-3)`; 13px / 1.75 `--a-ink`; info icon 18px |
| `.fb` feedback | `display:flex; align-items:center; gap:8px; flex:none; margin:0 14px; padding:12px 8px; border-top:1px solid var(--line)`; 13px / 600 `--ink-2`; `این مقاله کمک کرد؟`, `.sp`, then three `.face` |
| `.face` | 38 × 38, `border-radius:12px; background:var(--paper); color:var(--ink-3)`; 22px faces; hover `translateY(-2px) scale(1.08)`, `--a-2` / `--a-ink`. DOM order (RTL right → left after the spacer): `نه` (sad), `تا حدی` (neutral), `بله` (happy, leftmost) |
| `.cta` | `display:flex; align-items:center; gap:12px; flex:none; margin:0 14px 4px; padding:12px 14px; border-radius:20px; background:linear-gradient(165deg,var(--h1),var(--h2) 60%,var(--h3)); color:#fff`; shadow §3.4; `.avs` three `.s28` (ring `rgba(255,255,255,.9)`); `.tx` `هنوز سؤال دارید؟` + `small` `با تیم گفتگو کنید؛ ` + reply time; `.go` 36 × 36 circle `rgba(255,255,255,.16)` with a white chevron, hover `translateX(3px)` (RTL −3px) |

Production: article body = `vm.article.contentHtml` (KB HTML, unescaped, PD:1421-1428): style generic `h2`, `p`, `a`, `ol > li`
(number tiles via CSS counters with Persian digits — suggestion) and a callout class for `.tip` if the KB editor produces one
(**not specified**). The title `h1`, author and reading time are template markup (new VM fields `article.categoryTitle`,
`article.author`, `article.readingMinutes`; hide what is missing). `.prog` needs the scroll position of the article
container (new; hide when unavailable). Move the feedback block out of the scroll area (it is `flex:none` in the design).
Faces → `div.kb-feedback[data-kb-feedback]` with `button.kb-rate[data-kb-rate][aria-pressed]`: `بله` → `up`, `نه` → `down`;
`تا حدی` has no production value (new value or hide it, §9). Selected face look **not specified**; suggestion: the CSAT
`.faces button.on` look. Thanks text and the post-"down" CTA (PD:1413-1417) are **not drawn**; the `.cta` is always shown
and carries `data-kb-action="switch-chat"`.

### 4.19 Conversation list, skeleton, new-conversation button

| Part | Values |
|---|---|
| `.ci` row | `display:flex; align-items:flex-start; gap:12px; padding:12px; border-radius:18px; color:var(--ink)`; hover `--paper`; operator `.av.s44` (+ `.pr` while online) |
| `.tx` | column, `flex:1; min-width:0; gap:2px` |
| `.l1` | `display:flex; align-items:center; gap:8px`; name 14px / 700; `time` `margin-inline-start:auto`, 11.5px / 500 `--ink-3` |
| `.l2` | `display:flex; align-items:center; gap:8px`; 13px / 1.55 `--ink-3`; `em` `flex:1; font-style:normal`, one line ellipsis; unread `.l2.u em` `--ink` / 600; `.nb` |
| `.pl` | `margin-top:4px`: `.pill` `باز` (open) or `.pill.done` `حل شد` (resolved) |
| `.sk` skeleton row | `display:flex; align-items:center; gap:12px; padding:12px`; bars `i` `display:block; border-radius:8px; background:linear-gradient(90deg,var(--paper) 0%,var(--paper-2) 40%,var(--paper) 80%); background-size:200% 100%`, shimmer (reverse in RTL). Board shapes (inline): circle 44, lines 45% × 12 and 80% × 10 with `gap:8px`; the second row `opacity:.55` |
| `.fab` | `position:absolute; bottom:52px; left:50%; transform:translateX(-50%); z-index:4; display:inline-flex; align-items:center; gap:8px; height:48px; padding:0 20px; border-radius:999px; background:linear-gradient(180deg,var(--a-hi),var(--a)); color:var(--on-a)`; 14px / 700; plus 20px; shadow §3.4; enters with `t2-fab` |

Production (`conversationListHtml`, PD:1292-1326): header → `.bar` with `.ttl` `گفتگوهای شما`; rows →
`button.conv-row.ci[data-conversation-open]` (PD:1161-1173) with the operator's initial instead of the workspace avatar
(new field, fallback `c.title || workspaceName`), preview prefixed `شما: ` when the visitor wrote last (new field), status
pill from `c.status`; `button.wy-fab[data-home-action="chat"]` moves from the header to `.fab` with a visible label. The
`loading` state uses `.sk` rows (keep them `aria-hidden`, production-map §8.5); skeleton rows *after* loaded rows (older
pages) need pagination (new). Error and empty states (PD:1301-1312) **not drawn**; suggestion: `.cnt`-style text + an
outline-free `.go`-style retry button.

### 4.20 Email card in the thread `.fcard`

| Part | Values |
|---|---|
| Card | `width:270px; padding:12px; background:#fff`; ring + shadow §3.4; operator tail radii (it follows bubbles, so top-left 6px) |
| `label` | `display:block; margin:0 4px 6px`; 12px / 700 `--ink-2`: `ایمیل` |
| `.fi` | `display:flex; align-items:center; gap:6px; height:46px; padding-inline:12px 5px; border-radius:14px; background:#fff; direction:ltr`; drawn focused: `0 0 0 1.5px var(--a), 0 0 0 5px var(--a-2)` (idle **not specified**; suggestion `0 0 0 1px var(--line-2)`); text 14px, placeholder `--ink-4` (`name@example.com`), value `.v` `--ink` |
| `.ok` | 36 × 36, `border-radius:11px; background:var(--a); color:var(--on-a)`; check 18px; `aria-label="ثبت ایمیل"`; on the physical right in both directions (`.fi` is LTR) |
| `.skip` | `display:block; margin:10px 4px 0`; no background; 12.5px / 600 `--ink-3`: `نه ممنون، همین‌جا منتظر می‌مانم` |
| Done `.fcard.done` | `display:flex; align-items:center; gap:10px`; 13px / 1.55 `--ink-2`; `.ck` 30 × 30 circle `--a-2` / `--a-ink`, check 16px, pops in; text `پاسخ را به ` + `b` email (`--ink`, `direction:ltr; unicode-bidi:isolate`) + ` می‌فرستیم.` |

Production: `handoffPrechatCardHtml` (PD:798-816) restyled and placed in an **operator** row (production renders it as a
visitor row). Field row = `div.prechat-field[data-field="email"]`: `label.prechat-label[for=prechat-email]` = `label`,
`div.prechat-control` = `.fi` containing `input#prechat-email.prechat-input[data-prechat="email"][dir=ltr]` and the submit
`button.hc-submit[data-prechat-submit]` in the `.ok` look; keep `span.prechat-status` and
`div.prechat-error#prechat-err-email[data-err="email"][role=alert]`. Error look **not specified**; suggestion: `.fi` ring
`0 0 0 1.5px var(--bad)` and the error text 12px `--bad` under the field. Other asked fields (name, phone) **not drawn**;
suggestion: one `.fi` row each, the submit only on the last. `.skip`: new hook (suggested `data-prechat-skip`), only when
email is not required (`identity.isRequired`). The two bubbles above the card are system copy (§10). Done state: new.

### 4.21 Away notice and auto-reply

`.away`: `display:flex; align-items:center; gap:12px; margin:0 0 16px; padding:12px 14px; border-radius:18px;`
`background:var(--paper)`; `.it` 36 × 36 `border-radius:12px; background:#fff; color:var(--ink-2);`
`box-shadow:0 0 0 1px var(--line)` (moon 18px); text column `الان آفلاین هستیم` (13.5px / 700) + `small` office-hours line (12px / 500 `--ink-3`).
It is the first item of a top-aligned thread (`.thread.top`). Auto-reply = operator group with the store avatar (`.c4`
initial), no sender label: bubble `پیامتان ثبت شد.`, done card (§4.20), meta `پاسخ خودکار` instead of a time.

### 4.22 Rating after a chat `.csat`

| Part | Values |
|---|---|
| Card | `align-self:stretch; margin:2px 4px 6px; padding:18px 16px 16px; border-radius:22px; background:#fff; text-align:center`; shadow §3.4; rises in |
| Head | `.av.s44` centred (`margin:0 auto`); `h3` `margin:8px 0 2px` `گفتگو با {name} چطور بود؟`; `p` 12.5px `--ink-3` `نظرتان کمک می‌کند بهتر شویم.` |
| `.faces` | `display:flex; justify-content:center; gap:8px; margin:14px 0`; five buttons 46 × 46, `border-radius:15px; background:var(--paper); color:var(--ink-3)`, 26px faces; hover `translateY(-3px) scale(1.08)`; selected `.on` `background:var(--a-2); color:var(--a-ink); box-shadow:inset 0 0 0 1.5px var(--a)` + `aria-pressed="true"` + pick animation. DOM order (RTL right → left): `خیلی بد`, `بد`, `معمولی`, `خوب`, `عالی` |
| `.ta` comment | `height:64px; padding:10px 12px; border-radius:14px; background:var(--paper)`; 13px / 1.6, placeholder `--ink-4`, `text-align:start`: `چیز دیگری هم بگویید (اختیاری)` |
| `.btn` | `display:flex; align-items:center; justify-content:center; gap:8px; width:100%; height:46px; margin-top:10px; border-radius:14px; background:linear-gradient(180deg,var(--a-hi),var(--a)); color:var(--on-a)`; 14px / 700: `ارسال نظر` |
| `.lnk2` | `display:inline-flex; align-items:center; gap:6px; margin-top:10px`; 12.5px / 600 `--ink-3`; mail 16px: `ارسال متن گفتگو به ایمیل` |

New (production has no conversation rating, production-map §5.13). Shown after the system divider `{name} گفتگو را بست`
when the conversation closes; the conversation has no composer. Needs a rating API (1–5 + optional comment) and a
transcript-by-email API; suggested hooks `data-csat-rate="1…5"` (with `aria-pressed`), `data-csat-comment`,
`data-csat-submit`, `data-csat-transcript`. Submitted state **not specified**. Without the API, render nothing.

### 4.23 Launcher (board 06, `.wl`)

| Part | Design | Production WebYar kit (production-map §3.2) |
|---|---|---|
| Glyph | `path.bd` body + three `path.dt` diamonds, viewBox `0 0 60 60`, full bleed | identical (`WEBYAR_KIT_CHAT_GLYPH`, LD:674) |
| Size / shape | 60 × 60 circle | kit base 60px × `fab.scale` |
| Ground | `linear-gradient(140deg, color-mix(in oklab,var(--a) 55%,#3DF0CF), var(--a))` = `#22AF97 → #0B7D6C` | brand mode `linear-gradient(140deg,#22D3B4,#0B7D6C)`; custom accent = flat accent |
| Body / dots | body `#fff` (`currentColor`); dots `color-mix(in oklab,var(--a) 70%,#22D3B4)` = `#129681` | dots `#18AD94` (brand) / accent |
| Shadow | `0 12px 28px color-mix(in oklab,var(--a) 36%,transparent), 0 3px 8px rgba(18,20,31,.16)` | `0 12px 28px rgba(11,125,108,.36), 0 3px 8px rgba(18,20,31,.16)` (same for `#0B7D6C`) |
| Hover / active | `translateY(-3px) scale(1.06)` / `scale(.94)` (`transform .22s var(--ease), box-shadow .22s ease`) | hover identical; active inherits `scale(.92)` (LD:543) |
| Idle | dots bob: `t2-dots` 3s, delays 0 / .1s / .2s (right → left dot) | none (wave only on hover; bob while typing) |
| Badge `.bdg` | `top:-5px; inset-inline-end:-5px` (RTL: top-left); `min-width:22px; height:22px; padding:0 6px; border-radius:11px; background:#FFB423; color:#12141F`; 12px / 22px / 800; ring `0 0 0 2.5px #fff`; hidden `scale(0)`, shown `.5s var(--bounce) .35s` | `top:-6px; right:-6px`; 24 × 24; 13px / 24px / 800; ring 3px; `wy-kit-badge-in .45s` |
| Open / close | §6.1: drop `translateY(130px)` .26s `--ease-in`; rise .5s `--spring` after .22s | slides by `--gs-fab-exit` (.28s `cubic-bezier(.22,1,.36,1)`); rise = WAAPI 280ms (LD:955-995) |

Production: keep the WebYar kit for `simple` (chosen by edition only, brief §3; the brand sheet calls the kit unchanged) and
its glyph, ping, typing and offline states. Apply this design's open/close timing (brief §4) and badge-in timing. Ground,
dot colour, badge geometry and the idle dot wave differ from the kit as tabled; which side wins is an owner decision (§9).
Unread count in Persian digits (LD:690-693, 1972-1974).

### 4.24 Greeting bubble (board 06, `.greet`)

| Part | Values |
|---|---|
| Box | `position:absolute; bottom:96px; right:20px` in the board frame = 16px above the 60px launcher (launcher `bottom:20px`), aligned to its outer edge; `z-index:4; display:flex; align-items:flex-start; width:280px; border-radius:20px 20px 6px 20px` (tail corner = the launcher's corner); `background:#fff`; shadow §3.4; `transform-origin:100% 100%`; `role="status"` |
| `.gm` (whole message, a button) | `display:flex; flex:1; gap:10px; min-width:0; padding:14px 4px 14px 14px` (RTL `14px 14px 14px 4px`); no border/background; `text-align:start; color:var(--ink)`: avatar `.av.s30` + `span` (column, `gap:2px`, 13px / 1.4 / 700 title) with `small` body (13.5px / 1.55 / 400 `--ink-2`). Measured: 280 × 90 |
| `.gx` close | 40 × 40, transparent, `color:var(--ink-3)`, X 15px stroke 2.4, at the inline-end top (RTL: top-left), inside the bubble; `aria-label="بستن پیام"` |

Production: the smart-engagement launcher nudge (production-map §5.11; loader `surfaceHtml` LD:2698-2708, styles
LD:596-632 and the template copy CSS:1034-1100). Map `.gm` → `[data-smart-cta]` (the whole message is the click target; it
runs the rule action, `open_chat` opens straight into the conversation as in the prototype), `.smart-title` + `.smart-body`
inside it, `.gx` → `button.smart-dismiss[data-smart-dismiss]` inside the bubble (production: 22px circle outside, top-right).
Avatar source **not specified** (suggestion: the sender's initial tile, else the workspace initial). A visible CTA label
(`cta_label`) is **not drawn** (suggestion: use it as the button's accessible name). Position: bottom
`calc(var(--gs-fab-size) + 16px)`; for `position: bottom-left`, mirror the tail to `6px` bottom-left and the origin to
`0 100%` (brief §4). Keep `.entering` / `.leaving`, auto-hide and the reduced-motion opt-outs; update the loader's
SHELL_CSS copy too or the bubble restyles when the template sheet lands (LD:594-595 comment). The greeting and the unread
badge appear together; opening clears both; dismissing hides only the greeting.

### 4.25 Keyboard focus

`:where(.t2) :is(button,a,[role=textbox]):focus-visible{outline:2px solid var(--a); outline-offset:2px}`; on the hero
`outline-color:#fff`. Production Core already rings `2px solid var(--gs-primary)` with offset 2px (RT:42-62) — but that rule
also sets `border-radius:6px` on focused `button/a/input/textarea` and outranks single-class selectors: restate the radius
of round and pill controls under `:focus-visible` (`.send`, `.act`, `.chip`, `.fab`, `.ring`, `.pb`, `.stop`, `.x`,
faces, rows) or their shape changes on keyboard focus.

### 4.26 Not drawn in this design

| Element | Production | Suggestion (closest specified values) |
|---|---|---|
| Emoji picker | `div.emoji-picker[data-emoji-picker]` (6-column grid) | white card `border-radius:20px`, `box-shadow` of the tray, placed above `.cmp` like `.tray` |
| Pending attachment row | `div.att-preview[data-attach-preview]` inside the wrap above the input | keep inside `.box` above `.in`; thumbnail 40 × 46 like `.file .ft` |
| Voice preview | `div.vn-bar[data-vn-bar]` | `.rec` geometry with `.voice` content |
| Reply preview, quote, links, AI badge, message actions | production-map §5.1, §5.7 | restyle with T2 tokens; links in bubbles `--a-ink` underlined like `.art p a` |
| Jump to latest | `button.wy-jump[data-chat-jump]` | `.fab` look at 36px |
| Call card, call surface, routing pills | §5.2–§5.4 | out of scope; routing pills in the `.sys` look |
| Lightbox | `div.att-lightbox` | unchanged |
| Home smart card | `section.smart-home-card` | between the ask card and the rows, `.list` card look |
| Help empty / list errors | §4.3, §4.4 | §4.17, §4.19 suggestions |

---

## 5. Screens

Designer's notes are translated from each board's description (`.t2-d`).

### 5.1 · 01 Home, first visit

Board 01 designer's note: "Everything starts from one box: the visitor writes the question right there or picks a topic.
Conversations and the help center are two simple rows that take the place of the bottom menu. When the widget opens, the
content comes in one after another."

[Screenshot](screens/panels/01-home--01-first-visit.png). Purpose: first open, team online, no earlier conversations.
- Layout: §2.2 (hero 0–320, ask card 268–394, rows 410–546, footer 680–720).
- Copy: `.hi` `سلام 👋`; `.hq` `چطور می‌توانیم` / `کمکتان کنیم؟`; `.pres` `آنلاین هستیم، معمولاً در ۲ دقیقه پاسخ می‌دهیم`;
  placeholders rotating `سؤالتان را بنویسید…`, `مثلاً: سفارشم کی می‌رسد؟`, `مثلاً: سایز ۴۲ موجود است؟`; chips (workspace
  topics) `زمان ارسال` (truck), `مرجوعی کالا` (return), `راهنمای سایز` (ruler); rows help center
  (`۲۴ مقاله درباره سفارش، ارسال و مرجوعی`) and track order; footer.
- Data: workspace logo or initial (`ف` in the board), team members (initials `س`, `م`, `ر`), `isOnline`,
  `replyTimeText(true)`, ask examples (new), topics (new), KB article count and top categories (new on the home VM),
  commerce availability (new).
- Interactions: type + send/Enter → new conversation with the text; chip → conversation with the topic; help row → help
  view; track-order row → **not specified**; close.
- Production: `homeHtml(vm)` rewritten: drop `wy-head-home`, `home-greeting-block`, `home-recent`, `home-chips` and the
  `wy-actions` buttons (keep the footer); keep `[data-home-action="chat"]` (on `.send`), `[data-view="help"]`, and the
  smart card/error hooks (§4.5, §4.26).

### 5.2 · 02 Home, returning visitor

[Screenshot](screens/panels/01-home--02-returning-visitor.png). Purpose: a visitor with earlier conversations, one still open.
- Layout and differences from 01: `.hi` `سلام علی، خوش برگشتی 👋` (visitor name; generic greeting when unknown); rows card 410–610
  with three rows: continue (`.av.s40.c1` + `.pr`, `ادامه گفتگو با سارا`, `.t2x.u`
  `خواهش می‌کنم! کار دیگری هست که کمک کنم؟`, end `۱۰ دقیقه پیش` + `.nb` `۲`), your conversations
  (`۳ گفتگو، یکی باز است`), help center. No track-order row.
- Data: `vm.conversations` (latest unresolved: id, operator name (new), operator online (new), preview, `timeLabel`,
  `unreadCount`); total and open counts; visitor name (new; from `identify()` or contact).
- Interactions: continue row → that conversation; conversations row → list view; the rest as 01.
- Production: continue row = production's primary "continue last conversation" CTA (`data-conversation-open`, PD:1252-1255);
  conversations row = `button.home-link[data-view="list"]` (PD:1215).

### 5.3 · 03 Home, team away

[Screenshot](screens/panels/01-home--03-team-away.png). Purpose: home while the team is offline.
- Layout and differences from 01: `.hq` `پیامتان را` / `بگذارید`; `.pres.off` `آفلاین هستیم، از ساعت ۹ صبح پاسخ می‌دهیم`; `.field.static`
  `پیامتان را بنویسید…`; `.note` `پاسخ را صبح به ایمیلتان می‌فرستیم` instead of chips (ask card 268–381); help row sub
  `بیشتر پاسخ‌ها همین‌جاست، همیشه در دسترس`; rows 397–533.
- Data: `isOnline === false`; office-hours text: production has only `replyTimeText(false)` / `homeReplySlow` (PD:187-193);
  a structured opening time ("۹ صبح", "صبح") is new.
- Interaction: sending leaves a message (flow in 11).
- Production: same `homeHtml` with `isOnline === false` (production-map §4.1 "offline home").

### 5.4 · 04 Live chat

Board 02 designer's note: "A new message grows from its tail corner, the order card shows the status with a progress bar,
and the record button turns into the send button once something is typed. While typing, ready answers from the help
center appear above the box."

[Screenshot](screens/panels/02-conversation--04-live-chat.png). Purpose: an ongoing conversation with an assigned operator.
- Top → bottom: header (avatar `س` + `.pr`, `سارا`, `.st.typ` `در حال نوشتن` + dots, more, close); thread 68–588,
  bottom-anchored and overflowing under the 34px top fade (the first visitor bubble and the day pill are cut, as drawn):
  day `امروز`; visitor bubble 19:42 + read tick; operator run (label `سارا`, bubble, order card, meta `۱۹:۴۴`); visitor
  `عالیه، ممنون!` 19:46 + read tick; typing row (new group, enters); idle composer (mic); footer.
- Order card: `سفارش ۴۸۲۱۳` / `کفش رانینگ، سایز ۴۲`, pill `ارسال شد`, steps `ثبت` (done), `آماده‌سازی` (done), `ارسال`
  (current), `تحویل` (to do), footer `تحویل:` `پنجشنبه`, link `پیگیری مرسوله` (all values demo; labels UI).
- Data: assigned operator (name, online, typing), messages (`s.messages[]`, production-map §4.2), order metadata (new).
- Interactions: back → home; typing in the composer swaps the mic for send; order link opens the tracking page.
- Production: `chatFrameHtml` (header, composer), `messagesHtml` (thread), new typing row and order card (§4.10, §4.12).

### 5.5 · 05 Photos, files and voice

[Screenshot](screens/panels/02-conversation--05-photos-files-and-voice.png). Purpose: attachments, a reaction, a failed
send and the recorder.
- Top → bottom: header status `.ondot` + `آنلاین`. Thread 68–622: day; visitor image 224 × 168 with caption `IMG_2041.jpg`, 20:04 + read;
  operator run (label, file card `PDF` / `فاکتور-۴۸۲۱۳.pdf` / `۲۴۰ کیلوبایت` with download ring, bubble
  `این هم فاکتور سفارشتان.` with reaction `۱`, meta `۲۰:۰۶`); visitor voice note (playing, `۰:۱۴`) 20:07 + read; failed
  visitor message `آدرس جدید: تهران، خیابان ولیعصر، پلاک ۱۲` + `ارسال نشد` `تلاش دوباره`; recorder 628–680 (`۰:۰۸`).
- The voice button's `aria-label` is `پخش پیام صوتی` (play) while it shows the pause icon (playing state); production
  toggles the label with the state.
- Interactions: image → lightbox (`data-att-preview`); ring → download; voice button → play/pause, wave → seek; `تلاش دوباره`
  → resend (`data-msg-retry`); recorder delete / send (§4.16).
- Production: `renderMessageAttachment` (PD:269-331), `messagesHtml` failed state (PD:676-685), `rec-bar` (PD:1065-1081);
  reaction new (§4.11).

### 5.6 · 06 New conversation

[Screenshot](screens/panels/02-conversation--06-new-conversation.png). Purpose: a fresh conversation, the visitor typing a
first question.
- Top → bottom: header: `.avs` (three `.s28`), `گفتگوی تازه`, `معمولاً در ۲ دقیقه پاسخ می‌دهیم`; no more button. `.thread.top` 68–434:
  welcome block 88–185 (`تیم پشتیبانی فروشگاه نیلوفر`, `آنلاین هستیم`), welcome bubble 201–267
  (`سلام! سؤالتان را بنویسید یا یکی از موضوع‌ها را انتخاب کنید.`), topics 281–361 (`پیگیری سفارش`, `مشاوره خرید`,
  `مرجوعی و بازگشت وجه`, `موضوع دیگر`). Tray 434–580 for the draft `مرجوعی کفش`: `شرایط مرجوعی کالا` (`۲ دقیقه مطالعه`),
  `بازگشت وجه بعد از مرجوعی چقدر طول می‌کشد؟` (`۱ دقیقه مطالعه`), `مرجوعی` highlighted. Composer focused (`.box.fo`),
  `.act.on` send.
- Data: team members, workspace name, online state, welcome message, topics, KB matches for the draft (new).
- Interactions: topic chip → sends the topic; tray row → article; send → first message.
- Production: `emptyHtml` + Q&A chips + new tray (§4.14, §4.15). Whether the welcome block also shows above a conversation
  started from the home ask field is **not specified**.

### 5.7 · 07 Help search

Board 03 designer's note: "Search returns results as you type and highlights the searched word. The article has a
reading-progress bar and at the end the way to a conversation is open. The conversation list opens from the «Your
conversations» row on home."

[Screenshot](screens/panels/03-help-and-conversations--07-help-search.png). Purpose: searching the help center.
- Top → bottom: header `مرکز راهنما`; search `ارسال` (focused); `۳ مقاله پیدا شد`; three results with `mark` on `ارسال` in titles and
  snippets; `یا از یک موضوع شروع کنید`; categories `سفارش و ارسال` (box, `۵ مقاله`), `پرداخت` (card, `۴ مقاله`), `مرجوعی`
  (return, `۳ مقاله`), `حساب کاربری` (person, `۶ مقاله`). Geometry §2.4.
- Data: `vm.query`, `vm.results` (+ snippet and match ranges: new), `vm.categories` (+ counts, icon: new).
- Interactions: typing searches as you type; clear empties the query; result → article; category → its articles (new).
- Production: `kbHtml` state `results` + search field + categories (§4.17).

### 5.8 · 08 Article

[Screenshot](screens/panels/03-help-and-conversations--08-article.png). Purpose: reading one article, rating it, reaching
the team.
- Top → bottom: header `.ttl` `سفارش و ارسال` + `.prog` at 36%; `h1` `چطور سفارشم را پیگیری کنم؟`; meta `سارا` · `۲ دقیقه مطالعه`;
  paragraph with link `حساب کاربری، بخش سفارش‌ها`; `h2` `کد رهگیری کجاست؟`; three numbered steps; tip
  `به‌روزرسانی وضعیت مرسوله ممکن است تا ۲۴ ساعت طول بکشد.` (all article content is demo); feedback
  `این مقاله کمک کرد؟` + three faces; CTA `هنوز سؤال دارید؟`; footer. Geometry §2.4.
- Data: `vm.article` (+ category title, author, reading time: new), `vm.feedback` (production-map §4.4).
- Interactions: back (`data-view-back="back"`, fallback home); scrolling advances `.prog`; face → rating; CTA → chat.
- Production: `kbHtml` state `article`, `kbArticleFeedbackHtml` (§4.18).

### 5.9 · 09 Your conversations

[Screenshot](screens/panels/03-help-and-conversations--09-your-conversations.png). Purpose: all of the visitor's
conversations.
- Top → bottom: header `گفتگوهای شما`; rows: `سارا` (online, `۱۰ دقیقه پیش`, unread preview + `۲`, `باز`), `مهدی` (`دیروز`, `حل شد`),
  `رضا` (`۵ روز پیش`, `شما: ممنون از راهنمایی سریعتان!`, `حل شد`); two skeleton rows (loading older); `.fab`
  `گفتگوی تازه`. Geometry §2.4.
- Data: `vm.conversations[]` (+ operator name, last author: new), `vm.loading`, `vm.error`.
- Interactions: row → conversation; `.fab` → new conversation.
- Production: `conversationListHtml` (§4.19).

### 5.10 · 10 Asking for an email

Board 04 designer's note: "The email is asked inside the conversation itself, not with a separate form. When the team is
offline the message is recorded and the reply arrives by email. After the conversation is closed, the survey comes in the
same message thread."

[Screenshot](screens/panels/04-details-and-feedback--10-asking-for-an-email.png). Purpose: collecting a reply address
inside the thread after a handoff.
- Top → bottom: header (online); thread 68–588: day pill (170), visitor `سلام، برای خرید عمده تخفیف دارید؟` 19:42 + read; operator run
  entering (`.g.L.new`): label `سارا`, `سؤالتان به تیم رسید؛ معمولاً در چند دقیقه پاسخ می‌دهیم.`,
  `اگر از سایت رفتید، پاسخ را کجا بفرستیم؟`, email card (421–546), meta `۱۹:۴۴`; idle composer.
- Data: `identity.isAsked/isRequired` (server), `contact.email`.
- Interactions: submit (button or Enter) → saved → done state; skip → card hides (new).
- Production: handoff card (§4.20). The two bubbles: suggestion — render them as part of the card's operator row (the card's
  `hc-title` / `hc-subtitle` texts in bubble form), not as real messages, unless Core sends them.

### 5.11 · 11 Message while away

[Screenshot](screens/panels/04-details-and-feedback--11-message-while-away.png). Purpose: leaving a message while the
team is offline.
- Top → bottom: header: store avatar `ف` (`.c4`) + `.pr.off`, `فروشگاه نیلوفر`, `آفلاین؛ پاسخ با ایمیل`. `.thread.top`: away notice
  82–144 (`الان آفلاین هستیم` / `از ۹ صبح پاسخ می‌دهیم؛ معمولاً تا ۲ ساعت`); visitor
  `سلام، سایز ۴۲ این کفش کی دوباره موجود می‌شود؟` 23:10 + read; auto-reply (bubble `پیامتان ثبت شد.`, done card with
  `ali@example.com`, meta `پاسخ خودکار`); composer placeholder `اگر چیزی اضافه دارید بنویسید…`.
- Production: replaces the separate contact-fallback form (§4.6, `contactFallbackHtml`) with the chat thread. Needs Core to
  accept offline messages in the thread (production disables send offline, production-map §4.2) or to route the composer
  text + card email to the fallback endpoint (`data-fb-*` contract). Until then keep the fallback form, restyled (**not
  drawn**).

### 5.12 · 12 Rating after a chat

[Screenshot](screens/panels/04-details-and-feedback--12-rating-after-a-chat.png). Purpose: rating a conversation the
operator closed.
- Top → bottom: header (online); thread 68–680 (no composer): visitor `مرسی، مشکلم حل شد!` 21:12, operator
  `خوشحالم که حل شد! روز خوبی داشته باشید.` 21:13, divider `سارا گفتگو را بست` (270), CSAT 306–668 (`عالی` selected).
- Data: closing operator name, rating API availability (new).
- Interactions: face → selected (`aria-pressed`); comment optional; `ارسال نظر` submits; transcript link → email (new).
- Production: new (§4.22).

### 5.13 · 13 Mobile, home

Board 05 designer's note: "On mobile the widget opens full screen; the same simple home and the same conversation, with
bigger touch buttons and distance from the phone's edges."

[Screenshot](screens/panels/05-mobile--13-home.png). Purpose: 01 on a phone.
- Layout: 01 with the §2.8 deltas — hero 0–360 (top row at 58), ask card 308–440 with the chips in one 40px scrolling row
  (the third chip `راهنمای سایز` is cut by the 12px end fade), rows 456–592, footer 784–824, home bar zone below.
- Copy, data, interactions: as 01.
- Production: `.shell.gs-mobile-open .panel` + the §2.8 rules; safe-area insets replace the notch and home-bar space. Only
  the chips get bigger in `t2.css`; see §8 for touch targets.

### 5.14 · 14 Mobile, conversation

[Screenshot](screens/panels/05-mobile--14-conversation.png). Purpose: 04 on a phone.
- Layout: 04 with the §2.8 deltas — header 0–104 (`padding:54px 10px 10px` in the phone frame), thread 104–692, composer
  692–784, footer 784–824.
- Copy, data, interactions: as 04.
- Production: as 13.

### 5.15 · 06a Live prototype, closed

Board 06 designer's note: "Tap the floating button or the welcome message, write in the question box or pick a topic, go
back and close the widget. If you do nothing, the prototype plays by itself. Next to it, every motion is listed with its
time and curve."

[Site mock](screens/panels/06-live-prototype--site-mock.png). The host page with the launcher only: 60 × 60 at the frame's
bottom-right (20px insets in the 560 × 880 board frame; production keeps the 24px shell anchor), no badge. Production:
WebYar kit (§4.23). Step machine and every timer: §6.4.

### 5.16 · 06b Live prototype, greeting

[State](screens/states/06-live-prototype--greeting.png). Greeting `سارا از فروشگاه نیلوفر` /
`سلام! دنبال سایز مناسب هستید؟ کمکتان می‌کنم.` (demo smart-rule content) 16px above the launcher; unread badge `۱` at the
launcher's top-left (RTL). Interactions: message → opens straight into the conversation; close → hides the greeting, the
badge stays; launcher → opens home. Production: smart-engagement nudge + kit badge (§4.23, §4.24).

### 5.17 · 06c Live prototype, open on home

[State](screens/states/06-live-prototype--open-home.png). The panel has grown from the launcher corner (bottom-right),
the launcher has dropped out, the home content has cascaded in; motion note 3 is highlighted. Production: panel and
launcher motion (§6.1, §6.2).

### 5.18 · 06d Live prototype, open in a conversation

[State](screens/states/06-live-prototype--open-chat.png). The chat screen has slid in over home: header `سارا` with
`.ondot` and the workspace name `فروشگاه نیلوفر` as the status line, no more button; thread: day, operator
`سلام! دنبال سایز مناسب هستید؟ کمکتان می‌کنم.` (the greeting's text becomes the first message) 19:44, visitor
`سفارشم کی می‌رسد؟` 19:46, operator `سلام! سفارشتان امروز صبح ارسال شد و پنجشنبه می‌رسد.` 19:46; idle composer; motion
note 5 is highlighted. Production: view transition and message entrance (§6.1, §6.2).

---

## 6. Motion

All values from `t2.css` and the board 06 script. Board delays exist so a static board plays after load; in production
play each animation once when its element is first inserted (Core's `.msg-row.no-enter` stops replays, production-map §5.1)
with the designed delay, and never on re-renders.

### 6.1 Table

| Interaction | Element | Property | Duration | Easing | Delay | Keyframes / from → to |
|---|---|---|---|---|---|---|
| Panel opens | `.site .p` → `.panel.visible` | opacity | .22s | ease | .18s | 0 → 1 |
| | | transform | .52s | `--spring` | .18s | `translateY(40px) scale(.86)` → none; origin `100% 100%` (the anchor corner) |
| | | visibility | 0s | linear | .18s | hidden → visible |
| Panel closes | `.panel` | opacity | .2s | ease | 0 | 1 → 0 |
| | | transform | .26s | `--ease-in` | 0 | none → `translateY(40px) scale(.86)` |
| | | visibility | 0s | linear | .26s | → hidden |
| Launcher drops (open) | `.lw` → `.launcher.open` | transform | .26s | `--ease-in` | 0 | → `translateY(130px)` (board); production distance `--gs-fab-exit` |
| | | visibility | 0s | linear | .26s | → hidden |
| Launcher rises (close) | `.lw` → `.launcher` | transform | .5s | `--spring` | .22s | → none (visibility back at .22s) |
| Home cascade (live) | `.cas` ×6 (`--i` 0–5: top row, `.hi`, `.hq`, `.pres`, `.ask`, `.list`) | opacity · transform | .4s · .6s | ease · `--spring` | .3s + `--i` × 60ms | opacity 0, `translateY(14px)` → none |
| Home cascade (static boards) | `.cz` ×6 | animation `t2-rise` | .6s | `--ease` | .15s + `--i` × 70ms | `t2-rise`: opacity 0, `translateY(12px)` → 1, none |
| Home → chat | `.scr.chat` / `.scr.home` | transform · opacity | .42s · .3s | `--ease` · ease | 0 | chat `translateX(-100%)` (RTL; LTR `100%`), opacity 0 → none, 1; home → `translateX(22%)` (RTL; LTR `-22%`), opacity 0 |
| Chat → home | same | same | .42s · .3s | same | 0 | reverse |
| Message enters (live) | `.dm` | opacity · transform | .2s · .5s | ease · `--spring` | 0 | `scale(.6)` → none; origin operator `left bottom`, visitor `right bottom` |
| Message enters (boards) | `.g.new` | `t2-msg` | .5s | `--spring` | .25s | opacity 0, `scale(.55)` → none; same origins |
| Greeting shows | `.greet` (`.greet-on`) | opacity · transform | .3s · .55s | ease · `--spring` | .1s | `translateY(10px) scale(.7)` → none; origin `100% 100%` |
| Greeting hides | `.greet` | opacity · transform | .16s · .16s | ease | 0 | → `translateY(10px) scale(.7)`, opacity 0 (visibility at .16s) |
| Badge shows / hides | `.bdg` | transform | .5s / .2s | `--bounce` / ease | .35s / 0 | `scale(0)` ↔ none |
| Launcher hover / press | `.wl` | transform, box-shadow | .22s | `--ease`, ease | 0 | `translateY(-3px) scale(1.06)` / `scale(.94)` |
| Launcher idle dots | `.wl .dt` | `t2-dots` ∞ | 3s | ease-in-out | 0 / .1s / .2s | 0, 30, 100% none; 12% `translateY(-2.5px)` |
| Hero aurora | `.aur i:nth-child(1)` / `(2)` | `t2-drift` ∞ alternate / alternate-reverse | 16s / 22s | ease-in-out | 0 / −6s | `translate(0,0) scale(1)` → `translate(-26px,22px) scale(1.12)` |
| Presence ping | `.pres .dot::after` | `t2-ping` ∞ | 2.4s | `--ease` | 0 | `scale(1)` opacity .6 → 70–100% `scale(2.6)` opacity 0 |
| Placeholder rotation | `.field .ph span` ×3 | `t2-ph` ∞ | 12s | `--ease` | 0 / 4s / 8s | 0% opacity 0 `translateY(10px)`; 4–30% visible; 34–100% opacity 0 `translateY(-10px)` |
| Fake caret | `.field .ph::before`, `.box .in.ty::after`, `.sfield .q::after` | `t2-caret` ∞ | 1.1s | `steps(1)` | 0 | on 0–50%, off 50.01–100% |
| Send hover / press | `.send` | transform | .2s | `--bounce` | 0 | `translateY(-1px) scale(1.05)` / `scale(.92)` |
| Chip | `.chip` | background, shadow, colour · transform | .18s · .25s | ease · `--bounce` | 0 | press `scale(.95)` |
| Row hover | `.r` · `.r .ch` | background · transform | .18s · .2s | ease · `--ease` | 0 | chevron `translateX(3px)` (RTL −3px) |
| Icon buttons | `.gb`, `.ib` | background · transform | .18s | ease · `--ease` | 0 | press `scale(.92)` |
| Typing dots | `.typing i`, `.who .st.typ i` | `t2-wave` ∞ | 1.2s | ease-in-out | 0 / .15s / .3s | 0, 60, 100% none, opacity .45; 30% `translateY(-4px)`, opacity 1 |
| Reaction | `.react` | `t2-pop` | .5s | `--bounce` | .6s | opacity 0 `scale(.4)` → none |
| Order progress | `.steps::after` | `t2-fill` | 1.1s | `--ease` | .5s | `scaleX(0)` → none (from inline-start) |
| Current step | `.steps span.now i` | `t2-now` ∞ | 2s | ease-in-out | 1.6s | halo `0 0 0 4px var(--a-3)` → 50% `0 0 0 8px var(--a-2)` → back |
| Image sheen | `.img::after` | `t2-sheen` ∞ | 2.8s | ease-in-out | .8s | `translateX(-100%)` → 60–100% `translateX(100%)` |
| Download ring | `.ring .arc circle` | `t2-dl` (forwards) | 2.6s | `--ease` | .6s | `stroke-dashoffset` 94 → 24 |
| Voice playing | `.voice .wave i:nth-child(-n+9)` | `t2-bar` ∞ alternate | .9s | ease-in-out | 0; −.3s (3n); −.6s (3n+1) | `scaleY(.45)` ↔ 1 |
| Topic chips | `.qr .chip` 1–4 | `t2-rise` | .5s | `--ease` | .5 / .58 / .66 / .74s | opacity 0, `translateY(12px)` → none |
| Instant answers | `.tray` | `t2-rise` | .5s | `--ease` | .4s | same |
| Composer focus | `.box` | box-shadow | .22s | ease | 0 | idle ring → `.fo` ring |
| Mic → send | `.act.on` | `t2-pop` | .45s | `--bounce` | 0 | opacity 0 `scale(.4)` → none |
| `.act` press | `.act` | transform · background | .25s · .2s | `--bounce` · ease | 0 | `scale(.9)` |
| Recording dot | `.rec .dot` | `t2-blink` ∞ | 1s | ease-in-out | 0 | opacity 1 → 50% .25 → 1 |
| Recording wave | `.rec .wave i` | `t2-bar` ∞ alternate | .8s | ease-in-out | 0; −.25s (2n); −.5s (3n) | `scaleY(.45)` ↔ 1 |
| Search results | `.res a` 1–3 | `t2-rise` | .45s | `--ease` | .15 / .21 / .27s | |
| Category hover | `.cat` | background · transform | .18s · .25s | ease · `--ease` | 0 | `translateY(-2px)` |
| Reading progress | `.prog` | `t2-read-in` | 1.4s | `--ease` | .3s | `scaleX(0)` → `scaleX(.36)` |
| Article face hover | `.face` | transform · background, colour | .3s · .18s | `--bounce` · ease | 0 | `translateY(-2px) scale(1.08)` |
| CTA arrow | `.cta .go` | transform | .25s | `--ease` | 0 | hover `translateX(3px)` (RTL −3px) |
| New-conversation button | `.fab` | `t2-fab` | .6s | `--spring` | .5s | opacity 0 `translate(-50%,24px) scale(.8)` → `translateX(-50%)` |
| Skeleton | `.sk i` | `t2-shim` ∞ (reverse in RTL) | 1.4s | linear | 0 | `background-position: 100% 0` → `-100% 0` |
| Email saved | `.fcard.done .ck` | `t2-pop` | .5s | `--bounce` | .5s | |
| CSAT card | `.csat` | `t2-rise` | .55s | `--ease` | .3s | |
| CSAT face hover | `.faces button` | transform · background | .3s · .18s | `--bounce` · ease | 0 | `translateY(-3px) scale(1.08)` |
| CSAT face picked | `.faces button.on` | `t2-pick` | .7s | `--bounce` | .9s | `scale(.6)` → none |

**Reduced motion** (`@media (prefers-reduced-motion:reduce)`):
`.t2 *, .t2 *::before, .t2 *::after{animation:none!important; transition:opacity .15s ease!important}` and
`.t2 .field .ph span:first-child{opacity:1}` (the first placeholder shows, static). Everything else ends at its final state; opacity changes fade over .15s. Keep production's loader and kit opt-outs
(production-map §8.8); `playFabEntry` already jumps to rest (LD:960-967).

### 6.2 Production notes

- **Panel:** in `presentation-simple.css` replace production's `.panel` closed/open transition (CSS:91-96, 113) with §6.1;
  keep `pointer-events:none` while closed and `.shell.no-anim`.
- **Launcher drop:** the template stylesheet already styles `.launcher` from inside the shadow root (CSS:150-163), so it can
  set `.launcher.open{transition: transform .26s var(--ease-in), visibility 0s linear .26s; visibility:hidden}`.
- **Launcher rise:** `playFabEntry()` (LD:955-995) runs a fixed 280ms `cubic-bezier(.22,1,.36,1)` WAAPI animation with no
  delay. Make it template-aware for `simple`: duration 500ms, delay 220ms, easing = the `--spring` `linear()` string
  (suggestion: read three custom properties set by the template, falling back to today's values).
- **View change:** production mounts exactly one `.wy-view` (`wy-view-in` fade, CSS:184-195, 497-502). Incoming half: animate
  the new view root as `.scr` does. Outgoing half (home moving 22% and fading) needs Core to keep the old view for 420ms;
  if it cannot, ship the incoming half only.
- **Cascade:** play `.cas` when the panel opens on home (Core adds `.visible`), not on every home render (suggestion).
- **Messages:** replace `wy-msg-in .24s` (CSS:661-662) with the `.dm` timing for new `.msg-row`s.

### 6.3 Motion notes on board 06 (spec content, `.mn`)

Each row: a 44 × 44 curve tile, title, description and value (the highlighted row follows the prototype step; chrome).

| # | Title | Description | Value | Curve glyph (`path d`) | Implemented by |
|---|---|---|---|---|---|
| 1 | دکمه‌ی شناور پایین می‌رود (the floating button drops) | با شتاب از کادر صفحه بیرون می‌رود؛ وقتی ویجت باز است دکمه‌ای دیده نمی‌شود. (it accelerates out of the page frame; while the widget is open no button is visible) | ۲۶۰ میلی‌ثانیه (260 ms) | `M4 26C24 26 34 18 40 4` (ease-in) | `.lw` drop |
| 2 | ویجت از گوشه باز می‌شود (the widget opens from the corner) | با کمی جهش، از همان گوشه‌ای که دکمه بود. (with a little bounce, from the same corner the button was in) | ۵۲۰ میلی‌ثانیه (520 ms) | `M4 26C11 26 13 1 23 3S33 7 40 6` (overshoot) | panel open |
| 3 | محتوای خانه پشت‌سرهم می‌آید (home content comes in one after another) | سر، کادر سؤال و ردیف‌ها هرکدام ۶۰ میلی‌ثانیه بعد از قبلی. (the header, the question box and the rows, each 60 ms after the previous one) | هر ۶۰ میلی‌ثانیه (every 60 ms) | `M4 26h8M14 19h8M24 12h8M34 5h6` (steps) | `.cas` |
| 4 | رفتن به گفتگو (going to the conversation) | خانه کنار می‌رود و گفتگو از طرف مقابل می‌آید. (home moves aside and the conversation comes in from the opposite side) | ۴۲۰ میلی‌ثانیه (420 ms) | `M4 26C9 7 21 4 40 4` (ease-out) | `.scr` |
| 5 | پیام تازه از دُمش بزرگ می‌شود (a new message grows from its tail) | بعد از سه نقطه‌ی «در حال نوشتن». (after the three "typing" dots) | ۵۰۰ میلی‌ثانیه (500 ms) | `M5 25C10 25 12 4 22 6S32 9 40 8` + dot at (5, 25) | `.dm`, `.g.new` |
| 6 | بستن (close) | ویجت جمع می‌شود، بعد دکمه از پایینِ کادر بالا می‌آید. (the widget folds away, then the button rises from the bottom of the frame) | ۲۶۰ + ۵۰۰ میلی‌ثانیه (260 + 500 ms) | `M4 6C14 6 18 26 22 26` + `M24 26C30 26 31 3 40 6` | panel close + `.lw` rise (starts at 220 ms) |
| 7 | کاهش حرکت (reduced motion) | اگر کاربر «کاهش حرکت» را روشن کرده باشد، همه‌چیز فقط محو می‌شود. (if the user turned on "reduce motion", everything only fades) | ۱۵۰ میلی‌ثانیه (150 ms) | `M4 15h36`, `stroke-dasharray:2 4` | reduced-motion media query |

### 6.4 Prototype step machine (board 06 `class Component`)

State `{open, chat, greet, unread, m, step}` → `.site` classes `open`, `inchat`, `greet-on` (greet and not open), `unread`
(unread and not open), `m1`–`m3`; `step` highlights motion note `step + 1`.

| Step | Trigger | Effect | Next |
|---|---|---|---|
| mount | — | `auto = true` | step 0 after 600ms |
| 0 | timer | `greet:true, unread:true` (greeting + badge) | step 1 after 2600ms |
| 1 | timer | `open()`: `open:true, greet:false, unread:false`; notes 1 → 2 at 260ms → 3 at 700ms | step 2 after 2400ms |
| 2 | timer | `chat()`: `open, chat:true, m:0`, note 4; `m:1` at 650ms (visitor message), `m:2` at 1350ms (typing row), `m:3` + note 5 at 2650ms (reply) | step 3 after 4600ms |
| 3 | timer | `chat:false` (back to home), note 4 | step 4 after 1800ms |
| 4 | timer | `close()`: `open:false`, note 6; after 380ms `chat:false, m:0` | step 0 after 2600ms |
| any user action | launcher, field, chip, greeting, back, close | `pause()`: autoplay off; after 12000ms autoplay on and step 4 (if open) or 0 after 400ms | |
| replay | prototype button | autoplay on, `close()`, step 0 after 900ms | |

Handlers: launcher → `open()`; ask field and chips → `chat()` (the prototype opens the conversation on a click in the
field); greeting message → `chat()` (straight into the conversation); greeting close → `greet:false` (the badge stays);
back → `chat:false`; hero close / header close → `close()`.

Prototype defect: `.site.m2 .dm.k2.typing{display:none}` (`t2.css` L481) hides the typing row in the very step (`m:2`)
that should show it, so the live prototype never shows the typing dots; motion note 5 and screen 04 give the intended
order: typing row, then it is replaced by the message.

---

## 7. Direction, language and numbers

- **Direction:** the root carries `dir="rtl"`; spacing uses logical properties (`inset-inline`, `margin-inline`,
  `padding-inline`, `border-*-radius` logical forms) so the layout mirrors. Rules that differ by direction in `t2.css`:
  `.g.L/.g.R` sides, `.r .end` alignment, `.r:hover .ch` and `.cta:hover .go` nudge, `.prog` and `.steps::after` origin
  (`--ps`), `.voice` padding, `.qr` alignment, `.sfield` padding, `.sk i` shimmer direction, `.greet .gm` padding, `.scr`
  slide direction, `.p.mob .chips` fade (`--fade-to`), and the unused `.dirf` mirror for `.send svg` and `.ib`.
- **Physical in both directions:** visitor right / operator left; bubble tails (`.L` bottom-left, `.R` bottom-right) and
  join corners; typing bubble bottom-left; message `transform-origin` (`left bottom` / `right bottom`); panel and greeting
  origin `100% 100%` and the greeting tail (mirror both with `position: bottom-left`, brief §4); launcher and panel anchoring;
  hero radial highlight `at 100% 0%`; aurora drift `translate(-26px,22px)`; `.rec` padding `0 6px 0 8px`; `.fab` centring.
- **Chevrons:** the WebYar boards draw RTL paths (back `m10 6 6 6-6 6`, forward `m14 6-6 6 6 6`); the Respok boards draw
  the mirrored paths. One renderer serves both: draw the LTR path and mirror under `[dir=rtl]` with `transform:scaleX(-1)`
  (the `.dirf` rule; production does the same for `.wy-back`, CSS:282).
- **LTR islands:** the voice and recorder waveforms (`.wave{direction:ltr}`, progress left → right); the email input row
  (`.fcard .fi{direction:ltr}`, submit on the right); the email in the done card (`direction:ltr; unicode-bidi:isolate`);
  `.code` (`direction:ltr; unicode-bidi:isolate`, available for Latin codes such as tracking numbers, brand sheet). Bubble
  text is `text-align:start`; keep production's `unicode-bidi:plaintext` on `.msg-text` so each paragraph follows its own
  script (production-map §7).
- **Digits:** Persian digits for every number the UI prints: times (`۱۹:۴۲`), counts and badges (`۲`, `۱`,
  `۳ مقاله پیدا شد`, `۵ مقاله`), step numbers (`۱`–`۳`), order number (`سفارش ۴۸۲۱۳`), sizes (`۲۴۰ کیلوبایت`), durations
  (`۰:۱۴`, `۰:۰۸`), reading time, relative times (`۱۰ دقیقه پیش`). Latin stays Latin: file names (`IMG_2041.jpg`), `PDF`,
  emails. Production gaps to close: audio/recorder timers, file sizes and units, Q&A `+N` (production-map §7).
- **Font:** Vazirmatn for Persian and Latin alike (no per-direction stack).
- **Copy tone:** polite plural (brand sheet) — but see §10 for `خوش برگشتی`.

---

## 8. Accessibility

- **ARIA as designed:** close `aria-label="بستن"`; back `بازگشت`; more `گزینه‌های بیشتر`; ask field `role="textbox"`
  `aria-label="سؤالتان را بنویسید"` (production: a real textarea with that label); send `ارسال`; emoji `شکلک`; attach
  `پیوست`; mic `ضبط پیام صوتی`; typing row `در حال نوشتن`; recorder delete `حذف ضبط`; recorder send `ارسال پیام صوتی`;
  voice play `پخش پیام صوتی`; image `role="img"` with a description (demo `عکس کفش`; production: the file name, PD:285);
  download (demo `دانلود فاکتور`; production `t('download')`); search clear `پاک کردن`; article faces `نه` / `تا حدی` /
  `بله`; CSAT faces `خیلی بد` / `بد` / `معمولی` / `خوب` / `عالی` with `aria-pressed="true"` on the selected one; email submit
  `ثبت ایمیل`; skeleton rows `aria-label="در حال بارگذاری گفتگوهای قدیمی‌تر"`; greeting `role="status"`, its close
  `بستن پیام`; launcher `باز کردن گفتگو`. Decorative SVGs, `.aur`, `.mk`, `.prog`, waveforms: `aria-hidden="true"`.
- **Keep production ARIA** (production-map §8.5): panel dialog, live regions (`[data-presence]`, `[data-typing-row]`,
  `[data-rec-sr]`, `[data-rec-timer][role=timer]`, `.msg-att-loading`, `[data-fb-status]`, `.prechat-error[role=alert]`),
  `.hc-card[role=group]`, `.kb-rate[aria-pressed]`, `.emoji-btn[aria-expanded]`. Skeletons stay `aria-hidden`: put the
  skeleton's loading label in a polite live region instead of on the hidden row (suggestion). The visible typing row is
  `aria-hidden` (the sr-only row announces).
- **New live regions (suggestions):** result count `.cnt` and the tray heading as `role="status"`; the greeting as designed.
- **Focus:** §4.25 (ring colour `--a`, white on the hero; restate radii under `:focus-visible`). DOM order of the composer is
  fixed by production (mic, textarea, send, attach, emoji); the grid layout changes only the painting.
- **Contrast** (WCAG, default accent): white on `--a` 5.04:1; white on `--a-hi` 4.02:1 (top of visitor bubbles and buttons);
  `--a-ink` on `--a-2` 6.95:1; `--ink-3` on white 5.21:1, on `--paper` 4.62:1, on `--bubble` 4.31:1, on `--paper-2` 4.24:1
  (resolved pill text, 11px bold); `--ink-4` on white 2.36:1 (placeholders, chevrons); `--bad` on white 4.71:1; unread badge
  10.30:1. The brand-default hero is light at the top: the greeting line `.hi` (15.5px / 500, opacity .86) sits on about
  `#16A58D` (white ≈ 3.1:1) and the presence line on about `#0E8D78` (≈ 4.1:1), both below 4.5:1; the 27px bold question
  (≈ 3.5:1) passes for large text. Hard-coded white sits on accent-derived surfaces in `.gb`, `.hero .mk`, `.cta` and
  `.cta .go svg`, `.voice .pb`, and the hero focus ring: with a light custom accent (where `--on-a` turns Ink) those stay
  white; use `--on-a` there (brief §5.3).
- **Touch targets:** the brief asks for ≥ 44px on mobile and states the mobile specs enlarge icon buttons; `t2.css` does
  not (`.ib` 38, tools 36, `.gb` 38, `.act` 40, `.sfield .x` 28, `.face` 38, `.gx` 40). Suggestion: under
  `.shell.gs-mobile-open`, extend each hit area to 44 × 44 (padding or a transparent `::before`) without changing the drawn
  size, so the screenshots still match.

---

## 9. New versus production

Canonical names for every hook, setting, view-model field and i18n key below (one name per concept, shared by
both brands and both templates): [`../../shared/new-hooks-and-settings.md`](../../shared/new-hooks-and-settings.md).

| Addition | Screens | UI spec | Core / server / settings must provide | Suggested hook or config key | If unavailable |
|---|---|---|---|---|---|
| Hero home without header bar | 01–03, 13 | §4.2 | — (renderer) | — | — |
| Ask field on home: typed text starts a conversation | 01, 02, 13, 06 | §4.4 | open a new conversation and send the draft as its first message | `textarea[data-home-ask]` + `.send[data-home-action="chat"]` | field opens the chat view (prototype behaviour) |
| Rotating example placeholders | 01, 02, 13 | §4.4 | workspace setting | `askExamples[]` (2 lines) | `.field.static` |
| Topic chips (home, new conversation) | 01, 02, 06, 13 | §4.4, §4.14 | topics config (label + icon); send topic as first message | `data-topic` or `data-qna-question` | article chips (`data-home-article`) or none |
| Presence line with team initials | 01–03 | §4.2 | team member names (have), online state, reply time (have) | `showTeamAvatars` (have) | text only |
| Returning greeting with the visitor's name | 02 | §4.2 | visitor name | VM `visitorName` | `سلام 👋` |
| Continue row with operator name and presence | 02 | §4.5 | latest unresolved conversation (have) + operator name, online | VM `conversations[].operatorName`, `.operatorOnline` | workspace name, no presence dot |
| Conversations summary row | 02 | §4.5 | total and open counts (derivable) | — | title only |
| Help row with article count and categories | 01–03 | §4.5 | KB counts and category names on the home VM | VM `kbSummary` | title + offline sub |
| Track-order row | 01, 03, 13 | §4.5 | store context / order lookup; behaviour **not specified** | `data-home-action="track-order"` | hide |
| Office hours in offline copy | 03, 11 | §4.2, §4.21 | next opening time | `availability.nextOpenAt` | `replyTimeText(false)` |
| Operator identity, presence and typing in the chat header | 04, 05, 10, 12, 14, 06d | §4.8 | assigned operator name, online; typing (have, `setOperatorTyping`) | VM `assignedOperator` | workspace identity + reply time |
| "More options" menu | 04, 05, 10–12, 14 | §4.8 | menu content **not specified** | — | do not render |
| Visible typing row | 04, 14 | §4.10 | typing state to the renderer | `view.operatorTyping` → `.typing-row` | sr-only only (today) |
| Sender name above operator runs; initials avatars | 04–06, 10–12 | §4.9 | `senderName` (have) | renderer | — |
| Order card with progress | 04, 14 | §4.12 | order data in message metadata (commerce) | `metadata.kind = 'order_status'` | not rendered |
| Reactions | 05 | §4.11 | reactions API + realtime | `metadata.reactions` | not rendered |
| Download progress ring | 05 | §4.13 | download progress from Core | — | ring without arc |
| Waveform voice notes, Persian timers and sizes | 05 | §4.13, §4.16 | waveform data (optional), Persian digit formatting in Core timers | — | fixed bar pattern |
| Recorder "send" button | 05 | §4.16 | decision: keep stop → preview (production) or send directly | `data-rec-stop` | production flow |
| Mic becomes send while typing | 02 boards | §4.16 | — (CSS on `.has-draft`) | — | — |
| Instant answers while typing | 06 | §4.15 | KB search as you type, match ranges, reading time | tray in `[data-composer-zone]` | not rendered |
| Welcome block in a new conversation | 06 | §4.14 | team, workspace name, online (have) | — | — |
| Help search field | 07 | §4.17 | bind input → query → results | `data-kb-search` (brief §9) | list without search |
| Highlighted matches, result count | 07 | §4.17 | match ranges or query terms | — | no highlight |
| Categories grid | 07 | §4.17 | categories with counts (+ icon) | `data-kb-category` | hide `.sec` + `.cats` |
| Article category title, author, reading time, reading progress | 08 | §4.18 | VM fields; scroll progress | `data-kb-progress` | hide each missing piece |
| Three-face article rating | 08 | §4.18 | a third value for "partly" | `data-kb-rate="neutral"` (same value in the Respok build) | two faces (`up`, `down`) |
| Always-visible "still need help" card | 08 | §4.18 | — | `data-kb-action="switch-chat"` (have) | — |
| Conversation list: operator per row, "You:" prefix, pagination skeleton, floating new-conversation button | 09 | §4.19 | operator name, last author, pagination | `data-home-action="chat"` (have) on `.fab` | workspace name, no prefix, skeleton on first load only |
| Email card in the thread (email only, skip, done state) | 10, 11 | §4.20 | skip allowed when email not required; done state after submit | `data-prechat-skip` | no skip link |
| Offline messaging in the thread (away notice, auto-reply) | 11 | §4.21 | accept offline messages in chat or route to the fallback endpoint | `data-fb-*` contract | production contact-fallback form |
| Rating after a chat (CSAT) + transcript by email | 12 | §4.22 | rating + transcript APIs | `data-csat-*` | not rendered |
| Launcher: idle dot wave, badge geometry, drop/rise timing | 06 | §4.23, §6 | loader/kit CSS; template-aware `playFabEntry` | — | production kit |
| Greeting bubble look (avatar, inside close, whole bubble clickable, `role="status"`) | 06b | §4.24 | nudge markup + loader SHELL_CSS copy | `[data-smart-cta]`, `[data-smart-dismiss]` | production nudge |
| Panel open/close, view slide, home cascade | 06 | §6 | Core keeps the outgoing view 420ms (optional) | — | incoming half only |

**Hook placement in `simple`** (every production hook stays emitted, brief §2.1):

| Hook (production-map §6) | Template 2 element |
|---|---|
| `data-panel-close` | the shell close in the `.gb` / `.ib` look (§2.7) |
| `data-view="list"` / `data-view="help"` | home rows "your conversations" / "help center" |
| `data-view-back`, `data-view-back-fallback` | `.bar` back button |
| `data-home-action="chat"` | home `.send` (with the draft), list `.fab` |
| `data-home-action="conversations-retry"` | error variant of the conversations row (not drawn) |
| `data-home-article` | fallback home chips when no topics exist (suggestion) |
| `data-conversation-open` | home continue row, list `.ci` rows |
| `data-smart-dismiss`, `data-smart-cta` | home smart card (not drawn); greeting `.gx`, `.gm` (loader) |
| `data-chat-header`, `data-presence*`, `data-chat-messages`, `data-chat-jump*`, `data-composer-zone`, `data-typing-row`, `data-typing-label` | `.bar`, its sr-only presence, `.thread`, jump button (not drawn), zone around tray + composer + footer, sr-only typing |
| composer hooks (`data-input-*`, `data-msg-input`, `data-send-btn`, `data-mic-btn`, `data-attach-*`, `data-emoji-*`, `data-rec-*`, `data-vn-*`, `data-reply-*`) | §4.16; not-drawn parts kept (§4.26) |
| message hooks (`data-msg-*`, `data-typing-host/-active/-id`, `data-att-*`, `data-audio-*`) | §4.9, §4.13 |
| `data-qna`, `data-qna-question`, `data-qna-more` | `.qr` topics |
| `data-field`, `data-prechat`, `data-err`, `data-prechat-submit` | `.fcard` |
| `data-fb`, `data-fb-submit`, `data-fb-status` | offline fallback form (kept until the in-thread flow exists) |
| `data-kb-action`, `data-kb-slug`, `data-kb-feedback`, `data-kb-rate` | results rows, tray rows (if bound), `.cta`, `.fb`, `.face` |
| `data-conn-indicator`, `data-wy-brand-logo` | footer (`.wy-conn` kept, no visible dot online; no logo for WebYar) |
| `data-body`, `data-call-host`, `data-att-lightbox*`, `data-ci-*` | unchanged |

---

## 10. Copy deck

UI copy as designed. Production keys from production-map §7; "verify" = the key exists but its fa value is not in the bundle
(Core's i18n table is missing), so compare and add the suggested new key if it differs. `{x}` marks dynamic parts (the board
value is in parentheses).

| UI string | Where | Meaning | Key |
|---|---|---|---|
| `سلام 👋` | hero `.hi` (01, 03, 13, 06) | Hi 👋 | new: `simpleHomeHi` |
| `سلام {name}، خوش برگشتی 👋` (`علی`) | hero `.hi` (02) | Hi {name}, welcome back 👋 | new: `simpleHomeHiReturning` |
| `چطور می‌توانیم` + line break + `کمکتان کنیم؟` | hero `.hq` | How can we help you? | new: `simpleHeadline` (closest `homeWelcome`) |
| `پیامتان را` + line break + `بگذارید` | hero `.hq` (03) | Leave your message | new: `simpleHeadlineAway` (closest `homeLeaveMessage`) |
| `آنلاین هستیم` + `، ` + reply time | `.pres` | We're online, {reply time} | new: `simplePresenceOnline` (same string as the welcome block's `simpleWereOnline`), joined with `، ` |
| `معمولاً در ۲ دقیقه پاسخ می‌دهیم` | `.pres`, 06 header, `.cta` | We usually reply within 2 minutes | `config.replyTimeText` / `homeReplyFast` (verify) |
| `آفلاین هستیم، ` + `از ساعت ۹ صبح پاسخ می‌دهیم` | `.pres.off` | We're offline, we reply from 9 am | new: `simpleAwayBackAt` `{time}` (fallback `replyTimeText(false)` / `homeReplySlow`) |
| `سؤالتان را بنویسید…` (label without `…`) | ask placeholder 1, ask `aria-label` | Write your question… | new: `simpleAskPlaceholder`; label `simpleAskLabel` |
| `مثلاً: ` + example | ask placeholders 2–3 (`سفارشم کی می‌رسد؟`, `سایز ۴۲ موجود است؟`) | e.g.: {example} | new: `simpleAskExamplePrefix`; examples = workspace content |
| `پیامتان را بنویسید…` | ask placeholder (03), composer placeholder | Write your message… | field (03): `simpleAskPlaceholderAway`; composer: `typeMsg`; final wording in [the registry](../../shared/new-hooks-and-settings.md) §4.13: «پیام خود را بنویسید…» |
| `ارسال` | `.send`, `.act.on` | Send | `send` |
| `پاسخ را صبح به ایمیلتان می‌فرستیم` | `.note` (03) | We'll send the reply to your email in the morning | new: `simpleAwayNote` |
| `مرکز راهنما` | help row, 07 title | Help center | new: `simpleHelpCenter` |
| `{n} مقاله درباره {categories}` (`۲۴`, `سفارش، ارسال و مرجوعی`) | help row sub | {n} articles about {categories} | new: `simpleHelpSub` |
| `بیشتر پاسخ‌ها همین‌جاست، همیشه در دسترس` | help row sub (03) | Most answers are right here, always available | new: `simpleHelpSubAway` |
| `پیگیری سفارش` | track-order row | Track order | new: `simpleTrackOrder` |
| `با شماره سفارش، وضعیت را همین‌جا ببینید` | track-order row sub | With your order number, see the status right here | new: `simpleTrackOrderSub` |
| `ادامه گفتگو با {name}` (`سارا`) | continue row | Continue the conversation with {name} | new: `simpleContinueWith` (closest `wyContinueLast`) |
| `گفتگوهای شما` | conversations row, 09 title | Your conversations | new: `simpleYourConversations` |
| `{n} گفتگو، یکی باز است` (`۳`) | conversations row sub | {n} conversations, one is open | new: `simpleConversationsSub` (other open counts **not specified**) |
| `قدرت گرفته از` + `وب‌یار` | footer | Powered by WebYar | `poweredBy` + `config.poweredBy.brand` |
| `بستن` | close | Close | `close` |
| `بازگشت` | back | Back | `back` |
| `گزینه‌های بیشتر` | chat header | More options | new: `moreOptions` |
| `آنلاین` | header status | Online | new: `statusOnline` |
| `در حال نوشتن` | header status, typing row label | Typing | Core typing label (`[data-typing-label]`) / new: `simpleTyping` |
| `امروز` | day pill | Today | hard-coded (PD:545) |
| `شکلک` | emoji button | Emoji | `emojiPicker`; final wording in [the registry](../../shared/new-hooks-and-settings.md) §4.13: «شکلک‌ها» |
| `پیوست` | attach button | Attachment | `attachFile` (verify) |
| `ضبط پیام صوتی` | mic | Record a voice message | `recordVoice` (verify) |
| `ارسال نشد` | failed meta | Not sent | `msgFailed` (verify) |
| `تلاش دوباره` | retry | Try again | `retry` (verify) |
| `حذف ضبط` | recorder delete | Delete recording | new: `deleteRecording` |
| `ارسال پیام صوتی` | recorder send | Send voice message | new: `sendVoice` (production `stopRecording` = stop) |
| `پخش پیام صوتی` | voice play | Play voice message | `playAudio` (verify) |
| `دانلود` + name (`دانلود فاکتور`) | file download | Download {name} | `download` |
| `{n} کیلوبایت` (`۲۴۰`) | file size | {n} kilobytes | new: `unitKB` (MB/B units **not specified**) |
| `سفارش {number}` (`۴۸۲۱۳`) | order card title | Order {number} | new: `orderTitle` |
| `ارسال شد` | order status pill | Shipped | new: `orderStatusShipped` (other statuses **not specified**) |
| `ثبت` · `آماده‌سازی` · `ارسال` · `تحویل` | order steps | Placed · Preparing · Shipped · Delivered | new: `orderStepPlaced`, `…Preparing`, `…Shipped`, `…Delivered` |
| `تحویل:` + day (`پنجشنبه`) | order card footer | Delivery: {day} | new: `orderArrives` |
| `پیگیری مرسوله` | order card link | Track shipment | new: `orderTrackPackage` |
| `گفتگوی تازه` | 06 header, 09 `.fab` | New conversation | `wyNewConversation`; final wording in [the registry](../../shared/new-hooks-and-settings.md) §4.13: «گفتگوی جدید» |
| `تیم پشتیبانی {workspace}` (`فروشگاه نیلوفر`) | welcome block | {workspace} support team | new: `simpleWelcomeTeam` |
| `آنلاین هستیم` | welcome block | We're online | new: `simpleWereOnline` |
| `سلام! سؤالتان را بنویسید یا یکی از موضوع‌ها را انتخاب کنید.` | welcome bubble | Hi! Write your question or pick one of the topics. | `config.welcomeMessage` / `intro` |
| `موضوع دیگر` | last topic chip | Other topic | new: `simpleOtherTopic` |
| `پاسخ‌های آماده از مرکز راهنما` | tray heading | Ready answers from the help center | new: `simpleInstantAnswers` |
| `{n} دقیقه مطالعه` (`۲`, `۱`) | tray rows, article meta | {n}-minute read | new: `kbReadTime` |
| `پاک کردن` | search clear | Clear | new: `kbClearSearch` |
| (search input label, not drawn) | `.sfield` input | Search the help center | `searchKb` |
| `{n} مقاله پیدا شد` (`۳`) | result count | {n} articles found | new: `kbResultsCount` |
| `یا از یک موضوع شروع کنید` | categories label | Or start from a topic | new: `kbTopicsTitle` |
| `{n} مقاله` | category tile | {n} articles | new: `kbArticleCount` |
| `این مقاله کمک کرد؟` | article feedback | Did this article help? | new: `kbDidThisHelp` |
| `نه` · `تا حدی` · `بله` | article faces | No · Partly · Yes | `wyHelpfulNo` (verify) · new: `simpleHelpfulPartly` · `wyHelpfulYes` (verify) |
| `هنوز سؤال دارید؟` | `.cta` | Still have a question? | new: `kbStillNeedHelp` |
| `با تیم گفتگو کنید؛ ` + reply time | `.cta` sub | Chat with the team; {reply time} | new: `kbChatWithTeam` |
| `باز` · `حل شد` | status pills | Open · Resolved | `wyStatusOpen` · `wyStatusResolved`; final wording in [the registry](../../shared/new-hooks-and-settings.md) §4.13: «حل شده» |
| `شما: ` | preview prefix | You: | `you` (verify) + `: ` |
| `در حال بارگذاری گفتگوهای قدیمی‌تر` | skeleton label | Loading older conversations | new: `simpleLoadingOlder` |
| `سؤالتان به تیم رسید؛ معمولاً در چند دقیقه پاسخ می‌دهیم.` | 10, first bubble | Your question reached the team; we usually reply in a few minutes. | new: `simpleHandoffAck` |
| `اگر از سایت رفتید، پاسخ را کجا بفرستیم؟` | 10, second bubble | If you leave the site, where should we send the reply? | new: `simpleAskEmail` (closest `prechatTitle` / `prechatSubtitle`) |
| `ایمیل` | email card label | Email | `email` (field label, PD:574) |
| `name@example.com` | email placeholder | — | `prechatEmailPh` (verify) |
| `ثبت ایمیل` | email submit | Submit email | new: `saveEmail` |
| `نه ممنون، همین‌جا منتظر می‌مانم` | skip | No thanks, I'll wait here | new: `simpleSkipEmail` |
| `آفلاین؛ پاسخ با ایمیل` | 11 header status | Offline; reply by email | new: `simpleAwayStatus` |
| `الان آفلاین هستیم` | away notice | We're offline right now | new: `simpleAwayTitle` |
| `از ۹ صبح پاسخ می‌دهیم؛ معمولاً تا ۲ ساعت` | away notice sub | We reply from 9 am; usually within 2 hours | new: `simpleAwaySub` (or `replyTimeText(false)`) |
| `پیامتان ثبت شد.` | auto-reply | Your message has been recorded. | new: `simpleMessageRecorded` |
| `پاسخ را به {email} می‌فرستیم.` (`ali@example.com`) | done card | We'll send the reply to {email}. | new: `simpleReplyToEmail` |
| `پاسخ خودکار` | auto-reply meta | Automatic reply | new: `simpleAutoReply` |
| `اگر چیزی اضافه دارید بنویسید…` | 11 composer placeholder | If you have anything to add, write it… | new: `simpleAddMore` |
| `{name} گفتگو را بست` (`سارا`) | 12 divider | {name} closed the conversation | new: `convClosedBy` |
| `گفتگو با {name} چطور بود؟` | CSAT title | How was your conversation with {name}? | new: `csatTitle` |
| `نظرتان کمک می‌کند بهتر شویم.` | CSAT sub | Your feedback helps us improve. | new: `csatSub` |
| `خیلی بد` · `بد` · `معمولی` · `خوب` · `عالی` | CSAT faces | Very bad · Bad · Okay · Good · Great | new: `csat1` … `csat5` |
| `چیز دیگری هم بگویید (اختیاری)` | CSAT comment | Tell us anything else (optional) | new: `csatComment` |
| `ارسال نظر` | CSAT button | Send feedback | new: `csatSend` |
| `ارسال متن گفتگو به ایمیل` | CSAT link | Email the conversation transcript | new: `csatTranscript` |
| `بستن پیام` | greeting close | Close message | loader `dismiss` (verify) |
| `باز کردن گفتگو` | launcher | Open chat | loader `openChat` (verify) |

Copy notes: `خوش برگشتی` is the informal singular, while the brand sheet asks for the polite plural (suggestion, not in
the design: `خوش برگشتید`) — the board is reproduced verbatim; the owner decides. Keep ZWNJs (`می‌توانیم`, `وب‌یار`, `همین‌جا`, `پاسخ‌های`).

**Demo content (not copy):** the names `علی`, `سارا`, `مهدی`, `رضا`; the store `فروشگاه نیلوفر` and its initial `ف`; every
message body; order `۴۸۲۱۳`, `کفش رانینگ، سایز ۴۲`, `پنجشنبه`; `IMG_2041.jpg`; `فاکتور-۴۸۲۱۳.pdf`, `۲۴۰`; durations `۰:۱۴`,
`۰:۰۸`; all times; topics `زمان ارسال`, `مرجوعی کالا`, `راهنمای سایز`, `پیگیری سفارش`, `مشاوره خرید`, `مرجوعی و بازگشت وجه`;
the draft `مرجوعی کفش`; the query `ارسال`; result titles and snippets; category names and counts; the whole article; the
conversation previews and times; the emails; the greeting title and body; `۲۴` articles, `۳` conversations.

---

## 11. Acceptance checklist

In addition to [brief §10](../../CLAUDE_CODE_BRIEF.md):

- [ ] All 14 panel PNGs reproduced at 400 × 720 (mobile 390 × 844 viewport) with the board data; 06a–06d states match the
      state captures (launcher, greeting with badge, open home, open chat).
- [ ] Home: hero 320px tall with the 2-line question; ask card overlaps the hero by exactly 52px; rows card 16px below;
      footer pinned 40px; `--paper` background; close on the hero is the translucent `.gb` at top 23 / inline-end 20.
- [ ] Ask field: three placeholders rotate on a 12s cycle (4s apart) with the blinking caret; offline shows the static
      placeholder and the email note instead of chips; send with text opens a conversation whose first message is that text.
- [ ] Rows: 64px rows, divider inset 62px from the inline-start and 12px from the end, hidden on hover; chevron nudges toward
      the inline-end on hover; continue row shows time + `.nb` and no chevron.
- [ ] Brand-default accent (`#0B7D6C`, empty, `#3B82F6`) gives hero stops `#22C4A6 / #0F927D / #08594E` and glow `#7CF5DF`;
      any other preset uses the formulas; a light custom accent (e.g. `#22C4A6`) flips `--on-a` to `#16142B`.
- [ ] Chat: header 68px; thread bottom-anchored with the 34px top fade; operator left / visitor right in both directions;
      tails and 6px joins exactly as §4.9 (including the 6px top-left on the first bubble after the sender label).
- [ ] Composer: box 86px (12 / 26 / 2 / 40 / 6), idle mic → send swap on `.has-draft` with the pop; focus ring
      1.5px `--a` + 6px `--a-2`; recorder 52px with rec rings; DOM order and hooks unchanged.
- [ ] Visible typing row shows while the operator types and is replaced by the message, which grows from its tail corner
      (.5s spring).
- [ ] Help: search field focused ring, `mark` highlights, 2-column categories; article `.prog` from the inline-start, feedback
      and CTA pinned above the footer; list `.fab` 12px above the footer, centred.
- [ ] Email card, done card, away notice, CSAT match 10–12; CSAT only when the API exists; nothing broken when it does not.
- [ ] Persian digits everywhere listed in §7, including recorder/voice timers and file sizes.
- [ ] Panel opens: launcher drops 260ms ease-in, panel springs open over 520ms after 180ms from the launcher corner, home
      items cascade at 60ms steps from 300ms; close: panel 260ms ease-in, launcher rises 500ms spring after 220ms.
- [ ] Greeting 16px above the launcher, tail corner toward it, close inside at the inline-end; greeting and badge are
      triggered together (greeting delay 100ms, badge pop delay 350ms); opening clears both.
- [ ] Reduced motion: no movement anywhere (placeholder static on its first line), opacity fades of 150ms only.
- [ ] Keyboard focus keeps round and pill shapes (runtime.css radius override neutralised).
