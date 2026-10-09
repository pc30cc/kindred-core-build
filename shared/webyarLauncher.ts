/**
 * WebYar's floating chat button (the brand kit's floating-button/, v1), as
 * the chat widget's `default` template wears it in the Iranian edition only
 * (`region_mode = 'iran'`, the bootstrap's `edition === 'iran'`). Ported into
 * the existing launcher (`.launcher` + `svg.chat-icon` / `svg.close-icon`),
 * not the kit's standalone script: no extra global, no inline handler.
 *
 * public/widget/loader.js carries the SAME four strings (it is plain
 * JavaScript served to customers' sites and cannot import this file);
 * src/test/widget/webyarLauncher.test.ts proves they are byte-identical, and
 * the operator preview (WidgetLivePreview) uses these.
 *
 * States: rest (gradient 140deg #22D3B4 → #0B7D6C, white bubble, three
 * hollow dots), entrance (the button springs in, the bubble grows, then the
 * dots appear one by one: the kit's wyFabIn / wyBodyIn / wyDotIn), hover
 * (lift + the dots wave once), operator typing (the dots bob in turn while
 * the runtime shows "Support is typing…": wyType), attention ping (a
 * turquoise ring spreads twice, 6s after the entrance if the chat was not
 * opened: wyPing), open / close (the bubble turns away and the chevron turns
 * in, per the kit's lottie/webyar-launcher-open.json; on close the dots
 * arrive again), unread (saffron #FFB423 badge, Persian digits in Persian,
 * one nudge), offline (ink #12141F ground, turquoise bubble). Timings and
 * easings are the kit's webyar-launcher.css. prefers-reduced-motion: nothing
 * moves; the glyphs swap with a fade.
 *
 * Customisation: a workspace colour other than the seeded #3B82F6 keeps its
 * own solid colour (no gradient, no offline recolouring); its icon colour
 * paints the bubble and the chevron; a custom icon other than `chat` keeps
 * that icon; a custom image, shape, size, label and position work as before.
 */

/** Base launcher box in the kit (60px at 100%); the workspace scale multiplies it. */
export const WEBYAR_LAUNCHER_BASE_SIZE = 60;

export const WEBYAR_LAUNCHER_CSS = ".launcher.wy-kit.wy-kit-brand{background:linear-gradient(140deg,#22D3B4,#0B7D6C);box-shadow:0 12px 28px rgba(11,125,108,.36),0 3px 8px rgba(18,20,31,.16);--wy-kit-dot:#18AD94;--wy-kit-ring:#16C7A8;}.launcher.wy-kit:not(.open):not(.enter):hover{transform:translateY(-3px) scale(1.06);transition:transform .22s cubic-bezier(.2,.8,.2,1),box-shadow .22s ease;}.launcher.wy-kit.wy-kit-brand:not(.open):not(.enter):hover{box-shadow:0 18px 36px rgba(11,125,108,.42),0 4px 10px rgba(18,20,31,.16);}.launcher.wy-kit svg.wy-kit-glyph{position:absolute;inset:0;width:100%;height:100%;fill:none;stroke:none;overflow:visible;transform-origin:50% 50%;transition:transform .2s cubic-bezier(.4,0,1,1),opacity .16s ease;}.launcher.wy-kit .wy-kit-body{fill:currentColor;transition:fill .25s ease;}.launcher.wy-kit .wy-kit-dot{fill:var(--wy-kit-dot,var(--gs-primary,#0B7D6C));transform-box:fill-box;transform-origin:50% 50%;transition:fill .25s ease;}.launcher.wy-kit .wy-kit-chev{fill:none;stroke:currentColor;stroke-width:3.2;stroke-linecap:round;stroke-linejoin:round;}.launcher.wy-kit svg.close-icon.wy-kit-glyph{display:block;opacity:0;transform:rotate(45deg) scale(.6);transition:transform .2s ease,opacity .14s ease;}.launcher.wy-kit.open svg.chat-icon.wy-kit-glyph{display:block;opacity:0;transform:rotate(-35deg) scale(.3);}.launcher.wy-kit.open svg.close-icon.wy-kit-glyph{opacity:1;transform:none;transition:transform .26s cubic-bezier(.2,.9,.3,1.2) .06s,opacity .2s ease .06s;}.launcher.wy-kit.wy-kit-enter{animation:wy-kit-fab-in .62s cubic-bezier(.2,1.25,.4,1) backwards;}.launcher.wy-kit.wy-kit-enter .wy-kit-body{transform-box:fill-box;transform-origin:50% 50%;animation:wy-kit-body-in .5s cubic-bezier(.2,1.2,.4,1) .12s backwards;}.launcher.wy-kit.wy-kit-enter .wy-kit-dot{animation:wy-kit-dot-in .32s cubic-bezier(.3,1.45,.5,1) backwards;}.launcher.wy-kit.wy-kit-enter .wy-kit-d1{animation-delay:.45s;}.launcher.wy-kit.wy-kit-enter .wy-kit-d2{animation-delay:.65s;}.launcher.wy-kit.wy-kit-enter .wy-kit-d3{animation-delay:.85s;}.launcher.wy-kit:not(.open):hover .wy-kit-dot{animation:wy-kit-wave .62s ease-in-out;}.launcher.wy-kit:not(.open):hover .wy-kit-d2{animation-delay:.08s;}.launcher.wy-kit:not(.open):hover .wy-kit-d3{animation-delay:.16s;}.launcher.wy-kit.wy-kit-closing:not(.open) .wy-kit-dot{animation:wy-kit-dot-in .26s cubic-bezier(.3,1.45,.5,1) backwards;}.launcher.wy-kit.wy-kit-closing:not(.open) .wy-kit-d1{animation-delay:.12s;}.launcher.wy-kit.wy-kit-closing:not(.open) .wy-kit-d2{animation-delay:.2s;}.launcher.wy-kit.wy-kit-closing:not(.open) .wy-kit-d3{animation-delay:.28s;}.launcher.wy-kit.wy-kit-typing:not(.open) .wy-kit-dot,.launcher.wy-kit.wy-kit-typing:not(.open):hover .wy-kit-dot{animation:wy-kit-type 1.3s ease-in-out infinite;}.launcher.wy-kit.wy-kit-typing:not(.open) .wy-kit-d2,.launcher.wy-kit.wy-kit-typing:not(.open):hover .wy-kit-d2{animation-delay:.16s;}.launcher.wy-kit.wy-kit-typing:not(.open) .wy-kit-d3,.launcher.wy-kit.wy-kit-typing:not(.open):hover .wy-kit-d3{animation-delay:.32s;}.launcher.wy-kit .wy-kit-ping{position:absolute;inset:0;border-radius:inherit;border:2px solid var(--wy-kit-ring,var(--gs-primary,#16C7A8));opacity:0;pointer-events:none;}.launcher.wy-kit.wy-kit-pinging:not(.open) .wy-kit-ping{animation:wy-kit-ping 1.8s cubic-bezier(.2,.6,.3,1) 2;}.launcher.wy-kit .badge{top:-6px;right:-6px;min-width:24px;height:24px;padding:0 6px;border-radius:12px;border:0;background:#FFB423;color:#12141F;font:800 13px/24px Vazirmatn,Tahoma,'Segoe UI',sans-serif;box-shadow:0 0 0 3px #fff;animation:wy-kit-badge-in .45s cubic-bezier(.3,1.6,.5,1);}.launcher.wy-kit.open .badge{display:none;}.launcher.wy-kit.wy-kit-nudge:not(.open){animation:wy-kit-nudge .6s ease-in-out;}.launcher.wy-kit.wy-kit-brand.wy-kit-offline{background:#12141F;--wy-kit-dot:#12141F;}.launcher.wy-kit.wy-kit-brand.wy-kit-offline .wy-kit-body{fill:#16C7A8;}@keyframes wy-kit-fab-in{0%{opacity:0;transform:translateY(18px) scale(.6);}100%{opacity:1;transform:none;}}@keyframes wy-kit-body-in{0%{opacity:0;transform:scale(.7);}100%{opacity:1;transform:none;}}@keyframes wy-kit-type{0%,60%,100%{transform:none;opacity:.55;}25%{transform:translateY(-2.5px);opacity:1;}}@keyframes wy-kit-ping{0%{opacity:.6;transform:scale(1);}100%{opacity:0;transform:scale(1.75);}}@keyframes wy-kit-dot-in{0%{opacity:0;transform:scale(.4);}100%{opacity:1;transform:none;}}@keyframes wy-kit-wave{0%,100%{transform:none;}35%{transform:translateY(-2.5px);}}@keyframes wy-kit-badge-in{0%{transform:scale(0);}60%{transform:scale(1.18);}100%{transform:scale(1);}}@keyframes wy-kit-nudge{0%,100%{transform:none;}20%{transform:rotate(-10deg);}45%{transform:rotate(8deg);}70%{transform:rotate(-4deg);}}@media(prefers-reduced-motion:reduce){.launcher.wy-kit,.launcher.wy-kit *{animation:none!important;}.launcher.wy-kit:not(.open):not(.enter):hover{transform:none;}.launcher.wy-kit svg.wy-kit-glyph,.launcher.wy-kit svg.close-icon.wy-kit-glyph,.launcher.wy-kit.open svg.close-icon.wy-kit-glyph{transition:opacity .15s ease;}.launcher.wy-kit.open svg.chat-icon.wy-kit-glyph,.launcher.wy-kit svg.close-icon.wy-kit-glyph{transform:none;}}";

export const WEBYAR_LAUNCHER_CHAT_GLYPH = "<svg class=\"chat-icon wy-kit-glyph\" viewBox=\"0 0 60 60\" aria-hidden=\"true\" focusable=\"false\"><path class=\"wy-kit-body\" d=\"M42.28 27.95A12.4 12.4 0 0 0 21.7 17.01A12.4 12.4 0 0 0 30.43 38.62A7.75 7.75 0 0 0 22.95 46.14A0.43 0.43 0 0 1 22.56 46.56A21.7 21.7 0 0 0 42.28 27.95Z\"/><path class=\"wy-kit-dot wy-kit-d1\" d=\"M35.21 24.12L37.32 26.23L35.21 28.34L33.1 26.23Z\"/><path class=\"wy-kit-dot wy-kit-d2\" d=\"M30 24.12L32.11 26.23L30 28.34L27.89 26.23Z\"/><path class=\"wy-kit-dot wy-kit-d3\" d=\"M24.79 24.12L26.9 26.23L24.79 28.34L22.69 26.23Z\"/></svg>";

export const WEBYAR_LAUNCHER_CLOSE_GLYPH = "<svg class=\"close-icon wy-kit-glyph\" viewBox=\"0 0 60 60\" aria-hidden=\"true\" focusable=\"false\"><path class=\"wy-kit-chev\" d=\"M22 27l8 8 8-8\"/></svg>";

/** The attention ring (the kit's ping), drawn inside the launcher; no content. */
export const WEBYAR_LAUNCHER_PING = "<span class=\"wy-kit-ping\" aria-hidden=\"true\"></span>";
