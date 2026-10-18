/**
 * Widget Module: late Core features
 *
 * Core's code for what a template draws AFTER its first paint (the "late
 * pack", docs/operations/WIDGET_TEMPLATE_RULES.md §2): runtime-ext.js asks
 * for this file together with the renderer's extras
 * (`presentation-<renderer>-x.js`) once the first paint is done, or at once
 * when a control needs them, and only for a renderer whose descriptor names
 * extras (`default` and `intl` never download it). The two are applied
 * together or not at all, so a feature here never runs without its markup
 * and its markup is never drawn without it. Gated like runtime-ext.js: each
 * feature only for a renderer declaring it (`api.feat(name)`).
 *
 * Public API (window.__gs_mod_late): `v`, the version of the contract with
 * runtime-ext.js (the `api` below; runtime-ext refuses another version, so
 * a canonical-name fallback from another deploy never half-applies), and
 * create(api) → this module's instance. `api` is runtime-ext's own surface:
 * the instance's parts as runtime-ext.js names them (P, ctx, panel, chatQ,
 * the stores, renderBody, ModuleLoader, …), its helpers (feat, each,
 * onClick, wrap) and `on(hook, fn)`, which registers `fn` on one of the
 * hooks runtime.js runs (`ext('<hook>', a, b)`). runtime-ext runs its own
 * handler first, then the ones registered here in order: each gets
 * `(a, b, answer so far)` and an answer of its own (anything but
 * undefined) replaces it, so a handler may consume a call (true) or
 * override a value. create() registers handlers and starts nothing else.
 *
 * Brand-neutral: it ships in every build as is.
 */
(function () {
  'use strict';

  function create(api) {
    void api;
    // The features of issue #340 register here, each behind api.feat().
    return {};
  }

  window.__gs_mod_late = { v: 1, create: create };
})();
