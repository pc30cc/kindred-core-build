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

  window.__gs_mod_chat = {
    sendMessage: function (opts) {
      var apiBase = opts.apiBase;
      var workspaceId = opts.workspaceId;
      var sessionToken = opts.sessionToken;
      var conversationId = opts.conversationId || null;
      var text = opts.text;
      var onReply = opts.onReply;
      var onConversation = opts.onConversation;
      var onError = opts.onError;

      if (!apiBase || !workspaceId) {
        if (onError) onError('missing_config');
        return;
      }

      fetch(apiBase + '/api/widget/message', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Widget-Token': sessionToken || '',
        },
        body: JSON.stringify({
          workspace_id: workspaceId,
          conversation_id: conversationId || undefined,
          message: text,
        }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.conversation_id && onConversation) {
            onConversation(data.conversation_id);
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
      var sessionToken = opts.sessionToken;
      var onResult = opts.onResult; // ({ conversationId, messages })

      if (!apiBase || !workspaceId) return;

      fetch(
        buildUrl(apiBase, '/api/widget/identity/history', { workspace_id: workspaceId }),
        {
          credentials: 'include',
          headers: { 'X-Widget-Token': sessionToken || '' },
        }
      )
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
      var sessionToken = opts.sessionToken;
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

        fetch(url, {
          credentials: 'include',
          headers: { 'X-Widget-Token': sessionToken || '' },
        })
          .then(function (r) {
            if (!r.ok) throw new Error('poll_http_' + r.status);
            return r.json();
          })
          .then(function (data) {
            if (data.conversation_id && onConversation) {
              onConversation(data.conversation_id);
            }
            if (onMessages && data.messages && data.messages.length > 0) {
              onMessages(data.messages);
            }
            if (onTick) onTick(true);
          })
          .catch(function () { if (onTick) onTick(false); });
      }, interval);

      return { stop: function () { clearInterval(pollId); } };
    },
  };
})();
