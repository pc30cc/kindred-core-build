/**
 * Widget Module: Chat
 * Lazy-loaded when user sends first message.
 */
(function () {
  'use strict';

  window.__gs_mod_chat = {
    sendMessage: function (opts) {
      var apiBase = opts.apiBase;
      var workspaceId = opts.workspaceId;
      var sessionToken = opts.sessionToken;
      var text = opts.text;
      var onReply = opts.onReply;
      var onError = opts.onError;

      if (!apiBase || !workspaceId) {
        if (onError) onError('missing_config');
        return;
      }

      fetch(apiBase + '/api/widget/message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Widget-Token': sessionToken || '',
        },
        body: JSON.stringify({
          workspace_id: workspaceId,
          visitor_id: localStorage.getItem('__gs_vid') || '',
          session_id: localStorage.getItem('__gs_sid') || undefined,
          conversation_id: localStorage.getItem('__gs_cid') || undefined,
          message: text,
        }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.reply && onReply) onReply(data.reply);
          if (data.conversation_id) {
            localStorage.setItem('__gs_cid', data.conversation_id);
          }
        })
        .catch(function (err) {
          if (onError) onError(err);
        });
    },

    loadHistory: function (opts) {
      var apiBase = opts.apiBase;
      var workspaceId = opts.workspaceId;
      var sessionToken = opts.sessionToken;
      var conversationId = opts.conversationId || localStorage.getItem('__gs_cid');
      var onMessages = opts.onMessages;

      if (!apiBase || !workspaceId || !conversationId) return;

      fetch(
        apiBase + '/api/widget/history?workspace_id=' + encodeURIComponent(workspaceId) +
        '&conversation_id=' + encodeURIComponent(conversationId) +
        '&visitor_id=' + encodeURIComponent(localStorage.getItem('__gs_vid') || ''),
        { headers: { 'X-Widget-Token': sessionToken || '' } }
      )
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (onMessages && data.messages) onMessages(data.messages);
        })
        .catch(function () {});
    },

    startPolling: function (opts) {
      var apiBase = opts.apiBase;
      var workspaceId = opts.workspaceId;
      var sessionToken = opts.sessionToken;
      var onMessages = opts.onMessages;
      var interval = opts.interval || 5000;

      var pollId = setInterval(function () {
        var cid = localStorage.getItem('__gs_cid');
        if (!cid) return;

        fetch(
          apiBase + '/api/widget/poll?workspace_id=' + encodeURIComponent(workspaceId) +
          '&conversation_id=' + encodeURIComponent(cid) +
          '&visitor_id=' + encodeURIComponent(localStorage.getItem('__gs_vid') || ''),
          { headers: { 'X-Widget-Token': sessionToken || '' } }
        )
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (onMessages && data.messages && data.messages.length > 0) {
              onMessages(data.messages);
            }
          })
          .catch(function () {});
      }, interval);

      return { stop: function () { clearInterval(pollId); } };
    },
  };
})();
