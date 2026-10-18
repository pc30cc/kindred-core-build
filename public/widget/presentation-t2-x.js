/**
 * Widget Presentation — the "t2" renderer's extras.
 *
 * Markup of the t2 renderer (presentation-t2.js) that no first paint needs,
 * in a file of its own so that a first open of a t2 panel never downloads
 * it: Core (runtime-ext.js) asks for it after the first paint, together
 * with its late module (runtime-late.js), and hands it to the renderer
 * (`extend()`), which draws these surfaces from then on. The same rules as
 * a renderer: pure functions (view-model in, HTML out), no network, no
 * storage, no host, and its own copy in fa, en and tr. The stylesheet of
 * these surfaces is the template's own (presentation-t2.css).
 *
 * CONTRACT (docs/operations/WIDGET_TEMPLATE_RULES.md §1)
 *   window.__gs_mod_extras = { id: 't2', v: 1, create: function (H) { return { <surface>: fn, … }; } }
 *   H = the renderer's helpers: esc, t, tf, L, digits, fmtNum, ico,
 *       avatarHtml, storeAvatarHtml, systemPillHtml, config, lang, fa.
 *   `id` is the RENDERER's (a skin over t2 wears this file too) and `v` the
 *   version of this contract: the renderer takes only its own id and
 *   version, so a file from another deploy or template (a canonical-name
 *   fallback) is refused. Change `v` here and in the renderer together
 *   whenever a surface's arguments or H change.
 *
 * No surface lives here yet: the late features of issue #340 add theirs.
 */
(function () {
  'use strict';

  function create(H) {
    void H;
    return {};
  }

  window.__gs_mod_extras = { id: 't2', v: 1, create: create };
})();
