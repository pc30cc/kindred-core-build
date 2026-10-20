# New hooks, settings, controller calls and i18n keys

This is the canonical registry of every new name the two call-center design specs introduce: settings, controller calls
and fields, renderer UI state, hooks (classes, attributes, custom properties and controller fields the renderer or the
engine relies on) and i18n keys. One rewritten renderer (`presentation-default.js`) serves WebYar `default` and Respok
`intl` ([brief §3](../CLAUDE_CODE_BRIEF.md)), so there is **one name per concept**, shared by both brands. Production
names ([production map](production-map.md) §1.7, §5, §6, §8) are reused wherever they fit; they are listed here only
where a design uses them in a new way (a new value, a new place, changed copy). Every production hook keeps its element
and value contract ([brief §2](../CLAUDE_CODE_BRIEF.md)). If a design README and this file ever disagree on a name, this
file wins.

**Abbreviations.** WY = the [WebYar spec](../webyar/template-1-call-center/README.md), RP = the
[Respok spec](../respok/template-1-call-center/README.md), map = the [production map](production-map.md), brief = the
[implementation brief](../CLAUDE_CODE_BRIEF.md). L1–L9, P1–P8, Sa–Sh and 01–23 are the screen IDs of both specs (§1).
"Named here" = the specs describe the data or the hook but give it no name; this file names it.

**How each name was chosen.**

1. An existing production name when one fits (config field, controller method or field, i18n key).
2. Otherwise the name both specs already use.
3. Otherwise the WebYar spec's name (WebYar `default` is the base of the renderer; Respok `intl` is a skin over it).
4. Format follows production. Settings are snake_case fields of `bootstrap.config`, stored with the call-center settings
   on the server like `widget_template_id` and `widget_position` (map §1.4, §1.7); the one exception is `logoDirection`,
   a single workspace setting shared with the chat widget that keeps the chat package's name. Controller methods and
   fields and renderer state are camelCase (`toggleMic`, `callStartedAt`). i18n keys are snake_case (`talk_now`,
   `holding_place`) with `{n}`, `{total}`, `{time}`, `{when}` placeholders, identical in every language. CSS hooks keep
   the design class names inside the shadow root next to production's `ccw-*` classes.
5. Every new i18n key is added to `fa`, `en` and `tr` in RT's `I18N` (Turkish strings are not part of the designs), and
   every value is free of emoji ([brief §2.10](../CLAUDE_CODE_BRIEF.md)).

---

## 1. Settings

| Key | Values | Default | Where stored | What it controls | Notes |
|---|---|---|---|---|---|
| `config.launcher_style` (new) | `round`, `round_label`, `pill`, `card`, `split`, `edge_tab`, `dark_square`, `operator_face`, `mobile_bar` | `round_label` | Call-center settings (`call_center_settings.launcher_style`), sent as `bootstrap.config.launcher_style` | Launcher style L1–L9 | Design class per value: `.ln-c`, `.ln-cl`, `.ln-p`, `.ln-r`, `.ln-s`, `.ln-t`, `.ln-q`, `.ln-f`, `.mbar` (prototype keys `c`, `cl`, `p`, `r`, `t`). Unknown value → `round_label`. `card` and `operator_face` need `bootstrap.presence.operators` (without it: `card` without avatars, `operator_face` → `round_label`). `split` and `mobile_bar` call `startCall` / `openCallback` synchronously in the click. `edge_tab` sits on the vertical middle of the `left` or `right` edge (P5). Not specified: `mobile_bar` above 640px (RP suggestion: render `round_label`); `round_label` at ≤640px (WY suggestion: render as `pill`). WY §4.1, §9.1; RP §4.1, §9 |
| `config.widget_position` (existing; new values) | `right`, `left`; new `top_right`, `top_left`, `bottom_center` | `right` | Existing config field (map §1.7) | Corner of the launcher and the panel, and the panel's opening direction | Today every value other than `left` becomes `right` (RT:727-730); extend that mapping. The edge placement is `launcher_style: edge_tab` on `right` or `left`; the phone placements are the chosen value at ≤640px (P7) and `launcher_style: mobile_bar` (P8). Offsets 22px from the side and bottom, 20px from the top; `bottom_center` values not specified (WY suggestion: `left:50%; transform:translateX(-50%); bottom:22px`). Position classes §4.1. WY §2.3, §9.1; RP §4.3, §9 |
| `logoDirection` (existing in the chat widget; new for the call widget) | `thread`, `open` | `thread` | The workspace's Respok logo setting, the same one the chat widget reads (same name and values as in the chat handoff); the call bootstrap carries it as `bootstrap.config.logoDirection` | Respok "Powered by" lockup (Thread or Open) | Class `.lg-thread` / `.lg-open` on `.ccw-root` (§4.1). WebYar ignores it. Brief §5.7; RP §3.8, §4.13, §9; Respok brand sheet |
| `bootstrap.callback_policy.slots[]` (new) | Bookable callback start times (shape not specified; suggestion: ISO 8601 with offset) | none | Server callback policy, sent in `bootstrap.callback_policy` like `show_when_online` (map §1.7) | Day chips and time slots of callback step 1 (17) | One of two sources: `slots` wins over `business_hours`; with neither, the native `datetime-local` styled as `.inp`. Not specified: slot step, opening hours, first slot ≥ now + 5 min (to match the picker's `min`). fa: Jalali days in `Asia/Tehran`. WY §5.17, §9.1; RP §5.17, §9 |
| `bootstrap.callback_policy.business_hours` (new) | Opening hours (shape not specified) | none | Same as `slots` | Alternative source: the renderer generates the slots from the opening hours | Used only when `slots` is absent |
| `bootstrap.presence.operators[]` (new) | `{name, initial, avatar_url}` per online operator | `[]` | Computed by the server for each bootstrap (not a stored setting) | Avatars of `card` (L4); photo and name of `operator_face` (L8) | Presence refresh not specified (`isOnline` is fixed at bootstrap, map A3.19). WY §9.1; RP §9 |
| `config.widget_theme.*` (existing; new mapping) | `primary`, `accent`, `surface`, `text`, `muted`, `danger`, `radius`, `density` | as today | Existing (map §1.7) | `primary` → `--a` (hex, no rounding) and `--on-a`; `accent` → `--live`; `danger` → `--end` and `--bad`; `text` → `--ink`; `muted` → `--ink-3`; `surface` → the light panel background; `radius` → `data-radius` → `--r-panel` / `--r-card` / `--r-ctl` | Brief §5. The Respok stage stays fixed Ink. `density: compact` keeps production's rule on the new classes |
| `config.avatar_url` (existing; new places) | URL | none | Existing | Header logo tile `.lg`; face `.f1` of the business-logo launcher `.ln-c.logo` (Sc) | Flip to the phone face on hover (`.fc.flipped`) |

---

## 2. Controller calls and fields

### 2.1 New

The renderer calls these directly on the controller, like `toggleMic` (map §5); adding them to `intents` is optional.

| Name | Kind | Purpose | Engine work needed | Used by screens |
|---|---|---|---|---|
| `controller.retryMicrophone()` | method (new) | Ask for the microphone again after `microphone_permission_denied` and republish the local audio | RT: re-request the microphone (`setMicrophoneEnabled(true)` on the local participant); on success set `connectStatus` back to the live status and render; on failure stay on screen 12 | 12 (button `retry`); hide the button when the method is absent |
| `controller.skipRating()` | method (new in RT; PD:563 already calls it) | Leave the rating screen without sending a rating | RT: no API call, then `reset()` (brief §11, map A3.5) | 13 (`rate_skip`) |
| `controller.connectionQuality` | field (new): `excellent` \| `good` \| `poor` \| `lost` | Connection indicator | RT: listen to LiveKit `ConnectionQualityChanged`, store the value (LiveKit's `unknown` counts as absent), render | 08 `.net` (`title` = `quality_<value>`, §5.3); hide `.net` while absent |
| `controller.callbackBooking` | field (new, persisted): `{callbackId, scheduled_for, channel}` | The booked callback, shown on the launcher until its time | RT: set after `submitCallback` succeeds (`callbackId` from the response, `scheduled_for` ISO, `channel` `audio` \| `video`); keep it through `reset()`, which now clears `callbackId` (A3.2); persist it in sessionStorage `ccw_callback_booking:<workspaceId\|publicKey\|default>:<apiBase>` (named here, scoped like `ccw_active_call_session`); drop it once `scheduled_for` has passed. WY also allows a server copy in the bootstrap instead (not named; owner's decision). ASAP requests (no `scheduled_for`): not specified | Sh (its click opens the panel; suggestion: show 19) |

### 2.2 Existing calls and fields in new places

| Name | New use | Screens |
|---|---|---|
| `startCall('voice' \| 'video')` | The L5 split halves and the L9 voice button open the panel and start the call synchronously in the same click (ringback needs the gesture) | L5, L9 |
| `openCallback()` | L9 callback button; error-screen button; the offer card calls it only after `cancelCall()` resolves (A3.3, A3.4) | L9, 06, 15 |
| `toggleOpen()` | Dock and video-dock minimise; restore on Se and Sg; Sh click (suggestion); L2 label click; mobile scrim tap (suggestion) | 07–11, Se–Sh, 21 |
| `cancelCall()` | Se cancel, Sf and Sg end; screen 04 cancel (no call id yet: not specified, RP suggests disabling it until the request resolves) | 04, Se–Sg |
| `toggleMic()` | Sf and Sg mic buttons | Sf, Sg |
| `micOn` | Colour **and** label of every mic button (fixes A3.8) | 07–11, Sf, Sg |
| `callStartedAt` | Screen 10 shows the time continuing across a transfer: keep it in RT (RT:997-1011) or show the restarted timer (owner's decision) | 10 |
| `operatorName`, `ratingValue` | Sf name; summaries of 13 and 14; mini stars of 14 (both survive until `reset()`) | 13, 14, Sf |
| `callbackId` | Cleared by `reset()` (A3.2) | 19 |
| `formData.callback_scheduled_for` | Written by the day and slot chips as ISO 8601 with the offset (fa: `Asia/Tehran`, e.g. `+03:30`); `submitCallback` parses it | 17 |
| `formData.department_id`, `formData.consent` | Written by the department chips and the consent switch (no full render) | 02, 03, 18 |

---

## 3. Renderer UI state (view-model fields)

Production builds a view model that the renderer never reads (map §1.3); the renderer reads the controller. The new
state below is renderer-local, in one module-level `ui` object of `presentation-default.js`.

| Field | Type | Default | Purpose | Screens | Notes |
|---|---|---|---|---|---|
| `ui.callbackStep` | `1` \| `2` | `1` on entering `callback_form` | Step of the callback form | 17, 18 | Continue → `2`; Back and Change on step 2 → `1`; Back on step 1 → `reset()`. Both steps stay inside one `<form>`; hidden step-1 fields keep their `formData`. For `err_future_time` return to step 1 (RP suggestion). WY §5.17, §9.1; RP §5.17, §9 |
| `ui.editingContact` | boolean | `false` | Show the name / email / phone group, prefilled, for an identified visitor | 03 | Needs RT to send edited `formData` with an identified contact. WY §5.03, §9.1; RP §5.3, §9 |
| `ui.labelDismissed` | boolean | `false` | The visitor closed the L2 label | L2 | Remembered per session in sessionStorage `ccw_label_dismissed` = `'1'` (named here). WY §9.1; RP §9 |
| `ui.previousOperatorName` | string | none | Initial of the operator before a transfer (RT clears `operatorName` on transfer, map §4.6) | 10 | Named here. Set when `transferring` turns true. WY §5.10 |

---

## 4. Hooks

### 4.1 Classes, attributes and custom properties

| Hook | Element | Purpose | Set by | Notes |
|---|---|---|---|---|
| `.ccw-root` (production) = the boards' `.cc` | Root inside the shadow root | Carries every design token: `--a`, `--on-a`, `--a-1`…`--a-ink`, `--ink`…, `--paper`, `--line`, `--live`, `--live-hi`, `--end`, `--bad`, `--warn*`, `--star`, `--glow`, `--s1`..`--s3`, `--core`, `--core-ink`, `--r-panel`, `--r-card`, `--r-ctl`, `--tail`, `--tail-s`, motion tokens | `runtime.css` and the skin stylesheet | The design tokens keep their design names. They are **not** new `--ccw-*` tokens: production's `--ccw-*` stay HSL channels (brief §2.9). WY §3, RP §3 |
| `--a`, `--on-a` | `.ccw-root` (inline) | The accent as hex, and text on the accent | `applyTheme` from `widget_theme.primary` | Brief §5.1, §5.3 |
| `data-radius="sm\|md\|lg"` (production) | `.ccw-root` | Radius set; the boards' `data-r` | `applyTheme` | Rewrite `.cc[data-r=…]` as `[data-radius=…]` |
| `.ccw-presentation-intl` (production) | `.ccw-root` | Respok skin; the boards' `.b-rp` | The intl `mount` | `presentation-intl.css` = the non-chrome `.b-rp` rules (RP §3.8). WebYar has no `.b-wy` rules |
| `.lg-thread` / `.lg-open`; `.g-t` / `.g-o` | `.ccw-root`; lockup parts in the footer | Respok logo direction | Renderer, from `config.logoDirection` | `cc.css:69`. RP §3.8, §4.13 |
| `.ccw-is-open` (production) | `.ccw-root` | Open state: the panel opens and the launcher leaves the corner | Renderer | Replaces the prototype's `.site2.hide-l` (RP §9) |
| `left` / `right` (production); `top`, `center` (new, named here) | `.ccw-launcher-wrap` and `.ccw-panel` | Placement from `config.widget_position` | Renderer | `right` → `right`; `left` → `left`; `top_right` → `right top`; `top_left` → `left top`; `bottom_center` → `center` (neither `left` nor `right`). Replaces the prototype's `.pos-br`, `.pos-bl`, `.pos-tr`, `.pos-tl` |
| `.at-l` (design) | Launcher (`.ln-cl`, `.ln-f`, `.ln-t`) | Left-side variant: label order, label tail corner, edge-tab shape, close button side | Renderer for `left` and `top_left` | `cc.css:587-633, 883` |
| `.ln-c`, `.ln-cl`, `.ln-p`, `.ln-r`, `.ln-s`, `.ln-t`, `.ln-q`, `.ln-f`, `.mbar` (design) | Launcher inside `.ccw-launcher-wrap` | One per `config.launcher_style` value | Renderer | `.ccw-launcher-btn` stays on the button that toggles the panel. States: `.ln-c.off` (offline), `.ln-c.logo` with `.fc` / `.f1` / `.f2` (`.fc.flipped` on hover), `.ls` / `.ls.off` status dot, `.wv` wave, `.wig` wiggle |
| `.mc`, `.mvid`, `.sched` (design) | Content of `.ccw-launcher-wrap` while the panel is closed | Minimised queue and call (Se, Sf), minimised video (Sg), booked callback (Sh) | Renderer, from `state`, the open flag and `controller.callbackBooking` | `role="status"`; Sg's `.exp` becomes a `button` (`restore_call`) |
| `.cp.lv` > `.ly` (light layer) + `.dk.stage-bg` (stage layer); `.scr.on`; `.vid` (design) | `.ccw-panel` | Two persistent layers, the visible screen, the video screen | Renderer, structure built once per state | WY §2.1 |
| `dark`, `incall`, `toRate` (prototype class names, kept; named here) | `.ccw-root` (prototype: `.site2`) | Stage shown; queue → call ring hand-off; stage closing towards the End button | Renderer | Re-key `.site2.dark .lv .dk`, `.site2.incall …`, `.site2.toRate …` (`cc.css:861-867`) on `.ccw-root` |
| `--cx`, `--cy` (design) | `.dk` | Origin of the stage reveal | Renderer: the centre of the pressed element (WY suggestion); defaults `26%` (`74%` in RTL) and `56%` | WY §6.1, RP §6.1 |
| `--i` (design) | `.cz` cascade items, `.star` | Stagger index | Renderer | Indices: WY §6.3 |
| `--signal` (optional; RP suggestion) | `.ccw-presentation-intl` | One token for the Signal literals, if `widget_theme.accent` must recolour them | `presentation-intl.css` | RP §3.1 |

Production hooks that stay as they are: `#call-center-widget-host`, `#gs-presentation-fonts`, `ccw-launcher-wrap`,
`ccw-launcher-btn`, `ccw-panel`, `ccw-footer`, `ccw-powered`, `ccw-powered-label`, `ccw-powered-logo`, `data-density`,
`lang` / `dir` on `.ccw-root`, `[hidden]`, the honeypot `input[name=company_website]` and the media attributes below.

### 4.2 Controller fields used as hooks (media and level bars)

| Hook | Renderer supplies | Engine does | Screens |
|---|---|---|---|
| `controller._waveBars` | An array of the five bars `.mc .wvs i` while Sf is shown (`null` when Sf is removed); remove their `cc-eq` animation while the engine drives them (WY suggestion) | Nothing new: the meter already writes `transform: scaleY(…)` on each bar (RT:1345-1353). The voice panel (08) draws no level bars | Sf |
| `controller._attachedTracks` | The same remote `<video>` instance in `.feed` (09, 23) or `.mvid .feed` (Sg), re-parented synchronously, never cloned, never mirrored; the remote `<audio>` mounted hidden in the panel during voice calls too | Unchanged (map §6.1) | 08, 09, 23, Sf, Sg |
| `controller._localVideoEl` | The same instance in `.pip`, mirrored, only while `camOn` | Unchanged | 09, 23 |

---

## 5. i18n keys

Persian strings are copied from the WebYar copy deck (WY §10) and English strings from the Respok copy deck (RP §10),
with ZWNJ kept; values in the decks shown with demo data are written here with their placeholders. Where a string comes
from elsewhere in a spec, the last column says so. Wording decisions are in §5.6.

### 5.1 Launcher and header (new)

| Key | Persian | English | Where used | New or changed |
|---|---|---|---|---|
| `open_widget` | «باز کردن ویجت تماس» | Open the call widget | Launcher `aria-label` (every style; offline uses `callback`) | new (production uses the launcher text) |
| `close` | «بستن» | Close | L2 label close `aria-label` | new |
| `launcher_pill` | «تماس با پشتیبانی» | Call support | L3 pill text; mobile pill (20) | new |
| `launcher_tab` | «تماس با ما» | Call us | L6 edge-tab text; L5 split group `aria-label` | new |
| `queue_place_short` `{n}` | «نفر {n} صف» | #{n} in line | Se title | new |
| `queue_next_short` | «نفر بعدی» | Next | Se title at position 1; queue position value at position 1 (LP queue `q1`) | new |
| `restore_call` | «باز کردن تماس» | Open the call | Se and Sg restore button `aria-label` | new |
| `end_call` | «پایان تماس» | End call | Sf and Sg end `aria-label`; video-dock end `aria-label`; screen 12 button | new |
| `video_minimized` | «تماس تصویری کوچک‌شده» | Video call, minimized | Sg `aria-label` | new (Persian from WY §4.1 and §8; no WY deck row) |
| `minimize` | «کوچک کردن» | Minimize | Header collapse `aria-label` (replaces `back` there, A3.14); dock and video-dock minimise label | new |
| `widget_language` | «زبان ویجت» | Widget language | `.lang` `aria-label` (hard-coded English today, PD:261) | new |

### 5.2 Home and forms (new)

| Key | Persian | English | Where used | New or changed |
|---|---|---|---|---|
| `channel_voice` | «صوتی» | Voice | Home badge: the enabled channels among `channel_voice`, `video`, `callback`, joined with « · » / " · " (`channels` stays unused) | new (English is the first part of RP's "Voice · Video · Callback") |
| `voice_tile_sub` | «با میکروفون مرورگر» | Uses your microphone | Voice tile subtitle | new |
| `video_tile_sub` | «با دوربین و میکروفون» | Camera and microphone | Video tile subtitle | new |
| `edit` | «ویرایش» | Edit | Known-contact card (03, `ui.editingContact`) | new |
| `permission_note` | «مرورگر برای دوربین و میکروفون از شما اجازه می‌خواهد.» | Your browser will ask to use the camera and microphone. | 03 `.permit`, video calls (voice variant not drawn) | new |

### 5.3 Queue and call (new)

| Key | Persian | English | Where used | New or changed |
|---|---|---|---|---|
| `you` | «شما» | You | Queue line `.me`; self-view tag `.me-l` and `aria-label` | new |
| `eta_value_minutes` `{n}` | «حدود {n} دقیقه» | ~{n} minutes | Queue stats ETA value (`n = max(1, round(eta/60))`) | new (production `eta_minutes` is the chip sentence) |
| `eta_value_under_min` | «کمتر از ۱ دقیقه» | Under 1 minute | ETA value at one minute or less | new |
| `recording_short` | «ضبط» | Rec | Video top bar `.vtop` | new |
| `quality_good` | «کیفیت اتصال خوب است» | Good connection | `.net` `title` for `connectionQuality: good`; the other values use `quality_excellent`, `quality_poor`, `quality_lost` (named here; strings not in either deck) | new |
| `transfer_hold` | «لطفاً پشت خط بمانید.» | Please stay on the line. | Screen 10 | new |
| `mic_denied_title` | «دسترسی میکروفون رد شد» | Microphone permission denied | Screen 12 title (production `mic_denied` holds title and body in one string) | new |
| `mic_denied_body` | «لطفاً اجازه دسترسی بدهید و دوباره تلاش کنید.» | Please allow access and try again. | Screen 12 body | new |
| `mic_denied_how` | «روی نماد قفل کنار آدرس سایت بزنید و میکروفون را روشن کنید.» | Click the lock next to the site address and turn the microphone on. | Screen 12 instruction | new |
| `microphone` | «میکروفون» | Microphone | Screen 12 illustration popover | new |
| `retry` | «تلاش دوباره» | Try again | Screen 12 button → `retryMicrophone()` | new |
| `rtc_unsupported` | not in either deck | not in either deck | `connectStatus: rtc_v1_unsupported` (brief §11, A3.9): screen-12 layout with End call and, with `caps.callback`, the callback button | new; copy still to be written |
| `reconnecting_short` | «اتصال مجدد» | Reconnecting | Board 12 warn pill (`.pill.warn`) only; screen 11 uses `reconnecting_media` in `.bnr` | new (Persian from WY board 12 source; no WY deck row) |
| `mic_on`, `muted` | «میکروفون روشن» / «بی‌صدا» | Mic on / Muted | Board 12 state labels; only if the owner chooses state labels (WY §9.3 item 4); the screens use `mute` / `unmute` | new, conditional |

### 5.4 After the call, error and callback (new)

| Key | Persian | English | Where used | New or changed |
|---|---|---|---|---|
| `rating` | «امتیاز» | Rating | Stars group `aria-label` | new |
| `error_callback_hint` | «درخواست تماس بگذارید تا تیم ما در اولین فرصت با شما تماس بگیرد.» | Leave a callback request and our team will call you as soon as possible. | Screen 15 body (only with `caps.callback`) | new |
| `step_of` `{n}` `{total}` | «قدم {n} از {total}» | Step {n} of {total} | Step counter of 17 and 18 | new |
| `asap_option` | «در اولین فرصت» | As soon as possible | Step-1 "when" segment; summary chip of 18 for an ASAP request | new (production `asap` stays for `{when}` sentences, §5.6) |
| `today`, `tomorrow` | «امروز» / «فردا» | Today / Tomorrow | Day chips (17), summary chip (18), time row and `{when}` (19), Sh | new; lower case inside the English sentence ("tomorrow at 4:30 PM") |
| `continue` | «ادامه» | Continue | Step-1 primary button | new |
| `change` | «تغییر» | Change | Summary chip link (18) | new |
| `at_time` `{time}` | «ساعت {time}» | at {time} | `{when}` of `reach_out` = day + " " + `at_time` (19: «فردا ساعت ۱۶:۳۰» / "tomorrow at 4:30 PM") | new (English from RP's "{day} at {time}") |
| `time` | «زمان» | Time | Key/value row of 19 | new |
| `copy_code` | «کپی کد» | Copy code | Copy button `aria-label` (19) | new |

Weekday names come from `Intl` (`fa-IR-u-ca-persian` in `Asia/Tehran` for fa); slot times and the Sh time are formatted
with `Intl.DateTimeFormat` in the widget locale.

### 5.5 Existing keys whose value or use changes

| Key | Persian | English | Where used | Change |
|---|---|---|---|---|
| `mute` | «بی‌صدا» | Mute | Dock label; Sf, Sg and video-dock mic `aria-label` | emoji removed (today «🎙 بی‌صدا» / "🎙 Mute") |
| `unmute` | «صدا» | Unmute | Label of the muted mic button | fa «🎙 فعال‌کردن صدا» → «صدا» (§5.6 decision 1); en emoji removed |
| `camera_off`, `camera_on` | «خاموش کردن دوربین» / «روشن کردن دوربین» | Camera off / Camera on | Video-dock camera button (label follows `camOn`) | emoji removed |
| `phone`, `video` | «تلفنی» / «تصویری» | Phone / Video | Step-1 channel segment; summary chip of 18; `video` also the L5 split half and a home-badge part | emoji removed; new places |
| `schedule` | «زمان‌بندی» | Schedule | Step-1 segment | emoji removed |
| `urgent` | «فوری» | Urgent | Step-1 segment, summary chip, 19 tag | emoji removed and no renderer prefix (fixes the doubled 🔥) |
| `recording_progress` | «ضبط در حال انجام است» | Recording in progress | Voice-call pill `.pill.rec` | leading «● » / "● " removed |
| `connected_waiting` | «متصل، در انتظار اپراتور» | Connected, waiting | Screen 07 pill | fa and en change (today «متصل — در انتظار» / "Connected — waiting"; §5.6 decision 7) |
| `ringing_operator` | «در حال زنگ زدن به اپراتور» | Ringing an operator | Queue pill (always, as drawn) | en changes (today "Ringing operator") |
| `operator_joining` | «اپراتور در حال ورود است» | Operator joining | Screen 07 timer chip | value unchanged; the renderer drops the trailing «…» / "…" while the animated dots follow |
| `mute_sound` | «بی‌صدا کردن زنگ» | Mute sound | Queue sound toggle `aria-label` | fa changes (today «بی‌صدا کردن»; §5.6 decision 2) |
| `consent_required` | «رضایت می‌دهم این تماس برای کیفیت و امنیت ضبط شود.» | I consent to this call being recorded for quality and security. | Consent switch text, followed by the `required` chip | no leading space, no «(الزامی)» / "(required)" |
| `contact_required_note` | «ایمیل یا تلفن برای تماس با شما الزامی است.» | Email or phone is required so we can reach you. | Step-2 note | leading «* » / "* " removed |
| `callback_intro` | «راه ارتباطی را وارد کنید؛ تیم ما سریع تماس می‌گیرد.» | Tell us how to reach you and our team calls back fast. | Home callback row subtitle (new place; the callback form has no intro any more) | fa and en change (§5.6 decision 3) |
| `call_duration` | «مدت مکالمه» | Duration | Summaries of 13 and 14: `call_duration` + " " + time | composition changes (no ": ") |
| `connecting` | «در حال اتصال» | Connecting | Screen 04 title (production shows `loading` there) | new place |
| `live_now` | «آنلاین» | Live now | Home badge | unused today; set these values |
| `secure_line`, `queue_aware`, `fast_handoff` | «خط امن» / «مدیریت صف» / «اتصال سریع» | Secure line / Queue aware / Fast handoff | Home trust row | unused today; set these values |
| `queue_position`, `eta` | «جایگاه در صف» / «زمان تقریبی» | Queue position / ETA | Queue stats labels | unused today; set these values |
| `request_callback_title` | «درخواست تماس» | Request a callback | Callback-form channel chip `.ct` | unused today; set these values |
| `request_callback_instead` | «درخواست تماس» | Request a callback | Home callback row title (production: the ghost button) | new place |
| `request_callback` | «درخواست تماس» | Request callback | Offer card, error (15) and offline (16) buttons | unchanged |
| `callback` | «درخواست تماس» | Callback | L9 bar button; Sd label and `aria-label`; home-badge part | new places |
| `reach_out` | «تیم ما {when} با شما تماس می‌گیرد.» | Our team will reach out {when}. | 16 note (`{when}` = `asap`); 19 (`{when}` = day + " " + `at_time`) | `{when}` composition changes (Jalali day in fa) |
| `back` | «بازگشت» | Back | Form back, error screen | no longer on the collapse chevron (`minimize`) |
| `error_prefix` | — | — | Not used by the design: the screen-15 title is `controller.error` alone (`unknown` when empty) | dropped from the error screen |

The WebYar footer brand is «وب‌یار» with ZWNJ (production's `poweredByBrand()` returns «وب یار», RT:140); it is the
brand string inside `powered_by`, not a key.

### 5.6 Wording decisions

Where the two specs give different wording for the same key or slot, one wording is chosen; the other board keeps an
accepted difference.

1. **`unmute` (fa):** «صدا», the label of the muted mic button on the dedicated call screens (prototype, WY §4.6),
   instead of production's «فعال‌کردن صدا». Whether the dock shows action labels or state labels stays WY §9.3 item 4;
   the state variant uses `mic_on` / `muted`.
2. **`mute_sound` (fa):** «بی‌صدا کردن زنگ», as on the queue screens 05 and 06 (the dedicated boards), instead of
   production's «بی‌صدا کردن».
3. **`callback_intro`:** the home row is its only use, so the designed row text replaces production's in both languages
   («؛» instead of « — », "and our team" instead of " — our team").
4. **Channel in the step-2 summary chip:** `phone` / `video` («تلفنی» / «تصویری», "Phone" / "Video"), the labels of the
   step-1 segment (screen 17 is the dedicated screen for the channel choice), followed by the day and time (or
   `asap_option`) and `normal` / `urgent`, joined with « · » / " · " (a composition, no key). The English drawing
   "Video · Tomorrow, 4:30 PM · Urgent" matches; **accepted difference:** WebYar board 18 draws «تماس تصویری · فردا، ۱۶:۳۰ · فوری»,
   the widget shows «تصویری · فردا، ۱۶:۳۰ · فوری».
5. **ASAP segment label:** new `asap_option` («در اولین فرصت» / "As soon as possible"), because English needs a
   capitalised label while production's `asap` ("as soon as possible") stays lower case inside `reach_out`. The Persian is
   the same in both keys.
6. **`{when}` with a scheduled time:** day + " " + `at_time` («ساعت {time}» / "at {time}"), the English taken from RP's
   "{day} at {time}"; the English day is lower case inside the sentence.
7. **`connected_waiting`:** Persian «متصل، در انتظار اپراتور» (WY) and English "Connected, waiting" (RP). The Persian
   names the operator, the English does not: accepted, each deck sets its own language.
8. **`minimize` (en):** "Minimize" (RP deck); the brief's table quoted it as "Minimise" and now uses the deck string.
9. **The four «درخواست تماس» keys:** `callback` ("Callback": L9, Sd, badge), `request_callback_instead` ("Request a
   callback": home row), `request_callback_title` ("Request a callback": form chip), `request_callback` ("Request
   callback": offer, 15, 16). Persian is «درخواست تماس» in all four.
10. **`mic_denied_how`:** Persian «بزنید» (tap), English "Click": accepted, each deck sets its own language.
11. **Camera state labels** for the state-label variant (board 12 «دوربین روشن» / «دوربین خاموش», "Camera on" / "Camera
    off"): English matches `camera_on` / `camera_off`, Persian does not (the production values are actions). Not named by
    either spec; decide together with decision 1 (WY §9.3 item 4) before adding keys.

---

## 6. Superseded names

Do not use these; they appeared in earlier drafts of the two specs.

### 6.1 Names

The code-formatted names in the first column must not appear anywhere else in the package.

| Superseded | Canonical | Was in |
|---|---|---|
| `launcherStyle` (camelCase setting name) | `config.launcher_style` | WY §1 (L1), §5.20, §9.1; RP §4.1, §4.3, §9, §11 |
| `--ccw-stage-1..3`, `--ccw-glow`, `--ccw-core`, `--ccw-live` (board 12 labels) | design tokens `--s1`..`--s3`, `--glow`, `--core`, `--live` on `.ccw-root` (§4.1) | WY §9.1; RP §3.1 |
| `call_support` | `launcher_pill` | RP §10 |
| `call_us` | `launcher_tab` | RP §10 |
| `queue_place`, `queue_next` | `queue_place_short`, `queue_next_short` | RP §10 |
| `open_call` | `restore_call` | RP §10 |
| `unmute_short` | `unmute` (value «صدا») | WY §10 |
| `channel_video`, `channel_callback` | `video`, `callback` (with new `channel_voice`) | WY §10 |
| `voice_card_sub`, `video_card_sub` | `voice_tile_sub`, `video_tile_sub` | RP §10 |
| `callback_card_sub` | `callback_intro` (value changes) | RP §10 |
| `consent_text` | `consent_required` (value changes) | WY §10 |
| `permission_hint_video` | `permission_note` | RP §10 |
| `call_context` | composition `voice_call` / `video_call` + « · » / " · " + department name | RP §10 |
| `mute_ringing` | `mute_sound` (fa value changes) | WY §10 |
| `you_label` | `you` | RP §10 |
| `rec_short` | `recording_short` | RP §10 |
| `connection_good` | `quality_good` | RP §10 |
| `stay_on_line` | `transfer_hold` | RP §10 |
| `try_again` | `retry` | RP §10 |
| `rating_label` | `rating` | RP §10 |
| `callback_summary` | composition (§5.6 decision 4) | RP §10 |
| `when_at` | `at_time` | RP §10 |

### 6.2 Superseded uses of names that stay valid

| Superseded use | Canonical | Was in |
|---|---|---|
| `asap` as the step-1 segment label | `asap_option`; `asap` stays for `{when}` | WY §10 |
| `video_call` / `phone_callback` for the summary-chip channel | `phone` / `video` (§5.6 decision 4) | WY §10 |
| `channels` as the home badge text | parts `channel_voice`, `video`, `callback` (only enabled channels) | RP §10 |
| `callbackBooking` shaped `{scheduled_for, channel}` | `{callbackId, scheduled_for, channel}` | RP §9 |
| renderer sub-state `step` | `ui.callbackStep` | RP §5.17 |
| "Minimise" as the English label | "Minimize" (`minimize`) | brief §11 |
