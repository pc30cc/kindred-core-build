# Respok call-center widget · Template 1 — implementation spec

The Respok (International edition, respok.app) call-center widget: a visitor starts a voice or video call with the
support team or books a callback. English, left to right; Persian / RTL falls back to Vazirmatn. Per the
[brief §3](../../CLAUDE_CODE_BRIEF.md) this design becomes production call-widget template **`intl`**: production loads
`runtime.css` + `presentation-intl.css` **instead of** the Persian stylesheet, so the shared design CSS goes into
`runtime.css` and every `.b-rp` rule listed in [§3.8](#38-the-intl-skin-every-b-rp-rule-in-cccss) is the content of
`presentation-intl.css`. The main idea: light panels (Paper / Mist / Ink) for choosing and forms, and an Ink **call
stage** that spreads out of the pressed button for the queue and the call, with Signal `#FF5A3C` as the live / focus
colour and Ink `#16142B` as the default accent (`--a`).

Brand sheet: [`../README.md`](../README.md). Global rules (lifecycle, controller calls, media, in-place updates, frame,
accent pipeline, fonts, a11y, known bugs): [`../../CLAUDE_CODE_BRIEF.md`](../../CLAUDE_CODE_BRIEF.md). Production
widget: [`../../shared/production-map.md`](../../shared/production-map.md) (cited below as "map §n").

---

## 0. Files in this folder

| Path | What it is | How to use it |
|---|---|---|
| `source/NN-name.dc.html` | Board sources: markup with `{{holes}}`, copy, inline SVG icons, and a `class Component extends DCLogic` script at the bottom (`lum()` / `renderVals()` compute `--on-a`, radius and logo class; board 04 also holds the step machine and timers). `data-props`: `accent` (default `#16142B`, presets `#16142B #2F5BFF #0F766E #C2410C`), `radius` (`sm` / `md` / `lg`, default `md`), `logo` (`thread` / `open`, default `thread`) | Read for markup, copy and behaviour; they do not render on their own |
| `reference/NN-name.html` | Static renders of each board (handlers and timers removed). Root `<div class="cc b-rp lg-thread" dir="ltr" data-r="md" style="--a:#16142B;--on-a:#FFFFFF">` | Open from disk in Chrome. Extra states: `04-live-prototype--{open-home,queue,call,minimized-call,rating,thanks,button-c-br,button-p-bl,button-r-br,button-t-tr}.html`, `05-starting-a-call--radius-{sm,lg}.html` |
| [`reference/css/cc.css`](reference/css/cc.css) | The exact stylesheet of every board, both brands (`.cc.b-wy` WebYar, `.cc.b-rp` Respok; radius on `data-r`; logo direction `lg-thread` / `lg-open`). Line numbers below (`cc.css:NNN`) point into it | Source of every value in this README |
| [`reference/css/fonts.css`](reference/css/fonts.css), `reference/fonts/` | Figtree 400–800, DM Mono 400/500, Vazirmatn 400–700 | Same files as [`../../shared/fonts/`](../../shared/fonts/) |
| `screens/panels/*.png` | Every screen, launcher card, placement card, state card and design-system card at 2x (desktop crops include a 24px margin around the 400 × 660 panel; mobile crops a 24px margin around 390 × 844) | **The acceptance target** |
| `screens/boards/*.png` | Whole boards at 1x with the designer's title and explanation | Context |
| `screens/states/*.png` | The live prototype in its states and the radius variants of board 05, 1x | Context |
| [`tokens.json`](tokens.json) | Tokens resolved for the default accent, plus the three radius sizes | Token values (summarised in §3) |

**Board chrome is not product UI** (ignore): the kicker `.kick`, titles `.cc-h` / `.cc-d`, section titles `.sec-h`,
`.tag` labels ("01 Home, operators online"), `.cc-row` / `.cc-col`, the card frames `.lgc` (board 01), `.pm` / `.pmk`
(board 02), `.stc` / `.frm` / `.scr2` (board 03), the fake page sketches `.sk`, `.pmk .tb/.nv/.bd2`, `.mini-ph`, the
fake website `.site2 .sbar/.snav/.page` and the controls `.side` / `.cgrp` / `.ctl` of board 04, the phone chrome
`.notch` / `.homebar` / `.mpage` / `.cp.mob` 46px corner radius (board 11), the card frames `.sc` (board 12), the hover
cursor `.hov-arrow`, the board background `#E8E7EE`, and the illustrated people `.person` / `.feed .bk/.shelf` (they
stand in for live video). **Spec content that sits in chrome:** the captions of the launcher, placement and state cards,
the motion list `.mn` of board 04, and all of board 12; they are transcribed below.

**Sample content is not copy:** "Nilufar Store Support" and the "N" logo, Sara Mohammadi / "S", Ali Rezaei / "A",
`ali@example.com`, `+1 555 123 4567`, "Order #48213", "Returning shoes, size 42", "nilufar.store", `A1B2C3D4`, the
avatars S / M / R, all times and counts (0:47, 1:35, 2:14, 2:48, 3:05, 4:14, #3, "Tomorrow 4:30"). UI strings are in §10.

---

## 1. Screen inventory

IDs are the labels printed on the boards (and in the crop names). Cards on boards 01–04 and 12 are referred to as
the same IDs as the WebYar spec: launcher styles `L1`–`L9` (board 01), placements `P1`–`P8` (board 02), launcher states `Sa`–`Sh` and the open/close film `F1`–`F4` (board 03), the live prototype `LP` with its state name (board 04, e.g. `LP queue`), design-system cards `DS1`–`DS11` (board 12); numbered screens are `01`–`23`.

**Launchers, placement, states, prototype**

| ID | Screen | Screenshot (2x) | Reference page | Production view (map §) | Work |
|---|---|---|---|---|---|
| L1 | Round | [png](screens/panels/01-call-buttons--1-round.png) | [01](reference/01-call-buttons.html) | launcher, §2 | Restyle + markup |
| L2 | Round with a label (**default style**) | [png](screens/panels/01-call-buttons--2-round-with-a-label.png) | [01](reference/01-call-buttons.html) | launcher, §2 | Restyle + markup |
| L3 | Pill | [png](screens/panels/01-call-buttons--3-pill.png) | [01](reference/01-call-buttons.html) | launcher, §2 | New |
| L4 | Rectangular | [png](screens/panels/01-call-buttons--4-rectangular.png) | [01](reference/01-call-buttons.html) | launcher, §2 | New |
| L5 | Split: voice and video | [png](screens/panels/01-call-buttons--5-split-voice-and-video.png) | [01](reference/01-call-buttons.html) | launcher, §2 + `startCall` §5 | New |
| L6 | Edge tab | [png](screens/panels/01-call-buttons--6-edge-tab.png) | [01](reference/01-call-buttons.html) | launcher, §2 | New |
| L7 | Dark square | [png](screens/panels/01-call-buttons--7-dark-square.png) | [01](reference/01-call-buttons.html) | launcher, §2 | New |
| L8 | Operator face | [png](screens/panels/01-call-buttons--8-operator-face.png) | [01](reference/01-call-buttons.html) | launcher, §2 | New |
| L9 | Mobile bottom bar | [png](screens/panels/01-call-buttons--9-mobile-bottom-bar.png) | [01](reference/01-call-buttons.html) | launcher, §2 + `startCall` / `openCallback` §5 | New |
| P1 | Bottom right (Default) | [png](screens/panels/02-placement-on-the-page--1-bottom-right-default.png) | [02](reference/02-placement-on-the-page.html) | `widget_position` §1.7, §3 | Restyle |
| P2 | Bottom left | [png](screens/panels/02-placement-on-the-page--2-bottom-left.png) | [02](reference/02-placement-on-the-page.html) | `widget_position: left` §1.7 | Restyle |
| P3 | Top right | [png](screens/panels/02-placement-on-the-page--3-top-right.png) | [02](reference/02-placement-on-the-page.html) | — | New |
| P4 | Top left | [png](screens/panels/02-placement-on-the-page--4-top-left.png) | [02](reference/02-placement-on-the-page.html) | — | New |
| P5 | Middle, right edge | [png](screens/panels/02-placement-on-the-page--5-middle-right-edge.png) | [02](reference/02-placement-on-the-page.html) | — | New |
| P6 | Bottom center | [png](screens/panels/02-placement-on-the-page--6-bottom-center.png) | [02](reference/02-placement-on-the-page.html) | — | New |
| P7 | Phone, corner | [png](screens/panels/02-placement-on-the-page--7-phone-corner.png) | [02](reference/02-placement-on-the-page.html) | mobile §3 | Restyle + markup |
| P8 | Phone, bottom bar | [png](screens/panels/02-placement-on-the-page--8-phone-bottom-bar.png) | [02](reference/02-placement-on-the-page.html) | — | New |
| Sa | Ready | [png](screens/panels/03-button-states-and-motion--a-ready.png) | [03](reference/03-button-states-and-motion.html) | launcher online §2.2 | Restyle |
| Sb | Hover | [png](screens/panels/03-button-states-and-motion--b-hover.png) | [03](reference/03-button-states-and-motion.html) | hover flip §2.3 | Restyle |
| Sc | With the business logo | [logo face](screens/panels/03-button-states-and-motion--c-business-logo.png), [flipped to the call icon](screens/panels/03-button-states-and-motion--c-business-logo-flipped.png) | [03](reference/03-button-states-and-motion.html) | `config.avatar_url` §1.7, §2.1 | Restyle + markup |
| Sd | Offline | [png](screens/panels/03-button-states-and-motion--d-offline.png) | [03](reference/03-button-states-and-motion.html) | offline + `show_callback` §2.2 | Restyle + markup |
| Se | In line, panel minimized | [png](screens/panels/03-button-states-and-motion--e-in-line-minimized.png) | [03](reference/03-button-states-and-motion.html) | `queue_waiting` + closed (A3.19) | New |
| Sf | On a call, panel minimized | [png](screens/panels/03-button-states-and-motion--f-on-a-call-minimized.png) | [03](reference/03-button-states-and-motion.html) | `in_call` + closed (A3.19) | New |
| Sg | Video call, minimized | [png](screens/panels/03-button-states-and-motion--g-video-call-minimized.png) | [03](reference/03-button-states-and-motion.html) | `in_call` video + closed | New |
| Sh | Callback booked | [png](screens/panels/03-button-states-and-motion--h-callback-booked.png) | [03](reference/03-button-states-and-motion.html) | after `ended` (a) | New |
| F1–F4 | Closed · Opening 520 ms · Open · Closing 500 ms | [1](screens/panels/03-button-states-and-motion--motion-1-closed.png) [2](screens/panels/03-button-states-and-motion--motion-2-opening.png) [3](screens/panels/03-button-states-and-motion--motion-3-open.png) [4](screens/panels/03-button-states-and-motion--motion-4-closing.png) | [03](reference/03-button-states-and-motion.html) | open/close §3 | New |
| LP closed | Live prototype, closed (round with a label, bottom right) | [png](screens/panels/04-live-prototype--closed.png) | [04](reference/04-live-prototype.html) | launcher | Restyle |
| LP open-home | Panel open on home | [png](screens/panels/04-live-prototype--open-home.png) · [state](screens/states/04-live-prototype--open-home.png) | [ref](reference/04-live-prototype--open-home.html) | `online_available` §4.2 | Restyle + markup |
| LP queue | Queue (stage) | [png](screens/panels/04-live-prototype--queue.png) · [state](screens/states/04-live-prototype--queue.png) | [ref](reference/04-live-prototype--queue.html) | `queue_waiting` §4.5 | New markup |
| LP call | Voice call (stage) | [png](screens/panels/04-live-prototype--call.png) · [state](screens/states/04-live-prototype--call.png) | [ref](reference/04-live-prototype--call.html) | `in_call` §4.6 | New markup |
| LP minimized-call | Call carried on in the launcher | [png](screens/panels/04-live-prototype--minimized-call.png) · [state](screens/states/04-live-prototype--minimized-call.png) | [ref](reference/04-live-prototype--minimized-call.html) | `in_call` + closed | New |
| LP rating | Rating | [png](screens/panels/04-live-prototype--rating.png) · [state](screens/states/04-live-prototype--rating.png) | [ref](reference/04-live-prototype--rating.html) | `ended` (b) §4.7 | Restyle + markup |
| LP thanks | Thanks | [png](screens/panels/04-live-prototype--thanks.png) · [state](screens/states/04-live-prototype--thanks.png) | [ref](reference/04-live-prototype--thanks.html) | `ended` (c) §4.7 | Restyle + markup |
| LP button-c-br, -p-bl, -r-br, -t-tr | Round / pill bottom left / rectangular / edge tab top right | [c-br](screens/panels/04-live-prototype--button-c-br.png) [p-bl](screens/panels/04-live-prototype--button-p-bl.png) [r-br](screens/panels/04-live-prototype--button-r-br.png) [t-tr](screens/panels/04-live-prototype--button-t-tr.png) · states [c-br](screens/states/04-live-prototype--button-c-br.png) [p-bl](screens/states/04-live-prototype--button-p-bl.png) [r-br](screens/states/04-live-prototype--button-r-br.png) [t-tr](screens/states/04-live-prototype--button-t-tr.png) | [c-br](reference/04-live-prototype--button-c-br.html) [p-bl](reference/04-live-prototype--button-p-bl.html) [r-br](reference/04-live-prototype--button-r-br.html) [t-tr](reference/04-live-prototype--button-t-tr.html) | launcher + placement | New |

**Panel screens** (board 05 also in radius `sm` / `lg`: [sm](screens/states/05-starting-a-call--radius-sm.png),
[lg](screens/states/05-starting-a-call--radius-lg.png); reference pages
[`--radius-sm`](reference/05-starting-a-call--radius-sm.html), [`--radius-lg`](reference/05-starting-a-call--radius-lg.html))

| ID | Screen | Screenshot (2x) | Reference page | Production view (map §) | Work |
|---|---|---|---|---|---|
| 01 | Home, operators online | [png](screens/panels/05-starting-a-call--01-home-operators-online.png) ([sm](screens/panels/05-starting-a-call--01-home-operators-online--radius-sm.png), [lg](screens/panels/05-starting-a-call--01-home-operators-online--radius-lg.png)) | [05](reference/05-starting-a-call.html) | `online_available` §4.2 | Restyle + markup |
| 02 | Pre-call form, with an error | [png](screens/panels/05-starting-a-call--02-precall-form-with-an-error.png) ([sm](screens/panels/05-starting-a-call--02-precall-form-with-an-error--radius-sm.png), [lg](screens/panels/05-starting-a-call--02-precall-form-with-an-error--radius-lg.png)) | [05](reference/05-starting-a-call.html) | `pre_call_form` + `controller.error` §4.4 | Restyle + markup |
| 03 | Returning visitor | [png](screens/panels/05-starting-a-call--03-returning-visitor.png) ([sm](screens/panels/05-starting-a-call--03-returning-visitor--radius-sm.png), [lg](screens/panels/05-starting-a-call--03-returning-visitor--radius-lg.png)) | [05](reference/05-starting-a-call.html) | `pre_call_form` + `identifiedContact` §4.4 | Restyle + markup |
| 04 | Connecting | [png](screens/panels/06-waiting-in-line--04-connecting.png) | [06](reference/06-waiting-in-line.html) | `loading` §4.1 | New markup |
| 05 | In line, third | [png](screens/panels/06-waiting-in-line--05-in-line-third.png) | [06](reference/06-waiting-in-line.html) | `queue_waiting`, position > 1 §4.5 | New markup |
| 06 | Next, with a callback offer | [png](screens/panels/06-waiting-in-line--06-next-with-a-callback-offer.png) | [06](reference/06-waiting-in-line.html) | `queue_waiting`, position 1 + offer §4.5 | New markup |
| 07 | Operator joining | [png](screens/panels/07-on-a-call--07-operator-joining.png) | [07](reference/07-on-a-call.html) | `in_call` / `waiting_for_operator` §4.6 | New markup |
| 08 | Voice call | [png](screens/panels/07-on-a-call--08-voice-call.png) | [07](reference/07-on-a-call.html) | `in_call` / `in_call` + `operator_connected`, voice §4.6 | New markup |
| 09 | Video call | [png](screens/panels/07-on-a-call--09-video-call.png) | [07](reference/07-on-a-call.html) | `in_call` live, video §4.6, §6.1 | New markup |
| 10 | Transferring | [png](screens/panels/08-during-the-call--10-transferring.png) | [08](reference/08-during-the-call.html) | `in_call` + `transferring` §4.6 | New markup |
| 11 | Reconnecting | [png](screens/panels/08-during-the-call--11-reconnecting.png) | [08](reference/08-during-the-call.html) | `in_call` / `media_reconnecting` §4.6 | New markup |
| 12 | Microphone blocked | [png](screens/panels/08-during-the-call--12-microphone-blocked.png) | [08](reference/08-during-the-call.html) | `in_call` / `microphone_permission_denied` §4.6 | New |
| 13 | Rating the call | [png](screens/panels/09-after-the-call--13-rating-the-call.png) | [09](reference/09-after-the-call.html) | `ended` (b) §4.7 | Restyle + markup |
| 14 | Thank you | [png](screens/panels/09-after-the-call--14-thank-you.png) | [09](reference/09-after-the-call.html) | `ended` (c) §4.7 | Restyle + markup |
| 15 | Error | [png](screens/panels/09-after-the-call--15-error.png) | [09](reference/09-after-the-call.html) | `error` §4.9 | Restyle + markup |
| 16 | Team offline | [png](screens/panels/10-callback--16-team-offline.png) | [10](reference/10-callback.html) | `offline` §4.3 | Restyle + markup |
| 17 | Callback, step 1 | [png](screens/panels/10-callback--17-callback-step-1.png) | [10](reference/10-callback.html) | `callback_form` §4.4/4.8 (step 1) | New markup |
| 18 | Callback, step 2 | [png](screens/panels/10-callback--18-callback-step-2.png) | [10](reference/10-callback.html) | `callback_form` (step 2) | New markup |
| 19 | Callback scheduled | [png](screens/panels/10-callback--19-callback-scheduled.png) | [10](reference/10-callback.html) | `ended` (a) §4.7 | Restyle + markup |
| 20 | Button on the page (mobile) | [png](screens/panels/11-mobile--20-button-on-the-page.png) | [11](reference/11-mobile.html) | launcher ≤640px | Restyle |
| 21 | Home as a sheet | [png](screens/panels/11-mobile--21-home-as-a-sheet.png) | [11](reference/11-mobile.html) | `online_available`, mobile | New |
| 22 | Queue, full screen | [png](screens/panels/11-mobile--22-queue-full-screen.png) | [11](reference/11-mobile.html) | `queue_waiting`, mobile | New |
| 23 | Video call, full screen | [png](screens/panels/11-mobile--23-video-call-full-screen.png) | [11](reference/11-mobile.html) | `in_call` video, mobile | New |

**Design system (board 12, spec content)**

| ID | Card | Screenshot (2x) | Reference page | Production | Work |
|---|---|---|---|---|---|
| DS1 | Color | [png](screens/panels/12-design-system--01-color.png) | [12](reference/12-design-system.html) | tokens §7 | Restyle |
| DS2 | With any customer's brand color | [png](screens/panels/12-design-system--02-any-brand-color.png) | [12](reference/12-design-system.html) | `widget_theme.primary` §1.8 | see §3.1 note |
| DS3 | Type | [png](screens/panels/12-design-system--03-type.png) | [12](reference/12-design-system.html) | §7.3 | Restyle |
| DS4 | Corners and elevation | [png](screens/panels/12-design-system--04-corners-and-elevation.png) | [12](reference/12-design-system.html) | §7.2 | Restyle |
| DS5 | Buttons | [png](screens/panels/12-design-system--05-buttons.png) | [12](reference/12-design-system.html) | `.ccw-btn` | Restyle |
| DS6 | Form | [png](screens/panels/12-design-system--06-form.png) | [12](reference/12-design-system.html) | §4.4 | Restyle + markup |
| DS7 | Call controls | [png](screens/panels/12-design-system--07-call-controls.png) | [12](reference/12-design-system.html) | §4.6 controls | New markup |
| DS8 | Status (call) | [png](screens/panels/12-design-system--08-status-call.png) | [12](reference/12-design-system.html) | pills, rings | New markup |
| DS9 | Status (presence) | [png](screens/panels/12-design-system--09-status-presence.png) | [12](reference/12-design-system.html) | header status | Restyle |
| DS10 | Rating | [png](screens/panels/12-design-system--10-rating.png) | [12](reference/12-design-system.html) | stars §6.7 | Restyle |
| DS11 | Motion | [png](screens/panels/12-design-system--11-motion.png) | [12](reference/12-design-system.html) | §7.3 motion | Restyle |

### 1.1 Production screens 01–25 (owner's README) → design

| Prod # | Production state | Design | Notes |
|---|---|---|---|
| 01 | launcher (online) | L2, Sa, LP closed | default style "round with a label" |
| 02 | launcher-offline | Sd | Ink → white button, `phone-in` icon, hollow dot |
| 03 | home-online | 01 | |
| 04 | precall-form | 02 (without the error line) | department select → chips, contact fields grouped, consent switch |
| 05 | precall-form-filled-error | 02 | |
| 06 | precall-returning-visitor | 03 | |
| 07 | connecting (`loading`) | 04 | |
| 08 | queue | 05 | |
| 09 | queue-next-offer-callback | 06 | |
| 10 | incall-connecting (`waiting_for_operator`) | 07 | |
| 11 | incall-voice | 08 | |
| 12 | incall-video | 09 | |
| 13 | incall-transferring | 10 | |
| 14 | incall-reconnecting | 11 | |
| 15 | ended-rating | 13 | |
| 16 | ended-thanks | 14 | |
| 17 | callback-form | 17 + 18 | one long form becomes two steps |
| 18 | callback-form-scheduled-urgent | 17 (Video, Schedule, Urgent) + 18 | `datetime-local` becomes day + time chips |
| 19 | callback-confirmed | 19 | |
| 20 | offline-home | 16 | |
| 21 | error | 15 | |
| 22 | mobile launcher | 20 | |
| 23 | mobile home | 21 | bottom sheet |
| 24 | mobile queue | 22 | full screen |
| 25 | mobile in-call video | 23 | full screen, docked controls |

### 1.2 Every engine state and sub-state → design screen

| Engine state (map §4) | Sub-state | Design screen | Status |
|---|---|---|---|
| `loading` | `POST calls/request` in flight | 04 | drawn |
| `online_available` | — | 01 (21 on mobile) | drawn |
| `offline` | `offline_behavior: 'show_callback'` (+ `caps.callback`) | 16, launcher Sd | drawn |
| `offline` | any other value ("message only") | 16 without the button and the `.inl` line; launcher like Sd with "Support / Offline" | **not drawn** (suggestion) |
| `offline` | `'hide'` | wrap and panel `hidden` | nothing to draw |
| `pre_call_form` | fields, error, identified contact | 02, 03 | drawn |
| `queue_waiting` | position > 1 | 05 | drawn |
| `queue_waiting` | position 1 | 06 heading/copy; queue card with "Next" as in LP queue at `q1` | drawn |
| `queue_waiting` | offer threshold crossed | 06 (offer card replaces the queue card) | drawn |
| `queue_waiting` | `audio.needsGesture()` | `.hint` "Tap to enable sound" | **CSS only** (`cc.css:417`), not placed on any board |
| `in_call` | `connecting`, `pending`, `token_ready`, `loading_media_client`, `connecting_media` | 04 composition (spinning orb) with the status message as the title | **not drawn** (suggestion) |
| `in_call` | `waiting_for_operator` | 07 | drawn |
| `in_call` | `operator_connected`, `in_call` (live), voice | 08 | drawn |
| `in_call` | live, video | 09 (23 mobile) | drawn |
| `in_call` | `transferring === true` (any status) | 10 | drawn |
| `in_call` | `media_reconnecting` | 11 | drawn |
| `in_call` | `microphone_permission_denied` | 12 | drawn |
| `in_call` | `camera_permission_denied` | 08 with a `.bnr`-style notice and the voice controls (brief §11) | **not drawn** (suggestion) |
| `in_call` | `operator_left`, `media_disconnected`, `token_expired`, `room_connect_failed`, `rtc_v1_unsupported`, `media_client_missing`, `media_client_invalid`, `provider_client_not_configured`, `provider_client_not_supported`, `media_not_configured` | 12 composition (`.sb.dn`: icon, title, body, `.row2`) with `wifi-off` / `warn`, "End call" and, where a retry or a callback makes sense, a second button | **not drawn** (suggestion) |
| `in_call` | `fallback`, `accepted_no_sdk` | never set (dead) | — |
| `ended` | (a) `callbackId` set | 19 (+ launcher Sh after closing) | drawn |
| `ended` | (b) `endedCallId && !ratingSubmitted` | 13 | drawn |
| `ended` | (c) `ratingSubmitted` | 14 | drawn |
| `callback_form` | step 1 / step 2 (renderer sub-state `ui.callbackStep`) | 17 / 18 | drawn |
| `error` | `controller.error` | 15 | drawn |
| closed panel | `queue_waiting` / `in_call` voice / `in_call` video / booked callback | Se / Sf / Sg / Sh | drawn |

---

## 2. Frame and layout

### 2.1 Panel `.cp` (desktop)

| Property | Value | Source |
|---|---|---|
| Size | **400 × 660** (`width:400px;height:660px`), `flex-direction:column`, `overflow:hidden`, `isolation:isolate` | `cc.css:101` |
| Radius | `var(--r-panel)` = 26px (`sm` 16px, `lg` 34px) on three corners; the **tail corner** `var(--tail)` = **8px** in every radius size | `cc.css:102`, `:58`, `:62-63` |
| Tail corner | cc.css writes `border-end-end-radius:var(--tail)` (bottom-right in LTR). Implement it on the **physical** corner of the anchor (brief §4): bottom-right placement → `border-bottom-right-radius`, bottom-left → bottom-left, top-right → top-right, top-left → top-left, in both directions. Edge and bottom-center placements: not specified in the design (suggestion: no tail, all corners `--r-panel`) | brief §4 |
| Background | light screens `#fff`; stage screens the Ink stage gradient (§3.1); video `#0A0D10` | `cc.css:102`, `:345`, `:449` |
| Shadow | `var(--sh-panel)` = `0 0 0 1px rgba(15,18,23,.05),0 16px 36px -16px rgba(15,18,23,.24),0 56px 110px -44px rgba(15,18,23,.42)` | `cc.css:36` |
| Text | `font-size:14px; line-height:1.6; color:var(--ink)` | `cc.css:102` |
| Viewport caps | keep production's `max-width:calc(100vw - 24px)`, `max-height` with `dvh` (brief §4) | brief §4 |
| Live prototype | the panel inside the fake site is **384px** wide (`.site2 .cp{width:384px;height:660px}`); build **400px** as on boards 05–10 and the brief | `cc.css:843` |

### 2.2 Regions, top to bottom (measured with the static reference pages)

**Light screens** (01–03, 13–19):

| Region | Class | Height / box | Notes |
|---|---|---|---|
| Header | `.hd` | 74px; `padding-inline:18px 14px`; `gap:12px`; `z-index:4`; flex, centred | logo 44 at x=18,y=15; name/status block; optional `.lang`; collapse `.ib` 38 at x=348,y=18 |
| Context row (forms only) | `.ctx` | 44px; `padding:0 14px 8px`; `gap:8px` | back `.ib` 36 at x=14; `.ct` chip; `.stp` step counter pushed to the end |
| Body | `.bd` | flex 1; `padding:2px 18px 0`; `overflow:hidden`; column | 546px on home, 440px with `.ctx` and `.acts`, 484px with `.acts` only, 532px with neither |
| Actions | `.acts` | 62px = `padding:12px 18px 0` + 50px buttons; `gap:10px` | pinned above the footer |
| Footer | `.pw` | 40px; centred; `gap:6px` | "Powered by" + lockup |

Screens without `.acts` (15, 16) insert a `<div style="height:14px;flex:none">` spacer before `.pw`.

**Stage screens** (04–08, 10–12):

| Region | Class | Height / box | Notes |
|---|---|---|---|
| Header | `.hd` | 74px | stage variant (§4.2) |
| Stage body | `.sb` | flex 1; `padding:0 22px`; column, centred, `text-align:center` | 476px with the queue dock, 446px with the call dock, 532px on 12 |
| Queue dock | `.dock.q` | 70px = `padding:14px 20px 2px` + 54px controls; `gap:14px`; `align-items:center` | sound toggle + Cancel call |
| Call dock | `.dock` | 100px = `padding:14px 20px 2px` + 84px (End 66px with `margin-top:-4px`, label below); `gap:24px` | Mute · End · Minimize |
| Footer | `.pw` | 40px | stage colours |

**Video screen** (09): layered, not stacked. `.feed` `position:absolute; inset:0; z-index:-2` (the remote video), header
on top (`.vid .hd{background:transparent}`), `.vtop` at `top:82px`, `.pip` at `bottom:136px; inset-inline-end:16px`,
`.vdock` at `bottom:50px`, `.pw` absolute at `bottom:4px`; all three overlays `z-index:3`.

**Scrolling.** The design body `.bd` is `overflow:hidden` and every drawn screen fits (screen 18 ends 7px above `.acts`).
Production content can be longer (custom `pre_call_form_schema` fields, long error strings, `custom_texts`, 14px
`density`), and the panel can be shorter than 660px (viewport cap). Not specified in the design; suggestion:
`overflow-y:auto` on `.bd` / `.sb` with the header, `.ctx`, `.acts` / `.dock` and `.pw` pinned, as drawn.

**Z-order.** `.hd` `z-index:4`; stage noise `.cp.stage::after` `z-index:-1`; video `.feed` `-2`; `.vtop`, `.pip`,
`.vdock`, `.vid .pw` `3`; focused field `.fr:focus-within` `1`. Production wrap and panel keep `z-index:2147483000`.

### 2.3 Mobile (≤640px, brief §4) — board 11

The boards draw a 390 × 844 phone (`.cp.mob{width:390px;height:844px;border-radius:46px}`; the 46px corners, `.notch`
and `.homebar` are device chrome). Map to production `.ccw-panel` under `@media (max-width:640px)` (production today:
`@media (max-width:480px)`, map §3) with `env(safe-area-inset-*)` and `visualViewport` handling like the chat widget.

| Screen | Layout | Values (from `cc.css:519-548`) |
|---|---|---|
| 20 launcher | the selected launcher style in the corner (board: pill `.ln-p`, 184 × 56) | `.mln{position:absolute;right:18px;bottom:40px;z-index:4}` (the 40px includes the drawn home-bar zone) |
| 21 home | **bottom sheet** over a scrim | `.scrim{inset:0;z-index:5;background:rgba(6,10,12,.46)}`; `.sheet{inset-inline:0;bottom:0;z-index:6;height:654px;border-radius:30px 30px 0 0;background:#fff;box-shadow:0 -24px 48px -24px rgba(0,0,0,.45)}`; grabber `.grab` 40 × 5, radius 3, `var(--line-2)`, `margin:8px auto 0`; sheet header `.hd` 68px with no vertical padding; body and footer as on desktop (`.cp.mob .pw{margin-bottom:22px}`) |
| 22 queue | **full screen** stage | header `padding-top:58px; padding-bottom:12px` (header 114px); `.sb{padding-inline:26px}`; full-size orb (204px, not `.sm`); `.dock{padding-bottom:28px}`; footer `margin-bottom:22px` |
| 23 video | **full screen** video | `.vtop{top:104px}`; `.pip{bottom:150px;width:108px;height:150px}`; `.vdock{bottom:74px}`; `.pw{bottom:22px;margin-bottom:0}` |

The 58px header top padding is the drawn notch (10px + 32px) plus 16px; the 22px footer margin sits above the drawn home
bar. Suggestion: `padding-top: calc(env(safe-area-inset-top) + 16px)` and a bottom margin of
`env(safe-area-inset-bottom)` on real devices. Forms (02, 03, 17, 18), rating, thanks, error and the callback
confirmation are **not drawn on mobile**; suggestion: light screens use the sheet, stage screens use full screen.

---

## 3. Tokens

Production plumbing (brief §5): `applyTheme` keeps writing `--ccw-*` HSL channels on `.ccw-root` and additionally sets
`--a` (primary hex, no rounding) and `--on-a`. Every design token below is declared on `.ccw-root` (the design's `.cc`).

### 3.1 Colour

| Token | CSS (`.cc.b-rp` / `.cc`) | Default (tokens.json) | Used for | Production / theme key |
|---|---|---|---|---|
| `--a` | from `widget_theme.primary` | `#16142B` (Ink) | launcher fills, header logo tile, primary buttons, voice card, selected step bars, thanks / confirmation core | `--ccw-primary` + new `--a` (brief §5.1) |
| `--on-a` | `#fff` or `#16142B` (`lum()` rule) | `#FFFFFF` | text/icons on `--a` | new, set in `applyTheme` |
| `--a-1` | `color-mix(in oklab,var(--a) 6%,#fff)` | `#EFEFF1` | (Respok overrides most uses with `--paper`) | derived |
| `--a-2` | `…12%,#fff` | `#DFDFE3` | — (Respok overrides) | derived |
| `--a-3` | `…26%,#fff` | `#BBBBC3` | hover ring of `.chip` and `.opt.video` | derived |
| `--a-hi` | `…82%,#fff` | `#38384D` | board 12 swatch only | derived |
| `--a-ink` | `var(--a)` (Respok, `cc.css:50`) | `#16142B` | accent text: `.cbr .it`, `.known .ed`, `.sumchip .it/a`, `.okc .bdg` (overridden) | derived |
| `--ink` / `--ink-2` / `--ink-3` / `--ink-4` | `#16142B` / `#3D3B55` / `#5E5C75` / `#A9A7BC` | same | text, secondary, muted (Slate), faint / placeholders / offline (Away) | `text` → `--ink`, `muted` → `--ink-3` |
| `--paper` / `--paper-2` | `#F5F5F8` / `#EDECF2` | same | quiet fills (badge, ghost button, segmented track, cards) / hover | — |
| `--line` / `--line-2` | `#E4E3EC` / `#D3D1DE` | same | hairlines (Mist) / control borders, empty stars, switch track | `--ccw-border` |
| `--live` / `--live-hi` | `#FF5A3C` / `#FF5A3C` | Signal | online dots, launcher status dot, saved-contact check, stage live dots | `accent` → `--live` (brief §5.4) |
| `--glow` | `#FF5A3C` | Signal | rings, eq bars, wave bars, queue "You" glow, transfer arrows, offer icon | follows `--live` (suggestion) |
| `--star` | `#FF5A3C` | Signal | filled stars | follows `--live` (suggestion) |
| `--end` | `#E5432A` | End call | hang-up buttons, recording dots | `danger` → `--end` |
| `--bad` | `#D3361A` | Signal Deep | errors | `danger` → `--bad` |
| `--warn` / `--warn-ink` / `--warn-bg` | `#E8A317` / `#8A5300` / `#FFF6E1` | same | urgent priority | — |
| `--s1` / `--s2` / `--s3` | `#2E2A5E` / `#1A1838` / `#0D0C1C` | fixed | call stage gradient — **fixed Ink stage, not derived from the accent** (brief §5.2) | new design token (fixed, not from `widget_theme`) |
| `--core` / `--core-ink` | `linear-gradient(160deg,#FFFFFF,#E9E8F1)` / `#16142B` | fixed | the white orb core on the stage | new design token (fixed) |
| Stage light | `#3B3576` (indigo) | fixed | top-right radial in `.opt.voice`, `.cp.stage`, `.stage-bg`, `.sc.dk` | literal |

**Panel and stage backgrounds**

| Surface | Value | Source |
|---|---|---|
| Light panel | `#fff` | `cc.css:102` (brief §5.4: `surface` → this background) |
| Call stage (`.cp.stage`, `.stage-bg`) | `radial-gradient(90% 46% at 50% 30%,rgba(255,90,60,.2),transparent 72%),radial-gradient(120% 70% at 100% 0%,#3B3576 0%,transparent 58%),linear-gradient(180deg,var(--s1) 0%,var(--s2) 52%,var(--s3) 100%)` | `cc.css:345` |
| Stage grain | `.cp.stage::after`: `inset:0; z-index:-1; pointer-events:none; opacity:.06; mix-blend-mode:overlay;` inline SVG `feTurbulence` noise (`data:` URL, 180 × 180, `baseFrequency=.85`, `numOctaves=2`) | `cc.css:346-347` |
| Video | `.cp.stage.vid{background:#0A0D10}`; `.feed::after` scrim `linear-gradient(180deg,rgba(0,0,0,.48) 0%,transparent 26%,transparent 62%,rgba(0,0,0,.62) 100%)` | `cc.css:449`, `:456` |

**Radius setting** (`data-r` on the boards → production `data-radius`): `.cc[data-r=sm]{--r-panel:16px;--r-card:12px;--r-ctl:9px}`,
`md` (no attribute rule) 26 / 20 / 14, `.cc[data-r=lg]{--r-panel:34px;--r-card:26px;--r-ctl:19px}` (`cc.css:62-63`);
`--tail:8px` and `--tail-s:5px` in all three.

**Text on the accent.** `onA = 1.05/(L+0.05) >= (L+0.05)/(lum('#16142B')+0.05) ? '#FFFFFF' : '#16142B'` with WCAG
relative luminance `lum()` (every `source/*.dc.html`). Rules that **hard-code `#fff` on `var(--a)`** and must use
`var(--on-a)` instead: `cc.css:157` `.b-rp .opt.voice`, `:276` `.b-rp .okc .in`, `:567` `.b-rp .ln-c`, `:583`
`.b-rp .ln-c.logo .f2`, `:599` `.b-rp .ln-p`, `:616` `.b-rp .ln-r .go2`, `:620` `.b-rp .ln-s`, `:628` `.b-rp .ln-t`,
`:659` `.b-rp .ln-f .pb`; board 12 inline `style="background: var(--core); color: #fff"` on the `.bp .btn` demo.
The opposite error: `cc.css:325` `.b-rp .slots .chip.on{background:var(--ink)}` keeps the base `color:var(--on-a)`
(`:324`), so with a light custom accent (`--on-a` = Ink) the selected time slot turns Ink on Ink; use `#fff` there,
like `.b-rp .chip.on` (`:201`).

**Signal literals.** The Respok skin writes Signal as literals (`#FF5A3C`, `rgba(255,90,60,…)`, `#FFC2B4`, `#FFF1ED`,
`#FFEAE4`, `#C2361C`, and the `cc-lnwave-rp` keyframes) in the token block and in about twenty rules of §3.8. If `widget_theme.accent` must recolour them (brief §5.4), introduce one token
(suggestion: `--signal:#FF5A3C`, alpha forms via `color-mix`) in `presentation-intl.css`; otherwise keep the literals.

**Card DS2 vs the brief.** The card "With any customer's brand color — Every tint, shade and the call stage are made
from the main color" demonstrates derived stages (`.b-rp .bp .stage-bg`, `cc.css:891`, and inline `--s1..--s3`, `--glow`
on each `.bp`). For Respok the brief (§5.2) and the brand sheet fix the stage to Ink; the card is a WebYar-style demo.
Do not derive the Respok stage.

### 3.2 Typography

Font stacks: `--font: Figtree,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif` (`cc.css:59`); mono
`.b-rp .code{font-family:"DM Mono",ui-monospace,Menlo,monospace}` (`:336`). The Respok stack has **no Vazirmatn**: for
`lang="fa"` set `--font:"Vazirmatn",ui-sans-serif,system-ui,sans-serif` (tokens.json `fonts.text_rtl`). Base:
`-webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility` (`cc.css:45`). Card DS3 rows are marked ★.

| Role | Size / line-height / weight / letter-spacing | Classes |
|---|---|---|
| ★ Title (home) | 27px / 1.18 / 700 / -.022em (board 12 label says line-height 1.2) | `.b-rp .hh` |
| ★ Stage title | 23px / 1.25 / 700 / -.02em | `.b-rp .sh` |
| Centred title | 22px / 1.25 / 700 / -.015em | `.b-rp .ctr h3`, `.b-rp .rate h3` |
| Operator name (stage) | 22px / 1.3 / 700 / -.015em | `.b-rp .who-c .nm` |
| ★ Timer (queue) | 30px / 1 / 700 / .01em, `tabular-nums` | `.tmr b` |
| Orb initial | 48px / 1 / 700 | `.orb.op .core` |
| Option title | 16px / 1.4 / 700 | `.opt .ol b` |
| Button | 15px / 1 / 700 | `.btn`, `.xbtn`; `.btn.sm` 13.5px; `.offer .btn` 14px; `.mbar .btn` 13.5px |
| Header name | 15px / 1.45 / 700, ellipsis | `.hx .nm` |
| Card name | 15px / 1.45 / 700 | `.known b`, `.sumc b`; `.qs b` 15px/1.45/700 tnum |
| Field value | 14.5px / 1.5 / 500 (placeholder 400, `--ink-4`) | `.fr .v`, `.fr input`, `.inp input`; `.cbr b` 14.5/1.45/700; `.ctm` 14.5/700 tnum |
| ★ Body | 14px / 1.55 / 400 | `.b-rp .hs`; `.ta` 14px / 1.6 |
| Stage body | 13.5px / 1.5 | `.b-rp .sp` |
| Centred body | 13.5px / 1.55 | `.b-rp .ctr p` (also wins over `.inl` 12.5px, so the line under the offline button renders 13.5px) |
| Segment / chip | 13.5px / 700 (segment); 13px / 1 / 600 (chip) | `.seg button`, `.chip` |
| Consent | 13px / 1.6 | `.cons .tx`; `.rate p` 13px / 1.6; `.bnr` 13px/1.5/600; `.vtop` 13px/700 |
| ★ Label | 12.5px / 1.4 / 700 | `.lb`; `.ct` 12.5px/700; `.msg` 12.5/1.5/600; `.pill` 12.5px / 1 / 600; `.hx .st` 12.5px / 1.45 |
| ★ Caption | 12px / 500 (board 12) | `.badge` 12px/700 (`.chn` 500); `.opt .ol small` 12/1.5/500; `.trust li` 12/1.4/600; `.stp` 12/600; `.note` 12/1.6; `.rnote` 12/1.6 |
| Field label | 11.5px / 1.4 / 600 | `.fr label`; `.qs small` 11.5/1.5; `.cbn` 11.5/1.3/600; `.ql .me` 11.5/800; `.pw` 11.5px |
| Tag | 11px / 18px / 700 | `.cons .tx em` |
| Reference code | DM Mono 13px, `letter-spacing:.06em`, LTR isolate | `.code` (inside `.kv .v` at weight 700, which DM Mono 400/500 synthesises) |

### 3.3 Radii

| Token / element | Value |
|---|---|
| `--r-panel` | 26px (16 / 34) — panel |
| `--r-card` | 20px (12 / 26) — `.opt`, `.cbr`, `.known`, `.sumc`, `.qc`, `.offer`, `.kv`, `.addr` |
| `--r-ctl` | 14px (9 / 19) — `.btn`, `.grp`, `.inp`, `.ta`, `.cons`, `.permit`, `.sumchip`, `.bnr`, `.rnote`; `.seg` `calc(var(--r-ctl) + 2px)`, its buttons and `.btn.sm` `calc(var(--r-ctl) - 2px)` |
| `--tail` | 8px — panel tail corner |
| Fixed | `.lg` 14px · `.ib` 12px · `.lang` 10px · `.opt .oi` 15px · `.cbr .it` 13px · `.sumchip .it` 10px · `.known .ed` 10px · `.cpy` 8px · `.star` 14px · `.slots .chip` 12px · `.ei` 26px (light) / 50% (stage) · `.oi2` 28px · `.pip` 18px · `.mvid` 18px · `.sheet` 30px 30px 0 0 · pills, chips, avatars, `.dock` controls 999px / 50% · `.sw` 14px · `.addr .bar` 11px · `.addr .pop` 13px |
| Launchers (Respok tail on the end-end corner) | `.ln-p` 28px (end-end 10px) · `.ln-r` 20px (end-end 6px), `.go2` 15px (end-end 5px) · `.ln-s` 18px (end-end 7px), `.hf` 14px · `.ln-t` 16px 0 0 16px (bottom-left 6px) · `.ln-q` 19px (bottom-right 6px) · `.lbl` 20px 20px 4px 20px (`.at-l` 20px 20px 20px 4px) · `.mc` 30px · `.sched` 28px |

### 3.4 Shadows / elevation

| Name | Value | Used by |
|---|---|---|
| `--sh-panel` | see §2.1 | panel |
| `--sh-card` | `0 0 0 1px rgba(15,18,23,.05),0 2px 4px -1px rgba(15,18,23,.05),0 14px 32px -16px rgba(15,18,23,.26)` | `.lbl` |
| Respok accent lift | `0 12px 28px -8px rgba(22,20,43,.55)` | `.ln-c`, `.ln-p`, `.ln-s` |
| Logo tile | `0 8px 16px -8px rgba(22,20,43,.6)`; on stage `0 0 0 1px rgba(255,255,255,.16),0 8px 18px -8px rgba(0,0,0,.6)` | `.lg` |
| Primary button | `0 10px 22px -12px rgba(22,20,43,.7)` | `.b-rp .btn.pri` |
| Voice card | `0 18px 34px -16px rgba(22,20,43,.75)` | `.b-rp .opt.voice` |
| Danger | `0 10px 22px -12px color-mix(in oklab,var(--end) 85%,transparent)`; End `0 14px 28px -10px color-mix(…end 85%…),inset 0 1px 0 rgba(255,255,255,.25)`; `.xbtn` `0 14px 28px -12px …,inset 0 1px 0 rgba(255,255,255,.22)` | `.btn.dg`, `.cbn.end .bt`, `.xbtn` |
| Orb core | `0 0 0 10px rgba(255,255,255,.035),0 0 0 22px rgba(255,255,255,.02),0 26px 60px -14px color-mix(in oklab,var(--glow) 60%,transparent),inset 0 1px 0 rgba(255,255,255,.32)` | `.orb .core` |
| Selected segment | `0 1px 2px rgba(15,18,23,.08),0 4px 12px -4px rgba(15,18,23,.14)` | `.seg button.on` |
| Minimised call | `0 18px 34px -12px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.08)` | `.mc` |
| Minimised video | `0 0 0 1px rgba(15,18,23,.1),0 22px 40px -16px rgba(0,0,0,.6)` | `.mvid` |
| Booked callback | `0 0 0 1px var(--line),0 18px 34px -16px rgba(15,18,23,.4)` | `.sched` |
| Self-view | `0 0 0 1.5px rgba(255,255,255,.6),0 16px 30px -10px rgba(0,0,0,.6)` | `.pip` |
| Sheet | `0 -24px 48px -24px rgba(0,0,0,.45)` | `.sheet` |
| `--sh-ln` | `0 14px 30px -10px color-mix(in oklab,var(--a) 60%,transparent),0 3px 8px rgba(15,18,23,.14)` | base launchers (overridden by every Respok launcher rule) |

### 3.5 Spacing rhythm

Panel gutters 18px (light body, `.acts`), 22px (stage body; 26px on mobile). Header `padding-inline:18px 14px`, gap 12px.
Form stack `.fm` gap 14px (`padding-top:2px`); label → control 7px (`.lb margin:0 2px 7px`). Home: badge → title 14px,
title → copy 6px, copy → cards 24px, card gap 12px, cards → callback row 12px. Chips gap 8px; segmented `padding:4px;
gap:4px`; days row `margin-top:10px`, slots row `margin-top:8px`. Actions gap 10px. Call dock gap 24px, queue dock gap
14px, video dock gap 12px / padding 10px. Queue card `padding:14px 16px 12px`, stats `margin-top:12px; padding-top:12px`.

### 3.6 Icons

All from [`../../shared/icons/`](../../shared/icons/README.md): 24 × 24 viewBox, `fill:none`, `stroke:currentColor`,
round caps and joins. The boards set size and stroke per use:

| Use | Icon | Size / stroke |
|---|---|---|
| Launcher round / dark square / edge tab / pill / card / split | `phone` | 26/1.9 · 24/1.9 · 20/1.9 · 22/1.9 · 22/1.9 · 19/1.9 (+ `video` 19/1.9) |
| Offline launcher, callback row, offer, error / offline buttons, step chip | `phone-in` | 26/1.9 · 20/1.8 · 18/1.9 · 18/2 · 15/2 |
| Operator-face badge | `phone` | 14/2.2 |
| Header collapse | `chev-d` | 20/2 |
| Form back | `back` (mirrors) | 18/2 |
| Language | `globe` | 15/1.8 |
| Option go / Continue | `arrow-f` (mirrors) | 16/2.2 · 18/2.2 |
| Row chevron | `chevron-forward` (mirrors) | 18/2; transfer arrows 22/2 ×3 |
| Trust row | `shield`, `users`, `bolt` | 16/1.8 |
| Chip / button check, known contact, rating badge, thanks | `check` | 15/2.4 · 18/2.4 · 14/2.6 · 12/3 · 32/2.6 |
| Consent | `lock` | 18/1.8; address bar 13/2.2 |
| Error line / error screen | `warn` | 16/2 · 34/1.8 |
| Notes | `info` | 16/1.8 (`.rnote`) · 14/2 (`.note`) |
| Camera + mic hint | `video`, `mic` | 16/1.8 |
| Queue sound | `vol` / `vol-x` | 22/1.9 (dock) · 17/1.9 (`.sbt`) |
| Hang up | `hangup` | 22/2.1 (`.xbtn`) · 28/2 (`.cbn.end`) · 26/2 (video) · 20/2.1 (`.mc`) · 17/2.1 (`.mvid`) |
| Stage orb | `phone` | 46/1.7 (40 in `.orb.sm`, 28/1.8 in `.orb.xs`) |
| Queue operator dot / transfer target | `headset` | 17/1.8 · 30/1.7 |
| Call controls | `mic` / `mic-off` 24/1.9 · `video` / `video-off` 24/1.9 · `mini` 22/1.9 | video dock: `mic` 22/1.9, `video` 22/1.9, `mini` 20/1.9 |
| Minimised call / video | `expand` 17/2 (`.mc`) · 14/2.2 (`.mvid`); `mic` 18/2 · 15/2 | |
| Signal | `signal` | 15/2.2 |
| Reconnecting timer | `wifi-off` | 15/2 |
| Mic blocked | `mic-off` 34/1.8; popover `mic` 17/1.9; retry `retry` 18/2 | |
| Stars | `star` | 36/1.6 (rating), 18/1.6 (summary), 16/1.6 (board 12) |
| Callback segments | `phone` 16/2, `video` 17/2, `bolt` 16/2, `cal` 16/2 | |
| Offline tile / moon / timing note | `phone-in` 34/1.7 · `moon` 16/1.9 · `clock` 15/1.9 | |
| Confirmation badge / booked launcher / priority tag | `cal` 16/2 · 20/1.9 · `bolt` 13/2.2 | |
| Copy code | `copy` | 15/1.9 |
| Close label | `x` | 12/2.6 |

`hangup.svg` is `phone` rotated with `<g transform="rotate(135 12 12)">`. Directional icons (`back`, `arrow-f`,
`chevron-forward`, transfer arrows) need `class="dirf"` for the RTL fallback (`[dir=rtl] .dirf{transform:scaleX(-1)}`,
`cc.css:70`); the Respok boards (LTR) never set it.

### 3.7 Motion tokens

| Token | Value |
|---|---|
| `--ease` | `cubic-bezier(.2,.9,.25,1)` |
| `--ease-in` | `cubic-bezier(.55,0,.75,.2)` |
| `--spring` | `linear(0, 0.044 4.2%, 0.152 8.3%, 0.295 12.5%, 0.449 16.7%, 0.599 20.8%, 0.733 25%, 0.845 29.2%, 0.934 33.3%, 0.999 37.5%, 1.043 41.7%, 1.070 45.8%, 1.082 50%, 1.083 54.2%, 1.077 58.3%, 1.067 62.5%, 1.054 66.7%, 1.041 70.8%, 1.029 75%, 1.019 79.2%, 1.010 83.3%, 1.003 87.5%, 0.999 91.7%, 0.995 95.8%, 1)` |
| `--bounce` | `linear(0, 0.059 3.3%, 0.206 6.7%, 0.399 10%, 0.602 13.3%, 0.789 16.7%, 0.944 20%, 1.060 23.3%, 1.134 26.7%, 1.172 30%, 1.179 33.3%, 1.164 36.7%, 1.135 40%, 1.099 43.3%, 1.063 46.7%, 1.031 50%, 1.005 53.3%, 0.986 56.7%, 0.974 60%, 0.969 63.3%, 0.968 66.7%, 0.972 70%, 0.977 73.3%, 0.984 76.7%, 0.990 80%, 0.996 83.3%, 1.000 86.7%, 1.003 90%, 1.005 93.3%, 1.006 96.7%, 1)` |
| Fallback for `linear()` | `cubic-bezier(.2,.9,.25,1)` (brief §7) |
| Card DS11 | Open, spring 520 ms · Leave, ease-in 260 ms · Ring pulse 2400 ms · Stagger 60 ms · Voice halo 1600 ms · Reduced motion: Fade only (see §6 for where the CSS differs) |

### 3.8 The `intl` skin: every `.b-rp` rule in cc.css

This list is the content of `presentation-intl.css` (re-keyed from `.b-rp` to `.ccw-presentation-intl`). Rows marked
**chrome** style board frames only; do not ship them.

| cc.css | Selector | Property | Base value (line) | Respok value |
|---|---|---|---|---|
| 47 | `.cc.b-rp` | `--ink` `--ink-2` `--ink-3` `--ink-4` | `#0F1217` `#3F4551` `#626A77` `#A1A7B2` (19) | `#16142B` `#3D3B55` `#5E5C75` `#A9A7BC` |
| 47 | | `--paper` `--paper-2` | `color-mix(in oklab,var(--a) 3%,#F4F6F8)` / `…5%,#EBEEF1` (20-21) | `#F5F5F8` / `#EDECF2` |
| 47 | | `--line` `--line-2` | `color-mix(…6%,#E7EAEE)` / `…8%,#D4D9DF` (22-23) | `#E4E3EC` / `#D3D1DE` |
| 47 | | `--a-ink` | `color-mix(in oklab,var(--a) 70%,#0B0D12)` (17) | `var(--a)` |
| 47 | | `--live` `--live-hi` | `#12A150` `#3BDC8A` (24) | `#FF5A3C` `#FF5A3C` |
| 47 | | `--end` `--bad` | `#E5484D` `#D33A43` (25) | `#E5432A` `#D3361A` |
| 47 | | `--star` | `#F5A524` (27) | `#FF5A3C` |
| 47 | | `--glow` | `color-mix(in oklab,var(--a) 42%,#5CF2D6)` (28) | `#FF5A3C` |
| 47 | | `--s1` `--s2` `--s3` | `color-mix(…60%,#03110F)` `…30%,#03100E` `…12%,#020807` (29-31) | `#2E2A5E` `#1A1838` `#0D0C1C` |
| 47 | | `--core` | `linear-gradient(160deg,var(--a-hi),var(--a) 62%,color-mix(in oklab,var(--a) 82%,#000))` (32) | `linear-gradient(160deg,#FFFFFF,#E9E8F1)` |
| 47 | | `--core-ink` | `var(--on-a)` (33) | `#16142B` |
| 47 | | `--tail` `--tail-s` | `var(--r-panel)` `var(--r-ctl)` (34) | `8px` `5px` |
| 47 | | `--font` | `"Vazirmatn",ui-sans-serif,system-ui,sans-serif` (35) | `Figtree,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif` |
| 47 | | `background` (board) **chrome** | `color-mix(in oklab,var(--a) 6%,#E7EAEE)` (44) | `#E8E7EE` |
| 77 | `.b-rp .kick svg` **chrome** | color | `var(--a)` (76) | `#FF5A3C` |
| 79 | `.b-rp .cc-h` **chrome** | line-height; letter-spacing | 1.45; -.005em (78) | 1.3; -.012em |
| 81 | `.b-rp .cc-d` **chrome** | line-height | 1.8 (80) | 1.6 |
| 113 | `.b-rp .lg` | background; color; box-shadow | `var(--core)`; `var(--core-ink)`; `0 8px 16px -8px color-mix(…a 70%…),inset 0 1px 0 rgba(255,255,255,.25)` (112) | `var(--a)`; `var(--on-a)`; `0 8px 16px -8px rgba(22,20,43,.6)` |
| 140 | `.b-rp .badge` | background; box-shadow; color | `var(--a-1)`; `inset 0 0 0 1px var(--a-2)`; `var(--a-ink)` (137) | `var(--paper)`; `inset 0 0 0 1px var(--line)`; `var(--ink)` |
| 142 | `.b-rp .hh` | font-size; line-height; letter-spacing | 25px; 1.45; -.01em (141) | 27px; 1.18; -.022em |
| 144 | `.b-rp .hs` | line-height | 1.85 (143) | 1.55 |
| 157 | `.b-rp .opt.voice` | background; color; box-shadow | `var(--core)`; `var(--core-ink)`; `0 18px 34px -16px color-mix(…a 80%…),inset 0 1px 0 rgba(255,255,255,.22)` (156) | `radial-gradient(120% 90% at 100% 0%,#3B3576 0%,transparent 60%),var(--a)`; `#fff` (use `--on-a`); `0 18px 34px -16px rgba(22,20,43,.75)` |
| 164 | `.b-rp .opt.voice .rw` | border-color | `rgba(255,255,255,.22)` (161) | `rgba(255,90,60,.55)` |
| 168 | `.b-rp .opt.video .oi` | background; color | `var(--a-2)`; `var(--a-ink)` (167) | `var(--paper)`; `var(--ink)` |
| 181 | `.b-rp .trust svg` | color | `var(--a)` (180) | `var(--ink)` |
| 187 | `.b-rp .ct` | background; box-shadow; color | `var(--a-1)`; `inset 0 0 0 1px var(--a-2)`; `var(--a-ink)` (186) | `var(--paper)`; `inset 0 0 0 1px var(--line)`; `var(--ink)` |
| 201 | `.b-rp .chip.on` | background; box-shadow; color | `var(--a-1)`; `inset 0 0 0 1.5px var(--a)`; `var(--a-ink)` (199) | `var(--ink)`; `none`; `#fff` |
| 202 | `.b-rp .chip.on svg` | color | `var(--a)` (200) | `#fff` |
| 212 | `.b-rp .fr.fo` | box-shadow | `0 0 0 1.5px var(--a),0 0 0 5px var(--a-2)` (211) | `0 0 0 2px #FF5A3C,0 0 0 5px rgba(255,90,60,.12)` |
| 215 | `.b-rp .caret::after` | background | `var(--a)` (214) | `#FF5A3C` (fake caret; not needed with real inputs) |
| 218 | `.b-rp .inp.fo` | box-shadow | as 211 (217) | as 212 |
| 225 | `.b-rp .fr:focus-within, .b-rp .inp:focus-within, .b-rp .ta:focus` | box-shadow | as 211 (223-224) | as 212 |
| 235 | `.b-rp .sw.on` | background | `var(--a)` (234) | `#FF5A3C` |
| 246 | `.b-rp .btn.pri` | background; color; box-shadow | `var(--core)`; `var(--core-ink)`; `0 10px 22px -12px color-mix(…a 85%…),inset 0 1px 0 rgba(255,255,255,.2)` (245) | `var(--a)`; `var(--on-a)`; `0 10px 22px -12px rgba(22,20,43,.7)` |
| 255 | `.b-rp .known` | background; box-shadow | `var(--a-1)`; `inset 0 0 0 1px var(--a-2)` (254) | `var(--paper)`; `inset 0 0 0 1px var(--line)` |
| 268 | `.b-rp .ctr h3` | font-size; line-height; letter-spacing | 21px; 1.5; — (267) | 22px; 1.25; -.015em |
| 270 | `.b-rp .ctr p` | line-height | 1.8 (269) | 1.55 |
| 272 | `.b-rp .okc` | background | `var(--a-1)` (271) | `#FFF1ED` |
| 274 | `.b-rp .okc::before` | box-shadow | `0 0 0 1.5px var(--a-3)` (273) | `0 0 0 1.5px #FFC2B4` |
| 276 | `.b-rp .okc .in` | background; color | `var(--core)`; `var(--core-ink)` (275) | `var(--a)`; `#fff` (use `--on-a`) |
| 279 | `.b-rp .okc .bdg` | color | `var(--a-ink)` (278) | `#FF5A3C` |
| 282 | `.b-rp .oi2` | background; color; box-shadow | `var(--a-1)`; `var(--a-ink)`; `inset 0 0 0 1px var(--a-2)` (281) | `var(--paper)`; `var(--ink)`; `inset 0 0 0 1px var(--line)` |
| 292 | `.b-rp .sumc .avw .ck` | background | `var(--live)` (291) | `var(--ink)` |
| 298 | `.b-rp .rate h3` | font-size; line-height; letter-spacing | 20px; 1.5; — (297) | 22px; 1.25; -.015em |
| 316 | `.b-rp .seg button.on svg` | color | `var(--a)` (315) | `#FF5A3C` |
| 325 | `.b-rp .slots .chip.on` | background | `var(--a)` (324) | `var(--ink)` (text stays `var(--on-a)`; see §3.1) |
| 336 | `.b-rp .code` | font-family | `ui-monospace,"SF Mono",Menlo,monospace` (335) | `"DM Mono",ui-monospace,Menlo,monospace` |
| 345 | `.b-rp .cp.stage, .b-rp .stage-bg` | background | `radial-gradient(110% 58% at 50% 30%,color-mix(in oklab,var(--glow) 24%,transparent),transparent 72%),linear-gradient(180deg,var(--s1) 0%,var(--s2) 52%,var(--s3) 100%)` (344) | see §3.1 (Signal radial + `#3B3576` light) |
| 352 | `.b-rp .stage .lg` | background; color | `.b-rp .lg` values (113) | `#fff`; `var(--ink)` |
| 391 | `.b-rp .sh` | font-size; line-height; letter-spacing | 21px; 1.5; -.005em (390) | 23px; 1.25; -.02em |
| 393 | `.b-rp .sp` | line-height | 1.8 (392) | 1.5 |
| 406 | `.b-rp .ql .me` | color | `var(--s2)` (405) | `var(--ink)` |
| 416 | `.b-rp .offer .btn` | color | `var(--s3)` (415) | `var(--ink)` |
| 436 | `.b-rp .who-c .nm` | font-size; line-height; letter-spacing | 21px; 1.45; — (435) | 22px; 1.3; -.015em |
| 516 | `.b-rp .btn.wh` | color | `var(--s3)` (515) | `var(--ink)` |
| 563 | `.b-rp .ln .wv` | animation-name | `cc-lnwave` (562) | `cc-lnwave-rp` |
| 567 | `.b-rp .ln-c` | background; color; box-shadow | `var(--core)`; `var(--core-ink)`; `var(--sh-ln),inset 0 1px 0 rgba(255,255,255,.25)` (566) | `var(--a)`; `#fff` (use `--on-a`); `0 12px 28px -8px rgba(22,20,43,.55)` |
| 573 | `.b-rp .ln-c.off` | background; color | `linear-gradient(160deg,#fff,#EEF0F3)`; `var(--ink-2)` (572) | `#fff`; `var(--ink)` |
| 583 | `.b-rp .ln-c.logo .f2` | background; color | `var(--core)`; `var(--core-ink)` (582) | `var(--a)`; `#fff` (use `--on-a`) |
| 590 | `.b-rp .lbl` | border-radius | `16px 16px 6px 16px` (588) | `20px 20px 4px 20px` |
| 591 | `.b-rp .at-l .lbl` | border-radius | `16px 16px 16px 6px` (589) | `20px 20px 20px 4px` |
| 599 | `.b-rp .ln-p` | background; color; border-end-end-radius; box-shadow | `var(--core)`; `var(--core-ink)`; — (28px all); `var(--sh-ln),inset 0 1px 0 rgba(255,255,255,.22)` (597) | `var(--a)`; `#fff` (use `--on-a`); `10px`; `0 12px 28px -8px rgba(22,20,43,.55)` |
| 603 | `.b-rp .ln-p .ld` | background | `var(--live-hi)` (602) | `#FF5A3C` |
| 610 | `.b-rp .ln-r` | border-end-end-radius | — (20px all, 608) | `6px` |
| 616 | `.b-rp .ln-r .go2` | background; color; border-end-end-radius | `var(--core)`; `var(--core-ink)`; — (15px, 615) | `var(--a)`; `#fff` (use `--on-a`); `5px` |
| 620 | `.b-rp .ln-s` | background; color; border-end-end-radius; box-shadow | `var(--core)`; `var(--core-ink)`; — (18px); `var(--sh-ln),inset 0 1px 0 rgba(255,255,255,.2)` (619) | `var(--a)`; `#fff` (use `--on-a`); `7px`; `0 12px 28px -8px rgba(22,20,43,.55)` |
| 628 | `.b-rp .ln-t` | background; color; border-bottom-left-radius | `var(--core)`; `var(--core-ink)`; 16px (627) | `var(--a)`; `#fff` (use `--on-a`); `6px` |
| 635 | `.b-rp .ln-t .ld` | background | `var(--live-hi)` (634) | `#FF5A3C` |
| 639 | `.b-rp .ln-q` | background; border-bottom-right-radius | `linear-gradient(160deg,#2A2F38,#0E1116)`; 19px (638) | `linear-gradient(160deg,#2E2A5E,#16142B)`; `6px` |
| 643 | `.b-rp .ln-q .ls` | box-shadow | `0 0 0 2.5px #11141A,0 0 12px 2px color-mix(in oklab,var(--glow) 60%,transparent)` (642) | `0 0 0 2.5px #11141A,0 0 12px 2px rgba(255,90,60,.55)` |
| 659 | `.b-rp .ln-f .pb` | background; color | `var(--core)`; `var(--core-ink)` (658) | `var(--a)`; `#fff` (use `--on-a`) |
| 673 | `.b-rp .mc .mo` | background; color | `var(--core)`; `var(--core-ink)` (672) | `#fff`; `var(--ink)` |
| 701 | `.b-rp .sched .si` | background; color | `var(--a-2)`; `var(--a-ink)` (700) | `#FFEAE4`; `#C2361C` |
| 720 | `.b-rp .lgc.dark` **chrome** | background | `#11141A` (719) | `#0F0E1D` |
| 740 | `.b-rp .stc.dk` **chrome** | background | `linear-gradient(180deg,#1A1F26,#10141A)` (739) | `linear-gradient(180deg,#1E1B3B,#100E20)` |
| 764 | `.b-rp .frm .cap2 b span` **chrome** | color | `var(--a-ink)` (763) | `#C2361C` |
| 781 | `.b-rp .pmk .ghost` **chrome** | border-color; background | `color-mix(…a 60%…)`; `color-mix(…a 7%…)` (780) | `rgba(255,90,60,.6)`; `rgba(255,90,60,.06)` |
| 785 | `.b-rp .pmk .arw` **chrome** | color | `var(--a-ink)` (784) | `#C2361C` |
| 789 | `.b-rp .pm .cap b em` **chrome** | background; color | `var(--a-2)`; `var(--a-ink)` (788) | `#FFEAE4`; `#A62A12` |
| 802 | `.b-rp .site2 .sbar` **chrome** | background; box-shadow | `#EEF0F3`; `0 1px 0 #E2E5EA` (801) | `#ECEBF1`; `0 1px 0 #E1E0E8` |
| 836 | `.b-rp .site2.pos-bl .lbl, .b-rp .site2.pos-tl .lbl` | border-radius | `16px 16px 16px 6px` (835) / `6px 16px 16px 16px` (838) | `20px 20px 20px 4px` (for top-left this puts the tail at the bottom; see §11) |
| 875 | `.b-rp .ql2 .me` | color | `var(--s2)` (874) | `var(--ink)` |
| 891 | `.b-rp .bp .stage-bg` **chrome** | background | `.b-rp .stage-bg` (345) | the base derived stage (card DS2 demo) |
| 907 | `.b-rp .mn .it.on` **chrome** | background | `var(--a-1)` (906) | `#FFF4F1` |
| 910 | `.b-rp .mn .it.on .ic` **chrome** | background; color | `var(--a)`; `var(--on-a)` (909) | `var(--ink)`; `#fff` |
| 916 | `.b-rp .curve` **chrome** | color | `var(--a)` (915) | `#FF5A3C` |
| 928 | `.b-rp .sc.dk` **chrome** | background | `radial-gradient(110% 70% at 50% 0%,color-mix(…glow 22%…),transparent 72%),linear-gradient(180deg,var(--s1) 0%,var(--s2) 55%,var(--s3) 100%)` (927) | `radial-gradient(90% 60% at 50% 0%,rgba(255,90,60,.18),transparent 72%),radial-gradient(120% 80% at 100% 0%,#3B3576 0%,transparent 58%),linear-gradient(180deg,var(--s1) 0%,var(--s2) 55%,var(--s3) 100%)` |
| 937 | `.b-rp .sw-i code` **chrome** | font-family | `ui-monospace,"SF Mono",Menlo,monospace` (936) | `"DM Mono",ui-monospace,Menlo,monospace` |
| 976 | `.b-rp :is(button,a,[role=textbox]):focus-visible` | outline-color | `var(--a)` (975: `outline:2px solid var(--a);outline-offset:2px`) | `#FF5A3C` |

Not in `.b-rp` but Respok-specific through the root class: `.cc.lg-open .g-t, .cc.lg-thread .g-o{display:none!important}`
(`cc.css:69`) switches the footer lockup by `logoDirection`.

---

## 4. Components

Design class → production element. Production has no `data-*` action hooks (map §6.2); every control gets a direct
listener that calls the controller method named here. Keep the production containers `ccw-root`, `ccw-launcher-wrap`,
`ccw-panel` (+ `left` / `right`), `[hidden]`, and add the design classes inside them.

### 4.1 Launcher styles (board 01) and the `launcher_style` setting

Setting `config.launcher_style` (canonical name in
[`shared/new-hooks-and-settings.md`](../../shared/new-hooks-and-settings.md)). Default **`round_label`** (board 04 script: `style:'cl'`). Every style is a
`button` (or a `role="group"` of buttons) inside `ccw-launcher-wrap`; click → `controller.toggleOpen()` unless noted.

| Value | Board | Class | Anatomy and exact values |
|---|---|---|---|
| `round` | L1 | `button.ln.ln-c` | 60 × 60 circle; bg `var(--a)`, icon colour `#fff` (→ `--on-a`); shadow `0 12px 28px -8px rgba(22,20,43,.55)`; `phone` 26 with `.wig` (wiggle 3.6s); status dot `.ls` 14 × 14 at `top:1px; inset-inline-end:1px`, bg `var(--live)`, ring `0 0 0 2.5px #fff`; wave layer `.wv` (`inset:0; z-index:-1; border-radius:inherit`, `cc-lnwave-rp 3.6s var(--ease) infinite`). Hover `translateY(-3px) scale(1.05)`, active `scale(.94)`, `transition: transform .3s var(--ease), box-shadow .3s ease` |
| `round_label` | L2 | `div.ln-cl` > `span.lbl` + `button.ln.ln-c` | flex, `gap:12px`, `direction:ltr` (label always on the page side; `.at-l` = `row-reverse` for left placements). Label: column, `gap:2px`, `padding:10px 14px`, radius `20px 20px 4px 20px` (`.at-l`: `20px 20px 20px 4px`), `#fff`, `var(--sh-card)`, nowrap; `b` "Talk now" 13.5/700/1.45 ink; `small` 12/1.45 ink-3 with `.dot` + "Live support"; entrance `cc-lbl .6s var(--spring) .4s backwards`. Dismiss `button.x` (aria "Close"): 22 × 22 circle at `top:-8px; left:-8px` (`.at-l`: `right:-8px`), `#fff`, `var(--ink-3)`, `0 0 0 1px var(--line),0 4px 8px -4px rgba(15,18,23,.3)`, `x` 12/2.6. Measured 181 × 60 |
| `pill` | L3 | `button.ln.ln-p` | 56 high, `padding-inline:6px 20px`, radius 28px with end-end 10px, bg `var(--a)`, `#fff`, 15/700, `gap:10px`; icon disc `.pi` 44 circle `rgba(255,255,255,.18)` with `phone` 22; text "Call support"; live dot `.ld` 8 × 8 `#FF5A3C` ring `0 0 0 3px rgba(255,255,255,.22)`, `margin-inline-start:2px`; `.wv`. Hover `translateY(-3px)`. Small variant `.ln-p.sm` (phone placements): 48 high, `gap:8px`, `padding-inline:5px 16px`, 14px, `.pi` 38. Measured 184 × 56 |
| `card` | L4 | `button.ln.ln-r` | 300 × 72, `padding-inline:14px 10px`, radius 20px with end-end 6px, `#fff`, ink, shadow `0 0 0 1px rgba(15,18,23,.06),0 22px 40px -22px rgba(15,18,23,.45)`, `gap:12px`; avatars `.avs` (32px `.av`, overlap `margin-inline-start:-9px`, ring `0 0 0 2.5px #fff`); text `b` "Talk to our team" 14/700/1.4, `small` 12 ink-3 with `.dot` "Operators available", `gap:3px`; go tile `.go2` 50 × 50 radius 15px (end-end 5px) `var(--a)` / `#fff`, shadow `0 8px 16px -8px color-mix(in oklab,var(--a) 80%,transparent)`, `phone` 22. Hover `translateY(-3px)` |
| `split` | L5 | `div.ln.ln-s[role=group][aria-label="Call us"]` > `button.hf.pri` + `i.dv` + `button.hf` | 56 high, `padding:4px`, radius 18px (end-end 7px), `var(--a)` / `#fff`, shadow as round; halves `padding:0 16px`, radius 14px, 14/700, `gap:8px`, icons 19: "Voice call" (`phone`, `.pri` bg `rgba(255,255,255,.17)` + `inset 0 0 0 1px rgba(255,255,255,.12)`) and "Video" (`video`); hover bg `rgba(255,255,255,.24)`; divider 1px `rgba(255,255,255,.22)`, `margin:12px 2px`. Clicks: open the panel and call `startCall('voice' / 'video')` **synchronously in the same click** (ringback gesture). Hide a half whose capability is off. Measured 231 × 56 |
| `edge_tab` | L6 | `button.ln.ln-t` | width 50, `padding:14px 0 16px`, column, `gap:12px`; radius `16px 0 0 16px` with bottom-left 6px (left edge `.at-l`: `0 16px 16px 0`, no tail); `var(--a)` / `#fff`; shadow `-10px 12px 28px -12px color-mix(in oklab,var(--a) 70%,transparent)` (left edge mirrored `10px …`); `phone` 20; text `.vt` "Call us" 14/700, `letter-spacing:.01em`, `writing-mode:vertical-rl; transform:rotate(180deg)` (left edge: no rotate); dot `.ld` 8px `#FF5A3C`. Hover `translateX(-4px)` (left `+4px`). Measured 50 × 125 |
| `dark_square` | L7 | `button.ln.ln-q` | 58 × 58, radius 19px with bottom-right 6px; bg `linear-gradient(160deg,#2E2A5E,#16142B)` (fixed, not the accent); `#fff`; shadow `0 14px 28px -10px rgba(0,0,0,.65),inset 0 1px 0 rgba(255,255,255,.12),inset 0 0 0 1px rgba(255,255,255,.06)`; `phone` 24; dot `.ls` at `top:-3px; inset-inline-end:-3px`, bg `var(--glow)`, `0 0 0 2.5px #11141A,0 0 12px 2px rgba(255,90,60,.55)`. Hover `translateY(-3px)` |
| `operator_face` | L8 | `div.ln-f` > `span.lbl` + `button.fp` | flex `gap:12px`, `direction:ltr`; label as `round_label` with "Talk now" + `.dot` + operator name; photo button 64 × 64: `.pic` circle (`overflow:hidden`, ring `0 0 0 3px #fff`, `0 14px 28px -10px rgba(15,18,23,.5)`) holding the operator photo (new data; placeholder art on the board); ring `.ring2` `inset:-6px`, 2px `var(--live)`, `cc-ring 2.4s`; badge `.pb` 28 × 28 at `bottom:-3px; right:-4px`, `var(--a)` / `#fff`, ring `0 0 0 3px #fff`, `phone` 14/2.2 |
| `mobile_bar` | L9 | `div.mbar` > `button.btn.pri` + `button.btn.sec` | phones only: `position:absolute` → fixed to the viewport bottom, `inset-inline:0`, `padding:10px 10px 20px`, `gap:8px`, bg `rgba(255,255,255,.94)`, `box-shadow:0 -1px 0 var(--line),0 -14px 28px -18px rgba(15,18,23,.35)`, `backdrop-filter:blur(12px)`; buttons flex 1, 46 high, `padding:0 10px`, 13.5px: "Voice call" (`phone` 17/2) → open + `startCall('voice')`; "Callback" (`phone-in` 17/2) → open + `openCallback()`. The `.hb` home indicator is chrome. Above 640px not specified (suggestion: fall back to `round_label`) |

The five styles of the live prototype (`.lw.c/.cl/.p/.r/.t`) are `round`, `round_label`, `pill`, `card`, `edge_tab`.

### 4.2 Launcher states (board 03)

| State | Board | Condition (production) | Markup and values |
|---|---|---|---|
| Ready | Sa | `online_available` (`isOnline()`) | live dot `.ls`; the wave `.wv` "rolls out every few seconds": `cc-lnwave-rp` 3.6s (`box-shadow 0 0 0 0 rgba(255,90,60,.45)` → `0 0 0 20px rgba(255,90,60,0)` at 45%) |
| Hover | Sb | `:hover` / `:focus-visible` | caption: "The business logo flips to the call icon and the label slides open." The card shows `round_label` with the label already open and no logo |
| With the business logo | Sc | `config.avatar_url` | `.ln-c.logo`: bg `#fff`, colour `var(--a)`, shadow `0 0 0 1px var(--line),0 14px 28px -12px rgba(15,18,23,.4)`; flipper `.fc` (`transform-style:preserve-3d`), faces `.f1` (the logo `img`, `object-fit:cover`, circle; board letter "N" 24/700) and `.f2` (`rotateY(180deg)`, bg `var(--a)`, `phone` 26); faces `backface-visibility:hidden`. Flip on hover: `.fc.flipped{transform:rotateY(180deg)}`. The board runs `cc-flip 4.4s var(--spring) infinite` (`.fc.auto`) for demonstration; `.fc` has no transition in cc.css (suggestion: `transition: transform .55s var(--spring)`) |
| Offline | Sd | `offline` + `offline_behavior:'show_callback'` | `.ln-c.off`: bg `#fff`, `var(--ink)`, shadow `0 0 0 1px var(--line-2),0 12px 26px -12px rgba(15,18,23,.35)`; icon `phone-in` 26; no wiggle, no wave; dot `.ls.off` = `#fff` + `inset 0 0 0 2.5px var(--ink-4)` + `0 0 0 2.5px #fff`; label "Callback" / `.dot.off` "Leave details"; `aria-label="Callback"` |
| In line, minimized | Se | `queue_waiting` and panel closed | `div.mc.stage-bg[role=status]`: 60 high, radius 30px, `padding-inline:6px 8px`, `gap:10px`, stage background, shadow §3.4. Icon disc `.mo` 48 circle `#fff` / ink with `phone` 22 (wiggle 2.4s) and two rings (`::before`, `::after` delay 1.2s; 1.5px `var(--glow)`, `cc-ring 2.4s`). Text `b` "#3 in line" (position 1: "Next"), `small` "Waiting time 0:47" (12/600, `rgba(255,255,255,.66)`, tnum). Buttons `.mbt` 40 circle `rgba(255,255,255,.12)`: `expand` 17/2 aria "Open the call" → `toggleOpen()`; `.mbt.end` (`var(--end)`) `hangup` 20/2.1 aria "Cancel call" → `cancelCall()`. Measured 271 × 60 |
| On a call, minimized | Sf | `in_call` live, voice, panel closed | same pill: avatar `.av` 48 (18px initial) with `0 0 0 3px color-mix(in oklab,var(--glow) 55%,transparent)`, `cc-talk 1.6s alternate`; `b` operator first name ("Sara"), `small` "2:14"; level bars `.wvs` (5 × 3px, 16 high, `var(--glow)`, `cc-eq .8s`); `.mbt` `mic` 18/2 aria "Mute" → `toggleMic()`; `.mbt.end` aria "End call" → `cancelCall()`. Measured 237 × 60. **The live prototype (LP minimized-call) differs:** full name "Sara Mohammadi", level bars, `expand` "Open the call" and End, no mute (§11) |
| Video call, minimized | Sg | `in_call` live, video, panel closed | `div.mvid[role=status][aria-label="Video call, minimized"]` 188 × 122, radius 18, `#0A0D10`; the **remote `<video>`** fills it (`.feed`, cover); rec dot `.rd` 8px `var(--end)` at `top:9px; inset-inline-start:9px` (blink); `.exp` 26 × 26 radius 8 `rgba(10,12,14,.4)` with `expand` 14/2.2 at `top:6px; inset-inline-end:6px` (a `span` on the board: make it a `button` "Open the call"); bottom bar `.bar3` (`inset-inline:8px; bottom:8px; gap:6px`): time 11.5/700 tnum, buttons 30 × 30 circle `rgba(10,12,14,.45)` blur 8: `mic` 15/2 "Mute", `.end` `hangup` 17/2.1 "End call" |
| Callback booked | Sh | after `ended` (a) and closing, until the booked time | `div.sched[role=status]` 56 high, radius 28, `padding-inline:6px 18px`, `#fff`, ink, shadow §3.4, `gap:10px`; icon `.si` 44 circle `#FFEAE4` / `#C2361C` with `cal` 20/1.9; `b` "Callback scheduled" 13.5/700/1.3; `small` "Tomorrow 4:30" 12/1.3 ink-3. Click behaviour not specified (suggestion: `toggleOpen()`) |

Measured round/label positions in the live page: `ln-c` 60 × 60 at `right:22px; bottom:22px`.

### 4.3 Placement (board 02) and opening

Production `config.widget_position` (`right` / `left`, map §1.7) extends to the board's placements (proposed values,
shared with the WebYar spec; `right` and `left` keep their meaning, bottom corners). The edge placement is not a position
value: `launcher_style: edge_tab` puts the tab on the vertical middle of the `right` or `left` edge (prototype `.st-t`).

| Value | Board | Caption (spec) | Launcher anchor (live prototype) | Panel anchor and transform-origin |
|---|---|---|---|---|
| `right` (default; bottom right) | P1 | "The panel opens upward" | `right:22px; bottom:22px` | `right:22px; bottom:22px`; `100% 100%` |
| `left` (bottom left) | P2 | "The panel opens upward" | `left:22px; bottom:22px` | `left:22px; bottom:22px`; `0 100%` |
| `top_right` | P3 | "Opens downward, under the site header" | `right:22px; top:20px` (below the 100px fake site header) | `right:22px; top:20px`; `100% 0` |
| `top_left` | P4 | "Opens downward, under the site header" | `left:22px; top:20px` | `left:22px; top:20px`; `0 0` |
| `right` + `edge_tab` (middle, right edge) | P5 | "The panel opens beside the tab" | `right:0; top:50%; margin-top:-80px` | `right:22px; top:50%; margin-top:-330px`; `100% 50%` |
| `left` + `edge_tab` (middle, left edge) | (CSS only) | — | `left:0; top:50%; margin-top:-80px` | `left:22px; …`; `0 50%` |
| `bottom_center` | P6 | "The panel opens above it, centered" | centred, bottom (board mock: `left:50%; bottom:10px; translateX(-50%)`) | above, centred — values not specified |
| phone corner | P7 | "Home slides up as a sheet" | §2.3 | sheet |
| phone bottom bar | P8 | "Two big buttons within thumb reach." | `launcher_style: mobile_bar` | sheet |

The production site header height is unknown to the widget: suggestion `top:20px` from the viewport (configurable).
`edge_tab` always takes the edge placement on the chosen side (prototype `.st-t`). For top placements the label of
`round_label` keeps radius `16px 6px 16px 16px` (top-right, base rule `cc.css:837`) and `20px 20px 20px 4px`
(top-left, `cc.css:836`).

### 4.4 Panel header

| Part | Class | Values | Production |
|---|---|---|---|
| Header | `header.hd` (+ `.hd.ln` adds `box-shadow:0 1px 0 var(--line)`, not used on the boards) | 74px, `padding-inline:18px 14px`, `gap:12px` | header `PD:202-215` |
| Logo tile | `span.lg[aria-hidden]` | 44 × 44, radius 14, bg `var(--a)`, `var(--on-a)`, 19/700, shadow `0 8px 16px -8px rgba(22,20,43,.6)`; stage: `#fff` / ink + `0 0 0 1px rgba(255,255,255,.16),0 8px 18px -8px rgba(0,0,0,.6)` | `config.avatar_url` → `img` filling the tile (suggestion `object-fit:cover`); else the board shows the first letter of the display name |
| Name | `.hx .nm` | 15/700/1.45, ellipsis | `config.display_name` or `support` |
| Status | `.hx .st` | 12.5/1.45 ink-3, `gap:7px`; `.dot` 8 × 8 `var(--live)` with `::after` ping (`cc-ping 2.4s`); offline `.dot.off` (transparent, `inset 0 0 0 2px var(--ink-4)`, no ping); stage text `rgba(255,255,255,.66)`, dot `var(--live-hi)` | `operators_available` / `callback_desk`, follows `isOnline()` |
| Language | `button.lang[aria-label="Widget language"]` | 32 high, `padding:0 10px`, radius 10, `var(--paper)`, 12/700 ink-2, `gap:5px`, `globe` 15/1.8 ink-3, text "EN" | only when `availableLocales.length > 1` (map §4.10). The menu it opens is not drawn (suggestion: keep a native `select` under the styled face) → `setLocale(code)` |
| Collapse | `button.ib[aria-label="Minimize"]` | 38 × 38, radius 12, transparent, ink-2, `chev-d` 20/2; hover `var(--paper)`; active `scale(.92)`; stage: bg `rgba(255,255,255,.08)`, `rgba(255,255,255,.92)`, `inset 0 0 0 1px rgba(255,255,255,.08)`, hover `.15` | `toggleOpen()`; label "Minimize" fixes A3.14 |

### 4.5 Home (01): badge, hero, call choices, callback row, feature row

| Part | Class | Values |
|---|---|---|
| Live badge | `span.badge` | 28 high, `padding-inline:10px 12px`, radius 999, `var(--paper)`, `inset 0 0 0 1px var(--line)`, 12/700 ink, `gap:8px`; `.dot` + "Live now" + `.sep` (3px dot, ink-4) + `.chn` "Voice · Video · Callback" (500, ink-3). Measured 233 × 28 |
| Title | `h2.hh` | "Talk to our team", 27/700/1.18/-.022em, `margin:14px 0 6px` |
| Copy | `p.hs` | 14/1.55 ink-3, `max-width:340px` |
| Choices | `div.opts` | grid 2 columns, `gap:12px`, `margin-top:24px`; each `button.opt` 176 × 178, `padding:16px`, radius `var(--r-card)`, column `justify-content:flex-end`, `gap:12px`, `text-align:start`; icon tile `.oi` 46 × 46 radius 15 (`margin-bottom:auto`); go disc `.go` 30 circle at `top:16px; inset-inline-end:16px` with `arrow-f` 16/2.2; title `b` 16/700/1.4; sub `small` 12/500/1.5. Hover `translateY(-3px)` (`.35s var(--ease)`), `.go` `translateX(3px)` (RTL `-3px`); active `scale(.97)` |
| Voice card | `.opt.voice` | bg `radial-gradient(120% 90% at 100% 0%,#3B3576 0%,transparent 60%),var(--a)`, text `#fff` (→ `--on-a`), shadow `0 18px 34px -16px rgba(22,20,43,.75)`; `.oi` `rgba(255,255,255,.18)` + `inset 0 0 0 1px rgba(255,255,255,.16)`; `.go` `rgba(255,255,255,.16)`; small `opacity:.84`; three rings `.rw` (180 × 180 circle at `inset-block-start:-60px; inset-inline-end:-60px; z-index:-1`, `1.5px solid rgba(255,90,60,.55)`, `cc-tile 3.6s var(--ease) infinite`, delays 0 / 1.2s / 2.4s). "Voice call" / "Uses your microphone" → `startCall('voice')` |
| Video card | `.opt.video` | `#fff`, ink, `inset 0 0 0 1px var(--line-2),0 1px 2px rgba(15,18,23,.04)`; hover `inset 0 0 0 1px var(--a-3),0 16px 30px -18px rgba(15,18,23,.35)`; `.oi` paper / ink; `.go` paper / ink-2; small ink-3. "Video call" / "Camera and microphone" → `startCall('video')` |
| Callback row | `button.cbr` | `margin-top:12px`, `padding:12px 14px`, radius `var(--r-card)`, `var(--paper)` (hover `var(--paper-2)`), `gap:12px`; tile `.it` 40 × 40 radius 13 `#fff`, `var(--a-ink)`, `0 0 0 1px var(--line)`, `phone-in` 20/1.8; `b` "Request a callback" 14.5/700; `small` "Tell us how to reach you and our team calls back fast." 12.5/1.55 ink-3; `chevron-forward` 18/2 ink-4 → `openCallback()` |
| Feature row | `ul.trust` | `margin-top:auto`, `padding:14px 4px 4px`, `border-top:1px solid var(--line)`, `justify-content:space-between`; items 12/600/1.4 ink-3, `gap:6px`, icons 16/1.8 ink: `shield` "Secure line", `users` "Queue aware", `bolt` "Fast handoff" |

### 4.6 Forms (02, 03, 17, 18)

| Part | Class | Values | Production |
|---|---|---|---|
| Context row | `div.ctx` | `padding:0 14px 8px`, `gap:8px`; back `button.ib[aria-label="Back"]` 36 × 36 `var(--paper)`, `back` 18/2 | Back → `reset()` (step 2: back to step 1) |
| Channel chip | `span.ct` | 30 high, `padding:0 12px`, radius 999, paper, `inset 0 0 0 1px var(--line)`, 12.5/700 ink, `gap:7px`, icon 15/2 | "Voice call" / "Video call" from `formData.call_type`; "Request a callback" in the callback form |
| Step counter | `span.stp` | `margin-inline-start:auto`, 12/600 ink-3, `gap:8px`; `.bars` `gap:4px`, bars 16 × 4 radius 2 `var(--line-2)`, `.on` `var(--a)` | callback only; renderer sub-state |
| Stack | `div.fm` | column, `gap:14px`, `padding-top:2px` | `form.ccw-stack` keeps the submit path |
| Label | `.lb` | 12.5/700/1.4 ink-2, `margin:0 2px 7px`, `gap:6px`; `.lb em` (end-aligned hint, 11.5/600 ink-3) not used | `label[for]` |
| Department chips | `div.chips[role=group][aria-label="Department"]` > `button.chip[aria-pressed]` | wrap, `gap:8px`; chip 36 high, `padding:0 14px`, radius 999, `#fff`, `inset 0 0 0 1px var(--line-2)`, 13/600/1 ink-2, `gap:6px`; hover `inset 0 0 0 1px var(--a-3)`; active `scale(.95)`; selected `.on`: bg `var(--ink)`, no ring, `#fff`, `check` 15/2.4; disabled `.chip.dis`: paper, ink-4, line-through 1px | replaces `select.ccw-input` department (`PD:615-627`) → `formData.department_id`; list from `bootstrap.departments[channel]`; render as a radio group |
| Field group | `div.grp` > `div.fr` × n | radius `var(--r-ctl)`, `#fff`, `inset 0 0 0 1px var(--line-2)`; row `min-height:52px`, `padding:6px 14px`; divider `.fr + .fr::before` (1px `var(--line)`, `inset-inline:14px 0`); `label` 11.5/600/1.4 ink-3 (required `i` "*" `var(--bad)`); `input.v` 14.5/500/1.5 ink, transparent, no border | `name`, `email` (`dir=ltr`, `.ltrv`), `phone` (`dir=ltr`) → `formData.*` |
| Focus | `.fr:focus-within`, `.inp:focus-within`, `.ta:focus`, `.fr.fo`, `.inp.fo` | `z-index:1; border-radius:var(--r-ctl); box-shadow:0 0 0 2px #FF5A3C,0 0 0 5px rgba(255,90,60,.12)`; `.fr.fo` hides its own and the next divider (`opacity:0`); suggestion: same for `:focus-within` | — |
| Single field | `div.inp` | `min-height:46px`, `padding:0 14px`, radius `var(--r-ctl)`, `#fff`, `inset 0 0 0 1px var(--line-2)`, 14.5px | subject, custom schema text fields |
| Field error (DS6) | inline style on `.inp` | `box-shadow: inset 0 0 0 1.5px color-mix(in oklab, var(--bad) 55%, #fff); background: color-mix(in oklab, var(--bad) 5%, #fff)` | production has one `controller.error` (suggestion: mark the field it names) |
| Textarea | `textarea.ta` | `min-height:58px` (renders 67 with 2 rows), `padding:11px 14px`, radius `var(--r-ctl)`, `#fff`, `inset 0 0 0 1px var(--line-2)`, 14/1.6, `resize:none` | message / custom `textarea` |
| Consent | `div.cons` | `gap:12px`, `padding:10px 14px`, radius `var(--r-ctl)`, paper; `lock` 18/1.8 ink-3; text 13/1.6 ink-2 (`id` for `aria-labelledby`) + tag `em` "Required" (`margin-inline-start:4px; padding:0 6px; radius 5px; #fff; inset 0 0 0 1px var(--line); 11px/700; line-height 18px; ink-3`) | recording `consent_required` → `formData.consent` |
| Switch | `button.sw[role=switch][aria-checked]` | 46 × 28, radius 14, `var(--line-2)` (`.2s`); knob 22 `#fff` at `top:3px; inset-inline-start:3px`, `0 2px 4px rgba(15,18,23,.22)`, `transform .32s var(--spring)`; on: `#FF5A3C`, knob `translateX(18px)` (RTL `-18px`) | checkbox `PD:723-730` |
| Consent error | `.cons.err` | bg `color-mix(in oklab,var(--bad) 6%,#fff)`, `inset 0 0 0 1.5px color-mix(in oklab,var(--bad) 50%,#fff)`; lock `var(--bad)`; switch ring `0 0 0 2px #fff,0 0 0 3.5px color-mix(in oklab,var(--bad) 60%,#fff)` and `cc-nudge .5s var(--ease) .6s` ×2 | when the error is `err_recording_required` / `err_recording_accept` |
| Error line | `p.msg.err[role=alert]` | `margin:-8px 2px 0`, 12.5/600/1.5 `var(--bad)`, `gap:7px`, `warn` 16/2 | `controller.error` (`PD:735`) |
| Note | `p.note` | `margin:-6px 2px 0`, 12/1.6 ink-3, `gap:6px`, `info` 14/2 | `contact_required_note` |
| Permission hint | `p.permit` | `gap:10px`, `padding:10px 12px`, radius `var(--r-ctl)`, paper, 12.5/1.55 ink-3; icons `video` + `mic` 16/1.8 ink-2, `gap:2px` | new (video); voice variant not drawn |
| Known contact | `div.known` | `gap:12px`, `padding:12px 14px`, radius `var(--r-card)`, paper, `inset 0 0 0 1px var(--line)`; `.av.s44` initial; `b` name 15/700; `small` 12.5 ink-3 with `check` 14/2.6 `var(--live)` "Contact details already saved"; `a.ed` "Edit" 12.5/700 `var(--a-ink)`, `padding:6px 10px`, radius 10, hover `#fff` | `identifiedContact` (`PD:628-638`); Edit is new |
| Actions | `div.acts` | `padding:12px 18px 0`, `gap:10px`; `.btn.gh` "Back" (69 wide) + `.btn.pri` flex 1 | Back `type=button` → `reset()`; primary `type=submit` |
| Honeypot, time trap, custom schema types | not drawn | keep exactly (brief §2.6) | map §6.6 |

### 4.7 Buttons (DS5)

| Variant | Class | Values |
|---|---|---|
| Base | `.btn` | 50 high, `padding:0 18px`, radius `var(--r-ctl)`, 15/700/1, `gap:8px`, nowrap; `transition: transform .2s var(--ease), box-shadow .2s ease, background-color .18s ease`; active `scale(.97)` |
| Primary | `.btn.pri` | flex 1; `var(--a)` / `var(--on-a)`; `0 10px 22px -12px rgba(22,20,43,.7)` |
| Secondary | `.btn.sec` | `#fff`, ink, `inset 0 0 0 1px var(--line-2)` |
| Ghost | `.btn.gh` | paper, ink-2; hover `var(--paper-2)` |
| Danger | `.btn.dg` | `var(--end)`, `#fff`, `0 10px 22px -12px color-mix(in oklab,var(--end) 85%,transparent)` |
| Small | `.btn.sm` | 40 high, `padding:0 14px`, 13.5px, radius `calc(var(--r-ctl) - 2px)` |
| Full | `.btn.full` | `width:100%; flex:none` |
| Stage white | `.btn.wh` | `#fff`, ink |
| Stage glass | `.btn.gl` | `rgba(255,255,255,.12)`, `#fff`, `inset 0 0 0 1px rgba(255,255,255,.1)` |
| Disabled | not drawn | production disables Submit rating at 0 stars (suggestion: keep the `disabled` attribute with reduced opacity) |
| Density `compact` | not drawn | brief §5.6: keep production's rule (body padding 10px, button min-height 34px) on the new classes |

### 4.8 Call stage parts

| Part | Class | Values |
|---|---|---|
| Status pill | `span.pill[role=status]` | 30 high, `padding:0 12px`, radius 999, `rgba(255,255,255,.08)`, `inset 0 0 0 1px rgba(255,255,255,.1)`, 12.5/600/1 `rgba(255,255,255,.94)`, `gap:8px`, `backdrop-filter:blur(12px)`. Leads: `.eq` (4 bars 2.5 × 12px `var(--glow)`, `cc-eq .9s ease-in-out infinite alternate`, delays 0, -.3s, -.6s, -.15s), `.gd` (8px `var(--live-hi)` + `0 0 0 3px color-mix(…25%…)`). `.pill.rec`: `color-mix(in oklab,var(--end) 18%,transparent)`, `inset 0 0 0 1px color-mix(…end 46%…)`, `#FFD0D2`, dot `.rd` 8px `var(--end)` `cc-blink 1.4s`. `.pill.warn`: `rgba(232,163,23,.16)`, `inset … rgba(232,163,23,.42)`, `#FFDC9A`, spinner `.spn` 13px (2px `rgba(255,220,154,.3)`, top `#FFDC9A`, `cc-spin .9s linear`) |
| Orb | `div.orb[aria-hidden]` | 204 × 204, `margin:12px 0 4px`; core `.core` at `inset:38px` (128) circle, `var(--core)` / `var(--core-ink)`, shadow §3.4, icon 46. Modifiers: `.ringing` (core icon `cc-wiggle 2.4s`), `.rg` × 3 rings (1.5px `color-mix(in oklab,var(--glow) 80%,transparent)`, `cc-ring 2.4s var(--ease) infinite`, delays 0 / .8s / 1.6s), `.fast` (rings 1.6s, delays 0 / .53s / 1.06s; wiggle 1.6s), `.spin` (`::after` `inset:-9px`, 2.5px, top `var(--glow)`, inline-end `color-mix(…glow 40%…)`, `cc-spin 1.1s linear`), `.op` (core `#FCE3D4` / `#8A3410`, 48/700 initial), `.halo` × 2 (`radial-gradient(closest-side,color-mix(in oklab,var(--glow) 62%,transparent) 55%,transparent)`, `cc-halo 1.8s ease-in-out infinite alternate`; second 2.3s, delay -.8s, `opacity:.7`), `.breathe` (`cc-breathe 2.6s`), `.dim` (core `filter:saturate(.35) brightness(.78)`), `.dash` (`inset:28px`, 1.5px dashed `rgba(255,220,154,.55)`, `cc-spin 9s linear`), `.sm` 170 × 170 (`margin-top:6px`, layers `inset:30px`, icon 40), `.xs` 120 (board 12) |
| Titles | `h2.sh`, `p.sp` | §3.2; `.sh margin:4px 0`; `.sp max-width:318px`, `rgba(255,255,255,.68)`; `.sp.ctxl` inline-flex `gap:7px` |
| Loading dots | `span.ldots` | 3 × 4px dots, `gap:3px`, `margin-inline-start:2px`, `cc-wave 1.2s` delays 0 / .15s / .3s |
| Queue timer | `div.tmr[role=timer]` | `gap:10px`, `margin-top:14px`; `.tl` 12.5px `rgba(255,255,255,.6)` "Waiting time"; `b` 30/700 tnum; optional `.sbt` 34 × 34 circle `rgba(255,255,255,.1)` + inset .1 (sound toggle, screen 06) |
| Queue card | `div.qc` | `width:100%`, `margin-top:16px`, `padding:14px 16px 12px`, radius `var(--r-card)`, `rgba(255,255,255,.06)`, `inset 0 0 0 1px rgba(255,255,255,.09)`, `text-align:start` |
| Queue line | `div.ql` (static) / `div.ql2` (animated) | 32 high; dotted rule `::before` (`inset-inline:20px 26px`, 2px dotted `rgba(255,255,255,.28)`); operator `.op` 32 circle `color-mix(in oklab,var(--glow) 26%,var(--s2))` + ring `0 0 0 4px color-mix(in oklab,var(--s2) 70%,#000)`, `headset` 17/1.8; people `.pp` 12px `rgba(255,255,255,.42)` + same ring; "You" `.me` 24 high, `padding:0 10px`, `#fff`, ink, 11.5/800, ring + `0 0 18px 2px color-mix(…glow 45%…)`, `cc-me 2.4s`. `.ql2` positions: position 3 → dots at `calc(36% - 6px)` and `calc(68% - 6px)`, "You" at `calc(100% - 46px)`; position 2 → second dot hidden, "You" at `calc(68% - 22px)`; position 1 → both dots hidden, "You" at `46px` |
| Queue stats | `div.qs` | 2 columns, `gap:10px`, `margin-top:12px`, `padding-top:12px`, top border `rgba(255,255,255,.08)`; `small` 11.5/1.5 `rgba(255,255,255,.56)`; `b` 15/700 tnum. "Queue position" / "ETA" |
| Offer card | `div.offer` | `gap:10px`, `margin-top:14px`, `padding:14px`, radius `var(--r-card)`, `rgba(255,255,255,.1)`, `inset … .14`, `cc-rise .6s var(--spring) .5s backwards`; `p` 13.5/600/1.65 `#fff`, `gap:10px`, `phone-in` 18/1.9 `var(--glow)`; button `.btn` 44 high `#fff` ink 14px |
| Tap hint | `span.hint` | `height:28px; padding:0 10px; margin-top:10px; gap:7px; radius 999; rgba(255,255,255,.08); 12/600 rgba(255,255,255,.85); cc-hint 2s` — not placed on any board (suggestion: below `.tmr`) |
| Skeleton | `i.gsk` | 10px bars, radius 6, `linear-gradient(90deg,rgba(255,255,255,.07),rgba(255,255,255,.16),rgba(255,255,255,.07))` 200% wide, `cc-shim 1.4s linear` |
| Operator block | `div.who-c` | `.nm` (§3.2), `.rl` "Operator" 13/1.5 `rgba(255,255,255,.6)`; timer chip `.ctm` 32 high, `padding:0 13px`, `margin-top:12px`, radius 999, `rgba(255,255,255,.08)` + inset .08, 14.5/700 tnum, `gap:8px`, live dot `.gd` 8px `var(--live-hi)`, signal `.net` `rgba(255,255,255,.8)`; `.ctm.mut` `rgba(255,255,255,.55)` |
| Recording note | `p.rnote` | `margin-top:auto`, `padding:10px 12px`, radius `var(--r-ctl)`, `rgba(255,255,255,.06)`, 12/1.6 `rgba(255,255,255,.7)`, `gap:8px`, `info` 16/1.8 `rgba(255,255,255,.55)` |
| Notice banner | `div.bnr[role=status]` | full width, `margin-top:2px`, `padding:11px 14px`, radius `var(--r-ctl)`, `rgba(232,163,23,.14)`, `inset 0 0 0 1px rgba(232,163,23,.36)`, 13/600/1.5 `#FFDC9A`, `gap:10px`; spinner `.spn` 16px |
| Sound toggle | `button.gbtn.snd` | 54 × 54 circle, `rgba(255,255,255,.12)`, `#fff`, inset .1; `vol` 22/1.9 (`.i-on`) / `vol-x` (`.i-off`, shown with class `.on`); `aria-label` "Mute sound" / "Unmute sound" |
| Cancel | `button.xbtn` | 54 high, `padding:0 26px`, radius 27, `var(--end)`, `#fff`, 15/700, `gap:9px`, shadow §3.4, `hangup` 22/2.1; active `scale(.96)` |
| Call control | `button.cbn` > `span.bt` + label | width 64, column `gap:7px`, label 11.5/600/1.3 `rgba(255,255,255,.74)`; `.bt` 58 × 58 circle `rgba(255,255,255,.12)`, inset .1, blur 14 (`.2s`), hover `.2`, active `scale(.92)`; toggled `.cbn.on .bt` `#fff` / `var(--s3)` with the `-off` icon and the "Unmute" label (`.i-on` / `.i-off` swap); `.cbn.end .bt` 66 × 66, `margin-top:-4px`, `var(--end)` (hover `color-mix(in oklab,var(--end) 88%,#fff)`) |
| Dock | `div.dock` | `gap:24px`, `padding:14px 20px 2px`, `align-items:flex-start`; `.dock.q` `gap:14px`, centred |

### 4.9 Video parts (09, 23)

| Part | Class | Values | Production |
|---|---|---|---|
| Feed | `div.feed` | `position:absolute; inset:0; z-index:-2; overflow:hidden`; scrim `::after` §3.1 | the remote `<video>` from `controller._attachedTracks` (same instance, `object-fit:cover`, **not mirrored**, brief §11), plus the remote `<audio>` |
| Top bar | `div.vtop[role=status]` | `top:82px` (mobile 104), centred `translateX(-50%)`, 34 high, `padding:0 14px`, radius 999, `rgba(10,12,14,.38)`, `inset 0 0 0 1px rgba(255,255,255,.12)`, blur 14, 13/700, `gap:8px`; rec dot 8px `var(--end)` blink; separators 1 × 14 `rgba(255,255,255,.22)`; "Rec" · name · time (`.num` 600, `rgba(255,255,255,.85)`) | recording from `call.recording_state`; name `operatorName`; time from `callStartedAt` |
| Self-view | `div.pip[aria-label="You"]` | `bottom:136px; inset-inline-end:16px`, 98 × 136 (mobile `bottom:150px`, 108 × 150), radius 18, `overflow:hidden`, shadow §3.4, `cc-pip .6s var(--spring) .5s backwards`; tag `.me-l` "You" (20 high, `padding:0 7px`, `rgba(10,12,14,.45)`, 10.5/700, at `bottom:7px; inset-inline-start:7px`) | `controller._localVideoEl` (mirrored `scaleX(-1)`), only when `camOn` |
| Dock | `div.vdock` | `bottom:50px` (mobile 74), centred, `gap:12px`, `padding:10px`, radius 999, `rgba(10,12,14,.42)`, inset .12, blur 18; `.bt` 52 × 52 circle `rgba(255,255,255,.14)` (hover .24); `.bt.end` 64 × 52 radius 26 `var(--end)`. Order: Mute, Camera off, End call, Minimize | `toggleMic()`, `toggleCam()`, `cancelCall()`, `toggleOpen()`; toggled state not drawn (suggestion: `.cbn.on` colours) |
| Footer | `.vid .pw` | absolute `bottom:4px`, `rgba(255,255,255,.62)` | footer variants |

### 4.10 Transfer, reconnect, microphone blocked

| Part | Class | Values |
|---|---|---|
| Transfer graphic | `div.xf[aria-hidden]` | `gap:14px`, `margin:30px 0 20px`; from `.av` 78 (28px) + `0 0 0 6px rgba(255,255,255,.05)`; arrows `.ar` 3 × `chevron-forward` 22/2 `var(--glow)` (`margin-inline-start:-8px`, `opacity:.25`, `cc-flow 1.2s` delays 0 / .2s / .4s); to `.to` 78 circle `rgba(255,255,255,.06)` `headset` 30/1.7, dashed ring `::before` (`inset:-1px`, 1.5px dashed `color-mix(…glow 70%…)`, `cc-spin 8s`), pulse `::after` (`inset:-12px`, `cc-ring 2.4s`) |
| Reconnect | `.bnr` + `.orb.op.dim` + `.dash` + `.ctm.mut` with `wifi-off` 15/2 | §4.8 |
| Mic blocked | `div.sb.dn` | icon `.ei` 80 circle, `margin-top:22px`, `color-mix(in oklab,var(--end) 18%,transparent)`, `inset … 42%`, `#FFA5A8`, `mic-off` 34/1.8; title `margin-top:16px`; illustration `.addr` (aria-hidden): `margin-top:18px`, `padding:10px`, radius `var(--r-card)`, `rgba(255,255,255,.06)`, inset .09; bar `.bar` 36 high radius 11 `rgba(255,255,255,.08)` `direction:ltr` 12.5px with lock `.lk2` 24 × 24 radius 7 (focus ring `::after` `inset:-4px` 2px `var(--glow)` `cc-focus 1.6s`), host name, `.dots`; popover `.pop` 236 wide, `margin-top:8px`, `padding:9px 10px 9px 12px`, radius 13, `#fff`, ink, `0 12px 24px -10px rgba(0,0,0,.55)`, 13/600, `mic` 17/1.9 + "Microphone" + `.sw.on`; instruction `.how` 12.5/1.7 `rgba(255,255,255,.66)`, `margin-top:12px`; actions `.row2` (`margin-top:auto`, `gap:10px`, buttons flex 1): `.btn.gl` "End call", `.btn.wh` `retry` 18/2 "Try again"; 14px spacer |

### 4.11 Rating, thanks, error

| Part | Class | Values |
|---|---|---|
| Call summary | `div.sumc` | `gap:14px`, `padding:14px`, radius `var(--r-card)`, paper; avatar `.av.s52` with badge `.ck` (22 circle at `bottom:-3px; inset-inline-end:-3px`, `var(--ink)`, `#fff`, ring `0 0 0 2.5px var(--paper)`, `check` 12/3); `b` 15/700/1.45; `small` 12.5/1.55 ink-3 |
| Rating block | `div.rate` | `margin-top:26px`, centred; `h3` §3.2; `p` 13/1.6 ink-3, `margin-top:2px` |
| Stars | `div.stars[role=group][aria-label="Rating"]` > `button.star` × 5 | `gap:4px`, `margin:18px 0 20px`; star 50 × 50 radius 14 transparent, `var(--line-2)`, `star` 36/1.6; `.on` `var(--star)` + `fill:currentColor`; hover `scale(1.12)` (`.3s var(--bounce)`); `aria-label` 1–5, `aria-pressed` on the chosen star |
| Mini stars | `span.mini-stars[aria-label="4/5"]` | `gap:2px`, `var(--star)` filled; empty `svg.o` `fill:none`, `var(--line-2)`; 18px (16 on board 12) |
| Success mark | `span.okc` | 100 circle `#FFF1ED`; ring `::before` `0 0 0 1.5px #FFC2B4` `cc-bloom 2.6s var(--ease) .7s infinite`; core `.in` 70 circle `var(--a)` / `#fff` (→ `--on-a`), `0 14px 28px -12px color-mix(…a 85%…),inset 0 1px 0 rgba(255,255,255,.25)`, `cc-pop .6s var(--bounce) .15s backwards`; check path `stroke-dasharray:24`, `cc-draw .5s var(--ease) .5s backwards`; badge `.bdg` 32 circle at `bottom:2px; inset-inline-end:0`, `#fff`, `#FF5A3C`, `0 0 0 1px var(--line),0 6px 12px -6px rgba(15,18,23,.3)`, `cc-pop .5s var(--bounce) .7s backwards` |
| Error mark | `span.ei` | 76 × 76 radius 26, `color-mix(in oklab,var(--bad) 9%,#fff)`, `var(--bad)`, `inset 0 0 0 1px color-mix(…bad 16%…)`, `warn` 34/1.8 |
| Centred block | `div.ctr` | column, centred, `margin:auto 0`, `padding:0 8px`; `h3 margin:18px 0 6px`; `p max-width:300px`, ink-3; actions `.vstack` (`gap:10px`, `margin-top:22px`, full width) |

### 4.12 Callback flow (16–19)

| Part | Class | Values |
|---|---|---|
| Offline mark | `span.oi2` | 84 × 84 radius 28, paper, ink, `inset 0 0 0 1px var(--line)`, `phone-in` 34/1.7; moon `.moon` 32 circle at `top:-8px; inset-inline-end:-8px`, `#fff`, ink-3, `0 0 0 1px var(--line),0 6px 12px -6px rgba(15,18,23,.25)`, `moon` 16/1.9 |
| Inline note | `p.inl` | `margin-top:14px`, `max-width:300px`, centred; computed 13.5/1.55 ink-3 (`.ctr p` wins over `.inl{font-size:12.5px;line-height:1.6}`); `clock` 15/1.9 ink-4, `margin-inline-end:6px` |
| Segmented control | `div.seg` > `button[aria-pressed]` × 2 | `padding:4px`, `gap:4px`, radius `calc(var(--r-ctl) + 2px)`, paper; buttons flex 1, 40 high, radius `calc(var(--r-ctl) - 2px)`, 13.5/700 ink-3, `gap:7px` (`.2s`); `.on` `#fff`, ink, shadow §3.4, icon `#FF5A3C`; urgent `.on.urg` `var(--warn-bg)`, `var(--warn-ink)`, `inset 0 0 0 1.5px #F2C14E`, icon `#D98E04` |
| Day chips | `div.days` | `gap:8px`, `margin-top:10px`; `.chip` flex 1, `padding:0 8px` (85 wide) |
| Time slots | `div.slots` | `gap:8px`, `margin:8px -18px 0`, `padding:2px 18px`, `overflow:hidden`, mask fade 44px at the inline end (`[dir=ltr]` `--fade-to:right`); chips 38 high, radius 12, tnum, `flex:none`; selected `.on` `var(--ink)` (text: see §3.1); past/unavailable `.chip.dis` |
| Summary chip | `div.sumchip` | `gap:10px`, `padding:10px 12px`, radius `var(--r-ctl)`, paper; tile `.it` 32 radius 10 `#fff` `var(--a-ink)` `0 0 0 1px var(--line)`; text 13/600/1.5; link `a` "Change" 12.5/700 `var(--a-ink)` |
| Key / value card | `div.kv` > `.r` × n | `margin-top:22px`, `padding:2px 14px`, radius `var(--r-card)`, paper, `text-align:start`; rows `min-height:46px`, 13.5px, `justify-content:space-between`, separators `1px solid var(--line)`; `.k` ink-3; `.v` 700, `gap:8px` |
| Urgent tag | `span.tagu` | 24 high, `padding:0 8px`, radius 999, `var(--warn-bg)`, 12/700 `var(--warn-ink)`, `gap:4px`, `bolt` 13/2.2 `#D98E04` |
| Code + copy | `span.code` + `button.cpy[aria-label="Copy code"]` | code §3.2; copy 28 × 28 radius 8 `#fff` ink-3 `0 0 0 1px var(--line)`, `copy` 15/1.9 |

### 4.13 Powered-by footer

`a.pw`: 40 high, centred, `gap:6px`, 11.5px ink-3, no underline. Content: "Powered by" + lockup SVG `svg.lk` (Thread
`g-t` 53 × 13, `viewBox="0 -42 804.8 184"`; Open `g-o` 50 × 13, `viewBox="0 -49.9 812.2 199.8"`; wordmark
`currentColor` = ink, symbol accent `#FF5A3C`; files [`respok-lockup-thread.svg`](../../shared/brand/respok/respok-lockup-thread.svg),
[`respok-lockup-open.svg`](../../shared/brand/respok/respok-lockup-open.svg)), shown by `logoDirection` (`lg-thread` default).
Stage: text `rgba(255,255,255,.5)`, lockup `#fff`; `.pw b` / `.pw .wm` (`rgba(255,255,255,.78)` on stage; light 700
ink-2) style a bold brand-name text variant. Production variants (map §4.11): International + Respok brand → the inline
lockup inside `a.ccw-powered` with `target=_blank rel="noopener noreferrer"`; another brand / logo URL → "Powered by" +
`.ccw-powered-logo` or bold `b` brand text; no brand → empty footer (suggestion: keep the 40px row so the layout matches);
`custom_texts.powered_by` → that text only.

### 4.14 Avatars

`.av` 36 circle 13/700 (`.s28` 11px, `.s30` 12px, `.s44` 16px, `.s52` 19px); palette `.c1{#FCE3D4 / #8A3410}`
`.c2{#DCE6FB / #1C4A92}` `.c3{#D2EEDF / #145E39}` `.c4{#EBE1FA / #57309A}`; stacks `.avs` overlap -9px with a 2.5px
white ring. The operator (orb, summary, minimised call, transfer) is always `.c1` on the boards; production has only
`operatorName` (suggestion: initial of the name; palette pick not specified).

---

## 5. Screens

Every screen keeps the frame of §2 and the footer of §4.13. "Update in place" lists what changes on a running screen;
everything else is built once per state (brief §2.5).

### 5.1 Screen 01 — Home, operators online

- **Production:** `online_available` (`PD:305-322`), mobile 21. Shown when `isOnline()`.
- **Layout (measured):** header 0–74 (with `.lang` at x=280); badge y=76; title y=118 (32 high); copy y=156 (43); cards
  y=223 (176 × 178 each); callback row y=413 (364 × 84); feature row y=584 (36); footer y=620.
- **Copy:** "Nilufar Store Support" (demo `display_name`), "Operators available", "EN", "Live now",
  "Voice · Video · Callback", "Talk to our team", "Start a secure voice or video call with the next available operator.",
  "Voice call" / "Uses your microphone", "Video call" / "Camera and microphone", "Request a callback" / "Tell us how to
  reach you and our team calls back fast.", "Secure line", "Queue aware", "Fast handoff", "Powered by".
- **Controls:** voice card → `startCall('voice')`; video card → `startCall('video')` (both synchronous in the click);
  callback row → `openCallback()`; collapse → `toggleOpen()`; language → `setLocale()`.
- **Data:** `caps.voice` / `caps.video` decide the cards (single-card layout not drawn; suggestion: one full-width
  card); `caps.callback && callback_policy.show_when_online !== false` decide the callback row; the channel list in the
  badge should list only available channels (suggestion).
- **New:** badge, feature row (keys exist, unused today), callback card subtitle, `.lang` face.

### 5.2 Screen 02 — Pre-call form, with an error

- **Production:** `pre_call_form` with `controller.error = err_recording_accept` (`PD:597-741`, `forCall`).
- **Layout:** header; `.ctx` y=74 (back + "Voice call"); body y=118: "Department" + chips (y=147, 36 high: Sales
  80 wide selected, Tech support 106, Billing 64); field group y=197 (3 × 52: Full name, Email, Phone); "Subject" label
  y=367 + `.inp` y=391 (46); consent `.cons.err` y=451 (62, switch at x=322); error line y=519; actions y=558 (Back 69
  + Start call 285); footer.
- **Copy:** "Department", "Sales", "Tech support", "Billing" (demo department names), "Full name", "Email", "Phone",
  "Subject", "I consent to this call being recorded for quality and security." + "Required", "Please accept the
  recording consent to start the call.", "Back", "Start call" (`phone` 18/2; video calls use `video`).
- **Data:** chips from `bootstrap.departments.voice|video`; `formData.name/email/phone/subject`, `formData.custom`;
  `recording.effective_enabled && consent_required` → consent row; `!consent_required` → `call_may_record` (not drawn;
  suggestion: `.note` with `info`); `controller.error` → error line, and `.cons.err` when the error is a consent error.
- **Controls:** chips → `formData.department_id` (no re-render needed); switch → `formData.consent`; Back / context back
  → `reset()`; Start call `type=submit` → `submitCall()` synchronously.
- **New:** chips instead of `select`, grouped fields, switch, error styling. Keep the custom schema field types
  (`textarea` → `.ta`, `select` → not drawn, suggestion `.inp` with a native select, `checkbox` → `.sw`).

### 5.3 Screen 03 — Returning visitor

- **Production:** `pre_call_form` with `identifiedContact` (name/email/phone removed from the field list).
- **Layout:** `.ctx` "Video call"; known card y=122 (68); "Subject" y=204 with focused `.inp.fo` y=229; consent (on)
  y=289; `.permit` y=364 (59); actions.
- **Copy:** "Ali Rezaei" (demo), "Contact details already saved", "Edit", "Subject", "Returning shoes, size 42" (demo
  value), consent text + "Required", "Your browser will ask to use the camera and microphone.", "Back", "Start call"
  (`video` 18/2).
- **New:** "Edit" (suggestion: `ui.editingContact` reveals the name/email/phone group of screen 02 prefilled); the permission hint.

### 5.4 Screen 04 — Connecting

- **Production:** `loading` while `POST calls/request` is in flight (production text "Loading…").
- **Layout:** stage; orb `.orb.spin` at y=86 (core 128 at y=124); title "Connecting" + dots y=298; context
  "Voice call · Sales" with `mic` 15/1.9 y=331; skeleton card `.qc` (`margin-top:22px`) y=373 (56) with two `.gsk` bars
  (46% and 78%, second `margin-top:10px`); queue dock (sound toggle + "Cancel call").
- **Data:** channel from `formData.call_type`, department name from `bootstrap.departments` by `department_id` (omit
  " · …" when none).
- **Controls:** sound toggle → `audio.setMuted` / `startFromGesture` (brief §2.7); Cancel call: no call id exists yet
  during `loading`; not specified (suggestion: disable until the request resolves, then `cancelCall()`).
- **Also use** this composition for the `in_call` connecting statuses (§1.2) with the status message as the title.

### 5.5 Screen 05 — In line, third

- **Production:** `queue_waiting`, `queuePosition > 1` (`PD:330-394`).
- **Layout:** pill y=74 ("Ringing an operator", `.eq`); orb `.ringing.sm` y=110 (170); "Holding your place" y=288;
  copy y=321 (2 lines); timer row y=375 ("Waiting time" + 0:47); queue card y=421 (123: line 32, stats 53); queue dock
  y=550.
- **Data and in-place updates:** timer `m:ss` since `queueStartedAt` (text only, every second); position → `.ql2` class
  and "Queue position" value (`queuePosition`; position 1 → "Next"); ETA `queueEta`: `mins = max(1, round(eta/60))`,
  ≤ 1 → "Under 1 minute", else "~{n} minutes"; `show_position === false` → hide the line and the position cell,
  `show_eta === false` → hide the ETA cell (suggestion); positions above 3 keep two dots (suggestion). The rings must
  keep running across updates.
- **Controls:** sound toggle; Cancel call → `cancelCall()` (add `.catch`, brief §11); header collapse → `toggleOpen()`
  (minimises into Se).
- **Copy:** "Ringing an operator", "Holding your place", "Your request is in the live call queue. Keep this window open
  while we connect the operator.", "Waiting time", "You", "Queue position", "ETA", "~3 minutes", "Cancel call".

### 5.6 Screen 06 — Next, with a callback offer

- **Production:** `queue_waiting`, position 1, `caps.callback && offer_callback_after_seconds > 0 && elapsed >= threshold`.
- **Layout:** pill; orb `.ringing.sm.fast`; "You are next" y=288; "We are ringing the next available operator now."
  (1 line); timer row y=355 with `.sbt` sound toggle; offer card y=403 (104): text line + "Request callback" (44 high);
  queue dock (second sound toggle).
- **Before the offer threshold** at position 1: queue card with "Next" / "Under 1 minute" (live prototype `q1`).
- **Controls:** offer button → `cancelCall()` then `openCallback()` **after** it resolves (fixes A3.3); sound toggles.
- **Design issue:** two sound toggles on one screen (`.sbt` and the dock `gbtn`); suggestion: keep the dock toggle only.

### 5.7 Screen 07 — Operator joining

- **Production:** `in_call`, `connectStatus === 'waiting_for_operator'` (pill key `connected_waiting`, message
  `operator_joining`; mic row shown).
- **Layout:** pill `.gd` "Connected, waiting" y=74; orb `.op.breathe` y=116 (core "S"); name y=324, "Operator", timer chip
  `.ctm.mut` "Operator joining" + dots y=384; recording note `.rnote` y=481; call dock y=520 (Mute, End, Minimize).
- **Data:** `operatorName` (unknown → name line hidden and "Operator" only; core content not specified, suggestion
  `headset` icon); `recording.effective_enabled && recording_state !== 'recording'` → `.rnote`.
- **Controls:** Mute → `toggleMic()`; End → `cancelCall()`; Minimize → `toggleOpen()`.

### 5.8 Screen 08 — Voice call

- **Production:** `in_call`, `connectStatus ∈ {in_call, operator_connected}`, voice.
- **Layout:** `.pill.rec` "Recording in progress" (when `call.recording_state === 'recording'`; otherwise suggestion:
  `.pill` + `.gd` "In call"); orb `.op.halo`; name, "Operator", timer chip with `.gd`, `m:ss`, `.net` signal
  (`title="Good connection"`); dock.
- **Media:** mount the remote `<audio>` (hidden) — production leaves it detached today (map §6.1). Optional live level:
  `controller._waveBars` (no level bars are drawn in the voice panel; the minimised pill has `.wvs`).
- **In-place updates:** timer text; pill swap on recording change; mute button class `.on` + label.
- **Controls:** Mute ↔ Unmute (`.cbn.on`, `mic-off`, "Unmute") → `toggleMic()`; End; Minimize. Ringback must be
  stopped here (brief §11, A3.6).

### 5.9 Screen 09 — Video call

- **Production:** `in_call` live, `isVideoCall`, not transferring (`hideHero` path).
- **Layout:** §4.9 — header over the video; top bar at y=82 (232 × 34); self-view 98 × 136 at x=286, y=388; dock
  276 × 72 at x=62, y=538 (buttons at y=548); footer y=616.
- **Media:** remote video fills `.feed`; local video in `.pip` while `camOn`; append the same element instances once and
  keep them in the document (brief §2.4). Controls are always visible over the video (fixes "controls below the fold").
- **Controls:** Mute → `toggleMic()`; Camera off → `toggleCam()` (label/state "Camera on" when off, icon `video-off`);
  End call → `cancelCall()`; Minimize → `toggleOpen()` (moves the feed into Sg).
- **Not drawn:** operator camera off / `operator_video_visible === false` (suggestion: show the 08 composition).

### 5.10 Screen 10 — Transferring

- **Production:** `in_call` with `transferring === true`.
- **Layout:** pill `.gd` "In call"; transfer graphic y=134 (78 high); "Transferring to another operator…" y=236; "Please
  stay on the line." y=269; timer chip `.gd` "3:05" y=301; dock.
- **Data:** the board shows the call time continuing; production clears `callStartedAt` on transfer (timer restarts) —
  keep the engine behaviour or keep the start time (engine change, owner's decision).

### 5.11 Screen 11 — Reconnecting

- **Production:** `in_call`, `media_reconnecting` (mic row shown).
- **Layout:** banner `.bnr` "Reconnecting media…" y=76 (356 × 42); orb `.op.dim` + `.dash` y=130; name, "Operator",
  `.ctm.mut` with `wifi-off` + frozen time "2:48"; dock.

### 5.12 Screen 12 — Microphone blocked

- **Production:** `in_call`, `microphone_permission_denied` (message `mic_denied`, split into title and body).
- **Layout:** `.ei` y=96; "Microphone permission denied" y=192; "Please allow access and try again." y=225;
  illustration y=263 (356 × 110; host name from `location.hostname`, board "nilufar.store"); instruction y=385; buttons
  y=556 (173 + 173).
- **Controls:** End call → `cancelCall()`; Try again → new engine call (suggestion `retryMicrophone()`: re-request the
  microphone and re-publish); if unavailable, hide the button (brief §9).

### 5.13 Screen 13 — Rating the call

- **Production:** `ended` (b) `endedCallId && !ratingSubmitted` (`PD:512-565`).
- **Layout:** summary card y=76 (80): avatar 52 + "Call ended." + "Sara Mohammadi · Duration 4:14"; rating block y=182:
  "How was your call?", "Your feedback helps our team improve.", stars y=250 (5 × 50); comment `.ta` y=320 (67);
  actions (Skip 66 + Submit rating 288).
- **Data:** `operatorName`, `endedDuration` (`m:ss`; "Duration" without the production ": "); `ratingValue`,
  `ratingComment`.
- **Controls:** star n → `ratingValue = n`, update only the stars and the submit `disabled` (keep textarea focus,
  `PD:536-544`); Skip → `skipRating()` (add, brief §11); Submit rating → `submitRating()`.

### 5.14 Screen 14 — Thank you

- **Production:** `ended` (c) `ratingSubmitted`.
- **Layout:** centred block y=184: success mark 100; "Thank you for your feedback!" y=302; "Duration 4:14" y=335; summary
  card y=378 (348 × 72): avatar 44, "Sara Mohammadi" / "Operator", mini stars `ratingValue`/5 at the end; Done (full).
- **Controls:** Done → `reset()`. Known render quirk: the summary text inherits `text-align:center` from `.ctr`
  ("Operator" centres under the name in the PNG); match the PNG or set `text-align:start` (owner's decision).

### 5.15 Screen 15 — Error

- **Production:** `error` (`PD:575-579`).
- **Layout:** centred block y=190: `.ei` 76; title y=284; body y=318 (2 lines); buttons y=382 (Request callback, Back,
  each 348 × 50); 14px spacer; footer.
- **Copy:** title = `controller.error` without the "Error: " prefix (board shows the server message "No operator is
  available right now"; `unknown` when empty); body "Leave a callback request and our team will call you as soon as
  possible." (new); "Request callback" (`phone-in`) shown when `caps.callback` → `openCallback()`; "Back" → `reset()`.

### 5.16 Screen 16 — Team offline

- **Production:** `offline` (`PD:292-303`).
- **Layout:** header with `.dot.off` "Callback desk"; centred block y=199: `.oi2` 84 + moon; "Leave a callback request"
  y=301; "Our team is offline right now, but we can call you back." y=334; "Request callback" y=398; note "Our team will
  reach out as soon as possible." y=462.
- **Controls:** Request callback → `openCallback()` (only `offline_behavior === 'show_callback' && caps.callback`).

### 5.17 Screen 17 — Callback, step 1

- **Production:** `callback_form` (`renderForm(cfg, false)`), renderer sub-state `ui.callbackStep = 1`.
- **Layout:** `.ctx` "Request a callback" + "Step 1 of 2" (bars on / off); "Callback type" + seg y=147 (Phone | Video);
  "When should we call?" + seg y=233 (As soon as possible | Schedule); days y=291 (Today, Tomorrow, Sat, Sun);
  slots y=337 (10:00 AM disabled, 12:30 PM, 4:30 PM selected, 6:00 PM, 7:30 PM — fading out at the end);
  "Priority" + seg y=416 (Normal | Urgent); actions: Back + "Continue" (`arrow-f` after the text).
- **Data:** `formData.callback_channel` (`audio` / `video`; Video only with `caps.video`), `callback_when`
  (`now` / `later`), `callback_scheduled_for` composed from the day + slot (local time), `callback_urgency`. Days and
  slots are not in production: the scheduler is a `datetime-local` with `min = now + 5 min` (map §4.4). Slot source not
  specified (new server data, or generated client-side); disable slots before the minimum (`.chip.dis`). Fallback: the
  native `datetime-local` in an `.inp`.
- **Controls:** Back / context back → `reset()`; Continue (`type=button`) → step 2 (no engine call).

### 5.18 Screen 18 — Callback, step 2

- **Layout:** `.ctx` "Step 2 of 2" (both bars on); summary chip y=122 ("Video · Tomorrow, 4:30 PM · Urgent" + "Change");
  "Department" + chips y=213; field group y=263 (Full name, Email *, Phone *; Email focused); note y=427 "Email or phone
  is required so we can reach you."; "Message (optional)" + textarea y=484 (placeholder "Briefly describe what you need
  help with…"); actions: Back + "Send request" (`check` before the text).
- **Data:** required markers when `callback_policy.require_contact` (and not identified); message label
  `message_optional` / `message_min {n}`; honeypot and time trap kept; identified contact not drawn (suggestion: the
  `.known` card instead of the group); `controller.error` not drawn here (suggestion: `.msg.err` above the actions; jump
  to step 1 for `err_future_time`).
- **Controls:** Change / Back → step 1; Send request `type=submit` → `submitCallback()`.

### 5.19 Screen 19 — Callback scheduled

- **Production:** `ended` (a) `callbackId` (`PD:495-511`).
- **Layout:** centred block y=126: success mark + `cal` badge; "Callback scheduled" y=244; "Our team will reach out
  tomorrow at 4:30 PM." y=277; key/value card y=320 (4 × 46): Type (`video` + "Video callback"), Time ("Tomorrow, 4:30
  PM"), Priority (urgent tag), Reference (`A1B2C3D4` + copy); Done (full).
- **Data:** channel → `video_callback` / `phone_callback`; when → `reach_out {when}` with `asap` or the formatted
  scheduled time (relative day + time: new formatting); reference = first 8 characters of `callback_id`, upper case;
  Priority row for Normal not drawn (suggestion: plain "Normal").
- **Controls:** copy → clipboard (new); Done → `reset()` and clear `callbackId` (brief §11). After closing, the
  launcher shows Sh until the booked time (needs the booking persisted client-side in `controller.callbackBooking`; new).

### 5.20 Screens 20–23 — Mobile

| ID | Production | Spec |
|---|---|---|
| 20 | launcher ≤640px | selected style at `right:18px; bottom:40px` (board: pill "Call support"); §2.3 |
| 21 | `online_available` | home inside the bottom sheet (§2.3); sheet top at y=190; header 68; body y=271; feature row y=746; footer y=782 |
| 22 | `queue_waiting` | full-screen stage: header 114, pill y=114, orb 204 at y=156, title y=368, timer y=455, queue card y=501 (338 × 123), dock y=686 (96), footer y=782 |
| 23 | `in_call` video | full-screen video: top bar y=104, self-view 108 × 150 at x=266 y=544, dock 276 × 72 at x=57 y=698, footer y=782 |

---

## 6. Motion

### 6.1 Launcher and panel (live prototype CSS, `cc.css:818-851`)

| Interaction | Element | Property | Duration | Easing | Delay | Keyframes / values |
|---|---|---|---|---|---|---|
| Open: button leaves | launcher wrap | transform, visibility | 260 ms | `--ease-in` | visibility at 260 ms | bottom: `translateY(150px)`; top: `translateY(-170px)`; edge right `translateX(80px)`, edge left `translateX(-80px)` |
| Open: panel springs | panel | opacity / transform / visibility | 220 ms / 520 ms / 0 | `ease` / `--spring` | 180 ms | from `translateY(30px) scale(.88)` (top: `translateY(-30px)`; edge: `translateX(±30px) scale(.9)`), origin = anchor corner |
| Close: panel folds | panel | opacity / transform | 200 ms / 260 ms | `ease` / `--ease-in` | 0 (visibility hidden at 260 ms) | back to the closed transform |
| Close: button returns | launcher wrap | transform / opacity | 550 ms / 300 ms | `--spring` / `ease` | 200 ms | to `none` |
| Screen change inside the panel | `.scr` | opacity | out 300 ms, in 350 ms | `ease` | in: 100 ms | crossfade |
| Call stage spreads | `.dk` | clip-path | in 700 ms / out 550 ms | `--ease` / `--ease-in` | 0 | `circle(0 at var(--cx,26%) var(--cy,56%))` → `circle(150% at …)`; origin = the pressed voice card (RTL `--cx:74%`); towards rating `--cx:50%; --cy:88%` (the End button) |
| Queue → call | orb rings | animation off, opacity 0; core icon transform / opacity | 400 ms / 300 ms | `--ease` / `ease` | | `.incall .orb.lvq .rg{animation:none;opacity:0}` |
| Place in line moves | `.ql2 .me` / `.ql2 .pp` | inset-inline-start; opacity, transform | 700 ms; 300 ms, 400 ms | `--spring`; `ease`, `--spring` | | dots leave as `scale(.2)`, opacity 0 |
| Minimise into the button | `.mc` | animation `cc-mcin` | 550 ms | `--spring` | 100 ms | `0%{opacity:0;transform:translateY(40px) scale(.7)}` → none |
| Star pick | `.star.on` | animation `cc-starpick` | 450 ms | `--bounce` | | `0% scale(.6)`, `60% scale(1.25)`, `100% none` |

### 6.2 Motion list of the live prototype (`.mn`, transcribed)

| # | Row | Text | Value | CSS / script that implements it |
|---|---|---|---|---|
| 1 | The button drops away | Speeding up as it goes; no button while the panel is open. In the top corners it tucks under the site header. | 260 ms | `.hide-l` `.26s var(--ease-in)` ✓ |
| 2 | The panel springs from that corner | A small overshoot, then the content arrives in sequence. | 520 ms | `.52s var(--spring) .18s` ✓; cascade `.cz` |
| 3 | The call screen spreads from the button | The dark stage opens out of the button that was pressed. | 600 ms | `.dk` clip-path is **700 ms** in, 550 ms out |
| 4 | Rings pulse with the ringback | The place in line changes with a little spring. | every 2.4 s | `cc-ring 2.4s` ✓; `.ql2` 700 ms spring |
| 5 | The operator joins | The rings gather into the operator's face and the call timer starts. | 500 ms | no 500 ms rule (rings off, core icon 400 ms, screen fade 350 ms + 100 ms) |
| 6 | Minimizing | The panel folds and the call carries on inside the button. | 300 ms | panel 260 ms; `.mc` enters 550 ms + 100 ms |
| 7 | Ending and rating | The dark stage clears and the stars fill one by one. | 80 ms apart | static boards: `calc(.35s + var(--i) * 80ms)` ✓; prototype demo fills 120 ms apart |

Prototype script timings (demo only, not product): auto-play opens at 1200 ms, then 2600 (voice call), 2600 (position 2),
2100 (position 1), 2000 (operator joins), 3400 (minimise), 3400 (reopen), 2400 (end), 1000 (stars), 1800 (submit),
2000 (done), 2600 (loop); any click pauses auto-play for 15000 ms; timers tick every 1000 ms; closing a non-home screen
returns it to home 420 ms later (suggestion for production: `reset()` after the close transition on `ended` screens).

### 6.3 Continuous and entrance animations

| Element | Animation | Duration / easing / delay | Keyframes |
|---|---|---|---|
| Status dot ping `.dot::after` | `cc-ping` | 2.4s `--ease` ∞ | `0%{scale(1);opacity:.6}` `70%,100%{scale(2.6);opacity:0}` |
| Launcher wave `.ln .wv` | `cc-lnwave-rp` | 3.6s `--ease` ∞ | `0%{box-shadow:0 0 0 0 rgba(255,90,60,.45)}` `45%,100%{0 0 0 20px rgba(255,90,60,0)}` |
| Launcher icon `.wig`, orb `.ringing`, `.mc .mo svg` | `cc-wiggle` | 3.6s / 2.4s / 2.4s ease-in-out ∞ | `0,34%,100% 0` `4% -14deg` `9% 12deg` `14% -10deg` `19% 8deg` `24% -4deg` `29% 0` |
| Logo flip (board demo) | `cc-flip` | 4.4s `--spring` ∞ | `0,38% rotateY(0)` `50,88% 180deg` `100% 360deg` |
| Label entrance `.lbl` | `cc-lbl` | 600 ms `--spring` 400 ms | `0%{opacity:0;translateX(12px) scale(.9)}` |
| Home cascade `.cz` | `cc-rise` | 600 ms `--ease`, delay `calc(.15s + var(--i) * 70ms)` (badge 0 … feature row 5) | `0%{opacity:0;translateY(14px)}` (board 12 says "Stagger 60 ms") |
| Voice card rings `.rw` | `cc-tile` | 3.6s `--ease` ∞, 0 / 1.2s / 2.4s | `0%{scale(.5);opacity:0}` `25%{opacity:.9}` `100%{scale(1.3);opacity:0}` |
| Orb rings `.rg`, `.ln-f .ring2`, `.mc .mo` rings, `.xf .to::after` | `cc-ring` | 2.4s `--ease` ∞ (`.fast` 1.6s) | `0%{scale(1);opacity:.75}` `100%{scale(1.62);opacity:0}` |
| Halo | `cc-halo` | 1.8s / 2.3s (-.8s) ease-in-out alternate | `0% 1.04/.5` `30% 1.3/.85` `55% 1.12/.6` `80% 1.38/.9` `100% 1.18/.65` (scale/opacity; board 12 says "Voice halo 1600 ms") |
| Breathe | `cc-breathe` | 2.6s ease-in-out | `50%{scale(1.045)}` |
| "You" | `cc-me` | 2.4s ease-in-out | `50%{scale(1.07)}` |
| Talking avatar `.mc .av` | `cc-talk` | 1.6s ease-in-out alternate | box-shadow 2px → 7px glow ring |
| Bars `.eq`, `.wvs` | `cc-eq` | .9s / .8s ease-in-out alternate | `scaleY(.3)` → `scaleY(1)` |
| Dots `.ldots` | `cc-wave` | 1.2s ease-in-out | `30%{translateY(-3px);opacity:1}` else `.45` |
| Recording dots | `cc-blink` | 1.4s ease-in-out | `50%{opacity:.3}` |
| Spinners | `cc-spin` | .9s / 1.1s linear (dash 9s, transfer 8s) | `to{rotate(360deg)}` |
| Offer card | `cc-rise` | 600 ms `--spring` 500 ms | as cascade |
| Tap hint | `cc-hint` | 2s ease-in-out | `50%{opacity:.62}` |
| Skeleton | `cc-shim` | 1.4s linear | background-position 100% → -100% |
| Transfer arrows | `cc-flow` | 1.2s ease-in-out, 0 / .2s / .4s | `50%{opacity:1}` else `.2` |
| Lock focus | `cc-focus` | 1.6s ease-in-out | `50%{opacity:.35;scale(1.18)}` |
| Self-view | `cc-pip` | 600 ms `--spring` 500 ms | `0%{opacity:0;scale(.6) translateY(20px)}` |
| Success | `cc-pop` (core .6s `--bounce` .15s; badge .5s .7s), `cc-draw` (.5s `--ease` .5s, dashoffset 24 → 0), `cc-bloom` (2.6s `--ease` .7s ∞: `0% 1/.9`, `80%,100% 1.5/0`) | | |
| Stars (static boards) | `cc-star` | 550 ms `--bounce`, `calc(.35s + var(--i)*80ms)` | `0%{opacity:0;scale(.3) rotate(-25deg)}` |
| Consent error | `cc-nudge` | 500 ms `--ease` 600 ms ×2 | `25% -3px`, `75% 3px` |
| Sheet | `cc-sheet` 700 ms `--spring` 300 ms (`translateY(100%)` → none); scrim `cc-fade` 400 ms ease 200 ms | | |
| Hover / press | launchers `.3s var(--ease)`; `.opt` `.35s`; `.btn`, `.cbn .bt`, `.xbtn` `.2s`; `.ib` `.18s`; `.chip` `.25s var(--bounce)`; switch knob `.32s var(--spring)` | | |

### 6.4 Reduced motion

`@media (prefers-reduced-motion:reduce){.cc *,.cc *::before,.cc *::after{animation:none!important;transition:opacity .15s ease!important}}`
(`cc.css:1015-1017`; board 12: "Reduced motion — Fade only"). Apply to `.ccw-root` in the shadow root; the clip-path
stage reveal becomes an opacity fade. Brief §7: at least as strong as production's opt-out.

---

## 7. Direction, language and numbers

- **LTR is the design.** Respok renders `lang="en" dir="ltr"`. The CSS is written with logical properties
  (`inset-inline-*`, `margin-inline-*`, `padding-inline`, `border-end-end-radius`, `text-align:start`), so `dir="rtl"`
  mirrors the panels for the Persian fallback.
- **Stays physical:** launcher anchoring and the panel tail (physical anchor corner, brief §4); `.ln-cl` and `.ln-f`
  are `direction:ltr` (the label sits on the page side via `.at-l`); the label close `.x` (`left:-8px`); the edge tab
  shapes; the browser-bar illustration `.addr .bar` (`direction:ltr`) and its popover padding swap
  (`[dir=rtl] .addr .pop{padding:9px 12px 9px 10px}`).
- **Mirrors in RTL:** `.dirf` icons (back, forward arrows, row chevrons, transfer arrows); switch knob
  (`translateX(-18px)`); option go-disc hover (`translateX(-3px)`); stage reveal origin (`--cx:74%`); slot fade
  (`--fade-to:left`); `.ltrv` inputs stay `dir=ltr` but `text-align:right`.
- **Mixed content:** email, phone and the reference code are LTR isolates (`dir="ltr"`, `.code{direction:ltr;unicode-bidi:isolate}`, `.ltr`).
- **Digits:** Latin digits in English; timers and counts use `font-variant-numeric:tabular-nums` (`.num`, `.tmr b`,
  `.ctm`, `.qs b`, `.slots .chip`, `.mc small`). In `fa`, every number becomes Persian (brief §6; the board 04 helper
  `dig()` maps `0-9` → `۰-۹` when `fa`).
- **Fonts by direction:** English Figtree; Persian Vazirmatn (add it to `--font` for `lang="fa"`, §3.2); reference code
  DM Mono.
- **Times:** 12-hour English times on the boards ("4:30 PM", "Tomorrow, 4:30 PM", "10:00 AM"); use `Intl.DateTimeFormat`
  with the widget locale (production uses `toLocaleString()` with no locale, map §8).

---

## 8. Accessibility

| Item | As designed | Production action |
|---|---|---|
| Launcher | `aria-label="Open the call widget"`; offline `aria-label="Callback"`; split `role="group" aria-label="Call us"`; label close `aria-label="Close"` | add `aria-expanded`, `aria-controls` (brief §7) |
| Panel | `section.cp[aria-label]` (screen names on the boards; prototype "Nilufar Store Support" = display name); mobile `.sheet[role=dialog][aria-label]` | `role="dialog"` + label on `ccw-panel`; `inert` when closed; Escape collapses |
| Header | `.lg[aria-hidden]`; collapse "Minimize"; language "Widget language" | label from i18n (today hard-coded English) |
| Forms | `label[for]` / `id` pairs; email/phone `dir="ltr"`; department `role="group" aria-label="Department"` with `aria-pressed` chips; switch `role="switch" aria-checked aria-labelledby`; segments `aria-pressed`; error `p.msg.err[role=alert]` | brief asks radio semantics for chips and segments (`role=radiogroup` / `radio`); add `autocomplete`, `aria-invalid`, `aria-describedby` |
| Stage | `.pill[role=status]`, `.tmr[role=timer]`, `.ctm[role=timer]`, `.bnr[role=status]`, `.vtop[role=status]`; decorative `.orb`, `.xf`, `.ql`, `.eq`, `.wvs`, `.addr` `aria-hidden`; `.net[title="Good connection"]` | polite live regions for queue position, status and errors only — not for the per-second timers (brief §7); move `role=status` off containers whose text ticks |
| Call controls | `aria-label` "Mute", "End", "Minimize", "End call", "Camera off", "Mute sound", "Cancel call", "Open the call"; `.pip[aria-label="You"]`; `.mvid[role=status][aria-label="Video call, minimized"]` | add `aria-pressed` on Mute / Camera / sound toggles and switch their labels ("Unmute", "Camera on", "Unmute sound") |
| Rating | `role="group" aria-label="Rating"`, stars `aria-label="1"…"5"` + `aria-pressed`; textarea `aria-label="Add a comment (optional)"`; summary `aria-label="4/5"` | radio semantics; localised labels |
| Copy | `button.cpy[aria-label="Copy code"]` | announce success (not drawn) |
| Focus | `:focus-visible{outline:2px solid #FF5A3C;outline-offset:2px}` on buttons, links, `[role=textbox]`; stage `outline-color:#fff`; fields use the Signal ring box-shadow | every control, including `.opt`, `.cbr`, chips, stars, `.mbt`, `.vdock .bt` |
| Contrast | Ink on white 17.96:1; ink-3 on white 6.43:1, on paper 5.91:1; `--bad` on white 4.87:1; warn-ink on warn-bg 5.88:1; `#FFDC9A` on `#1A1838` 12.95:1. **Below 4.5:1:** Signal `#FF5A3C` on white 3.1:1 (icons, dots, stars, focus — not body text); placeholder ink-4 on white 2.35:1; **white on `--end` `#E5432A` 4.06:1** for 15px/700 "Cancel call" / "End call" text (not large text) | owner's decision (darker `--end` for text buttons, or accept) |
| Touch targets | ≥ 44px except `.ib` 38, `.ctx .ib` 36, `.lang` 32 high, `.cpy` 28, `.mvid` buttons 30, `.lbl .x` 22, `.star` 50 ✓, `.mbt` 40 | brief §7 asks ≥ 44px: enlarge hit areas (padding / pseudo-element) without changing the drawn size |

---

## 9. New versus production

Canonical names: [`../../shared/new-hooks-and-settings.md`](../../shared/new-hooks-and-settings.md) (one name per concept
for both brands); the names below follow it.

| Addition | Where | UI spec summary | Engine / server / settings must provide | Suggested hook, intent or config key | If unavailable |
|---|---|---|---|---|---|
| Launcher styles | L1–L9, LP button-* | §4.1 | setting | `config.launcher_style`: `round`, `round_label` (default), `pill`, `card`, `split`, `edge_tab`, `dark_square`, `operator_face`, `mobile_bar` | `round_label` |
| Placements | P1–P8 | §4.3 | setting | `config.widget_position`: `right` (default), `left`, `top_right`, `top_left`, `bottom_center`; the edge placement comes from `launcher_style: edge_tab` | `right` |
| Launcher leaves while open | F1–F4 | §6.1 | renderer | `ccw-is-open` drives `.hide-l` | — |
| Minimised queue / call / video in the launcher | Se–Sg, LP minimized-call | §4.2 | renderer reads `state`, `queuePosition`, `queueStartedAt`, `callStartedAt`, `operatorName`, media elements | launcher view derived from state; `_waveBars` = `.wvs i` | plain launcher |
| Booked callback on the launcher | Sh, 19 | `.sched` | persist `{callbackId, scheduled_for, channel}` after `submitCallback` until the time passes | `controller.callbackBooking` (persisted beyond `reset()`, e.g. sessionStorage) | normal launcher |
| Operator faces / photo | L4, L8 | avatars, photo | online operator initials / photo URL | `bootstrap.presence.operators[] {name, initial, avatar_url}` (new) | hide `.avs`; use `round_label` |
| Home badge + feature row | 01, 21 | §4.5 | — (keys `live_now`, `channels`, `secure_line`, `queue_aware`, `fast_handoff` exist, unused) | i18n | — |
| Department chips | 02, 18 | radio chips | `bootstrap.departments` (exists) | `formData.department_id` | — |
| Consent switch | 02, 03 | `.sw` | exists | `formData.consent` | — |
| Edit saved contact | 03 | "Edit" link | send edited name/email/phone with the call | `ui.editingContact` (renderer reveals the fields) | hide link |
| Hide the launcher label | L2 | "Close" on the label | renderer-local, remembered per session (suggestion) | `ui.labelDismissed` | show the label |
| Permission hint | 03 | `.permit` | — | i18n | — |
| Connecting context | 04 | "Voice call · Sales" | department name lookup | renderer | channel only |
| Visual queue line + split ETA | 05, 06 | `.qc` | exists (`queuePosition`, `queueEta`) | i18n `queue_position`, `eta` (exist) + new value keys | hide cells |
| Signal indicator | 08 | `.net` | connection quality (LiveKit `ConnectionQuality`) | `controller.connectionQuality` (`excellent`/`good`/`poor`/`lost`; new) | hide `.net` |
| Minimize in the dock | 07–11, 09 | `.cbn` / `.vdock .bt` | — | `toggleOpen()` | — |
| Operator initial orb | 07, 08, 11, 13, 14 | `.orb.op` | `operatorName` (exists) | — | `headset` icon (suggestion) |
| Transfer copy + continuing timer | 10 | "Please stay on the line.", timer continues | keep `callStartedAt` across transfer | engine change (owner) | timer restarts |
| Retry microphone | 12 | "Try again" | re-request microphone, re-publish | `controller.retryMicrophone()` (new) | hide button |
| Rating summary, thanks summary | 13, 14 | operator name, mini stars | exists | — | — |
| Error with callback CTA | 15 | `.vstack` | `caps.callback` | `openCallback()` | Back only |
| Two-step callback, day/time chips, summary chip | 17, 18 | §4.12 | callback slots (none today) | renderer `ui.callbackStep`; slots `callback_policy.slots[]` or `callback_policy.business_hours` (new) | `datetime-local` in `.inp` |
| Confirmation time, priority rows, copy code | 19 | `.kv`, `.cpy` | relative date formatting; Clipboard API | i18n `time`, `today`, `tomorrow` | hide copy |
| Mobile sheet and full screen | 20–23 | §2.3 | `visualViewport`, safe areas | `@media (max-width:640px)` | — |
| Business-logo flip | Sc | `.fc` | `config.avatar_url` (exists) | — | plain icon |
| Logo direction | footer | `lg-thread` / `lg-open` | setting | `logoDirection` (`thread` default) | thread |
| Tail corner, 400 × 660 | all | §2.1 | — | — | — |
| `--on-a`, `--a` | all | §3.1 | `applyTheme` | brief §5.1, §5.3 | — |

### 9.1 Known production problems (owner's README) → how this design solves them

| Problem | Solution in this design |
|---|---|
| Latin digits in Persian | Design is English; numbers are tabular and the board helper maps digits for `fa` (§7); timers update in place |
| Video call controls fall below the fold | Screen 09 / 23: the video fills the panel, the dock floats at `bottom:50px` (74 on mobile) over it; nothing scrolls |
| Mobile is not full-screen | Screens 22 / 23 are full screen; home is a bottom sheet (21) |
| Buttons are text-only in a call | Icon call controls `.cbn` with labels (Mute, End, Minimize) and the video dock (§4.8, §4.9) |
| "Connected" text and the recording note above the video | Status and recording move into the top bar ("Rec · name · time", §4.9); no text above the picture |
| Emoji used as icons | One stroke icon set ([`../../shared/icons/`](../../shared/icons/README.md)); emoji removed from strings (§10) |
| Long forms | Pre-call: department chips + one grouped contact block + switch (02); returning visitor only types the subject (03); callback split into two short steps (17, 18) |

---

## 10. Copy deck

UI strings as designed (English). Production keys from map §8 (en values in quotes when they differ). Demo content is not
listed.

| UI string | Where | Production key / new key |
|---|---|---|
| Open the call widget | launcher `aria-label` | new: `open_widget` (production uses the launcher text) |
| Talk now | label L2, L8 | `talk_now` |
| Live support | label | `live_support` |
| Close | label dismiss `aria-label` | new: `close` |
| Call support | pill | new: `launcher_pill` |
| Talk to our team | card L4, home title | `talk_to_team` |
| Operators available | card L4, header | `operators_available` |
| Voice call | split, bottom bar, home card, chip, context line | `voice_call` |
| Video | split | `video` ("🎥 Video" → remove emoji) |
| Call us | edge tab, split group label | new: `launcher_tab` |
| Callback | bottom bar, offline label, offline `aria-label` | `callback` |
| Leave details | offline label | `leave_details` |
| #{n} in line | minimised queue | new: `queue_place_short` |
| Next | minimised queue, queue position value at 1 | new: `queue_next_short` |
| Waiting time | minimised queue (+ " m:ss"), queue timer | `waiting_time` |
| Open the call | minimised `aria-label` | new: `restore_call` |
| Cancel call | minimised, queue dock | `cancel_call` |
| Mute / Unmute | call controls | `mute` / `unmute` ("🎙 Mute" / "🎙 Unmute" → remove emoji) |
| End call | minimised, video dock, mic blocked, board 12 | new: `end_call` |
| End | call dock | `end` |
| Video call, minimized | `aria-label` | new: `video_minimized` |
| Callback scheduled | booked launcher, screen 19 | `callback_scheduled` |
| Minimize | header collapse, dock | new: `minimize` (replaces `back` on the chevron, A3.14) |
| Widget language | `.lang` `aria-label` | new: `widget_language` (hard-coded today) |
| EN | `.lang` | `LOCALE_META.short` |
| Live now | badge | `live_now` (unused today) |
| Voice · Video · Callback | badge | per-channel parts, only enabled channels: new `channel_voice`, `video`, `callback` (`channels` stays unused) |
| Start a secure voice or video call with the next available operator. | home | `online_copy` |
| Uses your microphone | voice card | new: `voice_tile_sub` |
| Camera and microphone | video card | new: `video_tile_sub` |
| Video call | video card, chip | `video_call` |
| Request a callback | callback row, chip, board 12 button | `request_callback_instead` (callback row) / `request_callback_title` (chip, board 12 button; unused today) |
| Tell us how to reach you and our team calls back fast. | callback row | `callback_intro` ("Tell us how to reach you — our team calls back fast." → change en value; the form intro is not used in the design) |
| Secure line · Queue aware · Fast handoff | feature row | `secure_line`, `queue_aware`, `fast_handoff` (unused today) |
| Powered by | footer | `powered_by` ("Powered by {brand}"; with a logo the label is "Powered by") |
| Back | forms, error | `back` |
| Department | forms | `department` |
| Full name · Email · Phone · Subject | fields | `full_name`, `email`, `phone_field`, `subject` |
| Email * · Phone * | callback step 2 | `email_required`, `phone_required` (render "*" as the `<i>` marker) |
| I consent to this call being recorded for quality and security. | consent | `consent_required` (" I consent … security. (required)" → drop the leading space and "(required)") |
| Required | consent tag | `required` |
| Please accept the recording consent to start the call. | error line | `err_recording_accept` (client-side: `err_recording_required` "Recording consent is required to continue.") |
| Start call | primary | `start_call` |
| Contact details already saved | known contact | `contact_saved` |
| Edit | known contact, board 12 | new: `edit` |
| Your browser will ask to use the camera and microphone. | permission hint | new: `permission_note` |
| Connecting | screen 04 title | `connecting` |
| {channel} · {department} | screen 04 context | `voice_call` / `video_call` + " · " + department name (composition, no key) |
| Mute sound / Unmute sound | sound toggle `aria-label` | `mute_sound` / `unmute_sound` |
| Ringing an operator | queue pill | `ringing_operator` ("Ringing operator" → change en value) |
| Holding your place | queue title | `holding_place` |
| Your request is in the live call queue. Keep this window open while we connect the operator. | queue copy | `queue_copy_many` |
| You are next | position 1 title | `you_are_next` |
| We are ringing the next available operator now. | position 1 copy | `queue_copy_next` |
| You | queue line, self-view | new: `you` |
| Queue position | queue stats | `queue_position` (unused today) |
| ETA | queue stats | `eta` (unused today) |
| ~{n} minutes | ETA value | new: `eta_value_minutes` (production `eta_minutes` "Estimated wait: ~{n} minutes") |
| Under 1 minute | ETA value at position 1 | new: `eta_value_under_min` |
| Tap to enable sound | `.hint` (not placed) | `tap_to_hear` |
| Tired of waiting? We can call you back instead. | offer card | `tired_waiting` |
| Request callback | offer, error, offline | `request_callback` |
| Connected, waiting | screen 07 pill | `connected_waiting` ("Connected — waiting" → change en value) |
| Operator | role line, summary | `operator_label` |
| Operator joining | screen 07 timer chip (with animated dots) | `operator_joining` ("Operator joining…" → drop "…" when the dots render) |
| Recording may start after the operator begins the call. | screen 07 note | `recording_may_start` |
| Recording in progress | pill | `recording_progress` ("● Recording in progress" → drop "● ") |
| Rec | video top bar | new: `recording_short` |
| Good connection | signal `title` | new: `quality_good` |
| Camera off / Camera on | video dock `aria-label`, board 12 | `camera_off` / `camera_on` (remove "🎥 ") |
| Mic on · Muted | board 12 control labels | new: `mic_on`, `muted` (screens use Mute / Unmute) |
| In call | transfer pill, board 12 | `in_call` |
| Transferring to another operator… | screen 10 | `transferring_call` |
| Please stay on the line. | screen 10 | new: `transfer_hold` |
| Reconnecting media… | screen 11 banner | `reconnecting_media` |
| Reconnecting | board 12 warn pill | new: `reconnecting_short` |
| Microphone permission denied | screen 12 title | new: `mic_denied_title` (production `mic_denied` = title + body in one string) |
| Please allow access and try again. | screen 12 body | new: `mic_denied_body` |
| Microphone | screen 12 illustration | new: `microphone` |
| Click the lock next to the site address and turn the microphone on. | screen 12 | new: `mic_denied_how` |
| Try again | screen 12 | new: `retry` |
| Call ended. | summary | `call_ended` |
| Duration {m:ss} | summary, thanks | `call_duration` ("Duration" + " " + time; production joins with ": ") |
| How was your call? | rating | `rate_call_title` |
| Your feedback helps our team improve. | rating | `rate_call_sub` |
| Rating | stars group `aria-label` | new: `rating` |
| Add a comment (optional) | textarea | `rate_comment_ph` |
| Skip | rating | `rate_skip` |
| Submit rating | rating | `rate_submit` |
| Thank you for your feedback! | thanks | `rate_thanks` |
| Done | thanks, confirmation | `done` |
| {server message} | error title | `controller.error` (no "Error: " prefix; `unknown` fallback) |
| Leave a callback request and our team will call you as soon as possible. | error body | new: `error_callback_hint` |
| Callback desk | offline header | `callback_desk` |
| Leave a callback request | offline title | `leave_callback_request` |
| Our team is offline right now, but we can call you back. | offline copy | `offline_copy` |
| Our team will reach out as soon as possible. | offline note | `reach_out` with `{when}` = `asap` |
| Step 1 of 2 · Step 2 of 2 | callback steps | new: `step_of` ("Step {n} of {total}") |
| Callback type | step 1 | `callback_type` |
| Phone | step 1 | `phone` ("🎙 Phone" → remove emoji) |
| When should we call? | step 1 | `when_call` |
| As soon as possible | step 1 segment | new: `asap_option` (production `asap` is lower case for sentences) |
| Schedule | step 1 segment | `schedule` ("🗓 Schedule" → remove emoji) |
| Today · Tomorrow | day chips | new: `today`, `tomorrow`; weekday short names ("Sat", "Sun") from `Intl` |
| 10:00 AM … 7:30 PM | slots | formatted times (`Intl`) |
| Priority | step 1, confirmation | `priority` |
| Normal · Urgent | step 1, tag | `normal`, `urgent` ("🔥 Urgent" → remove emoji; fixes the doubled 🔥) |
| Continue | step 1 | new: `continue` |
| {channel} · {day}, {time} · {priority} | summary chip | composition, no key: `phone` / `video` + day and time (ASAP: `asap_option`) + `normal` / `urgent` |
| Change | summary chip | new: `change` |
| Email or phone is required so we can reach you. | step 2 note | `contact_required_note` ("* Email or phone …" → drop "* ") |
| Message (optional) / Message (min {n} chars) | step 2 | `message_optional` / `message_min` |
| Briefly describe what you need help with… | step 2 placeholder | `message_placeholder` |
| Send request | step 2 | `send_request` |
| Our team will reach out tomorrow at 4:30 PM. | confirmation | `reach_out` with `{when}` = day + " " + new `at_time` ("at {time}"; lower-case day) |
| Type · Time · Reference | confirmation rows | `type`, new: `time`, `reference` |
| Video callback / Phone callback | confirmation | `video_callback` / `phone_callback` |
| Copy code | copy `aria-label` | new: `copy_code` |
| Tomorrow 4:30 | booked launcher | formatted (`{day} {time}`) |

---

## 11. Acceptance checklist

In addition to the brief's §10:

- [ ] Every PNG in `screens/panels/` matches at 2x with the same data, including the 8px tail on the anchor corner and
      the radius variants of board 05.
- [ ] Respok defaults: `--a` Ink `#16142B`, `--on-a` white; Signal `#FF5A3C` only on live dots, focus, switch,
      selected-segment icons, stars, rings and the stage glow; the stage stays Ink with any custom accent.
- [ ] A light custom accent keeps text readable everywhere: the nine `#fff`-on-accent rules of §3.1 use `--on-a`, and
      the selected time slot uses white on Ink.
- [ ] `presentation-intl.css` contains exactly the non-chrome `.b-rp` rules of §3.8; `runtime.css` holds the rest.
- [ ] Default launcher `round_label` at bottom right (22px offsets); every `launcher_style` value and placement renders as
      on boards 01, 02 and 04; the button leaves (260 ms) and returns (550 ms after 200 ms) as in §6.1.
- [ ] Closing the panel during the queue or a call turns the launcher into Se, Sf or Sg; the call keeps running;
      reopening restores the same screen with focus and ring animations intact.
- [ ] Screen 05 / 06 update in place: timer, position (`.ql2` spring), ETA, title switch at position 1, offer card
      appearance; the rings never restart.
- [ ] All `connectStatus` cases of map §4.6 render (drawn ones as 07, 08, 11, 12; the others as the §1.2 suggestions),
      and `transferring` shows 10.
- [ ] Callback: step 1 → Continue → step 2 → Send request → 19; Back on step 2 returns to step 1; honeypot and time trap
      unchanged; Done clears `callbackId`.
- [ ] Footer: Thread lockup by default, Open with `logoDirection: open`, stage colours on dark screens, empty-footer
      layout intact.
- [ ] Persian fallback: `dir=rtl` mirrors logical layouts and `.dirf` icons; Vazirmatn is used; digits are Persian.
- [ ] Mobile (390 × 844): 20–23 match; safe areas replace the drawn notch and home bar.

### Design issues found while writing (build as designed unless the owner decides otherwise)

1. Panel width: live prototype 384px (`cc.css:843`) vs 400px on boards 05–10 and the brief; build 400.
2. Motion list vs CSS: "call screen spreads" 600 ms (CSS 700 ms in), "operator joins" 500 ms and "minimizing" 300 ms have
   no matching rule; board 03 "Closing 500 ms" vs CSS 260 ms panel + 550 ms button after 200 ms; board 12 "Stagger
   60 ms" vs `.cz` 70 ms, "Voice halo 1600 ms" vs `.halo` 1.8s / 2.3s; prototype stars fill 120 ms apart vs "80 ms apart".
3. Minimised call: card Sf has Mute + End, the live prototype has Open + End (and the full name).
4. Board Sc caption says the logo flips on hover, but the card animates continuously (both faces are provided as
   `--c-business-logo.png` and `--c-business-logo-flipped.png`); card Sb shows no logo at all.
5. Screen 06 has two sound toggles (`.sbt` and the dock).
6. The Respok launcher tails are hard-wired to the end-end / bottom-right / bottom-left corners (`.ln-p`, `.ln-r`, `.ln-s`,
   `.ln-q`, `.ln-t`) and do not follow the placement (LP button-p-bl shows the pill's tail pointing away from the
   corner); the panel tail is `border-end-end-radius` (logical) while the brief asks for the physical anchor corner.
   Label radius for top-left (`cc.css:836`) puts the tail at the bottom-left; top-right keeps the WebYar numbers
   `16px 6px 16px 16px` (`cc.css:837`).
7. Card DS1 labels `primary-ink` as `mix(primary 70%, ink)` (Respok: `var(--a)`) and maps `surface` to the Paper
   swatch, while the brief maps `surface` to the panel background; DS2 demonstrates accent-derived stages, which the
   Respok brand does not use.
8. `.inl` is styled 12.5px but renders 13.5px (`.ctr p` wins); `.kv .v` sets weight 700 on DM Mono (only 400/500).
9. Header status keeps "Operators available" on the error screen "No operator is available right now" and during calls
   (it follows `isOnline()` as in production).
10. Contrast: white on `--end` 4.06:1 for 15px button text.
