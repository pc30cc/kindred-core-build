# WebYar call-center widget · Template 1 — implementation spec

The WebYar (وب‌یار) website call-center widget: a voice call, a video call or a callback request, in Persian, right to
left. Per the [brief §3](../../CLAUDE_CODE_BRIEF.md) it becomes production call-widget template **`default`**, restyled
in place with a rewritten renderer (`public/call-widget/presentation-default.js`) on the same lifecycle and controller
calls. The idea: a calm **light panel** for choosing and filling in, and a **dark "call stage"** derived from the
workspace accent (`--s1..--s3`, `--glow`) that spreads out of the pressed button for the queue and the call; the
launcher stays honest about the call (queue bar, call bar, mini video, booked callback) when the panel is collapsed.

Brand sheet: [`../README.md`](../README.md). Production widget: [`../../shared/production-map.md`](../../shared/production-map.md)
(cited below as "map §n"). Where this README and the brief disagree, the brief wins for architecture and integration,
this README for visual values.

---

## 0. Files in this folder

| Path | What it is | How to use it |
|---|---|---|
| [`source/`](source/) `NN-name.dc.html` | Board sources: HTML with `{{holes}}`, the copy, inline SVG icons, and the `class Component` at the bottom (`renderVals()`, the live prototype's state machine and timers). `data-props` = board options (`accent` default `#0B7D6C` + 6 presets, `radius` `sm/md/lg`) | Read, do not run (they need the design tool). The 04 script is behaviour spec (§6) |
| [`reference/`](reference/) `NN-name.html` | Static renders of every board (scripts and handlers removed). 04 also as `--open-home`, `--queue`, `--call`, `--minimized-call`, `--rating`, `--thanks`, `--button-c-br`, `--button-p-bl`, `--button-r-br`, `--button-t-tr`; 05 also as `--radius-sm`, `--radius-lg` | Open from disk in Chrome. Computed values: Playwright (`python3 -I`, preinstalled Chromium) |
| [`reference/css/cc.css`](reference/css/cc.css) | The exact stylesheet of all boards, both brands (`.cc` = WebYar values; `.cc.b-rp` = Respok overrides; radius on the root `data-r="sm\|lg"`). [`reference/css/fonts.css`](reference/css/fonts.css) + [`reference/fonts/`](reference/fonts/) = Vazirmatn 400–700 | Source of every number in this README |
| [`screens/panels/`](screens/panels/) | Every screen, launcher style, placement and state card at 2x: **the acceptance target**. Crops include a few px of the board around the panel (the `.tag` label above, neighbouring cards) | Compare the live widget against these |
| [`screens/boards/`](screens/boards/) | Whole boards at 1x with the designer's title and explanation | Context only |
| [`screens/states/`](screens/states/) | Live prototype (04) in its states and board 05 in radius `sm` / `lg`, whole board at 1x | Context only |
| [`tokens.json`](tokens.json) | Every token: CSS expression + value resolved for `#0B7D6C` + the three radius sets | Token source of truth (§3) |

**Board chrome is not product UI** — ignore: the kicker `.kick` («ویجت کال‌سنتر»), titles `.cc-h` / `.cc-d`, section titles
`.sec-h`, the `.tag` number labels, `.cc-row` / `.cc-col`, the card frames `.lgc`, `.pm`, `.pmk`, `.stc`, `.frm`, `.scr2`,
the page sketches `.sk`, `.mini-ph .mp`, `.bd2`, the fake website `.site2 .sbar .snav .page .stg`, the prototype controls
`.side .cgrp .ctl`, the phone chrome `.notch`, `.homebar`, `.mbar .hb`, `.mpage`, `.cp.mob` radius 46, the
design-system card frames `.sc`, the person illustrations `.person` / `.feed .bk` / `.shelf` (they stand in for real video)
and the hover cursor `.hov-arrow`. **Spec content inside chrome:** the captions of the launcher, placement and state
cards (they state behaviour, transcribed in §4.1, §5), the motion list `.mn` of board 04 (§6.1) and board 12 (§3, §4).

**Sample content, not copy:** فروشگاه نیلوفر / «پشتیبانی فروشگاه نیلوفر» (the workspace name), «ف» (its initial),
سارا محمدی / «س» (operator), علی رضایی / «ع» (visitor), `ali@example.com`, `۰۹۱۲۳۴۵۶۷۸۹`, «سفارش ۴۸۲۱۳»,
«مرجوعی کفش، سایز ۴۲», departments «فروش» «پشتیبانی فنی» «مالی», `nilufar.store`, `A1B2C3D4`, every time and duration.

---

## 1. Screen inventory

Work: **Restyle** = same production view, new CSS · **Restyle + markup** = same state and controller calls, new
markup · **New** = needs engine / server / settings work (§9).

| ID | Screen | Screenshot (2x) | Reference page | Production view (map §) | Work |
|---|---|---|---|---|---|
| L1 | Launcher: round | [png](screens/panels/01-call-buttons--1-round.png) | [01](reference/01-call-buttons.html) | launcher §2 (`launcher_style=round`) | New (setting) |
| L2 | Launcher: round with a label (**default**) | [png](screens/panels/01-call-buttons--2-round-with-a-label.png) | [01](reference/01-call-buttons.html) | launcher §2 (button + `.ccw-launcher-label`) | Restyle + markup |
| L3 | Launcher: pill | [png](screens/panels/01-call-buttons--3-pill.png) | [01](reference/01-call-buttons.html) | §2 | New (setting) |
| L4 | Launcher: rectangular card | [png](screens/panels/01-call-buttons--4-rectangular.png) | [01](reference/01-call-buttons.html) | §2 | New (setting + operator data) |
| L5 | Launcher: split voice / video | [png](screens/panels/01-call-buttons--5-split-voice-and-video.png) | [01](reference/01-call-buttons.html) | §2 + `startCall` §5 | New (setting) |
| L6 | Launcher: edge tab | [png](screens/panels/01-call-buttons--6-edge-tab.png) | [01](reference/01-call-buttons.html) | §2 | New (setting) |
| L7 | Launcher: dark square | [png](screens/panels/01-call-buttons--7-dark-square.png) | [01](reference/01-call-buttons.html) | §2 | New (setting) |
| L8 | Launcher: operator face | [png](screens/panels/01-call-buttons--8-operator-face.png) | [01](reference/01-call-buttons.html) | §2 | New (setting + operator photo) |
| L9 | Launcher: mobile bottom bar | [png](screens/panels/01-call-buttons--9-mobile-bottom-bar.png) | [01](reference/01-call-buttons.html) | §2 at ≤640px | New (setting) |
| P1–P8 | Placement: bottom right (default), bottom left, top right, top left, middle right edge, bottom centre, phone corner, phone bottom bar | [1](screens/panels/02-placement-on-the-page--1-bottom-right-default.png) · [2](screens/panels/02-placement-on-the-page--2-bottom-left.png) · [3](screens/panels/02-placement-on-the-page--3-top-right.png) · [4](screens/panels/02-placement-on-the-page--4-top-left.png) · [5](screens/panels/02-placement-on-the-page--5-middle-right-edge.png) · [6](screens/panels/02-placement-on-the-page--6-bottom-center.png) · [7](screens/panels/02-placement-on-the-page--7-phone-corner.png) · [8](screens/panels/02-placement-on-the-page--8-phone-bottom-bar.png) | [02](reference/02-placement-on-the-page.html) | `config.widget_position` §1.7 (`left`/`right` only today) | P1, P2 Restyle; P3–P8 New |
| Sa | Launcher state: ready | [png](screens/panels/03-button-states-and-motion--a-ready.png) | [03](reference/03-button-states-and-motion.html) | §2.2 online | Restyle |
| Sb | Launcher state: hover | [png](screens/panels/03-button-states-and-motion--b-hover.png) | [03](reference/03-button-states-and-motion.html) | §2.3 hover | Restyle |
| Sc | Launcher state: business logo (flip) | [logo face](screens/panels/03-button-states-and-motion--c-business-logo.png), [flipped to the phone](screens/panels/03-button-states-and-motion--c-business-logo-flipped.png) | [03](reference/03-button-states-and-motion.html) | §2.1 `config.avatar_url` + flip layer | Restyle + markup |
| Sd | Launcher state: offline / callback | [png](screens/panels/03-button-states-and-motion--d-offline.png) | [03](reference/03-button-states-and-motion.html) | §2.2 offline + `show_callback` | Restyle + markup |
| Se | Launcher state: in line, panel minimised | [png](screens/panels/03-button-states-and-motion--e-in-line-minimized.png) | [03](reference/03-button-states-and-motion.html) | `queue_waiting` + `open=false` (production: launcher unchanged, A3.19) | New (renderer) |
| Sf | Launcher state: on a call, minimised | [png](screens/panels/03-button-states-and-motion--f-on-a-call-minimized.png) | [03](reference/03-button-states-and-motion.html) | `in_call` + `open=false` | New (renderer) |
| Sg | Launcher state: video call, minimised | [png](screens/panels/03-button-states-and-motion--g-video-call-minimized.png) | [03](reference/03-button-states-and-motion.html) | `in_call` video + `open=false` | New (renderer, media re-parent) |
| Sh | Launcher state: callback booked | [png](screens/panels/03-button-states-and-motion--h-callback-booked.png) | [03](reference/03-button-states-and-motion.html) | after `ended` (a) — nothing today | New (engine: persisted booking) |
| F1–F4 | Open / close film: closed, opening 520 ms, open, closing 500 ms | [1](screens/panels/03-button-states-and-motion--motion-1-closed.png) · [2](screens/panels/03-button-states-and-motion--motion-2-opening.png) · [3](screens/panels/03-button-states-and-motion--motion-3-open.png) · [4](screens/panels/03-button-states-and-motion--motion-4-closing.png) | [03](reference/03-button-states-and-motion.html) | `toggleOpen` §5, panel §3 | Restyle + markup |
| LP | Live prototype: closed, open home, queue, call, minimised call, rating, thanks; launcher variants c-br, p-bl, r-br, t-tr | [closed](screens/panels/04-live-prototype--closed.png) · [home](screens/panels/04-live-prototype--open-home.png) · [queue](screens/panels/04-live-prototype--queue.png) · [call](screens/panels/04-live-prototype--call.png) · [min](screens/panels/04-live-prototype--minimized-call.png) · [rating](screens/panels/04-live-prototype--rating.png) · [thanks](screens/panels/04-live-prototype--thanks.png) · [c-br](screens/panels/04-live-prototype--button-c-br.png) · [p-bl](screens/panels/04-live-prototype--button-p-bl.png) · [r-br](screens/panels/04-live-prototype--button-r-br.png) · [t-tr](screens/panels/04-live-prototype--button-t-tr.png) | [04](reference/04-live-prototype.html) (+ `--state` files) | whole lifecycle | Motion + behaviour spec (§6) |
| 01 | Home, operators online | [png](screens/panels/05-starting-a-call--01-home-operators-online.png) (+ [sm](screens/panels/05-starting-a-call--01-home-operators-online--radius-sm.png), [lg](screens/panels/05-starting-a-call--01-home-operators-online--radius-lg.png)) | [05](reference/05-starting-a-call.html) | `online_available` §4.2 + header §4.10 | Restyle + markup |
| 02 | Pre-call form with an error | [png](screens/panels/05-starting-a-call--02-precall-form-with-an-error.png) (+ [sm](screens/panels/05-starting-a-call--02-precall-form-with-an-error--radius-sm.png), [lg](screens/panels/05-starting-a-call--02-precall-form-with-an-error--radius-lg.png)) | [05](reference/05-starting-a-call.html) | `pre_call_form` §4.4 + `controller.error` | Restyle + markup |
| 03 | Returning visitor | [png](screens/panels/05-starting-a-call--03-returning-visitor.png) (+ [sm](screens/panels/05-starting-a-call--03-returning-visitor--radius-sm.png), [lg](screens/panels/05-starting-a-call--03-returning-visitor--radius-lg.png)) | [05](reference/05-starting-a-call.html) | `pre_call_form` §4.4, `identifiedContact` | Restyle + markup |
| 04 | Connecting | [png](screens/panels/06-waiting-in-line--04-connecting.png) | [06](reference/06-waiting-in-line.html) | `loading` §4.1 | Restyle + markup |
| 05 | In line (third) | [png](screens/panels/06-waiting-in-line--05-in-line-third.png) | [06](reference/06-waiting-in-line.html) | `queue_waiting` §4.5, position > 1 | Restyle + markup |
| 06 | Next, with a callback offer | [png](screens/panels/06-waiting-in-line--06-next-with-a-callback-offer.png) | [06](reference/06-waiting-in-line.html) | `queue_waiting` §4.5, position 1 + offer card | Restyle + markup |
| 07 | Operator joining | [png](screens/panels/07-on-a-call--07-operator-joining.png) | [07](reference/07-on-a-call.html) | `in_call` §4.6, `connectStatus='waiting_for_operator'` | Restyle + markup |
| 08 | Voice call | [png](screens/panels/07-on-a-call--08-voice-call.png) | [07](reference/07-on-a-call.html) | `in_call`, `connectStatus ∈ {in_call, operator_connected}`, voice | Restyle + markup (+ New signal) |
| 09 | Video call | [png](screens/panels/07-on-a-call--09-video-call.png) | [07](reference/07-on-a-call.html) | `in_call` live + `isVideoCall` | Restyle + markup |
| 10 | Transferring | [png](screens/panels/08-during-the-call--10-transferring.png) | [08](reference/08-during-the-call.html) | `in_call` + `transferring=true` | Restyle + markup |
| 11 | Reconnecting | [png](screens/panels/08-during-the-call--11-reconnecting.png) | [08](reference/08-during-the-call.html) | `in_call`, `connectStatus='media_reconnecting'` | Restyle + markup |
| 12 | Microphone blocked | [png](screens/panels/08-during-the-call--12-microphone-blocked.png) | [08](reference/08-during-the-call.html) | `in_call`, `connectStatus='microphone_permission_denied'` | Restyle + markup (+ New retry) |
| 13 | Rating the call | [png](screens/panels/09-after-the-call--13-rating-the-call.png) | [09](reference/09-after-the-call.html) | `ended` (b) `endedCallId && !ratingSubmitted` | Restyle + markup |
| 14 | Thank you | [png](screens/panels/09-after-the-call--14-thank-you.png) | [09](reference/09-after-the-call.html) | `ended` (c) `ratingSubmitted` | Restyle + markup |
| 15 | Error | [png](screens/panels/09-after-the-call--15-error.png) | [09](reference/09-after-the-call.html) | `error` §4.9 | Restyle + markup |
| 16 | Team offline | [png](screens/panels/10-callback--16-team-offline.png) | [10](reference/10-callback.html) | `offline` §4.3 (`show_callback`) | Restyle + markup |
| 17 | Callback, step 1 | [png](screens/panels/10-callback--17-callback-step-1.png) | [10](reference/10-callback.html) | `callback_form` §4.4/4.8, renderer step 1 | Restyle + markup (+ New slots) |
| 18 | Callback, step 2 | [png](screens/panels/10-callback--18-callback-step-2.png) | [10](reference/10-callback.html) | `callback_form`, renderer step 2 | Restyle + markup |
| 19 | Callback scheduled | [png](screens/panels/10-callback--19-callback-scheduled.png) | [10](reference/10-callback.html) | `ended` (a) `callbackId` | Restyle + markup |
| 20 | Mobile: button on the page | [png](screens/panels/11-mobile--20-button-on-the-page.png) | [11](reference/11-mobile.html) | launcher §2, ≤640px | Restyle + markup |
| 21 | Mobile: home as a sheet | [png](screens/panels/11-mobile--21-home-as-a-sheet.png) | [11](reference/11-mobile.html) | `online_available`, ≤640px | New (sheet) |
| 22 | Mobile: queue full screen | [png](screens/panels/11-mobile--22-queue-full-screen.png) | [11](reference/11-mobile.html) | `queue_waiting`, ≤640px | New (full screen) |
| 23 | Mobile: video call full screen | [png](screens/panels/11-mobile--23-video-call-full-screen.png) | [11](reference/11-mobile.html) | `in_call` video, ≤640px | New (full screen) |
| DS1–DS11 | Design system: colour, any brand colour, type, corners and elevation, buttons, form, call controls, status (call), status (presence), rating, motion | [1](screens/panels/12-design-system--01-color.png) · [2](screens/panels/12-design-system--02-any-brand-color.png) · [3](screens/panels/12-design-system--03-type.png) · [4](screens/panels/12-design-system--04-corners-and-elevation.png) · [5](screens/panels/12-design-system--05-buttons.png) · [6](screens/panels/12-design-system--06-form.png) · [7](screens/panels/12-design-system--07-call-controls.png) · [8](screens/panels/12-design-system--08-status-call.png) · [9](screens/panels/12-design-system--09-status-presence.png) · [10](screens/panels/12-design-system--10-rating.png) · [11](screens/panels/12-design-system--11-motion.png) | [12](reference/12-design-system.html) | tokens §7, components | Tokens (§3, §4) |

### 1.1 Production screens 01–25 (owner's README) → design

| Prod # | Production screen | Design screen(s) | Notes |
|---|---|---|---|
| 01 | launcher | L2 / Sa, LP closed | Label text unchanged (`talk_now` / `live_support`) |
| 02 | launcher-offline | Sd | Calmer white button + `phone-in` icon (production had no offline treatment, map §2.2) |
| 03 | home-online | 01 (mobile 21) | Two large call tiles + callback row + trust row |
| 04 | precall-form | 02 (without the error) | Chips for departments, grouped contact fields, consent switch |
| 05 | precall-form-filled-error | 02 | Error on the consent card + message line |
| 06 | precall-returning-visitor | 03 | Known-contact card with «ویرایش» |
| 07 | connecting (`loading`) | 04 | «در حال اتصال» instead of «در حال بارگذاری…» (A2.1) |
| 08 | queue | 05 (mobile 22) | Dark stage, place-in-line card |
| 09 | queue-next-offer-callback | 06 | Faster rings, offer card |
| 10 | incall-connecting (`waiting_for_operator`) | 07 | |
| 11 | incall-voice | 08 | Operator orb, timer pill, icon dock |
| 12 | incall-video | 09 (mobile 23) | Video fills the panel, dock floats on it |
| 13 | incall-transferring | 10 | |
| 14 | incall-reconnecting | 11 | |
| 15 | ended-rating | 13 | |
| 16 | ended-thanks | 14 | |
| 17 | callback-form | 17 + 18 | Split into two steps |
| 18 | callback-form-scheduled-urgent | 17 (video, schedule, urgent) + 18 | Day chips + time slots replace `datetime-local` |
| 19 | callback-confirmed | 19 | |
| 20 | offline-home | 16 | |
| 21 | error | 15 | Error as a title + callback way out |
| 22 | mobile-launcher | 20 | |
| 23 | mobile-home | 21 | Bottom sheet |
| 24 | mobile-queue | 22 | Full screen |
| 25 | mobile-incall-video | 23 | Full screen |

---

## 2. Frame and layout

### 2.1 Panel

| Property | Value (cc.css) | Production mapping |
|---|---|---|
| Element | `section.cp` (static boards) / `section.cp.lv` (prototype) | `div.ccw-panel.<right\|left>` gets `cp lv` (map §3). Persistent node (brief §2.5) |
| Size | `width:400px; height:660px` (prototype draws it at **384** × 660 because the fake site is 600 wide; build 400 per brief §4) | Keep `max-width: calc(100vw - 24px)`, `max-height: calc(100dvh - 130px)` (brief §4) |
| Radius | `border-radius: var(--r-panel)` (26 / sm 16 / lg 34); `border-end-end-radius: var(--tail)` | WebYar `--tail` = `--r-panel`, so no visible tail. The rule is logical (`end-end`); brief §4 wants the physical anchor corner — irrelevant for WebYar while `--tail` = `--r-panel`, matters only for Respok |
| Background | light screens `#fff` (`.cp`, `.site2 .cp.lv`); stage screens: `.stage-bg` (§3.1); video: `#0A0D10` (`.cp.stage.vid`) | `.ccw-panel` background |
| Shadow | `--sh-panel`: `0 0 0 1px rgba(15,18,23,.05), 0 16px 36px -16px rgba(15,18,23,.24), 0 56px 110px -44px rgba(15,18,23,.42)` | replaces `0 25px 50px -12px hsl(0 0% 0%/.25)` |
| Base text | `font-size:14px; line-height:1.6; color:var(--ink)`; `overflow:hidden; isolation:isolate; display:flex; flex-direction:column` | |
| Stage grain | `.cp.stage::after, .lv .dk::after`: full-cover SVG fractal-noise data-URI, `opacity:.06; mix-blend-mode:overlay; z-index:-1` | inline the same data-URI (no request) |

**Structure (prototype, use this in production):** the panel holds two persistent layers:

```
section.cp.lv  (= .ccw-panel)                      400×660, overflow hidden
  div.ly                                           light layer, position:absolute; inset:0; flex column
    div.scr[.on]  × light screens                  home / pre-call / callback / rating / thanks / error / offline
  div.dk.stage-bg                                  dark layer, position:absolute; inset:0; z-index:3; color:#fff;
                                                   clip-path: circle(0 at var(--cx,26%) var(--cy,56%)) → circle(150% …) when dark
    div.scr.stage[.on][.vid] × stage screens       connecting / queue / call / video / transfer / reconnect / mic blocked
```

`.lv .scr{position:absolute; inset:0; display:flex; flex-direction:column; opacity:0; visibility:hidden}`;
`.lv .scr.on{opacity:1; visibility:visible}` (transitions §6.2). Build each screen's DOM once per state and update text
in place (brief §2.5). For a video call add `background:#0A0D10` to `.dk` (the boards set it on `.cp.stage.vid`).

### 2.2 Regions top → bottom (desktop, 400 × 660, measured in the reference pages)

| Region | Class | Height / box | Padding / gap | Scrolls? | Screens |
|---|---|---|---|---|---|
| Header | `header.hd` | 74 (`height:74px`, flex, `align-items:center`) | `padding-inline: 18px 14px` (start 18 = right in RTL), `gap:12px`; `position:relative; z-index:4` | no | all |
| Context bar | `div.ctx` | 44 (36 button + 8) | `padding:0 14px 8px; gap:8px` | no | 02, 03, 17, 18 |
| Light body | `div.bd` | fills (`flex:1; min-height:0`) | `padding:2px 18px 0` | **`overflow:hidden`** in the design (not specified otherwise; suggestion: `overflow-y:auto` with production's 6px thumb so custom pre-call fields and short viewports still work) | light screens |
| Stage body | `div.sb` | fills | `padding:0 22px`; centred column, `text-align:center` | no (content can overflow: screen 05's queue card ends at y 555 while `.sb` ends at 550) — suggestion: `overflow-y:auto` | stage screens |
| Actions | `div.acts` | 62 (12 + 50 button) | `padding:12px 18px 0; gap:10px` | no | 02, 03, 13, 14, 17, 18, 19 |
| Call dock | `div.dock` | 100 (voice), 70 (`.dock.q` queue) | `padding:14px 20px 2px; gap:24px` (`.q`: `gap:14px; align-items:center`) | no | 04–08, 10, 11 |
| Footer | `a.pw` | 40 | centred, `gap:6px` | no | all (video: absolute, `bottom:4px`) |
| Spacer | inline `div` | 14 (`height:14px; flex:none`) | — | — | 12, 15, 16 (between body and footer when there is no `.acts`) |

Measured y-ranges: home `hd 0–74, bd 74–620, pw 620–660`; forms `hd 0–74, ctx 74–118, bd 118–558, acts 558–620,
pw 620–660`; queue `hd 0–74, sb 74–550, dock 550–620, pw 620–660`; call `sb 74–520, dock 520–620`.

**Z-order inside the panel:** `.feed` `z-index:-2` < grain `::after` `-1` < content < `.vtop`, `.pip`, `.vdock`, `.vid .pw`
`z-index:3` < `.hd` `z-index:4`. Prototype: `.ly` < `.dk` (`z-index:3`).

### 2.3 Placement and launcher (desktop)

Values from the live prototype (`.site2` rules, 04): launcher wrap `.lwp` and panel share the corner; **offset 22px**
from the side and bottom (`right:22px; bottom:22px`), top corners `top:20px`. Production offsets are 20px (map §2.3);
use 22px. Panel opens from the same corner (`transform-origin` per corner, §6.2). The edge tab sits at the vertical
middle (`top:50%; margin-top:-80px; right:0`), its panel at `top:50%; margin-top:-330px; right:22px`. Bottom centre:
not specified numerically (caption only); suggestion: `left:50%; transform:translateX(-50%); bottom:22px`. While the
panel is open the launcher leaves the corner (§6.2). Keep production's `z-index:2147483000`.

### 2.4 Mobile (≤ 640px, board 11, frames 390 × 844)

Map to production's breakpoint rule (`@media (max-width:480px)`, map §3, RCSS:277-284) moved to **640px** (brief §4,
same as the chat widget's mobile sheet). The `.cp.mob` frame, `.notch` and `.homebar` are phone chrome; the values that
make room for them become safe-area insets.

| Element | Board value | Production |
|---|---|---|
| Launcher | `.mln{position:absolute; right:18px; bottom:40px}` holding `.ln-p` (pill, 56 high) | `right:18px`; bottom 40px is drawn above the home bar; suggestion: `bottom: calc(18px + env(safe-area-inset-bottom))` |
| Home | bottom **sheet**: `.scrim` (`inset:0; z-index:5; background:rgba(6,10,12,.46)`) + `.sheet` (`inset-inline:0; bottom:0; z-index:6; height:654px; border-radius:30px 30px 0 0; background:#fff; box-shadow:0 -24px 48px -24px rgba(0,0,0,.45)`); `.grab` 40 × 5, radius 3, `--line-2`, `margin:8px auto 0`; `.sheet .hd{height:68px; padding-top:0; padding-bottom:0}` | `.ccw-panel` at `left:0; right:0; bottom:0`, height 654px capped at `100dvh`; scrim = new element behind it, tap closes (`toggleOpen`) — scrim tap not specified, suggestion |
| Queue, call, video | full screen `.cp.mob.stage`: header `padding-top:58px` (`.cp.mob.stage .hd`; light `.cp.mob .hd`: `height:auto; padding-top:56px; padding-bottom:12px`), `.sb{padding-inline:26px}`, `.dock{padding-bottom:28px}`, `.pw{margin-bottom:22px}` | `inset:0; width:100%; height:100dvh; border-radius:0`. 58px = notch bottom (42) + 16 → suggestion `calc(env(safe-area-inset-top) + 16px)`; 22px footer margin → suggestion `max(env(safe-area-inset-bottom), 8px)` (8px not specified) |
| Video | `.cp.mob.vid .vdock{bottom:74px}`, `.vtop{top:104px}`, `.pip{bottom:150px; width:108px; height:150px}`, `.pw{bottom:22px}` | add `env(safe-area-inset-bottom)` to the three bottoms |
| Queue orb | full `.orb` 204 (desktop queue uses `.orb.sm` 170) | |
| Focus / scroll | not drawn | lock host scroll while full screen and handle `visualViewport` like the chat widget (brief §4) |

Measured mobile: queue `hd 0–114, sb 114–686, dock 686–782, pw 782–822`; sheet `top 190, hd 203–271, bd 271–782,
pw 782–822`.

---

## 3. Tokens

All tokens live on `.cc` in `cc.css` (put them on `.ccw-root`). WebYar has **no** brand-specific rules (`.b-wy`
appears only in a comment), so every base rule of `cc.css` is the WebYar design; `.b-rp` rules are Respok's. Full list
and resolved values: [`tokens.json`](tokens.json).

### 3.1 Colour

| Token | CSS expression | Default (`#0B7D6C`) | Used for | Production source |
|---|---|---|---|---|
| `--a` | workspace primary | `#0B7D6C` | accent: switches on, focus ring, chips on, slots on, step bars, field focus | `widget_theme.primary` hex, set in `applyTheme` (brief §5.1) |
| `--on-a` | `#fff` or `#16142B` (board `lum()`, §3.1.1) | `#FFFFFF` | text on `--a` / `--core` | computed in `applyTheme` |
| `--a-1` | `color-mix(in oklab,var(--a) 6%,#fff)` | `#F2F7F6` | badge, chip on, known card, `.okc`, `.oi2`, motion-row on | derived |
| `--a-2` | `… 12%,#fff` | `#E5EFEC` | badge ring, focus halo (5px), `.oi` video tile, `.sched .si` | derived |
| `--a-3` | `… 26%,#fff` | `#C6DCD7` | chip hover ring, video tile hover ring, `.okc` bloom ring | derived |
| `--a-hi` | `… 82%,#fff` | `#4A9485` | top of `--core` gradient | derived |
| `--a-ink` | `color-mix(in oklab,var(--a) 70%,#0B0D12)` | `#16584F` | accent text on light (badge, `.ct`, chips on, links) | derived |
| `--core` | `linear-gradient(160deg,var(--a-hi),var(--a) 62%,color-mix(in oklab,var(--a) 82%,#000))` | — | primary button, voice tile, launcher, logo tile, orb core, success disc | derived |
| `--core-ink` | `var(--on-a)` | `#FFFFFF` | text/icons on `--core` | derived |
| `--ink` / `--ink-2` / `--ink-3` / `--ink-4` | `#0F1217` / `#3F4551` / `#626A77` / `#A1A7B2` | same | text scale; `--ink-4` placeholders, chevrons, off dots | `text` → `--ink`, `muted` → `--ink-3` (brief §5.4) |
| `--paper` | `color-mix(in oklab,var(--a) 3%,#F4F6F8)` | `#EEF2F4` | ghost button, cards (`.cbr`, `.cons`, `.sumc`, `.kv`), segmented track | board 12 calls it "surface `--ccw-surface`" — see §9.3 |
| `--paper-2` | `… 5%,#EBEEF1` | `#E1E8EA` | hover of `--paper` surfaces | |
| `--line` / `--line-2` | `… 6%,#E7EAEE` / `… 8%,#D4D9DF` | `#DBE3E6` / `#C6D2D5` | dividers / control borders, star off | |
| `--live` / `--live-hi` | `#12A150` / `#3BDC8A` | same | online dot, saved-contact check / dot on the stage, timer dot | `accent` → `--live` (brief §5.4) |
| `--end` | `#E5484D` | | hang-up, `.btn.dg`, recording dot | `danger` → `--end` |
| `--bad` | `#D33A43` | | field errors | `danger` → `--bad` |
| `--warn` / `--warn-ink` / `--warn-bg` | `#E8A317` / `#8A5300` / `#FFF6E1` | | urgent priority, reconnect banner | |
| `--star` | `#F5A524` | | rating | |
| `--glow` | `color-mix(in oklab,var(--a) 42%,#5CF2D6)` | `#3CBFA8` | stage rings, eq bars, spinner arc, offer icon, transfer arrows | derived |
| `--s1` / `--s2` / `--s3` | `color-mix(in oklab,var(--a) 60%,#03110F)` / `… 30%,#03100E` / `… 12%,#020807` | `#0A4E44` / `#072D27` / `#041411` | the call stage | derived |
| Stage background | `.stage-bg`: `radial-gradient(110% 58% at 50% 30%, color-mix(in oklab,var(--glow) 24%,transparent), transparent 72%), linear-gradient(180deg, var(--s1) 0%, var(--s2) 52%, var(--s3) 100%)`; text `#fff` | | `.cp.stage`, `.lv .dk`, `.mc` | |
| Fixed colours | operator avatar `.orb.op .core` `#FCE3D4` / `#8A3410`; avatars `.c1` `#FCE3D4/#8A3410`, `.c2` `#DCE6FB/#1C4A92`, `.c3` `#D2EEDF/#145E39`, `.c4` `#EBE1FA/#57309A`; video bg `#0A0D10`; dark square `#2A2F38 → #0E1116`; stage warn text `#FFDC9A`, stage error icon `#FFA5A8`, recording text `#FFD0D2`; urgent icon `#D98E04`, urgent ring `#F2C14E` | | | not themed |
| `surface` | — | — | brief §5.4 maps `widget_theme.surface` to the light panel background, which the design hard-codes as `#fff` (`.cp`, `.chip`, `.grp`, `.inp`, …) | §9.3 |

**Radius setting** (`data-r` on the boards → production `data-radius` on `.ccw-root`; rewrite `.cc[data-r=sm]` as
`[data-radius=sm]`): `sm` → `--r-panel:16px; --r-card:12px; --r-ctl:9px`; `md` (default, no rule) → `26 / 20 / 14`;
`lg` → `34 / 26 / 19`. `--tail` follows `--r-panel`, `--tail-s` follows `--r-ctl` (tokens.json). Verified against
[`05--radius-sm`](reference/05-starting-a-call--radius-sm.html) / [`--radius-lg`](reference/05-starting-a-call--radius-lg.html).
**Density** `compact` is not drawn (brief §5.6).

#### 3.1.1 Text on the accent

`--on-a` = `#FFFFFF` when `1.05 / (L + 0.05) ≥ (L + 0.05) / (L(#16142B) + 0.05)`, else `#16142B` (WCAG relative luminance
`L`, board `lum()`). All presets give white. **Rules that hard-code `#fff` on the accent instead of `--on-a`** (fix them):
`.mn .it.on .curve{color:#fff}` (motion-list icon on `--a`); board 12 brand previews `.bp` (inline `--core-ink:#fff` and
`.btn.pri.sm` inline `color:#fff`); `.sw.on::after` knob `#fff` on `--a` (non-text, keep). White translucent overlays on
accent surfaces (`.opt.voice .oi/.go/.rw`, `.ln-p .pi`, `.ln-s .hf.pri`, `.ld` rings) vanish on light accents — use
`color-mix(in oklab, var(--on-a) 18%, transparent)` (suggestion). The stage text is always `#fff`; with a light custom
accent the stage gets lighter: measured white on `--s1` = 4.26:1 for `#FACC15`, 4.19:1 for `#A3E635` (9.61:1 for the
default), and `--a-ink` on `--a-1` = 3.17:1 for `#FACC15` (7.63:1 default). Not specified by the design; flag in QA.

### 3.2 Typography

Font: `--font: "Vazirmatn", ui-sans-serif, system-ui, sans-serif`, weights 400/500/600/700 (shared fonts asset
`#gs-presentation-fonts`, [`../../shared/fonts/`](../../shared/fonts/)). Reference code: `ui-monospace, "SF Mono", Menlo,
monospace`. `.num` / timers: `font-variant-numeric: tabular-nums`. Two rules ask for weight 800 (`.ql .me`, `.ql2 .me`):
Vazirmatn 800 is not shipped, so it renders 700.

| Role | Size / line-height / weight / letter-spacing | Classes |
|---|---|---|
| Timer | 30 / 1 / 700 / .01em, tnum | `.tmr b` |
| Operator initial | 48 / 1 / 700 (xs orb 28) | `.orb.op .core` |
| Home title | 25 / 1.45 / 700 / -.01em, `text-wrap:balance` | `.hh` (board 12 says lh 1.3) |
| Stage title | 21 / 1.5 / 700 / -.005em | `.sh` (board 12 says lh 1.4) |
| Centred-state title | 21 / 1.5 / 700 | `.ctr h3` |
| Operator name | 21 / 1.45 / 700 | `.who-c .nm` |
| Rating title | 20 / 1.5 / 700 | `.rate h3` |
| Tile title | 16 / 1.4 / 700 | `.opt .ol b` |
| Header title | 15 / 1.45 / 700, ellipsis | `.hx .nm` |
| Card title | 15 / 1.45 / 700 | `.known b`, `.sumc b`, `.qs b` (tnum) |
| Buttons | 15 / 1 / 700 (`.btn.sm` 13.5; `.offer .btn` 14; `.mbar .btn` 13.5) | `.btn`, `.xbtn` |
| Inputs | 14.5 / 1.5 / 500; placeholder 400 `--ink-4` | `.fr .v`, `.inp input` |
| Row title | 14.5 / 1.45 / 700 | `.cbr b` |
| Call timer pill | 14.5 / — / 700, tnum | `.ctm` |
| Body / textarea | 14 / 1.85 (`.hs`) / 1.6 (`.ta`) | `.hs`, `.ta` |
| Stage body | 13.5 / 1.8, `rgba(255,255,255,.68)` | `.sp` |
| Segmented / kv / offer | 13.5 / — / 700 (`.seg button`); 13.5 (`.kv .r`); 13.5 / 1.65 / 600 (`.offer p`) | |
| Chip | 13 / 1 / 600 | `.chip` |
| Consent / reconnect / video top | 13 / 1.6 (`.cons .tx`); 13 / 1.5 / 600 (`.bnr`); 13 / 700 (`.vtop`) | |
| Rating sub | 13 / 1.6 | `.rate p` |
| Field label (outside) | 12.5 / 1.4 / 700, `--ink-2` | `.lb` |
| Header status | 12.5 / 1.45 / 400, `--ink-3` | `.hx .st` (board 12 "توضیح" says 12 / 500) |
| Pill / context chip | 12.5 / 1 / 600 (`.pill`); 12.5 / 700 (`.ct`) | |
| Messages | 12.5 / 1.5 / 600 (`.msg`); 12 / 1.6 (`.note`, `.rnote`); 12.5 / 1.55 (`.permit`); 12.5 / 1.6 (`.inl`); 12.5 / 1.7 (`.dn .how`) | |
| Badge / trust / step | 12 / 700 (`.badge`, `.chn` 500); 12 / 1.4 / 600 (`.trust li`); 12 / 600 (`.stp`) | |
| Group-field label | 11.5 / 1.4 / 600, `--ink-3`; required `*` `--bad` | `.fr label` |
| Small stage labels | 11.5 / 1.5, `rgba(255,255,255,.56)` (`.qs small`); 11.5 / 1.3 / 600 (`.cbn`); 11.5 (`.pw`, `.lb em`) | |
| Tiny | 11 / 700 (`.cons .tx em`), 10.5 / 700 (`.pip .me-l`) | |
| Code | 13, `letter-spacing:.06em`, mono, `direction:ltr; unicode-bidi:isolate` | `.code` |

### 3.3 Radii

| Token / value | Elements |
|---|---|
| `--r-panel` 26 (16 / 34) | panel |
| `--r-card` 20 (12 / 26) | `.opt`, `.cbr`, `.known`, `.sumc`, `.kv`, `.qc`, `.offer`, `.addr` |
| `--r-ctl` 14 (9 / 19) | `.btn`, `.grp`, `.fr` focus, `.inp`, `.ta`, `.cons`, `.permit`, `.sumchip`, `.bnr`, `.rnote`; `.seg` = `--r-ctl + 2`, `.seg button` and `.btn.sm` = `--r-ctl − 2` |
| Fixed | `.lg` 14 · `.ib` 12 · `.lang` 10 · `.opt .oi` 15 · `.cbr .it` 13 · `.sumchip .it` 10 · `.ed` 10 · `.slots .chip` 12 · `.cons em` 5 · `.cpy` 8 · `.ei` 26 (stage `.dn .ei` 50%) · `.oi2` 28 · `.star` 14 · `.addr .bar` 11 · `.addr .pop` 13 · `.pip` 18 · `.mvid` 18 · `.vdock .bt.end` 26 · `.sheet` 30 30 0 0 · `.xbtn` 27 · `.sw` 14 · 999 / 50% for pills, chips, dots, circles |
| Launchers | `.ln-c` 50% · `.lbl` 16 16 6 16 (§4.1) · `.ln-p` 28 · `.ln-r` 20 (`.go2` 15) · `.ln-s` 18 (`.hf` 14) · `.ln-t` 16 0 0 16 · `.ln-q` 19 · `.mc` 30 · `.sched` 28 |

### 3.4 Shadows / elevation

| Token / rule | Value | Used on |
|---|---|---|
| `--sh-panel` | see §2.1 | panel (board 12 "پنل") |
| `--sh-card` | `0 0 0 1px rgba(15,18,23,.05), 0 2px 4px -1px rgba(15,18,23,.05), 0 14px 32px -16px rgba(15,18,23,.26)` | launcher label `.lbl` (board 12 "کارت") |
| `--sh-ln` | `0 14px 30px -10px color-mix(in oklab,var(--a) 60%,transparent), 0 3px 8px rgba(15,18,23,.14)` | `.ln-c`, `.ln-p`, `.ln-s` (+ `inset 0 1px 0 rgba(255,255,255,.25)` / `.22` / `.2`) |
| Primary button | `0 10px 22px -12px color-mix(in oklab,var(--a) 85%,transparent), inset 0 1px 0 rgba(255,255,255,.2)`; hover `0 14px 26px -12px … 90% …` | `.btn.pri` |
| Danger | `0 10px 22px -12px color-mix(in oklab,var(--end) 85%,transparent)`; end call `0 14px 28px -10px … 85% …, inset 0 1px 0 rgba(255,255,255,.25)`; `.xbtn` `0 14px 28px -12px … 85% …, inset 0 1px 0 rgba(255,255,255,.22)` | |
| Voice tile | `0 18px 34px -16px color-mix(in oklab,var(--a) 80%,transparent), inset 0 1px 0 rgba(255,255,255,.22)` | `.opt.voice` |
| Logo tile | `0 8px 16px -8px color-mix(in oklab,var(--a) 70%,transparent), inset 0 1px 0 rgba(255,255,255,.25)`; on stage `0 0 0 1px rgba(255,255,255,.16), 0 8px 18px -8px rgba(0,0,0,.6)` | `.lg` |
| Orb core | `0 0 0 10px rgba(255,255,255,.035), 0 0 0 22px rgba(255,255,255,.02), 0 26px 60px -14px color-mix(in oklab,var(--glow) 60%,transparent), inset 0 1px 0 rgba(255,255,255,.32)` | `.orb .core` |
| Glass on stage | inset `0 0 0 1px rgba(255,255,255,.08–.14)` + `backdrop-filter: blur(12–18px)` | `.pill`, `.cbn .bt`, `.vtop`, `.vdock`, `.qc`, `.offer` |
| Minimised bars | `.mc` `0 18px 34px -12px rgba(0,0,0,.55), inset 0 0 0 1px rgba(255,255,255,.08)`; `.mvid` `0 0 0 1px rgba(15,18,23,.1), 0 22px 40px -16px rgba(0,0,0,.6)`; `.sched` `0 0 0 1px var(--line), 0 18px 34px -16px rgba(15,18,23,.4)` | |

### 3.5 Spacing rhythm

Panel side padding 18 (light) / 22 (stage) / 26 (mobile stage). Form stack gap 14 (`.fm`); label → field 7
(`.lb` margin-bottom); chip gap 8; action gap 10; tile gap 12; dock gap 24 (queue dock 14); header gap 12; card padding
12–16 (`.cbr` 12 14, `.known` 12 14, `.sumc` 14, `.qc` 14 16 12, `.offer` 14). Vertical stage rhythm: `.orb` margin
`12px 0 4px` (`.sm` margin-top 6), `.sh` margin `4px 0`, `.tmr` margin-top 14, `.qc` margin-top 16, `.offer` margin-top 14.

### 3.6 Icons

Inline SVG from [`../../shared/icons/`](../../shared/icons/README.md): 24 × 24 viewBox, `fill:none`,
`stroke:currentColor`, round caps and joins. The boards set size and stroke per use:

| Use | Icon file | Size | Stroke |
|---|---|---|---|
| Launcher glyph (`.ln-c`, `.ln-q`) | `phone.svg` | 26 / 24 | 1.9 |
| Pill / card / tab / split | `phone.svg`, `video.svg` | 22 / 22 / 20 / 19 | 1.9 |
| Offline launcher, callback row, callback buttons | `phone-in.svg` | 26 / 20 / 18 | 1.9 / 1.8 / 2 |
| Header collapse | `chev-d.svg` | 20 | 2 |
| Language | `globe.svg` | 15 | 1.8 |
| Tile icons / tile arrow | `phone.svg`, `video.svg` / `arrow-f.svg` (`.dirf`) | 22 / 16 | 1.9 / 2.2 |
| Row chevron | `chevron-forward.svg` (`.dirf`) | 18 | 2 |
| Trust row | `shield.svg`, `users.svg`, `bolt.svg` | 16 | 1.8 |
| Form back / context chip | `back.svg` (`.dirf`) / `phone.svg`, `video.svg`, `phone-in.svg` | 18 / 15 | 2 |
| Chip check, saved check | `check.svg` | 15 / 14 | 2.4 / 2.6 |
| Consent | `lock.svg` | 18 | 1.8 |
| Error line / info note | `warn.svg` / `info.svg` | 16 / 14–16 | 2 / 1.8–2 |
| Orb core | `phone.svg` | 46 (`.sm` 40, `.xs` 28) | 1.7 |
| Queue operator dot, transfer target | `headset.svg` | 17 / 30 | 1.8 / 1.7 |
| Sound toggle | `vol.svg` / `vol-x.svg` | 22 (timer button 17) | 1.9 |
| Hang-up | `hangup.svg` | 28 dock, 26 video dock, 22 cancel, 20 / 17 minimised | 2 / 2.1 |
| Mic / mic off | `mic.svg` / `mic-off.svg` | 24 dock, 22 video, 18 / 15 minimised, 34 blocked | 1.9 / 2 / 1.8 |
| Camera / off | `video.svg` / `video-off.svg` | 22–24 | 1.9 |
| Minimise / restore | `mini.svg` / `expand.svg` | 22 dock, 20 video / 17 bar, 14 mini video | 1.9 / 2 / 2.2 |
| Signal / reconnect | `signal.svg` / `wifi-off.svg` | 15 | 2.2 / 2 |
| Rating | `star.svg` | 36 (mini 16–18) | 1.6 |
| Success / retry / copy / calendar / clock / moon | `check.svg` / `retry.svg` / `copy.svg` / `cal.svg` / `clock.svg` / `moon.svg` | 32 / 18 / 15 / 16–20 / 15 / 16 | 2.6 / 2 / 1.9 / 1.9–2 / 1.9 / 1.9 |
| Footer mark | [`webyar-mark-dots.svg`](../../shared/brand/webyar/webyar-mark-dots.svg) | 11 × 15 | fill |

Mirroring: `[dir=rtl] .dirf{transform:scaleX(-1)}` on `arrow-f`, `chevron-forward`, `back` (and the transfer chevrons).

### 3.7 Motion tokens

| Token | Value |
|---|---|
| `--ease` | `cubic-bezier(.2,.9,.25,1)` |
| `--ease-in` | `cubic-bezier(.55,0,.75,.2)` |
| `--spring` | `linear(0, 0.044 4.2%, …, 1)` (full list in tokens.json); fallback `cubic-bezier(.2,.9,.25,1)` (brief §7) |
| `--bounce` | `linear(0, 0.059 3.3%, …, 1)` (tokens.json); same fallback |
| Board 12 "حرکت" | «باز شدن، فنری» ۵۲۰ ms · «رفتن، شتاب‌دار» ۲۶۰ ms · «تپش حلقه‌ها» ۲۴۰۰ ms · «ورود پشت‌سرهم» ۶۰ ms (CSS uses 70 ms) · «هاله‌ی صدا» ۱۶۰۰ ms · «کاهش حرکت» «فقط محو شدن» |

---

## 4. Components

Use the design class names inside the shadow root (they are scoped) and add the production hook classes the brief keeps
(`ccw-root`, `ccw-launcher-wrap`, `ccw-launcher-btn`, `ccw-panel`, `ccw-footer`, `ccw-powered`, `left`/`right`). Every
dimension below is from `cc.css`.

### 4.1 Launchers (board 01, states board 03)

Common: `.ln` (`position:relative; padding:0; border:0; line-height:1; -webkit-tap-highlight-color:transparent`).
Status dot `.ln .ls`: 14 × 14 circle at `top:1px; inset-inline-end:1px`, `--live`, ring `0 0 0 2.5px #fff`; offline
`.ls.off`: `#fff` + `inset 0 0 0 2.5px var(--ink-4)`. Wave `.ln .wv`: `inset:0; z-index:-1; border-radius:inherit`, `cc-lnwave
3.6s var(--ease) infinite`. Production: wrap = `.ccw-launcher-wrap` (positioned, §2.3), button = `.ccw-launcher-btn`,
click → `toggleOpen()`; `aria-label` «باز کردن ویجت تماس» (+ `aria-expanded`, brief §7). Card captions are spec:

| # | Style · caption | Anatomy and exact values |
|---|---|---|
| L1 | «دایره‌ای» — «کلاسیک و کم‌جا؛ برای بیشتر سایت‌ها مناسب است.» | `.ln-c` 60 × 60 circle, `--core`, `--core-ink`, `--sh-ln` + inset highlight; phone 26 with `.wig` (`cc-wiggle 3.6s ease-in-out infinite`); `.ls`; `.wv`. Hover `translateY(-3px) scale(1.05)`, active `scale(.94)`, `transition: transform .3s var(--ease), box-shadow .3s ease` |
| L2 | «دایره با برچسب» — «برچسب کنار دکمه، دعوت به تماس را روشن می‌کند.» (**default**, prototype `style:'cl'`) | `.ln-cl` (`display:flex; align-items:center; gap:12px; direction:ltr`) = `.lbl` + `.ln-c`. `.lbl` (`dir="rtl"`): `padding:10px 14px`, radius `16px 16px 6px 16px` (the 6px corner points at the button), `#fff`, `--sh-card`, `nowrap`, entrance `cc-lbl .6s var(--spring) .4s backwards`; `b` «همین حالا تماس بگیرید» 13.5/700 `--ink`; `small` 12 `--ink-3` with `.dot` + «پشتیبانی آنلاین». Close `.lbl .x`: 22 circle at `top:-8px; left:-8px` (`.at-l`: `right:-8px`), `#fff`, `--ink-3`, `0 0 0 1px var(--line), 0 4px 8px -4px rgba(15,18,23,.3)`, `x.svg` 12 / 2.6, `aria-label` «بستن». Label corner per placement: bottom left `16 16 16 6` (+ `flex-direction:row-reverse`), top right `16 6 16 16`, top left `6 16 16 16`. Clicking the label opens too (prototype) |
| L3 | «کپسولی» — «آیکون و متن در یک دکمه؛ واضح‌ترین دعوت.» | `.ln-p`: height 56, `padding-inline:6px 20px`, radius 28, `--core`, `--sh-ln`, 15/700, gap 10; `.pi` 44 circle `rgba(255,255,255,.18)` + phone 22; text «تماس با پشتیبانی»; `.ld` 8 circle `--live-hi` + `0 0 0 3px rgba(255,255,255,.22)`, `margin-inline-start:2px`; `.wv`. Hover `translateY(-3px)`. Small `.ln-p.sm`: 48 high, gap 8, `padding-inline:5px 16px`, 14px, `.pi` 38 (placement P7) |
| L4 | «مستطیلی» — «کارت کوچکی با چهره‌ی اپراتورها؛ انسانی و حرفه‌ای.» | `.ln-r`: 300 × 72, `padding-inline:14px 10px`, radius 20, `#fff`, `0 0 0 1px rgba(15,18,23,.06), 0 22px 40px -22px rgba(15,18,23,.45)`, gap 12; `.avs` 3 operator avatars 32 (overlap `-9px`, ring `2.5px #fff`); `.tx` `b` «با تیم ما صحبت کنید» 14/700, `small` 12 `--ink-3` `.dot` + «اپراتورها آماده‌اند»; `.go2` 50 × 50 radius 15 `--core` + phone 22, shadow `0 8px 16px -8px color-mix(in oklab,var(--a) 80%,transparent)` |
| L5 | «دوتکه: صوتی و تصویری» — «تماس صوتی یا تصویری مستقیم از روی صفحه شروع می‌شود.» | `.ln-s` (`role="group"` `aria-label` «تماس با ما»): height 56, `padding:4px`, radius 18, `--core`, `--sh-ln`; two `button.hf` (`padding:0 16px`, radius 14, 14/700, gap 8): `.hf.pri` (`rgba(255,255,255,.17)` + inset `.12`) phone 19 «تماس صوتی»; divider `.dv` 1px, `margin:12px 2px`, `rgba(255,255,255,.22)`; `.hf` video 19 «تصویری». Hover `.24`. Each half opens the panel **and** calls `startCall('voice'\|'video')` synchronously (ringback needs the gesture) |
| L6 | «زبانه‌ی کناری» — «به لبه‌ی صفحه می‌چسبد و جای محتوا را نمی‌گیرد.» | `.ln-t`: width 50, `padding:14px 0 16px`, column, gap 12, radius `16px 0 0 16px` (left edge `.at-l`: `0 16px 16px 0`), `--core`, shadow `-10px 12px 28px -12px color-mix(in oklab,var(--a) 70%,transparent)` (`.at-l` `10px …`); phone 20; `.vt` «تماس با ما» 14/700, `letter-spacing:.01em`, `writing-mode:vertical-rl; transform:rotate(180deg)` (`.at-l`: no rotate); `.ld`. Hover `translateX(-4px)` (`.at-l` `+4px`) |
| L7 | «مربع تیره» — «برای سایت‌های مینیمال و تیره.» | `.ln-q`: 58 × 58, radius 19, `linear-gradient(160deg,#2A2F38,#0E1116)`, `#fff`, `0 14px 28px -10px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.12), inset 0 0 0 1px rgba(255,255,255,.06)`; phone 24; `.ls` at `top:-3px; inset-inline-end:-3px` in `--glow`, ring `0 0 0 2.5px #11141A, 0 0 12px 2px color-mix(in oklab,var(--glow) 60%,transparent)`. Hover `translateY(-3px)` |
| L8 | «چهره‌ی اپراتور» — «عکس اپراتور به‌جای آیکون؛ دعوتی شخصی‌تر.» | `.ln-f` (`direction:ltr`, gap 12) = `.lbl` (`b` «همین حالا تماس بگیرید», `small` `.dot` + operator name) + `button.fp` 64 circle: `.pic` photo (`overflow:hidden`, ring `0 0 0 3px #fff, 0 14px 28px -10px rgba(15,18,23,.5)`), `.ring2` (`inset:-6px`, `2px solid var(--live)`, `cc-ring 2.4s var(--ease) infinite`), `.pb` 28 badge at `bottom:-3px; right:-4px` `--core` ring `3px #fff` + phone 14 / 2.2 |
| L9 | «نوار پایین موبایل» — «دو دکمه‌ی بزرگ در دسترس انگشت شست.» | `.mbar`: `position:absolute; inset-inline:0; bottom:0; z-index:4; display:flex; gap:8px; padding:10px 10px 20px; background:rgba(255,255,255,.94); box-shadow:0 -1px 0 var(--line), 0 -14px 28px -18px rgba(15,18,23,.35); backdrop-filter:blur(12px)`; `.btn` flex 1, height 46, `padding:0 10px`, 13.5: `.btn.pri` phone 17 «تماس صوتی» → `startCall('voice')`; `.btn.sec` phone-in 17 «درخواست تماس» → `openCallback()`. Bottom padding 20 sits above the drawn home bar; suggestion `calc(10px + env(safe-area-inset-bottom))` |

**Launcher states (board 03, captions are spec):**

| State | Caption | Spec |
|---|---|---|
| Sa ready | «آماده» — «نقطه‌ی سبز یعنی اپراتورها آنلاین‌اند. هر چند ثانیه یک موج آرام دور دکمه می‌چرخد.» | L1 with `.ls` (`isOnline()`), `.wv` wave, `.wig` |
| Sb hover | «نشانگر روی دکمه» — «لوگوی کسب‌وکار به آیکون تماس می‌چرخد و برچسب باز می‌شود.» | Drawn as L2 with a cursor; hover = L1 hover transform; with a logo it flips (Sc). "Label opens" on hover: L2 shows the label permanently; for L1 the label on hover is not drawn |
| Sc business logo | «با لوگوی کسب‌وکار» — «لوگوی خود مشتری روی دکمه؛ با نشانگر به آیکون تماس می‌چرخد.» | `.ln-c.logo`: `#fff`, `color:var(--a)`, `0 0 0 1px var(--line), 0 14px 28px -12px rgba(15,18,23,.4)`; `.fc` (`display:grid; width:100%; height:100%; transform-style:preserve-3d`) with `.f1` = logo (`config.avatar_url` image, or letter 24/700 «ف» = sample) and `.f2` (`transform:rotateY(180deg)`, `--core` + phone 26), both `backface-visibility:hidden`, 50%. Hover → `.fc.flipped{transform:rotateY(180deg)}`; flip duration not specified (the board loops `cc-flip 4.4s var(--spring)`; one flip there takes 12% = 528ms → suggestion `transition: transform .52s var(--spring)`). Both faces have a 2x crop: `--c-business-logo.png` (logo) and `--c-business-logo-flipped.png` (phone) |
| Sd offline | «آفلاین» — «رنگ آرام‌تر می‌شود و آیکون «درخواست تماس» جای تماس را می‌گیرد.» | `.ln-c.off`: `linear-gradient(160deg,#fff,#EEF0F3)`, `--ink-2`, `0 0 0 1px var(--line-2), 0 12px 26px -12px rgba(15,18,23,.35)`; icon `phone-in` 26, **no** wiggle, **no** wave; `.ls.off`; label `b` «درخواست تماس» (`callback`), `small` `.dot.off` + «ثبت اطلاعات» (`leave_details`); `aria-label` «درخواست تماس». Click → `toggleOpen()` (panel shows 16) |
| Se in line, minimised | «در صف، پنل کوچک‌شده» — «جایگاه در صف و زمان انتظار روی خود دکمه.» | `.mc.stage-bg` (`role="status"`): height 60, `padding-inline:6px 8px`, radius 30, gap 10, `#fff`; `.mo` 48 circle `--core` + phone 22 (wiggle 2.4s) with two `cc-ring` rings (`::before`, `::after` delay 1.2s, `1.5px solid var(--glow)`); `.tx`: `b` «نفر ۳ صف» (13.5/700), `small` «زمان انتظار ۰:۴۷» (12/600, `.66`, tnum); `.mbt` 40 circle `rgba(255,255,255,.12)` expand 17 `aria-label` «باز کردن تماس» → `toggleOpen()`; `.mbt.end` (`--end`) hang-up 20 `aria-label` «لغو تماس» → `cancelCall()`. Position 1: title «نفر بعدی» (prototype) |
| Sf on a call, minimised | «در تماس، پنل کوچک‌شده» — «زمان تماس، بی‌صدا کردن و پایان، بدون باز کردن پنل.» | `.mc` with `.av` 48 operator initial (`.c1`, 18px) ring `0 0 0 3px color-mix(in oklab,var(--glow) 55%,transparent)`, `cc-talk 1.6s ease-in-out infinite alternate`; `.tx` `b` operator name, `small` «۲:۱۴»; `.wvs` 5 bars 3 × 16 `--glow` (`cc-eq .8s`, delays 0, -.2, -.5, -.35, -.1s); `.mbt` mic 18 `aria-label` «بی‌صدا» → `toggleMic()`; `.mbt.end` `aria-label` «پایان تماس» → `cancelCall()`. Board 03 shows mute + end and the first name «سارا»; the prototype shows restore + end and the full name — see §9.3; build board 03's buttons and add restore by tapping the bar body (suggestion) |
| Sg video, minimised | «تماس تصویری کوچک‌شده» — «تصویر اپراتور در یک پنجره‌ی کوچک روی صفحه می‌ماند.» | `.mvid` (`role="status"` `aria-label` «تماس تصویری کوچک‌شده»): 188 × 122, radius 18, `#0A0D10`, `0 0 0 1px rgba(15,18,23,.1), 0 22px 40px -16px rgba(0,0,0,.6)`; `.feed` (`z-index:0`) = the remote `<video>`; `.rd` 8 `--end` at `top:9px; inset-inline-start:9px` blinking; `.exp` 26 radius 8 at `top:6px; inset-inline-end:6px` `rgba(10,12,14,.4)` expand 14 (make it a `button` «باز کردن تماس» → `toggleOpen()`); `.bar3` at `inset-inline:8px; bottom:8px`, gap 6: `.t` «۲:۱۴» 11.5/700 tnum, mic button 30 (`rgba(10,12,14,.45)`, blur 8) «بی‌صدا», end button «پایان تماس» |
| Sh callback booked | «درخواست تماس ثبت‌شده» — «زمان تماس برگشتی تا آن موقع روی دکمه می‌ماند.» | `.sched` (`role="status"`): height 56, `padding-inline:6px 18px`, radius 28, `#fff`, gap 10; `.si` 44 circle `--a-2` / `--a-ink` + `cal` 20; `b` «درخواست تماس ثبت شد» 13.5/700; `small` «فردا ۱۶:۳۰» 12 `--ink-3`. Click → `toggleOpen()` (suggestion: show 19) |

### 4.2 Panel header

`header.hd` (§2.2): logo tile `.lg` 44 × 44, radius 14, `--core`, `--core-ink`, 19/700 (initial; production
`config.avatar_url` image fills it, `object-fit:cover` suggested), shadow §3.4; `.hx` column: `.nm` = `config.display_name`
(fallback `support` «پشتیبانی») 15/700 ellipsis; `.st` 12.5 `--ink-3`, gap 7: `.dot` (8 circle `--live` + `cc-ping 2.4s`
halo) + «اپراتورها آماده‌اند» (`operators_available`) or `.dot.off` (`transparent` + `inset 0 0 0 2px var(--ink-4)`, no
halo) + «میز درخواست تماس» (`callback_desk`), following `isOnline()` only (map §4.10). Language `.lang` (only when
`availableLocales.length > 1`): 32 high, `padding:0 10px`, radius 10, `--paper`, 12/700 `--ink-2`, globe 15 `--ink-3`,
label «فا» (`aria-label` «زبان ویجت»); the list it opens is not drawn — keep production's `select` behaviour inside
this pill look (`setLocale(code)` on change). Collapse `.ib` 38 × 38, radius 12, transparent, `--ink-2`, chevron 20
(`aria-label` «کوچک کردن», fixes A3.14); hover `--paper`, active `scale(.92)` → `toggleOpen()`.
On the stage: `.stage .ib` `rgba(255,255,255,.08)` + inset `.08`, `rgba(255,255,255,.92)` (hover `.15`); `.stage .hd .st`
`rgba(255,255,255,.66)`; `.stage .dot` `--live-hi`; `.stage .lg` adds `0 0 0 1px rgba(255,255,255,.16), 0 8px 18px -8px rgba(0,0,0,.6)`.
Video: `.vid .hd{background:transparent}`. `.hd.ln` (`box-shadow:0 1px 0 var(--line)`) exists but no screen uses it.

### 4.3 Home: badge, title, call choices, callback row, trust row

- `.badge` (online): height 28, `padding-inline:10px 12px`, radius 999, `--a-1`, `inset 0 0 0 1px var(--a-2)`, 12/700
  `--a-ink`, gap 8; `.dot` + «آنلاین» + `.sep` (3 circle `--ink-4`) + `.chn` (500, `--ink-3`) «صوتی · تصویری · درخواست تماس».
- `.hh` margin `14px 0 6px`; `.hs` `max-width:340px`.
- `.opts` grid 2 columns, gap 12, `margin-top:24px`. `.opt` 178 high, padding 16, radius `--r-card`, column with content
  at the bottom, gap 12, `text-align:start`; `.oi` 46 radius 15 (`margin-bottom:auto`); `.go` 30 circle at
  `top:16px; inset-inline-end:16px` with `arrow-f` 16 (`.dirf`); `.ol b` 16/700, `small` 12/500.
  Hover `translateY(-3px)` (+ `.go` `translateX(3px)`, RTL `-3px`), active `scale(.97)`.
  - `.opt.voice` (first in DOM = right in RTL): `--core`, `--core-ink`, shadow §3.4; `.oi` `rgba(255,255,255,.18)` +
    inset `.16`; `small` `opacity:.84`; `.go` `rgba(255,255,255,.16)`; three `.rw` rings (180 circle at
    `inset-block-start:-60px; inset-inline-end:-60px`, `1.5px solid rgba(255,255,255,.22)`, `cc-tile 3.6s`, delays
    0 / 1.2 / 2.4s). «تماس صوتی» / «با میکروفون مرورگر». → `startCall('voice')`.
  - `.opt.video`: `#fff`, `--ink`, `inset 0 0 0 1px var(--line-2), 0 1px 2px rgba(15,18,23,.04)`; hover
    `inset 0 0 0 1px var(--a-3), 0 16px 30px -18px rgba(15,18,23,.35)`; `.oi` `--a-2` / `--a-ink`; `small` `--ink-3`;
    `.go` `--paper` / `--ink-2`. «تماس تصویری» / «با دوربین و میکروفون». → `startCall('video')`.
- `.cbr` (callback row): `margin-top:12px; padding:12px 14px`, radius `--r-card`, `--paper` (hover `--paper-2`), gap 12;
  `.it` 40 radius 13 `#fff` `--a-ink` ring `0 0 0 1px var(--line)` + `phone-in` 20; `b` «درخواست تماس» 14.5/700;
  `small` «راه ارتباطی را وارد کنید؛ تیم ما سریع تماس می‌گیرد.» 12.5 `--ink-3`; chevron 18 `--ink-4` `.dirf`.
  → `openCallback()`; shown when `caps.callback && callback_policy.show_when_online !== false` (map §4.2).
- `.trust`: `margin-top:auto; padding:14px 4px 4px; border-top:1px solid var(--line)`, `justify-content:space-between`;
  `li` 12/600 `--ink-3`, gap 6, icons 16 `--a`: shield «خط امن», users «مدیریت صف», bolt «اتصال سریع».

### 4.4 Forms

- Context bar `.ctx`: back `.ib` 36 with `--paper` (`back.svg` 18 `.dirf`, `aria-label` «بازگشت», → `reset()` on 02/03 and
  17; → step 1 on 18), `.ct` chip (30 high, `padding:0 12px`, radius 999, `--a-1` + inset `--a-2`, 12.5/700 `--a-ink`, icon
  15, gap 7), `.stp` (`margin-inline-start:auto`, 12/600 `--ink-3`, gap 8) «قدم ۱ از ۲» + `.bars` (two 16 × 4 radius 2,
  gap 4, `--line-2`, `.on` `--a`).
- `.fm` column gap 14, `padding-top:2px`. `.lb` label (`margin:0 2px 7px`; `em` optional hint at the end 11.5/600).
- Chips `.chips` (wrap, gap 8, `role="group"`): `.chip` 36 high, `padding:0 14px`, radius 999, `#fff`,
  `inset 0 0 0 1px var(--line-2)`, 13/600 `--ink-2`; hover ring `--a-3`; active `scale(.95)`; `.on` `--a-1` +
  `inset 0 0 0 1.5px var(--a)` + `--a-ink` and a leading check 15 in `--a`; `.dis` `--paper`, no ring, `--ink-4`,
  `line-through`. `aria-pressed` on each.
- Group `.grp` (radius `--r-ctl`, `#fff`, `inset 0 0 0 1px var(--line-2)`): `.fr` rows `min-height:52px; padding:6px 14px`,
  divider `.fr + .fr::before` (1px `--line`, `inset-inline:14px 0`); `label` above `input.v`; `*` in `<i>` `--bad`.
  Focus `.fr:focus-within`: `z-index:1`, radius `--r-ctl`, `0 0 0 1.5px var(--a), 0 0 0 5px var(--a-2)`, neighbouring
  dividers hidden. Email/tel: `dir="ltr"` + `.ltrv` (`text-align:right` in RTL).
- Single field `.inp`: `min-height:46px; padding:0 14px`, radius `--r-ctl`, `#fff`, ring `--line-2`, 14.5; focus as
  above. Error (board 12 inline style, no class — add `.inp.err`): `box-shadow: inset 0 0 0 1.5px color-mix(in oklab,var(--bad) 55%,#fff); background: color-mix(in oklab,var(--bad) 5%,#fff)`.
- Textarea `.ta`: `min-height:58px; padding:11px 14px`, radius `--r-ctl`, ring `--line-2`, 14 / 1.6, `resize:none`.
- Segmented `.seg`: `padding:4px; gap:4px`, radius `--r-ctl + 2`, `--paper`; buttons flex 1, 40 high, radius
  `--r-ctl − 2`, 13.5/700 `--ink-3`, gap 7; `.on` `#fff` `--ink` `0 1px 2px rgba(15,18,23,.08), 0 4px 12px -4px rgba(15,18,23,.14)`,
  icon `--a`; `.on.urg` `--warn-bg` / `--warn-ink` / `inset 0 0 0 1.5px #F2C14E`, icon `#D98E04`. `aria-pressed`.
- Consent `.cons`: `padding:10px 14px`, radius `--r-ctl`, `--paper`, gap 12; lock 18 `--ink-3`; `.tx` 13 / 1.6 `--ink-2`
  + `em` «الزامی» (inline chip, `#fff`, ring `--line`, radius 5, 11/700, line-height 18, `margin-inline-start:4px`);
  switch `.sw` (`role="switch"`, `aria-checked`, `aria-labelledby` → `.tx`): 46 × 28, radius 14, `--line-2`; knob 22
  `#fff` at `top:3px; inset-inline-start:3px`, `0 2px 4px rgba(15,18,23,.22)`; `.on` `--a`, knob `translateX(18px)`
  (RTL `-18px`, `.32s var(--spring)`). Error `.cons.err`: `color-mix(in oklab,var(--bad) 6%,#fff)` +
  `inset 0 0 0 1.5px color-mix(in oklab,var(--bad) 50%,#fff)`, lock `--bad`, switch ring `0 0 0 2px #fff, 0 0 0 3.5px color-mix(in oklab,var(--bad) 60%,#fff)` + `cc-nudge .5s var(--ease) .6s` × 2.
  Production: the checkbox `formData.consent` (map §4.4); when consent is not required show the passive line
  `call_may_record` (not drawn; suggestion `.note`).
- Messages: `.msg.err` (`role="alert"`, `margin:-8px 2px 0`, 12.5/600 `--bad`, warn 16) = the single `controller.error`
  slot; `.note` (`margin:-6px 2px 0`, 12 `--ink-3`, info 14); `.permit` (`padding:10px 12px`, radius `--r-ctl`, `--paper`,
  12.5 / 1.55 `--ink-3`, `.ics` video + mic 16 `--ink-2`).
- Known contact `.known`: `padding:12px 14px`, radius `--r-card`, `--a-1` + inset `--a-2`, gap 12; `.av.s44.c3` initial;
  `b` name 15/700; `small` check 14 `--live` + «اطلاعات تماس قبلاً ذخیره شده است»; `.ed` «ویرایش» (12.5/700 `--a-ink`,
  `padding:6px 10px`, radius 10, hover `#fff`).
- Summary chip `.sumchip`: `padding:10px 12px`, radius `--r-ctl`, `--paper`, gap 10; `.it` 32 radius 10 `#fff` ring
  `--line`; `.tx` 13/600; link «تغییر» 12.5/700 `--a-ink`.
- Day / slot pickers: `.days` (flex, gap 8, `margin-top:10px`, chips flex 1 `padding:0 8px`); `.slots` (gap 8,
  `margin:8px -18px 0; padding:2px 18px`, horizontally scrolling row with an edge fade mask
  `linear-gradient(to var(--fade-to,left), #000 calc(100% - 44px), transparent)`, `[dir=ltr]` `--fade-to:right`),
  slot chips 38 high radius 12 tnum, `.on` `--a` / `--on-a`, `.dis` disabled struck through. `overflow:hidden` on the
  board; production needs `overflow-x:auto` (suggestion) for more slots.
- Honeypot (not drawn): keep `input[name=company_website][tabindex=-1][aria-hidden=true][autocomplete=off]` off-screen.

### 4.5 Buttons

`.btn`: 50 high, `padding:0 18px`, radius `--r-ctl`, 15/700, gap 8, `nowrap`; `transition: transform .2s var(--ease),
box-shadow .2s ease, background-color .18s ease`; active `scale(.97)`. `.pri` flex 1, `--core`, `--core-ink`, shadow §3.4;
`.sec` `#fff` `--ink` ring `--line-2`; `.gh` `--paper` `--ink-2` (hover `--paper-2`); `.dg` `--end` `#fff`; `.full` width 100%;
`.sm` 40 high, `padding:0 14px`, 13.5, radius `--r-ctl − 2`. On the stage: `.btn.wh` `#fff` / `--s3`; `.btn.gl`
`rgba(255,255,255,.12)` / `#fff` + inset `.1`; `.offer .btn` 44 high `#fff` / `--s3` 14px. Disabled not drawn
(production disables «ثبت امتیاز» at 0 stars; suggestion `opacity:.5; pointer-events:none`).

### 4.6 Call stage components

- Glass pill `.pill` (`role="status"`): 30 high, `padding:0 12px`, radius 999, `rgba(255,255,255,.08)` + inset `.1`, blur 12,
  12.5/600 `rgba(255,255,255,.94)`, gap 8. Leading: `.eq` (4 bars 2.5 × 12 `--glow`, `cc-eq .9s` alternate, delays 0,
  -.3, -.6, -.15s) for ringing; `.gd` (8 `--live-hi` + `0 0 0 3px` 25% halo) for connected; `.pill.rec`
  (`color-mix(in oklab,var(--end) 18%,transparent)`, inset 46%, `#FFD0D2`, `.rd` 8 `--end` `cc-blink 1.4s`); `.pill.warn`
  (`rgba(232,163,23,.16)`, inset `.42`, `#FFDC9A`, `.spn` 13 spinner `cc-spin .9s linear`).
- Orb `.orb` 204 × 204, `margin:12px 0 4px`; rings / core / halos at `inset:38px` (core 128). `.rg` `1.5px solid
  color-mix(in oklab,var(--glow) 80%,transparent)`, `cc-ring 2.4s var(--ease) infinite`, delays 0 / .8 / 1.6s. `.core`
  `--core`, phone 46 / 1.7. Variants: `.ringing` (core icon `cc-wiggle 2.4s`); `.fast` (rings 1.6s, delays 0 / .53 /
  1.06s; icon 1.6s); `.spin` (`.core::after` arc `inset:-9px`, `2.5px` top `--glow`, inline-end 40% glow,
  `cc-spin 1.1s linear`); `.op` (core `#FCE3D4` / `#8A3410`, 48/700 initial); `.halo` (two `.halo` layers
  `radial-gradient(closest-side, color-mix(in oklab,var(--glow) 62%,transparent) 55%, transparent)`, `cc-halo 1.8s` and
  `2.3s` delay `-.8s` opacity `.7`, alternate); `.breathe` (core `cc-breathe 2.6s`); `.dim` (core `filter:saturate(.35)
  brightness(.78)`) + `.dash` (`inset:28px`, `1.5px dashed rgba(255,220,154,.55)`, `cc-spin 9s linear`); `.sm` 170
  (`inset:30px`, icon 40, `margin-top:6px`); `.xs` 120 (`inset:24px`, icon 28).
- Title `.sh` / text `.sp` (`max-width:318px`); `.ldots` 3 dots 4 × 4, gap 3, `cc-wave 1.2s` delays 0 / .15 / .3s.
- Wait timer `.tmr` (`role="timer"`, `margin-top:14px`, gap 10): `.tl` «زمان انتظار» 12.5 `rgba(255,255,255,.6)`; `b` 30/700
  tnum; optional `.sbt` sound button 34 circle `rgba(255,255,255,.1)`.
- Queue card `.qc`: `margin-top:16px; padding:14px 16px 12px`, radius `--r-card`, `rgba(255,255,255,.06)` + inset `.09`.
  Line `.ql` (32 high, `space-between`; dotted line `2px dotted rgba(255,255,255,.28)` at `inset-inline:20px 26px`):
  `.op` 32 circle `color-mix(in oklab,var(--glow) 26%,var(--s2))` + headset 17, ring `0 0 0 4px color-mix(in oklab,var(--s2) 70%,#000)`;
  `.pp` people ahead 12 circles `rgba(255,255,255,.42)` (same ring); `.me` «شما» chip 24 high `#fff` / `--s2` 11.5/800,
  glow, `cc-me 2.4s`. Stats `.qs` (2 columns, gap 10, `margin-top:12px; padding-top:12px`, top border `rgba(255,255,255,.08)`):
  «جایگاه در صف» + `b` position, «زمان تقریبی» + `b` ETA. Prototype `.ql2` animates the change (§6.2).
- Skeleton `.gsk`: 10 high, radius 6, shimmer gradient `rgba(255,255,255,.07/.16/.07)`, `cc-shim 1.4s linear`.
- Offer `.offer` (`margin-top:14px; padding:14px`, gap 10, radius `--r-card`, `rgba(255,255,255,.1)` + inset `.14`,
  entrance `cc-rise .6s var(--spring) .5s backwards`): `p` 13.5/600 with `phone-in` 18 `--glow`; `.btn` (§4.5).
- Sound hint `.hint` (defined, **not drawn on any screen**): 28 high, `padding:0 10px`, radius 999, `rgba(255,255,255,.08)`,
  12/600 `rgba(255,255,255,.85)`, gap 7, `margin-top:10px`, `cc-hint 2s`. Suggestion: under `.tmr` in 05/06/22 with
  `vol-x` 15 + «برای شنیدن صدا کلیک کنید» (`tap_to_hear`), shown while `audio.needsGesture()`.
- Who `.who-c`: `.nm` 21/700; `.rl` «اپراتور» 13 `rgba(255,255,255,.6)`; `.ctm` (`role="timer"`, `margin-top:12px`, 32 high,
  `padding:0 13px`, radius 999, `rgba(255,255,255,.08)` + inset, 14.5/700 tnum, gap 8): `.gd` 8 `--live-hi` + time + `.net`
  signal 15 (`rgba(255,255,255,.8)`, `title` «کیفیت اتصال خوب است»); `.ctm.mut` `rgba(255,255,255,.55)`.
- Recording note `.rnote` (`margin-top:auto`, `padding:10px 12px`, radius `--r-ctl`, `rgba(255,255,255,.06)`, 12 / 1.6
  `rgba(255,255,255,.7)`, info 16 `.55`).
- **Call dock** `.dock` (§2.2): `.cbn` (64 wide column, gap 7, 11.5/600 `rgba(255,255,255,.74)`) with `.bt` 58 circle
  `rgba(255,255,255,.12)` + inset `.1`, blur 14 (hover `.2`, active `scale(.92)`); `.cbn.on .bt` `#fff` / `--s3` (muted,
  camera off); `.cbn.end .bt` 66 × 66, `margin-top:-4px`, `--end` + shadow §3.4 (hover `color-mix(in oklab,var(--end) 88%,#fff)`).
  Voice dock order (DOM, right → left in RTL): mic «بی‌صدا» → `toggleMic()`; end «پایان» → `cancelCall()`; minimise
  «کوچک کردن» (`mini.svg`) → `toggleOpen()`. Muted: `.on` + `mic-off` + label «صدا» (prototype). No speaker button and
  no in-call sound toggle are drawn.
- Queue dock `.dock.q`: `.gbtn` 54 circle `rgba(255,255,255,.12)` + inset `.1`, `vol` / `vol-x` (`aria-label` «بی‌صدا کردن زنگ»);
  `.xbtn` 54 high, `padding:0 26px`, radius 27, `--end`, 15/700, gap 9, hang-up 22 + «لغو تماس» (active `scale(.96)`).
- Video: `.feed` (`inset:0; z-index:-2`, `#0A0D10` behind the video, gradient placeholder `linear-gradient(170deg,#6E7B80 0%,#3D484E 46%,#1C2328 100%)`,
  scrim `::after` `linear-gradient(180deg, rgba(0,0,0,.48) 0%, transparent 26%, transparent 62%, rgba(0,0,0,.62) 100%)`);
  `.vtop` (`role="status"`, `top:82px; left:50%; translateX(-50%); z-index:3`, 34 high, `padding:0 14px`, radius 999,
  `rgba(10,12,14,.38)` + inset `.12`, blur 14, 13/700, gap 8): `.rd` + «ضبط» + `.sep` (1 × 14 `.22`) + operator name + `.sep` +
  `.num` time (600, `.85`); `.pip` (`bottom:136px; inset-inline-end:16px`, 98 × 136, radius 18, `linear-gradient(165deg,#DCD3C6,#A89A8B)`,
  `0 0 0 1.5px rgba(255,255,255,.6), 0 16px 30px -10px rgba(0,0,0,.6)`, entrance `cc-pip .6s var(--spring) .5s`) with the
  local video **mirrored** and `.me-l` «شما» (20 high, `rgba(10,12,14,.45)`, at `bottom:7px; inset-inline-start:7px`);
  `.vdock` (`bottom:50px`, centred, `padding:10px; gap:12px`, radius 999, `rgba(10,12,14,.42)` + inset `.12`, blur 18):
  `.bt` 52 circles `rgba(255,255,255,.14)` (hover `.24`), `.bt.end` 64 × 52 radius 26 `--end`. Order: mic «بی‌صدا», camera
  «خاموش کردن دوربین», end «پایان تماس», minimise «کوچک کردن». Muted / camera-off states of `.vdock .bt` are not drawn
  (suggestion: reuse `.cbn.on .bt` colours `#fff` / `--s3` and the `-off` icons).
- Transfer `.xf` (`margin:30px 0 20px`, gap 14): previous operator `.av` 78 (28px, ring `6px rgba(255,255,255,.05)`),
  `.ar` 3 chevrons 22 `--glow` `.dirf` (`margin-inline-start:-8px`, `cc-flow 1.2s` delays 0 / .2 / .4s), target `.to` 78
  circle `rgba(255,255,255,.06)` + headset 30, dashed ring `cc-spin 8s` + pulse ring `inset:-12px` `cc-ring 2.4s`.
- Banner `.bnr` (`role="status"`): full width, `padding:11px 14px`, radius `--r-ctl`, `rgba(232,163,23,.14)` + inset `.36`,
  13/600 `#FFDC9A`, `.spn` 16.
- Permission help `.dn`: `.ei` 80 circle `margin-top:22px`, `color-mix(in oklab,var(--end) 18%,transparent)` + inset 42%,
  `#FFA5A8`, mic-off 34; `.addr` (`margin-top:18px; padding:10px`, radius `--r-card`, `rgba(255,255,255,.06)` + inset `.09`,
  `aria-hidden`): `.bar` 36 high LTR address bar (lock tile `.lk2` 24 with pulsing `--glow` focus ring `cc-focus 1.6s`, page
  host, three dots) + `.pop` (236 wide, `margin-top:8px`, `padding:9px 12px 9px 10px` in RTL, radius 13, `#fff`, 13/600,
  mic 17 + «میکروفون» + `.sw.on`); `.how` (`margin-top:12px`); `.row2` (`margin-top:auto`, gap 10, two `.btn` flex 1).

### 4.7 Rating, thanks, centred states

- `.sumc` (`padding:14px`, radius `--r-card`, `--paper`, gap 14): `.avw` with `.av.s52` + `.ck` (22 `--live` check 12/3,
  `inset-inline-end:-3px; bottom:-3px`, ring `2.5px var(--paper)`); `b` 15/700, `small` 12.5 `--ink-3`.
- `.rate` (`margin-top:26px`, centred): `h3`, `p` (`margin-top:2px`); `.stars` (`role="group"` «امتیاز», gap 4,
  `margin:18px 0 20px`): `.star` 50 × 50, radius 14, `--line-2`, svg 36 / 1.6; `.on` `--star` + `fill:currentColor`; hover
  `scale(1.12)`; `aria-label` «۱»…«۵», `aria-pressed="true"` only on the chosen value (radio semantics, brief §7).
  `.mini-stars` (gap 2, `--star`, filled; `.o` outline `--line-2`), sizes 18 (thanks) / 16.
- `.ctr` (centred column, `margin:auto 0; padding:0 8px`): `h3` `margin:18px 0 6px`; `p` `max-width:300px`.
  `.okc` 100 circle `--a-1` + bloom ring (`0 0 0 1.5px var(--a-3)`, `cc-bloom 2.6s .7s`), `.in` 70 `--core` + check 32 / 2.6
  (`cc-pop .6s var(--bounce) .15s`, path `cc-draw .5s .5s`, `stroke-dasharray:24`), optional `.bdg` 32 `#fff` `--a-ink` cal 16
  at `bottom:2px; inset-inline-end:0` (`cc-pop .5s .7s`). `.ei` 76 radius 26 `color-mix(in oklab,var(--bad) 9%,#fff)` +
  inset 16% + warn 34. `.oi2` 84 radius 28 `--a-1` / `--a-ink` + `phone-in` 34 / 1.7 + `.moon` 32 badge at
  `top:-8px; inset-inline-end:-8px`. `.vstack` (gap 10, `margin-top:22px`, full width). `.inl` (`max-width:300px; margin-top:14px`,
  clock 15 `--ink-4`).
- `.kv` (`margin-top:22px; padding:2px 14px`, radius `--r-card`, `--paper`): rows `min-height:46px`, 13.5, divider `--line`,
  key `--ink-3`, value 700; `.tagu` (24 high, `--warn-bg` / `--warn-ink` 12/700, bolt 13 `#D98E04`); `.code`; `.cpy` 28 × 28
  radius 8 `#fff` `--ink-3` ring `--line` + copy 15 (`aria-label` «کپی کد»).

### 4.8 Footer «قدرت گرفته از وب‌یار»

`a.pw` (40 high, centred, gap 6, 11.5 `--ink-3`): mark `.wm` 11 × 15 `--ink-2` ([`webyar-mark-dots.svg`](../../shared/brand/webyar/webyar-mark-dots.svg),
viewBox `17 13.5 26 33.5`) + «قدرت گرفته از » + `b` «وب‌یار» (700 `--ink-2`). Stage: text `rgba(255,255,255,.5)`, `b` and
mark `.78`. Video: `position:absolute; bottom:4px; inset-inline:0; z-index:3`, `rgba(255,255,255,.62)`. Mobile `margin-bottom:22px`.
Production: `div.ccw-footer > a.ccw-powered` with all five variants (map §4.11); split `powered_by` around `{brand}` to bold
the brand; production's brand string is «وب یار» (no ZWNJ) — use «وب‌یار». Logo variant, custom text and empty footer
are not drawn: keep the 40px row empty.

---

## 5. Screens

Shared by every panel: header §4.2 (sample name «پشتیبانی فروشگاه نیلوفر», initial «ف»), footer §4.8. Values are 1x.

### 5.01 Home, operators online — `online_available`

Purpose: choose voice, video or callback. Layout: header (with `.lang` because the board shows two locales) →
`.bd`: badge (y 76) → `.hh` «با تیم ما صحبت کنید» (y 118) → `.hs` «یک تماس صوتی یا تصویری امن را با اولین اپراتور آزاد شروع کنید.» (y 160)
→ `.opts` (y 236–414) → `.cbr` (y 426) → `.trust` (y 584–620) → footer. Entrance cascade `.cz` `--i` 0…5 (§6.3).
Data: `config.display_name`, `isOnline()`, `bootstrap.capabilities.{voice,video,callback}`, `callback_policy.show_when_online`,
`availableLocales`. Controls: voice tile `startCall('voice')`, video tile `startCall('video')` (synchronous in the click),
callback row `openCallback()`, collapse `toggleOpen()`, language `setLocale()`. Production: replaces PD:305-322 markup.
Hide a tile whose capability is off; the one-tile layout and the badge for partial channels are not drawn (suggestion: a
single tile spans both columns; badge lists only enabled channels).

### 5.02 Pre-call form with an error — `pre_call_form`

Layout: header → `.ctx` (back, `.ct` phone 15 «تماس صوتی»; video shows «تماس تصویری») → `.bd > .fm`: «دپارتمان» chips
(sample «فروش» on, «پشتیبانی فنی», «مالی») → `.grp` «نام کامل» / «ایمیل» / «تلفن» → «موضوع» `.inp` → `.cons.err` →
`.msg.err` «برای شروع تماس لطفاً رضایت ضبط را تأیید کنید.» → `.acts`: `.btn.gh` «بازگشت», `.btn.pri` phone 18 «شروع تماس».
Data: `bootstrap.departments[call_type]` (chips; auto-selected when one, hidden when none), `formData.{department_id,name,email,phone,subject,consent}`,
`config.pre_call_form_schema` (custom fields not drawn: render text/email/tel in `.grp`, textarea `.ta`, select as chips or
`.inp`, checkbox as `.cons`-style row — suggestion), `bootstrap.recording`, `controller.error`. Controls: `<form>` submit
→ `submitCall()`; back and «بازگشت» `type=button` → `reset()`; chip → `formData.department_id` (no full render).
Errors: `err_recording_accept` / `err_recording_required` light the consent card; field errors (`"<label>: الزامی"`) use the
`.msg.err` line and `.inp.err` on the field (suggestion: `aria-invalid` + `aria-describedby`).

### 5.03 Returning visitor — `pre_call_form` with `identifiedContact`

`.ct` video 15 «تماس تصویری» → `.known` (avatar initial, name, saved line, «ویرایش») → «موضوع» `.inp` (focused in the
board) → `.cons` (switch on) → `.permit` «مرورگر برای دوربین و میکروفون از شما اجازه می‌خواهد.» (video only) → acts with
video 18 «شروع تماس». «ویرایش» is new: show the name / email / phone group again (renderer flag `ui.editingContact`).

### 5.04 Connecting — `loading`

Stage. `.sb`: `.orb.spin` (y 86, no pill) → `.sh` «در حال اتصال» + `.ldots` → `.sp.ctxl` mic 15 + «تماس صوتی · فروش» (call
type + department name) → `.qc` skeleton (`margin-top:22px`, `.gsk` 46% and 78%) → `.dock.q` (sound + «لغو تماس»). Shown
while `POST calls/request` is in flight (map §4.1). Cancel: no call id yet → `cancelCall()` resets. Sound toggle: §5.05.

### 5.05 In line, third — `queue_waiting`, `queuePosition > 1`

`.pill` `.eq` «در حال زنگ زدن به اپراتور» → `.orb.ringing.sm` → `.sh` «جای شما محفوظ است» → `.sp` «درخواست شما در صف تماس زنده است. این پنجره را باز نگه دارید تا اپراتور متصل شود.»
→ `.tmr` «زمان انتظار» «۰:۴۷» → `.qc` (line + «جایگاه در صف» «۳» / «زمان تقریبی» «حدود ۳ دقیقه») → `.dock.q`.
Data (update in place every second, never rebuild): `queueStartedAt` → timer; `queuePosition` → `.qs b` and the line
(`.pp` dots = people ahead; drawn for 2 and 1; more than 2 not specified — suggestion: cap at 2); `queueEta` → «حدود {n} دقیقه»
(`n = max(1, round(eta/60))`) or «کمتر از ۱ دقیقه»; hide each stat with `show_position === false` / `show_eta === false`.
Sound: `.gbtn` → `audio.setMuted(!isMuted)` and on unmute with `needsGesture()` `audio.startFromGesture(queue_experience)`,
`stopPropagation` (map §4.5); icon `vol` / `vol-x` (`vol-x` also when `needsGesture()`), `aria-label` «بی‌صدا کردن زنگ» /
«فعال کردن صدا» (`unmute_sound`). Pill text: always `ringing_operator` as drawn (production switches to `ringing_enabled`
when audio is active; keep the eq bars animating only while `audio.isActive()` — suggestion). Cancel `.xbtn` →
`cancelCall()`. Collapse → `toggleOpen()` → launcher Se.

### 5.06 Next, with a callback offer — `queue_waiting`, `queuePosition === 1`

Same as 05 with `.orb.ringing.sm.fast`, `.sh` «نفر بعدی شما هستید», `.sp` «در حال زنگ زدن به اولین اپراتور آزاد هستیم.», `.tmr`
«۱:۳۵» **plus** `.sbt` sound button, no `.qc`, then `.offer` «از انتظار خسته شدید؟ می‌توانیم با شما تماس بگیریم.» + «درخواست تماس».
Offer shows when `caps.callback && offer_callback_after_seconds > 0 && elapsed ≥ threshold`; button → `cancelCall()` then
`openCallback()` after it resolves (fix A3.3/A3.4). The board draws two sound toggles (`.sbt` and `.gbtn`) — build one
(keep `.gbtn` in the dock; §9.3).

### 5.07 Operator joining — `in_call`, `connectStatus = 'waiting_for_operator'`

`.pill` `.gd` «متصل، در انتظار اپراتور» → `.orb.op.breathe` (operator initial from `operatorName`, fallback «؟» as today) →
`.who-c` name / «اپراتور» / `.ctm.mut` «اپراتور در حال ورود است» + `.ldots` → `.rnote` (bottom of `.sb`) «ممکن است ضبط پس از شروع تماس توسط اپراتور آغاز شود.»
(when `recording.effective_enabled` and not recording) → dock (mic, end, minimise; mic shown per map §4.6 rule).
Other pre-live statuses (`connecting`, `pending`, `token_ready`, `loading_media_client`, `connecting_media`) are not
drawn; suggestion: this layout with `.orb.spin` (phone core) when `operatorName` is empty and the status message
(`call_accepted_connecting`, `loading_media_client`, `connecting_av`) in `.ctm.mut`.

### 5.08 Voice call — `in_call`, `connectStatus ∈ {in_call, operator_connected}`, voice

`.pill.rec` «ضبط در حال انجام است» (when `call.recording_state === 'recording'`; else `.rnote` as 07) → `.orb.op.halo` →
`.who-c` «سارا محمدی» / «اپراتور» / `.ctm` `.gd` «۲:۱۴» `.net` → dock. Timer: `callStartedAt`, updated in place.
The remote `<audio>` from `_attachedTracks` must be mounted (hidden) in the panel (brief §2.4). `.net` needs
`controller.connectionQuality` (§9). Level meter: not drawn in the panel; drive the minimised `.wvs` bars through `controller._waveBars`.
Mic: `toggleMic()`; state from `micOn` (fix A3.8: colour and label both from `micOn`).

### 5.09 Video call — `in_call` live, `isVideoCall`

Panel `.vid`: remote video fills `.feed` (`object-fit:cover`, **not mirrored**, fix A3.7); header over the video; `.vtop`
«ضبط · سارا محمدی · ۲:۱۴» (drop «ضبط» and its separator when not recording — suggestion); `.pip` = `_localVideoEl` (same
instance, mirrored) only when `camOn`; `.vdock` mic / camera (`toggleCam()`) / end / minimise; footer absolute. Controls are
always visible (problem 2 solved). Measured: `.vtop` y 82–116, `.pip` y 388–524, `.vdock` y 538–610.

### 5.10 Transferring — `in_call` + `transferring`

`.pill` `.gd` «در تماس» → `.xf` (previous operator initial → arrows → headset) → `.sh` «در حال انتقال به اپراتور دیگر…» →
`.sp` «لطفاً پشت خط بمانید.» → `.ctm` `.gd` «۳:۰۵» → dock. The engine clears `operatorName` and `callStartedAt` on
transfer (map §4.6): keep the last name in the renderer (`ui.previousOperatorName`) for the avatar; the continuing timer needs the engine to keep
`callStartedAt` (§9), otherwise show the restarted time. Video transfer is not drawn (suggestion: same stage screen).

### 5.11 Reconnecting — `in_call`, `connectStatus = 'media_reconnecting'`

`.bnr` spinner «در حال اتصال مجدد رسانه…» → `.orb.op.dim` + `.dash` → `.who-c` + `.ctm.mut` `wifi-off` «۲:۴۸» (time keeps
running) → dock.

### 5.12 Microphone blocked — `in_call`, `connectStatus = 'microphone_permission_denied'`

`.sb.dn`: `.ei` → `.sh` «دسترسی میکروفون رد شد» → `.sp` «لطفاً اجازه دسترسی بدهید و دوباره تلاش کنید.» → `.addr` (host =
`location.hostname`, sample `nilufar.store`) → `.how` «روی نماد قفل کنار آدرس سایت بزنید و میکروفون را روشن کنید.» → `.row2`:
`.btn.gl` «پایان تماس» → `cancelCall()`; `.btn.wh` retry 18 «تلاش دوباره» → new `retryMicrophone()` (§9; hide if absent).
No dock; 14px spacer; footer. `camera_permission_denied` is not drawn: show the voice-call screen (08) with mute (fix
A3.10) and the `camera_denied` text as a `.bnr` (suggestion).

### 5.13 Rating the call — `ended` (b)

Light. `.bd`: `.sumc` (operator initial, «تماس پایان یافت.», «سارا محمدی · مدت مکالمه ۴:۱۴» = `operatorName` + « · » +
`call_duration` + time from `endedDuration`; drop the duration part when 0) → `.rate` «تماس چطور بود؟» / «نظر شما به بهبود تیم ما کمک می‌کند.»
→ stars (y 253) → `.ta` «افزودن نظر (اختیاری)» → `.acts` «رد کردن» (`.gh`) / «ثبت امتیاز» (`.pri`). Star click sets
`ratingValue` and updates only the stars (map §4.7); textarea → `ratingComment`; submit `submitRating()` (disabled at 0);
skip → `skipRating()` (brief §11). The prototype sends skip to the thanks screen; production resets — keep production.

### 5.14 Thank you — `ended` (c)

`.ctr`: `.okc` → «از بازخورد شما متشکریم!» → «مدت مکالمه ۴:۱۴» → `.sumc` (`margin-top:22px`; operator initial, name,
«اپراتور», `.mini-stars` showing `ratingValue`, `aria-label` «۴/۵») → `.acts` `.btn.pri.full` «تمام» → `reset()`.
`operatorName` and `ratingValue` survive until `reset()` (RT:1433-1454), so the data exists.

### 5.15 Error — `error`

`.ctr`: `.ei` → `h3` = `controller.error` (sample «در حال حاضر اپراتوری در دسترس نیست» is the server message of production
snapshot 21; fallback `unknown`) → `p` «درخواست تماس بگذارید تا تیم ما در اولین فرصت با شما تماس بگیرد.» → `.vstack`:
`.btn.pri.full` phone-in «درخواست تماس» → `openCallback()` (only when `caps.callback`; else omit the `p` and the button) and
`.btn.gh.full` «بازگشت» → `reset()`. Raw English server errors stay untranslated (A3.13); `rtc_v1_unsupported` lands here
with a new message (brief §11).

### 5.16 Team offline — `offline` (`offline_behavior = 'show_callback'`)

Header `.dot.off` «میز درخواست تماس». `.ctr`: `.oi2` + `.moon` → «درخواست تماس ثبت کنید» → «تیم ما الان آفلاین است، اما می‌توانیم با شما تماس بگیریم.»
→ `.btn.pri.full` phone-in «درخواست تماس» → `openCallback()` → `.inl` clock «تیم ما در اولین فرصت با شما تماس می‌گیرد.» → spacer
→ footer. Not drawn: other `offline_behavior` values (no button; launcher «پشتیبانی» / «آفلاین»), `hide` (wrap and panel `hidden`),
`show_callback` without `caps.callback`.

### 5.17 Callback, step 1 — `callback_form`, renderer step 1

`.ctx`: back → `reset()`, `.ct` phone-in «درخواست تماس», `.stp` «قدم ۱ از ۲». `.fm`: «نوع تماس» `.seg` «تلفنی» / «تصویری»
(`formData.callback_channel` `audio` / `video`; video only with `caps.video`) → «چه زمانی تماس بگیریم؟» `.seg` bolt «در اولین فرصت» /
cal «زمان‌بندی» (`callback_when` `now` / `later`); when `later`: `.days` «امروز» «فردا» + weekday names (sample «شنبه» «یکشنبه»)
and `.slots` times (sample «۱۰:۰۰» disabled, «۱۲:۳۰», «۱۶:۳۰» on, «۱۸:۰۰», «۱۹:۳۰») → «اولویت» `.seg` «عادی» / bolt «فوری»
(`callback_urgency`; urgent uses `.on.urg`). `.acts`: «بازگشت» → `reset()`; `.btn.pri` «ادامه» + `arrow-f` 18 `.dirf` → step 2
(renderer-local `ui.callbackStep`, no controller call). Writes `formData.callback_scheduled_for` as an ISO string with the Tehran offset
(e.g. `2026-10-20T16:30:00+03:30`), which `submitCallback` parses (`new Date(...)`, RT:1495-1504). Slot rules (step, opening
hours, first slot ≥ now + 5 min to match the picker's `min`) are not specified (§9).

### 5.18 Callback, step 2 — `callback_form`, renderer step 2

`.ctx` with «قدم ۲ از ۲» (back → step 1). `.fm`: `.sumchip` (channel icon, «تماس تصویری · فردا، ۱۶:۳۰ · فوری», «تغییر» → step 1;
ASAP shows «در اولین فرصت») → «دپارتمان» chips (`bootstrap.departments.callback`) → `.grp` «نام کامل» / «ایمیل *» / «تلفن *»
(`*` only with `callback_policy.require_contact`; focused row = `.fr.fo` in the board) → `.note` «ایمیل یا تلفن برای تماس با شما الزامی است.»
(with `require_contact` and no identified contact) → «پیام (اختیاری)» (or «پیام (حداقل {n} کاراکتر)») + `.ta` «کوتاه توضیح دهید چه کمکی نیاز دارید…»
→ honeypot (hidden) → `controller.error` slot (`.msg.err`, not drawn here). `.acts`: «بازگشت» → step 1; `.btn.pri` check 18
«ارسال درخواست» = `<form>` submit → `submitCallback()`. Keep the whole form (both steps) inside one `<form>`; step 1 fields hidden
on step 2 keep their `formData` values. The step bar overflows nothing (fm ends at y 551 of 558).

### 5.19 Callback scheduled — `ended` (a), `callbackId`

Header `.dot.off` «میز درخواست تماس» (the board shows offline; production follows `isOnline()`). `.ctr`: `.okc` + `.bdg` cal →
«درخواست تماس ثبت شد» → «تیم ما فردا ساعت ۱۶:۳۰ با شما تماس می‌گیرد.» (`reach_out` with `{when}` = Jalali relative day + «ساعت» +
time, or `asap`) → `.kv`: «نوع» video 16 «تماس تصویری» (`video_callback` / `phone_callback`), «زمان» «فردا، ۱۶:۳۰» (row omitted for
ASAP — suggestion), «اولویت» `.tagu` «فوری» (normal → plain «عادی», suggestion), «کد پیگیری» `.code` first 8 chars of
`callback_id` uppercased + `.cpy` (clipboard, renderer only). `.acts` «تمام» → `reset()` (which must clear `callbackId`, A3.2).
Collapsing here turns the launcher into Sh until the booked time (§9).

### 5.20 Mobile: button on the page

Pill launcher `.ln-p` «تماس با پشتیبانی» at `right:18px; bottom:40px` (§2.4). Which style mobile uses is not specified
(boards 02/7 and 11 draw the pill); suggestion: the configured `launcher_style`, with L2 shown as L3 below 640px.

### 5.21 Mobile: home as a sheet

01's content in `.sheet` over `.scrim` (§2.4). `.cbr` wraps to two lines (84 high). Entrance §6.2.

### 5.22 Mobile: queue full screen

05 at 390 × 844: header 114 (58 top), full `.orb.ringing` 204, `.sb` padding 26, dock y 686–782, footer y 782–822.

### 5.23 Mobile: video call full screen

09 at full screen: `.vtop` `top:104px` (overlaps the 114px header box by 10px; visually clear), `.pip` 108 × 150 at
`bottom:150px`, `.vdock` `bottom:74px`, footer `bottom:22px`.

### 5.24 Every production sub-state → screen

`in_call` `connectStatus` (map §4.6) and `ended` variants (map §4.7). "Drawn" = a board screen; otherwise the suggested
reuse (not specified in the design).

| Sub-state | Message key (status text) | Screen |
|---|---|---|
| `connecting` (null), `pending`, `token_ready` | `call_accepted_connecting` | suggestion: 07 layout, `.orb.spin`, text in `.ctm.mut` |
| `loading_media_client` / `connecting_media` | `loading_media_client` / `connecting_av` | same suggestion |
| `waiting_for_operator` | `operator_joining` | **drawn 07** |
| `operator_connected`, `in_call` | `operator_connected` / `connected` (not shown; the timer replaces it) | **drawn 08** (voice) / **09** (video) |
| `media_reconnecting` | `reconnecting_media` | **drawn 11** |
| `microphone_permission_denied` | `mic_denied` | **drawn 12** |
| `camera_permission_denied` | `camera_denied` | suggestion: 08 + `.bnr` with the text, mute available (A3.10) |
| `operator_left`, `media_disconnected`, `token_expired`, `room_failed` {error}, `rtc_v1_unsupported`, `media_client_missing`, `media_client_invalid`, `provider_client_not_configured`, `provider_client_not_supported`, `media_not_configured` | keys per the map §4.6 table (`provider_client_*` → `provider_not_*`; `rtc_v1_unsupported` → new key, brief §11) | suggestion: 12 layout (`.sb.dn`: `.ei` + `.sh` title + `.sp` text), buttons «پایان تماس» and, where the key says so, «درخواست تماس» (`openCallback` after `cancelCall`) |
| `fallback`, `accepted_no_sdk` | never set | — |
| `transferring` (flag) | `transferring_call` | **drawn 10** |
| `ended` (a) `callbackId` | `callback_scheduled` | **drawn 19** |
| `ended` (b) rating | `rate_call_title` | **drawn 13** (without duration when `endedDuration` is 0: not drawn) |
| `ended` (c) `ratingSubmitted` | `rate_thanks` | **drawn 14** |
| `ended` else branch (no `endedCallId`) | — | unreachable in practice; reuse 14 without stars |

---

## 6. Motion

### 6.1 Motion list of the live prototype (`.mn`, board 04) — spec

| # | Row (verbatim) | Value | Implementation (cc.css / 04 script) |
|---|---|---|---|
| 1 | «دکمه از کادر پایین می‌رود» — «با شتاب؛ وقتی پنل باز است دکمه‌ای دیده نمی‌شود. در گوشه‌های بالا، زیر سربرگ سایت می‌رود.» (the button drops out of the frame, accelerating; no button while open; top corners: it slides up under the site header) | ۲۶۰ میلی‌ثانیه | `.hide-l .lwp`: bottom corners `transform:translateY(150px)`, top corners `translateY(-170px)`, edge tab `translateX(80px)` / `(-80px)`; `transition: transform .26s var(--ease-in), visibility 0s linear .26s` → `visibility:hidden` |
| 2 | «پنل از همان گوشه باز می‌شود» — «با کمی جهش؛ محتوا پشت‌سرهم وارد می‌شود.» (panel opens from the same corner with a slight overshoot; content enters in sequence) | ۵۲۰ میلی‌ثانیه | closed: `opacity:0; visibility:hidden; transform:translateY(30px) scale(.88)` (top: `translateY(-30px) scale(.88)`; edge: `translateX(30px) scale(.9)`); open: `opacity:1; transform:none; transition: opacity .22s ease .18s, transform .52s var(--spring) .18s, visibility 0s linear .18s`; `transform-origin` `100% 100%` (br), `0 100%` (bl), `100% 0` (tr), `0 0` (tl), `100% 50%` / `0 50%` (edge). Content cascade = `.cz` (§6.3) |
| 3 | «صفحه‌ی تماس از دکمه پخش می‌شود» — «رنگ تیره از همان دکمه‌ای که زده شده باز می‌شود.» (the dark stage spreads out of the pressed button) | ۶۰۰ میلی‌ثانیه | `.lv .dk` `clip-path: circle(0 at var(--cx) var(--cy))` → `.dark`: `circle(150% at …)`, `transition: clip-path .7s var(--ease)` (in) / `.55s var(--ease-in)` (out). `--cx:26%` LTR, `74%` RTL (voice tile centre), `--cy:56%`; to rating `--cx:50%; --cy:88%`. CSS says 700 / 550 ms, the note 600 ms (§9.3). Suggestion: set `--cx/--cy` from the pressed element's centre |
| 4 | «حلقه‌ها با بوق انتظار می‌تپند» — «جایگاه در صف با یک حرکت فنری عوض می‌شود.» (rings pulse with the ringback; the queue position changes with a spring) | هر ۲٫۴ ثانیه | `.orb .rg` `cc-ring 2.4s`; `.ql2 .me{transition: inset-inline-start .7s var(--spring)}` (positions: 3 → `calc(100% - 46px)`, 2 → `calc(68% - 22px)`, 1 → `46px`); `.ql2 .pp{transition: opacity .3s ease, transform .4s var(--spring)}`, a passed dot → `opacity:0; transform:scale(.2)`; dots at `36% - 6px` and `68% - 6px` |
| 5 | «اپراتور وارد می‌شود» — «حلقه‌ها در چهره‌ی اپراتور جمع می‌شوند و زمان‌سنج تماس شروع می‌شود.» (rings gather into the operator's face; the call timer starts) | ۵۰۰ میلی‌ثانیه | `.incall .orb.lvq .rg{animation:none; opacity:0}`; `.orb.lvq .core svg{transition: transform .4s var(--ease), opacity .3s ease}`; queue screen fades out, call screen fades in (§6.2). No morph keyframes exist; suggestion: scale the core svg to 0 in .4s while the call screen fades in |
| 6 | «کوچک کردن» — «پنل جمع می‌شود و تماس داخل دکمه ادامه پیدا می‌کند.» (panel collapses; the call continues inside the button) | ۳۰۰ میلی‌ثانیه | panel close (row 2 reverse: `opacity .2s ease, transform .26s var(--ease-in)`); launcher returns (`.lwp{transition: transform .55s var(--spring) .2s, opacity .3s ease .2s, visibility 0s linear .2s}`); call bar `.mc` `cc-mcin .55s var(--spring) .1s backwards` (`translateY(40px) scale(.7)`, `opacity:0` → none) |
| 7 | «پایان و امتیاز» — «صفحه‌ی تیره کنار می‌رود و ستاره‌ها یکی‌یکی پر می‌شوند.» (the dark stage withdraws; stars fill one by one) | هر ۸۰ میلی‌ثانیه | stage closes toward `50% 88%` (row 3); stars `.stars .star.on` `cc-star .55s var(--bounce) calc(.35s + var(--i) * 80ms) backwards`; on click `.lv .star.on` `cc-starpick .45s var(--bounce)` (`scale .6 → 1.25 → 1`) |

Prototype step timing (04 script): opening highlights row 1 then row 2 after 320 ms; starting a call highlights row 3 then
row 4 after 900 ms. Auto-play sequence (demo only): open 1200 ms after load → voice call +2600 → position 2 +2600 →
position 1 +2100 → operator joins +2000 → minimise +3400 → reopen +3400 → end +2400 → stars filled at 120 ms steps +1000 →
submit +1800 → done +2000 → loop +2600. Any manual action pauses auto-play for 15 s. Closing from rating / thanks resets the
screen to home 420 ms after the close (`closeW`, `doneW`); cancel in the queue returns home immediately.

### 6.2 Interaction table

| Interaction | Element | Property | Duration | Easing | Delay | Keyframes / values |
|---|---|---|---|---|---|---|
| Launcher wave | `.ln .wv` | box-shadow | 3.6s ∞ | `--ease` | — | `cc-lnwave`: `0 0 0 0` accent 50% → `0 0 0 20px` 0% at 45% |
| Launcher glyph wiggle | `.ln-c .wig` | rotate | 3.6s ∞ | ease-in-out | — | `cc-wiggle`: 0 → -14° (4%) → 12° (9%) → -10° (14%) → 8° (19%) → -4° (24%) → 0 (29–100%) |
| Launcher hover / press | `.ln-c`, `.ln-p`, `.ln-r`, `.ln-q`, `.ln-t` | transform | .3s | `--ease` | — | §4.1 |
| Logo flip loop (board) | `.fc.auto` | rotateY | 4.4s ∞ | `--spring` | — | `cc-flip`: 0 (0–38%) → 180° (50–88%) → 360° |
| Label entrance | `.lbl` | opacity, transform | .6s | `--spring` | .4s | `cc-lbl`: `translateX(12px) scale(.9)`, 0 → none (physical X; for left placements not specified, suggestion `-12px`) |
| Status ping | `.dot::after` | scale, opacity | 2.4s ∞ | `--ease` | — | `cc-ping`: 1 / .6 → 2.6 / 0 at 70% |
| Launcher leaves / returns | `.lwp` | transform, visibility | .26s / .55s | `--ease-in` / `--spring` | 0 / .2s | §6.1 rows 1, 6 |
| Panel open / close | panel | opacity, transform | .52s (+.22s opacity) / .26s (+.2s) | `--spring` / `--ease-in` | .18s / 0 | §6.1 row 2 |
| Screen swap | `.lv .scr` | opacity | out .3s, in .35s | ease | in .1s | `visibility` flips at the end / start |
| Stage reveal | `.lv .dk` | clip-path | .7s in / .55s out | `--ease` / `--ease-in` | — | §6.1 row 3 |
| Content cascade | `.cz` | opacity, translateY | .6s | `--ease` | `.15s + i × 70ms` | `cc-rise`: `translateY(14px)`, 0 → none |
| Voice tile rings | `.opt.voice .rw` | scale, opacity | 3.6s ∞ | `--ease` | 0 / 1.2 / 2.4s | `cc-tile`: .5 / 0 → .9 at 25% → 1.3 / 0 |
| Tile hover | `.opt` / `.go` | transform | .35s / .3s | `--ease` | — | -3px / ±3px |
| Chip / switch | `.chip`, `.sw::after` | transform | .25s / .32s | `--bounce` / `--spring` | — | colours .18–.2s ease |
| Consent error nudge | `.cons.err .sw` | translateX | .5s × 2 | `--ease` | .6s | `cc-nudge`: ±3px |
| Success disc | `.okc .in` / path / `.bdg` / ring | scale / dashoffset / bloom | .6s / .5s / .5s / 2.6s ∞ | `--bounce` / `--ease` | .15s / .5s / .7s / .7s | `cc-pop` (.4 → 1), `cc-draw` (24 → 0), `cc-bloom` (1 → 1.5, 0 at 80%) |
| Stars | `.star.on` | scale, rotate | .55s | `--bounce` | `.35s + i × 80ms` | `cc-star`: `.3` / `-25deg` → none |
| Ringing rings | `.orb .rg` | scale, opacity | 2.4s ∞ (fast 1.6s) | `--ease` | 0 / .8 / 1.6s (fast 0 / .53 / 1.06s) | `cc-ring`: 1 / .75 → 1.62 / 0 |
| Ringing glyph | `.orb.ringing .core svg` | rotate | 2.4s (1.6s) | ease-in-out | — | `cc-wiggle` |
| Connecting arc | `.orb.spin .core::after` | rotate | 1.1s ∞ | linear | — | `cc-spin` |
| Speaking halo | `.orb .halo` ×2 | scale, opacity | 1.8s / 2.3s ∞ alternate | ease-in-out | 0 / -.8s | `cc-halo`: 1.04/.5 → 1.3/.85 → 1.12/.6 → 1.38/.9 → 1.18/.65 |
| Joining breathe | `.orb.breathe .core` | scale | 2.6s ∞ | ease-in-out | — | `cc-breathe`: 1 → 1.045 |
| Reconnect dash | `.orb .dash` | rotate | 9s ∞ | linear | — | |
| "You" chip | `.ql .me` | scale | 2.4s ∞ | ease-in-out | — | `cc-me`: 1 → 1.07 |
| Eq bars | `.pill .eq i` / `.mc .wvs i` | scaleY | .9s / .8s ∞ alternate | ease-in-out | §4.6 / §4.1 | `cc-eq`: .3 → 1 |
| Recording blink | `.rd` | opacity | 1.4s ∞ | ease-in-out | — | `cc-blink`: 1 → .3 → 1 |
| Spinners | `.spn` | rotate | .9s ∞ | linear | — | |
| Loading dots | `.ldots i` | translateY, opacity | 1.2s ∞ | ease-in-out | 0 / .15 / .3s | `cc-wave`: -3px / 1 at 30% |
| Skeleton | `.gsk` | background-position | 1.4s ∞ | linear | — | `cc-shim` |
| Offer card | `.offer` | opacity, translateY | .6s | `--spring` | .5s | `cc-rise` |
| Sound hint | `.hint` | opacity | 2s ∞ | ease-in-out | — | `cc-hint`: 1 → .62 |
| Call buttons | `.cbn .bt`, `.vdock .bt`, `.xbtn`, `.btn` | transform, background | .2s | `--ease` | — | active `.92` / `.96` / `.97` |
| Self view | `.pip` | scale, translateY | .6s | `--spring` | .5s | `cc-pip`: `.6` / `20px` / 0 → none |
| Transfer | `.xf .to` / `.ar svg` | rotate / opacity | 8s / 1.2s ∞ | linear / ease-in-out | 0 / .2 / .4s | `cc-spin`, `cc-ring`, `cc-flow` (.2 → 1) |
| Permission focus | `.addr .lk2::after` | scale, opacity | 1.6s ∞ | ease-in-out | — | `cc-focus`: 1 / .95 → 1.18 / .35 |
| Minimised call avatar | `.mc .av` | box-shadow | 1.6s ∞ alternate | ease-in-out | — | `cc-talk`: 2px 55% → 7px 18% glow |
| Mobile sheet | `.scrim` / `.sheet` | opacity / translateY | .4s / .7s | ease / `--spring` | .2s / .3s | `cc-fade`, `cc-sheet` (`translateY(100%)` → none) |

Board 03 film (spec captions): «بسته» — «دکمه در گوشه منتظر است.»; «در حال باز شدن» ۵۲۰ میلی‌ثانیه — «دکمه با شتاب از کادر پایین می‌رود و پنل با کمی جهش از همان گوشه باز می‌شود.»;
«باز» — «وقتی پنل باز است دکمه‌ای زیرش نیست؛ بستن روی خود پنل است.»; «در حال بسته شدن» ۵۰۰ میلی‌ثانیه — «پنل جمع می‌شود، بعد دکمه از پایینِ کادر بالا می‌آید.»
Board 01 description: the button drops out of the frame while the panel is open and comes back from below after closing.

### 6.3 Rules

- Animations run continuously; never restart them on the 1 s ticks (brief §2.5): update `.tmr b`, `.ctm` text,
  `.mc small`, `.qs b`, `.mvid .t` in place.
- `.cz` cascade only when a screen is first shown (indices as on board 05: badge 0, title 1, text 2, tiles 3, callback row 4, trust 5).
- If the engine drives `_waveBars`, remove `cc-eq` from those bars (suggestion) so the two do not fight.
- **Reduced motion:** `@media (prefers-reduced-motion:reduce){ .cc *, .cc *::before, .cc *::after { animation:none !important; transition: opacity .15s ease !important } }`
  (board 12 «کاهش حرکت» «فقط محو شدن»). The stage reveal then appears without the clip-path movement (opacity only).

---

## 7. Direction, language and numbers

- Root `dir="rtl"` `lang="fa"` on `.ccw-root` (production). Layout uses logical properties (`padding-inline`,
  `inset-inline-*`, `margin-inline-*`, `text-align:start`) so it mirrors.
- **Stay physical:** `.ln-cl` and `.ln-f` are `direction:ltr` (label always left of the button at a right placement;
  `.at-l` / left placements reverse it); `.lbl .x` (`left:-8px`), `.ln-f .pb` (`right:-4px`), `.ln-t` radius and hover
  shift, the label tail corners, all launcher / panel anchors and `transform-origin`, `.vtop` / `.vdock` centring, the
  `.addr .bar` (an LTR address bar), the `.slots` fade (`--fade-to:left` in RTL), `.sw` knob shift (`[dir=rtl] .sw.on::after
  {transform:translateX(-18px)}`), tile arrow hover (`[dir=rtl] … translateX(-3px)`), stage reveal origin (`--cx:74%`).
- Mirrored icons: `.dirf` (`arrow-f`, `chevron-forward`, `back`, transfer chevrons). Phone, hang-up, mic, video are not mirrored.
- **Digits:** every number Persian (۰–۹): timers `۰:۴۷`, `۲:۱۴` (m:ss, tnum), positions «۳», ETA «حدود ۳ دقیقه», «قدم ۱ از ۲»,
  slots «۱۶:۳۰», durations, star labels «۱»…«۵», «۴/۵». The board helper: `dig(x) = String(x).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[d])`,
  `fmt(t) = dig(floor(t/60) + ':' + pad2(t % 60))`. Hours (`75:03`) are not handled by the design or production.
- **Latin islands:** emails and phone inputs `dir="ltr"` + `.ltrv`; reference code `.code` (`direction:ltr; unicode-bidi:isolate`)
  stays Latin `A1B2C3D4`; helper `.ltr`. Typed Persian digits in inputs stay as typed.
- Dates: Jalali calendar, `Asia/Tehran` (brief §6): «امروز», «فردا», weekday names, «فردا، ۱۶:۳۰» (summary / kv),
  «فردا ساعت ۱۶:۳۰» (sentence), «فردا ۱۶:۳۰» (launcher Sh).
- Keep ZWNJ in strings (`می‌گیرد`, `آماده‌اند`, `وب‌یار`, `کال‌سنتر`, `بی‌صدا`).
- Font: Vazirmatn for everything in both directions of mixed text; no Latin face is set for WebYar (Latin falls back to
  Vazirmatn's Latin glyphs, as in the screenshots).

## 8. Accessibility

- **Labels in the board markup** (keep, translate per locale): launcher «باز کردن ویجت تماس»; label close «بستن»; split group
  «تماس با ما»; collapse «کوچک کردن»; language «زبان ویجت»; form back «بازگشت»; department group «دپارتمان» (chips
  `aria-pressed`); consent `role="switch"` + `aria-checked` + `aria-labelledby`; error `p.msg.err[role=alert]`; stage pills,
  `.bnr`, `.vtop`, `.mc`, `.mvid`, `.sched` `role="status"`; `.tmr`, `.ctm` `role="timer"`; sound «بی‌صدا کردن زنگ»; queue
  restore «باز کردن تماس», cancel «لغو تماس»; dock «بی‌صدا», «پایان», «کوچک کردن»; video «بی‌صدا», «خاموش کردن دوربین»,
  «پایان تماس», «کوچک کردن»; PiP «شما»; `.net` `title` «کیفیت اتصال خوب است»; stars group «امتیاز», `aria-label` «۱»…«۵» with
  `aria-pressed`; textarea `aria-label` «افزودن نظر (اختیاری)»; mini stars «۴/۵»; segmented and slot chips `aria-pressed`,
  disabled slot `disabled`; copy «کپی کد»; mobile sheet `role="dialog"` + `aria-label` = workspace name; panel `section`
  `aria-label` = workspace name. Decorative SVGs and `.orb`, `.ql`, `.addr`, `.feed` are `aria-hidden`.
- Make labels follow state: mic «بی‌صدا» / «صدا» (and `aria-pressed`), camera «خاموش کردن دوربین» / «روشن کردن دوربین»,
  sound «بی‌صدا کردن زنگ» / «فعال کردن صدا» (the prototype keeps the mic `aria-label` static).
- Add what production lacks (brief §7): `aria-expanded` on the launcher, `role="dialog"` on the panel, `inert` when closed,
  Escape collapses, polite live region for queue position, call status and errors (not timers), `for`/`id` on every field
  (the board uses them), `autocomplete` (`name`, `email`, `tel`).
- Focus ring: `:focus-visible{outline:2px solid var(--a); outline-offset:2px}` on buttons, links and `[role=textbox]`;
  on the stage `outline-color:#fff`. Fields use their focus halo (§4.4).
- Touch targets below 44px in the design: `.ib` 38 (`.ctx .ib` 36), `.lang` 32 high, `.chip` 36, `.seg button` 40,
  `.sbt` 34, `.mbt` 40, `.mvid` buttons 30 / `.exp` 26, `.cpy` 28, `.lbl .x` 22. Keep the visual size and extend the hit
  area (e.g. a transparent `::before` with negative inset — suggestion).
- Contrast: `--ink-3` text on `#fff` and `--paper`, stage text at ≥ .6 alpha on `--s1..s3` pass AA with the presets;
  placeholders `--ink-4` are intentionally light; light custom accents need QA (§3.1.1).

---

## 9. New versus production

### 9.1 Additions

Canonical names: [`../../shared/new-hooks-and-settings.md`](../../shared/new-hooks-and-settings.md) (one name per concept
for both brands); the names below follow it.

| Addition | Where | UI summary | Engine / server / settings must provide | Suggested name | If unavailable |
|---|---|---|---|---|---|
| Launcher style | L1–L9 | 9 styles, default round with a label | setting, values `round` · `round_label` · `pill` · `card` · `split` · `edge_tab` · `dark_square` · `operator_face` · `mobile_bar` (design classes `ln-c` · `ln-cl` · `ln-p` · `ln-r` · `ln-s` · `ln-t` · `ln-q` · `ln-f` · `mbar`; prototype keys `c`, `cl`, `p`, `r`, `t`) | setting `config.launcher_style` | `round_label` |
| Placement | P1–P8 | bottom right / left, top right / left, edge (with `edge_tab`), bottom centre; phone corner / bar | extend `config.widget_position` beyond `left`/`right` | values `right` · `left` · `top_right` · `top_left` · `bottom_center` | `right` |
| Hide label | L2 | «بستن» on the label | renderer-local, remember per session (suggestion) | `ui.labelDismissed` | show label |
| Operator avatars / face | L4, L8 | online operators' initials or photos, name | presence list in bootstrap | `bootstrap.presence.operators[] {name, initial, avatar_url}` | L4 without `.avs`; L8 → L2 |
| Minimised queue / call / video | Se, Sf, Sg | call bar in the launcher | data exists (`queuePosition`, `queueStartedAt`, `operatorName`, `callStartedAt`, `micOn`, media); renderer re-parents the same `<video>` into `.mvid .feed` synchronously | — | — |
| Booked callback on the launcher | Sh | chip until the booked time | persist `{callbackId, scheduled_for, channel}` beyond `reset()` (sessionStorage or bootstrap) | `controller.callbackBooking` | normal launcher |
| Connection quality | 08 `.net` | 4-bar signal, title text | LiveKit `ConnectionQualityChanged` → engine field | `controller.connectionQuality` (`excellent`/`good`/`poor`/`lost`) | hide `.net` |
| Retry microphone | 12 | «تلاش دوباره» | re-request the mic and republish | `controller.retryMicrophone()` | hide the button |
| Continuous time across transfer | 10 | timer keeps counting | do not clear `callStartedAt` on transfer (RT:997-1011); renderer keeps the previous `operatorName` | — | show restarted timer |
| Two-step callback form | 17, 18 | step 1 type/time/priority, step 2 contact | renderer-local step | `ui.callbackStep` | — |
| Day / slot picker | 17 | Jalali day chips + time slots | slot list or opening hours; Tehran time | `callback_policy.slots[]` or `callback_policy.business_hours` | `datetime-local` styled as `.inp` |
| Edit saved contact | 03 | «ویرایش» shows the contact fields | renderer flag; engine must accept edited `formData` with an identified contact | `ui.editingContact` | hide «ویرایش» |
| Channel badge and trust row | 01 | «آنلاین» + channels; three features | unused I18N keys exist (`live_now`, `channels`, `secure_line`, `queue_aware`, `fast_handoff`) | per-channel keys (§10) | — |
| Mobile sheet / full screen | 20–23 | sheet home, full-screen stage | renderer at ≤640px, safe areas, scroll lock | — | — |
| Mic level bars | Sf `.wvs` | live bars | set `controller._waveBars` to the 5 bars (engine writes `scaleY`) | — | CSS `cc-eq` |
| `skipRating`, unsupported browser | 13, 15 | | brief §11 | `controller.skipRating()`, i18n `rtc_unsupported` | — |
| Theme tokens | all | single accent, derived stage | `--a`, `--on-a` from `applyTheme` (brief §5); the stage, glow, core and live colours keep the design tokens `--s1..--s3`, `--glow`, `--core`, `--live` on `.ccw-root` (not new `--ccw-*` tokens) | — | — |

### 9.2 Known production problems (owner's README) → solution

| Problem | Design solution | Screens |
|---|---|---|
| Latin digits in Persian | Persian digits everywhere via `dig()`; tabular timers | 05, 06, 08, 13, 14, 17–19, Se–Sh |
| Video controls below the fold | Video fills the panel; `.vdock` floats at `bottom:50px` (mobile 74px); PiP above it | 09, 23 |
| Mobile not full screen | Sheet for home, full screen for queue and call | 21–23 |
| Text-only call buttons | 58px glass icon buttons with labels, 66px red hang-up | 07, 08, 10, 11 |
| "Connected" + recording note above the video | Merged into the `.vtop` overlay pill | 09, 23 |
| Emoji as icons | One stroke icon set ([`../../shared/icons/`](../../shared/icons/README.md)); strip emoji from I18N values | all |
| Long forms | Department chips, one grouped contact block, consent switch, returning visitor asks only the subject, callback split in two short steps | 02, 03, 17, 18 |

Also fixed by the design: closed launcher reflects the call (A3.19), collapse chevron labelled «کوچک کردن» (A3.14),
`rem` → px (all values are px), remote video not mirrored, panel `inert` when closed.

### 9.3 Design issues to decide (build as designed unless the owner decides)

1. Prototype panel is 384 wide; build 400 (brief). 2. Minimised call buttons: board 03 (mute + end, first name) vs
prototype (restore + end, full name). 3. Two sound toggles on screen 06. 4. Mute labels differ: boards 07–08 «بی‌صدا»
(action), board 12 «میکروفون روشن» / «بی‌صدا» (state), prototype muted «صدا». 5. Board 12 names `--paper` "surface
`--ccw-surface`", the brief maps `surface` to the panel background (`#fff` in the CSS). 6. Board 12 brand previews use
`--glow: color-mix(in oklab, X 55%, #fff)`, the CSS `42%` with `#5CF2D6`. 7. Motion values: stage reveal note 600 ms vs CSS
700 / 550; cascade 60 vs 70 ms; "voice halo" 1600 ms vs `.orb .halo` 1.8s / 2.3s (1.6s is `cc-talk`); film closing
500 ms vs .26s + .55s (from .2s). 8. Type sheet line-heights (25 / 1.3, 21 / 1.4) and caption 12 / 500 vs CSS (1.45, 1.5,
12.5 / 400). 9. Screen 19 header shows offline. 10. Pill text «متصل، در انتظار اپراتور» differs from `connected_waiting`.
11. `.lbl .x` has no `border:0; padding:0`, so the UA button border shows as a dark ring in L2 — add the reset.
12. `.mvid .exp` is a `span`; make it a button. 13. Weight 800 not shipped.

---

## 10. Copy deck

Production keys from map §8 (strip emoji from the I18N values; brief §2.10). "new" = add a key in `fa`, `en` and `tr`.

| UI string as designed | Where | Meaning | Production key |
|---|---|---|---|
| «همین حالا تماس بگیرید» | L2, L8 label | Call us right now | `talk_now` |
| «پشتیبانی آنلاین» | L2 label sub | Live support | `live_support` |
| «تماس با پشتیبانی» | L3, mobile pill | Call support | new: `launcher_pill` |
| «با تیم ما صحبت کنید» | L4, 01 title | Talk to our team | `talk_to_team` |
| «اپراتورها آماده‌اند» | L4, header | Operators available | `operators_available` |
| «تماس با ما» | L5 group label, L6 tab | Contact us | new: `launcher_tab` |
| «تماس صوتی» / «تصویری» | L5, L9, tiles, `.ct` | Voice call / Video | `voice_call` / `video` (emoji removed) |
| «درخواست تماس» | L9, Sd, `.cbr`, `.ct`, offer, 15, 16 | Request a callback | `callback` (L9, Sd) / `request_callback_instead` (`.cbr`) / `request_callback_title` (`.ct`) / `request_callback` (offer, 15, 16) |
| «ثبت اطلاعات» | Sd sub | Leave details | `leave_details` |
| «باز کردن ویجت تماس» | launcher `aria-label` | Open the call widget | new: `open_widget` |
| «بستن» | label close | Close | new: `close` |
| «نفر ۳ صف» / «نفر بعدی» | Se title | 3rd in line / Next | new: `queue_place_short` «نفر {n} صف», `queue_next_short` «نفر بعدی» |
| «زمان انتظار ۰:۴۷» | Se sub | Waiting time 0:47 | `waiting_time` + time |
| «باز کردن تماس» | restore buttons | Open the call | new: `restore_call` |
| «لغو تماس» | queue cancel | Cancel call | `cancel_call` |
| «بی‌صدا» / «صدا» | mute buttons | Mute / Sound on | `mute` / `unmute` (emoji removed; `unmute` fa value changes to «صدا») |
| «پایان تماس» | end buttons (aria), 12 | End call | new: `end_call` |
| «پایان» | dock label | End | `end` |
| «درخواست تماس ثبت شد» | Sh, 19 title | Callback request registered | `callback_scheduled` |
| «کوچک کردن» | header collapse, dock | Minimise | new: `minimize` (replaces `back` on the chevron) |
| «زبان ویجت» | language `aria-label` | Widget language | new: `widget_language` |
| «فا» | language pill | Persian | hard-coded `LOCALE_META` |
| «میز درخواست تماس» | offline header | Callback desk | `callback_desk` |
| «آنلاین» | badge | Online | `live_now` |
| «صوتی · تصویری · درخواست تماس» | badge | Voice · Video · Callback | per-channel parts, only enabled channels: new `channel_voice` «صوتی», `video` «تصویری», `callback` «درخواست تماس» (`channels` stays unused) |
| «یک تماس صوتی یا تصویری امن را با اولین اپراتور آزاد شروع کنید.» | 01 | Start a secure voice or video call with the next free operator. | `online_copy` |
| «با میکروفون مرورگر» | voice tile | With the browser microphone | new: `voice_tile_sub` |
| «تماس تصویری» | video tile, 03 `.ct`, 19 | Video call | `video_call` / `video_callback` |
| «با دوربین و میکروفون» | video tile | With camera and microphone | new: `video_tile_sub` |
| «راه ارتباطی را وارد کنید؛ تیم ما سریع تماس می‌گیرد.» | `.cbr` | Leave a way to reach you; our team calls back fast. | `callback_intro` (production uses « — » instead of «؛») |
| «خط امن» / «مدیریت صف» / «اتصال سریع» | trust row | Secure line / Queue management / Fast connection | `secure_line` / `queue_aware` / `fast_handoff` |
| «قدرت گرفته از وب‌یار» | footer | Powered by WebYar | `powered_by` (brand «وب‌یار») |
| «بازگشت» | back buttons | Back | `back` |
| «دپارتمان» | form | Department | `department` |
| «نام کامل» / «ایمیل» / «تلفن» | contact group | Full name / Email / Phone | `full_name` / `email` / `phone_field` |
| «ایمیل *» / «تلفن *» | 18 | Email * / Phone * | `email_required` / `phone_required` (render `*` in `<i>`) |
| «موضوع» | 02, 03 | Subject | `subject` |
| «رضایت می‌دهم این تماس برای کیفیت و امنیت ضبط شود.» | consent | I consent to this call being recorded for quality and security. | `consent_required` (value changes: no leading space, no «(الزامی)») |
| «الزامی» | consent chip | Required | `required` |
| «برای شروع تماس لطفاً رضایت ضبط را تأیید کنید.» | 02 error | Please accept recording consent to start the call. | `err_recording_accept` |
| «شروع تماس» | 02, 03 | Start call | `start_call` |
| «اطلاعات تماس قبلاً ذخیره شده است» | 03 | Contact details already saved | `contact_saved` |
| «ویرایش» | 03 | Edit | new: `edit` |
| «مرورگر برای دوربین و میکروفون از شما اجازه می‌خواهد.» | 03 (video) | The browser will ask for camera and microphone permission. | new: `permission_note` |
| «در حال اتصال» | 04 | Connecting | `connecting` |
| «تماس صوتی · فروش» | 04 | Voice call · {department} | `voice_call` / `video_call` + department name |
| «بی‌صدا کردن زنگ» | sound toggle | Mute the ringing | `mute_sound` (fa value changes from «بی‌صدا کردن») |
| «فعال کردن صدا» | sound toggle muted (not drawn) | Unmute | `unmute_sound` |
| «در حال زنگ زدن به اپراتور» | queue pill | Ringing the operator | `ringing_operator` |
| «جای شما محفوظ است» | 05 | Your place is held | `holding_place` |
| «درخواست شما در صف تماس زنده است. این پنجره را باز نگه دارید تا اپراتور متصل شود.» | 05 | Your request is in the live queue. Keep this window open. | `queue_copy_many` |
| «زمان انتظار» | timer label | Waiting time | `waiting_time` |
| «شما» | queue line, PiP | You | new: `you` |
| «جایگاه در صف» / «زمان تقریبی» | queue stats | Place in line / Estimated time | `queue_position` / `eta` |
| «حدود ۳ دقیقه» / «کمتر از ۱ دقیقه» | ETA value | About 3 minutes / Under 1 minute | new: `eta_value_minutes` «حدود {n} دقیقه», `eta_value_under_min` «کمتر از ۱ دقیقه» |
| «نفر بعدی شما هستید» | 06 | You are next | `you_are_next` |
| «در حال زنگ زدن به اولین اپراتور آزاد هستیم.» | 06 | We are ringing the next free operator. | `queue_copy_next` |
| «از انتظار خسته شدید؟ می‌توانیم با شما تماس بگیریم.» | 06 offer | Tired of waiting? We can call you back. | `tired_waiting` |
| «برای شنیدن صدا کلیک کنید» | sound hint (not drawn) | Tap to enable sound | `tap_to_hear` |
| «متصل، در انتظار اپراتور» | 07 pill | Connected, waiting for the operator | `connected_waiting` (value differs: production «متصل — در انتظار»; update `fa`) |
| «اپراتور» | operator role | Operator | `operator_label` |
| «اپراتور در حال ورود است» | 07 | The operator is joining | `operator_joining` (render without the trailing «…», dots are animated) |
| «ممکن است ضبط پس از شروع تماس توسط اپراتور آغاز شود.» | 07 | Recording may start after the operator begins the call. | `recording_may_start` |
| «ضبط در حال انجام است» | 08 pill | Recording in progress | `recording_progress` (drop the leading dot character) |
| «کیفیت اتصال خوب است» | `.net` title | Connection quality is good | new: `quality_good` (+ other levels) |
| «ضبط» | 09 `.vtop` | Recording | new: `recording_short` |
| «خاموش کردن دوربین» | 09 camera | Turn camera off | `camera_off` (emoji removed) |
| «میکروفون روشن» / «دوربین روشن» / «دوربین خاموش» | board 12 controls | Microphone on / Camera on / Camera off | new (only if the state-label variant is chosen, §9.3) |
| «در تماس» | 10 pill | In call | `in_call` |
| «در حال انتقال به اپراتور دیگر…» | 10 | Transferring to another operator… | `transferring_call` |
| «لطفاً پشت خط بمانید.» | 10 | Please stay on the line. | new: `transfer_hold` |
| «در حال اتصال مجدد رسانه…» | 11 | Reconnecting media… | `reconnecting_media` |
| «دسترسی میکروفون رد شد» | 12 title | Microphone access denied | `mic_denied` split → new: `mic_denied_title` |
| «لطفاً اجازه دسترسی بدهید و دوباره تلاش کنید.» | 12 | Please allow access and try again. | new: `mic_denied_body` |
| «میکروفون» | 12 illustration | Microphone | new: `microphone` |
| «روی نماد قفل کنار آدرس سایت بزنید و میکروفون را روشن کنید.» | 12 | Tap the lock next to the site address and turn the microphone on. | new: `mic_denied_how` |
| «تلاش دوباره» | 12 | Try again | new: `retry` |
| «تماس پایان یافت.» | 13 | Call ended. | `call_ended` |
| «سارا محمدی · مدت مکالمه ۴:۱۴» | 13 | {operator} · Duration {time} | `operatorName` + « · » + `call_duration` + « » + time |
| «تماس چطور بود؟» / «نظر شما به بهبود تیم ما کمک می‌کند.» | 13 | How was your call? / Your feedback helps us improve. | `rate_call_title` / `rate_call_sub` |
| «امتیاز» | stars group label | Rating | new: `rating` |
| «۱» … «۵», «۴/۵» | star labels, mini stars | 1…5, 4/5 | digits via `dig()` |
| «افزودن نظر (اختیاری)» | 13 | Add a comment (optional) | `rate_comment_ph` |
| «رد کردن» / «ثبت امتیاز» | 13 | Skip / Submit rating | `rate_skip` / `rate_submit` |
| «از بازخورد شما متشکریم!» | 14 | Thank you for your feedback! | `rate_thanks` |
| «مدت مکالمه ۴:۱۴» | 14 | Duration 4:14 | `call_duration` + time |
| «تمام» | 14, 19 | Done | `done` |
| «در حال حاضر اپراتوری در دسترس نیست» | 15 title | No operator is available right now | `controller.error` (server message, sample) |
| «درخواست تماس بگذارید تا تیم ما در اولین فرصت با شما تماس بگیرد.» | 15 | Leave a callback request and we will call you as soon as possible. | new: `error_callback_hint` |
| «درخواست تماس ثبت کنید» | 16 | Leave a callback request | `leave_callback_request` |
| «تیم ما الان آفلاین است، اما می‌توانیم با شما تماس بگیریم.» | 16 | Our team is offline now, but we can call you back. | `offline_copy` |
| «تیم ما در اولین فرصت با شما تماس می‌گیرد.» | 16 note | Our team will call you as soon as possible. | `reach_out` with `{when}` = `asap` |
| «قدم ۱ از ۲» | 17, 18 | Step 1 of 2 | new: `step_of` «قدم {n} از {total}» |
| «نوع تماس» | 17 | Callback type | `callback_type` |
| «تلفنی» / «تصویری» | 17 | Phone / Video | `phone` / `video` (emoji removed) |
| «چه زمانی تماس بگیریم؟» | 17 | When should we call? | `when_call` |
| «در اولین فرصت» | 17, 18 | As soon as possible | new: `asap_option` (no emoji prefix, PD:702; `asap` stays for the `{when}` sentences) |
| «زمان‌بندی» | 17 | Schedule | `schedule` (emoji removed) |
| «امروز» / «فردا» | 17 days, 18, 19, Sh | Today / Tomorrow | new: `today` / `tomorrow` |
| «شنبه» / «یکشنبه» | 17 days | Saturday / Sunday | `Intl` weekday, `fa-IR-u-ca-persian`, `Asia/Tehran` |
| «اولویت» / «عادی» / «فوری» | 17, 19 | Priority / Normal / Urgent | `priority` / `normal` / `urgent` (emoji removed; fixes the doubled emoji, map §4.4) |
| «ادامه» | 17 | Continue | new: `continue` |
| «تماس تصویری · فردا، ۱۶:۳۰ · فوری» | 18 summary | Video call · Tomorrow, 16:30 · Urgent | composed: `video` / `phone`, date (ASAP: `asap_option`), `normal` / `urgent`; the widget shows «تصویری» here (accepted difference, registry §5.6) |
| «تغییر» | 18 | Change | new: `change` |
| «ایمیل یا تلفن برای تماس با شما الزامی است.» | 18 note | Email or phone is required to reach you. | `contact_required_note` without the leading «* » |
| «پیام (اختیاری)» | 18 | Message (optional) | `message_optional` (or `message_min`) |
| «کوتاه توضیح دهید چه کمکی نیاز دارید…» | 18 | Briefly describe what you need… | `message_placeholder` |
| «ارسال درخواست» | 18 | Send request | `send_request` |
| «تیم ما فردا ساعت ۱۶:۳۰ با شما تماس می‌گیرد.» | 19 | Our team will call you tomorrow at 16:30. | `reach_out` with `{when}` «فردا ساعت ۱۶:۳۰» (new: `at_time` «ساعت {time}») |
| «نوع» / «زمان» / «کد پیگیری» | 19 kv | Type / Time / Reference | `type` / new: `time` / `reference` |
| «کپی کد» | 19 | Copy code | new: `copy_code` |
| «فردا ۱۶:۳۰» | Sh | Tomorrow 16:30 | composed date |

---

## 11. Acceptance checklist

In addition to the [brief §10](../../CLAUDE_CODE_BRIEF.md):

- [ ] Panel 400 × 660 with `--sh-panel`, radius 26 / 16 / 34 for `md` / `sm` / `lg`; header 74, footer 40; screens 01–19
      match their PNGs at 2x with the sample data.
- [ ] Every number in fa is Persian (timers, position, ETA, steps, slots, durations, star labels); codes and emails stay LTR.
- [ ] The default launcher is L2 at bottom right, 22px from the edges, with the online dot, wave and wiggle; it drops away
      (260 ms) while the panel opens (520 ms spring from the corner) and returns after closing.
- [ ] Starting a call reveals the dark stage with the clip-path from the pressed tile; the stage re-tints with the accent.
- [ ] Queue: rings, wiggle, "you" chip, eq bars and timers keep animating across the 1 s ticks; position changes move the
      chip with the spring; the sound toggle works with and without a gesture lock.
- [ ] Collapsing during the queue / voice / video turns the launcher into Se / Sf / Sg; the call keeps playing; restoring
      returns to the same screen; the video element is the same instance and never mirrored remotely.
- [ ] Voice and video docks never scroll out of view (desktop 660 high and mobile 844); PiP never overlaps the dock.
- [ ] Transfer, reconnect and microphone-blocked screens appear for `transferring`, `media_reconnecting`,
      `microphone_permission_denied`; every other `connectStatus` has a readable screen (§5.07, §5.12).
- [ ] Rating stars fill in sequence (80 ms steps), «ثبت امتیاز» disabled at 0, skip calls `skipRating()`; thanks shows the
      given stars and the operator.
- [ ] Callback: two steps inside one `<form>` with the honeypot; Jalali day chips and Tehran slots write a valid
      `callback_scheduled_for`; urgent uses the warn segment; the scheduled screen shows the code with copy.
- [ ] Mobile ≤ 640px: home as a sheet with scrim, queue and calls full screen with safe areas.
- [ ] Light custom accent (for example `#FACC15`): `--on-a` switches to `#16142B` on the core surfaces; check stage text.
- [ ] `prefers-reduced-motion`: no rings, waves, wiggles, halos, sheet slide or clip-path; opacity fades only.
- [ ] The label close button has no UA border; all icon buttons have `aria-label`s and visible focus (white on the stage).
