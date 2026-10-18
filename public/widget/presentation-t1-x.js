/**
 * Widget Presentation — the "t1" renderer's extras.
 *
 * Markup of the t1 renderer (presentation-t1.js) that no first paint needs,
 * in a file of its own so that a first open of a t1 panel never downloads
 * it: Core (runtime-ext.js) asks for it after the first paint, together
 * with its late module (runtime-late.js), and hands it to the renderer
 * (`extend()`), which draws these surfaces from then on. The same rules as
 * a renderer: pure functions (view-model in, HTML out), no network, no
 * storage, no host, and its own copy in fa, en and tr. The stylesheet of
 * these surfaces is the template's own (presentation-t1.css).
 *
 * CONTRACT (docs/operations/WIDGET_TEMPLATE_RULES.md §1)
 *   window.__gs_mod_extras = { id: 't1', v: 1, create: function (H) { return { <surface>: fn, … }; } }
 *   H = the renderer's helpers: esc, t, tf, L, fill, svg, P, D, digits,
 *       fmtNum, avatarHtml, systemPillHtml, config, lang, fa.
 *   `id` is the RENDERER's (a skin over t1 wears this file too) and `v` the
 *   version of this contract: the renderer takes only its own id and
 *   version, so a file from another deploy or template (a canonical-name
 *   fallback) is refused. Change `v` here and in the renderer together
 *   whenever a surface's arguments or H change.
 *
 *   emojiPickerHtml()   the grouped emoji picker (feature `emojiTabs`): a tab per group
 */
(function () {
  'use strict';

  // This file's copy: one '|'-separated string per language, in the order
  // of COPY_KEYS (as the renderer's own).
  var COPY_KEYS = 'cats'.split(' ');
  var DICT = {
    fa: 'پرکاربرد,چهره‌ها,آدم‌ها و دست‌ها,قلب‌ها و نمادها,طبیعت,غذا و نوشیدنی',
    en: 'Frequent,Faces,People and hands,Hearts and symbols,Nature,Food and drink',
    tr: 'Sık kullanılan,Yüzler,İnsanlar ve eller,Kalpler ve semboller,Doğa,Yiyecek ve içecek',
  };

  // Grouped emoji for the picker, one group per name in `cats`.
  var EMOJI = [
    '😍 🙏 👍 😊 😂 ❤️ 🌹 🎉',
    '😀 😁 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😋 😎 🤩 🥳 😏',
    '👍 👎 👏 🙏 👋 🤝 ✌️ 👌 💪 🙌 🤲 👀 🙋 🤷 💁 🙆',
    '❤️ 🧡 💛 💚 💙 💜 🤍 🖤 💔 💕 💖 💯 ✨ 🔥 ⭐ ✅',
    '🌹 🌷 🌸 🌻 🍀 🌙 ☀️ 🌈 🐱 🐶 🦋 🐝 🌊 ❄️ 🌿 🍂',
    '☕ 🍰 🎂 🍫 🍕 🍔 🍎 🍉 🍓 🍇 🍩 🍪 🧁 🍦 🍵 🥤',
  ];

  function create(H) {
    var esc = H.esc;
    var t = H.t;
    var svg = H.svg;
    var P = H.P;
    // A string or English: a locale 'constructor' must not reach Object.prototype.
    var COPY = (typeof DICT[H.lang] == 'string' ? DICT[H.lang] : DICT.en).split('|');
    var COPY_EN = DICT.en.split('|');
    /** This file's own copy (fa / en / tr; English otherwise). */
    function XL(key) { var i = COPY_KEYS.indexOf(key); return i < 0 ? '' : COPY[i] || COPY_EN[i] || ''; }

    function emojiPickerHtml() {
      var cats = XL('cats').split(',');
      var icons = [
        '<circle cx="12" cy="12" r="8.5"/>' + P('M12 7.5V12l3 2'), H.D.emoji,
        '<circle cx="12" cy="8.2" r="3.6"/>' + P('M5.2 19.5a6.8 6.8 0 0 1 13.6 0'),
        P('M12 19.6s-7-4.3-7-9.7a4 4 0 0 1 7-2.6 4 4 0 0 1 7 2.6c0 5.4-7 9.7-7 9.7Z'),
        P('M5.5 18.5C5.5 10.6 10.4 5.7 18.5 5c0 8.6-5 13.5-13 13.5Z') + P('m5.5 18.5 7-7'),
        P('M5 9.5h11v4.3a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z') + P('M16 10.5h1.2a2.4 2.4 0 0 1 0 4.8H16') + P('M9 3.8v2.4M12.4 3.8v2.4'),
      ];
      return '<div class="ep-cats" role="tablist" aria-label="' + esc(t('emojiPicker')) + '">' + cats.map(function (c, i) {
          return '<button type="button" class="ep-cat" role="tab" aria-selected="' + (i ? 'false' : 'true') + '" data-emoji-tab="' + i +
            '" aria-label="' + esc(c) + '">' + svg(icons[i], 19) + '</button>';
        }).join('') + '</div>' +
        '<div class="ep-grid">' + EMOJI.map(function (row, i) {
          return '<div data-emoji-group="' + i + '"><p class="ep-h">' + esc(cats[i]) + '</p><div class="ep-row">' +
            row.split(' ').map(function (e) {
              return '<button type="button" class="ep-e" data-emoji="' + e + '">' + e + '</button>';
            }).join('') + '</div></div>';
        }).join('') + '</div>';
    }

    return { emojiPickerHtml: emojiPickerHtml };
  }

  window.__gs_mod_extras = { id: 't1', v: 1, create: create };
})();
