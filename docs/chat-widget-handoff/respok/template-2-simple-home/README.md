# Respok chat widget · Template 2 "Simple home" — implementation spec

Template 2 for Respok (respok.app, International edition): a home without a bottom menu. The visitor types the question
straight into an ask field that overlaps a dark Ink hero, or picks a topic chip; the conversation list and the help center
are quiet rows under it. English, left to right (a Respok widget running Persian mirrors, see §7). Per
[brief §3](../../CLAUDE_CODE_BRIEF.md) it becomes the new production template id **`simple-intl`**: the Respok skin
`presentation-simple-intl.css` over the new `simple` renderer (`presentation-simple.js` + `presentation-simple.css`, shared
with WebYar's `simple`). The Respok skin is Ink + Signal: flat Ink fills, outlined topic chips, Signal focus rings and
carets, Figtree with tighter leading, and an 8px "tail" corner where the panel meets the launcher.

Read with: [brief](../../CLAUDE_CODE_BRIEF.md) (global rules, accent pipeline, fonts, acceptance),
[production map](../../shared/production-map.md) (production markup and hooks), [Respok brand sheet](../README.md)
(palette, logo directions), [`tokens.json`](tokens.json) (every token resolved for Ink).

Conventions in this file: `t2.css:NN` = line NN of [`reference/css/t2.css`](reference/css/t2.css); `PD`, `LD`, `CSS`,
`RT` as in the production map (`public/widget/presentation-default.js`, `public/widget/loader.js`,
`public/widget/presentation-default.css`, `public/widget/runtime.css`). **Suggestion:** marks anything the design does not specify. Sizes are CSS px at
1x; the screenshots are 2x.

---

## 0. Files in this folder

| Path | What it is | How to use it |
|---|---|---|
| [`source/`](source/) `NN-name.dc.html` | Board sources (Claude Design): markup with `{{holes}}`, copy, inline SVG icons; `class Component` at the bottom computes `renderVals()` (accent, `--on-a`, `--kac`, hero overrides, logo direction); `data-props` = board options (`accent` default `#16142B`, presets `#16142B #2F5BFF #0F766E #C2410C`; `logo` default `thread`, options `thread`/`open`) | Exact markup, copy and SVG paths. [`06-live-prototype.dc.html`](source/06-live-prototype.dc.html) also holds the open/close step machine and timers (§6.2) |
| [`reference/`](reference/) `NN-name.html` | Static renders of each board (handlers removed, default state: Ink, Thread). `06-live-prototype--greeting.html`, `--open-home.html`, `--open-chat.html` = prototype states | Open from disk in Chrome; read computed values in DevTools |
| [`reference/css/t2.css`](reference/css/t2.css) | The only stylesheet: tokens for both brands (`.t2` = base/WebYar, `.t2.b-rp` = Respok), every component, all motion, plus board chrome | Source of every number below. Respok = root `.t2.b-rp` + `lg-thread` or `lg-open`; Respok-only rules are `.b-rp …` (full list §3.8) |
| [`reference/css/fonts.css`](reference/css/fonts.css), [`reference/fonts/`](reference/fonts/) | Figtree 400–800, DM Mono 400/500, Vazirmatn 400–700 (OFL, licences in [`../../shared/fonts/`](../../shared/fonts/)) | Production ships them as `data:` URLs (brief §6) |
| [`screens/panels/`](screens/panels/) | Each widget screen at 2x, cropped with 24px (1x) of canvas around the panel (896 × 1536 = (400 + 48) × (720 + 48) × 2; mobile 876 × 1784) | **The acceptance target** |
| [`screens/boards/`](screens/boards/) | Whole boards at 1x with the designer's title and explanation | Context only |
| [`screens/states/`](screens/states/) | Live prototype captured in the greeting, open-home and open-chat states | Launcher, greeting and open-state targets |
| [`tokens.json`](tokens.json) | Tokens resolved for the default accent `#16142B`, plus `brandOverrides` | Summarised in §3; do not duplicate |

**Board chrome is not product UI** (ignore): `.t2-h`/`.t2-d` titles, `.tag` labels, `.t2-row`/`.t2-col`, the board
background `#E8E7EE`, the fake website `.site`/`.sbar`/`.page`, prototype buttons `.ctl`, phone chrome `.notch`/`.homebar`
and the 46px phone radius, `section` `aria-label`s that name the board screen. **Exception:** the motion-note list `.mn` in
board 06 is spec content (transcribed in §6.1). **Demo content** (names Sara/Mehdi/Reza/Ali, "Nilufar Store", the "N"
logo, order 48213, messages, file names, article text, counts, times) is not copy; UI strings are in §10.

**Board defects: reproduce the intent, not the defect** (all verified by rendering the reference pages):

| # | Where | Defect in the board | Implement |
|---|---|---|---|
| D1 | 08 article meta `.am` | `.am span{display:inline-flex}` (t2.css:380) also matches the avatar `span.av.s24`, so the initial "S" sits at the left of its circle instead of centred (visible in the screenshot) | Centre the initial (scope the rule to `.am > span`) |
| D2 | 05 file download `.ring` | `.ring` (t2.css:275) has no `border:0;padding:0`, so Chromium's default 2px outset button border shows and the progress arc is offset 2px right/down (visible in the screenshot) | `border:0; padding:0` |
| D3 | 06 live prototype | `.site.m2 .dm.k2.typing{display:none}` (t2.css:481) hides the typing row in the very step (`m2`, 1300 ms) meant to show it, and the row carries `.typing` on the group wrapper, which would paint the whole group as a typing pill | Show typing in `m2` with the board-02 structure (`.g.L > .av + .s > .typing`, §4.11), hide it in `m3` |
| D4 | Focus on the hero (Respok) | `.b-rp :is(button,a,[role=textbox]):focus-visible` (t2.css:554, specificity 0,3,0) beats `.hero :is(button,a):focus-visible{outline-color:#fff}` (t2.css:555, 0,2,1), so the hero close button computes a Signal ring | White ring on the hero, as the later rule and [brief §7](../../CLAUDE_CODE_BRIEF.md) intend (no screenshot shows focus) |
| D5 | 05 voice bubble | `button.pb` shows the pause glyph (playing state, first 9 bars animate) but is labelled "Play voice message" | Label follows state: play label when paused, pause label when playing (§4.16) |

---

## 1. Screen inventory

| ID | Screen | Screenshot (2x) | Reference page | Production view (production map §) | Work |
|---|---|---|---|---|---|
| 01 | Home · first visit | [01-home--01-first-visit.png](screens/panels/01-home--01-first-visit.png) | [01-home.html](reference/01-home.html) | Home `homeHtml` (§4.1), restructured | Restyle + markup |
| 02 | Home · returning visitor | [01-home--02-returning-visitor.png](screens/panels/01-home--02-returning-visitor.png) | [01-home.html](reference/01-home.html) | §4.1 (continue CTA, recent conversations) | Restyle + markup |
| 03 | Home · team away | [01-home--03-team-away.png](screens/panels/01-home--03-team-away.png) | [01-home.html](reference/01-home.html) | §4.1 offline home | Restyle + markup |
| 04 | Live chat (order card, typing) | [02-conversation--04-live-chat.png](screens/panels/02-conversation--04-live-chat.png) | [02-conversation.html](reference/02-conversation.html) | Chat `chatFrameHtml` §4.2, messages §5.1, typing §5.6, composer §5.7 | Restyle + markup |
| 05 | Photos, files and voice (+ recording, failed send) | [02-conversation--05-photos-files-and-voice.png](screens/panels/02-conversation--05-photos-files-and-voice.png) | [02-conversation.html](reference/02-conversation.html) | §5.5 attachments, §5.7 recorder, §5.1 failed send | Restyle + markup |
| 06 | New conversation (topics, instant answers) | [02-conversation--06-new-conversation.png](screens/panels/02-conversation--06-new-conversation.png) | [02-conversation.html](reference/02-conversation.html) | §4.2 `emptyHtml`, §5.12 Q&A chips, §5.7 composer with draft | Restyle + markup |
| 07 | Help search | [03-help-and-conversations--07-help-search.png](screens/panels/03-help-and-conversations--07-help-search.png) | [03-help-and-conversations.html](reference/03-help-and-conversations.html) | Help `kbHtml` §4.4 (`results` state) | Restyle + markup |
| 08 | Article | [03-help-and-conversations--08-article.png](screens/panels/03-help-and-conversations--08-article.png) | [03-help-and-conversations.html](reference/03-help-and-conversations.html) | §4.4 `article` state, §5.14 rating | Restyle + markup |
| 09 | Your conversations | [03-help-and-conversations--09-your-conversations.png](screens/panels/03-help-and-conversations--09-your-conversations.png) | [03-help-and-conversations.html](reference/03-help-and-conversations.html) | List `conversationListHtml` §4.3 | Restyle + markup |
| 10 | Asking for an email | [04-details-and-feedback--10-asking-for-an-email.png](screens/panels/04-details-and-feedback--10-asking-for-an-email.png) | [04-details-and-feedback.html](reference/04-details-and-feedback.html) | Handoff card `handoffPrechatCardHtml` §4.7 | Restyle + markup |
| 11 | Message while away | [04-details-and-feedback--11-message-while-away.png](screens/panels/04-details-and-feedback--11-message-while-away.png) | [04-details-and-feedback.html](reference/04-details-and-feedback.html) | Offline chat (§4.2 offline) / contact fallback §4.6 | Restyle + markup |
| 12 | Rating after a chat | [04-details-and-feedback--12-rating-after-a-chat.png](screens/panels/04-details-and-feedback--12-rating-after-a-chat.png) | [04-details-and-feedback.html](reference/04-details-and-feedback.html) | None (§5.13: no conversation rating in production) | New |
| 13 | Mobile home | [05-mobile--13-home.png](screens/panels/05-mobile--13-home.png) | [05-mobile.html](reference/05-mobile.html) | §2 mobile sheet + §4.1 | Restyle |
| 14 | Mobile conversation | [05-mobile--14-conversation.png](screens/panels/05-mobile--14-conversation.png) | [05-mobile.html](reference/05-mobile.html) | §2 mobile sheet + §4.2 | Restyle |
| P1 | Launcher at rest (site mock) | [06-live-prototype--site-mock.png](screens/panels/06-live-prototype--site-mock.png), board [06-live-prototype.png](screens/boards/06-live-prototype.png) | [06-live-prototype.html](reference/06-live-prototype.html) | RESPOK kit §3.1, §3.3 | Restyle |
| P2 | Greeting + unread badge | [06-live-prototype--greeting.png](screens/states/06-live-prototype--greeting.png) | [06-live-prototype--greeting.html](reference/06-live-prototype--greeting.html) | Smart nudge §5.11, kit badge §3.3 | Restyle + markup |
| P3 | Open on home (cascade) | [06-live-prototype--open-home.png](screens/states/06-live-prototype--open-home.png) | [06-live-prototype--open-home.html](reference/06-live-prototype--open-home.html) | Panel open §2, launcher `.open` §3.1 | Restyle (motion) |
| P4 | Open in chat (view slide, message entrance) | [06-live-prototype--open-chat.png](screens/states/06-live-prototype--open-chat.png) | [06-live-prototype--open-chat.html](reference/06-live-prototype--open-chat.html) | View swap §2, message entrance §5.1 | Restyle (motion) |

Board images: [01](screens/boards/01-home.png), [02](screens/boards/02-conversation.png),
[03](screens/boards/03-help-and-conversations.png), [04](screens/boards/04-details-and-feedback.png),
[05](screens/boards/05-mobile.png), [06](screens/boards/06-live-prototype.png).

---

## 2. Frame and layout

### 2.1 Panel frame (`.p`, t2.css:73-75)

| Property | Design | Production |
|---|---|---|
| Size | 400 × 720 | `.panel` width/height 400 × 720 (today 420 × 680, CSS:79-80); keep `max-height: calc(100dvh - 118px)`, `max-width: calc(100vw - 24px)` |
| Radius | `--r-panel` 28px on all corners except the tail | `border-radius: 28px` |
| Tail corner | `--tail` **8px** (Respok, t2.css:51), written as `border-end-end-radius` (correct only for LTR + bottom-right) | Physical corner of the anchor ([brief §4](../../CLAUDE_CODE_BRIEF.md)): `.panel.bottom-right{border-bottom-right-radius:var(--tail)}`, `.panel.bottom-left{border-bottom-left-radius:var(--tail)}`, both directions |
| Background | Home (`.p.home`): `--paper` `#F5F5F8`. Chat, help, article, list: `#fff` | Per view: `.panel[data-view=home]` paper, others white (the view root paints it) |
| Shadow | `--sh-panel` `0 0 0 1px rgba(15,18,23,.05), 0 16px 36px -16px rgba(15,18,23,.24), 0 56px 110px -44px rgba(15,18,23,.4)` | `.panel` box-shadow |
| Clip and stacking | `overflow:hidden; isolation:isolate; display:flex; flex-direction:column` | Same |
| Base type | `font-size:14px; line-height:1.6`, `--font` Figtree stack, `color: var(--ink)`, `-webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility` | On the template root |

### 2.2 Regions top to bottom (desktop, measured in the reference pages)

**Home (01, 02, 03).** No scrolling container in the board (content fits).

| Region | Class | y / height | Box |
|---|---|---|---|
| Hero | `.hero` | 0 / 312.1 (content-driven) | padding 18 20 80; hero row `.top` 48 at y 18; `.hi` at y 102 (22.4); `.hq` at y 126.4 (63.7, two lines); `.pres` at y 204.1 (28) |
| Ask card | `.ask` | 260.1 / 126 (01, 02), 112.8 (03) | overlaps the hero by 52 (`margin:-52px 14px 0`), 372 wide, padding 12, `z-index:1`; field 56; chips row 34 at +12 (03: note 18.8 at +12, margin-bottom 2) |
| Quiet rows | `.list` | 402.1 / 136 (2 rows) or 200 (3 rows); 03: 388.9 | `margin:16px 14px 0; padding:4px`; rows 64 tall |
| Empty | — | rest | panel background `--paper` |
| Footer | `.pw` | 680 / 40 | pinned by `margin-top:auto` |

**Chat (04, 05, 06, 10, 11, 12).**

| Region | Class | y / height | Box |
|---|---|---|---|
| Top bar | `.bar` | 0 / 68 | `padding:0 10px; gap:6px; z-index:3`; translucent white + blur; 1px `--line` hairline at the bottom |
| Thread | `.thread` | 68 / 520 (04, 10, 11); 554 with the 52px recorder (05); 366.4 above the tray (06); 612 with no composer (12) | `flex:1; min-height:0; overflow:hidden; padding:14px 14px 6px`; content bottom-aligned (`justify-content:flex-end`) and the top 34px fade out (`mask-image: linear-gradient(to bottom, transparent 0, #000 34px)`); `.thread.top` (06, 11): top-aligned, no mask |
| Instant answers | `.tray` | 434.4 / 145.6 (06 only) | `margin:0 12px 8px; z-index:2` |
| Composer | `.cmp` | 588 / 92 (box) or 622 / 58 (recorder) | `padding:6px 12px 0; z-index:2`; box 86 tall |
| Footer | `.pw` | 680 / 40 | |

**Help search (07):** bar 0–68 · search field 82 (50 tall, `margin:14px 14px 0`) · count 146 · results 171.2 (rows 81.4 / 81.4 / 62.2) · "Or start from a topic" 414.1 · category grid 444.1–595.3 · footer 680.
**Article (08):** bar 0–68 with the 2px progress line at y 67 · article 68–532.7 (`flex:1`, padding 20 22 0, bottom fade) · feedback row 532.7–595.7 (63) · help CTA 595.7–676 (80.3, margin-bottom 4) · footer 680.
**Your conversations (09):** bar 0–68 · list 68–680 (`padding:8px 10px`, rows 95.6) · floating button 620–668 (`bottom:52px`, centred, `z-index:4`) · footer 680.

### 2.3 What scrolls in production

The boards clip (`overflow:hidden`); production must scroll the middle region so that, when the viewport cap shrinks the
panel, only that region gives up height ([brief §4](../../CLAUDE_CODE_BRIEF.md)): chat thread = `[data-chat-messages]`;
help results + categories; article body (`.art` → `.wy-kb-scroll`); conversation list (`.inbox`). Bar, composer, tray,
article feedback row, help CTA and footer never shrink. **Home: not specified in the design.** Suggestion: hero, ask card
and rows scroll together above the fixed footer; the close button stays pinned (it is the shell's `.panel-close`).
Keep the article's bottom fade mask (`#000 82%` → transparent, t2.css:544) on the scroll container; suggestion: drop it
once scrolled to the end so the last line is not faded.

### 2.4 Z-order inside the panel

`.hero` 0 (glow `.aur` and watermark `.mk` at −1 inside it) · `.ask` 1 · `.cmp`, `.tray` 2 · `.bar` 3 · `.fab` 4.
Production layers keep their values: `.wy-jump` 4, `.panel-close` 20 (above every design layer), `.gs-call-host` 30,
lightbox 2147483100 (production map §2).

### 2.5 Close button per view (production `button.panel-close[data-panel-close]`)

Keep the shell-level absolute button and its hook; move and restyle it per view ([brief §4](../../CLAUDE_CODE_BRIEF.md)):

| View | Position | Look |
|---|---|---|
| Home (on the hero) | `top:23px; inset-inline-end:20px` (hero padding 18 + (48 − 38) / 2) | `.gb` (§4.2): 38 × 38, radius 12, `rgba(255,255,255,.14)`, inset 1px `rgba(255,255,255,.12)`, `backdrop-filter: blur(10px)`, white X 20px stroke 1.9 |
| Bars (chat, help, article, list) | `top:15px; inset-inline-end:10px` | `.ib` (§4.8): 38 × 38, radius 12, transparent, `--ink-2` X 20px stroke 1.9 |

The bar must leave room for it: reserve `padding-inline-end: 54px` (10 + 38 + gap 6) so "More options" ends 6px before
the close button, as drawn (x 308 vs 352).

### 2.6 Mobile (13, 14; t2.css:75-84, 182, 546-550)

Board: `.p.mob` 390 × 844 drawn inside a phone frame (radius 46, notch, home bar: device chrome, ignore). In production the
open sheet is `.shell.gs-mobile-open .panel` (full screen, radius 0, no shadow, safe-area padding; production map §2);
apply these under it and under `@media (max-width:640px)` for the first frame:

| Board rule | Meaning | Production |
|---|---|---|
| `.p.mob .hero{padding-top:58px}` | 18px hero padding + 40px reserved for the phone status bar | Hero background must reach the top edge: suggestion: for the home view set the sheet's `padding-top` to 0 and give the hero `padding-top: calc(18px + env(safe-area-inset-top, 0px))` |
| `.p.mob .bar{height:auto; padding:54px 10px 10px}` | 40px status bar + 14px; content row 40; bottom padding 10 (desktop 14) | Derived: `padding: calc(14px + env(safe-area-inset-top, 0px)) 10px 10px` (bar = 64px below the safe area) when the sheet's own top padding is 0; otherwise `14px 10px 10px` |
| `.p.mob .pw{margin-bottom:20px}` | home-bar allowance | `env(safe-area-inset-bottom)` (the sheet already pads it) |
| `.p.mob .chips{flex-wrap:nowrap; overflow-x:auto; margin-inline:-12px; padding-inline:12px; scrollbar-width:none}` + mask | one scrolling row of chips; edge fade `linear-gradient(to <end>, transparent 0, #000 28px, #000 calc(100% − 12px), transparent)` with `--fade-to:right` in LTR (left in RTL): 28px fade at the start edge, 12px at the end edge; scrollbar hidden | Same |
| `.p.mob .chip{height:40px; padding-inline:12px 14px; font-size:13.5px}` | larger touch target | Same |
| `.p.mob{font-size:15px}` | base size; no drawn text inherits it | Same |
| Close button | hero 63 = 40 + 23; bar 55 = 40 + 15 | `top: calc(env(safe-area-inset-top, 0px) + 23px)` on home, `+ 15px` on bars (replaces production's `+ 12px`, CSS:145) |

Mobile geometry (board): hero 352.1 · ask card at 300.1 (132 tall, chips 40) · rows at 448.1 · footer 784–824 · bar 104 ·
thread 104–692 · composer 692–784. t2.css has **no** mobile enlargement of icon buttons (bar `.ib` 38, composer tools 36);
[brief §7](../../CLAUDE_CODE_BRIEF.md) requires touch targets ≥ 44px. Suggestion: keep the drawn sizes and extend the hit
area to 44 × 44 with a transparent pseudo-element.

---

## 3. Tokens

### 3.1 Colour

Production root: `:host, .shell` with `--a: var(--gs-primary)` ([brief §5](../../CLAUDE_CODE_BRIEF.md)). Respok values come
from `.t2.b-rp` (t2.css:43-54); derived shades from `.t2` (t2.css:11-42).

**Accent and derived** (resolved for `#16142B`, from [`tokens.json`](tokens.json))

| Token | CSS expression | Default | Used for |
|---|---|---|---|
| `--a` | `var(--gs-primary)` (board: inline `--a: {{accent}}`) | `#16142B` | Visitor bubble, voice bubble, send/act on, FAB, CSAT button, email OK button, order progress, reading progress, download arc, logo initial, `.steps` dots, home-field fake caret, launcher |
| `--a-1` | `color-mix(in oklab, var(--a) 5%, #fff)` | `#F2F2F3` | Base `.chip:hover` bg (Respok overrides) |
| `--a-2` | `color-mix(in oklab, var(--a) 10%, #fff)` | `#E4E4E8` | `.face:hover` bg, `.steps .now` halo (anim) |
| `--a-3` | `color-mix(in oklab, var(--a) 20%, #fff)` | `#CACAD1` | `.steps span.now` halo, article link underline |
| `--a-hi` | `color-mix(in oklab, var(--a) 88%, #fff)` | `#2C2B41` | Top stop of the home `.send` gradient (the only gradient Respok keeps) |
| `--a-ink` | `color-mix(in oklab, var(--a) 72%, #0B0D12)` | `#131224` | `.face:hover` icon, `.ring` icon, article links, `.meta .retry` |
| `--on-a` | `#fff` default; computed per accent (below) | `#FFFFFF` | Every text/icon on the accent; the hero text colour |
| `--kon` | `= --on-a` | `#FFFFFF` | Launcher glyph main piece |
| `--kac` | `#FF5A3C` when accent is the brand default, else `--on-a` | `#FF5A3C` | Launcher accent piece (Thread answer pill / Open dot) |

**`--on-a`, `--kac` and hero overrides: exact board logic** (`lum()` + `renderVals()`, identical in every board script,
e.g. [`source/01-home.dc.html`](source/01-home.dc.html)):

```js
lum(hex) {                      // WCAG relative luminance
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.replace(/(.)/g, '$1$1');
  if (h.length !== 6) return 0; // invalid → 0 → white text
  const c = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
renderVals() {
  const accent = this.props.accent ?? '#16142B';
  const def = String(accent).toUpperCase() === '#16142B';         // brand default
  const L = this.lum(accent);
  const on = 1.05 / (L + 0.05) >= (L + 0.05) / (this.lum('#16142B') + 0.05) ? '#FFFFFF' : '#16142B';
  return { accent, onA: on,                                       // --a, --on-a (also --kon)
    kac: def ? '#FF5A3C' : on,                                     // --kac
    heroVars: def ? '--h1: #3B3576; --h2: #1E1B3B; --h3: #100E20; --glow: #FF5A3C;' : '',
    lg: this.props.logo === 'open' ? 'lg-open' : 'lg-thread' };   // root class
}
```

White wins when its contrast against the accent (`1.05 / (L + 0.05)`) is at least the accent's contrast against Ink
(`(L + 0.05) / (lum(#16142B) + 0.05)`, `lum(#16142B)` ≈ 0.0085). Results: `#16142B` white (17.96 vs 1.00); `#2F5BFF`
white (5.17 vs 3.47); `#0F766E` white (5.47 vs 3.28); `#C2410C` white (5.18 vs 3.47); a light accent such as `#FFB423`
gets Ink (1.78 vs 10.10). Production ([brief §5.3](../../CLAUDE_CODE_BRIEF.md)): compute once in the loader next to
`--gs-shadow` (LD:1088-1107), publish `--gs-on-primary`; the template reads `--on-a: var(--gs-on-primary, #fff)`,
`--kon: var(--on-a)`; `--kac: var(--on-a)` except under the brand class.

**Brand overrides** (`tokens.json` → `brandOverrides`): the board applies them when the accent equals `#16142B`
(`def`). Production: put them under `.shell.gs-accent-brand` (brief §5.2), set when the accent is uncustomised (empty or
`#3B82F6`, mapped to `#16142B`) **and** when the owner picks the Ink preset, so production matches `renderVals()`.

| Token | Formula (any other accent, `.t2.b-rp`) | Brand override (Ink) |
|---|---|---|
| `--h1` | `color-mix(in oklab, var(--a) 74%, #5B53A8)` (`#262349` for Ink) | `#3B3576` |
| `--h2` | `var(--a)` | `#1E1B3B` |
| `--h3` | `color-mix(in oklab, var(--a) 82%, #000)` (`#0E0D1E` for Ink) | `#100E20` |
| `--glow` | `#FF5A3C` (fixed for Respok, t2.css:47) | `#FF5A3C` |
| `--kac` | `= --on-a` | `#FF5A3C` |

**Neutrals and status (Respok, fixed: unlike the base `.t2` they are not tinted by the accent)**

| Token | Respok value | Base `.t2` value (WebYar, for contrast) | Used for |
|---|---|---|---|
| `--ink` | `#16142B` | `#0F1217` | Main text; chip outline/fill; `.cta` background; `.card .cf .go`; read ticks; typing status |
| `--ink-2` | `#3D3B55` | `#434955` | Secondary text in cards, article body, icon buttons |
| `--ink-3` | `#5E5C75` (Slate) | `#666D7A` | Meta text, subtitles, placeholders on home, inactive icons |
| `--ink-4` | `#A9A7BC` | `#A3A9B4` | Composer/CSAT/email placeholders, chevrons, `.note` icon |
| `--paper` | `#F5F5F8` | `color-mix(a 3%, #F4F6F8)` | Home background, field fill, icon tiles, hover fills, `.day`, `.away`, CSAT faces |
| `--paper-2` | `#EDECF2` | `color-mix(a 5%, #ECEFF2)` | `.pill.done`, `.sfield .x`, `.cat:hover`, `.ol li b`, skeleton highlight |
| `--line` | `#E4E3EC` (Mist) | `color-mix(a 7%, #E6E9ED)` | Hairlines, card rings, dividers |
| `--line-2` | `#D3D1DE` | `color-mix(a 8%, #D3D8DE)` | Field hover ring, composer ring, future step dot ring |
| `--bubble` | `#F0EFF5` | `color-mix(a 6%, #F0F2F5)` | Operator bubble, typing bubble, file bubble |
| `--live` | `#FF5A3C` (Signal) | `#12A150` | Presence dots (`.pr`, `.ondot`, `.welc p i`) |
| `--away` | `#A9A7BC` | `#A3A9B4` | Away presence ring |
| `--bad` | `#D3361A` (Signal Deep) | `#D33A43` | "Not sent" |
| `--rec` | `#FF5A3C` | `#E5484D` | Recorder dot, rings, wave, stop button |
| `--unread` / `--unread-ink` | `#D3361A` / `#fff` | `#FFB423` / `#12141F` | `.nb` unread count |

**Fixed Respok literals in `.b-rp` rules**

| Value | Where |
|---|---|
| `#FF5A3C` (Signal) | Focus outline; composer/search/email focus ring `0 0 0 2px`; carets in composer and search; `.tray h4` sparkle; `.pres .dot` (hero); `.faces button.on` inset ring |
| `rgba(255,90,60,.12)` | 6px (composer, search) / 5px (email) focus halo |
| `#FFEAE4` bg + `#A62A12` text | `.pill` (Shipped, Open), `.fcard.done .ck`, `.faces button.on` |
| `#FFE1D9` | `mark` highlight |
| `#FFF4F1` bg, `#FFD9CE` inset ring, `#8A2410` text | Article `.tip` |
| `#F1F0F6` → `#E4E3EC` (140deg) | Order card thumbnail `.card .th` |
| `#8C83FF` | Second hero glow blob |

**Other literals (both brands):** avatar pastels `.c1` `#FCE3D4`/`#8A3410`, `.c2` `#DCE6FB`/`#1C4A92`, `.c3`
`#D2EEDF`/`#145E39`, `.c4` `#EBE1FA`/`#57309A` (t2.css:120); reaction heart `#E5484D`; file-type label `#D33A43`; image
caption pill `rgba(10,12,16,.45)`; `.gb` whites; launcher shadows `rgba(22,20,43,…)`; launcher badge `#D3361A`. Resolved helper mixes for Ink: `.pres` avatar ring `color-mix(in oklab, var(--h2) 92%, #000)` = `#1A1734`;
recorder rings `color-mix(in oklab, var(--rec) 45%, #fff)` = `#FFBAAA` and `10%` = `#FFF0EC`; recorder bars
`color-mix(in oklab, var(--rec) 70%, #fff)` = `#FF927B`.

### 3.2 Typography

Font stacks: `--font` = `Figtree, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` (t2.css:52);
codes `"DM Mono", ui-monospace, Menlo, monospace` (t2.css:229); RTL text `"Vazirmatn", ui-sans-serif, system-ui,
sans-serif` (tokens.json `text_rtl`, §7). Weights used: 400, 500, 600, 700, 800. Figtree needs tighter leading than
Vazirmatn; the Respok line-heights are marked **(R)**.

| Role | Size / line-height / weight / letter-spacing | Classes |
|---|---|---|
| Hero greeting | 16 / 1.4 / 500 (R; base 15.5 / 1.5), opacity .86, margin-top 36 (R; base 34) | `.hi` |
| Hero headline | 27 / 1.18 / 700 / −.02em (R; base 1.35, −.01em), `text-wrap:balance`, forced break after "How can we" / "Leave us" | `.hq` |
| Presence line | 13 / 1.45 / 500, text opacity .92 | `.pres` |
| Logo initial | 21 / – / 700, colour `--a` | `.logo` |
| Ask placeholder | 15 / 24px line box, `--ink-3` | `.field .ph` |
| Chip | 12.5 / 1 / 600 (thread `.qr` 13, mobile 13.5) | `.chip` |
| Row title / subtitle | 14.5 / 1.45 / 600 · 12.5 / 1.5 / 400 (unread `.u` 500, `--ink`) | `.r .t1`, `.r .t2x` |
| Row end / unread badge | 11.5 · 11 / 1 / 800 | `.r .end`, `.nb` |
| Footer | 11.5 | `.pw` |
| Bar name / status | 15 / 1.35 / 700 · 12.5 / 1.4 | `.who .nm`, `.who .st` |
| Bar title | 17 / 1.4 / 700 | `.ttl` |
| Day divider | 11.5 / 1.6 / 600 | `.day` |
| System line | 12 | `.sys` |
| Sender label | 11.5 / 1.5 / 600 | `.g .who-l` |
| Bubble | 14.5 / **1.5** (R; base 1.65) | `.b` |
| Meta | 11 / 1.5 ("Not sent" 700, "Try again" 11 / 700) | `.meta` |
| Inline code | 12.5, **DM Mono** (R) | `.code` (defined, unused in the boards) |
| Card title / sub | 13.5 / 1.45 / 700 · 12 / 1.5 | `.card .tt b`, `.card .tt small` |
| Pill | 11 / 1 / 700 | `.pill` |
| Step label | 11 / 1.3 / 600 | `.steps span` |
| Card footer / button | 12.5 · 12.5 / 700 | `.card .cf`, `.card .cf .go` |
| File name / size / type | 13 / 1.5 / 600 · 11.5 · 10 / 800 / .02em | `.file .fx b`, `small`, `.ft` |
| Voice time / caption | 11.5 tabular-nums · 11 | `.voice .tm`, `.img .cap` |
| Welcome title / line | 15.5 / 1.45 / 700 · 12.5 / 1.5 | `.welc h3`, `.welc p` |
| Composer text | 14.5 / 26px | `.box .in` |
| Recorder time / hint | 13 / 700 tabular-nums · 11.5 / 1.5 | `.rec .tm`, `.hint` (unused) |
| Tray heading / title / sub | 12 / 1.5 / 700 · 13.5 / 1.45 / 600 · 11.5 / 1.5 / 500 | `.tray h4`, `.tt`, `small` |
| Search text | 15 | `.sfield` |
| Result count / section | 12 / 600 · 12.5 / 700 | `.cnt`, `.sec` |
| Result title / excerpt | 14 / 1.5 / 600 · 12 / 1.6 (2-line clamp) | `.res .tt`, `.res small` |
| Category title / count | 13.5 / 1.45 / 700 · 11.5 / 1.5 | `.cat b`, `.cat small` |
| Article h1 | 22 / **1.25** / 700 / **−.018em** (R; base 1.5, −.01em), balance | `.art h1` |
| Article meta | 12 | `.am` |
| Article p / h2 | 14.5 / **1.65** (R; base 1.95) · 16 / 1.5 / 700 | `.art p`, `.art h2` |
| Article steps / number | 14 / **1.55** (R; base 1.75) · 12 / 700 | `.ol li`, `.ol li b` |
| Tip | 13 / 1.75 | `.tip` |
| Feedback question | 13 / 600 | `.fb` |
| Help CTA title / sub | 14 / 1.45 / 700 · 12 / 1.5 / 500, opacity .82 | `.cta .tx` |
| List name / time / preview | 14 / 1.5 / 700 · 11.5 / 500 · 13 / 1.55 (unread 600 `--ink`) | `.ci .l1`, `time`, `.l2` |
| FAB / CSAT button | 14 / 700 | `.fab`, `.csat .btn` |
| Email label / input / skip | 12 / 700 · 14 · 12.5 / 600 | `.fcard label`, `.fi span`, `.skip` |
| Saved card | 13 / 1.55 | `.fcard.done` |
| Away title / sub | 13.5 / 1.5 / 700 · 12 / 500 | `.away` |
| CSAT title / sub / comment / link | 16 / 1.5 / 700 · 12.5 · 13 / 1.6 · 12.5 / 600 | `.csat` |
| Greeting name / message | 13 / 1.4 / 700 · 13.5 / 1.55 / 400 | `.greet .gm` |
| Avatar initials | 13 / 1 / 700 (s24 10, s28 11, s30 12, s40 15, s44 16) | `.av` |
| Launcher badge | 12 / 22px / 800 | `.kl .bdg` |

### 3.3 Radii

Panel 28 (tail 8) · ask card 24 · `.list` 22 · composer box, recorder, CSAT card 22 · bubbles, typing, `.tray`, `.cta` 20
(tail/join corners 6) · Respok greeting 21 21 4 21 · field 18, rows `.r`, `.ci`, `.cat`, `.away` 18 · `.sfield`,
`.res a`, `.tip` 16 · logo, CSAT faces 15 · `.card .th`, `.fi`, `.tray a`, `.csat .ta`, `.csat .btn` 14 · `.r .it` 13 ·
`.gb`, `.ib`, `.face`, `.away .it` 12 · composer tools `.ib`, `.fi .ok`, `.res .it`, `.cat .it`, launcher badge 11 ·
`.tray .it`, `.card .cf .go`, `.nb` 10 · `.file .ft` 9 · `.ol li b`, skeleton bars 8 · `.code` 6 · `mark` 3 · steps
track 2 · pills, chips, `.day`, `.react`, `.img .cap`, `.fab` 999 · circles 50% (send, act, stop, ring, `.pb`, `.ck`,
avatars, launcher).

### 3.4 Shadows and elevation

| Token / element | Value |
|---|---|
| `--sh-panel` | `0 0 0 1px rgba(15,18,23,.05), 0 16px 36px -16px rgba(15,18,23,.24), 0 56px 110px -44px rgba(15,18,23,.4)` |
| `--sh-card` (ask card) | `0 0 0 1px rgba(15,18,23,.045), 0 2px 4px -1px rgba(15,18,23,.05), 0 18px 40px -18px rgba(15,18,23,.28)` |
| Logo | `0 8px 18px -8px rgba(0,0,0,.45)` |
| Home send | `0 6px 14px -6px color-mix(in oklab, var(--a) 80%, transparent), inset 0 1px 0 rgba(255,255,255,.22)` |
| `.list`, `.react` ring, `.card`, `.tray`, `.fcard`, `.csat` ring | `0 0 0 1px var(--line)` (+ `.react` `0 3px 8px -3px rgba(15,18,23,.18)`; `.card` `0 8px 20px -14px rgba(15,18,23,.3)`; `.tray` `0 14px 30px -18px rgba(15,18,23,.35)`; `.fcard` `0 10px 24px -16px rgba(15,18,23,.3)`; `.csat` `0 16px 34px -20px rgba(15,18,23,.35)`) |
| Bar | `0 1px 0 var(--line)` + `backdrop-filter: saturate(1.4) blur(14px)` on `rgba(255,255,255,.86)` |
| Visitor bubble | `0 1px 2px color-mix(in oklab, var(--a) 25%, transparent)` |
| Composer box | `0 0 0 1px var(--line-2), 0 8px 20px -14px rgba(15,18,23,.3)`; focused (R) `0 0 0 2px #FF5A3C, 0 0 0 6px rgba(255,90,60,.12), 0 8px 20px -14px rgba(15,18,23,.3)` |
| Send in composer (`.act.on`) | `0 6px 14px -6px color-mix(in oklab, var(--a) 75%, transparent)` |
| FAB | `0 14px 28px -12px color-mix(in oklab, var(--a) 80%, transparent), inset 0 1px 0 rgba(255,255,255,.2)` |
| Help CTA | `0 12px 24px -16px rgba(15,18,23,.6)` |
| Greeting | `0 16px 36px -10px rgba(15,18,23,.28), 0 0 0 1px rgba(15,18,23,.05)` |
| Launcher `.kl` | `0 10px 28px rgba(22,20,43,.28)`; hover `0 16px 36px rgba(22,20,43,.36)` |
| Avatar rings | stack `0 0 0 2.5px #fff`; hero stack `0 0 0 2px color-mix(in oklab, var(--h2) 92%, #000)` (`#1A1734` for Ink); welcome `0 0 0 3px #fff`; CTA `0 0 0 2.5px rgba(255,255,255,.9)`; presence dot `0 0 0 2.5px #fff` |

### 3.5 Spacing rhythm

Side insets: cards and lists sit 14px from the panel edge (`.ask`, `.list`, `.sfield`, `.cats`, `.fb`, `.cta`, thread
padding); text-only sections 22px (`.cnt`, `.sec`, `.art`); bars, `.inbox`, `.res` 10px; composer 12px. Vertical: hero
padding 18 / 80, card overlap −52, rows 64 tall with 10/12 padding, bubbles 3px apart inside a group and 14px between
groups, 12px inside cards, 40px footer. Gaps: 6 (chips, bar), 8 (field, group), 10 (hero row, `.who`, `.cats`), 12 (rows,
cards, list items).

### 3.6 Icons

All icons are inline SVG, `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"
stroke-linejoin="round"`, coloured by the parent. Copy the paths from the board named in the last column.

| Icon | Drawn size · stroke | Used in | Source |
|---|---|---|---|
| Close X `M6 6l12 12M18 6 6 18` | 20 · 1.9 (hero, bars); 15 · 2.4 (greeting); 14 · 2.2 (search clear) | `.gb`, `.ib`, `.gx`, `.sfield .x` | 01, 03, 06 |
| Arrow up `M12 19V5M5.5 11.5L12 5l6.5 6.5` | 20 · 2.2 | `.send`, `.act.on`, `.rec .stop` | 01, 02 |
| Back chevron `m14 6-6 6 6 6` / forward chevron `m10 6 6 6-6 6` | 20 · 2 / 18 · 2 | bar back; `.r .ch`, `.tray .ch`, `.cta .go` | 02, 01 |
| More `M5 12h.01M12 12h.01M19 12h.01` | 20 · 3 | bar "More options" | 02 |
| Truck · return arrow · ruler · box · two bubbles · book | 16 · 1.8 (chips), 20 · 1.7 (row tiles), 18 · 1.7 (tiles in tray/results/categories, card footer truck) | chips, `.r .it`, `.res .it`, `.tray .it`, `.cat .it`, `.card .cf` | 01, 02, 03 |
| Card · user | 18 · 1.7 | categories Payments, Your account | 03 |
| Mail | 16 · 1.8 | `.note`, `.lnk2` | 01, 04 |
| Double tick (`.rd`) | 16 · 2 | visitor meta | 02 |
| Error circle (`.er`) | 14 · 2.2 | failed meta | 02 |
| Shoe | 26 · 1.6 (card thumb); 64 · 1.2 (image placeholder, demo) | `.card .th`, `.img` | 02 |
| Smile (eyes stroke 2.6) · paperclip · mic (filled capsule + stroke 2) | 20 · 1.8 · 1.8 · 2 | composer tools, `.act` | 02 |
| Image | 13 · 2 | `.img .cap` | 02 |
| Download (+ arc `viewBox 0 0 34 34`, circle r 15) | 16 · 2 | `.ring` | 02 |
| Heart (filled) | 12 | `.react` | 02 |
| Pause (two filled bars) | 15 | `.voice .pb` (play glyph not drawn) | 02 |
| Trash | 20 · 1.8 | recorder delete | 02 |
| Sparkle | 16 · 1.7 | `.tray h4` | 02 |
| Search | 20 · 1.9 | `.sfield` | 03 |
| Clock · info | 15 · 1.8 · 18 · 1.9 | `.am`, `.tip` | 03 |
| Faces: frown, slight frown, neutral, smile, big smile (filled mouth) (eyes stroke 2.6) | 22 · 1.7 (`.face`), 26 · 1.6 (`.faces`) | article rating (frown/neutral/big smile), CSAT (all five) | 03, 04 |
| Plus | 20 · 2.2 | `.fab` | 03 |
| Check `m5 12.5 4 4 10-10` | 18 · 2.4 (`.ok`), 16 · 2.4 (`.ck`) | email card | 04 |
| Moon | 18 · 1.8 | `.away .it` | 04 |
| Brand: Thread symbol (`viewBox 0 0 104 92`), Open symbol (`0 0 82 82`; launcher `0 0 108 108` with dot r 12 at 96,96), lockups (`0 -42 804.8 184` Thread, `0 -49.9 812.2 199.8` Open) | see §4.2, §4.33, §4.34 | watermark, footer, launcher | 01, 06; files in [`../../shared/brand/respok/`](../../shared/brand/respok/) |

### 3.7 Motion tokens

| Token | Value | Character |
|---|---|---|
| `--ease` | `cubic-bezier(.2,.9,.25,1)` | fast-out, gentle settle (view slide, rises, fills) |
| `--ease-in` | `cubic-bezier(.55,0,.75,.2)` | accelerating exit (launcher drop, panel close) |
| `--spring` | `linear(0, 0.044 4.2%, … 1.083 54.2%, … 1)` (full list in [`tokens.json`](tokens.json)) | small overshoot, peak 1.083 at ~50–54% (panel open, cascade, new message, FAB, launcher rise) |
| `--bounce` | `linear(0, 0.059 3.3%, … 1.179 33.3%, … 1)` | larger overshoot, peak 1.179 at ~33% (badge, pops, chip/face presses) |

Fallback for browsers without `linear()`: `cubic-bezier(.2,.9,.25,1)` ([brief §7](../../CLAUDE_CODE_BRIEF.md)).
Durations used: 1.1s caret, 1.2s dots, 2.4s ping, 12s placeholder cycle, .15–.25s hovers/presses, .26s exits, .3–.6s
entrances, 16s/22s glow drift. Full table §6.

### 3.8 Respok skin: every `.b-rp` rule (goes into `presentation-simple-intl.css`)

The skin = the `.t2.b-rp` token block (t2.css:43-54, §3.1) + the rules below + the Respok launcher. In the skin file drop
the `.b-rp` prefix (the file only loads for `simple-intl`). Base values are what `presentation-simple.css` (WebYar)
already has.

| t2.css | Selector | Base (`simple`) | Respok (`simple-intl`) |
|---|---|---|---|
| 51 | `--tail` | 28px | **8px** tail corner |
| 52 | `--font` | Vazirmatn stack | Figtree stack |
| 60 | `.lg-open .g-t, .lg-thread .g-o` | — | `display:none!important` (logo direction, §4.33) |
| 83 | `.hero` background | `radial-gradient(120% 90% at 100% 0%, color-mix(h1 85%, transparent), transparent 62%), linear-gradient(165deg, h1 0%, h2 52%, h3 100%)` | `radial-gradient(110% 80% at 100% 0%, color-mix(in oklab, var(--h1) 90%, transparent), transparent 60%), linear-gradient(165deg, var(--h1) 0%, var(--h2) 55%, var(--h3) 100%)` |
| 90 | `.hero .aur i:nth-child(1)` | opacity .55 | .42 |
| 91 | `.hero .aur i:nth-child(2)` | glow-mix gradient, opacity .26 | `radial-gradient(closest-side, #8C83FF, transparent)`, opacity .22 |
| 93 | `.hero .mk` | top −30, inline-end −26, width 172 | top −36, inline-end −18, width 150 |
| 102 | `.hi` | margin-top 34, 15.5px, lh 1.5 | 36, 16px, 1.4 |
| 103 | `.hq` | lh 1.35, −.01em | lh 1.18, −.02em |
| 108 | `.pres .dot` | `var(--live-on-hero, #6EF0B4)` | `#FF5A3C` |
| 147-150 | `.chip` | inset 1px `--line-2`, `--ink-2` text, accent icon; hover `--a-1` fill, inset 1px `--a-3`, `--a-ink` | **outlined**: inset 1.5px `--ink`, `--ink` text and icon; hover **fills with Ink**: `background: var(--ink)`, text and icon `#fff` (the 1.5px Ink ring stays: t2.css:147 outranks t2.css:145 by order) |
| 161 | `.r .it` | `--a-2` / `--a-ink` | `--paper` / `--ink` |
| 191 | `.who .st.typ` | `--a-ink` | `--ink` |
| 214 | `.b` | lh 1.65 | lh 1.5 |
| 217 | `.R .b` | `linear-gradient(180deg, var(--a-hi), var(--a) 75%)` | **flat** `var(--a)` |
| 225 | `.meta .rd` | `--a` | `--ink` |
| 229 | `.code` | `ui-monospace, "SF Mono", Menlo, monospace` | `"DM Mono", ui-monospace, Menlo, monospace` |
| 245 | `.card .th` | `linear-gradient(140deg, var(--a-2), var(--a-3))`, `--a-ink` | `linear-gradient(140deg, #F1F0F6, #E4E3EC)`, `--ink` |
| 250 | `.pill` | `--a-2` / `--a-ink` | `#FFEAE4` / `#A62A12` (`.pill.done` t2.css:251 still wins for Resolved) |
| 265 | `.card .cf .go` | `--a-2` / `--a-ink`, hover `--a-3` | `--ink` / `#fff`; no hover change (t2.css:265 outranks t2.css:264 by order) |
| 280 | `.voice` | gradient | **flat** `var(--a)` |
| 307 | `.box.fo` | `0 0 0 1.5px var(--a), 0 0 0 6px var(--a-2), …` | `0 0 0 2px #FF5A3C, 0 0 0 6px rgba(255,90,60,.12), 0 8px 20px -14px rgba(15,18,23,.3)` |
| 311 | `.box .in.ty::after` (caret) | `--a` | `#FF5A3C` |
| 316 | `.act` | `--a-2` / `--a-ink` | `--paper` / `--ink` |
| 318 | `.act.on` | gradient | **flat** `var(--a)` |
| 333 | `.tray h4 svg` | `--a` | `#FF5A3C` |
| 337 | `.tray a .it` | `--a-2` / `--a-ink` | `--paper` / `--ink` |
| 343 | `mark` | `color-mix(in oklab, var(--a) 22%, #fff)` | `#FFE1D9` |
| 348 | `.sfield` | `0 0 0 1.5px var(--a), 0 0 0 6px var(--a-2)` | `0 0 0 2px #FF5A3C, 0 0 0 6px rgba(255,90,60,.12)` |
| 352 | `.sfield .q::after` (caret) | `--a` | `#FF5A3C` |
| 359 | `.res a .it` | `--a-2` / `--a-ink` | `--paper` / `--ink` |
| 371 | `.cat .it` | `--a-ink` | `--ink` |
| 378 | `.art h1` | lh 1.5, −.01em | lh 1.25, −.018em |
| 382 | `.art p` | lh 1.95 | lh 1.65 |
| 387 | `.ol li` | lh 1.75 | lh 1.55 |
| 389 | `.ol li b` | `--a-2` / `--a-ink` | `--paper-2` / `--ink` |
| 391 | `.tip` | `--a-1`, inset 1px `--a-3`, `--a-ink` | `#FFF4F1`, inset 1px `#FFD9CE`, `#8A2410` |
| 397 | `.b-wy .cta` | WebYar gradient | Respok keeps the base `.cta{background:var(--ink)}` (Ink whatever the accent) |
| 414 | `.fab` | gradient | **flat** `var(--a)` |
| 423 | `.fcard .fi` | `0 0 0 1.5px var(--a), 0 0 0 5px var(--a-2)` | `0 0 0 2px #FF5A3C, 0 0 0 5px rgba(255,90,60,.12)` |
| 430 | `.fcard.done .ck` | `--a-2` / `--a-ink` | `#FFEAE4` / `#A62A12` |
| 444 | `.faces button.on` | `--a-2` / `--a-ink`, inset 1.5px `--a` | `#FFEAE4` / `#A62A12`, inset **2px** `#FF5A3C` |
| 447 | `.csat .btn` | gradient | **flat** `var(--a)` |
| 489 | `.greet` | `20px 20px 6px 20px` | **`21px 21px 4px 21px`** |
| 554 | `:is(button,a,[role=textbox]):focus-visible` | `outline: 2px solid var(--a)` | outline colour `#FF5A3C` (not on the hero, D4) |
| 504-517 | `.kl` launcher, `.kl .bdg`, glyph animations | (WebYar uses `.wl`) | Respok launcher, §4.34 |

Not overridden for Respok (keep the base look): the home `.send` keeps its `--a-hi` → `--a` gradient and inset highlight;
`.steps` fill and dots, `.prog`, `.ring` arc, `.fi .ok`, `.logo` initial, `.face:hover` use the accent.
Board-chrome-only `.b-rp` rules (ignore): t2.css:64, 66, 453, 526, 534.

---

## 4. Components

Each component: design classes → production element (keep hooks, add the design class), anatomy and values, states.
"Add" = new markup in the `simple` renderer (additive; production hooks unchanged).

### 4.1 Panel and close button
See §2.1 and §2.5. Close: `button.panel-close[data-panel-close][aria-label=Close]`. States: `.gb:hover` background
`rgba(255,255,255,.24)`; `.gb:active` / `.ib:active` `scale(.92)`; `.ib:hover` `--paper`; transitions
`background-color .18s ease, transform .18s var(--ease)`; focus §4.36.

### 4.2 Hero (`.hero`, home only)
Production: new element in the home view (replaces `div.wy-head.wy-head-home` + `section.home-greeting-block`).
- Box: `position:relative; z-index:0; overflow:hidden; padding:18px 20px 80px; color: var(--on-a)`; background §3.8 (t2.css:83).
- Glow `.aur` (`aria-hidden`, `inset:0; z-index:-1`): two `i` blobs, `border-radius:50%; filter:blur(26px)`.
  Blob 1: `top:-120px; inset-inline-end:-80px; 300 × 260; radial-gradient(closest-side, var(--glow), transparent)`,
  opacity .42, drift 16s. Blob 2: `bottom:-140px; inset-inline-start:-90px; 300 × 240;
  radial-gradient(closest-side, #8C83FF, transparent)`, opacity .22, drift 22s (§6).
- Watermark `.mk` (`aria-hidden`): `position:absolute; z-index:-1; top:-36px; inset-inline-end:-18px; width:150px;
  height:auto; color:#fff; opacity:.08`. Thread: two-pill symbol (`viewBox 0 0 104 92`, 150 × 132.7). Open: bubble
  symbol (`viewBox 0 0 82 82`, 150 × 150). Shown by logo direction (§4.33).
- Top row `.top` (flex, `align-items:center; gap:10px`): `.logo` 48 × 48, radius 15, `#fff`, workspace initial 21px/700
  in `--a`, shadow `0 8px 18px -8px rgba(0,0,0,.45)`; flexible spacer; the close button (§2.5).
  Production: `identityAvatarHtml()` data (`config.logoUrl` → image; else first letter of `workspaceName`; none when
  `showLogo === false`). Image logo inside the 48px tile: not specified; suggestion: `object-fit:cover`, same radius.
- `.hi` greeting and `.hq` headline: §3.2. The headline has a designed line break (`How can we<br>help you today?`,
  `Leave us<br>a message`).
- `.pres` presence line §4.3.

### 4.3 Presence line (`.pres`)
`display:flex; align-items:center; gap:10px; margin-top:14px`. Avatar stack `.avs` (28px avatars, 11px initials,
overlap −9px, ring `0 0 0 2px color-mix(in oklab, var(--h2) 92%, #000)` = `#1A1734` for Ink), then text with a leading dot: `i.dot` 8 × 8 circle `#FF5A3C`,
`margin-inline-end:6px; vertical-align:1px`, plus a ping (`::after`, same colour, `t2-ping 2.4s var(--ease) infinite`).
Away `.pres.off`: dot becomes an empty ring (`background:transparent; box-shadow: inset 0 0 0 2px
rgba(255,255,255,.7)`, no ping) and the avatars turn `filter: grayscale(1) brightness(1.05); opacity:.8` (t2.css:538).
Data: online team members (production `vm.teamMembers` with `online`; up to 3), availability state, reply time, next
opening time (§9).

### 4.4 Avatars (`.av`, `.avs`, `.pr`)
Circle, `display:grid; place-items:center`, initials 700, `line-height:1`. Sizes: default 36 (13px), `s24` (10), `s28`
(11), `s30` (12), `s40` (15), `s44` (16). Palettes `.c1`–`.c4` (§3.1). Stack `.avs`: `margin-inline-start:-9px`, ring
`0 0 0 2.5px #fff`, first item no offset. Presence dot `.pr`: 12 × 12, `bottom:-1px; inset-inline-end:-1px`, `--live`
with `0 0 0 2.5px #fff`; `.pr.off`: `#fff` fill, `inset 0 0 0 2.5px var(--away), 0 0 0 2.5px #fff`.
Production: operator photos where they exist (`senderAvatar`, `teamMembers[].avatar`); **add** an initials fallback
(production shows no avatar layer without a photo, PD:698-710). Palette assignment is not specified; suggestion: stable
hash of the person id modulo 4.

### 4.5 Ask card (`.ask`, `.field`, `.send`, `.note`)
- `.ask`: `position:relative; z-index:1; margin:-52px 14px 0; padding:12px; border-radius:24px; background:#fff;
  box-shadow: var(--sh-card)`.
- `.field`: `display:flex; align-items:center; gap:8px; height:56px; padding-inline:16px 8px; border-radius:18px;
  background: var(--paper); box-shadow: inset 0 0 0 1px var(--line); cursor:text`; hover ring `--line-2`; transitions
  `box-shadow .2s ease, background-color .2s ease`.
- Placeholder `.ph` (`flex:1; height:24px; overflow:hidden; 15px/24px; --ink-3`): three phrases stacked
  (`position:absolute; inset:0`, one line, ellipsis) cycling with `t2-ph 12s var(--ease) infinite`, delays 0 / 4s / 8s;
  a fake caret `::before` (1.5 × 18, radius 1, `top:3px; inset-inline-start:0`, `--a`, `t2-caret 1.1s steps(1)
  infinite`). `.field.static` (away): one static phrase, no caret.
- `.send`: 42 × 42 circle, `linear-gradient(180deg, var(--a-hi), var(--a))`, `--on-a` arrow, shadow §3.4; hover
  `translateY(-1px) scale(1.05)`, active `scale(.92)`, `transition: transform .2s var(--bounce)`.
- `.chips` (`display:flex; flex-wrap:wrap; gap:6px; margin-top:12px`) §4.6.
- Away `.note`: `display:flex; align-items:center; gap:8px; margin:12px 4px 2px`; 12.5px/1.5 `--ink-3`; mail icon
  16px `--ink-4`.
- Production (new, [brief §9](../../CLAUDE_CODE_BRIEF.md) "Ask field on home"): a real `textarea` (suggested hook
  `data-home-ask`, `aria-label="Ask a question"`, one line, `rows=1`) with the `.ph` overlay `aria-hidden` while
  empty; `.send` = `button[data-home-action="chat"][aria-label=Send]`; Enter or send starts a conversation with the draft
  as the first message and moves to the chat (§6 view slide). In the live prototype a tap on the field already moves to
  the chat (board shortcut). Not specified: focused state of this field (suggestion: the composer focus ring of §4.19),
  long text (suggestion: single line, scrolls), hiding the card when `chatEnabled` is false (suggestion: hide it).

### 4.6 Chips (`.chip`, Respok outlined)
`display:inline-flex; align-items:center; gap:6px; height:34px; padding-inline:10px 12px; border:0; border-radius:999px;
background:#fff; box-shadow: inset 0 0 0 1.5px var(--ink); 12.5px/1/600; color: var(--ink); white-space:nowrap`; icon
16px in `--ink`. Hover: `background: var(--ink)`, text and icon `#fff`. Active `scale(.95)`. Transitions: `background-color,
box-shadow, color .18s ease; transform .25s var(--bounce)`. Variants: in the thread (`.qr .chip`) 36 tall,
`padding-inline:12px 14px`, 13px; mobile 40 tall, 13.5px. Home chips: suggested
`button.chip[data-home-action="chat"][data-topic="<label>"]` (topic sent as the first message); thread chips: §4.17.

### 4.7 Quiet rows (`.list`, `.r`)
- `.list`: `margin:16px 14px 0; padding:4px; border-radius:22px; background:#fff; box-shadow: 0 0 0 1px var(--line)`.
- `.r`: `display:flex; align-items:center; gap:12px; min-height:64px; padding:10px 12px; border-radius:18px; color:
  var(--ink)`; hover `--paper` (.18s). Divider between rows: `.r + .r::before` 1px `--line` at the top,
  `inset-inline: 62px 12px`; hidden on the hovered row and the row after it.
- Icon tile `.it`: 40 × 40, radius 13, `--paper`, `--ink` icon 20px (stroke 1.7). Continue row: avatar `.av.s40`
  with `.pr` instead of the tile.
- Text `.tx` (column, `min-width:0`): `.t1` title, `.t2x` subtitle (single line, ellipsis; `.u` = unread preview).
- End: chevron `.ch` 18px `--ink-4` (hover `translateX(3px)`, RTL −3px, `.2s var(--ease)`), or `.end` column
  (`align-items:flex-end; gap:5px`; 11.5px `--ink-3`): time label + `.nb` (min 20 × 20, `padding:0 6px`, radius 10,
  `#D3361A`, `#fff`, 11px/800).
- Production: emit `button.r` (or `a.r`) with these hooks: Continue → `data-conversation-open="<id>"`; Your
  conversations → `data-view="list"`; Help center → `data-view="help"`; Track an order → new (suggested
  `data-home-action="track-order"`). Row rules per screen in §5.1–5.3.

### 4.8 Top bar (`.bar`, `.ib`, `.who`, `.ttl`, `.prog`)
- `.bar`: `position:relative; z-index:3; display:flex; align-items:center; gap:6px; height:68px; padding:0 10px;
  background: rgba(255,255,255,.86); backdrop-filter: saturate(1.4) blur(14px); box-shadow: 0 1px 0 var(--line)`.
- `.ib`: 38 × 38, radius 12, transparent, `--ink-2`; hover `--paper`; active `scale(.92)`. Back = production
  `button.wy-back[data-view-back=home]` (article: `data-view-back="back" data-view-back-fallback="home"`), back chevron
  20px stroke 2, `aria-label="Back"`.
- `.who` (chat): `display:flex; align-items:center; gap:10px; flex:1; min-width:0; padding-inline:2px`; avatar `s40` with
  `.pr`; `.nm` name; `.st` status (`display:flex; align-items:center; gap:6px`): online = `i.ondot` (7px `--live`) +
  "Online"; typing `.st.typ` (`--ink`) = "typing" + three 4px dots (`t2-wave`); away = text only with `.pr.off` on the
  avatar; new conversation = 28px team stack instead of one avatar + reply time.
  Production: the chat header shows the workspace identity today (`headerIdentityHtml`); **add** the assigned agent
  (name, avatar, presence). Make `div.presence[data-presence]` (Core fills `[data-presence-dot]`,
  `[data-presence-label]`) the visible `.st` line instead of `sr-only`. Typing in the bar: suggestion
  `.wy-view-chat:has([data-typing-row]:not([hidden])) .st` switches to the typing look (no Core change).
- More options `.ib` (dots): no production menu; not specified what it opens. Render nothing until one exists.
- `.ttl` (help, article, list): `flex:1; margin:0; padding-inline:4px`; 17/1.4/700.
- `.prog` (article reading progress): `position:absolute; bottom:-1px; inset-inline-start:0; height:2px; width:100%;
  background: var(--a); transform: scaleX(p)`, origin at the inline start (`--ps:left` in LTR). Board shows p = .36
  (`t2-read-in` animates 0 → .36). Production: suggestion `p = scrollTop / (scrollHeight − clientHeight)` of the article
  scroller.

### 4.9 Thread (`.thread`, `.day`, `.sys`)
- `.thread`: §2.2; production `div.wy-chat-scroll[data-chat-messages]` (Core renders `.messages` inside). Bottom-aligned
  content and the 34px top fade apply to that scroller; `.thread.top` look for the empty/new conversation and the away
  thread.
- `.day`: `align-self:center; margin:2px 0 14px; padding:3px 10px; border-radius:999px; background: var(--paper)`;
  11.5/1.6/600 `--ink-3`. Production `div.msg-day > span` (labels "Today"/"Yesterday" PD:545-547).
- `.sys`: `display:flex; align-items:center; gap:10px; margin:6px 6px 14px`; 12px `--ink-3`; 1px `--line` rules on both
  sides (`::before`, `::after`, `flex:1`). Used for "Sara closed the conversation" (new system row). Production system
  rows (`div.msg-row.system > .msg-system-pill`, §5.2): suggestion: same `.sys` look.

### 4.10 Message group, bubble, meta
- Group `.g`: `display:flex; align-items:flex-end; gap:8px; max-width:86%` (94% when it holds an order card);
  `margin-bottom:14px`. Column `.s`: `gap:3px`; operator `.L` left, visitor `.R` right (physical, §7). Avatar `s28` at the
  bottom with `margin-bottom:22px` (sits beside the last bubble, above the meta line; also on groups without meta).
- Sender label `.who-l` above the first bubble of an operator group: `margin:0 12px 1px`.
- Bubble `.b`: `width:fit-content; max-width:100%; padding:9px 14px; border-radius:20px; 14.5px/1.5; overflow-wrap:anywhere;
  text-align:start`. Operator: `--bubble` + `--ink`. Visitor: flat `--a` + `--on-a` + shadow §3.4.
- Corners (t2.css:219-222): operator bubbles, cards, files, email cards `20px 20px 20px 6px`; visitor bubbles, images,
  voice `20px 20px 6px 20px`; every item after the first in a group also gets the outer top corner 6px
  (`border-top-left-radius` for `.L`, `border-top-right-radius` for `.R`). Physical in both directions.
- Meta `.meta`: `display:flex; align-items:center; gap:4px; margin:2px 8px 0`; 11/1.5 `--ink-3`: time, then for the
  visitor the double tick `.rd` 16px in `--ink`. Operator meta = time only (11: "Automatic reply").
- Failed `.g.fail`: bubble `opacity:.72`; meta = error icon 14px + "Not sent" (`--bad` 700) + "Try again"
  (`button.retry`: no padding/border/background, 11/700, `--a-ink`, underline, `text-underline-offset:2px`).
- New message `.g.new`: grows from its tail (`t2-msg`, §6), `transform-origin` left bottom (`.L`) / right bottom (`.R`).
- Production mapping (`messagesHtml`, production map §5.1; keep the row contract `.msg-row.(visitor|operator)[.is-last]
  > .msg-col > .msg-line > .msg + .msg-actions` and `.msg-footline > .msg-meta`): one design group = one run of rows.
  Spacing: 3px between rows of a run, 14px after the run (replaces `margin-bottom:-9px` + 12px gap). Corner rule in CSS:
  `.msg-row.operator:not(.is-last) + .msg-row.operator .msg{border-top-left-radius:6px}` (visitor: top-right).
  **Remove** the inline visitor background (PD:665; brief §2.6). **Add** `.who-l` in the first row of an operator run
  (renderer knows the group keys, PD:638-643) and the initials avatar (§4.4). Ticks: `.msg-ticks` single/double/seen →
  draw the `.rd` glyph for delivered and seen in `--ink`; sending/sent colours are not specified (suggestion: `--ink-3`).
  Failed: `span.msg-ticks.is-failed` gets the error icon + "Not sent" look, `button.msg-retry-btn[data-msg-retry]` the
  "Try again" look. Message actions, quotes, links, AI badge: not drawn; keep production behaviour (suggestion: icons
  `--ink-3`, links styled like article links §4.24).

### 4.11 Typing indicator (`.typing`)
Inside an operator group (`.g.L.new > .av.s28 + .s > .typing`): `display:flex; align-items:center; gap:4px; height:38px;
padding:0 15px; border-radius:20px; border-bottom-left-radius:6px; background: var(--bubble)`; three 7px `--ink-3` dots,
`t2-wave 1.2s ease-in-out infinite`, delays 0 / .15s / .3s. Production: **new visible row** (production shows typing to
screen readers only, `[data-typing-row]`, §5.6). Suggested markup `div.msg-row.operator.is-last.typing-row[aria-hidden=true] >
avatar + div.msg.operator.typing-bubble > span.typing-dots (3 spans)`, rendered last when Core reports operator typing
(`setOperatorTyping`, passed to the renderer as `view.operatorTyping {name, avatar}`); keep the sr-only `[data-typing-row]`. The AI thinking row (`.ai-thinking-row`) uses the same look
(suggestion).

### 4.12 Reaction (`.react`, new)
On a bubble with `.rel` (`position:relative; margin-bottom:10px`): `position:absolute; bottom:-10px;
inset-inline-end:10px; display:flex; align-items:center; gap:3px; height:22px; padding:0 7px; border-radius:999px;
background:#fff`; shadow §3.4; 11/700 `--ink-2`; heart 12px `#E5484D`; count "1". Pop-in `t2-pop .5s var(--bounce)
.6s`. Display only. Needs server + Core reactions; hide otherwise.

### 4.13 Order card (`.card`, new, commerce)
- `.card`: `width:296px; max-width:100%; overflow:hidden; background:#fff`; ring + shadow §3.4; corners per §4.10.
- Header `.ch1`: `display:flex; align-items:center; gap:12px; padding:12px 14px`; thumb `.th` 46 × 46 radius 14, gradient
  `#F1F0F6 → #E4E3EC` (140deg), shoe icon 26px `--ink` (product image when available, suggestion); `.tt` title "Order
  48213" + sub "Running shoes, size 42"; status `.pill` (§4.27 values, Respok `#FFEAE4`/`#A62A12`): "Shipped".
- Progress `.steps`: `display:flex; justify-content:space-between; margin:2px 18px 0; padding-top:12px`. Track
  `::before` and fill `::after`: `top:17px; inset-inline:28px; height:3px; border-radius:2px`; track `--line`; fill
  `--a`, `width: calc((100% - 56px) * .6667)` from the inline start (`t2-fill`). Each step `span` 56 wide, column,
  `gap:7px`, label 11/1.3/600 `--ink-3` (done/current `--ink`), dot `i` 13 × 13: future = `#fff` + `inset 0 0 0 3px
  var(--line-2)`; done `.ok` = `--a` fill + `0 0 0 3px #fff`; current `.now` = `#fff` + `inset 0 0 0 4px var(--a), 0 0 0
  4px var(--a-3)` pulsing (`t2-now`). Steps: Placed, Packed, Shipped, Delivered. Production: fill width =
  `(100% − 56px) × index / (count − 1)` (board: index 2 of 0–3 = .6667).
- Footer `.cf`: `display:flex; align-items:center; gap:8px; margin-top:12px; padding:10px 14px; border-top:1px solid
  var(--line)`; truck 18px; "Arrives **Thursday**" (`b` `--ink` 700); button `.go` "Track package"
  (`margin-inline-start:auto`; 32 tall, `padding:0 12px`, radius 10, Respok `--ink` / `#fff`, 12.5/700).
- Production: new message kind from commerce data (the loader has a store context, `data-commerce-*`); render the card
  inside `div.msg.operator` with no bubble padding/background; `.go` = link to the carrier tracking URL. Hide when no
  store context.

### 4.14 Image attachment (`.img`)
224 × 168, `overflow:hidden`, corners per §4.10 (visitor: `20 20 6 20`). Board fill (peach gradient + 64px shoe) is the
demo photo. Sheen `::after` (`linear-gradient(110deg, transparent 30%, rgba(255,255,255,.35) 50%, transparent 70%)`,
`t2-sheen 2.8s ease-in-out .8s infinite`). Caption `.cap`: `position:absolute; bottom:8px; inset-inline-start:8px;
height:24px; padding:0 9px; gap:6px; border-radius:999px; background: rgba(10,12,16,.45); backdrop-filter:blur(6px)`;
11px `#fff`; image icon 13px + file name. Production: `div.msg-att.msg-att-image > button.msg-att-img-btn.is-loading
[data-att-preview]` (keep hooks, loading text and fallback); photo `object-fit:cover`. Suggestion: run the sheen only while
`.is-loading`. Caption with file name: new (attachment name).

### 4.15 File attachment (`.file`)
250 wide, `display:flex; align-items:center; gap:12px; padding:10px 12px; background: var(--bubble)`; corners per §4.10.
Type tile `.ft` 40 × 46, radius 9, `#fff`, ring `--line`, label "PDF" 10/800 `#D33A43` (file extension, upper case).
`.fx` name (ellipsis) + size ("240 KB", production `humanSize`). Download `.ring`: 34px circle `#fff`, ring `--line`,
download icon 16px `--a-ink`, `border:0; padding:0` (D2); progress arc `svg.arc` 34px rotated −90°, circle r 15, stroke
`--a` 2.5 round, `stroke-dasharray:94`, `stroke-dashoffset` = 94 × (1 − progress) (board animates 94 → 24). Production:
`div.msg-att.msg-att-file > div.msg-att-icon + div.msg-att-meta + a.msg-att-action[data-att-download]` → tile, meta, ring.
Download progress: new (Core); without it show the ring with no arc.

### 4.16 Voice message (`.voice`)
244 wide, `display:flex; align-items:center; gap:10px; padding:8px 14px 8px 8px` (RTL `8px 8px 8px 14px`), flat `--a`,
`--on-a`; corners per §4.10. Play/pause `.pb` 34px circle `rgba(255,255,255,.22)`, white 15px glyph (board: pause).
Wave `.wave`: `display:flex; align-items:center; gap:2px; flex:1; height:28px; direction:ltr`; 24 bars (`flex:1;
max-width:3px; min-height:4px; border-radius:2px`), played `rgba(255,255,255,.95)`, unplayed `.d` `.42`; heights (board):
8 10 10 6 20 22 12 16 18 · 8 14 7 16 20 10 14 18 6 12 12 12 8 9 24; while playing the played bars animate (`t2-bar`).
Time `.tm` 11.5px tabular, opacity .9. Production `div.msg-att.msg-att-audio[data-audio-player][dir=ltr]`: play button
`button.wy-ap-play[data-audio-toggle]` (label = play or pause per state, D5), bars inside
`div.wy-ap-track[data-audio-seek]` with the played part driven by `[data-audio-progress]` width, time
`[data-audio-time]`. Rate `[data-audio-rate]` and download `a.wy-ap-dl` are not drawn: keep the nodes, suggestion: hide
them. Waveform data does not exist in production; suggestion: a fixed 24-bar pattern (decorative, `aria-hidden`).

### 4.17 Quick topics in the thread (`.qr`)
`display:flex; flex-wrap:wrap; gap:8px; max-width:92%; margin:0 0 6px`, aligned to the visitor side (LTR
`align-self:flex-end; justify-content:flex-end`). Chips §4.6 (36px). Entrance stagger §6. Production: Q&A chips
`div.qna-suggestions[data-qna] > div.qna-chips > button.qna-chip[data-qna-question]` (§5.12); `.qna-title` and the
"+N" more button are not drawn (suggestion: hide the title, keep "more" styled as a chip). Icons per topic: new
(suggested topic setting `{label, icon}`; fallback the two-bubbles icon).

### 4.18 Welcome block (`.welc`, new conversation)
`display:flex; flex-direction:column; align-items:center; gap:6px; margin:6px 10px 16px; text-align:center`; team stack
40px avatars (15px, ring `0 0 0 3px #fff`); `h3` "The Nilufar Store team" (`margin:4px 0 0`); `p` (`gap:7px`) 8px
`--live` dot + "We’re online". Then the welcome bubble (operator group) and the topics. Production: `emptyHtml()`
(welcome bubble from `welcomeMessage` or `t('intro')`); the header block is new. With `aiAgent.suppressGreeting` keep
the block, drop the bubble (suggestion).

### 4.19 Composer (`.cmp`, `.box`, `.tools`, `.act`)
- `.cmp`: `position:relative; z-index:2; flex:none; padding:6px 12px 0`.
- `.box`: `display:flex; flex-direction:column; gap:2px; padding:12px 8px 6px; border-radius:22px; background:#fff`;
  ring/shadow §3.4; focused `.fo` Signal ring (§3.4); `transition: box-shadow .22s ease`. Height 86 with one line.
- Text `.in`: `min-height:26px; padding:0 10px; 14.5px/26px; --ink`; placeholder `--ink-4`; typing caret (`.ty::after`
  1.5 × 17, radius 1, `#FF5A3C`, `vertical-align:-3px`, blinking).
- Tools row `.tools` (`display:flex; align-items:center; gap:2px`): emoji `.ib`, attach `.ib` (36 × 36, radius 11,
  `--ink-3`, icons 20px stroke 1.8), spacer, action `.act`.
- `.act`: 40px circle, `--paper` / `--ink`, mic icon ("Record a voice message"); with text it becomes send `.act.on`:
  flat `--a`, `--on-a` arrow, shadow §3.4, pop-in `t2-pop .45s var(--bounce)`; active `scale(.9)`; transitions
  `transform .25s var(--bounce), background-color .2s ease`.
- Production mapping (keep the fixed control set and DOM order, production map §8.1): `.box` = `div.input-wrap
  [data-input-wrap]`; focus ring on `:focus-within`; `.in` = `textarea.input[data-msg-input]` (Core sets the height; max
  not specified, keep production's 15rem); layout `div.input-row[data-input-row]` as a grid: row 1 = textarea across;
  row 2 = emoji, attach, spacer, action cell. Place `.composer-actions` / `.composer-actions-start` with
  `display:contents`. `button.mic-btn[data-mic-btn]` (still the first child) and `button.send-btn[data-send-btn]` share the
  action cell: no draft → mic visible (`.act`), send hidden; `.input-bar.has-draft` → send visible (`.act.on`), mic
  hidden. Without voice notes (no mic) show send in the `.act` look when empty and `.act.on` with a draft (suggestion).
  `button.attach-btn[data-attach-btn]` (+ hidden file input) and `button.emoji-btn[data-emoji-btn]` get the tool look;
  emoji open state `[aria-expanded=true]` not drawn (suggestion: `--paper` background).
- Not drawn (keep production markup and hooks, restyle with these tokens, suggestion: white card, `--line` ring, radius
  20, 6px padding like `.tray`): emoji picker `[data-emoji-picker]`, reply preview `[data-reply-preview]`, attachment
  preview `[data-attach-preview]` (inside `.input-wrap`, above the row), jump-to-latest `[data-chat-jump]`.
- Placeholder copy: "Write a message…" (11: "Add anything else…").

### 4.20 Recorder (`.rec`)
Replaces the box while recording: `display:flex; align-items:center; gap:8px; height:52px; padding:0 6px 0 8px;
border-radius:22px; background:#fff; box-shadow: 0 0 0 1.5px #FFBAAA, 0 0 0 6px #FFF0EC` (mixes of `--rec`). Children:
delete `.ib` (38px, trash 20px, `--ink-2`, "Delete recording"); dot `.dot` 10px `--rec`, `margin-inline-start:6px`,
blinking; time `.tm` "0:08"; wave `.wave` (height 24, 24 bars `#FF927B`, animated; heights 8 24 12 6 10 7 18 22 10 18 9 12
18 20 14 16 20 10 16 8 12 14 16 8); `.stop` 40px circle `--rec`, `#fff` arrow ("Send voice message"). `.hint`
(11.5/1.5 `--ink-3`, centred, `margin:6px 6px 0`) is defined but unused.
Production: `.input-bar.is-recording` → style `.input-wrap` as the `.rec` pill; `div.rec-bar[data-rec-bar]` children map
in order: `button.rec-cancel[data-rec-cancel]` → delete, `span.rec-live > span.rec-dot + span.rec-time[data-rec-timer]`
→ dot + time, `span.rec-wave` (10 `i` today; render 24) → wave, `button.rec-confirm[data-rec-stop]` → `.stop`.
Behaviour difference: production's confirm stops and opens the preview (`[data-vn-bar]`), the design labels it "Send
voice message" with the send arrow. Keep the production flow; the preview bar is not drawn (suggestion: same 52px pill:
delete `.ib`, 34px play button in `--paper`, bars, time, `.act.on` send).

### 4.21 Instant answers tray (`.tray`, new)
Between thread and composer: `position:relative; z-index:2; margin:0 12px 8px; padding:6px; border-radius:20px;
background:#fff`; shadow §3.4; rise-in `t2-rise .5s var(--ease)`. Heading `h4` (`display:flex; gap:7px; margin:4px 8px
6px`) sparkle 16px `#FF5A3C` + "Answers from the help center". Rows `a` (`display:flex; align-items:center; gap:10px;
padding:8px; border-radius:14px`, hover `--paper`): tile `.it` 32 × 32 radius 10 `--paper`, book 18px `--ink`; title `.tt`
(ellipsis) with `mark` highlights (`padding:0 1px; border-radius:3px; background:#FFE1D9; color:inherit`); `small` "2 min
read"; chevron `.ch` `--ink-4`. Up to 2 rows drawn. Production: new container in `[data-composer-zone]` before the input
bar (suggested `div.tray[data-kb-suggest][hidden]`); rows `button[data-kb-action="open"][data-kb-slug]`. Needs KB search
as the visitor types (debounced draft), matched words. Hidden when there are no matches or KB is disabled.

### 4.22 Search field, count, results (help)
- `.sfield`: `display:flex; align-items:center; gap:10px; height:50px; margin:14px 14px 0; padding:0 8px 0 14px` (RTL
  `0 14px 0 8px`); radius 16; `#fff`; drawn focused: `0 0 0 2px #FF5A3C, 0 0 0 6px rgba(255,90,60,.12)`; search icon
  20px `--ink-3`; query `.q` 15px `--ink` with Signal caret; clear `.x` 28px circle `--paper-2`, X 14px `--ink-3`.
  Unfocused/empty state not drawn (suggestion: `0 0 0 1px var(--line-2)` ring like the composer, placeholder
  `--ink-4`).
- `.cnt` "3 articles found": `margin:14px 22px 6px`.
- `.res` (`margin:0 10px`): rows `a` `display:flex; align-items:flex-start; gap:12px; padding:11px 12px; border-radius:16px`,
  hover `--paper`; tile `.it` 34px radius 11 `margin-top:1px` `--paper` / `--ink`, book 18px; `.tt` title and `small`
  excerpt (2-line clamp), both with `mark`. Entrance stagger §6.
- Production: compose the existing `kbSearchBarHtml` (PD:1345) into `kbHtml` as an `input[type=search]` (suggested hook
  `data-kb-search`; clear `data-kb-search-clear`); results rows = `button.kb-article[data-kb-action=open][data-kb-slug]`
  with the new title highlight + excerpt; `searching` state keeps skeleton rows (`.sk` look, §4.28). Empty results not
  drawn: keep `kbEmptyHtml` restyled (suggestion).

### 4.23 Categories (`.sec`, `.cats`, `.cat`, new)
`.sec` "Or start from a topic" (`margin:18px 22px 10px`). `.cats`: `display:grid; grid-template-columns:1fr 1fr; gap:10px;
margin:0 14px`. `.cat`: `display:flex; align-items:center; gap:12px; padding:12px; border-radius:18px; background:
var(--paper)`; hover `--paper-2` + `translateY(-2px)` (`.25s var(--ease)`); tile `.it` 36px radius 11 `#fff` ring
`--line` icon 18px `--ink`; `b` name, `small` "5 articles". Production: `vm.categories` (ignored today, PD:1387); suggested
hook `data-kb-category="<id>"`.

### 4.24 Article (`.art`)
`flex:1; min-height:0; padding:20px 22px 0`; bottom fade (t2.css:544). `h1`; meta `.am` (`display:flex;
align-items:center; gap:14px; margin:12px 0 16px`; items `gap:6px`): author `av.s24` + name, clock 15px + "2 min read"
(D1: centre the initial). Body: `p` (`margin:0 0 14px`, `--ink-2`), links (`--a-ink`, 600, underline in `--a-3`, offset
3px), `h2` (`margin:4px 0 10px`), ordered steps `.ol` (`gap:10px; margin:0 0 14px; list-style:none`; `li` flex gap 10;
number tile 24 × 24 radius 8 `--paper-2` / `--ink`), callout `.tip` (`display:flex; gap:10px; padding:12px 14px;
border-radius:16px`, colours §3.8, info icon 18px). Production: `div.kb-article-view > div.kb-article-body`
(`contentHtml`, CMS HTML): style `h1, p, a, h2, ol > li` (number tiles via a CSS counter on `li::before`); callout: no
CMS element exists (suggestion: style `blockquote` or a `.tip` class if the editor emits one). Header title = category
name; the article title moves into the body `h1`. Author and reading time: new article fields.

### 4.25 Article feedback (`.fb`, `.face`)
`display:flex; align-items:center; gap:8px; margin:0 14px; padding:12px 8px; border-top:1px solid var(--line)`;
"Did this help?" + spacer + three `.face` (38 × 38, radius 12, `--paper`, `--ink-3`, icons 22px): No (frown),
Somewhat (neutral), Yes (big smile). Hover `translateY(-2px) scale(1.08)`, `--a-2` / `--a-ink`, `.3s var(--bounce)`.
Selected state not drawn (suggestion: the CSAT `.on` look §4.32, `aria-pressed=true`). Production:
`div.kb-feedback[data-kb-feedback]`, faces = `button.kb-rate[data-kb-rate][aria-pressed]`: No → `down`, Yes → `up`,
Somewhat → new value (suggested `neutral`, needs server; without it render two faces). Thanks text and the post-"down"
CTA: replaced by the always-visible CTA §4.26.

### 4.26 "Still need help?" CTA (`.cta`)
`display:flex; align-items:center; gap:12px; margin:0 14px 4px; padding:12px 14px; border-radius:20px; background:
var(--ink); color:#fff`; shadow §3.4; team stack 28px (ring `rgba(255,255,255,.9)`); `.tx` title + `small`; go circle
36px `rgba(255,255,255,.16)` with white chevron; hover moves the chevron `translateX(3px)` (`.25s var(--ease)`). Always
Ink in Respok, whatever the accent. Production: `a.cta[data-kb-action="switch-chat"]` (exists), shown unless
`vm.hideChatCta`.

### 4.27 Conversation rows and pills (`.inbox`, `.ci`, `.pill`)
`.inbox`: `display:flex; flex-direction:column; flex:1; min-height:0; padding:8px 10px` (scrolls in production).
`.ci`: `display:flex; align-items:flex-start; gap:12px; padding:12px; border-radius:18px`, hover `--paper`; avatar
`s44` (+ `.pr` when the agent is online); `.tx` column gap 2: `.l1` name + `time` (`margin-inline-start:auto`); `.l2`
preview `em` (ellipsis; unread `.u` = `--ink` 600) + `.nb`; `.pl` (`margin-top:4px`) status pill. `.pill`:
`display:inline-flex; align-items:center; gap:5px; height:22px; padding:0 9px; border-radius:999px`; Open (Respok)
`#FFEAE4` / `#A62A12`; Resolved `.pill.done` `--paper-2` / `--ink-3`. Production: `button.conv-row[data-conversation-open]`
(`conversationRowHtml`, PD:1146-1173) → `.ci` layout; name/avatar = assigned agent (new; fallback workspace name and logo,
as today); preview gets "You: " when the last message is the visitor's (new); status labels `wyStatusOpen` /
`wyStatusResolved`.

### 4.28 Skeleton (`.sk`)
Row: `display:flex; align-items:center; gap:12px; padding:12px`; 44px circle, two bars 45% × 12 and 80% × 10 (column gap 8),
radius 8; shimmer `linear-gradient(90deg, var(--paper) 0%, var(--paper-2) 40%, var(--paper) 80%)`, `background-size:200%
100%`, `t2-shim 1.4s linear infinite` (reversed in RTL). The second row at `opacity:.55`. `aria-label="Loading older
conversations"`. Production: `skeletonConvRowsHtml` (list loading) and all T2 skeletons use these primitives; skeleton
parity ([brief §2.7](../../CLAUDE_CODE_BRIEF.md)): 68px bar, same paddings, 86px composer box, hero height on home.
Loading older items (pagination) is new.

### 4.29 Floating new-conversation button (`.fab`)
`position:absolute; bottom:52px; left:50%; transform:translateX(-50%); z-index:4; display:inline-flex; align-items:center;
gap:8px; height:48px; padding:0 20px; border-radius:999px`; flat `--a`, `--on-a`, 14/700, plus icon 20px; shadow §3.4;
entrance `t2-fab .6s var(--spring) .5s`. Production: the header `button.wy-fab[data-home-action=chat]` moves here and
gains the visible label "New conversation" (keep its hook and `aria-label`).

### 4.30 Email card (`.fcard`, `.fcard.done`)
- Ask: `width:270px; padding:12px; background:#fff`; ring/shadow §3.4; operator corners (§4.10). `label` "Email"
  (`margin:0 4px 6px`). Field `.fi`: `display:flex; align-items:center; gap:6px; height:46px; padding-inline:12px 5px;
  border-radius:14px; background:#fff; direction:ltr`, drawn focused with the Signal ring `0 0 0 2px #FF5A3C, 0 0 0 5px
  rgba(255,90,60,.12)`; placeholder "name@example.com" `--ink-4` (value `.v` `--ink`); OK `.ok` 36 × 36 radius 11 flat
  `--a`, `--on-a` check 18px ("Save email"). Skip `.skip` "No thanks, I’ll wait here" (`margin:10px 4px 0`, no button
  chrome).
- Saved `.fcard.done`: `display:flex; align-items:center; gap:10px`; 13/1.55 `--ink-2`; check circle `.ck` 30px
  `#FFEAE4` / `#A62A12` (pop `.5s var(--bounce) .5s`); email in `b` (`--ink`, `direction:ltr; unicode-bidi:isolate`).
- Production: `handoffPrechatCardHtml` (§4.7): keep `div.hc-card[role=group][aria-label]`, fields
  `input.prechat-input[data-prechat=email]` with its label/error IDs (`prechat-email`, `prechat-err-email`) and
  `button.hc-submit[data-prechat-submit]` (styled as the 36px `.ok` inside the field, text visually hidden, `aria-label`
  "Save email"). Present it on the operator side (left) inside the agent's group. The two prompts above it are operator
  bubbles: map `.hc-subtitle` (Core text, typewriter host) to "Got it, the team has your question and usually replies
  within minutes." and `.hc-title` to "If you leave the site, where should we send the reply?" (visual order: subtitle
  first; suggestion). Errors (`.prechat-error[role=alert]`, `aria-invalid`) not drawn (suggestion: 12px `--bad` under the
  field, field ring `--bad`). When name or phone are also asked: not drawn (suggestion: stacked `.fi` fields and a
  full-width `.csat .btn` submit). Skip: new (suggested `data-prechat-skip`). The saved card: new Core state.
- The full-screen pre-chat view (`prechatFormHtml`, production map §4.5) is not drawn in T2; keep it with its hooks (Core
  may still route to it), restyled with the `.fi` field look and a `.csat .btn` submit (suggestion).

### 4.31 Away banner (`.away`)
`display:flex; align-items:center; gap:12px; margin:0 0 16px; padding:12px 14px; border-radius:18px; background:
var(--paper)`; tile `.it` 36px radius 12 `#fff` ring `--line`, moon 18px `--ink-2`; title "We’re away right now" + `small`
"Back at 9 AM, usually reply within 2 hours". First item of a `.thread.top`. Needs availability, next opening time and
reply time (§9).

### 4.32 Rating card (`.csat`, new)
`align-self:stretch; margin:2px 4px 6px; padding:18px 16px 16px; border-radius:22px; background:#fff; text-align:center`;
ring/shadow §3.4; rise-in `.55s var(--ease) .3s`. Agent avatar `s44` centred; `h3` "How was your chat with Sara?"
(`margin:8px 0 2px`); `p` "Your answer helps the team get better."; `.faces` (`display:flex; justify-content:center;
gap:8px; margin:14px 0`): five 46 × 46 buttons radius 15 `--paper` `--ink-3` icons 26px: Very bad, Bad, Okay, Good, Great;
hover `translateY(-3px) scale(1.08)` (`.3s var(--bounce)`); selected `.on[aria-pressed=true]`: `#FFEAE4` / `#A62A12` +
`inset 0 0 0 2px #FF5A3C`, pop `t2-pick .7s var(--bounce) .9s`. Comment `.ta` (64 tall, `padding:10px 12px`, radius 14,
`--paper`, placeholder "Tell us more (optional)" `--ink-4`, start-aligned) → production `textarea`. Button `.btn` "Send
feedback" (100% × 46, `margin-top:10px`, radius 14, flat `--a`, `--on-a`). Link `.lnk2` mail 16px + "Email me the
transcript" (`margin-top:10px; gap:6px`). The closed thread has **no composer** (screen 12). Production: new (no rating UI
or API, production map §5.13); suggested hooks `data-csat-rate="1…5"`, `data-csat-comment`, `data-csat-submit`,
`data-csat-transcript`. Hide when the API is missing.

### 4.33 Footer "Powered by" (`.pw`) and logo direction
`display:flex; align-items:center; justify-content:center; gap:6px; flex:none; height:40px; margin-top:auto; 11.5px;
--ink-3`; "Powered by" + lockup box 53 × 13 (Thread) / 50 × 13 (Open), drawn in `--ink` (`currentColor`) with the Signal
piece `#FF5A3C`, `role=img aria-label="Respok"`; the artwork fits the box (Thread 53 × 12.1, Open 50 × 12.3). Production
`div.wy-footer > span.wy-conn[data-conn-indicator] + a.wy-powered` (keep link attributes, keep the conn indicator as a
sibling; not drawn: suggestion zero width while `data-conn-state=online`). Draw the lockup inline (board SVG or
[`respok-lockup-thread.svg`](../../shared/brand/respok/respok-lockup-thread.svg) /
[`respok-lockup-open.svg`](../../shared/brand/respok/respok-lockup-open.svg)): as an `<img>` their `currentColor` parts
would paint black, not Ink. Keep `img.wy-powered-logo[data-wy-brand-logo]` for a non-Respok `poweredBy.logo`.
**Logo direction** (setting `logoDirection: "thread" | "open"`, default `thread`, [brief §5.6](../../CLAUDE_CODE_BRIEF.md)):
class `lg-thread` / `lg-open` on `.shell` (so the launcher and the panel agree); elements `.g-t` (Thread) / `.g-o` (Open); it switches the hero
watermark, the footer lockup and the launcher glyph.

### 4.34 Launcher (`.kl`, RESPOK kit)
60 × 60 circle, `border:0; padding:0; background: var(--a); color: var(--kon)`; shadow and hover §3.4 / §6 (same values
as production `.rpk-kit-brand`, production map §3.3); active `scale(.94)`. Production's extra active details (.09s, shadow
`0 5px 14px rgba(22,20,43,.24)`) have no board equivalent: keep them. The board keeps the Ink-based shadows for every
accent, while production's non-brand launcher uses `--gs-shadow`: keep that. Glyph: Thread `svg.kg.g-t` 50% wide (`viewBox 0 0 104 92`,
30 × 26.5, identical paths to production `RESPOK_KIT_CHAT_GLYPH`): question pill `.m` fill `--kon`, answer pill `.ac` fill
`--kac`; Open `svg.kg.g-o` 47% wide (`viewBox 0 0 108 108`): bubble `.m` + dot `.ac` (circle r 12 at 96,96). Badge
`.bdg`: `position:absolute; top:-5px; inset-inline-end:-5px; min-width:22px; height:22px; padding:0 6px; border-radius:11px;
background:#D3361A; color:#fff; 12px/22px/800; text-align:center; box-shadow: 0 0 0 2.5px #fff`; hidden `scale(0)`. On a new
unread: badge springs in, the Thread answer pill slides in (`t2-pill`, same keyframes as production `rpk-kit-answer`,
which production plays through `.rpk-kit-arrive` when the count rises while closed), the Open dot pops (`t2-dotpop`), §6. Production changes: badge offset −3 → −5, 2px border → 2.5px outer ring, weight 700
→ 800, timings §6; launcher icon colour = `--gs-on-primary` when `fab.iconColor` is not set; non-brand `--rpk-kit-accent`
= `--gs-on-primary`; add the Open glyph for `logoDirection: open`; select the kit by edition only (brief §3). Keep the
kit's focus ring (`0 0 0 3px #fff, 0 0 0 6px #FF5A3C`), close chevron and away state. Placement in the board:
`bottom:20px; right:20px` of the page (production keeps 24px offsets).

### 4.35 Greeting bubble (`.greet`)
`position:absolute; bottom:96px; right:20px` (16px above the launcher), `width:280px; z-index:4; display:flex;
align-items:flex-start; border-radius:21px 21px 4px 21px` (the 4px tail points at the launcher; mirror to `21px 21px
21px 4px` for `bottom-left`), `#fff`, shadow §3.4, `transform-origin:100% 100%`; `role=status`. Message button `.gm`
(`flex:1; gap:10px; padding:14px 4px 14px 14px`, RTL `14px 14px 14px 4px`, transparent, start-aligned, `--ink`): avatar
`s30` + text column (`gap:2px`): name line "Sara from Nilufar Store" + `small` message. Dismiss `.gx` 40 × 40 transparent,
X 15px `--ink-3`, "Dismiss message". Measured 280 × 90. Production: the smart-engagement launcher nudge
(`div.smart-nudge`, production map §5.11): `.smart-title` → name line, `.smart-body` → message, `button.smart-dismiss
[data-smart-dismiss]` → `.gx` (inside the bubble at the top end instead of outside), `button.smart-cta[data-smart-cta]` →
the whole `.gm` (no separate CTA pill); drop the accent hairline and the rotated-square tail; avatar new. Position
`bottom: calc(var(--gs-fab-size) + 16px)`, aligned to the launcher's outer edge. In the prototype, clicking the greeting
opens straight into the chat and the greeting text is the agent's first message there.

### 4.36 Focus ring
`:is(button, a, [role=textbox]):focus-visible{outline:2px solid #FF5A3C; outline-offset:2px}`; on the hero white (D4).
Field focus is drawn as rings, not outlines: composer `.box.fo`, search `.sfield`, email `.fi` (Signal 2px + halo).
Production: keep Core's suppression of the outline inside wrapped inputs (RT:42-62) and use `:focus-within` for those
rings.

---

## 5. Screens

### 5.1 Screen 01 · Home, first visit ([png](screens/panels/01-home--01-first-visit.png))
- **Purpose:** first open; ask a question, pick a topic, or go to help / order tracking.
- **Layout:** §2.2 home. Hero: logo "N" + close; "Hi there 👋"; "How can we / help you today?"; presence: avatars S M R +
  Signal dot + "Online now, usually replies in 2 minutes". Ask card: rotating placeholder ("Ask us anything…",
  "e.g. When will my order arrive?", "e.g. Is size 42 in stock?") + send; chips Delivery, Returns, Sizing. Rows: Help center
  ("24 articles on orders, delivery and returns"), Track an order ("See its status with your order number"). Footer.
- **Data:** workspace logo/name (`config.logoUrl`, `workspaceName`); online team (`vm.teamMembers`), `vm.isOnline`, reply
  time (`replyTimeText`); placeholder examples and topics (new settings, §9); KB article count and categories (`vm.articles`
  / categories); commerce availability.
- **Interactions:** typing + Enter/send → new conversation with the draft (§4.5); chip → new conversation with the topic;
  Help center → `data-view="help"`; Track an order → not specified (suggestion: start a conversation with "Track my order");
  close → `data-panel-close`. Hover/press per §4. Cascade on open (§6).
- **Production:** replace `homeHtml` output (PD:1176-1287) in the `simple` renderer: hero + ask card + rows + footer.
  Hooks kept: `data-view`, `data-home-action="chat"`, `data-conversation-open`, `data-home-action="conversations-retry"`
  (error state not drawn; suggestion: a row whose subtitle is the error text and whose action retries). Not drawn on the
  T2 home: greeting block, article chips `button.home-chip[data-home-article]`, compact recent rows, CTA buttons (their
  actions move to the ask card and rows). Hook contract ([brief §2.1](../../CLAUDE_CODE_BRIEF.md), hook diff in brief §10):
  keep `data-home-article` emitted (suggestion: the suggested-article buttons in a `hidden` group) unless Core is
  confirmed not to need it. Row
  visibility: Help center when `kbEnabled`; Track an order when a store context exists. `vm.smartSurface` home card: not
  drawn (suggestion: render it between the ask card and the rows with the `.list` card look).

### 5.2 Screen 02 · Home, returning visitor ([png](screens/panels/01-home--02-returning-visitor.png))
Same as 01 except: greeting "Welcome back, Ali 👋" (visitor name from `identify()`/contact; without a name use "Hi there
👋"); rows: **Continue with Sara** (avatar `s40` + online dot; preview "You’re welcome! Anything else I can help with?" in
the unread style; end column "10 min ago" + badge "2") → `data-conversation-open="<id>"` of the latest unresolved
conversation (production `unresolved`, PD:1184); **Your conversations** ("3 conversations, 1 open") → `data-view="list"`;
Help center. List height 200. No Track an order row in this state: the rule is not stated (suggestion: show it only
when there is no Continue row, as in 01/02/03).

### 5.3 Screen 03 · Home, team away ([png](screens/panels/01-home--03-team-away.png))
Differences: headline "Leave us / a message"; `.pres.off` with "Away right now, back at 9 AM"; field `.static` with
"Write your message…" (no rotation, no caret); no chips; `.note` "We’ll email you the reply in the morning"; rows: Help
center ("Most answers are here, any time"), Track an order. Ask card 112.8 tall, rows at 388.9. Sending starts the away
conversation (screen 11). Production: offline home (`vm.isOnline` false; today `homeReplySlow` + `homeLeaveMessage`).

### 5.4 Screen 04 · Live chat ([png](screens/panels/02-conversation--04-live-chat.png))
- Bar: back, agent "Sara" (`s40` + `.pr`), status "typing" + dots, More options, close.
- Thread (bottom-aligned, top fade, overflowing content clipped under the fade): "Today"; visitor bubble + "7:42 PM" + read ticks;
  operator group "Sara": bubble + order card (Order 48213, Running shoes, size 42, Shipped; steps Placed, Packed,
  Shipped (current), Delivered; "Arrives Thursday"; "Track package") + "7:44 PM"; visitor "Great, thanks!" "7:46 PM" + read ticks;
  operator typing row (`.g.L.new`).
- Composer: "Write a message…", emoji, attach, mic `.act`.
- Production: `chatFrameHtml` + `messagesHtml` (§4.10); visible typing (§4.11, new); order card (§4.13, new);
  header agent identity (§4.8, new).

### 5.5 Screen 05 · Photos, files and voice ([png](screens/panels/02-conversation--05-photos-files-and-voice.png))
Bar status online dot + "Online". Thread: visitor image (caption "IMG_2041.jpg") "8:04 PM" + read ticks; operator "Sara": file
"Invoice-48213.pdf" "240 KB" with the download ring (74% arc), bubble "Here’s the invoice for your order." with a heart reaction
"1", "8:06 PM"; visitor voice bubble (playing, "0:14") "8:07 PM" + read ticks; failed visitor bubble "New address: 12 Hill Road" with
"Not sent" + "Try again". Composer in recording mode (§4.20, "0:08"). Production: §4.14–4.16, §4.20, failed send §4.10,
reaction §4.12.

### 5.6 Screen 06 · New conversation ([png](screens/panels/02-conversation--06-new-conversation.png))
Bar: back, team stack (28px S M R), "New conversation", "Usually replies in 2 minutes", close (no More options).
`.thread.top`: welcome block (§4.18), welcome bubble "Hi! Type your question, or pick a topic to get started.", topics
Track my order, Help me choose, Returns and refunds, Something else (§4.17). Tray (§4.21) for the draft "return shoes":
"Return conditions" (2 min read), "How long does a refund take after a return?" (1 min read), matches highlighted.
Composer focused (`.fo`), typed text with Signal caret, send `.act.on`. Production: `emptyHtml()` + Q&A chips + tray (new)
+ composer `has-draft` state.

### 5.7 Screen 07 · Help search ([png](screens/panels/03-help-and-conversations--07-help-search.png))
Bar: back, "Help center", close. Search field (focused, "delivery", clear). "3 articles found". Results: "Delivery times
and costs" / "Free delivery on orders over $50; most parcels arrive in 2 to 3 days…"; "Tracking a parcel after delivery
starts" / "We text you a tracking code; you can also follow it from your account…"; "Delivery outside the city" / "Orders
outside the city arrive by courier in 3 to 5 days…". "Or start from a topic"; categories Orders and delivery (5 articles),
Payments (4), Returns (3), Your account (6). Production: `kbHtml` `results` state (+ search bar, categories new). The `list`
state (no query) is not drawn (suggestion: search field unfocused, then categories, then the article list as `.res` rows).

### 5.8 Screen 08 · Article ([png](screens/panels/03-help-and-conversations--08-article.png))
Bar: back (`data-view-back="back"`), category "Orders and delivery", close, reading progress line. Article: "How do I track
my order?"; meta Sara · 2 min read; paragraph with link "Your account, Orders"; "Where is my tracking code?"; steps 1–3;
tip "Tracking can take up to 24 hours to show the first update.". Feedback row "Did this help?" + 3 faces. CTA "Still need
help?" / "Chat with the team, usually replies in 2 minutes". Production: `kbHtml` `article` state (§4.24–4.26).

### 5.9 Screen 09 · Your conversations ([png](screens/panels/03-help-and-conversations--09-your-conversations.png))
Bar: back, "Your conversations", close. Rows: Sara (online, "10 min ago", unread "2", Open), Mehdi ("Yesterday", "Your
refund is on its way to your card.", Resolved), Reza ("5 days ago", "You: Thanks for the quick help!", Resolved); two
skeleton rows (loading older); floating "New conversation". Production: `conversationListHtml` (§4.27–4.29); error state
(`wy-conv-error` + retry) and empty state ("No conversations yet") not drawn (suggestion: centred 13px `--ink-3` text,
retry as a `.chip`).

### 5.10 Screen 10 · Asking for an email ([png](screens/panels/04-details-and-feedback--10-asking-for-an-email.png))
Thread: "Today"; visitor "Hi, do you offer discounts on bulk orders?" "7:42 PM" + read ticks; operator group (Sara, `.new`): two
bubbles + email card (§4.30) + "7:44 PM". Composer idle. Production: handoff card (§4.7) restyled and moved to the
operator side.

### 5.11 Screen 11 · Message while away ([png](screens/panels/04-details-and-feedback--11-message-while-away.png))
Bar: workspace avatar "N" (`c4`, `.pr.off`), "Nilufar Store", "Away, replies by email". `.thread.top`: away banner;
visitor "Hi, when will size 42 of these shoes be back in stock?" "11:10 PM" + read ticks; operator (workspace) bubble "Your message is
saved." + saved card "We’ll send the reply to **ali@example.com**." + meta "Automatic reply". Composer "Add anything else…"
(enabled). Production: today the offline chat disables send ("Disabled while offline", production map §4.2) or shows the
contact fallback form (§4.6, `data-fb*`). The design needs messages accepted while away and the reply sent by email;
needs Core/server (§9). If unavailable: keep the fallback form, restyled with `.fi` fields and a `.csat .btn` submit
(suggestion).

### 5.12 Screen 12 · Rating after a chat ([png](screens/panels/04-details-and-feedback--12-rating-after-a-chat.png))
Thread (bottom-aligned, no composer): visitor "Thanks, that sorted it!" 9:12 PM + read ticks; operator "Glad that’s sorted! Have a
great day." 9:13 PM; system line "Sara closed the conversation"; CSAT card with "Great" selected. Production: new (§4.32);
the close event is a new system row.

### 5.13 Screen 13 · Mobile home ([png](screens/panels/05-mobile--13-home.png))
Screen 01 on the mobile sheet (§2.6): taller hero (status-bar allowance), chips in one scrolling row (40px), footer above
the home-bar allowance. Production: `.shell.gs-mobile-open .panel`.

### 5.14 Screen 14 · Mobile conversation ([png](screens/panels/05-mobile--14-conversation.png))
Screen 04 on the mobile sheet: bar 104 (status-bar allowance), same thread and composer at 390 wide.

### 5.15 Live prototype (P1–P4)
- **P1** ([site mock](screens/panels/06-live-prototype--site-mock.png)): launcher at rest, Thread glyph on Ink, Signal
  answer pill.
- **P2** ([greeting](screens/states/06-live-prototype--greeting.png)): greeting bubble "Sara from Nilufar Store" / "Hi!
  Looking for the right size? I can help." + badge "1"; answer pill arrival.
- **P3** ([open home](screens/states/06-live-prototype--open-home.png)): launcher gone, panel at the launcher corner (tail
  bottom-right), home cascade.
- **P4** ([open chat](screens/states/06-live-prototype--open-chat.png)): chat header "Sara" with status online dot + "Nilufar Store"
  (board 02 uses "Online"), messages "Hi! Looking for the right size? I can help." (7:44 PM), "When will my order arrive?"
  (7:46 PM + read ticks), "Hi! Your order shipped this morning and arrives on Thursday." (7:46 PM). No More options button.
Interactions and timings: §6.2.

---

## 6. Motion

### 6.1 Motion table (t2.css keyframes t2.css:561-581; prototype transitions t2.css:465-517)

The seven rows of the board's motion notes (`.mn`, spec content) come first, verbatim (title · note · value).

| Interaction | Element | Property | Duration | Easing | Delay | Keyframes / values |
|---|---|---|---|---|---|---|
| **"The chat button drops away"** · "It speeds up as it leaves the window; while the widget is open there is no button." · **260 ms** | `.lw` → production `.launcher.open` | transform, visibility | .26s | `--ease-in` | 0 (visibility hidden at .26s) | `translateY(0)` → `translateY(130px)` (board; production keeps `--gs-fab-exit`) |
| **"The widget springs from the corner"** · "A small overshoot, from the corner where the button was." · **520 ms** | `.p` → `.panel.visible` | transform; opacity | .52s; .22s | `--spring`; ease | .18s | from `translateY(40px) scale(.86)`, `opacity:0`, `transform-origin` at the launcher corner (100% 100%) → open. Production: end at `translateY(0)`, not `none`, so the panel stays the containing block of the lightbox (production map §2) |
| **"Home content arrives in sequence"** · "Header, question card and rows, 60 ms apart." · **60 ms apart** | `.cas` with `--i` 0 top row, 1 `.hi`, 2 `.hq`, 3 `.pres`, 4 `.ask`, 5 `.list` | opacity; transform | .4s; .6s | ease; `--spring` | `calc(.3s + var(--i) * 60ms)` | from `opacity:0; translateY(14px)`. Trigger on panel open (`.panel.visible .cas`) as transitions so re-renders do not replay |
| **"Moving into the chat"** · "Home slides aside and the conversation comes in from the other side." · **420 ms** | `.scr.home`, `.scr.chat` | transform; opacity | .42s; .3s | `--ease`; ease | 0 | home → `translateX(-22%)`, opacity 0; chat from `translateX(100%)`, opacity 0 → none, 1. Back reverses. RTL: home `translateX(22%)`, chat from `-100%`. Production: needs the outgoing view kept for 420 ms (Core swaps one `.wy-view`, §4 of the production map); suggestion: the renderer snapshots the outgoing view into an absolutely positioned layer |
| **"A new message grows from its tail"** · "Right after the typing dots." · **500 ms** | `.g.new` (static board), `.dm` (prototype) | transform; opacity | .5s; .2s (`.dm`) | `--spring`; ease | 0 in the prototype (static board `.25s`) | `t2-msg`: `opacity:0; scale(.55)` → none; `.dm`: `scale(.6)` → none; origin left bottom (operator) / right bottom (visitor). Production: replaces `wy-msg-in .24s`; keep `.msg-row.no-enter` |
| **"Closing"** · "The widget folds away, then the button rises from below the window." · **260 + 500 ms** | `.p`; then `.lw` | opacity, transform; transform | .2s, .26s; .5s | ease, `--ease-in`; `--spring` | 0; .22s | panel → `translateY(40px) scale(.86)`, `opacity:0`, visibility hidden at .26s; launcher `translateY(130px)` → 0. The board snaps the home cascade back to hidden at close start (no transition on the base state); suggestion: reset it after the panel is hidden. Production: replaces the 280 ms WAAPI rise (LD:955-995) for `simple`/`simple-intl` |
| **"Reduced motion"** · "If someone turns on Reduce motion, everything simply fades." · **150 ms** | everything under `.t2` | — | .15s | ease | — | `@media (prefers-reduced-motion:reduce){ .t2 *, ::before, ::after { animation:none!important; transition: opacity .15s ease!important } .t2 .field .ph span:first-child{opacity:1} }` (t2.css:583-586) |
| Greeting in / out | `.greet` (`.greet-on`) | opacity; transform | .3s; .55s / .16s; .16s | ease; `--spring` / ease | .1s / 0 | from `translateY(10px) scale(.7)`, origin 100% 100%. Production replaces `gs-smart-in .38s` / `gs-smart-out .24s` |
| Unread badge | `.kl .bdg` | transform | in .5s / out .2s | `--bounce` / ease | .35s / 0 | `scale(0)` ↔ none |
| Answer pill arrives (Thread) | `.kl .g-t .ac` | transform, opacity | .45s | `cubic-bezier(.3,1.4,.5,1)` | .2s (backwards) | `t2-pill`: `translateX(34px)`, 0 → 70% `translateX(-6px)`, 1 → none (production `rpk-kit-answer` .36s, no delay) |
| Signal dot pops (Open) | `.kl .g-o .ac` | transform | .45s | `cubic-bezier(.3,1.5,.5,1)` | .2s | `t2-dotpop`: scale .2 → 60% 1.35 → 1; origin 96px 96px |
| Launcher hover / press | `.kl` | transform, box-shadow | .16s | ease | 0 | `scale(1.06)` + hover shadow / `scale(.94)` |
| Typing dots | `.typing i`, `.who .st.typ i` | transform, opacity | 1.2s infinite | ease-in-out | 0, .15s, .3s | `t2-wave`: 0/60/100% none, .45 → 30% `translateY(-4px)`, 1 |
| Rotating placeholder | `.field .ph span` 1–3 | opacity, transform | 12s infinite | `--ease` | 0, 4s, 8s | `t2-ph`: 0% 0 `translateY(10px)` → 4–30% 1 none → 34–100% 0 `translateY(-10px)` |
| Carets | `.field .ph::before`, `.box .in.ty::after`, `.sfield .q::after` | opacity | 1.1s infinite | `steps(1)` | 0 | `t2-caret`: on 0–50%, off 50.01–100% |
| Presence ping | `.pres .dot::after` | transform, opacity | 2.4s infinite | `--ease` | 0 | `t2-ping`: scale 1, .6 → 70–100% scale 2.6, 0 |
| Hero glow | `.aur i` 1 / 2 | transform | 16s / 22s infinite | ease-in-out | 0 / −6s | `t2-drift` `alternate` / `alternate-reverse`: → `translate(-26px,22px) scale(1.12)` |
| Board-only cascade | `.cz` | opacity, transform | .6s | `--ease` | `calc(.15s + var(--i) * 70ms)` | `t2-rise` (12px). Static boards only; production uses `.cas` |
| Chip / send / icon presses | `.chip`, `.send`, `.gb`, `.ib`, `.act` | transform | .25s / .2s / .18s / .18s / .25s | `--bounce` / `--bounce` / `--ease` / `--ease` / `--bounce` | 0 | `.95` / hover `translateY(-1px) scale(1.05)`, active `.92` / `.92` / `.92` / `.9`; colour changes .18s ease |
| Row / CTA / category hover | `.r .ch`, `.cta .go`, `.cat` | transform | .2s / .25s / .25s | `--ease` | 0 | `translateX(3px)` (RTL −3px) / `translateX(3px)` / `translateY(-2px)` |
| Composer focus | `.box` | box-shadow | .22s | ease | 0 | §3.4 |
| Mic → send | `.act.on` | opacity, transform | .45s | `--bounce` | 0 | `t2-pop`: `opacity:0; scale(.4)` → none |
| Recording | `.rec .dot`; `.rec .wave i` | opacity; transform | 1s; .8s infinite alternate | ease-in-out | 0; 2n −.25s, 3n −.5s | `t2-blink` 1 → .25 → 1; `t2-bar` `scaleY(.45)` → 1 |
| Voice playing | `.voice .wave i:nth-child(-n+9)` | transform | .9s infinite alternate | ease-in-out | 3n −.3s, 3n+1 −.6s | `t2-bar` |
| Download progress | `.ring svg.arc circle` | stroke-dashoffset | 2.6s, forwards | `--ease` | .6s | `t2-dl`: 94 → 24 (production: real progress) |
| Image sheen | `.img::after` | transform | 2.8s infinite | ease-in-out | .8s | `t2-sheen`: `translateX(-100%)` → 60–100% `translateX(100%)` |
| Order progress | `.steps::after`; `.steps span.now i` | transform; box-shadow | 1.1s; 2s infinite | `--ease`; ease-in-out | .5s; 1.6s | `t2-fill` `scaleX(0)` → none; `t2-now` halo 4px `--a-3` ↔ 50% 8px `--a-2` |
| Reaction | `.react` | opacity, transform | .5s | `--bounce` | .6s | `t2-pop` |
| Quick topics | `.qr .chip` 1–4 | opacity, transform | .5s | `--ease` | .5s, .58s, .66s, .74s | `t2-rise`: `opacity:0; translateY(12px)` → none |
| Instant answers | `.tray` | opacity, transform | .5s | `--ease` | .4s | `t2-rise` |
| Search results | `.res a` 1–3 | opacity, transform | .45s | `--ease` | .15s, .21s, .27s | `t2-rise` |
| Reading progress | `.prog` | transform | 1.4s | `--ease` | .3s | `t2-read-in`: `scaleX(0)` → `scaleX(.36)` (production: follows scroll) |
| Faces | `.face:hover`; `.faces button:hover`; `.faces .on` | transform | .3s; .3s; .7s | `--bounce` | 0; 0; .9s | `translateY(-2px) scale(1.08)`; `translateY(-3px) scale(1.08)`; `t2-pick` `scale(.6)` → none |
| FAB | `.fab` | opacity, transform | .6s | `--spring` | .5s | `t2-fab`: `opacity:0; translate(-50%,24px) scale(.8)` → `translateX(-50%)` |
| Skeleton | `.sk i` | background-position | 1.4s infinite | linear | 0 | `t2-shim`: 100% → −100% (RTL reversed) |
| Email saved / CSAT | `.fcard.done .ck`; `.csat` | opacity, transform | .5s; .55s | `--bounce`; `--ease` | .5s; .3s | `t2-pop`; `t2-rise` |

Curve glyphs drawn beside the seven notes (`svg.curve`, 44 × 30, stroke 2.2, Signal `#FF5A3C` in Respok; the active row
gets background `#FFF4F1` and an `--a` icon tile with a white curve): 1 accelerating curve (ease-in), 2 rise with overshoot (spring), 3 four steps
(stagger), 4 fast-out decelerating curve (ease), 5 overshoot starting from a dot (growth from the tail), 6 down then up
(fold, then rise), 7 dashed flat line (no movement).

Board delays are measured from page load (static boards play once). In production start each entrance when its element
is inserted; keep the staggers (60, 70, 80, 60 ms) as the rhythm.

### 6.2 Live prototype step machine (`class Component`, [`source/06-live-prototype.dc.html`](source/06-live-prototype.dc.html))

State `{ open, chat, greet, unread, m, step }` → root classes `open`, `inchat`, `greet-on` (greet and not open),
`unread` (unread and not open), `m1`–`m3`; `step` k highlights motion-note row k+1.

| Time (autoplay) | Action | Effect |
|---|---|---|
| mount + 600 ms | `run(0)`: `greet:true, unread:true` | greeting in (.1s delay), badge (.35s delay), answer pill (.2s delay) |
| + 2600 ms | `open()`: `open:true, greet:false, unread:false`; steps 0 @0, 1 @260 ms, 2 @700 ms | launcher drops, panel springs (.18s), cascade |
| + 2400 ms | `chat()`: `chat:true, m:0, step 3`; `m1` @650 ms, `m2` @1350 ms, `m3` + step 4 @2650 ms | view slide; visitor message; typing (D3); answer grows from its tail |
| + 4600 ms | `chat:false, step 3` | back to home (reverse slide) |
| + 1800 ms | `close()`: `open:false, step 5`; after 380 ms `chat:false, m:0` | panel folds, launcher rises after .22s |
| + 2600 ms | `run(0)` again | loop |

Clicks pause autoplay for 12 s (`pause()`), then resume with `go(open ? 4 : 0, 400)`. Launcher → `open()`; field or chip →
`chat()`; greeting message → `chat()` (opens directly into the chat); greeting X → `greet:false`; back → home; close →
`close()`; Replay → `close()` then `run(0)` after 900 ms. Production equivalents: launcher click / `window.__gs.push(['open'])`,
smart CTA, `data-home-action="chat"`, `data-view-back`, `data-panel-close`. The autoplay itself is a board device.

### 6.3 Reduced motion
t2.css:583-586 (row "Reduced motion" above): no animation, only `.15s` opacity transitions; the first placeholder shows
statically. Keep every production opt-out (production map §8.8) and the kit's `.12s` glyph fade. The order progress fill,
download arc and reading progress show their current values without animating (in the board the arc then stays empty,
because its 94 → 24 is only an animation).

---

## 7. Direction, language and numbers

- **Respok is LTR English.** `lang="en"`, `dir` per production rules (PD writes `dir=rtl` only for `fa`).
- **Physical in both directions:** message sides (operator left, visitor right; t2.css:206-209 keeps them under
  `[dir=rtl]`), bubble corners and tails, quick-topic alignment (visitor side), panel tail and greeting tail (physical
  corner of the anchor), hero highlight `at 100% 0%` (t2.css:83, not mirrored), launcher/greeting anchoring.
- **Logical (mirror in RTL):** paddings via `padding-inline`, `inset-inline` (watermark, glow, divider, reaction, caption,
  presence dot, badge), progress origins (`--ps`), `.voice`, `.sfield`, `.greet .gm` padding swaps (rules exist), `.r .end`
  alignment, hover nudges (`.r .ch`, `.cta .go`), skeleton shimmer, mobile chip fade (`--fade-to`), view slide.
- **Chevrons:** the Respok boards draw LTR paths only (back `m14 6-6 6 6 6`, forward `m10 6 6 6-6 6`). In RTL swap the
  paths (as the WebYar boards do); do not flip with `scaleX(-1)` where a hover `transform` is also used.
- **Always LTR inside any text:** waveforms (`direction:ltr`), the email field (`direction:ltr`), emails in the saved
  card and `.code` (`direction:ltr; unicode-bidi:isolate`), voice/audio players (production `dir=ltr`).
- **Fonts:** Figtree for Latin; DM Mono for codes and tracking numbers. A Respok widget in Persian switches to Vazirmatn
  ([brand sheet](../README.md)); t2.css has no Respok RTL font rule: suggestion: under `[dir=rtl]` use the `text_rtl`
  stack from tokens.json and the base (non-`.b-rp`) line-heights, which are tuned for Vazirmatn.
- **Numbers:** Latin digits; times in the visitor's locale ("7:42 PM"); relative times from Core ("10 min ago",
  "Yesterday", "5 days ago"); counts as typed ("3 articles found", "2"). In `fa`, Persian digits per
  [brief §6](../../CLAUDE_CODE_BRIEF.md).
- **Copy style:** sentence case, curly apostrophes (’) and ellipses (…) as written in §10.

---

## 8. Accessibility

- **Focus:** §4.36; every button, link and the ask field reachable in DOM order (hero close → ask field → send → chips →
  rows → footer link on home; back → header → thread → composer in chat).
- **Labels in the board markup:** Close · Ask a question (`role=textbox`, production: a real labelled textarea) · Send ·
  Back · More options · typing (`.typing`) · Photo of the shoes (`.img role=img`, demo alt) · Download invoice · Play voice
  message · Delete recording · Send voice message · Emoji · Attach a file · Record a voice message · Clear · No / Somewhat /
  Yes · Loading older conversations · Save email · Very bad / Bad / Okay / Good / Great (`aria-pressed="true"` on the
  selected one) · Open chat · Dismiss message · Respok (`role=img` on the lockup). Decorative: `.aur`, `.mk`, all icons
  (`aria-hidden`), waveforms. Greeting `role=status`.
- **Keep production ARIA and live regions** (production map §8.5): launcher `aria-haspopup`/`aria-expanded`/`aria-label`
  with the unread count (badge `aria-hidden`), panel dialog, `[data-presence]` (now visible), `[data-typing-row]`
  (sr-only, keep), `[data-rec-sr]`, `[data-rec-timer][role=timer]`, `.msg-att-loading`, `[data-fb-status]`,
  `.prechat-error[role=alert]`, `.hc-card[role=group]`, `.kb-rate[aria-pressed]`, `.emoji-btn[aria-expanded]`.
  The new visible typing row is `aria-hidden` so typing is not announced twice.
- **New controls:** CSAT faces as a radio group or `aria-pressed` buttons with the five labels; tray rows are buttons
  with the article title; the order card's "Track package" is a link (opens a new tab, say so); the reading progress line
  is decorative.
- **Contrast (Respok, WCAG):** body text `--ink` on white 17.96:1; `--ink-3` on white 6.43:1, on `--paper` 5.91:1;
  pill `#A62A12` on `#FFEAE4` 6.13:1; tip `#8A2410` on `#FFF4F1` 8.32:1; unread badge white on `#D3361A` 4.87:1; hero
  white on `#1E1B3B` 16.47:1; Signal focus ring on white 3.10:1 (meets 3:1 for non-text); white arrow on Signal stop
  button 3.10:1 (icon only). **Below AA:** `--ink-4` placeholders ("Write a message…", "name@example.com", "Tell us more
  (optional)") 2.35:1 on white. Text on a custom accent uses `--on-a` (§3.1).
- **Touch targets:** desktop icon buttons 38 (bar, hero), 36 (composer tools), 28 (search clear), text button "Try
  again" ~16px tall; mobile ≥ 44 required by the brief (§2.6).
- **Reduced motion:** §6.3.

---

## 9. New versus production

Canonical names for every hook, setting, view-model field and i18n key below (one name per concept, shared by
both brands and both templates): [`../../shared/new-hooks-and-settings.md`](../../shared/new-hooks-and-settings.md).

| Addition | Where | UI spec | Core / server / settings must provide | Suggested hook or config key | If unavailable |
|---|---|---|---|---|---|
| Template id `simple-intl` | all | §3.8 skin over `simple` | Registry entry `{ id:'simple-intl', globalKey:'__gs_presentation_simple', script:'presentation-simple.js', style:'presentation-simple.css', skin:'presentation-simple-intl.css', fonts:<Figtree + DM Mono asset> }`; `shared/widgetTemplates.ts`; kit chosen by edition (brief §3) | — | Template 1 `intl` |
| `--on-a` / brand overrides | all | §3.1 | Loader computes `--gs-on-primary`; `.gs-accent-brand` when the accent is Ink | `--gs-on-primary`, `gs-accent-brand` | `--on-a:#fff` |
| Logo direction | hero, footer, launcher | §4.33, §4.34 | Setting | `logoDirection: "thread" \| "open"` (default `thread`) | `thread` |
| Ask field on home | 01–03, 13 | §4.5 | Start a conversation with the typed text | `textarea[data-home-ask]` + `button[data-home-action="chat"]` | Field opens the chat with the draft prefilled |
| Rotating example placeholders | 01, 02, 13 | §4.5 | Workspace examples | suggested `askExamples[]` | Only "Ask us anything…" |
| Topic chips (home + thread) with icons | 01, 02, 06, 13 | §4.6, §4.17 | Topics with labels/icons; first message = topic | `data-topic`; reuse `data-qna-question`; suggested `topics[] {label, icon}` | Hide chips |
| Hero presence (team, away time) | 01–03 | §4.3 | Online members, next opening time | vm `teamMembers`, suggested `availability.nextOpenAt` | "Away right now" without time |
| Continue row with agent | 02 | §4.7 | Agent name/avatar, preview, unread, time per conversation | `data-conversation-open` | Workspace name/logo |
| Conversation counts | 02 | §4.7 | Total and open counts | — | Subtitle hidden |
| Help center row subtitle | 01–03 | §4.7 | Article count, top categories | — | Title only |
| Track an order row + order card | 01, 03, 04 | §4.7, §4.13 | Commerce context (`data-commerce-*`), order status, steps, ETA, tracking URL | suggested `data-home-action="track-order"`, message `metadata.kind="order_status"` | Hide |
| Agent identity + visible presence/typing in the bar | 04, 05, 10, 12 | §4.8 | Assigned agent; presence (exists), typing (exists) | `[data-presence]` made visible | Workspace identity |
| Visible typing row | 04, 14 | §4.11 | `setOperatorTyping` (exists) | `view.operatorTyping` → `.typing-row` | sr-only only (today) |
| Sender label, initials avatars | 04–06, 10–12 | §4.10, §4.4 | — (renderer) | — | — |
| Reactions | 05 | §4.12 | Reaction data | — | Hide |
| Image caption, download progress | 05 | §4.14, §4.15 | Attachment name, download progress | — | No caption / no arc |
| Waveform voice bubble | 05 | §4.16 | — (decorative bars) | — | — |
| Instant answers while typing | 06 | §4.21 | KB search as you type, matched terms | suggested `div.tray[data-kb-suggest]`; rows `data-kb-action="open"` | Hide |
| Help search, count, highlights, excerpts | 07 | §4.22 | KB search with excerpts and matches | suggested `data-kb-search`, `data-kb-search-clear` | Article list only |
| Help categories | 07 | §4.23 | `vm.categories` (exists, ignored today) | suggested `data-kb-category` | Hide |
| Article category title, author, read time, progress | 08 | §4.8, §4.24 | Article fields | — | Workspace header, no meta |
| Three-face article rating | 08 | §4.25 | Neutral rating value | `data-kb-rate="down\|neutral\|up"` | Two faces (up/down) |
| Always-visible "Still need help?" | 08 | §4.26 | — | `data-kb-action="switch-chat"` | — |
| List: agent rows, "You: " prefix, floating button, older-items skeleton | 09 | §4.27–4.29 | Agent per conversation, last sender, pagination | `data-home-action="chat"` | Workspace identity; skeleton on first load only |
| Email-only in-thread card, skip, saved card | 10, 11 | §4.30 | Skip handling; saved-email state | `data-prechat-submit`, suggested `data-prechat-skip` | Production card restyled |
| Away thread (messages accepted while away) | 11 | §4.31, §5.11 | Accept offline messages, email reply, reply time | — | Contact fallback form restyled |
| Conversation closed system row | 12 | §4.9 | Close event in the message stream | message `metadata.kind` (new) | Omit |
| Rating card (CSAT) | 12 | §4.32 | Rating API, transcript email | suggested `data-csat-*` | Hide |
| Greeting look | P2 | §4.35 | Nudge content: agent name, avatar, message | `data-smart-cta`, `data-smart-dismiss` | Production nudge restyled without avatar |
| Launcher Open glyph, badge and arrival timings | P1, P2 | §4.34 | Loader kit CSS | `logoDirection` | Thread |
| Panel, launcher, cascade, view-slide motion | P3, P4 | §6 | Loader timings for T2; Core keeps the outgoing view during the slide | — | Fade (production) |

---

## 10. Copy deck

UI strings as designed (English). "Meaning / variables" names placeholders; production keys from production map §7 (English
values seen in the production snapshots in parentheses when they differ).

| UI string | Where | Meaning / variables | Production key |
|---|---|---|---|
| Hi there 👋 | 01, 03, 13 hero | — | new: `simpleHomeHi` (`homeGreeting` = "Hello 👋") |
| Welcome back, Ali 👋 | 02 hero | `{name}` = visitor name | new: `simpleHomeHiReturning` |
| How can we help you today? | 01, 02, 13 headline (break after "How can we") | — | new: `simpleHeadline` |
| Leave us a message | 03 headline (break after "Leave us") | — | new: `simpleHeadlineAway` (`homeLeaveMessage` = "Leave a message") |
| Online now, usually replies in 2 minutes | hero presence | "Online now" + reply time | new: `simplePresenceOnline` + `replyTimeText` (`homeReplyFast` = "Typically replies in a few minutes") |
| Away right now, back at 9 AM | 03 presence | `{time}` | new: `simpleAwayBackAt` |
| Ask a question | ask field `aria-label` | — | new: `simpleAskLabel` |
| Ask us anything… | ask placeholder 1 | — | new: `simpleAskPlaceholder` |
| e.g. When will my order arrive? · e.g. Is size 42 in stock? | ask placeholders 2, 3 | workspace examples (demo) | setting (suggested `askExamples`); prefix new: `simpleAskExamplePrefix` |
| Write your message… | 03 field | — | new: `simpleAskPlaceholderAway` |
| We’ll email you the reply in the morning | 03 note | depends on next opening | new: `simpleAwayNote` |
| Delivery · Returns · Sizing | home chips | workspace topics (demo) | setting |
| Send | send buttons `aria-label` | — | `send` |
| Close | close `aria-label` | — | `close` |
| Help center | row title, help bar title | — | new: `simpleHelpCenter` (`wyArticles` = "Articles") |
| 24 articles on orders, delivery and returns | help row subtitle | `{n}`, `{categories}` | new: `simpleHelpSub` |
| Most answers are here, any time | help row subtitle (away) | — | new: `simpleHelpSubAway` |
| Track an order | row title | — | new: `simpleTrackOrder` |
| See its status with your order number | row subtitle | — | new: `simpleTrackOrderSub` |
| Continue with Sara | row title | `{name}` = agent | new: `simpleContinueWith` (`wyContinueLast` = "Continue last conversation") |
| Your conversations | row title, list bar title | — | new: `simpleYourConversations` (`wyConversations` = "Conversations") |
| 3 conversations, 1 open | row subtitle | `{n}`, `{open}` | new: `simpleConversationsSub` |
| 10 min ago · Yesterday · 5 days ago | row/list times | Core `timeLabel` | Core |
| Powered by | footer | + lockup "Respok" | `poweredBy` |
| Back | back `aria-label` | — | `back` |
| More options | bar `aria-label` | — | new: `moreOptions` |
| typing | bar status, typing bubble `aria-label` | — | new: `simpleTyping` |
| Online | bar status | — | new: `statusOnline` |
| Today | day divider | — | hard-coded (PD:545-547) |
| Shipped · Placed · Packed · Delivered | order pill and steps | order status labels | new: `orderStatusShipped` (pill); `orderStepPlaced`, `orderStepPreparing`, `orderStepShipped`, `orderStepDelivered` |
| Order 48213 · Running shoes, size 42 | order card | commerce data (demo) | — |
| Arrives Thursday | order card footer | `{day}` | new: `orderArrives` |
| Track package | order card button | — | new: `orderTrackPackage` |
| Write a message… | composer placeholder | — | `typeMsg` ("Type a message...") |
| Add anything else… | composer placeholder (away) | — | new: `simpleAddMore` |
| Emoji | composer `aria-label` | — | `emojiPicker` |
| Attach a file | composer `aria-label` | — | `attachFile` ("Attach file") |
| Record a voice message | mic `aria-label` | — | `recordVoice` ("Record voice message") |
| Download invoice | file ring `aria-label` | "Download" + file | `download` |
| Play voice message | voice play `aria-label` | pause label when playing (D5) | `playAudio` |
| Not sent | failed meta | — | `msgFailed` |
| Try again | failed retry | — | `retry` ("Retry") |
| Delete recording | recorder `aria-label` | — | new: `deleteRecording` |
| Send voice message | recorder confirm `aria-label` | see §4.20 | `stopRecording` ("Stop recording"); `sendVoice` if it sends directly |
| New conversation | 06 bar title, list FAB | — | `wyNewConversation` |
| Usually replies in 2 minutes | 06 bar status | reply time | `replyTimeText` / `homeReplyFast` |
| The Nilufar Store team | welcome title | `{workspace}` | new: `simpleWelcomeTeam` |
| We’re online | welcome line | — | new: `simpleWereOnline` |
| Hi! Type your question, or pick a topic to get started. | welcome bubble | workspace welcome | `welcomeMessage` / `intro` |
| Track my order · Help me choose · Returns and refunds · Something else | thread topics | workspace topics (demo) | Q&A questions / setting |
| Answers from the help center | tray heading | — | new: `simpleInstantAnswers` |
| 2 min read · 1 min read | tray, article meta | `{n}` minutes | new: `kbReadTime` |
| Clear | search clear `aria-label` | — | new: `kbClearSearch` |
| 3 articles found | result count | `{n}` | new: `kbResultsCount` |
| Or start from a topic | categories heading | — | new: `kbTopicsTitle` |
| 5 articles · 4 articles · 3 articles · 6 articles | category counts | `{n}` | new: `kbArticleCount` |
| Did this help? | article feedback | — | new: `kbDidThisHelp` (`wyArticleHelpful` = "Was this article helpful?") |
| No · Somewhat · Yes | faces `aria-label` | — | `wyHelpfulNo` · new: `simpleHelpfulPartly` · `wyHelpfulYes` (today "Not helpful", "Helpful") |
| Still need help? | article CTA | — | new: `kbStillNeedHelp` |
| Chat with the team, usually replies in 2 minutes | article CTA sub | + reply time | new: `kbChatWithTeam` |
| You: | list preview prefix | — | `you` + ": " (`you` = "You") |
| Open · Resolved | status pills | — | `wyStatusOpen`, `wyStatusResolved` |
| Loading older conversations | skeleton `aria-label` | — | new: `simpleLoadingOlder` |
| Got it, the team has your question and usually replies within minutes. | handoff bubble 1 | — | `.hc-subtitle` text (Core); new: `simpleHandoffAck` |
| If you leave the site, where should we send the reply? | handoff bubble 2 | — | new: `simpleAskEmail` |
| Email | email card label | — | `email` |
| name@example.com | email placeholder | — | `prechatEmailPh` |
| Save email | OK `aria-label` | — | new: `saveEmail` |
| No thanks, I’ll wait here | email card skip | — | new: `simpleSkipEmail` |
| Away, replies by email | 11 bar status | — | new: `simpleAwayStatus` |
| We’re away right now | away banner | — | new: `simpleAwayTitle` |
| Back at 9 AM, usually reply within 2 hours | away banner sub | `{time}`, `{replyTime}` | new: `simpleAwaySub` |
| Your message is saved. | auto bubble | — | new: `simpleMessageRecorded` |
| We’ll send the reply to ali@example.com. | saved card | `{email}` | new: `simpleReplyToEmail` |
| Automatic reply | meta under the auto bubble | — | new: `simpleAutoReply` |
| Sara closed the conversation | system line | `{name}` | new: `convClosedBy` |
| How was your chat with Sara? | CSAT title | `{name}` | new: `csatTitle` |
| Your answer helps the team get better. | CSAT sub | — | new: `csatSub` |
| Very bad · Bad · Okay · Good · Great | CSAT faces `aria-label` | 1–5 | new: `csat1`–`csat5` |
| Tell us more (optional) | CSAT comment | — | new: `csatComment` |
| Send feedback | CSAT button | — | new: `csatSend` |
| Email me the transcript | CSAT link | — | new: `csatTranscript` |
| Open chat | launcher `aria-label` | + unread count | `openChat` (loader) |
| Dismiss message | greeting dismiss `aria-label` | — | `dismiss` ("Dismiss") |
| Sara from Nilufar Store | greeting name line | `{agent}`, `{workspace}` | nudge `title` (smart content) |
| Hi! Looking for the right size? I can help. | greeting message | — | nudge `body` (smart content) |

Demo only (not copy): names, messages in bubbles, order/product, file names and sizes, article titles, excerpts and body,
category names, times, counts, "Nilufar Store", "N".

---

## 11. Acceptance checklist

In addition to [brief §10](../../CLAUDE_CODE_BRIEF.md):

- [ ] Each of the 14 panel PNGs matches at 400 × 720 (mobile 390 × 844), DSF 2, with Ink and Thread; the panel tail is the
      8px corner on the launcher side (bottom-right by default, bottom-left with `position: bottom-left`, any direction).
- [ ] Home hero measures 312.1px (desktop) and the ask card overlaps it by exactly 52px; rows start 16px below the card.
- [ ] Respok deltas (§3.8) all present: flat accent visitor bubble, voice bubble, send `.act.on`, FAB, CSAT button; home
      `.send` keeps its gradient; outlined chips that fill with Ink on hover; Signal focus rings and carets (composer,
      search, email field); white focus ring on the hero.
- [ ] Line-heights: bubble 1.5, `.hq` 1.18, article h1 1.25 / p 1.65 / steps 1.55 (Figtree).
- [ ] With `#2F5BFF`, `#0F766E`, `#C2410C` the hero uses the formula stops (no Ink overrides), `--kac` = white; with a light
      accent (`#FFB423`) all text/icons on the accent and the launcher glyph turn Ink `#16142B`.
- [ ] Logo direction `open` swaps the watermark, footer lockup (50 × 13) and launcher glyph; `thread` is the default.
- [ ] Composer: mic in the action cell when empty, send with the pop when typing; DOM order and hooks unchanged; recorder
      pill 52px with Signal rings; skeleton composer box 86px.
- [ ] Visible typing row appears with `setOperatorTyping` and the sr-only announcement still fires once.
- [ ] Hook diff of the `simple` renderer against production is empty, including hooks whose UI T2 does not draw
      (`data-home-article`, `data-chat-jump`, `data-reply-preview`, `data-emoji-picker`, `data-audio-rate`, the pre-chat
      and contact-fallback views).
- [ ] Board defects D1–D5 are not reproduced.
- [ ] Motion matches §6.1: launcher drop .26s ease-in; panel .52s spring after .18s from `translateY(40px) scale(.86)`;
      cascade 60 ms apart from .3s; view slide .42s; message .5s spring from the tail; close .26s then launcher rise .5s
      after .22s; reduced motion = .15s fades only.
- [ ] Greeting 280 wide, 16px above the launcher, radius 21 21 4 21 (mirrored for bottom-left); badge 22px `#D3361A` at
      −5/−5 with a 2.5px white ring.
- [ ] Every feature in §9 without backend support renders nothing (no dead controls), and the views still look right
      without the footer.
