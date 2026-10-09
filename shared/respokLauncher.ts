/**
 * RESPOK's floating chat button (the brand kit's Thread chat button,
 * Shared/Code/widget/respok-launcher.js v1.0.0, `style: 'thread'`), as the
 * chat widget's `intl` template wears it in the International edition only
 * (the bootstrap's `edition === 'international'` with `templateId === 'intl'`).
 * Ported into the existing launcher (`.launcher` + `svg.chat-icon` /
 * `svg.close-icon`), not the kit's standalone script: no extra global, no
 * inline handler, no font request, no Shadow DOM of its own.
 *
 * public/widget/loader.js carries the SAME three strings (it is plain
 * JavaScript served to customers' sites and cannot import this file);
 * src/test/widget/respokLauncher.test.ts proves they are byte-identical, and
 * the operator preview (WidgetLivePreview) uses these.
 *
 * States (the kit's 06-chat-button-states): rest (Ink #16142B ground, the
 * white question pill and the Signal #FF5A3C answer pill), hover (scale 1.06,
 * deeper shadow), pressed (scale .94), keyboard focus (white gap + Signal
 * ring), open (the glyph turns away, the chevron turns in, 200ms), unread
 * (Signal Deep #D3361A badge with a white rim, springs in; bumps when it was
 * already showing; the answer pill slides in from the right when a new
 * message arrives), away (outside working hours: the answer pill becomes an
 * outline in Away #A9A7BC). prefers-reduced-motion: nothing moves or scales;
 * the glyph and chevron swap with a 120ms fade.
 *
 * Customisation, the same rule as WebYar's button (shared/webyarLauncher.ts):
 * a workspace colour other than the seeded #3B82F6 keeps its own solid
 * colour and the glyph is drawn in one colour (its icon colour), as the kit
 * does for any colour but Ink; away then outlines the answer pill in that
 * same colour. A custom icon other than `chat` keeps that icon; a custom
 * image, shape, size, label and position work as before.
 */

/** Base launcher box in the kit (60px at 100%); the workspace scale multiplies it. */
export const RESPOK_LAUNCHER_BASE_SIZE = 60;

export const RESPOK_LAUNCHER_CSS = ".launcher.rpk-kit.rpk-kit-brand{background:#16142B;box-shadow:0 10px 28px rgba(22,20,43,.28);--rpk-kit-accent:#FF5A3C;--rpk-kit-away:#A9A7BC;}.launcher.rpk-kit:not(.open):not(.enter):hover{transform:scale(1.06);transition:transform .16s ease,box-shadow .16s ease;}.launcher.rpk-kit.rpk-kit-brand:not(.open):not(.enter):hover{box-shadow:0 16px 36px rgba(22,20,43,.36);}.launcher.rpk-kit:not(.open):not(.enter):active{transform:scale(.94);transition-duration:.09s;}.launcher.rpk-kit.rpk-kit-brand:not(.open):not(.enter):active{box-shadow:0 5px 14px rgba(22,20,43,.24);}.launcher.rpk-kit:focus-visible{outline:none;box-shadow:0 0 0 3px #fff,0 0 0 6px #FF5A3C,0 10px 28px rgba(22,20,43,.28);}.launcher.rpk-kit svg.rpk-kit-glyph{position:absolute;inset:0;margin:auto;width:50%;height:44.23%;fill:none;stroke:none;overflow:visible;transition:transform .2s ease,opacity .2s ease;}.launcher.rpk-kit .rpk-kit-q{fill:currentColor;}.launcher.rpk-kit .rpk-kit-a{fill:var(--rpk-kit-accent,currentColor);}.launcher.rpk-kit.rpk-kit-away .rpk-kit-a{fill:none;stroke:var(--rpk-kit-away,currentColor);stroke-width:7;}.launcher.rpk-kit svg.close-icon.rpk-kit-glyph{display:block;width:43%;height:43%;opacity:0;transform:rotate(-90deg);}.launcher.rpk-kit .rpk-kit-chev{fill:none;stroke:currentColor;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;}.launcher.rpk-kit.open svg.chat-icon.rpk-kit-glyph{display:block;opacity:0;transform:rotate(90deg) scale(.6);}.launcher.rpk-kit.open svg.close-icon.rpk-kit-glyph{opacity:1;transform:none;}.launcher.rpk-kit.rpk-kit-arrive .rpk-kit-a{animation:rpk-kit-answer .36s cubic-bezier(.3,1.4,.5,1);}.launcher.rpk-kit .badge{top:-3px;right:-3px;min-width:22px;height:22px;padding:0 6px;border-radius:11px;border:2px solid #fff;background:#D3361A;color:#fff;font-size:12px;font-weight:700;line-height:18px;box-shadow:none;animation:rpk-kit-badge-in .34s cubic-bezier(.3,1.5,.5,1);}.launcher.rpk-kit .badge.rpk-kit-bump{animation:rpk-kit-bump .32s ease;}.launcher.rpk-kit .badge.rpk-kit-still{animation:none;}.launcher.rpk-kit.open .badge{display:none;}@keyframes rpk-kit-answer{0%{transform:translateX(34px);opacity:0;}70%{transform:translateX(-6px);opacity:1;}100%{transform:none;}}@keyframes rpk-kit-badge-in{0%{transform:scale(0);}100%{transform:scale(1);}}@keyframes rpk-kit-bump{0%,100%{transform:scale(1);}50%{transform:scale(1.15);}}@media(prefers-reduced-motion:reduce){.launcher.rpk-kit,.launcher.rpk-kit *{animation:none!important;}.launcher.rpk-kit:not(.open):not(.enter):hover,.launcher.rpk-kit:not(.open):not(.enter):active{transform:none;}.launcher.rpk-kit svg.rpk-kit-glyph,.launcher.rpk-kit svg.close-icon.rpk-kit-glyph,.launcher.rpk-kit.open svg.close-icon.rpk-kit-glyph{transition:opacity .12s ease;}.launcher.rpk-kit.open svg.chat-icon.rpk-kit-glyph,.launcher.rpk-kit svg.close-icon.rpk-kit-glyph{transform:none;}}";

export const RESPOK_LAUNCHER_CHAT_GLYPH = "<svg class=\"chat-icon rpk-kit-glyph\" viewBox=\"0 0 104 92\" aria-hidden=\"true\" focusable=\"false\"><path class=\"rpk-kit-q\" d=\"M21 0H41A21 21 0 0 1 62 21V21A21 21 0 0 1 41 42H4A4 4 0 0 1 0 38V21A21 21 0 0 1 21 0Z\"/><path class=\"rpk-kit-a\" d=\"M43 50H83A21 21 0 0 1 104 71V88A4 4 0 0 1 100 92H43A21 21 0 0 1 22 71V71A21 21 0 0 1 43 50Z\"/></svg>";

export const RESPOK_LAUNCHER_CLOSE_GLYPH = "<svg class=\"close-icon rpk-kit-glyph\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\"><path class=\"rpk-kit-chev\" d=\"M6 9l6 6 6-6\"/></svg>";
