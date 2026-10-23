# Production map: WebYar / RESPOK website chat widget

> **Scope note for this handoff.** This file describes the widget that is in production today (read from the
> source you shared: `public/widget/*` and `shared/*Launcher.ts`). Line references such as `PD:1176` point into those files.
> The new designs in this package re-skin and extend that widget. The in-chat call features described in §5.3 and §5.4
> (call invitation card, call surface) are **out of scope**: keep their markup, hooks and CSS working exactly as they are.
> The separate call-center widget is not part of this package at all.

Static read of the shipped widget source (nothing was executed). Purpose: let an implementation handoff map new designs onto the exact production markup, hooks and state classes.

## 0. Legend and evidence rules

| Alias | File (under `source/`) |
|---|---|
| `PD` | `public/widget/presentation-default.js` (renderer, 1794 lines) |
| `LD` | `public/widget/loader.js` (host shell, 3564 lines) |
| `CSS` | `public/widget/presentation-default.css` (default skin, 2063 lines) |
| `INTL` | `public/widget/presentation-intl.css` (intl skin, 180 lines) |
| `RT` | `public/widget/runtime.css` (Core reset, 75 lines) |
| `REG` | `public/widget/presentation-registry.js` |
| `FONTS` | `public/widget/presentation-default-fonts.css` |
| `WYL` / `RPL` | `shared/webyarLauncher.ts` / `shared/respokLauncher.ts` |
| `[snap]` | seen in the live-DOM captures `snapshots/*.html` |
| `[shot]` | seen in `screens/*.png` |
| `[inf]` | my inference, stated as such |

**Core is missing from the bundle.** Widget Core (`runtime.js`), the call module (`runtime-call.js`), the smart engine (`smart-engine.js`) and the i18n table are referenced by `LD` but not included. Core creates the `.panel` element, binds every `PD` `data-*` hook, supplies `t()`, and toggles most state classes. Anything said about Core comes from code comments in PD/LD/CSS or from `[snap]`. You can't read its handler line numbers from this bundle.

`WYL` and `RPL` strings are **byte-identical** to the `LD` copies. I checked all 7 strings (`WEBYAR_KIT_CSS`, `_CHAT_GLYPH`, `_CLOSE_GLYPH`, `_PING`, `RESPOK_KIT_CSS`, `_CHAT_GLYPH`, `_CLOSE_GLYPH`) and every one matched.

---

## 1. Architecture

### 1.1 Mounting (Shadow DOM, no iframe)

- Singleton guard: `window.__gs_loaded`, plus a check for an existing `<gs-widget>` (LD:29-36).
- Custom element `gs-widget` with `this.attachShadow({ mode: "open" })` (LD:742-753). There is no iframe anywhere.
- `mountShell()` (LD:791-847) does the following:
  - appends `<gs-widget data-version="2026-08-06-smart-engagement-v1">` to `document.body` (LD:38, 808-810);
  - injects a `<style>` holding `SHELL_CSS` (LD:503-664, 813-815);
  - creates `div.shell.pos-bottom-right` (LD:817-824);
  - creates `button.launcher.bottom-right.pending` with `aria-haspopup="dialog"` and `aria-expanded="false"` (LD:826-840);
  - creates `div.error-toast` (LD:842-844).
- Assets are lazy. They load on the first launcher click (`onLauncherClick` → `loadRuntimeAssets`, LD:1543-1558, 1609) or on a silent Smart Engagement preload (LD:1955-1958).
  - In the shadow root: `<link data-gs-runtime>` runtime.css (LD:1799-1811), then `<link data-gs-runtime data-gs-template>` template css (LD:1828-1835), then an optional `<link data-gs-runtime data-gs-template-skin>` (LD:1839-1852).
  - In `document.head`: the registry script, then the renderer (LD:1856-1872), `runtime.js` (LD:1874-1939), the call module (LD:1915-1933), the smart engine (LD:2922-2939), and `<link id="gs-presentation-fonts">`. The fonts link sits at document level so `document.fonts` sees the faces (LD:1574-1582, 1814-1822).
- Init sequence:
  1. `registry.resolve(configData.templateId)`, then `window[descriptor.globalKey].prepare()`. This is a font gate: IRANSans 400/500/600, capped at 500 ms (LD:1671-1687; PD:1781-1791).
  2. `window.__gs_runtime.init(configData, { shadowRoot, shellEl, launcher, setUnread, setOperatorTyping })` (LD:1694-1700).
  3. `instance.open()`, but only if a click asked for it (LD:1728-1730).
- Live tree when open `[snap]`:

```
<gs-widget data-version>  #shadow-root(open)
  <style>SHELL_CSS
  div.shell.pos-bottom-right   style="--gs-primary;--gs-secondary;--gs-shadow;--gs-fab-size;--gs-presentation-font"
    button.launcher.bottom-right.revealed[.pulse][.square][.has-image][.wy-kit… | .rpk-kit…][.open]
      svg.chat-icon  svg.close-icon  [span.wy-kit-ping]  [img.fab-img]  [span.badge]
    [div.gs-fab-label > span.label-title + span.label-sub]
    div.error-toast[.visible][.toast-left]
    div.panel.bottom-right.anim-on[.panel-rtl].visible  dir role="dialog" aria-label="<workspace>"
         tabindex="-1" aria-hidden="false" data-conn-state="online" data-view="home"      ← Core
      div.connection-banner.sr-only[role=status][aria-live=polite]                        ← Core
      button.panel-close[data-panel-close]                                                ← PD:920 shellHtml()
      div.smart-announce[hidden]                                                          ← Core
      div.body.wy-scroll[data-body]   → exactly ONE .wy-view inside                       ← PD:925
      div.gs-call-host[data-call-host][hidden]                                            ← PD:931
      div.att-lightbox[data-att-lightbox][hidden][role=dialog][aria-modal=true] …         ← PD:932-937
      div.sr-only[aria-live=polite][role=status]   (message announcer)                    ← Core
    [div.smart-nudge.<pos>]                         (launcher nudge)                      ← LD:2716-2730
  <style data-wy-kit> or <style data-rpk-kit>                                              ← LD:709-715 / 732-738
  <link runtime.css> <link presentation-default.css> [<link presentation-intl.css>]
```

- Other boot paths:
  - **Launcher-only mode.** No API base or no workspace id. The launcher is neutral grey `#6B7280`, and a click shows the toast `notConfigured` (LD:1192-1201, 1386-1397).
  - **Widget disabled.** If `data.disabled` is set, the shell is removed (LD:1232-1236).
  - **Hidden while offline.** The shell is removed when `availability.offline_mode === 'hide_widget'`, the state is offline, and there is no `gs_active` cookie (LD:1243-1256).
  - **`gs_active`** (first-party, one day) is set by the runtime while the visitor has an open or pending thread (the thread list's statuses) and cleared when none is left; with it the loader boots the runtime silently on the next page view, so a reply shows on the launcher (badge, preview, title). A publication on the visitor's presence channel (`services/widget/visitorWake.ts`, an operator's message) does the same on the page the visitor is on.
  - **Not enabled.** If `config.enabled` is falsy, nothing more happens (LD:1314).
- Public API: `window.__gs.push([cmd, …])` with these commands:
  - `open`, `close`, `toggle`, `setUnread`, `show`, `hide`;
  - `isOpen(cb)` and `getState(cb)`, which return `{ready, open, visible, unread}`;
  - `identify({name, email, phone})`;
  - `onReady`, `onOpen`, `onClose`, `onMessage`, `onUnreadChange`.
  
  Sources: LD:1343-1360, 1702-1723, 2022-2044. Also `window.__gs_panel_close = triggerClose` (LD:1541).

### 1.2 How the presentation (skin) is chosen

- Registry (REG:33-60):
  - `default` → `presentation-default.js` + `presentation-default.css` + `presentation-default-fonts.css`;
  - `intl` → the **same** script and base css, plus `skin: 'presentation-intl.css'`.
  
  Both register under `window.__gs_presentation_default` (REG:41, 54). The legacy id `web-yar` maps to `default` (REG:67), and unknown ids fall back to `default` (REG:69-73).
- The choice is made on the **server**. `/api/widget/config` returns `templateId` plus hashed asset URLs: `presentationRegistryUrl`, `presentationUrl`, `presentationStyleUrl`, `presentationFontsUrl`, `presentationSkinUrl`, `styleUrl`, `runtimeUrl` (LD:1625-1639). The REG:47-50 comment says "The server picks it per edition".
- Load order makes intl tokens win: runtime.css → presentation-default.css → presentation-intl.css. A failed skin is non-fatal (LD:1837-1852).
- The launcher kit is chosen separately from the template:
  - **WebYar kit:** `config.edition === "iran"` and `templateId` is empty or `"default"` (LD:681-685).
  - **RESPOK kit:** `config.edition === "international"` and `config.templateId === "intl"` (LD:729-731).
  - **Plain launcher:** anything else.
- In the snapshots, every `fa-*` capture is the default template with the WebYar kit, and every `en-*` capture is the intl skin with the RESPOK kit `[snap]`.

### 1.3 Locale and direction

- Renderer: `env.locale` comes from Core, and `isRtl()` is true only when the base language is `fa` (PD:60). Each view root writes its own `dir`:
  - chat writes `dir="rtl"` only when fa, and never writes `ltr` (PD:954, 1132);
  - home, list, kb and the skeletons use `vm.rtl` (PD:1266, 1313, 1456, 1540, 1633, 1649, 1673, 1686, 1699);
  - prechat and fallback always write `rtl` or `ltr` from the locale (PD:829-830, 847, 870);
  - the handoff card does the same (PD:804, 809).
- Core writes `dir` and the `.panel-rtl` class on `.panel` `[snap]`, as noted in CSS:47-48. No CSS rule targets `.panel-rtl`.
- Some parts are always LTR:
  - the audio player `div.msg-att-audio[dir=ltr]` (PD:295);
  - the voice-note bar `div.vn-bar[dir=ltr]` (PD:1090);
  - email and phone inputs `dir="ltr"`, in **every** locale (PD:581, 586).
- Loader strings use `configData.locale || <html lang> || navigator.language` (LD:899-902). The nudge gets `dir="rtl"` for `fa`, `ar`, `he` or `ur` (LD:2724-2727). That is wider than the renderer, which treats only `fa` as RTL.
- Calendar: fa uses Jalali in `Asia/Tehran` unless `config.calendar === 'gregorian'`, which gives Gregorian with Persian digits in the visitor's zone or in `config.timeZone` (PD:500-526).

### 1.4 Accent and theme tokens

| Property | Set at | Value / default | Used by |
|---|---|---|---|
| `--gs-primary` | inline on `.shell` (LD:1101) | `config.primaryColor`, else `#3B82F6`. Launcher-only/error mode: `#6B7280` (LD:1389) | launcher bg (LD:532), nudge (LD:607, 619), focus ring (RT:47), `--wy-accent` |
| `--gs-secondary` | inline on `.shell` (LD:1103-1106) | `secondaryColor`, else `primaryColor`, else `#6366F1` | **unused** in the provided CSS |
| `--gs-shadow` | inline on `.shell` (LD:1107) | `rgba(r,g,b,.34)` from the accent; `rgba(0,0,0,.22)` if the hex is invalid (LD:1088-1095) | launcher shadow (LD:530, 542; CSS:160) |
| `--gs-fab-size` | inline on `.shell` (LD:1008) | round(56 or 60 × scale) px | launcher, icons, label, nudge offset |
| `--gs-fab-exit` | on `.launcher` / `.gs-fab-label` (LD:528, 568) | `calc(var(--gs-fab-size,56px) + 56px)` | slide-out distance |
| `--gs-vvh` / `--gs-vvo` | inline on `.shell` (LD:1449, 1452) | visualViewport height / offsetTop | mobile full-screen |
| `--gs-presentation-font` | FONTS:16-21 (`:root`), copied onto `.shell` (LD:1588-1596) | `'IRANSans','InterWY',-apple-system,…` | `.shell` font (LD:511) |
| `--wy-*` | `:host, .shell` (CSS:22-41; message tokens CSS:1950-1963) | see tokens.json. `--wy-accent: var(--gs-primary, #1f93ff)` (CSS:34) | the whole template |
| intl overrides | `:host, .shell` (INTL:17-35, 70-81) | `--wy-accent: var(--gs-primary, #ff5a3c)` (INTL:29), radii 0.375/0.625/0.875/1.125rem, etc. | |
| kit-local | inside the kit CSS (LD:673, 726) | `--wy-kit-dot`, `--wy-kit-ring`, `--rpk-kit-accent`, `--rpk-kit-away` | launcher kits only |
| `--wy-primary` | **never defined** | falls back to `#1f93ff` | voice player button and progress (CSS:941, 944, 972) |

The accent also arrives as **`env.primaryColor`**, and the renderer inlines it in two places:
- the visitor bubble, `style="background:<primaryColor>"` (PD:665);
- the home-card smart CTA (PD:902).

Inline styles beat the stylesheet unless the stylesheet uses `!important`.

Some colours are hard-coded tints of the default `#1f93ff` and ignore the accent: `rgba(31,147,255,…)` at CSS:160, 325, 327, 566, 772, 804, 870-871, 1758, 1809.

### 1.5 Customer config options that affect look or layout

| Key | Read at | Default | Effect |
|---|---|---|---|
| `primaryColor` | LD:1101, 686-689 | `#3B82F6` | accent. Empty or `#3b82f6` counts as "uncustomised", which switches on kit brand mode (gradient or Ink) |
| `secondaryColor` | LD:1105 | primary or `#6366F1` | `--gs-secondary` (unused) |
| `position` | LD:1110, 2383, 2719 | `bottom-right` | `"bottom-left"` flips the shell, launcher, label, nudge and toast |
| `fab.scale` | LD:943-948, 999 | 1 | accepts 80–140 (%) or 0.8–1.4, clamped |
| `fab.shape` | LD:1013 | `circle` | `"square"` adds `.square` (16px radius) |
| `fab.animation` | LD:1014 | off | `=== true` adds `.pulse` |
| `fab.icon` | LD:1016 | `chat` | one of `chat`, `message`, `help`, `headset`, `phone`, `sparkles`, `smile` (LD:931-939) |
| `fab.iconColor` | LD:1015 | `#ffffff` | inline `color` on the launcher |
| `fab.imageUrl` | LD:1017-1022 | none | http(s) only; adds `img.fab-img` + `.has-image` |
| `fab.label` / `fab.subLabel` / `fab.textColor` | LD:1063-1083 | none | the `.gs-fab-label` card |
| `edition` + `templateId` | LD:681-685, 729-731 | plain launcher / `default` | kit + skin |
| `availability.state` | LD:1030, 1045, 1267 | online | kit offline/away state; home copy (via the vm) |
| `workspaceName` or `brandName` | PD:27 | `''` | header title; avatar initial (fallback `W`, PD:117) |
| `showLogo` | PD:109 | shown | `=== false` removes the avatar entirely |
| `logoUrl` | PD:110-116 | none → initial on an accent circle | header/list avatar image |
| `poweredBy {text, brand, url, logo}` | PD:133-162 | absent, and no `platformName` → **no footer** | footer credit; `logo` must be http(s) |
| `showPoweredBy` / `platformName` | PD:134-135 | | `false` hides the credit; `platformName` is the brand fallback |
| `replyTimeText` | PD:187-193 | locale default `homeReplyFast` / `homeReplySlow` | header subtitle. `''` hides it, which also gives a one-line header and skeleton |
| `welcomeMessage` | PD:220-222 (chat); vm (home) | `t('intro')` / `t('homeWelcome')` | welcome bubble / home welcome |
| `aiAgent.suppressGreeting` | PD:216-219 | false | no welcome bubble |
| `teamMembers[].avatar_url` or `.avatar` | PD:224-231 | | welcome-bubble avatar |
| `readReceipts.enabled` | PD:634-635 | true | ticks on or off |
| `attachments.enabled` / `.voiceNotesEnabled` / `.allowedMimes` | PD:971-975, 1004, 1048-1051 | `false` / `false` / `[]` | attach button + chip; mic, recorder and voice-note bar |
| `composer.emojiEnabled` | PD:976 | true | emoji button + picker |
| `calendar` / `timeZone` | PD:512-520 | Jalali in Tehran | day dividers |
| `smart {enabled, rules, engineUrl, aiProactive}` | LD:1336-1339, 2105-2114 | off | nudge and panel surfaces |

**Not configurable** in these files: offsets (fixed at 24px, or 12px at ≤640px), z-index, panel size, fonts (template-owned), composer layout ("fixed design spec — nothing here is configurable", CSS:1383).

---

## 2. Panel frame

| Aspect | Value | Source |
|---|---|---|
| Element | `div.panel.bottom-right` (or `.bottom-left`), created by Core as a sibling of the launcher inside `.shell`. Attributes: `dir`, `role="dialog"`, `aria-label=<workspace>`, `tabindex="-1"`, `aria-hidden`, `data-conn-state`, `data-view` | `[snap]` |
| Desktop size | **420 × 680 px**, `max-height: calc(100dvh - 118px)`, `max-width: calc(100vw - 24px)` | CSS:79-82. The CSS:77-78 comment: "source canvas is 380×600 … product canvas is 420×680". Measured 420×680 in `fa-02-home.png` `[shot]`. README's "about 400×680" is out of date |
| Anchor | `.shell` is a 0×0 `position:fixed` box at `bottom:24px; right:24px` (or `left:24px`) (LD:511-514). `.panel` is `position:absolute; bottom:0; right:0` (or `left:0`), with `transform-origin: bottom right` (or `left`) | CSS:73-112 |
| Result | The panel's corner sits on the launcher's corner, 24px from both viewport edges, so the panel covers the launcher spot | `[shot]` |
| Look | `background: var(--wy-surface)`; `border-radius: var(--wy-radius-xl)` (20px default, 18px intl); `box-shadow: var(--wy-shadow)`; `overflow:hidden`; flex column | CSS:83-89, 38-39; INTL:33-34 |
| Closed | `opacity:0; transform: translateY(16px) scale(0.97); pointer-events:none` | CSS:91-95 |
| Open | `.panel.visible { opacity:1; transform: translateY(0); pointer-events:auto }`. Core toggles `.visible` `[snap]` | CSS:113 |
| Transition | `transform .3s cubic-bezier(0.22,1,0.36,1), opacity .2s ease`. `.shell.no-anim .panel` turns it off | CSS:96, 114 |
| Launcher while open | `.launcher.open` slides down by `--gs-fab-exit` (size + 56px), `pointer-events:none`, over `.28s cubic-bezier(.22,1,.36,1)`. On close the loader replays a 280 ms WAAPI rise for the launcher and label | LD:528, 531, 561-562, 1514-1537, 955-995 |
| Close control | `button.panel-close[data-panel-close]`, absolute `top:12px; inset-inline-end:12px; z-index:20`, 40×40, radius 12px, 1px `--wy-border`, card background, 18px X | PD:920-924; CSS:1822-1843 |
| View swap | `.wy-view` runs `animation: wy-view-in .26s`. `@keyframes wy-view-in` is declared **twice** (CSS:191 translate+fade, CSS:502 fade-only) and the later one wins, so it is a fade. The skeleton→content crossfade is 150 ms via `.wy-crossfade > .wy-view`, a class Core sets on the view host | CSS:184-195, 497-502 |
| Body | `.body` padding is `14px 16px 4px`, but `.body:has(> .wy-view)` has padding 0 and a flex column | CSS:579-587 |

**Mobile (breakpoint `max-width: 640px`).** The same value appears at LD:515 and 522, in `isPhoneViewport` at LD:1443, and at CSS:121 and 1377.

- **Closed.** Shell offsets drop to 12px (LD:515-516). The launcher keeps its configured size (LD:592).
- **Open.** If `isOpen && isPhoneViewport()`, the loader adds `.gs-mobile-open` to `.shell` (LD:1455-1470). The shell then becomes `top:0;left:0;right:0;bottom:auto;width:100vw;height:var(--gs-vvh,100dvh)` (LD:523-524).
- **Hidden while open.** `.launcher`, `.fab-label` and `.smart-nudge` get `display:none!important` (LD:525-526). The selector `.fab-label` does **not** match the real class `gs-fab-label` (LD:1067); the label only disappears because `.gs-fab-label.open` slides it away (LD:575).
- **The sheet.** `.shell.gs-mobile-open .panel` gets `inset:0; width/height 100%; border-radius:0; box-shadow:none; transform-origin: bottom center; padding-top: env(safe-area-inset-top,0px); padding-bottom: env(safe-area-inset-bottom,0px)`. `.visible` then means `transform:none` (CSS:122-136). `.panel-close` moves to `top: calc(env(safe-area-inset-top,0px) + 12px)` (CSS:145).
- **First frame.** Before `.gs-mobile-open` arrives, the panel is `calc(100vw - 24px)` wide and `calc(100dvh - 120px)` tall (CSS:138-142).
- **Keyboard and URL bar.** `--gs-vvh` holds `visualViewport.height` and `--gs-vvo` holds `offsetTop`. The shell also gets an inline `transform: translateY(offsetTop)` while locked. Listeners: visualViewport `resize` and `scroll`, plus window `orientationchange` (LD:1445-1454, 1476-1481).
- **Host scroll lock.** `body{position:fixed; top:-scrollY; width:100%; overflow:hidden}` and `html{overscroll-behavior:none}`. Close restores them and calls `scrollTo` (LD:1459-1499).
- **Safe areas.** Only the top and bottom insets are handled; left and right are not. Platform note: `env()` insets are non-zero only when the host page uses `viewport-fit=cover`.
- **Call surface.** At ≤640px the PiP is 80×108 and the buttons are 56px (CSS:1377-1381).

**Z-index**

| Element | z-index | Source |
|---|---|---|
| `.shell`, at host-page level | 2147483646 | LD:512 |
| `.launcher` / `.gs-fab-label` / `.smart-nudge`, inside the shell's stacking context | 2 / 2 / 6 | LD:527, 567, 596 |
| `.panel` | 2147483000 | CSS:76 |
| `.error-toast` | 2147483647 | LD:587 |
| `.wy-jump` / `.panel-close` / `.gs-call-host` / `.att-lightbox` | 4 / 20 / 30 / 2147483100 | CSS:612, 1826, 1142, 998 |

The CSS:75 comment says the panel sits "below the loader's launcher (2147483646)". That's wrong in practice: the launcher's own z-index is 2 inside the same stacking context, so the panel stacks **above** it. It doesn't matter today because the launcher is slid away while the panel is open.

`[inf]` On desktop the `position:fixed` lightbox (CSS:997-998) only covers the panel. `.panel.visible` keeps `transform: translateY(0)`, which is a non-`none` transform, so the panel becomes the containing block for its fixed children.

---

## 3. Launcher

### 3.1 Behaviour shared by all launcher variants (`button.launcher`, LD:826-840)

- **Size.** `--gs-fab-size = round(base × scale)`. The base is 56px for the plain launcher and 60px for either kit (LD:1003; WYL:33; RPL:34). The scale is clamped to 0.8–1.4 (LD:943-948), so plain is 45–78px and kits are 48–84px.
- **Shape.** Circle, `border-radius:50%` (LD:529), or `.square` at 16px (LD:546). The template's `.launcher{border-radius:9999px}` (CSS:153) loses to `.launcher.square` on specificity.
- **Icon.** The icon box is 46% of the size (LD:577; CSS:174). `FAB_ICONS` are 24-unit stroke icons: `chat` (round speech bubble), `message` (rectangle bubble with tail), `help` (question mark in a circle), `headset`, `phone`, `sparkles`, `smile` (LD:931-939). Before config arrives, the `message` glyph and an X are shown (LD:837-839). The close icon is an X, `M18 6L6 18M6 6l12 12` (LD:1054).
- **Colour.**
  - Background `var(--gs-primary)` (LD:532).
  - Icon colour inline, from `fab.iconColor` (LD:1015).
  - Shadow `0 3px 12px -4px var(--gs-shadow), 0 0 0 1px rgba(0,0,0,.03)` (LD:530). Once the runtime has loaded, the template's `.launcher` rule (CSS:150-163, shadow `0 4px 14px -4px var(--gs-shadow…)`) also applies.
- **Image.** `img.fab-img` covers the button. On hover it fades out and scales to .88 over .2s, revealing the icon (LD:553-556). The comment there says "clip-path circle", but the CSS actually uses opacity + scale.
- **Label card.** `div.gs-fab-label > span.label-title [+ span.label-sub]` (LD:1059-1083).
  - Position: inline `right` (or `left`) = `size + 10px`, on the same bottom line.
  - Box: height `size − 4px`, `padding:0 16px`, radius `.9rem`, background `#fff`, shadow `0 8px 20px rgba(0,0,0,.12)`.
  - Text: title 13px/600 `#1c2024` (or `fab.textColor`); sub 11px `#60646c`.
  - Behaviour: `pointer-events:none`. It slides with the launcher (`.enter`, `.open`; transition .62s `cubic-bezier(.33,1,.68,1)`) (LD:567-575).
- **States.**
  - `pending`: hidden until config (LD:539, 830).
  - `revealed`: visible (LD:541, 1120).
  - Entry: slides up from `translateY(--gs-fab-exit)` with a WAAPI 280 ms `cubic-bezier(.22,1,.36,1)`. With reduced motion it jumps straight to rest (LD:955-995, 1140-1142).
  - `:hover`: `translateY(-2px) scale(1.04)` over .18s (LD:542).
  - `:active`: `scale(.92)` (LD:543).
  - `.pulse`: `gs-fab-pulse` 2.4s × 2, peaking at scale 1.07 (LD:547-548).
  - `.open`: slid off-screen. The chat/close icon swap (LD:580) therefore happens out of view.
- **Unread badge.** `span.badge[aria-hidden="true"]` is appended to the launcher (LD:1961-2002).
  - Look: min 18×18, radius 9, `#EF4444`, 11px/700, 2px white border, top/right −2px (LD:582-584).
  - Text: `"9+"` above 9 (LD:1969).
  - Accessibility: the count lives in the launcher `aria-label` ("Open chat — N unread messages", LD:909-917).
  - The template's `.launcher-badge` rule (CSS:177-181) is dead; nothing emits that class.
- **ARIA.** `aria-haspopup="dialog"`, `aria-expanded` and `aria-label` are localised from `LOADER_STRINGS` (LD:834-836, 909-919).
- **Error toast.** `div.error-toast.visible` shows for 6 s at fixed `bottom:92px; right:24px`, or `left` with `.toast-left` (LD:585-591, 921-926, 1149-1151).
- **Position.** Set by `config.position`. Offsets are not configurable.

### 3.2 WebYar kit (`.wy-kit`, Iranian edition): WYL, mirrored at LD:666-715

- **Brand mode `.wy-kit-brand`** applies when the accent is empty or `#3b82f6` (LD:680, 686-689, 1029):
  - background `linear-gradient(140deg,#22D3B4,#0B7D6C)`;
  - shadow `0 12px 28px rgba(11,125,108,.36),0 3px 8px rgba(18,20,31,.16)`;
  - dots `--wy-kit-dot:#18AD94`, ring `--wy-kit-ring:#16C7A8`.

  With a custom accent there is no gradient: the background is the accent, the dots use `--gs-primary`, and there is no offline recolour (WYL:26-29).
- **Chat glyph** (`svg.chat-icon.wy-kit-glyph`, viewBox 0 0 60 60, full-bleed) (LD:674):
  - `path.wy-kit-body` is a white comma/teardrop speech bubble, a circle with a tail curling to the bottom-left, filled `currentColor`;
  - three small diamonds `path.wy-kit-dot.wy-kit-d1`, `.wy-kit-d2` and `.wy-kit-d3` sit on its centre line.
  
  If `fab.icon` is not `chat`, the plain FAB icon is used instead (LD:1033-1035).
- **Close glyph.** A down-chevron, `path.wy-kit-chev` `M22 27l8 8 8-8`, stroke 3.2 (LD:675). The ring is `span.wy-kit-ping` (LD:676).
- **Entrance `.wy-kit-enter`.** The class is removed after 1400 ms (LD:1134-1137).
  - Button: `wy-kit-fab-in` .62s `cubic-bezier(.2,1.25,.4,1)`, from `translateY(18px) scale(.6)` and opacity 0.
  - Body: `wy-kit-body-in` .5s, delay .12s.
  - Dots: `wy-kit-dot-in` .32s at delays .45s, .65s and .85s.
- **Hover.** `translateY(-3px) scale(1.06)` over .22s, a deeper shadow, and a dots wave of .62s (delays 0, .08s, .16s).
- **Ping `.wy-kit-pinging`.** Fires 6 s after the entrance if the chat is still closed. The ring runs `wy-kit-ping` 1.8s × 2, growing to scale 1.75 while fading, and the class is cleared after 3.8 s (LD:694-702, 1138).
- **Typing `.wy-kit-typing`.** The operator-typing signal from Core, via `setOperatorTyping` (LD:705-708, 1699). The dots bob 1.3s on an infinite loop, at delays 0, .16s and .32s.
- **Open and close.**
  - Open: the chat glyph turns to `rotate(-35deg) scale(.3)` at opacity 0, and the chevron goes from `rotate(45deg) scale(.6)` to none (.26s `cubic-bezier(.2,.9,.3,1.2)`, delay .06s).
  - Closing: `.wy-kit-closing` lasts 700 ms (LD:1423-1429), and the dots pop back over .26s at delays .12s, .2s and .28s.
- **Unread badge** (LD:1970-1981):
  - 24×24, radius 12, `#FFB423` text on `#12141F`, font `800 13px/24px Vazirmatn,Tahoma,'Segoe UI'`;
  - 3px white ring, top/right −6px, `wy-kit-badge-in` .45s;
  - **Persian digits** when the locale is fa;
  - the first unread triggers the `.wy-kit-nudge` wiggle (.6s);
  - the badge is hidden when the panel is open.
- **Offline `.wy-kit-offline`** (brand mode only, LD:1030-1031): ground `#12141F`, bubble `#16C7A8`, dots `#12141F`.
- **Reduced motion.** No animation; the glyphs swap with a .15s fade.

### 3.3 RESPOK kit (`.rpk-kit`, International edition): RPL, mirrored at LD:717-738

- **Brand mode `.rpk-kit-brand`** uses the same colour rule (LD:1044): ground `#16142B` (Ink), shadow `0 10px 28px rgba(22,20,43,.28)`, `--rpk-kit-accent:#FF5A3C`, `--rpk-kit-away:#A9A7BC`.
- **Chat glyph** (viewBox 104×92; the svg is 50% × 44.23% of the button, centred) (LD:727):
  - `path.rpk-kit-q` is a white "question" pill at the top-left with a squared bottom-left corner, filled `currentColor`;
  - `path.rpk-kit-a` is the "answer" pill at the bottom-right with a squared bottom-right corner, filled `--rpk-kit-accent`.
- **Close glyph.** A chevron `M6 9l6 6 6-6`, stroke 2.5, at 43% (LD:728).
- **Pointer and focus states.**
  - Hover: `scale(1.06)` over .16s, with a deeper shadow.
  - Active: `scale(.94)` over .09s.
  - `:focus-visible`: `0 0 0 3px #fff, 0 0 0 6px #FF5A3C`.
- **Open.** The glyph turns to `rotate(90deg) scale(.6)` at opacity 0, and the chevron goes from `rotate(-90deg)` to none (.2s).
- **Away `.rpk-kit-away`** (offline, any colour, LD:1045): the answer pill becomes a 7-unit outline in `--rpk-kit-away`.
- **Unread badge** (LD:1982-1994):
  - 22×22, `#D3361A`, 2px white border, 12px/700, `rpk-kit-badge-in` .34s;
  - `.rpk-kit-bump` (.32s) when the count rises while the badge is already showing;
  - `.rpk-kit-still` when the count falls;
  - `.rpk-kit-arrive` slides the answer pill in from the right over .36s when the count rises while the panel is closed (cleared after 420 ms).
- **Entrance.** No kit-specific entrance; it uses the plain 280 ms slide.
- **Reduced motion.** A .12s fade.

---

## 4. Views

Exactly one `.wy-view` is mounted inside `div.body[data-body]` (PD:907-918). Core sets `.panel[data-view]`; the values seen are `home`, `chat`, `help` and `list`. The pre-contact form mounts while `data-view="chat"` `[snap]`.

Most headers share one identity block, `headerIdentityHtml(opts)` (PD:196-208):

```
[button.wy-back[data-view-back]] [span.wy-avatar.wy-avatar-md (.has-img > img) or initial]
div.wy-head-text > span.wy-head-title > [span.wy-online-dot][stack] span(title)  ;  [span.wy-head-sub]
```

No current caller passes `online`, `stack` or `avatarSize`, so `.wy-online-dot` (styled at CSS:254, 264) is never emitted.

### 4.1 Home: `homeHtml(vm)` (PD:1176-1287)

```
div.wy-view.wy-view-home.home-root[dir=rtl]
  div.wy-head.wy-head-home            title: vm.workspaceName or vm.headerTitle; subtitle: replyTimeText(vm.isOnline)
  div.wy-home-body
    div.wy-scroll.wy-home-scroll
      [section.smart-home-card > smartSurfaceHtml(vm.smartSurface)]                       (mode 'home_card')
      section.home-greeting-block > h2.home-greeting (t homeGreeting) + p.home-welcome (vm.welcomeMessage or t homeWelcome)
      [section.home-section.home-recent > h3.home-section-title + ≤3 compact conv rows + button.home-link[data-view=list] > span.home-link-chevron]
      [section.home-section.home-conv-error > p.home-conv-error-text + button.home-link[data-home-action=conversations-retry]]
      [section.home-section > h3.home-section-title + div.home-chips > ≤5 button.home-chip[data-home-article=<slug>] + button.home-chip.home-chip-more[data-view=help]]
    div.wy-actions-block
      div.wy-actions > [button.wy-btn.wy-btn-primary[data-conversation-open=<unresolved id>]]
                       + button.wy-btn.(wy-btn-primary or wy-btn-outline).wy-btn-grow[data-home-action=chat] ([span.home-stack > ≤3 span.home-stack-item.has-img > img] + label)
      div.wy-footer
```

- **CTA rules** (PD:1250-1260):
  - If an unresolved conversation exists: a primary "Continue last conversation" button plus an outline `wyStartNew` button.
  - Otherwise: one primary button with the online-team avatar stack and `homeStartChat` when online, or `homeLeaveMessage` when offline.
  - `showArticlesButton` is hard-coded `false`, so the outline `data-view="help"` button is never rendered (PD:1190, 1261-1264).
- **Offline home** is the same view. The subtitle becomes `homeReplySlow` and the CTA becomes `homeLeaveMessage` `[shot fa-08]`.
- **VM fields:**
  - `rtl`, `isOnline`, `chatEnabled`, `kbEnabled`;
  - `conversations[] {id, status, preview, timeLabel, unreadCount, title}`, `conversationsError`;
  - `articles[] {slug, title}`;
  - `showTeamAvatars`, `teamMembers[] {online, avatar, name}`;
  - `smartSurface {mode, title, body, ctaLabel, dismissible}`;
  - `workspaceName`, `headerTitle`, `welcomeMessage`.

### 4.2 Chat: `chatFrameHtml(vm)` (PD:950-1140)

Core builds the frame **once** and renders the message list into `[data-chat-messages]` (PD:941-949).

```
div.wy-view.wy-view-chat[dir=rtl]
  div.header.wy-head.wy-head-chat[data-chat-header]  back[data-view-back=home] + identity (subtitle replyTimeText(true))
    div.presence.sr-only[data-presence][aria-live=polite] > span.presence-dot[data-presence-dot] + span.presence-label[data-presence-label]
  div.wy-chat-scroll-host
    div.wy-chat-scroll.wy-scroll[data-chat-messages]      ← messagesHtml()/emptyHtml() output
    button.wy-jump[data-chat-jump][hidden] > span.wy-jump-ico + span.wy-jump-label[data-chat-jump-label]
  div.smart-chat-dock[hidden]                              ← Core [snap]
  div.composer-zone[data-composer-zone]   (only if vm.chatEnabled; otherwise just the footer)
    typing row · reply preview · emoji picker · input-bar (see §5.7) · div.wy-footer
```

- **Frame VM:** `config.attachments`, `config.composer`, `chatEnabled`, `locale`, `workspaceName`, `brandName`. The renderer also reads `navigator.mediaDevices.getUserMedia` and `window.MediaRecorder` (PD:973-974).
- **`messagesHtml(s, extraRowHtml, view)`** (PD:630-796):
  - `s.messages[]` fields: `sender`, `senderType`, `senderName`, `senderAvatar`, `time`, `body`, `attachment`, `status`, `localId`, `replyTo`, `metadata`, `__id`, `from`/`author`;
  - `s.aiThinking`;
  - `view.typewriter {id, tokens, revealedCount}`;
  - `view.qna {questions, expanded, collapsedCount}`;
  - Core can append `extraRowHtml`.
- **`emptyHtml()`** (PD:215-237) produces `div.messages.welcome-only > div.msg-row.operator > [span.msg-avatar.has-img] + div.msg.operator.welcome-bubble`. It has no column, actions or meta. With `suppressGreeting` it produces an empty `div.messages.welcome-only`.
- **Offline "leave a message"** in the snapshots (`*-09`) is this chat view showing only the welcome bubble. Core gives the send button `title` "Disabled while offline" `[snap]`.

### 4.3 Conversation list: `conversationListHtml(vm)` (PD:1292-1326)

```
div.wy-view.wy-view-list[dir]
  div.wy-head.wy-head-list > back[data-view-back=home] + div.wy-head-plain (wyConversations) + [button.wy-fab[data-home-action=chat][aria-label=New conversation] > plus]
  div.wy-body-pad.wy-list-body > div.wy-scroll.wy-list-scroll > BODY + div.wy-footer
```

- **BODY** has four states:
  - error with no items: `div.wy-empty.wy-conv-error > p + button.wy-btn.wy-btn-outline[data-home-action=conversations-retry]`;
  - loading: `skeletonConvRowsHtml(6)`;
  - items: one full row each;
  - none: `div.wy-empty > p`.
- **Full row** (PD:1161-1173):
  ```
  button.conv-row[data-conversation-open]
    span.wy-avatar.wy-avatar-sm
    span.conv-main
      span.conv-line > span.conv-name + span.conv-time
      span.conv-line > span.conv-preview + span.conv-unread
      span.conv-status[.is-resolved] > span.conv-status-dot + Open/Resolved
  ```
- **Compact row** (home, PD:1153-1157): `button.conv-row.conv-row-compact[data-conversation-open] > span.conv-preview + span.conv-unread + span.conv-time`.
- **Unread count** uses `fmtNum` (Persian digits in fa), shown as `99+` above 99 (PD:1147-1150). `timeLabel` arrives pre-formatted, e.g. "۱۰ دقیقه پیش" `[snap]`.
- **VM fields:** `rtl`, `conversations`, `error`, `loading`, `chatEnabled`.

### 4.4 Help center and article: `kbHtml(vm)` (PD:1431-1463)

```
div.wy-view.wy-view-kb.kb-root[dir]
  list or results:  div.wy-head > identity (back home, subtitle wyArticles)
  article:          div.wy-head.wy-head-article > button.wy-back[data-view-back=back][data-view-back-fallback=home] + span.wy-avatar.wy-avatar-sm + div.wy-head-plain.wy-head-article-title
  div.wy-body-pad.wy-kb-body > div.wy-scroll.wy-kb-scroll > INNER + div.wy-footer
```

- **INNER** depends on `vm.state`:
  - `list` uses `kbHomeHtml`: `div.kb-list > button.kb-article[data-kb-action=open][data-kb-slug] > span.kb-article-title + span.kb-article-chevron`. Categories are ignored (PD:1387-1392).
  - `searching` shows 6 skeleton rows.
  - `results` uses `kbSearchResultsHtml`.
  - `article` uses `kbArticleHtml`.
- **Empty state** (PD:1353-1364): `div.kb-empty > div.kb-empty-icon (book or search, 40px) + p.kb-empty-text + [button.wy-btn.wy-btn-primary[data-kb-action=switch-chat]]`.
- **Article** (PD:1421-1428): `div.kb-article-view > div.kb-article-body`. The body is `vm.article.contentHtml`, inserted **unescaped**, followed by the feedback block (§5.14).
- **Search bar.** `kbSearchBarHtml(vm)` produces `div.kb-search-wrap > input.kb-search[type=search]` with no `data-*` hook (PD:1345-1351). It is exported but **not** composed into `kbHtml`, and there is no search input in the snapshots.
- **VM fields:** `state`, `article {title, contentHtml}`, `feedback {enabled, rating}`, `results`, `categories`, `articles`, `emptyText`, `hideChatCta`, `rtl`, `query`.

### 4.5 Pre-chat (pre-contact): `prechatFormHtml(identity, contact, locale)` (PD:823-842)

```
div.wy-view.wy-view-precontact.prechat[dir]
  div.wy-head > identity (back home, subtitle wyConnectOperator)
  div.wy-scroll.wy-body-pad > p.prechat-subtitle + div.prechat-fields (field rows) + div.prechat-spacer + button.wy-btn.wy-btn-primary.wy-btn-block.prechat-submit[data-prechat-submit]
```

Name, email and phone appear when `identity.isAsked(key)`; required comes from `identity.isRequired(key)`. Both are server-authoritative (PD:571-572, 818-828).

### 4.6 Contact fallback (offline leave-a-message form): `contactFallbackHtml(identity, contact, locale, presence)` (PD:844-892)

```
div.wy-view.wy-view-fallback.prechat.fallback[dir]
  div.wy-head > identity (back home, subtitle wyLeaveMessage)
  div.wy-scroll.wy-body-pad > p.prechat-intro (presence.introLabel or t fallbackIntro)
     div.prechat-fields > name, email, [phone] rows (data-fb) + div.prechat-field[data-field=message] > textarea#fb-message
     button.wy-btn.wy-btn-primary.wy-btn-block.prechat-submit[data-fb-submit] + div.fallback-status[data-fb-status][role=status]
  div.wy-footer
```

Email is required only when phone isn't asked (PD:867). The message is always required. It isn't in the snapshots, and these files don't show when Core picks this form over the chat view.

### 4.7 Inline handoff pre-chat card: `handoffPrechatCardHtml(…)` (PD:798-816)

```
div.msg-row.visitor > div.hc-card[dir][role=group][aria-label] > div.hc-title + div.hc-subtitle + div.prechat-fields.hc-fields + button.wy-btn.wy-btn-primary.hc-submit[data-prechat-submit]
```

When animated, the subtitle is a typewriter host: `[data-typing-host][data-typing-active=1][data-typing-id=hc-subtitle]`. It isn't in the snapshots.

### 4.8 Skeletons: `skeletonHtml(view, vm)` (PD:1720-1731)

- **Keys:** `home`, `chat`, `list`, `prechat`, `help`/`articles`, `article`. Anything else falls back to the home skeleton.
- **Structure.** Each skeleton reuses the real view's classes, adds `.wy-skeleton` to the root, and is `aria-hidden`. They include the real footer (PD:1465-1475).
- **Primitives:** `span.wy-sk` with `.wy-sk-line`, `.wy-sk-circle`, `.wy-sk-chip`, `.wy-sk-btn`, `.wy-sk-pill` or `.wy-sk-field`. Sizes are inline styles (PD:1477-1486).
- **Helpers:** `.wy-sk-back`, `.wy-sk-row`, `.wy-sk-group`, `.wy-sk-chevron`, `.wy-sk-msgs`, `.wy-sk-msg(.is-me)`, `.wy-sk-bubble`, `.wy-sk-input`, `.wy-sk-ico`.
- **VM:** `rtl`, `chatEnabled`, `composer {voiceNotes, attachments, emoji}` (chat), `fields` (1–4, default 2; prechat).
- **Motion.** A 1.6s shimmer (CSS:426-495), switched off under reduced motion (CSS:504-508).
- There is no skeleton for the fallback view.

---

## 5. Components

### 5.1 Message row (PD:630-796; contract restated at INTL:60-69 and CSS:1942-1947)

```
div.msg-day > span(label)                                   new calendar day (PD:556-560, 649)
div.msg-row.(visitor or operator)[.is-last]
  [span.msg-avatar.has-img > img]  or  [span.msg-avatar.msg-avatar-spacer]     operator with senderAvatar only
  div.msg-col
    div.msg-line
      div.msg.(visitor or operator)[.has-att or .has-att-only][.is-ai][.has-tail][style="background:<primaryColor>" (visitor)]
        [span.msg-quote] [span.msg-text] [attachment]
      [span.msg-actions > button.msg-act[data-msg-reply…] + button.msg-act[data-msg-copy]]     only when there is text
    [div.msg-footline > div.msg-meta > [span.msg-ai-badge[role=img] > svg][span.msg-sender] [span.msg-time] [ticks / failed + retry]]   .is-last only
```

- **Grouping.**
  - The group key is author + calendar day. The visitor's key is `v`; an operator's is `op:<senderName>|<senderAvatar>` (PD:638-643).
  - The last row of a run gets `.is-last`, and its bubble gets `.has-tail`.
  - Only that last row carries the avatar image and the meta line. Earlier rows get a spacer, and only when `senderAvatar` exists. Operators without an avatar get no avatar layer at all (PD:671-673, 698-710).
- **Sides are physical in both directions:** operator on the left, visitor on the right (CSS:648-659; INTL:66-69).
- **Rhythm.**
  - Gap 12px between groups, with `margin-bottom:-9px` on non-last rows (CSS:1967-1968).
  - Bubble padding 8/13px (fa) or 8/12px (intl); line height 22px (fa) or 20px (intl).
  - Radius 18px, with 6px on the joining corners (CSS:1950-2009; INTL:70-127).
- **Operator bubble colour:** `#eef1f4`, no border, text `#12141f` (CSS:1985-1989). Intl uses `#efeef4` (INTL:103-107).
- **Time:** `toLocaleTimeString(locale, {hour:'2-digit', minute:'2-digit'})` (PD:492-498), which gives Persian digits in fa ("۱۹:۴۱" `[snap]`).
- **Read ticks.** Shown on the visitor's last bubble only, and only when receipts are enabled (PD:686-695; glyphs PD:98-101):
  - `sending` → `span.msg-ticks.is-sending > span.msg-status-spinner`;
  - `delivered` → double tick;
  - `seen` → double tick + `.is-seen` (accent);
  - any other status → single tick.
- **Failed send.** Shown even when receipts are off: `span.msg-ticks.is-failed` "!" + `button.msg-retry-btn[data-msg-retry=<localId>]` (PD:676-685).
- **AI messages.** The bubble gets `.is-ai`. The meta line gets `span.msg-ai-badge` plus an optional `span.msg-sender` (PD:712-718). Since 2026-10-23 (owner) the badge is an icon, not the word: the sparkle (an `aria-hidden` SVG) with `role="img"`, `aria-label` "AI" (`wyAiShort`) and title "AI assistant" (`wyAiAssistant`); `span.msg-sender` is left out when the name is Core's stand-in for a nameless AI (that same "AI assistant"), so only a name the workspace gave the agent is printed. t1 and t2 draw the same badge, without the title.
- **Quote.** `span.msg-quote` comes from `replyTo.text`/`replyTo.body` or from a leading `> ` block in the body (PD:596-615, 727-754).
- **Links.** Core's `linkifyHtml` (PD:54-59) produces `a.msg-link[target=_blank][rel="noopener noreferrer nofollow"][dir=auto]`, labelled "Open link", styled as a pill with `::after '↗'` (CSS:704-763) `[snap]`.
- **Typewriter reveal.** While revealing, the bubble carries `[data-typing-host][data-typing-active="1"]` and the text is `span.msg-text[data-typing-id]` (PD:735-749, 775).
- **Reply and copy actions.**
  - Visibility: `opacity:0` until row `:hover` or `:focus-within`, 0.6 on touch screens (CSS:825-834).
  - Position: absolute, beside the bubble on its open side (CSS:2011-2018).
  - Copy success shows `.msg-act.is-done` (CSS:841, set by Core).
- **Entrance.** `wy-msg-in` .24s; `.msg-row.no-enter` stops the replay (CSS:661-666).
- **Unstyled hooks.** These classes are emitted but have **no CSS rule**, so a re-skin can use them freely: `.has-att`, `.has-att-only`, `.is-ai`, `.is-sending`, `.welcome-only`, `.ai-thinking-row`.

### 5.2 System rows

All share `div.msg-row.system > div.msg-system-pill > svg(12px) + span` (PD:358-361; CSS:844-847):
- **Call ended** (PD:363-383) uses keys `csEndedNotConnected`, `csEndedByOperator`, `csEndedByVisitor` and `csEndedBySystem`, with a `{duration}` of mm:ss or hh:mm:ss in Latin digits (PD:349-356).
- **Routing** (PD:385-408) covers `routing_agent_joined`, `conversation_transferred` (shown as a join), `routing_no_agent_available` and `routing_in_queue`.

### 5.3 Call invitation card (PD:410-481; CSS:1105-1124)

```
div.msg-row.system > div.ci-card.ci-channel-(audio or video).ci-status-<status>[data-ci-card=<invitation_id>][role=group][aria-label]
  div.ci-row > span.ci-icon + div.ci-text > div.ci-title
     pending:  div.ci-body > div + [div.ci-wait]  ;  div.ci-meta.ci-countdown[aria-live=polite] > span.ci-pulse + "{time} left"
     other:    div.ci-meta.ci-status.ci-status-<joined, expired, cancelled or declined>
  pending: div.ci-actions > button.ci-btn.ci-btn-primary[data-ci-action=join][data-ci-id][data-ci-channel] + button.ci-btn.ci-btn-ghost[data-ci-action=decline][data-ci-id]
```

`.ci-err` is in the CSS but not emitted here.

### 5.4 Call surface host

`div.gs-call-host[data-call-host][hidden]` is a panel-level overlay, so the chat stays mounted underneath. It sits at z 30, above `.panel-close` (PD:926-931; CSS:1132-1145).

The surface markup itself comes from the call module, which isn't in the bundle. The CSS hooks cover CSS:1149-1381:

- **Containers:** `.gs-call-surface` or `[data-call-surface]` on a dark `#14161a` stage; `.gs-call-audio`, `.gs-call-video`.
- **Video stage:** `.gs-call-stage`, `.gs-call-stage-placeholder`, `.gs-call-stage-orb`, `.gs-call-stage-msg`, `.gs-call-remote-video`.
- **Picture-in-picture:** `.gs-call-pip`, `.gs-call-pip-off`, `.gs-call-local-video`.
- **Status bar:** `.gs-call-topbar`, `.gs-call-topbar-dot`, `.gs-call-topbar-status`, `.gs-call-topbar-timer`.
- **Voice stage:** `.gs-call-voice-stage`, `.gs-call-voice-orb`, `.gs-call-voice-pulse`, `.gs-call-voice-icon`, `.gs-call-voice-status`, `.gs-call-voice-timer`, `.gs-call-eq`, `.gs-call-eq-bar`.
- **Controls:** `.gs-call-controls`, `.gs-call-btn`, `.gs-call-btn-toggle` (+ `.off`), `.gs-call-btn-hangup`, `.gs-call-btn-back`.
- **Minimise/expand:** `.gs-call-size`, `.gs-call-size-ico`, `.gs-call-size-min`, `.gs-call-size-max`, `.gs-call-corner`.
- **End states and debug:** `.gs-call-terminal-card`, `.gs-call-terminal-label`, `.gs-call-orientation-debug`.
- **States:** `.gs-call-host.is-mini` is a 168×108 card at `top:64px; inset-inline-end:10px`. `[data-phase=connecting/reconnecting/failed/ended]` colours the status dot.

### 5.5 Attachments in messages (PD:267-331; CSS:875-1008)

- **Image:**
  ```
  div.msg-att.msg-att-image > button.msg-att-img-btn.is-loading[data-att-preview=<id>][aria-label]
     span.msg-att-loading[aria-live=polite] > span.msg-att-spinner + span.msg-att-loading-text ("Receiving…")
     img[data-att-media-src=<id>]   ;   span.msg-att-img-fallback
  ```
  Core removes `.is-loading` once the authenticated fetch finishes. The thumbnail is at most 168×190.
- **File:**
  ```
  div.msg-att.msg-att-file > div.msg-att-icon + div.msg-att-meta(div.msg-att-name[title] + div.msg-att-sub(size)) + a.msg-att-action[href=#][data-att-download][data-att-download-name][aria-label]
  ```
- **Voice note** (always LTR):
  ```
  div.msg-att.msg-att-audio[data-audio-player][dir=ltr]
    audio[data-att-media-src][data-audio-el]
    button.wy-ap-play[data-audio-toggle] > span.wy-ap-ico.wy-ap-ico-play + span.wy-ap-ico.wy-ap-ico-pause + span.wy-ap-spinner
    div.wy-ap-body > div.wy-ap-track[data-audio-seek] > div.wy-ap-buffer[data-audio-buffer] + div.wy-ap-progress[data-audio-progress] > span.wy-ap-knob
                     div.wy-ap-meta > span.wy-ap-time[data-audio-time] "0:00" + button.wy-ap-rate[data-audio-rate] "1×"
    a.wy-ap-dl[href=#][data-att-download][data-att-download-name]
  ```
  States: `.msg-att-audio.is-playing` and `.is-loading`. Its colour comes from the undefined `--wy-primary`, which falls back to `#1f93ff`.
- **Lightbox** (in the shell, PD:932-937): `div.att-lightbox[data-att-lightbox][hidden][role=dialog][aria-modal=true] > button.att-lightbox-close[data-att-lightbox-close] "×" + img[data-att-lightbox-img]`. It uses `rgba(0,0,0,.78)` and fades in over .18s (CSS:996-1008).

### 5.6 Typing indicator and AI thinking

- **Human operator typing** has **no visible row** in the thread. It is announced only through the screen-reader-only `div.sr-only[data-typing-row][hidden][aria-live=polite] > span.typing-label[data-typing-label]` (PD:980-985).
- The only visible typing signal is the WebYar launcher's `.wy-kit-typing`. `.typing-row` in the CSS (CSS:873) is unused.
- **AI thinking row** (PD:617-627) shows when `s.aiThinking` is set and the last message is the visitor's (PD:791-793):
  ```
  div.msg-row.operator.ai-thinking-row > div.msg.operator.ai-thinking-bubble > span.typing-dots[aria-hidden] (3 spans) + span.sr-only
  ```
  The dots bounce on `wy-bounce` 1.2s (CSS:858-868).

### 5.7 Composer (PD:978-1115; CSS:1383-1932)

```
div.input-bar[data-input-bar]   Core adds .has-draft, .is-recording, .is-voice-preview and an inline display:flex
  div.input-wrap[data-input-wrap]           the pill: 16px radius, --wy-card, 1px border-strong ring; focus-within = 2px accent ring (CSS:1850-1859)
    [div.att-preview[data-attach-preview][hidden]]                     pending file/image row ABOVE the input (attachments.enabled)
       div.att-preview-thumb[data-attach-thumb] > img.att-preview-img[data-attach-thumb-img][hidden] + span.att-preview-doc[data-attach-thumb-doc]
       div.att-preview-meta > div.att-preview-name[data-attach-name] + div.att-preview-sub[data-attach-sub] + div.att-preview-track[data-attach-track][hidden] > div.att-preview-bar[data-attach-bar]
       button.att-preview-btn.att-preview-retry[data-attach-retry][hidden] + button.att-preview-btn.att-preview-remove[data-attach-remove]      error state: .att-preview.is-error
    div.input-row[data-input-row]
       [button.mic-btn[data-mic-btn] > svg + span.mic-ring]            first child; .recording state
       textarea.input[rows=1][data-msg-input]                          min/height 50px in chat, max 15rem; Core sets an inline height
       div.composer-actions > div.composer-actions-start > button.send-btn[data-send-btn] + [button.attach-btn[data-attach-btn] + input[type=file][data-attach-input][hidden][accept]] + [button.emoji-btn[data-emoji-btn][aria-expanded]]
       [div.rec-bar[data-rec-bar][hidden]] > button.rec-btn.rec-cancel[data-rec-cancel] + span.rec-live(span.rec-dot + span.rec-time[data-rec-timer][role=timer]) + span.rec-wave(10 i) + span.sr-only[data-rec-sr][role=status] + button.rec-btn.rec-confirm[data-rec-stop]
       [div.vn-bar[data-vn-bar][hidden][dir=ltr]] > button.rec-btn.vn-delete[data-vn-delete] + button.vn-play[data-vn-toggle](.vn-ico-play / .vn-ico-pause) + div.vn-track[data-vn-seek] > div.vn-progress[data-vn-progress] + span.vn-time[data-vn-time] + audio[data-vn-audio] + button.vn-send[data-vn-send]
```

- **Fixed membership.** Every control stays mounted whatever the draft holds. DOM order is send → attach → emoji, which in RTL paints left-to-right as emoji, attach, send (PD:1038-1043).
- **Buttons.** All are 36×36 with an 11px radius in chat (CSS:1870-1882).
- **Send state.** With `.has-draft`, send is solid accent; without it, opacity .55 (CSS:1899-1909).
- **Recording and preview.** `.is-recording` and `.is-voice-preview` hide the input, the actions and the mic, and show the bar. Every mode keeps the same 46px row height (CSS:1484-1568). `.vn-send:disabled` applies while uploading.
- **Voice-note gating.** Needs `voiceNotesEnabled === true` **and** browser support for `getUserMedia` + `MediaRecorder` (PD:973-975).
- **Emoji picker.**
  - Markup: `div.emoji-picker[data-emoji-picker][hidden]`; Core fills it with **50** `button.emoji-item[data-emoji][aria-label]` `[snap]`.
  - Layout: a 6-column grid, max-height 13.25rem (CSS:1698-1708). The emoji button turns accent when `[aria-expanded='true']` (CSS:1895-1898).
- **Reply preview.** `div.reply-preview[data-reply-preview][hidden] > span.reply-preview-bar + span.reply-preview-icon + span.reply-preview-body(span.reply-preview-author[data-reply-preview-author] + span.reply-preview-text[data-reply-preview-text]) + button.reply-preview-cancel[data-reply-cancel]` (PD:986-995). It is fed by `data-msg-reply`, `-text` and `-author`.

### 5.8 Jump to latest

`button.wy-jump[data-chat-jump][hidden]` sits bottom-end inside the scroll host (PD:1117-1130). Core toggles `hidden` and `.has-new`; `.has-new` makes it solid accent. The label is hidden while `:empty` (CSS:605-644).

### 5.9 Presence and connection indicator

- **Presence.** `[data-presence]`, screen-reader only, in the chat header (PD:965-968). Nothing visible is shown.
- **Connection indicator.** `span.wy-conn[data-conn-indicator][aria-hidden] > span.wy-conn-ring + span.wy-conn-dot` sits before the credit in every footer (PD:164, 167-177). Its look comes from Core's `data-conn-state` on `.panel` (CSS:378-424):

| `data-conn-state` | Dot | Ring |
|---|---|---|
| `online` (observed) | green at .75 | hidden |
| `connecting`, `reconnecting`, `loading` | accent | orbits every 1.6s |
| `degraded` | accent at .8 | orbits every 2.6s at .55 |
| `offline` | faint | hidden |

The screen-reader text lives in Core's `.connection-banner` (RT:64-66).

### 5.10 Footer and "Powered by" (PD:127-165)

```
div.wy-footer > span.wy-conn[data-conn-indicator] + (a.wy-powered[href][target=_blank][rel="noopener nofollow"][referrerpolicy="strict-origin-when-cross-origin"] or span.wy-powered)
   inner: span("<label> <brand>")   or, with poweredBy.logo:   span(label) + img.wy-powered-logo[data-wy-brand-logo][alt=<brand>]
```

- `poweredBy.text` is used only when it is written in the widget's script; otherwise `t('poweredBy')` is used (PD:63-65, 140).
- Core swaps a broken logo image back to the brand name.
- The logo is 16px tall in the default skin and 14px in intl (CSS:370-376; INTL:47-53).

### 5.11 Smart engagement

- **Launcher nudge** (loader-owned, mode `launcher_nudge`). `surfaceHtml` (LD:2698-2708) produces `button.smart-dismiss[data-smart-dismiss][aria-label] "×"`, `div.smart-title`, `div.smart-body` and `button.smart-cta[data-smart-cta]`. These sit inside `div.smart-nudge.entering.<bottom-right or bottom-left>[dir]`, appended to `.shell` (LD:2716-2730).
- **Nudge layout.** Max width 288px, positioned `size + 12px` above the launcher, with an accent hairline (`::before`) and a tail (`::after`). The dismiss button sits outside the bubble at the top-right in every direction (LD:596-632; mirrored at CSS:1034-1100).
- **Motion.**
  - `.entering` runs `gs-smart-in` .38s and is stripped on `animationend` or after 480 ms.
  - `.leaving` runs `gs-smart-out` .24s, with removal after `animationend` or 320 ms (LD:2677-2696, 2731-2735).
  - Both animations are gated on an `.anim-on` ancestor; see App. A10.
- **Handlers.**
  - Dismiss → `markRule(dismissed)` + report + clear (LD:2738-2745).
  - CTA → `markRule(cta)` + report + clear + `runAction` (`open_chat`, `open_home`, `open_kb`, `open_article`, `open_url`) (LD:2746-2754, 2653-2670).
  - Auto-hide after `behavior_config.auto_hide_seconds`, default 25 s (LD:2761-2766).
- **AI nudge** (LD:2381-2423) uses the same markup but adds **no** `.entering` and **no** `dir`, and auto-hides after 25 s.
- **Panel-bound modes** (`announcement`, `home_card`, `chat_message`, `open_widget`) go through Core's `inst.showSmart(...)` (LD:2672-2676, 2775-2819).
  - The renderer supplies only `smartSurfaceHtml(s)` (PD:894-905), used inside `section.smart-home-card` on home. Its CTA background is an inline accent.
  - `.smart-announce` and `.smart-chat-dock` are Core containers `[snap]`. `.smart-msg-row .smart-card` is styled (CSS:1023) but its markup isn't in the bundle.

### 5.12 Q&A chips (PD:239-258; CSS:1010-1020)

```
div.qna-suggestions[data-qna] > div.qna-title + div.qna-chips > button.qna-chip[data-qna-question=<text>] … + [button.qna-more-btn[data-qna-more] + span.qna-more-count "+N"]
```

- Collapsed it shows 3; `expanded` shows them all.
- It renders after the message whose `metadata.source === 'ai_agent_intro'`, until the visitor replies (PD:786-787).

### 5.13 Feedback and CSAT (`data-fb*`)

- **There is no conversation CSAT or rating UI** in the renderer or the CSS.
- **`data-fb`, `data-fb-submit` and `data-fb-status` belong to the contact-fallback form** (§4.6), not to feedback.
  - Fields: `input.prechat-input#fb-<key>[data-fb=<key>]` and `textarea.prechat-input.prechat-textarea#fb-message[data-fb=message]`.
  - Submit: `button.prechat-submit[data-fb-submit]`.
  - Status: `div.fallback-status[data-fb-status][role=status][aria-live=polite]` (PD:849-889).

### 5.14 Knowledge-base article rating (PD:1395-1419; CSS:1793-1812)

```
div.kb-feedback[data-kb-feedback] > span.kb-feedback-q + div.kb-feedback-actions > button.kb-rate[.is-up][data-kb-rate=up][aria-pressed] (thumb up + "Helpful") + button.kb-rate[.is-down][data-kb-rate=down][aria-pressed]
   + [span.kb-feedback-thanks]  + [button.wy-btn.wy-btn-primary.kb-feedback-cta[data-kb-action=switch-chat]]   (only after a "down" rating)
```

It renders only when `vm.feedback.enabled`.

### 5.15 Pre-chat field rows and validation (PD:573-594, 849-863)

```
div.prechat-field[data-field=<key>]
  label.prechat-label[for=prechat-<key>] + [span.prechat-req-mark "*" aria-label/title=t('required')]
  div.prechat-control > input#prechat-<key>.prechat-input[data-prechat=<key>][type][autocomplete][dir=ltr (email, phone)][placeholder][aria-required][aria-invalid=false][aria-describedby=prechat-err-<key>] + span.prechat-status[aria-hidden]
  div.prechat-error#prechat-err-<key>[data-err=<key>][role=alert][aria-live=polite]
```

- Visible states: `[aria-invalid='true']` gives a red `#e5484d` border; `.prechat-error:empty` is hidden (CSS:1728-1733). Core writes both the error text and `aria-invalid`.
- `.prechat-status` has no CSS.
- `PRECHAT_ICONS` (PD:564-569) is defined but never used.
- **Gotcha:** `.prechat-input[dir='ltr']{text-align:right}` (CSS:1730) combined with always-LTR email and phone means those fields are **right-aligned in English too** `[shot en-07]`.

---

## 6. Every `data-*` attribute

### 6.1 Counts

| Set | Count |
|---|---|
| Attributes emitted in `PD` markup | **101** |
| Attributes `LD` reads or writes | **20** |
| Shared by both (`data-smart-dismiss`, `data-smart-cta`) | 2 |
| **Distinct across both files** | **119** |

- Comment-only mentions in PD are excluded: `data-conn-state` and the `data-audio-*` wildcard.
- Core writes another 5 that are only observed in the snapshots or targeted by CSS (§6.4).

### 6.2 Wiring

Every PD hook is bound by **Core** (`runtime.js`, not provided), so no handler line can be cited. The "Purpose" column quotes PD comments where they exist. "click" on buttons is `[inf]`, except where PD:677-681 says so: `data-msg-retry`, `-reply` and `-copy` share **one delegated click handler**.

### 6.3 Renderer (`PD`) hooks

| Attribute | Element (class) | Surface | Value | Purpose / wiring (emit line) |
|---|---|---|---|---|
| `data-panel-close` | `button.panel-close` | shell | — | close panel; loader exposes `__gs_panel_close` (LD:1538-1541) (PD:920) |
| `data-body` | `div.body.wy-scroll` | shell | — | view host, one view at a time (PD:907-925) |
| `data-call-host` | `div.gs-call-host[hidden]` | shell | — | call overlay host; `.is-mini` (PD:926-931) |
| `data-att-lightbox` | `div.att-lightbox[hidden]` | shell | — | image lightbox dialog (PD:932) |
| `data-att-lightbox-close` | `button.att-lightbox-close` | shell | — | close lightbox (PD:934) |
| `data-att-lightbox-img` | `img` | shell | — | Core sets src (PD:936) |
| `data-view` | `button.home-link` / `.home-chip-more` / outline `wy-btn` (dead) | home | `list` / `help` | navigate to a tab (PD:1215, 1244, 1262) |
| `data-view-back` | `button.wy-back` | all headers | `home` or `back` | back; `back` = a real step back, then the fallback (PD:123, 1444-1447) |
| `data-view-back-fallback` | `button.wy-back` | article | `home` | target when there's no history (PD:1447) |
| `data-home-action` | `wy-btn` / `.home-link` / `.wy-fab` / `.wy-empty` button | home, list | `chat`, `conversations-retry` | start a chat / reload conversations (PD:1230, 1257, 1304, 1318) |
| `data-home-article` | `button.home-chip` | home | article slug | open that article (PD:1241) |
| `data-conversation-open` | `button.conv-row` (`-compact`), primary `wy-btn` | home, list | conversation id | open a thread (PD:1154, 1161, 1253) |
| `data-chat-header` | `div.header.wy-head.wy-head-chat` | chat | — | header node (PD:958) |
| `data-presence` | `div.presence.sr-only` | chat | — | presence live region (PD:965) |
| `data-presence-dot` | `span.presence-dot` | chat | — | presence dot (PD:966) |
| `data-presence-label` | `span.presence-label` | chat | — | presence text (PD:967) |
| `data-chat-messages` | `div.wy-chat-scroll.wy-scroll` | chat | — | Core renders the message list here (PD:947-948, 1135) |
| `data-chat-jump` | `button.wy-jump[hidden]` | chat | — | scroll to latest; Core sets `hidden` and `has-new` (PD:1117-1121) |
| `data-chat-jump-label` | `span.wy-jump-label` | chat | — | new-message label or count (PD:1128) |
| `data-composer-zone` | `div.composer-zone` | chat | — | composer root (PD:979) |
| `data-typing-row` | `div.sr-only[hidden]` | chat | — | operator typing announcement, not shown on screen (PD:980-983) |
| `data-typing-label` | `span.typing-label` | chat | — | typing text (PD:984) |
| `data-reply-preview` | `div.reply-preview[hidden]` | chat | — | quoted-reply bar (PD:986) |
| `data-reply-preview-author` | `span.reply-preview-author` | chat | — | author (PD:990) |
| `data-reply-preview-text` | `span.reply-preview-text` | chat | — | text (PD:991) |
| `data-reply-cancel` | `button.reply-preview-cancel` | chat | — | cancel the reply (PD:993) |
| `data-emoji-picker` | `div.emoji-picker[hidden]` | chat | — | Core fills `button.emoji-item[data-emoji]` (PD:996) |
| `data-input-bar` | `div.input-bar` | chat | — | state classes `has-draft`, `is-recording`, `is-voice-preview` (PD:997) |
| `data-input-wrap` | `div.input-wrap` | chat | — | pill (PD:998) |
| `data-input-row` | `div.input-row` | chat | — | writing row (PD:1029) |
| `data-attach-preview` | `div.att-preview[hidden]` | chat | — | pending attachment row; `.is-error` (PD:1005) |
| `data-attach-thumb` | `div.att-preview-thumb` | chat | — | thumbnail box (PD:1006) |
| `data-attach-thumb-img` | `img.att-preview-img[hidden]` | chat | — | image preview (PD:1007) |
| `data-attach-thumb-doc` | `span.att-preview-doc` | chat | — | document glyph (PD:1008) |
| `data-attach-name` | `div.att-preview-name` | chat | — | file name (PD:1012) |
| `data-attach-sub` | `div.att-preview-sub` | chat | — | size or status (PD:1013) |
| `data-attach-track` | `div.att-preview-track[hidden]` | chat | — | upload progress track (PD:1014) |
| `data-attach-bar` | `div.att-preview-bar` | chat | — | progress width (PD:1015) |
| `data-attach-retry` | `button.att-preview-retry[hidden]` | chat | — | retry the upload (PD:1018) |
| `data-attach-remove` | `button.att-preview-remove` | chat | — | discard the file (PD:1021) |
| `data-mic-btn` | `button.mic-btn` | chat | — | start recording; `.recording` (PD:1033) |
| `data-msg-input` | `textarea.input` | chat | — | draft; Core auto-sizes it (PD:1037) |
| `data-send-btn` | `button.send-btn` | chat | — | send text and any attachment (PD:1046) |
| `data-attach-btn` | `button.attach-btn` | chat | — | open the file picker (PD:1049) |
| `data-attach-input` | `input[type=file][hidden]` | chat | — | file input, `accept=allowedMimes` (PD:1051) |
| `data-emoji-btn` | `button.emoji-btn[aria-expanded]` | chat | — | toggle the picker (PD:1054) |
| `data-rec-bar` | `div.rec-bar[hidden]` | chat | — | recording UI (PD:1065) |
| `data-rec-cancel` | `button.rec-cancel` | chat | — | cancel the recording (PD:1066) |
| `data-rec-timer` | `span.rec-time[role=timer]` | chat | — | elapsed time (PD:1071) |
| `data-rec-sr` | `span.sr-only[role=status]` | chat | — | "Recording…" announcement (PD:1076) |
| `data-rec-stop` | `button.rec-confirm` | chat | — | stop, which gives a preview (PD:1078) |
| `data-vn-bar` | `div.vn-bar[hidden][dir=ltr]` | chat | — | voice-note preview; `.is-playing` (PD:1090) |
| `data-vn-delete` | `button.vn-delete` | chat | — | discard the note (PD:1091) |
| `data-vn-toggle` | `button.vn-play` | chat | — | play or pause (PD:1094) |
| `data-vn-seek` | `div.vn-track` | chat | — | seek (PD:1099) |
| `data-vn-progress` | `div.vn-progress` | chat | — | progress width (PD:1100) |
| `data-vn-time` | `span.vn-time` | chat | — | time (PD:1102) |
| `data-vn-audio` | `audio` | chat | — | preview audio element (PD:1103) |
| `data-vn-send` | `button.vn-send` | chat | — | send the note; disabled while uploading (PD:1104) |
| `data-msg-reply` | `button.msg-act` | messages | `m.__id` | quote this message; delegated click (PD:677-681, 760) |
| `data-msg-reply-text` | same | messages | body, first 200 chars | quoted text (PD:761) |
| `data-msg-reply-author` | same | messages | "You" or sender name | quoted author (PD:762) |
| `data-msg-copy` | `button.msg-act` | messages | full body | copy; `.is-done` (PD:765) |
| `data-msg-retry` | `button.msg-retry-btn` | messages | `m.localId` | resend a failed message; delegated click (PD:677-683) |
| `data-typing-host` | `div.msg` / `div.hc-subtitle` | messages / handoff | — | typewriter host (PD:775, 806) |
| `data-typing-active` | same | same | `1` | reveal in progress (PD:775, 806) |
| `data-typing-id` | `span.msg-text` / `div.hc-subtitle` | same | `__id` / `hc-subtitle` | reveal target (PD:741-747, 806) |
| `data-att-preview` | `button.msg-att-img-btn` | messages | attachment id | open the lightbox (PD:280) |
| `data-att-media-src` | `img` / `audio` | messages | attachment id | Core loads authenticated media (PD:267-268, 285, 296) |
| `data-att-download` | `a.msg-att-action` / `a.wy-ap-dl` | messages | attachment id | authenticated download (PD:312, 326) |
| `data-att-download-name` | same | messages | file name | download name (PD:312, 326) |
| `data-audio-player` | `div.msg-att-audio[dir=ltr]` | messages | — | player root; `.is-playing`, `.is-loading` (PD:291-295) |
| `data-audio-el` | `audio` | messages | — | media element (PD:296) |
| `data-audio-toggle` | `button.wy-ap-play` | messages | — | play or pause (PD:297) |
| `data-audio-seek` | `div.wy-ap-track` | messages | — | seek (PD:303) |
| `data-audio-buffer` | `div.wy-ap-buffer` | messages | — | buffered width (PD:304) |
| `data-audio-progress` | `div.wy-ap-progress` | messages | — | played width (PD:305) |
| `data-audio-time` | `span.wy-ap-time` | messages | — | time (PD:308) |
| `data-audio-rate` | `button.wy-ap-rate` | messages | — | playback rate, "1×" (PD:309) |
| `data-ci-card` | `div.ci-card` | messages | invitation id | invitation card (PD:472) |
| `data-ci-action` | `button.ci-btn` | messages | `join` / `decline` | accept or decline a call (PD:454, 456) |
| `data-ci-id` | `button.ci-btn` | messages | invitation id | (PD:454, 456) |
| `data-ci-channel` | join button | messages | `audio` / `video` | (PD:455) |
| `data-qna` | `div.qna-suggestions` | messages | — | Q&A block (PD:254) |
| `data-qna-question` | `button.qna-chip` | messages | question text | pick a question (PD:248) |
| `data-qna-more` | `button.qna-more-btn` | messages | — | expand the list (PD:251) |
| `data-field` | `div.prechat-field` | prechat, fallback, handoff | `name` / `email` / `phone` / `message` | field row (PD:582, 851, 877) |
| `data-prechat` | `input.prechat-input` | prechat, handoff | key | field value (PD:585) |
| `data-err` | `div.prechat-error[role=alert]` | prechat, fallback | key | error text (PD:592, 861, 884) |
| `data-prechat-submit` | `button.prechat-submit` / `.hc-submit` | prechat, handoff | — | submit contact details (PD:812, 838) |
| `data-fb` | `input` or `textarea.prechat-input` | fallback | key | **contact-fallback** field, not feedback (PD:855, 881) |
| `data-fb-submit` | `button.prechat-submit` | fallback | — | send the offline message (PD:887) |
| `data-fb-status` | `div.fallback-status[role=status]` | fallback | — | send result (PD:889) |
| `data-smart-dismiss` | `button.smart-dismiss` | home smart card | — | dismiss; Core `onDismiss` (LD:2800-2804) (PD:897) |
| `data-smart-cta` | `button.smart-cta` | home smart card | — | CTA; Core `onCta` (LD:2805-2810) (PD:902) |
| `data-kb-action` | `button.kb-article` / `wy-btn` | help, article | `open`, `switch-chat` | open an article / go to chat (PD:1339, 1361, 1415) |
| `data-kb-slug` | `button.kb-article` | help | slug | article id (PD:1339) |
| `data-kb-feedback` | `div.kb-feedback` | article | — | rating block (PD:1403) |
| `data-kb-rate` | `button.kb-rate[aria-pressed]` | article | `up` / `down` | rate the article (PD:1407, 1410) |
| `data-conn-indicator` | `span.wy-conn` | every footer | — | connection dot (PD:164, 173) |
| `data-wy-brand-logo` | `img.wy-powered-logo` | footer | — | Core swaps a failed logo back to the name (PD:150-157) |

### 6.4 Loader (`LD`) attributes

| Attribute | Element | Purpose / wiring |
|---|---|---|
| `data-workspace-id` | host-page `<script src=…/widget/loader.js>` | workspace id, falling back to `window.__gs_id` (LD:319-321) |
| `data-api-base` | loader script | API base, falling back to `window.__gs_api_base` (LD:491-498) |
| `data-asset-base` | loader script | asset base; otherwise derived from `src` (LD:322-327) |
| `data-debug` | loader script | `"true"` turns on debug logs (LD:317) |
| `data-commerce-assertion` | loader script | signed store-customer assertion, also written by store context (LD:368, 3549) |
| `data-commerce-binding` | loader script | grant fingerprint, reused for 10 min (LD:348-361, 372) |
| `data-commerce-connection` | loader script | optional connection id (LD:380) |
| `data-commerce-context-url` | loader script | same-origin store-context endpoint (LD:436, 3536) |
| `data-commerce-context-eager` | loader script | `"true"` fetches the context before bootstrap (LD:476, 487, 3533) |
| `data-commerce-subject` | loader script | `anon` or `u<64hex>`, read and written (LD:475, 485, 3546-3554) |
| `data-version` | `<gs-widget>` | `LOADER_VERSION` (LD:809) |
| `data-gs-runtime` | runtime and template `<link>`s, runtime `<script>` | tag used by failure cleanup and dedupe (LD:1756-1762, 1807, 1831, 1843, 1880, 2067-2071) |
| `data-gs-template` | template `<link>`, registry and renderer `<script>` | `true` / `registry` / `renderer` (LD:1832, 1860, 1866) |
| `data-gs-template-skin` | skin `<link>` | `true` (LD:1844) |
| `data-gs-runtime-call` | call-module `<script>` | dedupe and cleanup (LD:1758, 1905, 1919) |
| `data-gs-smart` | smart-engine `<script>` | injected at most once (LD:2917, 2926) |
| `data-wy-kit` | `<style>` in the shadow root | WebYar kit CSS, injected once (LD:710-712) |
| `data-rpk-kit` | `<style>` in the shadow root | RESPOK kit CSS, injected once (LD:733-735) |
| `data-smart-dismiss` | `button.smart-dismiss` in `.smart-nudge` | click: AI nudge (LD:2398-2408), rule nudge (LD:2738-2745); emitted at LD:2701 |
| `data-smart-cta` | `button.smart-cta` in `.smart-nudge` | click: AI nudge (LD:2409-2418), rule nudge (LD:2746-2754); emitted at LD:2706 |

### 6.5 Written by Core only (`[snap]` or CSS, in neither file)

| Attribute | Element | Values |
|---|---|---|
| `data-view` | `.panel` | `home`, `chat`, `help`, `list` |
| `data-conn-state` | `.panel` | `online`, plus CSS states `connecting`, `reconnecting`, `loading`, `degraded`, `offline` (CSS:407-422) |
| `data-emoji` | `button.emoji-item` | the emoji (50 items) |
| `data-call-surface` | call surface root | (CSS:1149) |
| `data-phase` | call surface | `connecting`, `reconnecting`, `failed`, `ended` (CSS:1271-1274) |

---

## 7. i18n

- **Where strings come from.** All UI text comes from Core's `env.t` via `t(key)` and `tf(key, fallback)` (PD:25, 66-69).
  - `tf` falls back to its English default when `t` returns nothing or returns the key itself.
  - The call strings use `t(k) || 'English'` instead (PD:335-346, 419-469). That only falls back when `t` returns nothing; if Core returns the key for a missing entry, the key itself would show `[inf]`.
- **Keys PD uses (about 120).** Labels are built dynamically for `name`, `email` and `phone`.
  - Pre-chat placeholders: `prechatNamePh`, `prechatEmailPh`, `prechatPhonePh` (PD:575).
  - Call headlines: `ciHeadline{Audio,Video}[From]` (PD:416-418); call bodies: `ciBody{Audio,Video}` (PD:431); call ended: `csEnded*` (PD:369-372).
  - Static keys:
    - Home/navigation: `homeGreeting`, `homeWelcome`, `homeReplyFast`, `homeReplySlow`, `homeStartChat`, `homeLeaveMessage`, `homeHelpTitle`, `homeSeeAll`, `help`, `back`, `close`, `cancel`.
    - Composer/messages: `intro`, `typeMsg`, `send`, `attachFile`, `emojiPicker`, `recordVoice`, `recording`, `stopRecording`, `cancelRecording`, `remove`, `retry`, `msgFailed`, `msgSending`, `msgOpenLink`, `reply`, `copy`, `you`, `operator`, `scrollToLatest`, `aiThinking`, `receivingFile`, `imageUnavailable`, `openFile`, `closePreview`, `download`, `playAudio`.
    - KB: `searchKb`, `kbZeroResults`, `noArticles`, `kbSwitchToChat`.
    - Pre-chat/fallback: `prechatTitle`, `prechatSubtitle`, `continue`, `required`, `fallbackIntro`, `fallbackMessageLabel`, `fallbackSubmit`.
    - Conversations/Q&A: `convLoadError`, `convRetry`, `qnaTitle`, `qnaMore`.
    - Routing: `routingAgentJoined`, `routingAgentJoinedSuffix`, `routingAgentJoinedGeneric`, `routingNoAgentAvailable`, `routingInQueue`.
    - Calls: `ci*` (wait, time, state, join, decline, aria), `videoCall`, `voiceCall`.
    - `poweredBy`.
    - The `wy*` family: `wyAiAssistant`, `wyAiShort`, `wyArticleHelpful`, `wyArticles`, `wyArticlesSuggest`, `wyConnectOperator`, `wyContinueLast`, `wyConversations`, `wyConversationsLoadError`, `wyConversationsRetry`, `wyFeedbackThanks`, `wyHelpfulNo`, `wyHelpfulYes`, `wyLeaveMessage`, `wyMoreArticles`, `wyNewConversation`, `wyNoConversations`, `wyNoPreview`, `wyPrecontactDesc`, `wyRecentConversations`, `wyStartNew`, `wyStatusOpen`, `wyStatusResolved`, `wyTalkToSupport`, `wyUnread`, `wyViewConversations`.
- **Loader strings** live in their own `LOADER_STRINGS` for `en`, `fa` and `tr` (LD:851-897): errors, `openChat`, `closeChat`, `unreadOne`, `unreadMany`, `dismiss`.
- **Workspace-authored text:**
  - `welcomeMessage`, `replyTimeText`;
  - `poweredBy.text`, used only if its script matches the locale (PD:63-65, 140);
  - the launcher `label` and `subLabel`;
  - smart content, resolved per locale by the engine (LD:2834);
  - KB HTML and conversation `timeLabel`, both produced by Core.
- **Hard-coded in the renderer:**
  - day labels `امروز`, `دیروز`, `Bugün`, `Dün`, `Today`, `Yesterday` (PD:545-547);
  - `1×`, `0:00`, `×`, `!`, `*`, and the initial fallback `W`;
  - the units `B`, `KB`, `MB` (PD:260-265);
  - `+N` on the Q&A more button.

**Persian digits**

| Applied | Not applied (Latin digits) |
|---|---|
| message times, via `toLocaleTimeString` with `fa` (PD:492-498) `[snap]` | call duration `fmtCallDuration` (PD:349-356) |
| day dividers, via `Intl.DateTimeFormat` `fa-IR-u-ca-persian` or `-gregory` (PD:522-554) | invitation countdown (PD:333-347) |
| conversation unread count, via `fmtNum` → `fa-IR` (PD:484-490, 1150) | file sizes (PD:260-265) |
| conversation `timeLabel` (Core) `[snap]` | audio and recorder timers `0:00` (PD:308, 1071, 1102) |
| WebYar launcher badge, via `persianDigits()` (LD:690-693, 1972-1974) | Q&A `+N` (PD:252) |
| phone placeholder in the i18n string (`۰۹۱۲ ۳۴۵ ۶۷۸۹`) `[snap]` | plain and RESPOK launcher badges (LD:1969) |
| | the `{n}` in the loader's `unreadMany` aria-label (LD:915) |

**RTL**

- Direction is set by `dir` attributes (§1.3); there are no `:dir()` selectors.
- `.shell[dir='rtl']` sets `text-align:right` (CSS:71).
- `[dir='rtl']` flips the back icon, the home-link chevron, the KB chevron and the call back button with `scaleX(-1)` (CSS:282, 529-531, 1773, 1361).
- The message-row flex direction flips so the sides **stay physical** (CSS:656-659, 682-683, 824).
- `.msg-text` and `.msg-quote` use `unicode-bidi: plaintext; text-align: start`, so each paragraph follows its own script (CSS:1997-2001; INTL:115-119).
- Logical properties appear in: `inset-inline-end` (jump, panel-close, lightbox close, smart-dismiss, call corner), `margin-inline-*`, `padding-inline-*`, `border-inline-start` (quote) and `inset-inline` (nudge hairline).
- Intentionally **physical:**
  - launcher, panel, label and nudge anchoring (`right`/`left`);
  - the nudge dismiss button, which stays top-right in every direction (LD:622-623);
  - bubble corner radii;
  - `.msg-actions` at `right:100%` or `left:100%`;
  - the audio and voice-note tracks (`left:0`, under forced LTR);
  - `.prechat-input[dir='ltr']{text-align:right}`.

**Fonts**

- `.shell, .shell *` uses `'IRANSans','InterWY',…` (CSS:43-46). Under `[dir='ltr']`, InterWY comes first (CSS:49-54). Intl puts InterWY first in every direction (INTL:39-42).
- The faces actually shipped are IRANSans 400/500/600/700 (600 and 700 are the same Bold asset) and **InterWY 500 only** (FONTS:13-14, 23-27). Bold Latin is therefore synthesized or substituted `[inf]`.
- The Vazirmatn woff2 files are in `fonts/` but have **no `@font-face`**. Only the kit badge names Vazirmatn, so it falls back to Tahoma.

---

## 8. What a re-skin must preserve

1. **Every `data-*` hook** in §6 must keep its element and its value contract. Core binds them and holds node references from a single build (PD:13-19, 941-949, 1059-1063). In particular, keep these nodes present even when hidden:
   - the composer's fixed control set and order (PD:1038-1043);
   - the mic as the first child of the input row;
   - `att-preview`, then `input-row`, inside `input-wrap`;
   - `rec-bar` and `vn-bar` as siblings, not replacements.
2. **Structural classes that Core and the loader query or toggle:**
   - Launcher and shell: `.shell`, `.launcher`, `svg.chat-icon`, `svg.close-icon`, `.badge`, `.gs-fab-label`, `.error-toast`, `.smart-nudge`.
   - Panel and views: `.panel`, `.body`, `.wy-view`, `.messages`, `.msg-row` (+ `.is-last`), `.composer-zone`, `.input-bar`.
   - State classes: `.open`, `.enter`, `.pending`, `.revealed`, `.visible`, `.anim-on`, `.no-anim`, `.gs-mobile-open`, `.pos-bottom-right`, `.pos-bottom-left`, `.bottom-right`, `.bottom-left`, `.has-draft`, `.is-recording`, `.is-voice-preview`, `.recording`, `.is-playing`, `.is-loading`, `.is-error`, `.has-new`, `.is-done`, `.is-mini`, `.off`, `.no-enter`, `.wy-crossfade`, `.entering`, `.leaving`, `.is-up`, `.is-down`, `.is-seen`, `.is-failed`, and every `wy-kit-*` and `rpk-kit-*` class.
3. **Message markup contract** (§5.1). Both skins key on `.msg-row.(visitor or operator)[.is-last] > .msg-col > .msg-line > .msg + .msg-actions` and `.msg-footline > .msg-meta`. Keep the physical sides (operator left, visitor right) unless you change both skins on purpose.
4. **IDs used for label and error wiring:** `prechat-<key>`, `prechat-err-<key>`, `fb-<key>`, `fb-err-<key>`, `fb-message`, `fb-err-message`. Also the document-level `#gs-presentation-fonts`.
5. **ARIA:**
   - Launcher: `aria-haspopup="dialog"`, a dynamic `aria-expanded` and `aria-label` that include the unread count, and an `aria-hidden` badge.
   - Panel: `role="dialog"`, `aria-label`, `tabindex="-1"` (Core).
   - Live regions:
     - `.connection-banner` and the trailing announcer (both Core);
     - `[data-presence]` and `[data-typing-row]`;
     - `[data-rec-sr]` and `[data-rec-timer][role=timer]`;
     - `.msg-att-loading`, `.ci-countdown` and `[data-fb-status]`;
     - `.prechat-error[role=alert]`.
   - Dialogs and groups: `.att-lightbox[role=dialog][aria-modal]`, `.ci-card[role=group]`, `.hc-card[role=group]`.
   - State attributes: `.emoji-btn[aria-expanded]`, `.kb-rate[aria-pressed]`, inputs' `aria-required`, `aria-invalid` and `aria-describedby` (CSS keys on `aria-invalid` and `aria-expanded`).
   - Skeletons stay `aria-hidden`, and `.sr-only` stays usable (RT:67-75).
6. **The "Powered by" footer** (README:111 calls it a plan feature) is `.wy-footer > .wy-conn[data-conn-indicator] + .wy-powered`.
   - Keep the anchor attributes: `target=_blank`, `rel="noopener nofollow"`, `referrerpolicy`.
   - The conn indicator must stay a sibling, never inside the link (PD:148-149).
   - Its visibility is driven by config, so a view must also look right **without** the footer (PD:128-132).
7. **Focus management:**
   - the `:focus-visible` ring in Core is `2px solid var(--gs-primary)`, with suppression inside wrapped inputs (RT:42-62);
   - the template rings on `.panel-close` and the chat controls (CSS:1842, 1910-1917);
   - the RESPOK launcher ring;
   - `window.__gs_panel_close` as the deterministic close path (LD:1538-1541).
8. **Reduced motion.** Keep the existing opt-outs: LD:650-662, LD:951-967, both kits, CSS:504-508, 1371-1374, 1547-1550, 1815-1818, 1926-1932.
9. **Inline styles the stylesheet cannot beat without `!important`:**
   - visitor bubble background (PD:665) and home-card smart CTA (PD:902);
   - `.shell` custom properties;
   - launcher `color`;
   - label offsets and title colour (LD:1071, 1080-1081);
   - skeleton sizes;
   - textarea height (Core).
10. **Skeleton parity.** Each skeleton must match its real view's header height, paddings and composer box, or the crossfade will jump (PD:1465-1475, 1593-1598).

---

## Appendix A: discrepancies, dead code and stale comments

1. The panel is 420×680 (CSS:79-80); README:105 says "about 400×680".
2. LD:578-579 says the launcher "stays in place while the panel is open". It actually slides away (LD:561-562; PD:917-918) `[shot]`.
3. CSS:62-65 says "there is no `.shell.pos-*` contract". The loader does emit `pos-bottom-right` and `pos-bottom-left` (LD:818, 1113-1114).
4. The CSS:75 z-index comment is wrong (see §2).
5. The mobile hide selector is `.fab-label`, but the real class is `.gs-fab-label` (LD:525 vs LD:1067).
6. `@keyframes wy-view-in` is defined twice (CSS:191, 502). The later fade-only version wins.
7. `--wy-primary` is used but never defined (CSS:941, 944, 972), so the voice player ignores the accent.
8. Hard-coded `rgba(31,147,255,…)` tints ignore the accent (see §1.4).
9. English email and phone fields are right-aligned (CSS:1730 + PD:581) `[shot en-07]`.
10. `.anim-on .smart-nudge.entering/.leaving` only match when `.anim-on` is on an ancestor. `.anim-on` is only seen on `.panel`, while the nudge is a child of `.shell` (LD:2730). Whether the nudge animates depends on Core, so this is unclear.
11. `--gs-secondary` is set but unused. `.panel-rtl` has no rules. `.prechat-status` is unstyled.
12. Defined or styled but never emitted:
    - in PD: `PRECHAT_ICONS` (PD:564-569); `.wy-online-dot`, plus the unused `online`, `stack` and `avatarSize` options of `headerIdentityHtml`; `showArticlesButton`; `kbSearchBarHtml` (exported, never composed);
    - in the CSS: `.launcher-badge`, `.typing-row`, `.wy-status`, `.prechat-privacy*`, `.kb-category`, `.kb-section-h`, `.kb-article-h`, `.kb-article-excerpt-full`, `.kb-article-footer`, `.kb-open-browser`, `.ci-err`;
    - `.smart-card` and `.smart-msg-row` may be emitted by Core; that can't be confirmed from these files.
13. `ctx.loadAuthedMediaBlobUrl` is stored but never used (PD:50). The renderer also reads `navigator` and `window.MediaRecorder` (PD:973-974), despite its "pure" contract.
14. The fab image comment promises a clip-path circle reveal; the CSS does opacity + scale (LD:549-556).
15. The AI nudge omits `.entering` and `dir`, unlike rule nudges (LD:2385 vs LD:2721-2727).
16. RTL detection differs: the renderer treats only `fa` as RTL; the nudge treats `fa`, `ar`, `he` and `ur` as RTL.
17. The kits' "open" glyph animation (chevron) plays while the launcher is sliding off-screen, so it is barely visible.
