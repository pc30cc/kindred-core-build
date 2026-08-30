/**
 * Widget Presentation — "classic" renderer.
 *
 * SINGLE SOURCE OF TRUTH for the chat widget's markup. Registered under
 * `window.__gs_presentation_classic` and resolved through
 * `presentation/registry.js`.
 *
 * CONTRACT (see docs/WIDGET_PRESENTATION_ARCHITECTURE.md)
 *   create(env) -> renderer
 *     env    = { t, escapeHtml, config, locale, primaryColor }
 *     render = pure functions: (view-model) -> HTML string
 *
 * Rules for every presentation implementation:
 *   - NEVER touch transport, fetch, realtime, stores or the DOM.
 *   - NEVER read application state directly — everything arrives as a
 *     view-model argument produced by Widget Core.
 *   - Interaction is expressed with behaviour hooks (data-* attributes)
 *     that Core binds; visual classes carry no behavioural meaning.
 *
 * This renderer is a VERBATIM extraction of the markup that used to live
 * inside runtime.js. It intentionally produces pixel-identical output.
 */
(function () {
  'use strict';

  function create(env) {
    env = env || {};
    var t = env.t || function (k) { return k; };
    var config = env.config || {};
    var Util = { escapeHtml: env.escapeHtml };
    // Legacy alias kept so the extracted markup below reads unchanged.
    var ctx = {
      config: config,
      locale: env.locale,
      primaryColor: env.primaryColor,
      loadAuthedMediaBlobUrl: env.loadAuthedMediaBlobUrl,
    };

  function emptyHtml() {
    // Server-authoritative welcome message (workspace override → platform default).
    // Rendered as a real operator bubble — same look & feel as a live operator
    // reply — so the visitor immediately sees the conversation has "started".
    // Falls back to the i18n `intro` string only if backend sent nothing.
    // Phase 4 — when AI Agent is enabled in an auto-reply mode AND the
    // pre-chat AI intro is enabled, the AI intro IS the first assistant
    // message. Skip the generic greeting entirely so we don't show two.
    var ai = ctx.config && ctx.config.aiAgent;
    if (ai && ai.suppressGreeting === true) {
      try { console.debug('[Widget AI Agent] generic greeting suppressed'); } catch (_) {}
      return '<div class="messages welcome-only"></div>';
    }
    var welcome = (ctx.config && typeof ctx.config.welcomeMessage === 'string' && ctx.config.welcomeMessage.trim().length > 0)
      ? ctx.config.welcomeMessage
      : t('intro');
    var lines = String(welcome).split(/\n+/).map(function (l) {
      return Util.escapeHtml(l);
    }).join('<br>');
    return       '<div class="messages welcome-only">' +
        '<div class="msg-row operator">' +
          (function () {
            // Chat bubbles show the operator's profile picture — never the
            // workspace logo.
            var team = (ctx.config && Array.isArray(ctx.config.teamMembers)) ? ctx.config.teamMembers : [];
            var op = team.find ? team.find(function (m) { return m && (m.avatar_url || m.avatar); }) : null;
            var opAvatar = op && (op.avatar_url || op.avatar);
            if (opAvatar) {
              return '<span class="msg-avatar has-img"><img src="' + Util.escapeHtml(String(opAvatar)) + '" alt="" loading="lazy" decoding="async" /></span>';
            }
            var opName = (team[0] && (team[0].name || team[0].full_name)) || '';
            var initial = ((opName || (ctx.config && ctx.config.brandName ? ctx.config.brandName : 'S')).trim().charAt(0) || 'S').toUpperCase();
            return '<span class="msg-avatar" aria-hidden="true">' + Util.escapeHtml(initial) + '</span>';
          })() +
          '<div class="msg operator welcome-bubble">' + lines + '</div>' +
        '</div>' +
      '</div>';
  }

  function qnaChipsHtml(qnaState) {
    var QNA_COLLAPSED_COUNT = qnaState.collapsedCount || 3;
    var all = qnaState.questions || [];
    var visible = qnaState.expanded ? all : all.slice(0, QNA_COLLAPSED_COUNT);
    var remaining = all.length - visible.length;
    var chipsHtml = visible.map(function (q) {
      var text = (q && q.question) ? String(q.question) : '';
      if (!text) return '';
      return '<button type="button" class="qna-chip" data-qna-question="' +
        Util.escapeHtml(text) + '">' + Util.escapeHtml(text) + '</button>';
    }).join('');
    var moreHtml = (!qnaState.expanded && remaining > 0)
      ? '<button type="button" class="qna-more-btn" data-qna-more>' +
          Util.escapeHtml(t('qnaMore')) +
          '<span class="qna-more-count">+' + remaining + '</span>' +
        '</button>'
      : '';
    return '<div class="qna-suggestions" data-qna>' +
      '<div class="qna-title">' + Util.escapeHtml(t('qnaTitle')) + '</div>' +
      '<div class="qna-chips">' + chipsHtml + moreHtml + '</div>' +
    '</div>';
  }

  function humanSize(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / (1024 * 1024)).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  }
  function attachmentProxyUrl(id) {
    var apiBase = ctx.config.apiBase || '';
    return apiBase + '/api/widget/attachments/' + encodeURIComponent(id);
  }
  // The proxy route requires the X-Widget-Token header (see server —
  // "single auth header"), which a plain <img>/<audio> src or <a href>
  // navigation can never send. ctx.loadAuthedMediaBlobUrl (defined once on
  // the shared ctx in __gs_runtime.init, since the lightbox needs the same
  // helper outside this closure) does an authenticated fetch instead and
  // hands back a blob: URL.
  function renderMessageAttachment(att) {
    if (!att || !att.id) return '';
    var id = Util.escapeHtml(att.id);
    var name = Util.escapeHtml(att.file_name || 'file');
    var size = humanSize(att.size_bytes);
    var isImage = att.kind === 'image' || (att.mime_type && /^image\//.test(att.mime_type));
    var isAudio = att.kind === 'audio' || (att.mime_type && /^audio\//.test(att.mime_type));
    if (isImage) {
      return '<div class="msg-att msg-att-image">' +
        '<button type="button" class="msg-att-img-btn" data-att-preview="' + id + '" aria-label="' + Util.escapeHtml(t('openFile')) + '">' +
          '<img loading="lazy" decoding="async" data-att-media-src="' + id + '" alt="' + name + '" />' +
          '<span class="msg-att-img-fallback">' + Util.escapeHtml(t('imageUnavailable')) + '</span>' +
        '</button>' +
        '</div>';
    }
    if (isAudio) {
      return '<div class="msg-att msg-att-audio">' +
        '<audio controls preload="none" data-att-media-src="' + id + '"></audio>' +
        '</div>';
    }
    var iconSvg = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
    return '<div class="msg-att msg-att-file">' +
      '<div class="msg-att-icon">' + iconSvg + '</div>' +
      '<div class="msg-att-meta">' +
        '<div class="msg-att-name" title="' + name + '">' + name + '</div>' +
        '<div class="msg-att-sub">' + Util.escapeHtml(size) + '</div>' +
      '</div>' +
      '<a class="msg-att-action" href="#" data-att-download="' + id + '" data-att-download-name="' + name + '" aria-label="' + Util.escapeHtml(t('download')) + '">' +
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4v12m0 0l-4-4m4 4l4-4"/><path d="M5 20h14"/></svg>' +
      '</a>' +
      '</div>';
  }

  // ─── Phase 9 — Call invitation card renderer ───
  // System messages with metadata.kind === 'call_invitation' are rendered
  // as an interactive card. The persisted system message is the canonical
  // source; this is purely presentation. Click handlers are wired via
  // event delegation in renderChat() below, so re-renders never leak

  function fmtInvitationRemaining(expiresAtIso) {
    var ms = new Date(expiresAtIso).getTime() - Date.now();
    if (!isFinite(ms) || ms <= 0) return t('ciStateExpired') || 'Expired';
    var total = Math.ceil(ms / 1000);
    var timeStr;
    if (total < 60) {
      timeStr = (t('ciSeconds') || '{s}s').replace('{s}', String(total));
    } else {
      var m = Math.floor(total / 60);
      var s = total % 60;
      if (s === 0) timeStr = (t('ciMinutes') || '{m}m').replace('{m}', String(m));
      else timeStr = (t('ciMinutesSeconds') || '{m}m {s}s').replace('{m}', String(m)).replace('{s}', String(s));
    }
    return (t('ciTimeLeft') || '{time} left').replace('{time}', timeStr);
  }

  // Pass A — Format duration_seconds as mm:ss / hh:mm:ss.
  function fmtCallDuration(seconds) {
    var s = Math.max(0, Math.floor(Number(seconds) || 0));
    var hh = Math.floor(s / 3600);
    var mm = Math.floor((s % 3600) / 60);
    var ss = s % 60;
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return hh > 0 ? pad(hh) + ':' + pad(mm) + ':' + pad(ss) : pad(mm) + ':' + pad(ss);
  }

  // Pass A — Render the system "call ended" summary row in chat.
  function renderCallEndedRow(msg) {
    var meta = msg.metadata || {};
    var endedBy = String(meta.ended_by || 'system');
    var endReason = String(meta.end_reason || '');
    var dur = Number(meta.duration_seconds) || 0;
    var isMissed = endReason === 'failed' || dur <= 0;
    var key;
    if (isMissed) {
      key = 'csEndedNotConnected';
    } else if (endedBy === 'operator') {
      key = 'csEndedByOperator';
    } else if (endedBy === 'visitor') {
      key = 'csEndedByVisitor';
    } else {
      key = 'csEndedBySystem';
    }
    var fallback;
    if (isMissed) {
      fallback = 'Call did not connect';
    } else if (endedBy === 'operator') {
      fallback = 'Call ended by operator · Duration ' + fmtCallDuration(dur);
    } else if (endedBy === 'visitor') {
      fallback = 'Call ended by visitor · Duration ' + fmtCallDuration(dur);
    } else {
      fallback = 'Call ended · Duration ' + fmtCallDuration(dur);
    }
    var raw = t(key);
    var text = (raw && raw !== key)
      ? String(raw).replace('{duration}', fmtCallDuration(dur))
      : fallback;
    var icon = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2A19.79 19.79 0 0 1 8.63 18.5"/>'
      + '<line x1="23" y1="1" x2="1" y2="23"/></svg>';
    return '<div class="msg-row system"><div class="msg-system-pill">'
      + icon + '<span>' + Util.escapeHtml(text) + '</span>'
      + '</div></div>';
  }

  // Agent-routing outcome row — spec §22: "Connecting…" must always
  // resolve to something concrete. Never fabricates an agent name (only
  // renders one when the server actually resolved and sent one).
  function renderRoutingOutcomeRow(msg) {
    var meta = msg.metadata || {};
    var kind = meta.kind;
    var text;
    if (kind === 'routing_agent_joined') {
      var name = meta.agent_name ? String(meta.agent_name) : '';
      var raw = t('routingAgentJoined');
      text = (raw && raw !== 'routingAgentJoined' && name)
        ? String(raw).replace('{name}', name)
        : (name ? (name + ' ' + t('routingAgentJoinedSuffix')) : t('routingAgentJoinedGeneric'));
    } else if (kind === 'routing_no_agent_available') {
      text = t('routingNoAgentAvailable');
    } else {
      text = t('routingInQueue');
    }
    var icon = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
    if (kind === 'routing_agent_joined') {
      icon = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
    }
    return '<div class="msg-row system"><div class="msg-system-pill">'
      + icon + '<span>' + Util.escapeHtml(text) + '</span>'
      + '</div></div>';
  }

  function renderCallInvitationCard(msg) {
    var meta = msg.metadata || {};
    var channel = meta.channel === 'video' ? 'video' : 'audio';
    var status = meta.status || 'pending';
    var inviteId = Util.escapeHtml(meta.invitation_id || '');
    var op = meta.operator_name ? Util.escapeHtml(meta.operator_name) : '';
    var headlineKey = channel === 'video'
      ? (op ? 'ciHeadlineVideoFrom' : 'ciHeadlineVideo')
      : (op ? 'ciHeadlineAudioFrom' : 'ciHeadlineAudio');
    var headlineTpl = t(headlineKey) || (channel === 'video' ? 'You have been invited to a video call' : 'You have been invited to an audio call');
    var headline = op ? headlineTpl.replace('{op}', op) : headlineTpl;
    var iconSvg = channel === 'video'
      ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>'
      : '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92Z"/></svg>';

    var statusBlock = '';
    var actionBlock = '';
    var bodyBlock = '';
    var stateLabel = '';
    if (status === 'pending') {
      // Body line: "An operator is inviting you to a voice call."
      // + "The operator will wait up to X minutes for you to join."
      var bodyKey = channel === 'video' ? 'ciBodyVideo' : 'ciBodyAudio';
      var bodyText = t(bodyKey) || (channel === 'video'
        ? 'An operator is inviting you to a video call.'
        : 'An operator is inviting you to a voice call.');
      var waitMinutes = (typeof meta.wait_minutes === 'number' && isFinite(meta.wait_minutes) && meta.wait_minutes > 0)
        ? Math.round(meta.wait_minutes)
        : 0;
      // Fallback: derive from expires_at if server didn't provide wait_minutes.
      if (!waitMinutes && meta.expires_at) {
        var deltaMs = new Date(meta.expires_at).getTime() - new Date(msg.createdAt || Date.now()).getTime();
        if (isFinite(deltaMs) && deltaMs > 0) {
          waitMinutes = Math.max(1, Math.round(deltaMs / 60000));
        }
      }
      var waitLine = '';
      if (waitMinutes === 1) {
        waitLine = t('ciWaitOneMinute') || 'The operator will wait up to one minute for you to join.';
      } else if (waitMinutes > 1) {
        waitLine = (t('ciWaitMinutes') || 'The operator will wait up to {m} minutes for you to join.')
          .replace('{m}', String(waitMinutes));
      }
      bodyBlock = '<div class="ci-body">' +
        '<div>' + Util.escapeHtml(bodyText) + '</div>' +
        (waitLine ? '<div class="ci-wait">' + Util.escapeHtml(waitLine) + '</div>' : '') +
      '</div>';

      var rem = Util.escapeHtml(fmtInvitationRemaining(meta.expires_at));
      statusBlock = '<div class="ci-meta ci-countdown" aria-live="polite">' +
        '<span class="ci-pulse" aria-hidden="true"></span>' + rem +
      '</div>';
      var joinLabel = channel === 'video'
        ? (t('ciJoinVideo') || 'Join video call')
        : (t('ciJoinAudio') || 'Join call');
      var joinAria = channel === 'video'
        ? (t('ciAriaJoinVideo') || 'Join the video call now')
        : (t('ciAriaJoinAudio') || 'Join the audio call now');
      var declineLabel = t('ciDecline') || 'Decline';
      var declineAria = t('ciAriaDecline') || 'Decline this call invitation';
      actionBlock = '<div class="ci-actions">' +
        '<button type="button" class="ci-btn ci-btn-primary" data-ci-action="join" data-ci-id="' + inviteId +
          '" data-ci-channel="' + channel + '" aria-label="' + Util.escapeHtml(joinAria) + '">' +
          Util.escapeHtml(joinLabel) +
        '</button>' +
        '<button type="button" class="ci-btn ci-btn-ghost" data-ci-action="decline" data-ci-id="' + inviteId +
          '" aria-label="' + Util.escapeHtml(declineAria) + '">' +
          Util.escapeHtml(declineLabel) +
        '</button>' +
      '</div>';
    } else {
      if (status === 'joined') stateLabel = t('ciStateJoined') || 'You joined the call';
      else if (status === 'expired') stateLabel = t('ciStateExpired') || 'Invitation expired';
      else if (status === 'cancelled') stateLabel = t('ciStateCancelled') || 'Operator cancelled the invitation';
      else if (status === 'declined') stateLabel = t('ciStateDeclined') || 'You declined this call';
      statusBlock = '<div class="ci-meta ci-status ci-status-' + Util.escapeHtml(status) + '">' + Util.escapeHtml(stateLabel) + '</div>';
    }

    var ariaCard = (t('ciAriaCard') || 'Call invitation') + ' — ' +
      (channel === 'video' ? (t('videoCall') || 'Video') : (t('voiceCall') || 'Voice'));
    return '<div class="msg-row system">' +
      '<div class="ci-card ci-channel-' + channel + ' ci-status-' + Util.escapeHtml(status) +
        '" data-ci-card="' + inviteId + '" role="group" aria-label="' + Util.escapeHtml(ariaCard) + '">' +
        '<div class="ci-row">' +
          '<span class="ci-icon" aria-hidden="true">' + iconSvg + '</span>' +
          '<div class="ci-text">' +
            '<div class="ci-title">' + Util.escapeHtml(headline) + '</div>' +
            bodyBlock +
            statusBlock +
          '</div>' +
        '</div>' +
        actionBlock +
      '</div>' +
    '</div>';
  }

  function formatMsgTime(d) {
    try {
      var date = (d instanceof Date) ? d : new Date(d);
      if (!date || isNaN(date.getTime())) return '';
      return date.toLocaleTimeString(ctx.locale || undefined, { hour: '2-digit', minute: '2-digit' });
    } catch (_) { return ''; }
  }

  // Shared pre-chat field icons — used by both the full-page pre-chat
  // form (initial entry) and the inline handoff pre-chat card (mid-thread).
  var PRECHAT_ICONS = {
    name: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    email: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92Z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  };

  function renderPrechatFieldRow(identity, key, type, value) {
    var label = t(key);
    var ph = t('prechat' + key.charAt(0).toUpperCase() + key.slice(1) + 'Ph') || label;
    var req = identity.isRequired(key);
    // Inline "required" marker — single red asterisk next to the label,
    // matching native form conventions. Optional fields show nothing.
    var badge = req
      ? '<span class="prechat-req-mark" aria-label="' + Util.escapeHtml(t('required')) + '" title="' + Util.escapeHtml(t('required')) + '">*</span>'
      : '';
    var ac = key === 'name' ? 'name' : key === 'email' ? 'email' : 'tel';
    var inputDir = key === 'email' || key === 'phone' ? 'ltr' : '';
    return '<div class="prechat-field" data-field="' + key + '">' +
        '<div class="prechat-row">' +
          '<label class="prechat-label" for="prechat-' + key + '">' +
            Util.escapeHtml(label) + badge +
          '</label>' +
        '</div>' +
        '<div class="prechat-control">' +
          '<span class="prechat-icon" aria-hidden="true">' + PRECHAT_ICONS[key] + '</span>' +
          '<input id="prechat-' + key + '" class="prechat-input" data-prechat="' + key + '" type="' + type +
            '" autocomplete="' + ac + '"' +
            (inputDir ? ' dir="' + inputDir + '"' : '') +
            ' placeholder="' + Util.escapeHtml(ph) + '"' +
            (req ? ' aria-required="true"' : '') +
            ' aria-invalid="false" aria-describedby="prechat-err-' + key + '"' +
            ' value="' + Util.escapeHtml(value || '') + '" />' +
          '<span class="prechat-status" aria-hidden="true"></span>' +
        '</div>' +
        '<div class="prechat-error" id="prechat-err-' + key + '" data-err="' + key + '" role="alert" aria-live="polite"></div>' +
      '</div>';
  }

  // Wires validation + submit behavior for a rendered pre-chat field set —
  // shared by the full-page form and the inline handoff card, since both
  // emit the same `data-prechat`/`data-field`/`data-err`/data-prechat-submit`

  function renderAiThinkingRow() {
    return '<div class="msg-row operator ai-thinking-row">' +
      '<div class="msg operator ai-thinking-bubble">' +
        '<span class="ai-thinking-spark" aria-hidden="true"></span>' +
        '<span class="typing-dots"><span></span><span></span><span></span></span>' +
        '<span class="ai-thinking-label">' + Util.escapeHtml(t('aiThinking') || 'Thinking…') + '</span>' +
      '</div>' +
    '</div>';
  }

  function messagesHtml(s, extraRowHtml, view) {
    view = view || {};
    var typewriter = view.typewriter || null;
    var qnaState = view.qna || { questions: [], expanded: false };
    // Phase 7 — read-receipts toggle (admin-controlled, surfaced via /config).
    var rrCfg = ctx.config && ctx.config.readReceipts;
    var receiptsEnabled = !rrCfg || rrCfg.enabled !== false;
    // Find last visitor message — only it shows the lifecycle indicator
    // (chat-app convention; reduces visual noise).
    var lastVisitorIdx = -1;
    for (var lv = s.messages.length - 1; lv >= 0; lv--) {
      if (s.messages[lv].sender === 'visitor') { lastVisitorIdx = lv; break; }
    }
    var html = '<div class="messages">';
    // Group consecutive operator messages so we only show the avatar on the
    // last bubble of a streak (Intercom/Zendesk convention). Otherwise a
    // long agent reply produces a wall of repeated avatars.
    var groupKeys = s.messages.map(function (m) {
      return m.sender === 'visitor' ? 'v' : ('op:' + (m.senderName || '') + '|' + (m.senderAvatar || ''));
    });
    // Quick-question chips render right under the AI's intro bubble, only
    // while the visitor hasn't engaged yet — once they've sent their own
    // message the suggestions have done their job and would just be
    // clutter on an active thread.
    var visitorHasReplied = s.messages.some(function (m) { return m.sender === 'visitor'; });
    s.messages.forEach(function (m, idx) {
      // Phase 9 — Call invitation card. System messages with
      // metadata.kind === 'call_invitation' render as an interactive
      // card (Join / state) instead of a normal chat bubble.
      if (m.senderType === 'system' && m.metadata && m.metadata.kind === 'call_invitation') {
        html += renderCallInvitationCard(m);
        return;
      }
      // Pass A — Call-ended summary. System message with
      // metadata.kind === 'call_ended' renders as a centered system row
      // ("Call ended by operator · Duration 00:34"). Localized.
      if (m.senderType === 'system' && m.metadata && m.metadata.kind === 'call_ended') {
        html += renderCallEndedRow(m);
        return;
      }
      // Agent-routing outcome — connected / everyone busy / queued.
      // System messages inserted server-side by chatRouting.ts, same
      // centered-pill treatment as the call-ended row above.
      if (m.senderType === 'system' && m.metadata
          && (m.metadata.kind === 'routing_agent_joined'
            || m.metadata.kind === 'routing_no_agent_available'
            || m.metadata.kind === 'routing_in_queue')) {
        html += renderRoutingOutcomeRow(m);
        return;
      }
      var bg = m.sender === 'visitor' ? 'style="background:' + ctx.primaryColor + '"' : '';
      var cls = m.sender === 'visitor' ? 'visitor' : 'operator';
      var isAi = m.senderType === 'ai';
      var aiBadgeHtml = isAi
        ? '<span class="msg-ai-badge" aria-label="AI assistant" title="AI assistant">AI</span>'
        : '';
      var hasText = m.body && String(m.body).trim().length > 0;
      var attHtml = renderMessageAttachment(m.attachment);
      var extraCls = (attHtml && !hasText) ? ' has-att-only' : (attHtml ? ' has-att' : '');
      // Phase 7 — lifecycle row (sending/sent/seen/failed). Only on the last
      // visitor message, only when read receipts are enabled in config.
      var statusHtml = '';
      if (m.sender === 'visitor' && idx === lastVisitorIdx && receiptsEnabled && m.status) {
        var label, icon;
        if (m.status === 'sending') {
          label = t('msgSending'); icon = '<span class="msg-status-spinner"></span>';
        } else if (m.status === 'failed') {
          label = t('msgFailed'); icon = '<span class="msg-status-icon">!</span>';
        } else if (m.status === 'seen') {
          label = t('msgSeen'); icon = '<span class="msg-status-icon seen">✓✓</span>';
        } else { // 'sent'
          label = t('msgSent'); icon = '<span class="msg-status-icon">✓</span>';
        }
        statusHtml = '<div class="msg-status status-' + m.status + '">' + icon +
          '<span class="msg-status-label">' + Util.escapeHtml(label) + '</span></div>';
      }

      // Avatar slot: only shown on the LAST bubble of an operator streak,
      // so the visitor sees one face per message group. Visitor messages
      // have no avatar slot (their bubbles are right-aligned).
      var avatarHtml = '';
      if (cls === 'operator') {
        var isLastInStreak = idx === s.messages.length - 1 || groupKeys[idx + 1] !== groupKeys[idx];
        if (isLastInStreak) {
          if (m.senderAvatar) {
            avatarHtml = '<span class="msg-avatar has-img">' +
              '<img src="' + Util.escapeHtml(m.senderAvatar) + '" alt="' + Util.escapeHtml(m.senderName || t('operator')) + '" loading="lazy" decoding="async" />' +
            '</span>';
          } else {
            var initial = ((m.senderName || ctx.config.brandName || 'S').trim().charAt(0) || 'S').toUpperCase();
            avatarHtml = '<span class="msg-avatar" aria-hidden="true">' + Util.escapeHtml(initial) + '</span>';
          }
        } else {
          avatarHtml = '<span class="msg-avatar msg-avatar-spacer" aria-hidden="true"></span>';
        }
      }

      var timeStr = formatMsgTime(m.time);
      var timeHtml = timeStr ? '<span class="msg-time">' + Util.escapeHtml(timeStr) + '</span>' : '';

      // Visitor rows have no avatar slot, so `statusHtml` (sending/sent/
      // seen) takes that leading position instead — it must render
      // BEFORE the bubble, not after. `.msg-row.visitor` is packed to
      // the physical right edge (`justify-content: flex-end`), so a
      // trailing sibling lands OUTSIDE the bubble, past it, right up
      // against the panel edge — a leading sibling lands where a normal
      // chat app puts it: just inside the bubble, facing the rest of
      // the conversation.
      var leadingHtml = cls === 'operator' ? avatarHtml : statusHtml;

      // Word-by-word reveal — only the one message currently being
      // "typed" (see startTypewriter) renders its partial slice; every
      // other bubble (including this same one once the reveal finishes)
      // renders its full text as normal.
      var isTypingThis = !!(typewriter && typewriter.id === m.__id);
      var typingDone = isTypingThis && typewriter.revealedCount >= typewriter.tokens.length;
      var displayText = isTypingThis && !typingDone
        ? typewriter.tokens.slice(0, typewriter.revealedCount).join('')
        : m.body;
      var textHtml = hasText
        ? '<span class="msg-text"' + (isTypingThis && !typingDone ? ' data-typing-id="' + Util.escapeHtml(m.__id) + '"' : '') + '>' +
            Util.escapeHtml(displayText) +
          '</span>'
        : '';

      html += '<div class="msg-row ' + cls + '">' +
        leadingHtml +
        '<div class="msg ' + cls + extraCls + (isAi ? ' is-ai' : '') + '"' +
          (isTypingThis && !typingDone ? ' data-typing-host data-typing-active="1"' : '') + ' ' + bg + '>' +
          aiBadgeHtml +
          textHtml + attHtml + timeHtml +
        '</div>' +
        '</div>';

      // Right after the AI's intro bubble (and nowhere else), while the
      // visitor hasn't replied yet: quick-question chips sourced from the
      // workspace's own AI Q&A entries (ai_agent_qna) — reusing existing
      // content instead of a second, parallel "suggested questions" list.
      var isIntro = m.metadata && m.metadata.source === 'ai_agent_intro';
      if (isIntro && !visitorHasReplied && qnaState.questions.length) {
        html += qnaChipsHtml(qnaState);
      }
    });
    if (extraRowHtml) html += extraRowHtml;
    // Only while the thread is genuinely waiting: the indicator sits
    // directly UNDER the visitor's own last message and disappears the
    // instant any AI/operator message lands (even if it arrived through
    // history/polling rather than the realtime 'message' event).
    var lastMsg = s.messages && s.messages.length ? s.messages[s.messages.length - 1] : null;
    var waitingOnAi = !!lastMsg && (lastMsg.sender === 'visitor' || lastMsg.from === 'visitor' || lastMsg.author === 'visitor');
    if (s.aiThinking && waitingOnAi) html += renderAiThinkingRow();
    html += '</div>';
    return html;
  }

  // Event wiring for a rendered messages list — shared by the normal chat

  function handoffPrechatCardHtml(identity, contact, locale, subtitle, animateSubtitle) {
    contact = contact || {};
    var fieldsHtml = '';
    if (identity.isAsked('name')) fieldsHtml += renderPrechatFieldRow(identity, 'name', 'text', contact.name);
    if (identity.isAsked('email')) fieldsHtml += renderPrechatFieldRow(identity, 'email', 'email', contact.email);
    if (identity.isAsked('phone')) fieldsHtml += renderPrechatFieldRow(identity, 'phone', 'tel', contact.phone);
    var dir = locale === 'fa' ? 'rtl' : 'ltr';
    var iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
    // The prompt line animates word-by-word the first time it's shown
    // (data-typing-id="hc-subtitle" + empty text — startTypewriterFor
    // fills it in right after this HTML lands in the DOM). Every other
    // field/label here is already accessible/professional as-is — the
    // request was specifically about this line and about not boxing the
    // fields off from the rest of the conversation (see .hc-card CSS).
    var subtitleHtml = animateSubtitle
      ? '<div class="hc-subtitle" data-typing-host data-typing-active="1" data-typing-id="hc-subtitle"></div>'
      : '<div class="hc-subtitle">' + Util.escapeHtml(subtitle) + '</div>';
    // `.msg-row.visitor` (not `.operator`) — the pre-chat card sits on
    // the same physical side as the visitor's own outgoing messages, per
    // explicit request, rather than the AI/operator side.
    return '<div class="msg-row visitor">' +
      '<div class="hc-card prechat-pro" dir="' + dir + '" role="group" aria-label="' + Util.escapeHtml(t('prechatTitle')) + '">' +
        '<div class="hc-header">' +
          '<span class="hc-icon" aria-hidden="true">' + iconSvg + '</span>' +
          '<div class="hc-text">' +
            '<div class="hc-title">' + Util.escapeHtml(t('prechatTitle')) + '</div>' +
            subtitleHtml +
          '</div>' +
        '</div>' +
        '<div class="prechat-fields hc-fields">' + fieldsHtml + '</div>' +
        '<button type="button" class="prechat-submit hc-submit" data-prechat-submit>' +
          '<span class="prechat-submit-label">' + Util.escapeHtml(t('continue')) + '</span>' +
          '<span class="prechat-submit-arrow" aria-hidden="true">' +
            (dir === 'rtl'
              ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>'
              : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>') +
          '</span>' +
        '</button>' +
      '</div>' +
    '</div>';
  }

  function prechatFormHtml(identity, contact, locale) {
    contact = contact || {};
    var fieldsHtml = '';
    if (identity.isAsked('name')) fieldsHtml += renderPrechatFieldRow(identity, 'name', 'text', contact.name);
    if (identity.isAsked('email')) fieldsHtml += renderPrechatFieldRow(identity, 'email', 'email', contact.email);
    if (identity.isAsked('phone')) fieldsHtml += renderPrechatFieldRow(identity, 'phone', 'tel', contact.phone);

    var dir = locale === 'fa' ? 'rtl' : 'ltr';
    return       '<div class="prechat prechat-pro" dir="' + dir + '">' +
        '<div class="prechat-hero">' +
          '<h3 class="prechat-title">' + Util.escapeHtml(t('prechatTitle')) + '</h3>' +
          '<p class="prechat-subtitle">' + Util.escapeHtml(t('prechatSubtitle')) + '</p>' +
        '</div>' +
        '<div class="prechat-fields">' + fieldsHtml + '</div>' +
        '<button type="button" class="prechat-submit" data-prechat-submit>' +
          '<span class="prechat-submit-label">' + Util.escapeHtml(t('continue')) + '</span>' +
          '<span class="prechat-submit-arrow" aria-hidden="true">' +
            (dir === 'rtl'
              ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>'
              : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>') +
          '</span>' +
        '</button>' +
        '<p class="prechat-privacy">' +
          '<span class="prechat-privacy-icon" aria-hidden="true">' + PRECHAT_ICONS.lock + '</span>' +
          Util.escapeHtml(t('prechatPrivacy')) +
        '</p>' +
      '</div>';
  }

  function contactFallbackHtml(identity, contact, locale, presence) {
    contact = contact || {};
    var introCustom = (presence && presence.introLabel) ? presence.introLabel : '';
    var intro = introCustom || t('fallbackIntro');
    var dir = locale === 'fa' ? 'rtl' : 'ltr';

    function fieldRow(key, type, value, required) {
      var label = t(key);
      return '<div>' +
        '<label class="prechat-label" for="fb-' + key + '">' + Util.escapeHtml(label) +
          (required ? ' <span class="prechat-required">*</span>' : '') + '</label>' +
        '<input id="fb-' + key + '" class="input" data-fb="' + key + '" type="' + type +
        '" autocomplete="' + (key === 'name' ? 'name' : key === 'email' ? 'email' : 'tel') +
        '" placeholder="' + Util.escapeHtml(label) + '"' +
        (required ? ' aria-required="true"' : '') +
        ' aria-invalid="false" aria-describedby="fb-err-' + key + '"' +
        ' value="' + Util.escapeHtml(value || '') + '" />' +
        '<div class="prechat-error" id="fb-err-' + key + '" data-err="' + key + '" role="alert" aria-live="polite"></div>' +
      '</div>';
    }

    // Always ask for at least one contact channel + the message body.
    var askPhone = identity.isAsked('phone');
    var fieldsHtml = '';
    fieldsHtml += fieldRow('name', 'text', contact.name, identity.isRequired('name'));
    fieldsHtml += fieldRow('email', 'email', contact.email, !askPhone);
    if (askPhone) fieldsHtml += fieldRow('phone', 'tel', contact.phone, identity.isRequired('phone'));

    return       '<div class="prechat fallback" dir="' + dir + '">' +
      '<p class="prechat-intro">' + Util.escapeHtml(intro) + '</p>' +
      '<div class="prechat-fields">' + fieldsHtml +
        '<div>' +
          '<label class="prechat-label" for="fb-message">' + Util.escapeHtml(t('fallbackMessageLabel')) +
          ' <span class="prechat-required">*</span></label>' +
          '<textarea id="fb-message" class="input" data-fb="message" rows="3" placeholder="' +
            Util.escapeHtml(t('typeMsg')) + '"' +
            ' aria-required="true" aria-invalid="false" aria-describedby="fb-err-message"></textarea>' +
          '<div class="prechat-error" id="fb-err-message" data-err="message" role="alert" aria-live="polite"></div>' +
        '</div>' +
      '</div>' +
      '<button type="button" class="prechat-submit" data-fb-submit>' + Util.escapeHtml(t('fallbackSubmit')) + '</button>' +
      '<div class="fallback-status" data-fb-status role="status" aria-live="polite"></div>' +
      '</div>';

  }

  function smartSurfaceHtml(s) {
    return (s.dismissible === false
      ? ''
      : '<button type="button" class="smart-dismiss" data-smart-dismiss aria-label="close">\u00d7</button>') +
      (s.title ? '<div class="smart-title">' + Util.escapeHtml(s.title) + '</div>' : '') +
      '<div class="smart-body">' + Util.escapeHtml(s.body || '') + '</div>' +
      (s.ctaLabel
        ? '<button type="button" class="smart-cta" data-smart-cta style="background:' + env.primaryColor + '">' +
            Util.escapeHtml(s.ctaLabel) + '</button>'
        : '');
  }

  function shellHtml(vm) {
    var config = vm.config || {};
    var brandName = vm.brandName || '';
    var headerTitle = vm.headerTitle || '';
    var chatEnabled = !!vm.chatEnabled;
    var kbEnabled = !!vm.kbEnabled;
  var teamStackHtml = '';
  var __wsLogo = (config && config.logoUrl && config.showLogo !== false) ? String(config.logoUrl) : '';
  if (__wsLogo) {
    teamStackHtml = '<div class="header-op-stack" data-header-logo>' +
      '<span class="header-op-avatar has-img"><img src="' + Util.escapeHtml(__wsLogo) + '" alt="' +
      Util.escapeHtml(brandName || headerTitle) + '" loading="lazy" decoding="async" /></span></div>';
  }
  // Operator profile pictures are NEVER shown in the header — they belong
  // to the chat bubbles only. The header brands with the workspace logo.

  var headerRtl = (vm.locale || 'en').toLowerCase().split('-')[0] === 'fa';
  var headerDirAttr = headerRtl ? ' dir="rtl"' : '';
  var headerCls = 'header' + (headerRtl ? ' header-rtl' : '');
  var wsLogoUrl = (config && config.logoUrl && config.showLogo !== false) ? String(config.logoUrl) : '';
  // Header shows operator avatars only (workspace logo removed).
  var headerLogoHtml = wsLogoUrl
    ? '<span class="header-logo"><img src="' + Util.escapeHtml(wsLogoUrl) + '" alt="' +
      Util.escapeHtml(brandName || headerTitle) + '" loading="lazy" decoding="async" /></span>'
    : '';
  var headerCloseHtml = '<button type="button" class="header-close" data-panel-close aria-label="' +
    Util.escapeHtml(t('closeWidget') || 'Close') + '" title="' + Util.escapeHtml(t('closeWidget') || 'Close') + '">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="m6 9 6 6 6-6"/></svg></button>';
  var headerHtml = '<div class="' + headerCls + '"' + headerDirAttr + '>' +
    headerCloseHtml +
    '<div class="header-brand">' +
      teamStackHtml +
    '</div>' +
    '<div class="presence sr-only" data-presence aria-live="polite">' +
      '<span class="presence-dot" data-presence-dot></span>' +
      '<span class="presence-label" data-presence-label></span>' +
    '</div>' +
    '</div>';
  // Visitor-initiated voice/video tabs were removed — calls are now only
  // initiated from the operator side. Keep chat + help tabs only.
  var NAV_ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.8V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.8"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.2a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4"/><line x1="12" y1="17.5" x2="12.01" y2="17.5"/>',
  };
  var tabDefs = [{ key: 'home', label: t('home') }];
  if (chatEnabled) tabDefs.push({ key: 'chat', label: t('chat') });
  if (kbEnabled) tabDefs.push({ key: 'help', label: t('help') });
  var tabsHtml = '';
  if (tabDefs.length > 1) {
    var act = vm.activeTab;
    tabsHtml = '<div class="tabs tabs-bottom">' + tabDefs.map(function (d) {
      return '<button type="button" class="tab' + (act === d.key ? ' active' : '') +
        '" data-tab="' + d.key + '">' +
        '<svg class="tab-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
          NAV_ICONS[d.key] + '</svg>' +
        '<span class="tab-label">' + Util.escapeHtml(d.label) + '</span>' +
      '</button>';
    }).join('') + '</div>';
  }
  var bodyHtml = '<div class="body" data-body></div>';
  var attachCfg = (config && config.attachments) || { enabled: false };
  var composerCfg = (config && config.composer) || {};
  var micSupported = !!(typeof navigator !== 'undefined' && navigator.mediaDevices
    && navigator.mediaDevices.getUserMedia && typeof window.MediaRecorder === 'function');
  // Voice notes and file attachments are independent workspace toggles —
  // see server DEFAULT_WIDGET_SETTINGS.voice_notes_enabled /
  // .attachments_enabled. Emoji defaults to on unless explicitly disabled.
  var voiceNotesEnabled = attachCfg.voiceNotesEnabled === true;
  var emojiEnabled = composerCfg.emojiEnabled !== false;
  var inputHtml = chatEnabled
    ? '<div class="typing-row" data-typing-row hidden aria-live="polite">' +
        '<span class="typing-dots"><span></span><span></span><span></span></span>' +
        '<span class="typing-label" data-typing-label></span>' +
      '</div>' +
      '<div class="attach-tray" data-attach-tray hidden></div>' +
      '<div class="emoji-picker" data-emoji-picker hidden></div>' +
      '<div class="input-bar" data-input-bar>' +
      '<button type="button" class="escalate-btn" data-escalate-btn hidden title="' + Util.escapeHtml(t('talkToHuman')) + '" aria-label="' + Util.escapeHtml(t('talkToHuman')) + '">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15v-3a8 8 0 0 1 16 0v3"/><path d="M20 15.5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h3z"/><path d="M4 15.5a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2H4z"/></svg>' +
      '</button>' +
      // The text field, attach and the mic live INSIDE one pill
      // (input-wrap) — mic + attach sit together at its trailing edge.
      // Emoji is a separate button outside the pill (next to send),
      // matching the requested layout.
      '<div class="input-wrap" data-input-wrap>' +
        '<input class="input" data-msg-input placeholder="' + Util.escapeHtml(t('typeMsg')) + '" />' +
        (attachCfg.enabled
          ? '<button type="button" class="attach-btn" data-attach-btn title="' + Util.escapeHtml(t('attachFile') || 'Attach file') + '" aria-label="' + Util.escapeHtml(t('attachFile') || 'Attach file') + '">' +
              '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>' +
            '</button>' +
            '<input type="file" data-attach-input hidden accept="' + (attachCfg.allowedMimes || []).join(',') + '" />'
          : '') +
        (voiceNotesEnabled && micSupported
          ? '<button type="button" class="mic-btn" data-mic-btn title="' + Util.escapeHtml(t('recordVoice')) + '" aria-label="' + Util.escapeHtml(t('recordVoice')) + '">' +
              '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>' +
              '<span class="mic-ring" aria-hidden="true"></span>' +
            '</button>'
          : '') +
      '</div>' +
      (emojiEnabled
        ? '<button type="button" class="emoji-btn" data-emoji-btn title="' + Util.escapeHtml(t('emojiPicker')) + '" aria-label="' + Util.escapeHtml(t('emojiPicker')) + '">' +
            '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>' +
          '</button>'
        : '') +
      '<button type="button" class="send-btn" data-send-btn style="background:' + vm.primaryColor + '">' +
      '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>' +
      '</button>' +
      '</div>'
    : '';
   var poweredHtml = brandName
     ? '<div class="powered">' + Util.escapeHtml(t('poweredBy')) + ' <a href="#">' + Util.escapeHtml(brandName) + '</a></div>'
    : '';

  return headerHtml + bodyHtml + inputHtml + tabsHtml + poweredHtml +
    // Phase 6b — lightbox container, hidden by default.
    '<div class="att-lightbox" data-att-lightbox hidden role="dialog" aria-modal="true" aria-label="' + Util.escapeHtml(t('openFile')) + '">' +
      '<button type="button" class="att-lightbox-close" data-att-lightbox-close aria-label="' + Util.escapeHtml(t('closePreview')) + '">×</button>' +
      '<img data-att-lightbox-img alt="" />' +
    '</div>';
  }

  function homeHtml(vm) {
    var rtlHome = !!vm.rtl;
    var isOnline = !!vm.isOnline;
    var avatars = (vm.teamMembers || []).map(function (op) {
      var name = (op && op.name) ? String(op.name) : t('operator');
      var av = op && op.avatar ? String(op.avatar) : '';
      var on = !!(op && op.online);
      var cls = 'home-avatar' + (av ? ' has-img' : '') + (on ? ' is-online' : '');
      var inner = av
        ? '<img src="' + Util.escapeHtml(av) + '" alt="' + Util.escapeHtml(name) + '" loading="lazy" decoding="async" />'
        : '<span aria-hidden="true">' + Util.escapeHtml((name.trim().charAt(0) || 'O').toUpperCase()) + '</span>';
      return '<span class="' + cls + '" title="' + Util.escapeHtml(name) + '">' + inner + '</span>';
    }).join('');

    var cats = vm.categories || [];
    var arts = vm.articles || [];
    var kbHtml = '';
    if (vm.kbEnabled && (cats.length || arts.length)) {
      var items = cats.length
        ? cats.slice(0, 4).map(function (c) {
            return '<button type="button" class="home-kb-item" data-home-cat="' +
              Util.escapeHtml(c.slug || c.id || '') + '">' +
              '<span class="home-kb-title">' + Util.escapeHtml(c.name || c.title || '') + '</span>' +
              '<span class="home-kb-chevron" aria-hidden="true">' + (rtlHome ? '‹' : '›') + '</span>' +
            '</button>';
          }).join('')
        : arts.slice(0, 4).map(function (a) {
            return '<button type="button" class="home-kb-item" data-home-article="' +
              Util.escapeHtml(a.slug || '') + '">' +
              '<span class="home-kb-title">' + Util.escapeHtml(a.title || '') + '</span>' +
              '<span class="home-kb-chevron" aria-hidden="true">' + (rtlHome ? '‹' : '›') + '</span>' +
            '</button>';
          }).join('');
      kbHtml =
        '<section class="home-section">' +
          '<div class="home-section-head">' +
            '<h4 class="home-section-title">' + Util.escapeHtml(t('homeHelpTitle')) + '</h4>' +
            '<button type="button" class="home-section-link" data-home-action="help">' +
              Util.escapeHtml(t('homeSeeAll')) + '</button>' +
          '</div>' +
          '<div class="home-kb-list">' + items + '</div>' +
        '</section>';
    }

    var ctaLabel = isOnline ? t('homeStartChat') : t('homeLeaveMessage');
    var ctaHtml = vm.chatEnabled
      ? '<button type="button" class="home-cta" data-home-action="chat" style="background:' + vm.primaryColor + '">' +
          '<span class="home-cta-label">' + Util.escapeHtml(ctaLabel) + '</span>' +
          '<span class="home-cta-icon" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
              '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
          '</span>' +
        '</button>'
      : '';

    var smartCardHtml = vm.smartSurface && vm.smartSurface.mode === 'home_card'
      ? '<section class="smart-home-card">' + smartSurfaceHtml(vm.smartSurface) + '</section>'
      : '';

    return       '<div class="home-root"' + (rtlHome ? ' dir="rtl"' : '') + '>' +
        smartCardHtml +
        '<section class="home-hero">' +
          '<div class="home-greeting">' + Util.escapeHtml(t('homeGreeting')) + '</div>' +
          '<p class="home-welcome">' + Util.escapeHtml(vm.welcomeMessage || t('homeWelcome')) + '</p>' +
        '</section>' +
        '<section class="home-card">' +
          '<div class="home-card-top">' +
            (avatars ? '<div class="home-avatars">' + avatars + '</div>' : '') +
            '<div class="home-status ' + (isOnline ? 'is-online' : 'is-offline') + '">' +
              '<span class="home-status-dot"></span>' +
              '<span>' + Util.escapeHtml(isOnline ? t('homeTeamOnline') : t('homeTeamOffline')) + '</span>' +
            '</div>' +
            (isOnline ? '' : '<p class="home-hint">' + Util.escapeHtml(t('homeReplySlow')) + '</p>') +
          '</div>' +
          ctaHtml +
        '</section>' +
        kbHtml +
      '</div>';

  }

  // ══════════════════════════════════════════════════════════════════
  // Knowledge Base surfaces
  // ══════════════════════════════════════════════════════════════════
  // Data fetching, search state and HTML sanitization stay in Widget
  // Core / the KB module. Everything below is pure markup driven by a
  // view-model:
  //   vm = {
  //     rtl, state: 'list'|'results'|'searching'|'article',
  //     query, emptyText,
  //     article:   { title, excerpt, contentHtml, publicUrl },
  //     results:   [{ slug, title, excerpt }],
  //     articles:  [{ slug, title, excerpt }],
  //     categories:[{ name, description, url }],
  //   }
  // `article.contentHtml` MUST arrive already sanitized by Core.

  var KB_ICON_SEARCH =
    '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>' +
    '</svg>';
  var KB_ICON_BOOK =
    '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>' +
    '</svg>';
  var KB_ICON_CHAT =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  function kbArticleItemHtml(a) {
    return '<button type="button" class="kb-article" data-kb-action="open" data-kb-slug="' +
      Util.escapeHtml(a.slug) + '">' +
      '<div class="kb-article-title">' + Util.escapeHtml(a.title) + '</div>' +
      (a.excerpt ? '<div class="kb-article-excerpt">' + Util.escapeHtml(a.excerpt) + '</div>' : '') +
      '</button>';
  }

  function kbSearchBarHtml(vm) {
    vm = vm || {};
    return '<div class="kb-search-wrap">' +
      '<input class="kb-search" type="search" autocomplete="off" autocorrect="off" spellcheck="false" ' +
      'placeholder="' + Util.escapeHtml(t('searchKb')) + '" value="' + Util.escapeHtml(vm.query || '') + '" />' +
      '</div>';
  }

  function kbEmptyHtml(vm) {
    vm = vm || {};
    var isSearch = vm.state === 'results';
    var text = vm.emptyText || (isSearch ? t('kbZeroResults') : t('noArticles'));
    return '<div class="kb-empty kb-empty-centered">' +
      '<div class="kb-empty-icon" aria-hidden="true">' + (isSearch ? KB_ICON_SEARCH : KB_ICON_BOOK) + '</div>' +
      '<p class="kb-empty-text">' + Util.escapeHtml(text) + '</p>' +
      (vm.hideChatCta ? '' :
        '<button type="button" class="kb-cta kb-cta-pro" data-kb-action="switch-chat">' +
          '<span class="kb-cta-icon" aria-hidden="true">' + KB_ICON_CHAT + '</span>' +
          '<span>' + Util.escapeHtml(t('kbSwitchToChat')) + '</span>' +
        '</button>') +
      '</div>';
  }

  function kbLoadingHtml() {
    return '<div class="kb-status">' + Util.escapeHtml(t('kbSearching')) + '</div>';
  }

  function kbSearchResultsHtml(vm) {
    vm = vm || {};
    var results = vm.results || [];
    if (!results.length) return kbEmptyHtml({ state: 'results', emptyText: vm.emptyText, hideChatCta: vm.hideChatCta });
    return '<div class="kb-list">' + results.map(kbArticleItemHtml).join('') + '</div>';
  }

  function kbHomeHtml(vm) {
    vm = vm || {};
    var cats = vm.categories || [];
    var articles = vm.articles || [];
    if (!cats.length && !articles.length) {
      return kbEmptyHtml({ state: 'list', emptyText: vm.emptyText, hideChatCta: vm.hideChatCta });
    }
    var html = '';
    if (articles.length) {
      html += '<div class="kb-section-h">' + Util.escapeHtml(t('kbAllArticles')) + '</div>';
      html += '<div class="kb-list">' + articles.map(kbArticleItemHtml).join('') + '</div>';
    }
    if (cats.length) {
      html += '<div class="kb-section-h">' + Util.escapeHtml(t('kbCategories')) + '</div>';
      html += '<div class="kb-list">';
      cats.forEach(function (c) {
        var href = c.url ? ' href="' + Util.escapeHtml(c.url) + '"' : '';
        html += '<a class="kb-category" target="_blank" rel="noopener noreferrer"' + href + '>' +
          '<div class="kb-article-title">' + Util.escapeHtml(c.name) + '</div>' +
          (c.description ? '<div class="kb-article-excerpt">' + Util.escapeHtml(c.description) + '</div>' : '') +
          '</a>';
      });
      html += '</div>';
    }
    return html;
  }

  function kbArticleHtml(vm) {
    vm = vm || {};
    var a = vm.article || {};
    var rtl = !!vm.rtl;
    return '<div class="kb-article-view">' +
      '<button type="button" class="kb-back" data-kb-action="back">' +
        (rtl ? '→ ' : '← ') + Util.escapeHtml(t('kbBack')) +
      '</button>' +
      '<h2 class="kb-article-h">' + Util.escapeHtml(a.title || '') + '</h2>' +
      (a.excerpt ? '<p class="kb-article-excerpt-full">' + Util.escapeHtml(a.excerpt) + '</p>' : '') +
      '<div class="kb-article-body">' + (a.contentHtml || '') + '</div>' +
      (a.publicUrl
        ? '<div class="kb-article-footer">' +
            '<a class="kb-open-browser" href="' + Util.escapeHtml(a.publicUrl) + '" target="_blank" rel="noopener noreferrer">' +
              Util.escapeHtml(t('kbOpenInBrowser')) +
            '</a>' +
          '</div>'
        : '') +
      '</div>';
  }

  /** Full KB surface — search bar + the state-specific body. */
  function kbHtml(vm) {
    vm = vm || {};
    var state = vm.state || 'list';
    var inner;
    if (state === 'article') inner = kbArticleHtml(vm);
    else if (state === 'searching') inner = kbLoadingHtml(vm);
    else if (state === 'results') inner = kbSearchResultsHtml(vm);
    else inner = kbHomeHtml(vm);
    return '<div class="kb-root"' + (vm.rtl ? ' dir="rtl"' : '') + '>' +
      (vm.hideSearch ? '' : kbSearchBarHtml(vm)) +
      inner +
      '</div>';
  }

    return {
      id: 'classic',
      shellHtml: shellHtml,
      homeHtml: homeHtml,
      emptyHtml: emptyHtml,
      messagesHtml: messagesHtml,
      aiThinkingRowHtml: renderAiThinkingRow,
      qnaChipsHtml: qnaChipsHtml,
      messageAttachmentHtml: renderMessageAttachment,
      callInvitationCardHtml: renderCallInvitationCard,
      callEndedRowHtml: renderCallEndedRow,
      routingOutcomeRowHtml: renderRoutingOutcomeRow,
      prechatFieldRowHtml: renderPrechatFieldRow,
      prechatFormHtml: prechatFormHtml,
      handoffPrechatCardHtml: handoffPrechatCardHtml,
      contactFallbackHtml: contactFallbackHtml,
      smartSurfaceHtml: smartSurfaceHtml,
      format: {
        msgTime: formatMsgTime,
        callDuration: fmtCallDuration,
        invitationRemaining: fmtInvitationRemaining,
        humanSize: humanSize,
      },
    };
  }

  window.__gs_presentation_classic = { id: 'classic', create: create };
})();
