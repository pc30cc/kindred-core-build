/*!
 * Call Widget presentation registry — versioned boundary between the call
 * engine and renderers. Presentations must only render and emit intents.
 */
(function (global) {
  'use strict';
  if (global.CallWidgetPresentations) return;
  var implementations = Object.create(null);
  var DEFAULT_ID = 'default';

  function validId(id) { return typeof id === 'string' && /^[a-z0-9-]+$/.test(id); }
  function validImplementation(value) {
    return value && value.contractVersion === 1 &&
      typeof value.createHost === 'function' &&
      typeof value.mount === 'function' &&
      typeof value.update === 'function' &&
      typeof value.destroy === 'function';
  }

  global.CallWidgetPresentations = Object.freeze({
    contractVersion: 1,
    register: function (id, implementation) {
      if (!validId(id) || !validImplementation(implementation)) {
        throw new Error('invalid_call_widget_presentation');
      }
      implementations[id] = implementation;
    },
    resolve: function (id) {
      return implementations[id] || implementations[DEFAULT_ID] || null;
    },
    resolveId: function (id) {
      return implementations[id] ? id : DEFAULT_ID;
    },
    has: function (id) { return !!implementations[id]; },
  });
})(window);
