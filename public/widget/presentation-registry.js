/**
 * Widget Template Registry.
 *
 * The ONLY place that knows which presentation templates exist and which
 * assets each one ships. Widget Core (runtime.js) and the loader stay
 * template-agnostic: they ask the registry for a descriptor and mount
 * whatever it points at.
 *
 * A template entry is:
 *   {
 *     id:        stable identifier persisted in widget settings
 *     globalKey: window key the renderer registers itself under
 *     script:    renderer asset file name (hashed at build time)
 *     style:     template stylesheet file name (hashed at build time)
 *     fonts:     OPTIONAL font asset file name (hashed at build time). The
 *                single source of this template's font bytes. Consumers
 *                (loader, live preview) treat it as an opaque stylesheet —
 *                they know nothing about which font families it defines.
 *   }
 *
 * Adding a template later = add ONE entry here + two asset files.
 * No Core change, no loader change.
 */
(function () {
  'use strict';

  var DEFAULT_ID = 'default';

  var TEMPLATES = {
    // The shipped widget design — the single, default template. The id is
    // deliberately generic: it is baked into asset file names and persisted
    // in widget settings, so naming it after a product would outlive the
    // product.
    'default': {
      id: 'default',
      name: 'Default',
      globalKey: '__gs_presentation_default',
      script: 'presentation-default.js',
      style: 'presentation-default.css',
      // Single source of font bytes for this template (base64-inlined faces).
      fonts: 'presentation-default-fonts.css',
    },
  };

  /**
   * Ids this template used to be called. An embed or a settings row written
   * before the rename still resolves here instead of 404ing on assets that
   * no longer exist.
   */
  var LEGACY_IDS = { 'web-yar': 'default' };

  function resolve(id) {
    if (id && TEMPLATES[id]) return TEMPLATES[id];
    if (id && LEGACY_IDS[id]) return TEMPLATES[LEGACY_IDS[id]];
    return TEMPLATES[DEFAULT_ID];
  }

  function list() {
    return Object.keys(TEMPLATES).map(function (k) { return TEMPLATES[k]; });
  }

  window.__gs_presentation_registry = {
    defaultId: DEFAULT_ID,
    resolve: resolve,
    list: list,
  };
})();
