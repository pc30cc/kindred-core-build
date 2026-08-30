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
 *   }
 *
 * Adding a template later = add ONE entry here + two asset files.
 * No Core change, no loader change.
 */
(function () {
  'use strict';

  var DEFAULT_ID = 'classic';

  var TEMPLATES = {
    // The original (and currently only) widget design, extracted verbatim
    // out of runtime.js. It is the first official implementation of the
    // template system — not a redesign.
    classic: {
      id: 'classic',
      name: 'Classic',
      globalKey: '__gs_presentation_classic',
      script: 'presentation-classic.js',
      style: 'presentation-classic.css',
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
