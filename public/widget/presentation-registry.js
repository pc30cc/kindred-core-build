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

  var DEFAULT_ID = 'web-yar';

  var TEMPLATES = {
    // The official Web Yar widget design — the single, default template.
    'web-yar': {
      id: 'web-yar',
      name: 'Web Yar',
      globalKey: '__gs_presentation_web_yar',
      script: 'presentation-web-yar.js',
      style: 'presentation-web-yar.css',
      // Single source of font bytes for this template (base64-inlined faces).
      fonts: 'presentation-web-yar-fonts.css',
    },
  };


  function resolve(id) {
    if (id && TEMPLATES[id]) return TEMPLATES[id];
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
