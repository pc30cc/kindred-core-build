/**
 * Widget Module: Chat (cookie-based identity)
 *
 * IMPORTANT: All requests use `credentials: 'include'` so the HttpOnly `dvsid`
 * visitor cookie is sent automatically. We NEVER read or write visitor_id /
 * session_id / conversation_id from localStorage — the server is the only
 * source of truth for visitor identity.
 *
 * The runtime shell tracks the current `conversationId` in memory (received
 * from /identity/history or returned by /message). Polling is rebound when it
 * changes.
 */
(function () {
  'use strict';

  function buildUrl(base, path, params) {
    var qs = [];
    if (params) {
      for (var k in params) {
        if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
          qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
        }
      }
    }
    return base + path + (qs.length ? '?' + qs.join('&') : '');
  }

  // Strip sensitive query params from a URL string. Returns sanitized string.
  // Used for the visitor's current page URL so we never leak tokens upstream.
  var SENSITIVE_QS = ['token','access_token','refresh_token','code','password','session','auth','key','secret','api_key','sig','signature'];
  function sanitizeUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;
    try {
      var u = new URL(raw);
      u.hash = '';
      var sp = u.searchParams;
      for (var i = 0; i < SENSITIVE_QS.length; i++) sp.delete(SENSITIVE_QS[i]);
      var s = u.toString();
      if (s.length > 1000) s = s.slice(0, 1000);
      return s;
    } catch (_) { return null; }
  }
  // Normalize a string: trim + collapse internal whitespace + length cap.
  function normTitle(s) {
    if (!s || typeof s !== 'string') return null;
    var t = s.replace(/\s+/g, ' ').trim();
    if (!t) return null;
    return t.length > 300 ? t.slice(0, 300) : t;
  }
  // Read a meta tag's content by attribute name/value pair, safely.
  function readMeta(attr, val) {
    try {
      if (typeof document === 'undefined') return null;
      var el = document.querySelector('meta[' + attr + '="' + val + '"]');
      if (!el) return null;
      return normTitle(el.getAttribute('content') || '');
    } catch (_) { return null; }
  }
  function readH1() {
    try {
      if (typeof document === 'undefined') return null;
      var nodes = document.getElementsByTagName('h1');
      for (var i = 0; i < nodes.length && i < 5; i++) {
        var n = nodes[i];
        if (!n) continue;
        if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') continue;
        var t = normTitle(n.textContent || '');
        if (t) return t;
      }
      return null;
    } catch (_) { return null; }
  }
  // Public-page-only title extraction. Never reads inputs, cookies, storage.
  function getSafePageTitle() {
    var t = readMeta('property', 'og:title');
    if (t) return { title: t, source: 'og:title' };
    t = readMeta('name', 'twitter:title');
    if (t) return { title: t, source: 'twitter:title' };
    t = readH1();
    if (t) return { title: t, source: 'h1' };
    try {
      if (typeof document !== 'undefined') {
        var d = normTitle(document.title || '');
        if (d) return { title: d, source: 'document.title' };
      }
    } catch (_) {}
    return { title: null, source: null };
  }
  function buildPageContext() {
    try {
      if (typeof window === 'undefined' || !window.location) return null;
      var loc = window.location;
      var url = sanitizeUrl(loc.href || '');
      if (!url) return null;
      var parsed = null;
      try { parsed = new URL(url); } catch (_) { parsed = null; }
      var titleInfo = getSafePageTitle();
      var ref = (typeof document !== 'undefined' && document.referrer) ? sanitizeUrl(document.referrer) : null;
      if (ref && ref.length > 1000) ref = ref.slice(0, 1000);
      var ctx = {
        currentPageUrl: url,
        currentPageOrigin: parsed ? parsed.origin : (loc.origin || null),
        currentPagePath: parsed ? parsed.pathname : (loc.pathname || null),
        currentPageTitle: titleInfo.title,
        referrer: ref,
      };
      // Non-enumerable-ish hint for debug only; not sent to backend.
      ctx.__titleSource = titleInfo.source;
      return ctx;
    } catch (_) { return null; }
  }

  // Phase 9 — gated debug. Visitor opts in with:
  //   localStorage.setItem('gs:debug', '1')
  // Used to verify in production that the page-aware payload is leaving
  // the browser. Never logs cookies, tokens, or sensitive query params.
  function isDebug() {
    try { return typeof localStorage !== 'undefined' && localStorage.getItem('gs:debug') === '1'; }
    catch (_) { return false; }
  }
  function dbg() {
    if (!isDebug()) return;
    try { console.log.apply(console, arguments); } catch (_) {}
  }

  window.__gs_mod_chat = {
    sendMessage: function (opts) {
      var apiBase = opts.apiBase;
      var workspaceId = opts.workspaceId;
      // `opts.fetchWith`, when provided by the runtime, transparently injects
      // the current session token AND retries once with a fresh one on 401/403.
      // Falling back to a plain fetch keeps backward compatibility with any
      // caller that hasn't been upgraded yet.
      var fetchWith = opts.fetchWith || function (url, init) {
        init = init || {}; init.credentials = init.credentials || 'include';
        var h = init.headers || {}; h['X-Widget-Token'] = opts.sessionToken || '';
        init.headers = h; return fetch(url, init);
      };
      var conversationId = opts.conversationId || null;
      // Only meaningful when there is no conversationId: asks the server to
      // create a fresh thread instead of reusing the visitor's open one.
      var forceNewConversation = !conversationId && !!opts.forceNewConversation;

      var attachmentId = opts.attachmentId || null;
      var text = opts.text;
      var departmentId = opts.departmentId || null;
      var onReply = opts.onReply;
      var onConversation = opts.onConversation;
      // Phase 7 — receives { conversationId, messageId } once the backend
      // has accepted and persisted the message. Drives the sending → sent
      // lifecycle transition. Never invoked on failure.
      var onAccepted = opts.onAccepted;
      var onError = opts.onError;

      if (!apiBase || !workspaceId) {
        if (onError) onError('missing_config');
        return;
      }

      var pageCtx = buildPageContext();
      var titleSource = pageCtx ? pageCtx.__titleSource : null;
      // Strip debug-only hint before sending over the wire.
      var pageCtxOut = null;
      if (pageCtx) {
        pageCtxOut = {
          currentPageUrl: pageCtx.currentPageUrl,
          currentPageOrigin: pageCtx.currentPageOrigin,
          currentPagePath: pageCtx.currentPagePath,
          currentPageTitle: pageCtx.currentPageTitle,
          referrer: pageCtx.referrer,
        };
      }
      dbg('[Widget Runtime] active message sender', { file: 'runtime-chat.js', path: '/api/widget/message' });
      dbg('[Widget Runtime] page_context built', pageCtxOut ? {
        currentPageUrl: pageCtxOut.currentPageUrl,
        currentPagePath: pageCtxOut.currentPagePath,
        currentPageTitle: pageCtxOut.currentPageTitle,
        titleSource: titleSource,
      } : null);
      dbg('[Widget Runtime] payload includes page_context', !!pageCtxOut);

      fetchWith(apiBase + '/api/widget/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: workspaceId,
          conversation_id: conversationId || undefined,
          force_new_conversation: forceNewConversation || undefined,
          attachment_id: attachmentId || undefined,

          message: text,
          department_id: departmentId || undefined,
          // Canonical key only. Backend still accepts the legacy `pageContext`
          // alias from older deployed runtimes for backward compatibility.
          page_context: pageCtxOut || undefined,
        }),
      })
        .then(function (r) {
          if (!r.ok) throw new Error('http_' + r.status);
          return r.json();
        })
        .then(function (data) {
          if (data.conversation_id && onConversation) {
            onConversation(data.conversation_id);
          }
          // Phase 7 — backend-confirmed acceptance. Triggers sending → sent.
          if (onAccepted) {
            onAccepted({
              conversationId: data.conversation_id || null,
              messageId: data.message_id || null,
            });
          }
          if (data.reply && onReply) onReply(data.reply);
        })
        .catch(function (err) {
          if (onError) onError(err);
        });
    },

    /**
     * Smart history continuation. Reads HttpOnly cookie server-side and
     * returns the most recent conversation if it is within the workspace's
     * configured continue window. Returns conversation_id + messages (or null).
     */
    loadHistory: function (opts) {
      var apiBase = opts.apiBase;
      var workspaceId = opts.workspaceId;
      var fetchWith = opts.fetchWith || function (url, init) {
        init = init || {}; init.credentials = init.credentials || 'include';
        var h = init.headers || {}; h['X-Widget-Token'] = opts.sessionToken || '';
        init.headers = h; return fetch(url, init);
      };
      var onResult = opts.onResult; // ({ conversationId, messages })

      if (!apiBase || !workspaceId) return;

      fetchWith(buildUrl(apiBase, '/api/widget/identity/history', { workspace_id: workspaceId }), {})
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (onResult) {
            onResult({
              conversationId: data.conversation_id || null,
              messages: data.messages || [],
            });
          }
        })
        .catch(function () {
          if (onResult) onResult({ conversationId: null, messages: [] });
        });
    },

    startPolling: function (opts) {
      var apiBase = opts.apiBase;
      var workspaceId = opts.workspaceId;
      // Polling lives long enough that the token WILL expire mid-loop. We
      // route every tick through fetchWith() so refresh + retry happen
      // transparently, and we never freeze with a stale token.
      var fetchWith = opts.fetchWith || function (url, init) {
        init = init || {}; init.credentials = init.credentials || 'include';
        var h = init.headers || {}; h['X-Widget-Token'] = opts.sessionToken || '';
        init.headers = h; return fetch(url, init);
      };
      var getConversationId = opts.getConversationId; // function returning current cid
      var onMessages = opts.onMessages;
      var onConversation = opts.onConversation;
      var onTick = opts.onTick; // (ok: boolean) — connection health signal
      var interval = opts.interval || 5000;

      var pollId = setInterval(function () {
        var cid = typeof getConversationId === 'function' ? getConversationId() : null;
        var url = buildUrl(apiBase, '/api/widget/poll', {
          workspace_id: workspaceId,
          conversation_id: cid || undefined,
        });

        fetchWith(url, {})
          .then(function (r) {
            if (!r.ok) {
              // Stale conversation id (closed/deleted/foreign) → drop it so
              // the next tick re-resolves via cookie identity. Prevents
              // infinite 403 loops on a recycled cid.
              if (r.status === 403 && cid && opts.onConversationDenied) {
                try { opts.onConversationDenied(cid); } catch (_) {}
              }
              throw new Error('poll_http_' + r.status);
            }
            return r.json();
          })
          .then(function (data) {
            if (data.conversation_id && onConversation) {
              onConversation(data.conversation_id);
            }
            if (onMessages && data.messages && data.messages.length > 0) {
              onMessages(data.messages);
            }
            // Phase 8B — polling-mode call detection. When realtime is down
            // and an operator initiates a call, the widget learns about it
            // here. Dispatch is idempotent — runtime-call dedupes by call_id.
            if (data.active_call && data.active_call.id) {
              try {
                if (window.__gs_call && typeof window.__gs_call.ringingFromPoll === 'function') {
                  window.__gs_call.ringingFromPoll(data.active_call);
                } else if (window.__gs && typeof window.__gs.push === 'function') {
                  window.__gs.push(['call:ringing-poll', data.active_call]);
                }
              } catch (_) {}
            }
            if (onTick) onTick(true);
          })
          .catch(function () { if (onTick) onTick(false); });
      }, interval);

      return { stop: function () { clearInterval(pollId); } };
    },
  };
})();
