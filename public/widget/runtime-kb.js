/**
 * Widget Module: Knowledge Base
 * Lazy-loaded when user opens Help tab. Talks to:
 *   GET /api/widget/kb/categories
 *   GET /api/widget/kb/article
 *   GET /api/widget/kb/search
 *   GET /api/widget/kb-suggest
 *
 * Public API (window.__gs_mod_kb):
 *   loadCategories({ apiBase, workspaceId, locale, sessionToken, onResult })
 *   loadArticle   ({ apiBase, workspaceId, locale, sessionToken, slug, meta, onResult })
 *   searchArticles({ apiBase, workspaceId, locale, sessionToken, query, limit, signal, onResult })
 *   suggestArticles({ apiBase, workspaceId, locale, fetchWith, query, limit, signal, onResult })
 *                  onResult({ ok, status, results }); an abort answers nothing
 */
(function () {
  'use strict';

  function buildUrl(apiBase, path, params) {
    var qs = [];
    for (var k in params) {
      if (Object.prototype.hasOwnProperty.call(params, k) && params[k] != null && params[k] !== '') {
        qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
      }
    }
    return apiBase + path + (qs.length ? ('?' + qs.join('&')) : '');
  }

  function doFetch(url, opts, signal) {
    var fetchWith = opts.fetchWith || function (u, init) {
      init = init || {}; init.credentials = init.credentials || 'include';
      var h = init.headers || {}; h['X-Widget-Token'] = opts.sessionToken || '';
      init.headers = h; return fetch(u, init);
    };
    var init = { method: 'GET', headers: {} };
    if (signal) init.signal = signal;
    return fetchWith(url, init).then(function (r) {
      if (!r.ok) { var e = new Error('http_' + r.status); e.status = r.status; throw e; }
      return r.json();
    });
  }

  window.__gs_mod_kb = {
    loadCategories: function (opts) {
      if (!opts || !opts.apiBase || !opts.workspaceId) {
        if (opts && opts.onResult) opts.onResult({ ok: false, categories: [] });
        return;
      }
      var url = buildUrl(opts.apiBase, '/api/widget/kb/categories', {
        workspace_id: opts.workspaceId,
        locale: opts.locale || 'en',
      });
      doFetch(url, opts)
        .then(function (data) { opts.onResult({ ok: true, categories: data.categories || [], articles: data.articles || [] }); })
        .catch(function () { opts.onResult({ ok: false, categories: [], articles: [] }); });
    },

    loadArticle: function (opts) {
      if (!opts || !opts.apiBase || !opts.workspaceId || !opts.slug) {
        if (opts && opts.onResult) opts.onResult({ ok: false, article: null });
        return;
      }
      var url = buildUrl(opts.apiBase, '/api/widget/kb/article', {
        workspace_id: opts.workspaceId,
        locale: opts.locale || 'en',
        slug: opts.slug,
        // 1 (runtime-ext.js, a renderer drawing the author): `author_name` too.
        meta: opts.meta,
      });
      doFetch(url, opts)
        .then(function (data) { opts.onResult({ ok: true, article: data.article || null }); })
        .catch(function () { opts.onResult({ ok: false, article: null }); });
    },

    searchArticles: function (opts) {
      if (!opts || !opts.apiBase || !opts.workspaceId || !opts.query) {
        if (opts && opts.onResult) opts.onResult({ ok: true, results: [] });
        return;
      }
      var url = buildUrl(opts.apiBase, '/api/widget/kb/search', {
        workspace_id: opts.workspaceId,
        locale: opts.locale || 'en',
        q: opts.query,
        limit: opts.limit || 8,
        // 'words' (runtime-ext.js): word by word, ranked; none: one phrase.
        match: opts.match,
      });
      doFetch(url, opts, opts.signal)
        .then(function (data) { opts.onResult({ ok: true, results: data.results || [] }); })
        .catch(function (e) {
          if (e && e.name === 'AbortError') return;
          opts.onResult({ ok: false, results: [] });
        });
    },

    // The help articles that answer a first message being written
    // (runtime-late.js `instantAnswers`): its own rate limit, so a 429
    // (`status`) says to stop asking for a while.
    suggestArticles: function (opts) {
      if (!opts || !opts.apiBase || !opts.workspaceId || !opts.query) {
        if (opts && opts.onResult) opts.onResult({ ok: true, status: 0, results: [] });
        return;
      }
      var url = buildUrl(opts.apiBase, '/api/widget/kb-suggest', {
        workspace_id: opts.workspaceId,
        locale: opts.locale || 'en',
        q: opts.query,
        limit: opts.limit || 2,
      });
      doFetch(url, opts, opts.signal)
        .then(function (data) { opts.onResult({ ok: true, status: 200, results: (data && data.results) || [] }); })
        .catch(function (e) {
          if (e && e.name === 'AbortError') return;
          opts.onResult({ ok: false, status: (e && e.status) || 0, results: [] });
        });
    },
  };
})();