# Production map: WebYar / RESPOK website call-center widget

> **Scope note for this handoff.** This file describes the call-center widget that is in production today (voice and video calls plus callback requests), read from the source in the design package (`source/public/call-widget/*`, `source/shared/widgetTemplates.ts`). Line references such as `PD:430` point into those files. The chat widget has its own map; it is mentioned here only where the two widgets share something (fonts, editions) or could collide.

Static read of the shipped source. Nothing was executed. The purpose is to let an implementation handoff map new designs onto the exact production markup, states, controller calls, hooks and classes.

## 0. Legend and evidence rules

| Alias | File (under `source/`) |
|---|---|
| `PD` | `public/call-widget/presentation-default.js` (renderer, 811 lines) |
| `RT` | `public/call-widget/runtime.js` (call engine, states, I18N, 1615 lines) |
| `RCSS` | `public/call-widget/runtime.css` (tokens + all structural CSS, 287 lines) |
| `FA` | `public/call-widget/presentation-default.css` (default / Iranian skin, 26 lines) |
| `INTL` | `public/call-widget/presentation-intl.css` (international / RESPOK skin, 49 lines) |
| `LD` | `public/call-widget/l.js` (embed loader, 164 lines) |
| `REG` | `public/call-widget/presentation-registry.js` (36 lines) |
| `WT` | `shared/widgetTemplates.ts` (166 lines) |
| `FONTS` | `public/widget/presentation-default-fonts.css` (27 lines, data-URL fonts shared with the chat widget) |
| `README` | the package `README.md` (owner's brief) |
| `[snap]` | seen in the live-DOM captures `snapshots/*.html` |
| `[shot]` | seen in `screens/*.png` |
| `[inf]` | my inference, stated as such |

**How to read the snapshots.** Every snapshot name is `<locale>-<NN>-<state>.html`. The `fa-*` captures use the `default` template (`ccw-presentation-default`), and the `en-*` captures use the `intl` template (`ccw-presentation-intl ccw-presentation-default`) `[snap]`. I parsed all 50 snapshots into DOM trees and compared each `fa`/`en` pair. Apart from text, the markup is **identical**, except for two things: the root classes, and the footer link (`href="#"` in fa vs `target="_blank" rel="noopener noreferrer"` in en).

**Capture artefacts (not production markup):**
- The video snapshots (`*-12`, `*-25`) contain `<img src="https://demo-shop.test/media/remote.svg" data-track-sid="TR_remote" style="width:100%;height:100%;…">` and an `<img>` inside `.ccw-local-pip`. Production appends LiveKit `<video>`/`<audio>` elements there (PD:452-466). These `<img>` placeholders escape every `.ccw-media video` rule (RCSS:237-238, 243), so the screenshots show a much taller remote picture than production would `[inf]` (see Appendix A1).
- Inputs carry an empty `style=""` that the renderer never sets.
- The error strings in `*-05` ("برای ادامه، رضایت ضبط تماس را تأیید کنید" / "Please accept call recording to continue") are **not** in RT's I18N. The real strings are `err_recording_required` (RT:823) or `err_recording_accept` (RT:850).
- `*-21` shows a server message ("در حال حاضر اپراتوری در دسترس نیست" / "No operator is available right now") inside `error_prefix`.

**The engine never queries the DOM.** RT has no `querySelector`, `getElementById`, `classList` or `dataset` call at all. Every listener is attached by PD directly on the element it creates (`el(tag, {on:{…}})`, PD:79). There is **no event delegation and no `data-*` action hook**. This is the biggest difference from the chat widget.

---

## 1. Architecture

### 1.1 Embed loader (`LD`)

- **Embed snippet** (LD:3-8): `<script async src="https://<origin>/call-widget/l.js" workspace-id="WS_ID">`, or `public-key="cck_…"` instead of `workspace-id`.
- **Script attributes** (LD:38-45):

  | Attribute | Alias | Use |
  |---|---|---|
  | `workspace-id` | `data-workspace-id` | bootstrap query `workspaceId=` |
  | `public-key` | `data-public-key` | bootstrap query `publicKey=` (used when there is no workspace id) |
  | `api-base` | — (no `data-` form) | API origin; defaults to the script's own origin (LD:45) |

  If neither id is present the loader stops silently; the warning is logged only in debug mode (LD:40-43).
- **Globals and guards:**
  - `window.__CC_WIDGET_LOADED__` is a singleton guard (LD:12-13).
  - Debug mode is `window.__gs_debug === true` or `localStorage['gs:debug']==='1'`, the same convention as the chat widget (LD:27-36).
  - `window.CallWidgetPresentations` is the registry (REG:20).
  - `window.CallCenterWidget` is the engine instance (RT:1614), guarded by `__mounted__` (RT:7, 675).
  - `window.LivekitClient` or `window.LiveKit` is the media SDK (LD:143; RT:1094).
- **Boot sequence:**
  1. `GET {apiBase}/api/call-widget/bootstrap?workspaceId|publicKey` with `credentials:'include'`. The header `x-cc-active-call` is sent when sessionStorage holds an active call (LD:46-59).
  2. `status:'disabled'` → silent exit. Any other non-ok result → debug warning and exit (LD:62-66).
  3. A cache-bust suffix `?v=<assets_version|session|now>&t=<now>` is added to every asset (LD:72-78).
  4. **Into the host `document.head`**: `runtime.css` (LD:80-83) and the presentation stylesheet (`assets.presentation_style_url` if it matches `^/call-widget/[a-z0-9.-]+$`, else `presentation-default.css`) (LD:85-97). The renderer loads the same two files again **inside** the shadow root (§1.2).
  5. **Into `document.body`**, chained: registry script → renderer script (`assets.presentation_script_url`, else `presentation-default.js`) → `runtime.js` (LD:102-138). On load it calls `CallCenterWidget.mount({apiBase, origin, assetsVersion, runtimeAssetSuffix, activeSessionKey, pageTitle: document.title, bootstrap, loadLiveKitSdk})` (LD:111-126).
  6. The LiveKit SDK loads lazily, only when a call needs media: `<script data-cc-livekit-sdk="1" src="{origin}/call-widget/vendor/livekit-client.umd.min.js">` in `document.head`, with concurrent requests shared (LD:140-157; RT:1095-1111).
- **Public API: none.** There is no command queue like the chat widget's `__gs.push`. `window.CallCenterWidget` exposes the controller itself (`toggleOpen`, `startCall`, `reset`, …), but that is undocumented `[inf]`.
- **Storage keys:**
  - sessionStorage `ccw_active_call_session:<workspaceId|publicKey|default>:<apiBase>` (LD:46; RT:732-740);
  - sessionStorage `ccw_ringback_muted` (`'1'`/`'0'`, RT:180, 522);
  - localStorage `ccw_locale` (RT:574, 656, 665).
- **API endpoints** (all under `{apiBase}/api/call-widget/`, via `api()` RT:742-761, `credentials:'include'`, headers `x-cc-session` and `x-cc-active-call`). In preview mode `api()` always returns `409 preview_mode` (RT:744-746).

  | Endpoint | Caller |
  |---|---|
  | `POST calls/request` | `submitCall`, RT:829 |
  | `GET calls/:id/status` | `pollOnce`, every 5 s, RT:978, 986 |
  | `POST calls/:id/join-token` | RT:1063 |
  | `POST calls/:id/cancel` | RT:1419 |
  | `POST calls/:id/rate` | RT:962 |
  | `POST callbacks/request` | RT:1506 |

### 1.2 Mounting (Shadow DOM)

`createHost` (PD:745-774) is called by `RT.mount` (RT:702-707):

```
document.body
  div#call-center-widget-host  style="all:initial"                                     PD:746-749
    #shadow-root(open)                                                                  PD:750
      link[rel=stylesheet] → {origin}/call-widget/runtime.css{suffix}                   PD:751-754
      link[rel=stylesheet] → {origin}{assets.presentation_style_url | /call-widget/presentation-default.css}{suffix}   PD:755-761
      div.ccw-root.ccw-presentation-default[.ccw-presentation-intl][.ccw-is-open]
           data-radius data-density lang dir  style="--ccw-…: H S% L%" (widget_theme)     PD:770-772, 776, 803, 55-65, 156-158
        div.ccw-launcher-wrap.<right|left>        ← built once, contents replaced every render   PD:142-148, 197-198
        div.ccw-panel[.<right|left>]              ← built once, contents replaced every render   PD:254-255
document.head
  link#gs-presentation-fonts → assets.font_style_url   (only if given and not already present; the id is shared with the chat widget)   PD:762-769
```

- The root class order is `ccw-root ccw-presentation-intl ccw-presentation-default` in intl, because the intl `mount` adds its class and then calls the default `mount` (PD:802-804) `[snap en-*]`.
- `.ccw-panel` has no position class until the first open (PD:200 returns before PD:254) `[snap fa-01, fa-22]`.
- **Render cycle.** `RT.render()` (RT:1557-1582) builds a `context` and calls `presentation.mount` once, then `presentation.update` on every later render. Both of those run `applyTheme` and then `renderWidget.call(controller)`. `renderWidget` rebuilds **all** launcher and panel children with `replaceChildren` (PD:198, 255). Only the two outer containers persist; the PD:136-141 comment explains this is so that the open/close transitions can play.

### 1.3 Engine ↔ renderer contract (what is actually used)

- **Registry contract** (REG:12-18): `contractVersion === 1`, plus `createHost`, `mount`, `update` and `destroy` functions. `resolve(id)` falls back to `default` (REG:28-30). PD registers `default` (PD:794) and `intl` (PD:799-810).
- **Context** passed to `mount`/`update` (RT:1561-1575):
  - `{contractVersion, root, theme, viewModel, intents, controller, audio}`;
  - `audio` is a frozen facade: `{isActive, isMuted, needsGesture, setMuted, startFromGesture}` over the `Ringback` singleton (RT:1568-1574).
- **What PD really consumes:** `context.root`, `context.theme`, `context.audio` (stored in the module-level `activeAudio`, PD:72, 778, 784) and **`context.controller`**. `renderWidget` runs with `this = controller` (PD:779, 785).
- **`viewModel` and `intents` are built but never read by PD.** `getPresentationViewModel` is at RT:1584-1599 and `getPresentationIntents` at RT:1601-1612.
  - PD reads controller fields directly, including private ones (`_attachedTracks`, `_localVideoEl`), and **writes** some (`formData.*`, `ratingValue`, `ratingComment`, `_remoteHolder`).
  - PD calls controller methods that are not in `intents`: `toggleMic`, `toggleCam`, `submitCall`, `submitCallback`, `submitRating`, `skipRating`, `render`. The full list is in §5.
- `destroy`, `ready` and `prepare` exist (PD:787-791) but RT never calls them.

### 1.4 How the template and skin are chosen

- **Server side** (WT:122-143):
  - `default` = `presentation-default.js` + `presentation-default.css`;
  - `intl` = the **same script** + `presentation-intl.css`.
  - Iran edition offers `['default']`; International offers `['intl']`. An unknown edition (null) is treated as Iran. The stored `call_center_settings.widget_template_id` is honoured only if the edition offers it.
- **Client side:**
  - the presentation object comes from `registry.resolve(bootstrap.config.widget_template_id)` (RT:698-701);
  - the stylesheet comes from `bootstrap.assets.presentation_style_url` (PD:755-757; LD:93-96);
  - so the server must send both consistently `[inf]`.
- **Stylesheet loading.** Unlike the chat widget, the intl skin is **not** layered over the default CSS. INTL is loaded *instead of* FA (INTL:2-4; WT:118 "loaded on its own, next to runtime.css") `[snap en-*: only runtime.css + presentation-intl.css]`. Load order inside the shadow root: RCSS, then FA **or** INTL.
- **Shared classes.** The intl root carries both `ccw-presentation-intl` and `ccw-presentation-default`. FA guards its powered-by rules with `:not(.ccw-presentation-intl)` (FA:24-26). That guard only matters if FA were ever loaded alongside INTL.

### 1.5 Locale and direction

- **Supported locales:** `en`, `fa`, `tr` (RT:28). `LOCALE_META` is defined twice: RT:29-33 (`label`, `short`, `dir`) and PD:67-71 (`short`, `dir`).
- **Initial locale** (`initLocale`, RT:660-672):
  - the available list is `bootstrap.i18n.available_locales`, normalised to 2-letter codes, defaulting to `['en']`;
  - the pick order is stored `ccw_locale` → `bootstrap.i18n.default_locale` → `navigator.languages[0]` → the first available.
- **`setLocale(code)`** (RT:652-658) ignores codes outside the available list, persists to localStorage, and re-renders.
- **Direction.** On every render PD writes `lang=<locale>` and `dir=<rtl for fa, else ltr>` on `.ccw-root` (PD:156-157). There is no per-view `dir`.
- **RTL CSS.**
  - `.ccw-root[dir="rtl"]{direction:rtl;text-align:right}` (RCSS:23).
  - The launcher wrap is **forced `direction:ltr`** (RCSS:29). In both directions the round button is therefore on the left and the pill label on the right. With the default right position, the label sits at the viewport edge and the button sits inward `[shot fa-01, en-01]`.
  - In RTL the label text is right-aligned via `align-items:flex-end` (RCSS:63).
- **Logical vs physical properties.**
  - Logical: `margin-inline-start` (lang, close: RCSS:99, 105), `inset-inline-start/end` (PiP, video info: RCSS:240, 245), `text-align:start` (summary card: RCSS:257).
  - Physical: launcher and panel anchoring (`right`/`left`, RCSS:28, 32, 72, 79), `transform-origin`, and the honeypot's `left:-10000px` (PD:688).
- **Not direction-aware:**
  - email and phone inputs have no `dir="ltr"`, unlike the chat widget, so in fa they are typed right-aligned `[inf]`;
  - `.ccw-summary-val.ccw-mono` is forced `direction:ltr` (RCSS:261).

### 1.6 Fonts

- **Families.**
  - RCSS:19 sets `'IRANSans','InterWY',-apple-system,…` on `:host, .ccw-root`.
  - RCSS:24 forces `'IRANSans','InterWY',Tahoma,…` on `.ccw-root[lang="fa"]` **and all descendants**.
  - INTL:34 puts `'InterWY','IRANSans',…` first on the intl root.
- **Faces.**
  - FA:7-11 and INTL:13-17 declare `@font-face` with `url('../widget/fonts/*.woff2')`: IRANSans 400, 500, and 600+700 (both the same Bold file), plus **InterWY 500 only**.
  - FONTS:23-27 holds the same faces as data URLs. It is added to `document.head` only when `bootstrap.assets.font_style_url` is set (PD:762-769). The snapshots link it at document level `[snap]`.
- `[inf]` Because LD also puts FA/INTL into `document.head` (LD:91-97), the `@font-face` rules are registered at document level even in browsers that ignore `@font-face` inside shadow roots.
- `[inf]` Latin 600-weight text (titles, buttons, launcher text) has only an Inter 500 face, so it is synthesised bold.
- `--gs-presentation-font` (FONTS:16-21) is not read by the call widget.

### 1.7 Config and bootstrap fields that affect look or layout

| Field | Read at | Default | Effect |
|---|---|---|---|
| `config.widget_theme.{primary,accent,surface,text,muted,danger}` | RT:1560 → PD:55-62 | none | inline `--ccw-*` HSL channels (§7); only `#rrggbb` is accepted |
| `config.widget_theme.radius` | PD:63 | `md` | `data-radius="sm\|md\|lg"` on the root |
| `config.widget_theme.density` | PD:64 | `comfortable` | `data-density="compact\|comfortable"` |
| `config.widget_position` | RT:727-730 | `right` | `'left'` → `left` class on wrap and panel; any other value → `right` |
| `config.avatar_url` | PD:179-183, 204 | none | the "logo": a launcher face image and the header avatar image. Fallback: phone glyph on a primary gradient / primary circle |
| `config.display_name` | PD:207 | `t('support')` | header title |
| `config.offline_behavior` | PD:161, 287 | `'show_callback'` | `'hide'`: launcher **and** panel `hidden` while `state==='offline'` (PD:165-168). `'show_callback'`: offline launcher "Callback / Leave details" + Request-callback button. **Any other value** (README's "show a message only"): launcher "Support / Offline", offline panel without a button (PD:172-176, 299-301) |
| `config.custom_texts[locale][key]` | RT:580-585, 632-633 | none | overrides any I18N key (§8) |
| `config.widget_template_id` | RT:699 | `default` | presentation choice (§1.4) |
| `config.pre_call_form_enabled` | RT:790, 909 | falsy | whether the pre-call form is required (§4.4) |
| `config.pre_call_form_schema[]` | PD:639; RT:908 | `[]` | custom pre-call fields `{id,label,type,required,placeholder,options[]}` |
| `bootstrap.capabilities.{voice,video,callback,operator_video_visible}` | PD:159, 315-318; RT:723-725, 1153-1154 | — | **"online" = `voice \|\| video`** (RT:722-725); which buttons show; whether the operator's camera is attached |
| `bootstrap.callback_policy.{show_when_online,require_contact,honeypot_enabled,min_message_length,cooldown_seconds}` | PD:306-307, 600, 644-645, 681, 685, 694; RT:1470-1495, 1548-1551 | — | ghost callback button, required labels and note, honeypot, message label, validation |
| `bootstrap.queue_experience.{show_position,show_eta,offer_callback_after_seconds,ringback_*}` | PD:331, 374, 378, 384; RT:326-328, 463-496 | position and ETA shown | queue chips, offer card, hold audio |
| `bootstrap.recording.{effective_enabled,consent_required}` | PD:446-447, 722-733; RT:781-783 | — | consent checkbox / passive note / in-call recording note |
| `bootstrap.departments.{voice,video,callback}[] {id,name}` | PD:615-627; RT:778-780, 1457-1459 | — | department select; auto-selected when exactly one |
| `bootstrap.visitor.contact {id,name,email,phone}` | RT:690-696 | — | returning visitor: prefill + "contact saved" card |
| `bootstrap.i18n.{available_locales,default_locale}` | RT:661-667 | `['en']` | locale and language switcher |
| `bootstrap.edition`, `powered_by {brand,brands{},logo,url}`, `powered_by_logo` | RT:602-650 | — | footer credit (§4.11) |
| `bootstrap.active_call` | RT:1369-1408 | — | resume a queue or call after reload, **auto-opening the panel** (RT:1383) |

**Not configurable:**
- launcher size (52px) and offsets (20px; 14px at ≤480px);
- panel size;
- z-index;
- fonts;
- launcher texts. There are no dedicated fields: the texts are I18N keys `talk_now`, `live_support`, `callback`, `leave_details`, `support`, `offline`, so they can only be changed through `custom_texts`.

### 1.8 How hex becomes HSL channels

`hexToHslChannels` (PD:37-53) accepts only `/^#[0-9a-f]{6}$/i`. Shorthand `#abc`, `rgb()` and alpha are silently ignored. It returns `"H S% L%"` with **integers** (`Math.round`). `applyTheme` (PD:55-65):
- writes `root.style.setProperty(token, value)` for each `THEME_KEYS` entry (PD:28-35);
- writes `surface` to **both** `--ccw-surface` and `--ccw-panel` (PD:61-62);
- sets `root.dataset.radius` and `root.dataset.density`.

These inline values beat the skin's token rules. Properties are only ever set, never removed. `[inf]` The defaults are exactly `#1F93FF` → `209 100% 56%` (fa) and `#FF5A3C` → `9 100% 62%` (intl).

---

## 2. Launcher

### 2.1 Markup (PD:170-198), rebuilt on every render

```
div.ccw-launcher-wrap.<right|left>[hidden]             hidden only when offline + offline_behavior 'hide'   PD:166, 197
  button.ccw-launcher-btn[aria-label=<launcher text>]  click → controller.toggleOpen()                       PD:186-190
    span.ccw-launcher-face                                                                                  PD:178
      span.ccw-launcher-logo > img[src=config.avatar_url][alt=""]                                           PD:179-180
        or span.ccw-launcher-logo.ccw-launcher-logo-fallback > svg(phone, 20)                               PD:181-182
      span.ccw-launcher-icon > svg(phone, 20)                  ← the "flip" layer                           PD:184
  div.ccw-launcher-label                                                                                    PD:192-195
    span.ccw-launcher-text   span.ccw-launcher-sub
```

### 2.2 States and texts

| Condition | `.ccw-launcher-text` (= `aria-label`) | `.ccw-launcher-sub` | Snapshot |
|---|---|---|---|
| online (`caps.voice \|\| caps.video`) | `talk_now` "Talk now" / "همین حالا تماس بگیرید" | `live_support` "Live support" / "پشتیبانی آنلاین" | `*-01`, `*-22` `[snap]` |
| offline + `show_callback` | `callback` "Callback" / "درخواست تماس" | `leave_details` "Leave details" / "ثبت اطلاعات" | `*-02` `[snap]` |
| offline + any other value except `hide` | `support` "Support" / "پشتیبانی" | `offline` "Offline" / "آفلاین" | not captured |
| offline + `hide` | wrap and panel `hidden` | — | not captured |

- The launcher text depends only on online/offline. **It does not reflect the queue or an active call**, so a collapsed panel during a call still says "Talk now".
- There is no offline colour treatment: the button looks the same in both states `[shot fa-02]`.
- **ARIA:** only `aria-label`. There is no `aria-expanded`, `aria-haspopup` or `aria-controls`, and the label does not change when the panel is open.

### 2.3 Look and motion (RCSS)

- **Wrap** (RCSS:27-33):
  - `position:fixed; bottom:20px; right:20px` (`.left` → `left:20px; right:auto`);
  - `z-index:2147483000`; flex row with `gap:10px`; `direction:ltr`;
  - transition: transform .38s `cubic-bezier(.4,0,.2,1)`, opacity .28s.
  - Open (`.ccw-is-open` on root): `translateY(90px)`, `opacity:0`, `pointer-events:none`.
- **Button** (RCSS:35-42):
  - 52×52, `border-radius:999px`, white background under the face, `overflow:hidden`;
  - shadow `0 10px 26px hsl(var(--ccw-primary)/.35)`;
  - hover `translateY(-2px) scale(1.05)`; active `scale(.96)`; transition .3s `cubic-bezier(.34,1.56,.64,1)`.
- **Faces** (RCSS:43-55):
  - the logo layer is a circular `img` with `object-fit:cover`;
  - the fallback and icon layers are both `linear-gradient(155deg, primary, primary/.85)` with a white glyph.
  - **Hover flip:** `.ccw-launcher-icon` goes from `clip-path:circle(0%)` to `circle(75%)` over .55s `cubic-bezier(.22,1,.36,1)`. `[inf]` Without `avatar_url` both layers are the same phone glyph on the same gradient, so the flip is invisible. It only shows with a real logo.
- **Label** (RCSS:57-65):
  - height 48, padding `0 16px`, radius `.9rem`, white, shadow `0 8px 20px hsl(0 0% 0%/.12)`, `nowrap`;
  - text 13px/600 ink; sub 11px muted;
  - entrance `ccw-label-in .5s cubic-bezier(.34,1.56,.64,1) .15s both` (keyframes RCSS:275).
  - `[inf]` The label node is recreated on every render, so this entrance animation replays every second while a queue or call timer runs with the panel collapsed (§4.0).
- **Mobile ≤480px** (RCSS:278-279): offsets become 14px. The size is unchanged `[shot fa-22]`.
- **Reduced motion** (RCSS:285-287): all animations and transitions in `.ccw-root` are turned off.
- **Not supported:** a badge, unread count, pulse, scale or shape options.

---

## 3. Panel frame

| Aspect | Value | Source |
|---|---|---|
| Element | `div.ccw-panel.<right\|left>`, a sibling of the launcher wrap inside `.ccw-root`; children `header + body + footer` | PD:145, 254-255 |
| Size | **368 × 508 px** fixed; `max-width: calc(100vw - 24px)`; `max-height: calc(100vh - 130px)` | RCSS:73. The widget crops (832×1112 @2x = 416×556 with a 24px margin) agree `[shot]` |
| Anchor | `position:fixed; bottom:20px; right:20px` (or `left:20px`), the **same point as the launcher wrap**, so the panel covers the launcher spot | RCSS:68-72, 79 |
| Look | `background: hsl(var(--ccw-surface))`; shadow `0 25px 50px -12px hsl(0 0% 0%/.25)`; `overflow:hidden`; flex column; radius from the skin: `var(--ccw-radius-panel)`, 18px fa / 16px intl at `md` | RCSS:74-76; FA:18; INTL:42 |
| Closed | `transform: scale(.82) translateY(24px); opacity:0; pointer-events:none`, but **still rendered**: no `visibility`, `inert` or `aria-hidden`. `[inf]` After the first open it keeps its last content, which stays in the tab order and the accessibility tree while invisible | RCSS:80; PD:200 |
| Open | `.ccw-is-open .ccw-panel { transform: scale(1) translateY(0); opacity:1; pointer-events:auto }`; `transform-origin: bottom right` (or `bottom left`) | RCSS:77, 79, 81 |
| Transition | `transform .38s cubic-bezier(.32,.9,.35,1), opacity .28s ease` | RCSS:77 |
| Open/close control | launcher click **and** the header chevron both call `toggleOpen()`, which flips `open` and re-renders (RT:763-769). There is no Escape key, outside click, focus move or focus trap. Closing does **not** end a call or leave the queue | PD:189, 214 |
| Auto-open | `resumeActiveCall` sets `open = true` (RT:1383) | |
| z-index | wrap and panel both `2147483000`; the panel is later in the DOM, so it stacks above. Inside: `.ccw-ring-core` 1, `.ccw-local-pip` 3, `.ccw-video-info` 4 | RCSS:28, 72, 203, 241, 245 |

- **Header** (PD:202-215; RCSS:83-107):
  - padding `14px 16px`, a 1px bottom border, background surface;
  - avatar `2.5rem` primary circle with a white phone glyph (17px) or `img`;
  - title 14.5px/600 with ellipsis; sub 11.5px muted with a 7px status dot;
  - close: a transparent 16px chevron-down in `--ccw-faint`.
  - The panel itself has no `role="dialog"` or `aria-label`.
- **Body** (PD:217-218; RCSS:109-112): `div.ccw-body.ccw-scroll`, `flex:1; overflow-y:auto; padding:14px 16px; font-size:13px`, with a 6px scrollbar thumb in `--ccw-border` and `scrollbar-gutter:stable`. All states scroll inside it; nothing is pinned.
- **Footer** (PD:248-252; RCSS:114-118): `div.ccw-footer`, `padding: 8px 0 12px`, centred; `a.ccw-powered` 11px faint. Variants are in §4.11.
- **Mobile (`max-width:480px`, RCSS:277-284):**
  - the panel becomes `left:10px; right:10px; bottom:14px; width:auto`, with the height **still 508px** and `max-height: calc(100vh - 108px)`;
  - `.ccw-row` switches to `flex-direction:column`, so all paired buttons stack;
  - `.ccw-title` gets `max-width: calc(100vw - 158px)`.
  - Measured on a 390-wide viewport: **370×508 floating card, 14px above the bottom edge** `[shot fa-23, fa-24, fa-25]`.
  - There is no full screen, no `dvh` or visualViewport handling, no safe-area insets and no host scroll lock (compare the chat widget's 640px breakpoint and full-screen sheet).
- **Units.** `rem` values (`.ccw-avatar 2.5rem`, the button, input, segment and error radius `.5rem`, the label radius `.9rem`, …) resolve against the **host page's** `<html>` font-size, because shadow DOM does not isolate `rem` `[inf]`.
- **Cross-widget `[inf]`:** the chat widget's shell is fixed at `bottom:24px; right:24px` (z 2147483646). If both widgets are embedded on one page, their launchers overlap in the same corner.

---

## 4. States

### 4.0 Render cadence and state machine

- **Who re-renders.**
  - `renderWidget` rebuilds every launcher and panel child on each `render()`. While the panel is closed it rebuilds only the launcher (PD:200).
  - Renders are triggered by:
    - a 1 s queue timer (RT:921-939);
    - a 1 s in-call timer (RT:947-953);
    - the 5 s status poll (RT:975-1059);
    - every media event (RT:1130-1200);
    - segmented-control clicks (PD:613, 704, 718);
    - the sound toggle (PD:363).
- **Consequences for a re-skin `[inf]`:**
  - CSS entrance animations on panel content replay on each render.
  - The ring animation (1.8s) is restarted every second, so it never completes a cycle in the queue or in a call.
  - Keyboard focus inside the panel is lost every second in the queue and in a call.
  - `<video>`/`<audio>` nodes are re-parented every second (§6.1).
- **Transitions:**

| From | Trigger | To | Source |
|---|---|---|---|
| — | constructor | `loading` (never painted at boot) | RT:538 |
| boot | `bootstrap.status !== 'ok'` | `offline` (unreachable through LD, which exits first `[inf]`) | RT:710-712 |
| boot | `isOnline()` | `online_available` / `offline` | RT:716 |
| boot | `bootstrap.active_call` in state `active\|ringing\|connecting` / other | `in_call` / `queue_waiting` (+ panel opened) | RT:1383-1397 |
| `online_available` | Voice/Video, and a form is needed (`pre_call_form_enabled && !identified`, consent required, passive recording notice, or >1 department) | `pre_call_form` | RT:771-795 |
| `online_available` / `pre_call_form` | `submitCall` passes validation | `loading` | RT:827-828 |
| `pre_call_form` (or the current state) | client validation fails | unchanged, with `error` set | RT:814-825 |
| `loading` | `recording_consent_required` / `department_*` | `pre_call_form` + error | RT:849-856 |
| `loading` | other API error / network error | `error` | RT:857-858, 899-903 |
| `loading` | ok, `call_state ∈ active,ringing,connecting` | `in_call` | RT:874-881 |
| `loading` | ok, otherwise | `queue_waiting` | RT:882-898 |
| `queue_waiting` | poll `call.state ∈ active,ringing,connecting` | `in_call` | RT:1040-1046 |
| `queue_waiting` / `in_call` | poll `call.state ∈ cancelled,ended,missed,failed` | `ended` | RT:1032-1039 |
| `queue_waiting` / `in_call` | Cancel/End → `cancelCall`, then the API resolves; `endedDuration>0` → `ended`, else `reset` | `ended` / home | RT:1410-1431 |
| `online_available` / `offline` / `queue_waiting` (offer card) | `openCallback` | `callback_form` | RT:1456-1465 |
| `callback_form` | `submitCallback` ok | `ended` (callback-confirmed view) | RT:1547-1553 |
| any | `reset` (Back, Done, Skip, cancel without a connected call) | `online_available` / `offline` | RT:1433-1454 |

### 4.1 `loading` (PD:289-290). Snapshots `*-07-connecting` `[snap]`

```
div.ccw-loading > div.ccw-spinner + div.ccw-muted("loading": "Loading…" / "در حال بارگذاری…")
```

- This is shown only while `POST calls/request` is in flight (RT:828).
- README's "connecting / spinner while the call request is sent" is this state, and its text is "Loading…", not "connecting".
- CSS: `min-height:170px`, centred; 26px spinner with a 3px border-top in primary, spinning at .85s (RCSS:177-179).

### 4.2 `online_available` (PD:305-322). Snapshots `*-03-home-online`, `*-23-mobile-home` `[snap]`

```
div.ccw-stack
  div.ccw-hero-copy > h2.ccw-hero-title("talk_to_team") + p.ccw-hero-sub("online_copy")
  div.ccw-row
    [button.ccw-btn.primary > svg(phone,15) + "voice_call"]      caps.voice → controller.startCall('voice')   PD:315
    [button.ccw-btn.secondary > svg(video,15) + "video_call"]    caps.video → controller.startCall('video')   PD:316
  [button.ccw-btn.ghost("request_callback_instead")]             caps.callback && callback_policy.show_when_online !== false → openCallback()   PD:318-320
```

### 4.3 `offline` (PD:292-303). Snapshot `*-20-offline-home` `[snap]`

```
div.ccw-stack
  div.ccw-hero-copy > h2.ccw-hero-title("leave_callback_request") + p.ccw-hero-sub("offline_copy")
  [button.ccw-btn.primary("request_callback")]     offline_behavior === 'show_callback' && caps.callback → openCallback()
```

- Header sub: `span.ccw-status-dot.offline` + `callback_desk` ("Callback desk" / "میز درخواست تماس") `[snap fa-20]`.
- `[inf]` With `show_callback` but `caps.callback` false, the launcher still promises "Callback" while the panel has no button.

### 4.4 `pre_call_form` and 4.8 `callback_form`: one renderer, `renderForm(cfg, forCall)` (PD:597-741)

```
form.ccw-stack                                                  submit → preventDefault; forCall ? submitCall() : submitCallback()   PD:601-604
  [cb] p.ccw-form-intro("callback_intro")                                                       PD:605-607
  [cb] label.ccw-label("callback_type") + div.ccw-segment > button.ccw-seg-btn[.active][type=button] × ("phone"=audio, ["video"] if caps.video)   PD:608-614
  [departments for this channel non-empty]
       label.ccw-label("department") + select.ccw-input > option[value=""]("choose_department") + option[value=<id>](name)…   PD:615-627
  [identified contact] div.ccw-known-contact > span.ccw-known-dot("✓") + div > div.ccw-known-title(name) + div.ccw-muted("contact_saved")   PD:628-638
  per field: label.ccw-label(<label>[" *"])  +  one of                                          PD:651-680
       input.ccw-input[type=text|email|tel|…][value][placeholder]
       textarea.ccw-textarea[placeholder]            (schema type 'textarea')
       select.ccw-input > option[value=""](placeholder or "—") + options     (schema type 'select')
       input[type=checkbox]                 (schema type 'checkbox'; no class, no wrapping label)
  [cb && require_contact && !identified] div.ccw-note("contact_required_note")                  PD:681-683
  [cb && honeypot_enabled !== false] input[type=text][name=company_website][autocomplete=off][tabindex=-1][aria-hidden=true][style="position:absolute;left:-10000px;…"]   PD:685-693
  [cb] label.ccw-label("message_min" {n} | "message_optional") + textarea.ccw-textarea[placeholder="message_placeholder"]   PD:694-698
  [cb] label.ccw-label("when_call") + div.ccw-segment("⚡ " + "asap" = now | "schedule" = later)   PD:700-705
  [cb && later] input.ccw-input[type=datetime-local][min=<now+5 min, local>]                   PD:706-713
  [cb] label.ccw-label("priority") + div.ccw-segment("normal" | "🔥 " + "urgent"; adds .danger when active)   PD:714-719
  [call && recording.effective_enabled && consent_required] label.ccw-checkbox > input[type=checkbox] + text("consent_required")   PD:723-730
  [call && recording.effective_enabled && !consent_required] div.ccw-muted("call_may_record")   PD:731-733
  [controller.error] div.ccw-error(error)                                                     PD:735
  div.ccw-row > button.ccw-btn.secondary[type=button]("back" → reset()) + button.ccw-btn.primary[type=submit]("start_call" | "send_request")   PD:736-739
```

- **Field list** (PD:639-650):
  - pre-call uses `config.pre_call_form_schema` when it is non-empty; with an identified contact, `name`, `email` and `phone` are removed from it;
  - otherwise an identified contact gets `[subject]`;
  - otherwise the defaults are `name` (text), `email` (email), `phone` (tel), `subject` (text);
  - in the callback form the email and phone labels become `email_required` / `phone_required` (with "*") when `require_contact`.
  - The callback form never uses the schema.
- **Value binding:** `name|email|phone|subject` → `formData[id]`; custom fields → `formData.custom[id]`, on `input` (or `change` for checkboxes) (PD:654-678). Other bindings:

  | Control | `formData` key | Source |
  |---|---|---|
  | department | `department_id` | PD:625 |
  | channel segment | `callback_channel` = `audio\|video` | PD:613 |
  | message | `message` | PD:697 |
  | when segment | `callback_when` = `now\|later` | PD:704 |
  | date-time input | `callback_scheduled_for` | PD:711 |
  | priority segment | `callback_urgency` = `normal\|urgent` | PD:718 |
  | consent checkbox | `consent` | PD:727 |
  | honeypot | `hp_company` | PD:691 |

  Segment clicks call `self.render()`, which rebuilds the form (values survive via `formData`; focus does not).
- **Snapshots:**

  | Snapshot | What it shows |
  |---|---|
  | `*-04` | pre-call with 3 departments + consent checkbox |
  | `*-05` | filled + `.ccw-error` |
  | `*-06` | identified contact: known card + subject + consent |
  | `*-17` | callback: phone active, 2 departments, require_contact, honeypot, ASAP, Normal |
  | `*-18` | video + schedule (`datetime-local[min="2026-10-16T13:35"]`) + urgent `.active.danger` |

  All are `[snap]`. `*-17`/`*-18` show the urgent label as **"🔥 🔥 فوری" / "🔥 🔥 Urgent"**: PD:716 prefixes `🔥 ` to an I18N value that already starts with `🔥` (RT:48, 76).
- **Accessibility.** Labels are sibling elements with no `for` or `id`, so **no field is programmatically labelled** except the consent checkbox. There are also no `name`s (except the honeypot), no `autocomplete`, `aria-invalid` or `aria-describedby`, and the error has no `role="alert"`.

### 4.5 `queue_waiting` (PD:330-394). Snapshots `*-08-queue`, `*-09-queue-next-offer-callback`, `*-24-mobile-queue` `[snap]`

```
div.ccw-stack
  div.ccw-queue-block
    div.ccw-ring-avatar[style="width:64px;height:64px;"] > span.ccw-ring.r1 + span.ccw-ring.r2
        + div.ccw-ring-core.ccw-ring-core-phone[style="width:52px;height:52px;"] > svg(phone,20)        PD:338, 273-282
    span.ccw-pill.live( audio.isActive() ? "ringing_enabled" : "ringing_operator" )                     PD:335, 339
    div.ccw-queue-copy-block > h3.ccw-queue-title(position===1 ? "you_are_next" : "holding_place")
                             + p.ccw-queue-copy(position>1 ? "queue_copy_many" : "queue_copy_next")    PD:333-334, 340-343
    div.ccw-wait-row > span.ccw-muted("waiting_time") + span.ccw-wait-timer(m:ss since queueStartedAt)
        + button.ccw-sound-toggle[.muted][type=button][aria-label="mute_sound"|"unmute_sound"]("🔊" | "🔇")   PD:344-367
  [audio.needsGesture()] div.ccw-tap-hint("tap_to_hear")                                                PD:370-372
  [chips] div.ccw-chip-row > [span.ccw-chip(position===1 ? "you_next_line" : "you_queue_number" {n})]   show_position !== false && position
                           + [span.ccw-chip(mins<=1 ? "eta_under_min" : "eta_minutes" {n})]             show_eta !== false && eta>0; mins = max(1, round(eta/60))   PD:373-382
  [offer] div.ccw-offer-card > span("tired_waiting") + button.ccw-btn.secondary("request_callback")      caps.callback && offer_callback_after_seconds>0 && elapsed>=threshold   PD:384-391
  button.ccw-btn.danger("cancel_call") → cancelCall()                                                   PD:392
```

- **VM fields:**
  - `queuePosition`, from `calls/request.queue_position` and then from the poll's `position` (RT:871, 990);
  - `queueEta`, in seconds, from the poll's `eta_seconds` (RT:992);
  - `queueStartedAt`, from `created_at` or now (RT:869-870);
  - `bootstrap.queue_experience`;
  - the audio facade.
- **Sound toggle** (PD:352-364):
  - `stopPropagation`, then flip `audio.setMuted`;
  - on unmute, if `needsGesture()`, call `audio.startFromGesture(queue_experience)` inside the click;
  - then re-render.
  - The class `muted` and the 🔇 glyph show when muted **or** when a gesture is needed. The `aria-label` follows only `isMuted()`.
- **Tap hint** (`.ccw-tap-hint`) is a `div`, not a button. Sound is actually unlocked by the window-level capture listeners `pointerdown`, `touchstart` and `keydown` (RT:198-208), so any tap anywhere works. It pulses at 1.6s (RCSS:216-220). README calls it "Tap to hear the ringback"; the real text is "Tap to enable sound" / "برای شنیدن صدا کلیک کنید". It is not captured.
- **Offer card.**
  - Button: `cancelCall()` then `setTimeout(openCallback, 50)` (PD:389).
  - `[inf]` `cancelCall`'s API promise calls `reset()` when it resolves; if that takes longer than 50 ms it can overwrite the callback form with the home view.
  - RT forces one extra render when the threshold is crossed (RT:926-937).
- **Snapshot values:** `*-08` position 3, ETA ~3 min, `0:47`; `*-09` position 1 + under 1 min + offer card. The pill always says "Ringing operator" because the capture had no active audio.

### 4.6 `in_call` (PD:396-492). Snapshots `*-10` (waiting), `*-11` (voice live), `*-12`/`*-25` (video live), `*-13` (transferring), `*-14` (reconnecting) `[snap]`

**Inputs:**
- `connectStatus` (default `'connecting'`);
- `call` (the poll's `call` object: `call_type`, `recording_state`, `muted`, `state`, `started_at`, `assigned_agent_id`);
- `formData.call_type`;
- `transferring`;
- `operatorName` (poll `operator_name`);
- `callStartedAt`;
- `micOn`, `camOn`;
- `_attachedTracks`, `_localVideoEl`;
- `bootstrap.recording`;
- `error`.

```
div.ccw-stack.ccw-centered
  span.ccw-pill.live( isLive ? "in_call" : status==='waiting_for_operator' ? "connected_waiting" : "connecting" )   PD:422
  ── one of ──
  (transferring)  div.ccw-transfer > span.ccw-spinner.small + span("transferring_call")                PD:424-428
  (!hideHero)     div.ccw-call-hero                                                                    PD:429-438
                    div.ccw-ring-avatar[76] > span.ccw-ring.r1 + span.ccw-ring.r2 + div.ccw-ring-core[64] > span.ccw-ring-core-initial(<first letter, uppercased> | "؟")
                    div.ccw-call-meta > [span.ccw-call-op-name(operatorName)] + span.ccw-call-op-role("operator_label")
                                      + span.ccw-call-timer( isLive ? m:ss since callStartedAt : <status message> )
  (video && live) div.ccw-muted[style="text-align:center;"](<status message>)                          PD:439-441
  ── recording ──
  call.recording_state==='recording' → span.ccw-pill.recording("recording_progress")                   PD:443-444
  else recording.effective_enabled  → div.ccw-muted("recording_may_start")                             PD:445-448
  ── media (video calls only; see §6.1) ──
  div.ccw-media.video                                                                                  PD:450, 462-475
     <remote <video>/<audio> from _attachedTracks>[data-track-sid][data-remote-video][data-orientation-correction]
     [live && !transferring && _localVideoEl && camOn]  div.ccw-local-pip > <local video>[data-local-video][data-orientation-correction]
     [live && !transferring]  div.ccw-video-info > span.ccw-video-info-name(operatorName | "operator_label") + span.ccw-video-info-duration(m:ss)
  div.ccw-controls                                                                                     PD:477-489
     [status ∈ in_call, operator_connected, waiting_for_operator, media_reconnecting]
        div.ccw-row > button.ccw-btn.(call.muted ? primary : secondary)( micOn===false ? "unmute" : "mute" ) → toggleMic()
                    + [video] button.ccw-btn.(camOn===false ? primary : secondary)( camOn===false ? "camera_on" : "camera_off" ) → toggleCam()
     button.ccw-btn.danger.full("end") → cancelCall()
```

- `isLive = status ∈ {in_call, operator_connected}` (PD:418).
- `isVideoCall = call.call_type==='video' || formData.call_type==='video'` (PD:419).
- `hideHero = isVideoCall && isLive && !transferring` (PD:420).

**Status → message and pill** (status messages PD:398-417; RT sets `connectStatus` at the lines shown):

| `connectStatus` | Set at RT | Message key (fa) | Pill | Mic/cam row |
|---|---|---|---|---|
| null → `connecting` | 1441 (reset) | `call_accepted_connecting` (تماس پذیرفته شد، در حال اتصال…) | connecting | no |
| `pending` (join-token failed) | 1065, 1072 | *unmapped* → `call_accepted_connecting` | connecting | no |
| `token_ready` | 1069 | *unmapped* → `call_accepted_connecting` | connecting | no |
| `loading_media_client` | 1092 | `loading_media_client` | connecting | no |
| `connecting_media` | 1122 | `connecting_av` | connecting | no |
| `waiting_for_operator` | 1143, 1247 | `operator_joining` (اپراتور در حال ورود است…) | **connected_waiting** | yes `[snap *-10]` |
| `operator_connected` | 1185 | `operator_connected` | **in_call** (live) | yes |
| `in_call` | 1143, 1247 | `connected` (متصل شد) | **in_call** (live) | yes `[snap *-11, *-12]` |
| `media_reconnecting` | 1140 | `reconnecting_media` | connecting | yes `[snap *-14]` |
| `operator_left` | 1197 | `operator_left` | connecting | no |
| `media_disconnected` | 1135 | `media_disconnected` | connecting | no |
| `token_expired` | 1133, 1257 | `token_expired` | connecting | no |
| `microphone_permission_denied` | 1203 | `mic_denied` | connecting | no |
| `camera_permission_denied` | 1226 | `camera_denied` | connecting | no |
| `room_connect_failed` | 1262, 1269 | `room_failed` {error = `controller.error` or `unknown`} | connecting | no |
| `rtc_v1_unsupported` | 1259 | *unmapped* → `call_accepted_connecting` (the friendly error in `error` is never shown) | connecting | no |
| `media_client_missing` / `media_client_invalid` | 1107, 1113 / 1118 | same-named keys | connecting | no |
| `provider_client_not_configured` / `provider_client_not_supported` / `media_not_configured` | 1081-1083, 1088 | `provider_not_configured` / `provider_not_supported` / `media_not_configured` | connecting | no |
| `fallback`, `accepted_no_sdk` | **never set** | `fallback`, `accepted_no_sdk` (dead) | — | — |

- **Where the message shows:**
  - in voice calls, and in non-live video calls, it fills the **timer slot** `.ccw-call-timer` (12.5px). Long permission and error sentences therefore render there;
  - in live video it is a centred `.ccw-muted` line above the media ("Connected" / "متصل شد", README's complaint) `[snap *-12]`;
  - while transferring, no message is shown.
- **Transfer** is detected when `assigned_agent_id` changes during `in_call` (RT:997-1011). The engine clears `operatorName` and `callStartedAt`, so the timer restarts. The flag is cleared when a new `operator_name` arrives (RT:1013-1017). The pill stays "In call" `[snap *-13]`.
- **Rings** keep pulsing around the operator initial during the live call. The ring core is the primary colour and the initial is white 22px/600 (RCSS:199-205).
- **Video sizes** (RCSS:235-250):
  - `.ccw-media` is a flex column with 8px gap and `position:relative`;
  - remote `video`: `width:100%; max-height:150px` in `.video` (230px otherwise), `object-fit:cover`, background ink, radius `.75rem`, `transform:scaleX(-1)`;
  - PiP: **52×38** at `bottom:6px; inset-inline-start:6px`, radius `.4rem`;
  - info overlay: white 12px/600 text with a text-shadow, along the bottom.
- `[inf]` The mic button's colour follows `call.muted` (server field) while its label follows the local `micOn`, so the two can disagree.

### 4.7 `ended`: three variants (PD:494-573)

**(a) Callback confirmed**, whenever `controller.callbackId` is set (PD:495-511). Snapshot `*-19` `[snap]`.

```
div.ccw-stack.ccw-centered
  div.ccw-ring-avatar[52] > span.ccw-ring.r1 + span.ccw-ring.r2 + div.ccw-ring-core.ccw-ring-core-success.ccw-no-ring[52] > svg(check,20)
  h3.ccw-confirm-title("callback_scheduled")
  p.ccw-muted[style="text-align:center;"]("reach_out" {when})      when = callback_when==='later' && scheduled ? new Date(...).toLocaleString() : "asap"
  div.ccw-summary-card
    div.ccw-summary-row > span.ccw-muted("type") + span.ccw-summary-val(channel==='video' ? "video_callback" : "phone_callback")
    div.ccw-summary-row > span.ccw-muted("reference") + span.ccw-summary-val.ccw-mono(<first 8 chars of callback_id, uppercased>)
  button.ccw-btn.primary.full("done") → reset()
```

`.ccw-no-ring` hides the rings via `.ccw-ring-avatar:has(.ccw-no-ring) .ccw-ring{display:none}` (RCSS:202). `[inf]` `reset()` never clears `callbackId` (RT:1433-1454), so after one callback request every later call also ends on this view.

**(b) Call ended + rating**, when `endedCallId && !ratingSubmitted` (PD:512-565). Snapshot `*-15` `[snap]`.

```
div.ccw-stack.ccw-centered
  div.ccw-ring-avatar[44] > rings + div.ccw-ring-core.ccw-ring-core-success.ccw-no-ring[44] > svg(check,18)
  div.ccw-ended-copy > span.ccw-ended-title("call_ended") + [span.ccw-muted("call_duration" + ": " + m:ss)]   endedDuration > 0
  div.ccw-rate-block > span.ccw-rate-title("rate_call_title") + span.ccw-muted("rate_call_sub")
  div.ccw-stars > button.ccw-star[.filled][type=button][aria-label="1".."5"] > svg(star,24, fill=currentColor|none) ×5
  textarea.ccw-textarea[placeholder="rate_comment_ph"]                → controller.ratingComment (input)
  div.ccw-row > button.ccw-btn.secondary("rate_skip") → skipRating ? skipRating() : reset()
              + button.ccw-btn.primary[disabled while ratingValue===0]("rate_submit") → submitRating()
```

A star click sets `controller.ratingValue = n`. It rebuilds **only** the stars and toggles the submit button's `disabled` without a full render, so the textarea keeps focus (PD:536-544). `.ccw-star` and `.ccw-star.filled` are both primary; "filled" is drawn by the SVG `fill` attribute (PD:528; RCSS:269-270).

**(c) Thanks**, when `ratingSubmitted` (PD:566-568). Snapshot `*-16` `[snap]`.

```
… same ring + ended copy … + span.ccw-rate-title("rate_thanks") + button.ccw-btn.secondary.full("done") → reset()
```

The `else` branch (PD:569-571, `button.ccw-btn.primary.full("done")`) is shown when there is no `endedCallId`. In practice that is unreachable, because both paths into `ended` set it `[inf]`.

**Duration.** `endedDuration` is counted from `callStartedAt`. That is the server `started_at`, or else the first time the poll saw `active|ringing|connecting` (RT:1023-1031), so it can include ring time.

### 4.9 `error` (PD:575-579). Snapshot `*-21` `[snap]`

```
div.ccw-stack.ccw-centered > div.ccw-error("error_prefix" {error: controller.error | "unknown"}) + button.ccw-btn.secondary("back") → reset()
```

`error` is the server's `message || error`, raw (RT:857), or a sanitised network message (RT:901). It is not localised. An unknown state renders `div("…")` (PD:581).

### 4.10 Header sub-states

- **Status line:**
  - online → `span.ccw-status-dot.online` (`hsl(144 61% 45%)`, hard-coded) + `operators_available`;
  - offline → `.offline` (`--ccw-faint`) + `callback_desk` (PD:208-211; RCSS:95-97).
  - It follows `isOnline()` only, never the call state.
- **Language switcher** (`renderLocaleSwitcher`, PD:258-270): rendered only when `availableLocales.length > 1`, between the header copy and the chevron. Not captured.

  ```
  select.ccw-lang[aria-label="Widget language"] > option[value=en|fa|tr]("EN" | "فا" | "TR")[selected]    change → controller.setLocale(value)
  ```

  CSS: 26px high, radius 8px, 10px/700, `outline:0` (no focus ring), white (RCSS:98-102, 107). The `aria-label` is hard-coded English.
- **Logo:** `config.avatar_url` → `div.ccw-avatar > img[alt=""]`, else the phone svg (PD:203-205). Not captured with a real logo.

### 4.11 Footer ("powered by") variants (PD:220-252; RT:577-650)

| Case | Markup |
|---|---|
| Iran or unknown edition, no `powered_by_logo` | `a.ccw-powered[href="#"]` (click → `preventDefault`) > text `powered_by` with brand `وب یار` / `Web Yar` (RT:140, 604) `[snap fa-*]` |
| Iran (`edition==='iran'` exactly) + `powered_by_logo` | `a.ccw-powered[href="#"] > span.ccw-powered-label("قدرت گرفته از") + img.ccw-powered-logo[src][alt=<brand>][draggable=false]` (16px high, gap 4px, FA:25-26) |
| International + `powered_by.brand(s)` + `url` | `a.ccw-powered[href=<url>][target=_blank][rel="noopener noreferrer"]("Powered by RESPOK")` `[snap en-*]` |
| International + `powered_by.logo` | `span.ccw-powered-label("Powered by") + img.ccw-powered-logo` (14px, gap 5px, INTL:48-49). Turkish puts the logo first: `img + span("tarafından desteklenmektedir")` |
| International, no brand | `powered_by` → `''`, so `div.ccw-footer` is empty but keeps its 20px padding |
| `custom_texts.<locale>.powered_by` set | that text replaces the credit, with no logo, in any edition (RT:581-583, 632-633) |

If the logo fails to load, it is replaced by the brand name as text (PD:236-241). `.ccw-powered-label` has no CSS rule.

---

## 5. Intents and actions

**Binding.** Every action is a direct listener on the element PD creates (`el(..., {on:{click|change|input|submit}})`, PD:79, 268, 554, 625, 674, 691, 697, 711, 727). No `data-*`, `id` or delegation is involved, and RT locates nothing in the DOM.

| UI element | Event | PD line | Controller call (RT line) | Effect |
|---|---|---|---|---|
| `button.ccw-launcher-btn` | click | 189 | `toggleOpen()` (763-769) | flips `open`, re-renders |
| `button.ccw-close` (chevron) | click | 214 | `toggleOpen()` | collapses (the label says "Back") |
| `select.ccw-lang` | change | 268 | `setLocale(code)` (652-658) | locale, `dir`, persist |
| Voice call / Video call | click | 315 / 316 | `startCall('voice'\|'video')` (771-795) | primes audio, auto-selects a sole department, then routes to `pre_call_form` or straight to `submitCall` |
| "Request a callback" (online ghost, offline primary) | click | 319 / 300 | `openCallback()` (1456-1465) | resets department, honeypot and error; stamps `callbackOpenedAt`; → `callback_form` |
| Pre-call `form` | submit | 603 | `submitCall()` (797-904) | Ringback starts **inside the gesture**; validates the schema and consent; `POST calls/request` |
| Callback `form` | submit | 603 | `submitCallback()` (1467-1555) | client cooldown, contact, length and time checks; `POST callbacks/request` |
| Form "Back" | click | 737 | `reset()` (1433-1454) | → home |
| Segments (channel / when / priority) | click | 591 via 613, 704, 718 | writes `formData.*`, then `render()` | |
| Fields, select, textarea, checkbox | input / change | 554, 625, 674-678, 691, 697, 711, 727 | writes `formData.*` / `ratingComment` | no render |
| `button.ccw-sound-toggle` | click | 352-364 | `audio.setMuted(bool)`, `audio.startFromGesture(qe)`, `render()` | Ringback facade (RT:504-533) |
| Offer card "Request callback" | click | 389 | `cancelCall()` + `setTimeout(openCallback, 50)` | see §4.5 |
| "Cancel call" (queue) / "End" (in-call) | click | 392 / 488 | `cancelCall()` (1410-1431) | bumps the media generation, disconnects the room, stops Ringback, `POST cancel` → `ended` or `reset` |
| Mute / Unmute | click | 480 | `toggleMic()` (1275-1282) | `setMicrophoneEnabled(!micOn)`, no-op without a room |
| Camera off / on | click | 484 | `toggleCam()` (1283-1311) | `setCameraEnabled`; attaches or detaches `_localVideoEl` |
| Star `n` | click | 536-544 | writes `ratingValue = n` | local star rebuild |
| "Submit rating" | click | 561 | `submitRating()` (958-973) | `POST rate {rating, comment}`; `ratingSubmitted = true` even on failure |
| "Skip" | click | 563 | `skipRating` is **not defined in RT** → `reset()` | no API call |
| "Done" | click | 509, 568, 570 | `reset()` | |
| Error "Back" | click | 578 | `reset()` | |

**The formal `intents` object** (RT:1601-1612) contains `toggleOpen`, `startVoiceCall`, `startVideoCall`, `requestCallback`, `cancelCall`, `reset` and `setLocale`. **PD never uses it.** A new renderer that wanted to use only `intents` would also need:
- mic and camera toggles;
- call and callback form submission plus field setters;
- the rating value, comment, submit and skip;
- the ringback mute;
- a read-only view model that also carries:
  - `queueStartedAt`, `callStartedAt`, `operatorName`, `transferring`;
  - `call.recording_state`, `micOn`, `camOn`;
  - `endedDuration`, `endedCallId`, `ratingSubmitted`, `callbackId`;
  - `formData`, `identifiedContact`, `availableLocales`;
  - the media elements.

None of these are in `getPresentationViewModel` (RT:1584-1599) `[inf]`.

---

## 6. Hooks the engine relies on

### 6.1 Media (LiveKit)

| Hook | Owner | Contract |
|---|---|---|
| `controller.root` | PD `createHost` → RT:707 | the `.ccw-root` element. `render()` is a no-op without it (RT:1558) |
| `controller._attachedTracks` `{sid: HTMLMediaElement}` | RT `attach()` (RT:1146-1168): `track.attach()`, `autoplay`, `playsInline` (video) | PD appends **every value** (audio **and** video elements) into `div.ccw-media`, after setting `data-track-sid=<sid>` (PD:452-461). Operator video is skipped when `capabilities.operator_video_visible === false` (RT:1152-1155) |
| `controller._localVideoEl` | RT:1218-1222, 1297-1300 (`muted`, `autoplay`, `playsInline`); cleared on cam off (RT:1305-1307) | PD puts it in `div.ccw-local-pip` only when live, video, not transferring, and `camOn` (PD:462-467) |
| `prepareMediaElement` | PD:123-134 | on `<video>` only: sets `data-remote-video="true"` or `data-local-video="true"`, `data-orientation-correction="scaleX(-1)"`, and inline `transform:scaleX(-1); scale:1; rotate:0deg`. **Remote video is mirrored too**, and so is RCSS:237 |
| `controller._remoteHolder` | written by PD:451 | never read by RT; only cleared (RT:1442) |
| `controller._waveBars` | **read** by RT's audio meter (RT:1345-1353, `bars[i].style.transform = scaleY(…)`) | **never set by PD**: the RAF analyser loop runs for the whole call with no visual. A new design could supply an array of bar elements here for a live voice meter |

- **Where media lives `[inf]`:**
  - voice calls: `.ccw-media` is built but **never inserted** into the DOM (PD:462-475 only pushes it for video), so the remote `<audio>` plays detached;
  - video calls: remote audio and video are inside `.ccw-media.video`, and are re-parented into a fresh container on every render, every second.
- A re-render must keep appending the **same** element instances, never clone them. It must also not leave a playing element out of the document, since removing a media element from the document pauses it.

### 6.2 `data-*` inventory (complete)

| Attribute | Element | Set by | Read by |
|---|---|---|---|
| `data-radius` | `.ccw-root` | PD:63 (`sm\|md\|lg`) | FA:13-15, INTL:37-39 |
| `data-density` | `.ccw-root` | PD:64 (`compact\|comfortable`) | FA:16-17, INTL:40-41 |
| `data-track-sid` | remote media | PD:457 | nothing |
| `data-remote-video` / `data-local-video` | `<video>` | PD:127 | nothing |
| `data-orientation-correction` | `<video>` | PD:128 | nothing |
| `data-cc-livekit-sdk` | SDK `<script>` | LD:152 | LD:144 (dedupe) |
| `workspace-id` / `data-workspace-id`, `public-key` / `data-public-key`, `api-base` | embed `<script>` | host page | LD:38-45 |

There are **no** action or `data-*` hooks in the panel.

### 6.3 IDs and structural or state classes

- **IDs:** `#call-center-widget-host` (PD:747) and `#gs-presentation-fonts` (PD:763-765, document level, shared with the chat widget).
- **Classes CSS depends on:**
  - root: `ccw-root`, `ccw-presentation-default`, `ccw-presentation-intl`, `ccw-is-open`;
  - containers: `ccw-launcher-wrap.left|right`, `ccw-panel.left|right`;
  - buttons: `ccw-btn` + `primary|secondary|ghost|danger|full`;
  - segments: `ccw-seg-btn.active[.danger]`;
  - other state classes: `ccw-status-dot.online|offline`, `ccw-media.video`, `ccw-spinner.small`, `ccw-pill.recording`, `ccw-star.filled`, `ccw-ring-core-success`, `ccw-no-ring` (via `:has`, RCSS:202).
- **Emitted but unstyled (free hooks):** `ccw-pill.live`, `ccw-ring.r1`, `ccw-ring-core-phone`, `ccw-sound-toggle.muted`, `ccw-powered-label`, `ccw-launcher-wrap.right`, `ccw-panel.right`.
- **`[hidden]`** is forced by `.ccw-root [hidden]{display:none!important}` (RCSS:22). It is used by the `hide` offline behaviour.

### 6.4 Timers and cadence

| Timer | Period | Source | What it does |
|---|---|---|---|
| queue tick | 1 s | RT:921-939 | `render()` while in `queue_waiting`; one extra render when the offer threshold is crossed |
| call tick | 1 s | RT:947-953 | `render()` while `in_call` and `callStartedAt` is set |
| status poll | 5 s (plus one immediately) | RT:975-981 | position, ETA, operator, transfer, start, end |
| offer → callback | 50 ms | PD:389 | `openCallback` after `cancelCall` |
| ringback ring | 2.8 s | RT:421-423 | 440+480 Hz double ring (RT:254-257) |
| hold music | 11 s loop | RT:425-426 | generated pad + bell melody (RT:276-323) |
| announcement | first after 1.4 s, then every 18 s (min spacing 14 s audio / 12 s TTS; voice retry 900 ms) | RT:414-430, 335, 373, 379 | |
| audio meter | `requestAnimationFrame` | RT:1341-1355 | no-op visual (§6.1) |

- **Clock:** `m:ss` from `Date.now() - <start>` (PD:118-121). There is no hour field (e.g. `75:03`) and no guard against negative values.

### 6.5 Audio (Ringback, RT:176-535)

- **Modes** (from `queue_experience`):
  - `ringback_enabled === false` or `ringback_mode === 'off'` → silent;
  - `'music'` + `ringback_music_url` → a looping `<audio>` (volume .38 hold / .62 ring), which falls back to tone on error;
  - otherwise `'tone'`.
- **Announcements:**
  - `ringback_queue_audio_urls[<position>]`, or else `ringback_announcement_audio_url`;
  - otherwise browser TTS of `queue_wait_announce`, **en and tr only**. Persian never uses TTS (RT:368-371).
- **Phases:** `hold` while queued; `ring` when the server reports `active|ringing|connecting` (RT:1041). On the normal queue → call path Ringback is stopped at that moment (RT:1043).
- **Gesture unlock.**
  - `prime()` and `startFromGesture()` run synchronously in the Voice/Video and Start-call clicks (RT:775, 801-812).
  - When blocked, `needsGesture` becomes true and the window capture listeners are installed (RT:198-208).
  - The renderer shows the tap hint and the 🔇 state.
- **Mute** persists in sessionStorage `ccw_ringback_muted` (RT:518-533).
- **Renderer facade:** only `isActive`, `isMuted`, `needsGesture`, `setMuted` and `startFromGesture` (RT:1568-1574).

### 6.6 Form fields, payloads and validation

- **`formData`** (RT:563-569): `name`, `email`, `phone`, `subject`, `message`, `call_type` (`voice|video`), `consent`, `department_id`, `callback_channel` (`audio|video`), `callback_urgency` (`normal|urgent`), `callback_when` (`now|later`), `callback_scheduled_for` (a `datetime-local` string), `hp_company`, `custom{}`.
- **Pre-call validation** (RT:806-825, 906-919):
  - schema fields with `required` (only when `pre_call_form_enabled`) → error `"<field.label>: " + t('required')`;
  - consent required and unchecked → `err_recording_required`.
  - Server codes: `recording_consent_required` → `err_recording_accept`; `department_channel_disabled|department_not_found` → `err_department`; anything else → the `error` state (RT:846-858).
- **`POST calls/request` body** (RT:831-844):
  - `call_type`, `visitor_name`, `visitor_email`, `visitor_phone`, `subject`;
  - `page_url`, `page_title`;
  - `consent_recording`, `recording_consent`, `recording_consent_at`;
  - `department_id`, `form_data` (= `custom`).
- **Callback validation** (RT:1471-1505):
  - client cooldown → `err_wait_seconds {n}`;
  - `require_contact` and no email/phone (unless identified) → `err_contact_required`;
  - message shorter than `min_message_length` → `err_message_short {n}`;
  - scheduled time not after now−60 s → `err_future_time`. The picker's `min` is now+5 min, so the two do not match.
  - Server codes (RT:1523-1545): `department_*`, `contact_required`, `message_too_short {min}`, `too_fast`, `cooldown_active {retry_after}`, `rate_limited_ip`, `feature_not_available` → localised `err_*`; anything else is shown raw.
- **`POST callbacks/request` body** (RT:1508-1521):
  - `name`, `email`, `phone`, `subject`, `message`;
  - `channel`, `urgency`, `scheduled_for` (ISO);
  - `page_url`, `department_id`;
  - `hp_company` (honeypot, from the `company_website` input), `form_opened_at` (time-trap).
- **Error display.** All errors render as **one** `div.ccw-error` above the action row (PD:735). There is no per-field state.
  - `[inf]` If an identified visitor skips the form (RT:789-794) and schema validation then fails, the error is set while still in `online_available`, which never renders `error`. Nothing visible happens.

### 6.7 Rating

- Values are integers 1-5 (`ratingValue`, default 0); the submit button is disabled at 0.
- The comment is free text (`ratingComment`, sent as `null` when empty).
- It is sent once to `POST calls/:id/rate` for `endedCallId` (RT:958-973).
- Stars have `aria-label="1".."5"` (Latin digits, unlocalised) and no `aria-pressed` or radio semantics (PD:534).

---

## 7. Tokens

### 7.1 Colour tokens (HSL channels, used as `hsl(var(--x))`)

| Token | RCSS default (RCSS:5-18) | INTL (INTL:20-33) | `widget_theme` key | Consumers |
|---|---|---|---|---|
| `--ccw-ink` | `210 13% 13%` | `245 37% 12%` | `text` | all ink text, label, input text, video bg (RCSS:59, 75, 93, …, 237) |
| `--ccw-muted` | `220 6% 40%` | `245 12% 41%` | `muted` | `.ccw-muted`, subs, ghost button (RCSS:65, 94, 125, 129, 139, 158, 160, 211, 233) |
| `--ccw-faint` | `228 7% 58%` | `246 10% 58%` | — | offline dot, chevron, powered-by, note, operator role (RCSS:95, 97, 104, 117, 157, 232) |
| `--ccw-border` | `230 11% 89%` | `247 19% 90%` | — | header rule, inputs, secondary/ghost buttons, segments, spinner track, cards, scrollbar |
| `--ccw-surface` | `0 0% 99%` | `240 18% 97%` | `surface` | **panel and header background** (RCSS:75, 85) |
| `--ccw-panel` | `0 0% 99%` | `0 0% 100%` | `surface` | **unused** |
| `--ccw-primary` | `209 100% 56%` (#1F93FF) | `9 100% 62%` (#FF5A3C) | `primary` | launcher gradient + shadow, avatar, primary button, focus ring (.25), input focus, checkbox, spinner, active segment, rings + core, tap hint, stars (RCSS:38-52, 88, 137, 145, 154, 159, 178, 195, 200, 203, 217-218, 269-270) |
| `--ccw-primary-disabled` | `207 100% 88%` | `9 100% 88%` | — (not derived) | any `.ccw-btn[disabled]` (RCSS:143) |
| `--ccw-accent` | `149 66% 30%` | `152 70% 34%` | `accent` | pill text, known-contact border + dot, success ring core (RCSS:164, 168, 183, 204) |
| `--ccw-accent-bg` | `144 55% 95%` | `152 50% 95%` | — (not derived) | pill bg, known-contact bg |
| `--ccw-active-bg` | `207 100% 96%` | `9 100% 96%` | — (not derived) | active segment bg, tap-hint bg |
| `--ccw-danger` | `358 75% 59%` | `358 75% 52%` | `danger` | danger text, End bg, recording pill, urgent segment, error |
| `--ccw-danger-bg` | `359 71% 96%` | same | — (not derived) | Cancel bg, error bg, urgent bg |
| `--ccw-shadow` | `222 47% 11%` | `245 37% 12%` | — | **unused** (shadows are hard-coded) |

- **Theme overrides** are inline on `.ccw-root` (PD:55-62), so they beat both skins.
- **The derived tints are not recomputed.** With a custom `primary`, the disabled button, active segment and tap hint keep the skin's blue (fa) or coral (intl) tint `[inf]`.
- **Hard-coded colours in RCSS:**
  - white `hsl(0 0% 100%)` for: launcher button bg and label, language select, secondary buttons, inputs, segments, offer card, summary card, button text;
  - online dot `hsl(144 61% 45%)` (RCSS:96);
  - chip bg `hsl(220 14% 96%)` (RCSS:222);
  - PiP bg `hsl(220 8% 26%)` (RCSS:241);
  - shadows (RCSS:60, 76, 247).
- There is no dark mode and no `prefers-color-scheme` rule.

### 7.2 Radius and density

| | FA (`.ccw-presentation-default[data-radius]`, FA:13-15) | INTL (INTL:37-39) | Fallback when unset |
|---|---|---|---|
| `sm` | panel 12px / control 8px | 10px / 6px | — |
| `md` (default) | 18px / 10px | 16px / 8px | FA:18-19 → 18/10; INTL:42-43 → 16/8 |
| `lg` | 24px / 14px | 22px / 12px | — |

- `--ccw-radius-panel` reaches only `.ccw-panel` (FA:18; INTL:42).
- `--ccw-radius-control` reaches only `.ccw-btn` (FA:19; INTL:43).
- Everything else uses fixed radii:

  | Radius | Elements |
  |---|---|
  | `.5rem` | inputs, segments, error, tap hint |
  | `.6rem` | known contact, summary card |
  | `.75rem` | offer card, video |
  | `.4rem` | PiP |
  | `.9rem` | launcher label |
  | 8px | language select |
  | 999px | pills, chips, rings, avatar, launcher |

- **Density** `compact` (FA:16-17; INTL:40-41): `.ccw-body{padding:10px}`, `.ccw-btn{min-height:34px; padding-block:6px}`. The base (comfortable) is a body padding of `14px 16px` and buttons with `min-height:40px; padding:9px 12px` (RCSS:109, 131-136).

### 7.3 Type, spacing and elevation in use (RCSS)

**Type scale (px/weight):**

| Size / weight | Elements |
|---|---|
| 18/600 | hero title |
| 16/600 | queue title, confirm title |
| 15/600 | operator name |
| 14.5/600 | header title |
| 14/600 | ended title, rate title |
| 13.5/500 | buttons |
| 13 | body, hero sub (lh 1.6), launcher text 13/600, wait timer 13/600 (tabular nums), known title 13/600 |
| 12.5 | form intro, queue copy, segment 12.5/500, call timer |
| 12 | label 12/500, muted (lh 1.5), error 12/600, summary rows, video info 12/600 |
| 11.5 | header sub, operator role |
| 11 | launcher sub, pill 11/500, chip, checkbox text, powered-by |
| 10.5 | note |
| 10/700 | language select |
| 22/600 | operator initial |

**Spacing:** stack gap 14; row and segment gap 8; header gap 10; queue block gap 10; controls gap 6; chip row gap 8; hero copy gap 3.

**Elevation:** launcher `0 10px 26px primary/.35`; label `0 8px 20px black/.12`; panel `0 25px 50px -12px black/.25`.

**Motion:**

| Animation | Values | Source |
|---|---|---|
| panel open | .38s `cubic-bezier(.32,.9,.35,1)` | RCSS:77 |
| launcher wrap | .38s `cubic-bezier(.4,0,.2,1)` | RCSS:30 |
| button hover | .3s `cubic-bezier(.34,1.56,.64,1)` | RCSS:39 |
| icon flip | .55s `cubic-bezier(.22,1,.36,1)` | RCSS:53 |
| label in | .5s, .15s delay | RCSS:61 |
| rings | `ccw-ring` 1.8s ease-out ∞, scale .9→1.5 and opacity .55→0, r2 delayed .6s | RCSS:200-201, 274 |
| spinner | .85s | RCSS:178 |
| tap-hint pulse | 1.6s | RCSS:219 |
| colour transitions | .15-.16s | RCSS:135, 193 |

All of these are disabled under `prefers-reduced-motion` (RCSS:285-287).

---

## 8. i18n

- **Where texts live.** `I18N` in RT holds en (RT:35-62), fa (RT:63-90) and tr (RT:91-118), **136 keys each, all three complete**. PD uses 112 keys and RT itself uses 15 (errors, `required`, `queue_wait_announce`). Nine keys are unused: `live_now`, `channels`, `secure_line`, `queue_aware`, `fast_handoff`, `enable_ringing_sound`, `queue_position`, `eta`, `request_callback_title`.
- **Lookup** `t(key, vars)` (RT:577-593):
  1. `custom_texts[locale][key]`
  2. **`custom_texts.en[key]`**
  3. `I18N[locale][key]`
  4. `I18N.en[key]`
  5. the key itself

  `{var}` placeholders are replaced by `formatText` (RT:148-155). Overrides must be non-blank strings. `[inf]` Because of step 2, a workspace that customises only an English text will show that **English** text in the Persian widget.
- `powered_by` gets `{brand}` from `poweredByBrand()`. An empty brand gives an empty string, so there is no footer text (RT:587-591).
- Several Persian keys share the same text, so they read identically in the UI:
  - `callback`, `request_callback` and `request_callback_instead` are all "درخواست تماس";
  - `video_callback` = `video_call` = "تماس تصویری".
- `consent_required` starts with a space in every locale, because it follows the checkbox node (PD:729).

**Keys used by the renderer (PD), with the en and fa values verbatim:**

| Key | Used at | en | fa |
|---|---|---|---|
| `talk_now` | PD:173 | Talk now | همین حالا تماس بگیرید |
| `callback` | PD:174 | Callback | درخواست تماس |
| `support` | PD:174,207 | Support | پشتیبانی |
| `live_support` | PD:175 | Live support | پشتیبانی آنلاین |
| `leave_details` | PD:176 | Leave details | ثبت اطلاعات |
| `offline` | PD:176 | Offline | آفلاین |
| `operators_available` | PD:210 | Operators available | اپراتورها آماده‌اند |
| `callback_desk` | PD:210 | Callback desk | میز درخواست تماس |
| `back` | PD:214,578,737 | Back | بازگشت |
| `powered_by` | PD:226 | Powered by {brand} | قدرت گرفته از {brand} |
| `loading` | PD:290 | Loading… | در حال بارگذاری… |
| `leave_callback_request` | PD:295 | Leave a callback request | درخواست تماس ثبت کنید |
| `offline_copy` | PD:296 | Our team is offline right now, but we can call you back. | تیم ما الان آفلاین است، اما می‌توانیم با شما تماس بگیریم. |
| `request_callback` | PD:300,389 | Request callback | درخواست تماس |
| `talk_to_team` | PD:310 | Talk to our team | با تیم ما صحبت کنید |
| `online_copy` | PD:311 | Start a secure voice or video call with the next available operator. | یک تماس صوتی یا تصویری امن را با اولین اپراتور آزاد شروع کنید. |
| `voice_call` | PD:315 | Voice call | تماس صوتی |
| `video_call` | PD:316 | Video call | تماس تصویری |
| `request_callback_instead` | PD:319 | Request a callback | درخواست تماس |
| `you_are_next` | PD:333 | You are next | نفر بعدی شما هستید |
| `holding_place` | PD:333 | Holding your place | جای شما محفوظ است |
| `queue_copy_many` | PD:334 | Your request is in the live call queue. Keep this window open while we connect the operator. | درخواست شما در صف تماس زنده است. این پنجره را باز نگه دارید تا اپراتور متصل شود. |
| `queue_copy_next` | PD:334 | We are ringing the next available operator now. | در حال زنگ زدن به اولین اپراتور آزاد هستیم. |
| `ringing_enabled` | PD:339 | Ringing enabled | صدای زنگ فعال است |
| `ringing_operator` | PD:339 | Ringing operator | در حال زنگ زدن به اپراتور |
| `waiting_time` | PD:345 | Waiting time | زمان انتظار |
| `unmute_sound` | PD:350 | Unmute sound | فعال کردن صدا |
| `mute_sound` | PD:350 | Mute sound | بی‌صدا کردن |
| `tap_to_hear` | PD:371 | Tap to enable sound | برای شنیدن صدا کلیک کنید |
| `you_next_line` | PD:375 | You are next in line | شما نفر بعدی صف هستید |
| `you_queue_number` | PD:375 | You are #{n} in the queue | شما نفر {n} صف هستید |
| `eta_under_min` | PD:380 | Estimated wait: under 1 minute | زمان انتظار: کمتر از ۱ دقیقه |
| `eta_minutes` | PD:380 | Estimated wait: ~{n} minutes | زمان انتظار: حدود {n} دقیقه |
| `tired_waiting` | PD:388 | Tired of waiting? We can call you back instead. | از انتظار خسته شدید؟ می‌توانیم با شما تماس بگیریم. |
| `cancel_call` | PD:392 | Cancel call | لغو تماس |
| `call_accepted_connecting` | PD:398 | Call accepted, connecting… | تماس پذیرفته شد، در حال اتصال… |
| `connected` | PD:399 | Connected | متصل شد |
| `operator_joining` | PD:400 | Operator joining… | اپراتور در حال ورود است… |
| `operator_connected` | PD:401 | Operator connected | اپراتور متصل شد |
| `operator_left` | PD:402 | Operator left the call. | اپراتور تماس را ترک کرد. |
| `reconnecting_media` | PD:403 | Reconnecting media… | در حال اتصال مجدد رسانه… |
| `media_disconnected` | PD:404 | Media disconnected. | ارتباط رسانه قطع شد. |
| `connecting_av` | PD:405 | Connecting audio/video… | در حال اتصال صدا/تصویر… |
| `fallback` | PD:406 | Call accepted. Please continue on the operator side. | تماس پذیرفته شد. لطفاً از سمت اپراتور ادامه دهید. |
| `accepted_no_sdk` | PD:407 | Call accepted. Audio/video client unavailable on this page. | تماس پذیرفته شد. کلاینت صدا/تصویر در این صفحه در دسترس نیست. |
| `media_not_configured` | PD:408 | Call accepted, media connection is not configured yet. | تماس پذیرفته شد، اما اتصال رسانه هنوز تنظیم نشده است. |
| `provider_not_configured` | PD:409 | Call accepted, but the media server URL is not configured. Please request a callback. | تماس پذیرفته شد، اما آدرس سرور رسانه تنظیم نشده است. لطفاً درخواست تماس ثبت کنید. |
| `provider_not_supported` | PD:410 | Call accepted, but this provider has no in-browser client. | تماس پذیرفته شد، اما این ارائه‌دهنده کلاینت مرورگری ندارد. |
| `media_client_missing` | PD:411 | Media client is not loaded. Call room is ready but the browser client is missing. | کلاینت رسانه بارگذاری نشده است. اتاق تماس آماده است اما کلاینت مرورگر موجود نیست. |
| `media_client_invalid` | PD:412 | Media client loaded but is incompatible with this widget. | کلاینت رسانه بارگذاری شده با این ویجت سازگار نیست. |
| `loading_media_client` | PD:413 | Loading media client… | در حال بارگذاری کلاینت رسانه… |
| `mic_denied` | PD:414 | Microphone permission denied. Please allow access and try again. | دسترسی میکروفون رد شد. لطفاً اجازه دسترسی بدهید و دوباره تلاش کنید. |
| `camera_denied` | PD:415 | Camera permission denied. Audio call continues without video. | دسترسی دوربین رد شد. تماس صوتی بدون تصویر ادامه دارد. |
| `room_failed` | PD:416 | Failed to connect to the call room: {error} | اتصال به اتاق تماس ناموفق بود: {error} |
| `unknown` | PD:416,577 | unknown | نامشخص |
| `token_expired` | PD:417 | Your session expired. Please end and start a new call. | جلسه شما منقضی شد. لطفاً تماس را پایان دهید و دوباره شروع کنید. |
| `in_call` | PD:422 | In call | در تماس |
| `connected_waiting` | PD:422 | Connected — waiting | متصل — در انتظار |
| `connecting` | PD:422 | Connecting | در حال اتصال |
| `transferring_call` | PD:427 | Transferring to another operator… | در حال انتقال به اپراتور دیگر… |
| `operator_label` | PD:435,469 | Operator | اپراتور |
| `recording_progress` | PD:444 | ● Recording in progress | ● ضبط در حال انجام است |
| `recording_may_start` | PD:447 | Recording may start after the operator begins the call. | ممکن است ضبط پس از شروع تماس توسط اپراتور آغاز شود. |
| `unmute` | PD:480 | 🎙 Unmute | 🎙 فعال‌کردن صدا |
| `mute` | PD:480 | 🎙 Mute | 🎙 بی‌صدا |
| `camera_on` | PD:484 | 🎥 Camera on | 🎥 روشن کردن دوربین |
| `camera_off` | PD:484 | 🎥 Camera off | 🎥 خاموش کردن دوربین |
| `end` | PD:488 | End | پایان |
| `asap` | PD:499,702 | as soon as possible | در اولین فرصت |
| `video_callback` | PD:500 | Video callback | تماس تصویری |
| `phone_callback` | PD:500 | Phone callback | تماس تلفنی |
| `callback_scheduled` | PD:503 | Callback scheduled | درخواست تماس ثبت شد |
| `reach_out` | PD:504 | Our team will reach out {when}. | تیم ما {when} با شما تماس می‌گیرد. |
| `type` | PD:506 | Type | نوع |
| `reference` | PD:507 | Reference | کد پیگیری |
| `done` | PD:509,568,570 | Done | تمام |
| `call_ended` | PD:515 | Call ended. | تماس پایان یافت. |
| `call_duration` | PD:516 | Duration | مدت مکالمه |
| `rate_comment_ph` | PD:552 | Add a comment (optional) | افزودن نظر (اختیاری) |
| `rate_call_title` | PD:556 | How was your call? | تماس چطور بود؟ |
| `rate_call_sub` | PD:557 | Your feedback helps our team improve. | نظر شما به بهبود تیم ما کمک می‌کند. |
| `rate_submit` | PD:561 | Submit rating | ثبت امتیاز |
| `rate_skip` | PD:563 | Skip | رد کردن |
| `rate_thanks` | PD:567 | Thank you for your feedback! | از بازخورد شما متشکریم! |
| `error_prefix` | PD:577 | Error: {error} | خطا: {error} |
| `callback_intro` | PD:606 | Tell us how to reach you — our team calls back fast. | راه ارتباطی را وارد کنید — تیم ما سریع تماس می‌گیرد. |
| `phone` | PD:610 | 🎙 Phone | 🎙 تلفنی |
| `video` | PD:611 | 🎥 Video | 🎥 تصویری |
| `callback_type` | PD:612 | Callback type | نوع تماس |
| `department` | PD:618 | Department | دپارتمان |
| `choose_department` | PD:619 | Choose a department | یک دپارتمان انتخاب کنید |
| `known_contact` | PD:630 | Known contact | مخاطب شناخته‌شده |
| `contact_saved` | PD:635 | Contact details already saved | اطلاعات تماس قبلاً ذخیره شده است |
| `subject` | PD:641,646 | Subject | موضوع |
| `full_name` | PD:643 | Full name | نام کامل |
| `email_required` | PD:644 | Email * | ایمیل * |
| `email` | PD:644 | Email | ایمیل |
| `phone_required` | PD:645 | Phone * | تلفن * |
| `phone_field` | PD:645 | Phone | تلفن |
| `contact_required_note` | PD:682 | * Email or phone is required so we can reach you. | * ایمیل یا تلفن برای تماس با شما الزامی است. |
| `message_min` | PD:694 | Message (min {n} chars) | پیام (حداقل {n} کاراکتر) |
| `message_optional` | PD:694 | Message (optional) | پیام (اختیاری) |
| `message_placeholder` | PD:695 | Briefly describe what you need help with… | کوتاه توضیح دهید چه کمکی نیاز دارید… |
| `when_call` | PD:700 | When should we call? | چه زمانی تماس بگیریم؟ |
| `schedule` | PD:702 | 🗓 Schedule | 🗓 زمان‌بندی |
| `priority` | PD:714 | Priority | اولویت |
| `normal` | PD:716 | Normal | عادی |
| `urgent` | PD:716 | 🔥 Urgent | 🔥 فوری |
| `consent_required` | PD:729 |  I consent to this call being recorded for quality and security. (required) |  رضایت می‌دهم این تماس برای کیفیت و امنیت ضبط شود. (الزامی) |
| `call_may_record` | PD:732 | This call may be recorded for quality and security. | ممکن است این تماس برای کیفیت و امنیت ضبط شود. |
| `start_call` | PD:738 | Start call | شروع تماس |
| `send_request` | PD:738 | Send request | ارسال درخواست |

**Keys used only by the engine (RT), shown through `controller.error` or the announcement:**

| Key | Used at | en | fa |
|---|---|---|---|
| `queue_wait_announce` | RT:803,887,1006,1389,1400 | You are in the waiting queue. Please wait, we will connect you shortly. | شما در صف انتظار هستید. لطفاً صبر کنید، به‌زودی شما را به اپراتور متصل می‌کنیم. |
| `required` | RT:817 | Required | الزامی |
| `err_recording_required` | RT:823 | Recording consent is required to continue. | برای ادامه، رضایت ضبط تماس الزامی است. |
| `err_recording_accept` | RT:850 | Please accept the recording consent to start the call. | برای شروع تماس لطفاً رضایت ضبط را تأیید کنید. |
| `err_department` | RT:854,1526 | This department is not available for this call type. Please choose another department. | این دپارتمان برای این نوع تماس در دسترس نیست. لطفاً دپارتمان دیگری انتخاب کنید. |
| `err_failed_start` | RT:857 | Failed to start call. | شروع تماس ناموفق بود. |
| `err_wait_seconds` | RT:1474 | Please wait {n}s before sending another request. | لطفاً {n} ثانیه قبل از ارسال درخواست بعدی صبر کنید. |
| `err_contact_required` | RT:1483,1528 | Please provide your email or phone so we can reach you. | لطفاً ایمیل یا تلفن خود را وارد کنید تا بتوانیم با شما تماس بگیریم. |
| `err_message_short` | RT:1492,1531 | Please describe your request in at least {n} characters. | لطفاً درخواست خود را حداقل در {n} کاراکتر توضیح دهید. |
| `err_future_time` | RT:1502 | Please pick a valid future time. | لطفاً یک زمان معتبر در آینده انتخاب کنید. |
| `err_too_fast` | RT:1533 | That was too fast. Please take a moment to fill in the form. | خیلی سریع بود. لطفاً کمی برای تکمیل فرم زمان بگذارید. |
| `err_cooldown` | RT:1537 | You already requested a callback. Please wait {n}s before sending another. | قبلاً درخواست تماس ثبت کرده‌اید. لطفاً {n} ثانیه صبر کنید. |
| `err_rate_limited` | RT:1539 | Too many callback requests from your network. Please try again later. | درخواست‌های زیادی از شبکه شما ارسال شده است. بعداً دوباره تلاش کنید. |
| `err_callback_unavailable` | RT:1541 | Callback requests are currently unavailable. | درخواست تماس در حال حاضر در دسترس نیست. |
| `err_failed` | RT:1543 | Failed. | ناموفق بود. |

**Strings hard-coded in PD (not translatable):**

| String | Where | Note |
|---|---|---|
| `Widget language` | PD:261 | `aria-label` on the language select, always English |
| `EN`, `فا`, `TR` | PD:67-71 | language option labels |
| `؟` | PD:430 | operator-initial fallback, in every locale |
| `—` | PD:662 | custom select placeholder |
| ` *` | PD:653 | required suffix on custom schema labels |
| `: ` | PD:516 | separator in the duration line |
| `✓` | PD:632 | known-contact dot |
| `🔊` / `🔇` | PD:366 | sound toggle glyph |
| `⚡ ` and `🔥 ` | PD:702, 716 | segment prefixes. `🔥` doubles with the I18N value |
| `1`-`5` | PD:534 | star `aria-label`s |
| `…` | PD:581 | unknown-state fallback |

Emoji also sit **inside I18N values**: `mute`, `unmute` (🎙), `camera_off`, `camera_on` (🎥), `phone` (🎙), `video` (🎥), `schedule` (🗓), `urgent` (🔥), `recording_progress` (●) and the unused `enable_ringing_sound` (🔊), in all three locales. English-only engine texts: `friendlyConnectError` (RT:161-173), shown via `room_failed {error}`, and raw server `message`/`error` values in the forms and the `error` state.

**Digits.** There is no digit localisation anywhere in the call widget.

| Persian digits | Latin digits in Persian UI |
|---|---|
| only where literally typed in a fa string: `eta_under_min` "کمتر از ۱ دقیقه" (RT:71) | queue wait timer, call timer, video-info duration, ended duration: `fmtTime` → `m:ss` (PD:118-121, 346, 436, 470, 516) `[snap fa-08 "0:47", fa-11 "2:14", fa-15 "4:14"]` |
| values typed by the visitor (`۰۹۱۲۳۴۵۶۷۸۹` in `fa-05`) `[snap]` | `{n}` in `you_queue_number`, `eta_minutes`, `message_min`, `err_wait_seconds`, `err_cooldown`, `err_message_short` (`String(n)` in `formatText`, RT:152) `[snap fa-08 "شما نفر 3 صف هستید"]` |
| | star `aria-label`s 1-5; the reference code (Latin by design); the `datetime-local` value and `min` |
| | the callback time in the confirmation: `new Date(...).toLocaleString()` with **no locale argument** (PD:498), so it uses the host browser's locale and Gregorian calendar, not fa or Jalali |

**Dates and calendar.** The call widget does not use `widgetDateHints` (WT:147-166; no `calendar` or `timeZone` read in RT or PD). The scheduler is the browser's native `datetime-local` picker, whose `min` is computed in local time (PD:709-710).

---

## 9. What a re-skin or re-render must preserve

1. **The state contract.** `controller.state` is one of the nine values (RT:16-26, mirrored at PD:16-26). The sub-state inputs are listed in §4: `connectStatus`, `transferring`, `queuePosition`/`queueEta`, `callbackId`, `endedCallId`, `ratingSubmitted`, `identifiedContact`, `error`, and the `bootstrap` capabilities and policies. Keep every branch of PD:284-582, including the 20 `connectStatus` cases (§4.6), the three `ended` variants and the hide policy (PD:163-168).
2. **The presentation lifecycle.**
   - Register under `default` and `intl` with `contractVersion:1` and `createHost`, `mount`, `update`, `destroy` (REG:12-18).
   - `createHost` must create `#call-center-widget-host` with an open shadow root, load RT's CSS (or its successor) inside it, append `#gs-presentation-fonts` to `document.head` when `assets.font_style_url` is given, and return `{host, root}`.
   - `mount`/`update` must apply the theme and render for `context.controller`.
3. **Controller calls** (§5). Today the renderer drives the controller directly. A new renderer must either do the same (`toggleOpen`, `startCall`, `openCallback`, `submitCall`, `submitCallback`, `cancelCall`, `reset`, `setLocale`, `toggleMic`, `toggleCam`, `submitRating`, `render`, plus direct writes to `formData.*`, `ratingValue` and `ratingComment`), or RT must first grow `intents` and the view model to cover them. Starting a call must stay a **synchronous** call inside the click so that `Ringback.prime`/`startFromGesture` keep the user activation (RT:773-775, 799-812).
4. **Media hooks** (§6.1).
   - Append every `_attachedTracks` element and `_localVideoEl` as the same instances, and keep them in the document while they play.
   - Keep `data-track-sid` and the `prepareMediaElement` attributes.
   - Decide on purpose whether voice audio is mounted.
   - Optionally set `controller._waveBars` for a live level meter.
5. **Persistence across the 1 s re-render.** Keep `ccw-launcher-wrap` and `ccw-panel` as persistent nodes (the PD:136-141 rationale). Ideally also stop rebuilding animated or focused children every tick, so that focus, hover and ring animations survive.
6. **Forms.**
   - Keep the `<form>` submit path (Enter submits) and the `type=button` on non-submit buttons.
   - Keep the honeypot exactly: `input[name=company_website][tabindex=-1][aria-hidden=true][autocomplete=off]`, visually off-screen, not `display:none`.
   - Keep the time-trap (`callbackOpenedAt` is set in `openCallback`), the `datetime-local` `min`, the custom schema field types (text/email/tel/textarea/select/checkbox) with their `*` required marker, and a place for the single `controller.error` message.
7. **The audio UI.** The sound toggle must call `setMuted` and, on unmute with `needsGesture`, `startFromGesture(queue_experience)` **inside the click**, with `stopPropagation`. The "tap to enable sound" hint must appear whenever `needsGesture()` is true.
8. **ARIA that exists today** (and should be extended, not lost):
   - the launcher `aria-label`;
   - the collapse button `aria-label`;
   - the language select `aria-label`;
   - the sound toggle `aria-label`;
   - the star `aria-label`s;
   - `aria-hidden` on the honeypot.

   What is missing and worth adding:
   - `aria-expanded` on the launcher;
   - `role="dialog"` and a label on the panel;
   - `inert` or `hidden` on the closed panel;
   - live regions for the queue position, call status and errors;
   - label/field association;
   - radio semantics for the stars and segments.
9. **The "Powered by" footer** (README:153, a plan feature).
   - Keep `div.ccw-footer > a.ccw-powered` with all the variants in §4.11: the Iran dead link `href="#"` + `preventDefault`; the international `target=_blank rel="noopener noreferrer"` link only for an `http(s)` URL; the logo with its `onerror` → brand-text fallback; `.ccw-powered-label` spans around the logo, with their order following the locale string.
   - A view must also look right with an empty footer (International without a brand).
10. **Theme and tokens.**
    - Keep the `--ccw-*` names, the HSL-channel format and inline application on `.ccw-root`.
    - Keep `data-radius` and `data-density` on the root.
    - Keep `[hidden]` forced to `display:none`.
    - Keep `left`/`right` position classes on both the wrap and the panel.
11. **Reduced motion.** Keep a global opt-out at least as strong as RCSS:285-287.
12. **Persian and RTL.** Keep `lang` and `dir` on `.ccw-root` (PD:156-157) and the fa font forcing (RCSS:24). Any digit localisation must cover every case in the §8 digits table.

---

## Appendix A: discrepancies, dead code and known problems

### A1. README "Known problems" (README:89-106) checked against the code

| README item | Code evidence | Verdict |
|---|---|---|
| Latin digits in Persian (queue chips, timers, durations) | `fmtTime` (PD:118-121); `{n}` via `String()` (RT:152) | **Confirmed**, and wider: star labels, error seconds, the callback time via `toLocaleString()` (PD:498). The only Persian digit is the literal `۱` in `eta_under_min` |
| Video controls fall below the fold | the controls are in normal flow after `.ccw-media` inside the scrolling body (PD:472-489); nothing is pinned or overlaid | **Confirmed as a structural problem.** `[inf]` In the screenshots it is exaggerated: the captures use `<img>` placeholders that ignore `.ccw-media.video video{max-height:150px}` (RCSS:238). With a real `<video>` the picture is capped at 150px tall, so the controls probably fit while the video stays small |
| Mobile is not full-screen | RCSS:277-284: 370×508 card `[shot fa-23..25]` | **Confirmed** |
| Buttons are text-only in a call | PD:480, 484, 488 with I18N `mute`/`camera_off`/`end` | **Confirmed.** The labels carry emoji, not icons |
| "Connected" text and the recording note above the video | PD:439-448 | **Confirmed** `[snap *-12, *-25]` |
| Emoji used as icons | I18N values (§8) + PD:366, 632, 702, 716 | **Confirmed.** Also `🔥` is doubled in the urgent segment `[snap *-17, *-18]` |
| Long forms | PD:597-741: one label + field per row, every block stacked | **Confirmed** |

### A2. README and tokens.json vs code

1. The README state table's texts differ from the shipped strings. The real values are:

   | README says | Shipped string | Key |
   |---|---|---|
   | "Call us now" | "Talk now" / "همین حالا تماس بگیرید" | `talk_now` |
   | "Request a callback / Leave your details" | "Callback / Leave details" | `callback` / `leave_details` |
   | "Ringing an operator" | "Ringing operator" | `ringing_operator` |
   | "Your place is held" | "Holding your place" | `holding_place` |
   | "Tap to hear the ringback" | "Tap to enable sound" | `tap_to_hear` |

   README "07 connecting" is the `loading` state with "Loading…".
2. README:139-146 lists `startVoiceCall`, `startVideoCall`, `requestCallback`, … as the renderer's intents. The renderer never uses the `intents` object (§1.3, §5).
3. README:136-137 says the engine attaches media into `.ccw-media`. The **renderer** does that (PD:450-475), and only for video calls.
4. In `tokens.json`, `en_intl_overrides.--ccw-radius-panel/control = 10px/6px` are the intl **`sm`** values. The default (`md`) is 16px/8px (INTL:38, 42-43).
5. `tokens.json` lists `--ccw-panel` and `--ccw-shadow`, which no rule consumes. Its `theme_keys.surface` → `--ccw-surface + --ccw-panel` is correct, but only `--ccw-surface` is visible.
6. README's "logo" is `config.avatar_url`. There is no separate logo field.

### A3. Bugs and risky behaviour in the code (`[inf]` unless stated)

1. **Full rebuild every second** during the queue and calls (§4.0). This replays the label entrance, restarts the ring animations before they finish, loses keyboard focus and hover, and re-parents media nodes.
2. `callbackId` is never cleared by `reset()` (RT:1433-1454), so after one callback request, every later `ended` shows "Callback scheduled".
3. **Offer-card race:** `cancelCall()` is asynchronous and calls `reset()` on resolve, while `openCallback()` fires after 50 ms (PD:389; RT:1419-1430).
4. `cancelCall` has no `.catch` (RT:1419). On a network failure the visitor stays in `queue_waiting`/`in_call` with media already torn down.
5. `skipRating` is called by PD:563 but is not defined in RT, so Skip is just `reset()`.
6. **Ringback can keep sounding during a call.**
   - After a resumed active call it starts in the `ring` phase and is never stopped (RT:1384-1392).
   - After a transfer, hold restarts and every poll then switches it to `ring` (RT:1004-1009, 1041).
   - The only mute control exists in the queue view.
7. **Remote video is mirrored** like a selfie (PD:127-131; RCSS:237).
8. The mic button's colour follows `call.muted` (server) and its label follows `micOn` (local) (PD:480).
9. `rtc_v1_unsupported` (RT:1259) is not mapped in PD, so the visitor sees "Call accepted, connecting…" indefinitely.
10. If the camera is denied while the operator is already in the room, the status stays `camera_permission_denied`. Only End is shown, with no mute, although the message says the audio call continues (RT:1225-1232; PD:478).
11. The closed panel keeps stale, focusable content (RCSS:80; PD:200).
12. A `custom_texts.en` override leaks into fa/tr (RT:582).
13. Server `message`/`error` and `friendlyConnectError` are shown untranslated in Persian.
14. The `ccw-close` chevron is labelled "Back" / "بازگشت" (PD:214) but collapses the panel.
15. Not localised for direction: no `dir="ltr"` on email/phone inputs; no `autocomplete`; unassociated labels (§4.4).
16. Derived tints (`--ccw-primary-disabled`, `--ccw-active-bg`, `--ccw-accent-bg`, `--ccw-danger-bg`) ignore `widget_theme`. The online dot and the chip and card whites are hard-coded.
17. `rem` units depend on the host page's root font-size.
18. Viewport units are `100vh`, not `dvh`, on mobile (RCSS:73, 280).
19. The launcher does not reflect a running call, and `isOnline` is fixed from the bootstrap with no presence refresh (RT:722-725, 1452).
20. If an identified visitor skips the form and schema validation then fails, the error is invisible (§6.6).
21. The callback scheduler allows `min = now+5 min` in the picker but validates `> now−1 min` (PD:709-710 vs RT:1499).

### A4. Dead code, unused hooks and redundant work

1. The `viewModel` and `intents` contexts are unused by PD (RT:1565-1566, 1584-1612). Registry `destroy`, `ready` and `prepare` are never called.
2. `_waveBars` is never set, so the analyser RAF loop runs for nothing (RT:1324-1357). `_remoteHolder` is written and never read (PD:451; RT:1442).
3. The `fallback` and `accepted_no_sdk` messages (PD:406-407) are never produced. `in_call_ended` (RT:1134) is never set.
4. The `bootstrap.status !== 'ok'` branch (RT:710-712) is unreachable after LD:62-66. `provider_ready` (RT:713-715) and `toggleOpen`'s offline `if` (RT:765-767) are empty blocks.
5. Nine I18N keys are unused (§8). `--ccw-panel` and `--ccw-shadow` are unused tokens.
6. The `ended` "else" Done button (PD:569-571) is effectively unreachable.
7. These emitted classes have no rules: `ccw-pill.live`, `ccw-ring.r1`, `ccw-ring-core-phone`, `ccw-sound-toggle.muted`, `ccw-powered-label`, and the `.right` position class.
8. `.ccw-star.filled` has the same colour as `.ccw-star` (RCSS:269-270).
9. `LOCALE_META` is duplicated in RT:29-33 and PD:67-71.
10. LD injects `runtime.css` and the presentation CSS into the **host** `document.head` (LD:80-97), while PD loads them again inside the shadow root (PD:751-761). The selectors are `ccw-`-prefixed and harmless to the host, but the work is double. `[inf]` That host copy is what makes the `@font-face` rules global.
11. The hover "flip" is invisible without `avatar_url`: both layers draw the same phone glyph on the same gradient (RCSS:46-55).

### A5. Family consistency with the chat widget (for the "one family" brief, README:154-155)

- **Breakpoints:** call 480px vs chat 640px.
- **Corner offsets:** call 20px (14px mobile) vs chat 24px (12px mobile).
- **Launcher size:** call 52px fixed vs chat 56/60px × scale.
- **Mobile:** the call widget has no full-screen sheet.
- **Digits:** the chat widget localises digits in several places; the call widget localises none.
- **Shared assets:** `#gs-presentation-fonts`, the IRANSans/InterWY files, the edition → template mapping (WT) and the debug flag.
