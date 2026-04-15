/**
 * Widget Module: Knowledge Base
 * Lazy-loaded when user opens Help tab.
 */
(function () {
  'use strict';

  window.__gs_mod_kb = {
    loadArticles: function (opts) {
      var apiBase = opts.apiBase;
      var workspaceId = opts.workspaceId;
      var sessionToken = opts.sessionToken;
      var locale = opts.locale || 'en';
      var onArticles = opts.onArticles;

      if (!apiBase || !workspaceId) return;

      fetch(
        apiBase + '/api/widget/help-articles?workspace_id=' + encodeURIComponent(workspaceId) +
        '&locale=' + encodeURIComponent(locale),
        { headers: { 'X-Widget-Token': sessionToken || '' } }
      )
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (onArticles) onArticles(data.articles || []);
        })
        .catch(function () {
          if (onArticles) onArticles([]);
        });
    },

    searchArticles: function (opts) {
      var apiBase = opts.apiBase;
      var workspaceId = opts.workspaceId;
      var sessionToken = opts.sessionToken;
      var query = opts.query || '';
      var locale = opts.locale || 'en';
      var onResults = opts.onResults;

      if (!apiBase || !workspaceId || !query) return;

      fetch(
        apiBase + '/api/widget/help-articles?workspace_id=' + encodeURIComponent(workspaceId) +
        '&locale=' + encodeURIComponent(locale) +
        '&q=' + encodeURIComponent(query),
        { headers: { 'X-Widget-Token': sessionToken || '' } }
      )
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (onResults) onResults(data.articles || []);
        })
        .catch(function () {
          if (onResults) onResults([]);
        });
    },
  };
})();
