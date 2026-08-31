/**
 * Widget Presentation — "web-yar" renderer.
 *
 * THE default (and only) presentation template. Registered under
 * `window.__gs_presentation_web_yar` and resolved through
 * `presentation-registry.js`.
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
 */
(function () {
  'use strict';

  function create(env) {
    env = env || {};
    var t = env.t || function (k) { return k; };
    var config = env.config || {};
    var workspaceName = String(config.workspaceName || config.brandName || '');
    var Util = { escapeHtml: env.escapeHtml || function (v) { return String(v == null ? '' : v); } };
    var ctx = {
      config: config,
      locale: env.locale,
      primaryColor: env.primaryColor,
      loadAuthedMediaBlobUrl: env.loadAuthedMediaBlobUrl,
    };

    function esc(v) { return Util.escapeHtml(v); }
    function isRtl() { return String(ctx.locale || 'en').toLowerCase().split('-')[0] === 'fa'; }
    function tf(key, fallback) {
      var v = t(key);
      return (v && v !== key) ? v : fallback;
    }

    // ── Shared iconography (stroke icons, matching the design language) ──
    var ICON = {
      back: '<svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
      chevron: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
      plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
      send: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 4L3 11l6.5 2.5L12 20l8-16Z"/></svg>',
      attach: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a1.5 1.5 0 0 1-2.12-2.12l8.49-8.48"/></svg>',
      emoji: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M8.5 14s1.2 2 3.5 2 3.5-2 3.5-2" stroke-linecap="round"/><circle cx="9" cy="10" r="0.9" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="0.9" fill="currentColor" stroke="none"/></svg>',
      mic: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/></svg>',
      thumbUp: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12M15 5.88 14 10h6.28a2 2 0 0 1 1.94 2.5l-1.54 6A2 2 0 0 1 18.75 20H7a1 1 0 0 1-1-1v-9a1 1 0 0 1 .29-.71l6.06-6.06a.5.5 0 0 1 .85.35L13 5.88Z"/></svg>',
      thumbDown: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V2M9 18.12 10 14H3.72a2 2 0 0 1-1.94-2.5l1.54-6A2 2 0 0 1 5.25 4H17a1 1 0 0 1 1 1v9a1 1 0 0 1-.29.71l-6.06 6.06a.5.5 0 0 1-.85-.35L11 18.12Z"/></svg>',
      close: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    };

    // Delivery ticks: one tick = sent, two ticks = delivered, two accent
    // ticks = read. No textual label (design decision).
    var TICKS = {
      single: '<svg viewBox="0 0 20 12" width="15" height="10" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6.6l3 3L14.5 3"/></svg>',
      double: '<svg viewBox="0 0 20 12" width="18" height="10" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 6.6l3 3L11 3"/><path d="M8 9.6L14.5 3"/></svg>',
    };

    // Workspace identity block reused by every header (home/list/articles/
    // article/precontact/chat). Never hardcodes a brand — everything comes
    // from config/view-model.
    function identityAvatarHtml(size) {
      // Logo explicitly disabled by the workspace => render NO avatar layer at
      // all (no initial-letter fallback circle behind it).
      if (config && config.showLogo === false) return '';
      var logo = (config && config.logoUrl) ? String(config.logoUrl) : '';
      var brand = workspaceName;
      var cls = 'wy-avatar wy-avatar-' + (size || 'md');
      if (logo) {
        return '<span class="' + cls + ' has-img"><img src="' + esc(logo) + '" alt="' + esc(brand) +
          '" loading="lazy" decoding="async" /></span>';
      }
      var initial = (brand.trim().charAt(0) || 'W').toUpperCase();
      return '<span class="' + cls + '" aria-hidden="true">' + esc(initial) + '</span>';
    }


    function backButtonHtml(target) {
      return '<button type="button" class="wy-back" data-view-back="' + esc(target || 'home') +
        '" aria-label="' + esc(tf('back', 'Back')) + '">' + ICON.back + '</button>';
    }

    function footerHtml() {
      // The footer credits the PLATFORM, never the workspace brand. Wording,
      // brand label and outbound link are platform-admin owned and arrive as
      // `config.poweredBy` ({ text, brand, url }); plans decide visibility, so
      // an absent payload means "do not render" — the view then extends to the
      // bottom edge on its own.
      var pb = (config && config.poweredBy) || null;
      if (config && config.showPoweredBy === false) return '';
      var platform = (pb && pb.brand) || (config && config.platformName) || '';
      if (!platform) return '';
      var label = (pb && pb.text) || tf('poweredBy', 'Powered by');
      var url = (pb && pb.url) || '';
      // No URL => a genuinely non-interactive element: no href, no data hook,
      // no link semantics. Appearance is identical (same class).
      // With a URL => a native anchor (no JS navigation): `nofollow` keeps this
      // widely distributed attribution link compliant with search-engine link
      // policies, `noopener` protects the opener, and a strict-origin referrer
      // still lets the platform see the referring origin in analytics.
      // The connection/loading indicator is a SIBLING of the anchor — never
      // part of the clickable area (SEO + click semantics stay untouched).
      var inner = '<span>' + esc(label) + ' ' + esc(platform) + '</span>';
      var body = url
        ? '<a class="wy-powered" href="' + esc(url) + '" target="_blank" rel="noopener nofollow" referrerpolicy="strict-origin-when-cross-origin">' + inner + '</a>'
        : '<span class="wy-powered">' + inner + '</span>';

      return '<div class="wy-footer">' + connIndicatorHtml() + body + '</div>';
    }

    /**
     * The single post-mount loading/connection affordance: a 4px dot with a
     * micro orbital ring. Purely visual — Core only writes a normalized
     * `data-conn-state` on the panel and this template decides the look.
     */
    function connIndicatorHtml() {
      return '<span class="wy-conn" data-conn-indicator aria-hidden="true">' +
        '<span class="wy-conn-ring"></span>' +
        '<span class="wy-conn-dot"></span>' +
      '</span>';
    }




    /**
     * Reply-time note under the workspace name. Workspace-configurable via
     * `widget_settings.reply_time_text` (surfaced as config.replyTimeText);
     * falls back to the locale default for the availability state.
     */
    function replyTimeText(online) {
      var custom = (config && typeof config.replyTimeText === 'string') ? config.replyTimeText.trim() : '';
      if (custom) return custom;
      return online === false ? tf('homeReplySlow', '') : tf('homeReplyFast', '');
    }

    function headerIdentityHtml(opts) {
      opts = opts || {};
      var title = esc(opts.title || workspaceName);
      var subtitle = opts.subtitle ? '<span class="wy-head-sub">' + esc(opts.subtitle) + '</span>' : '';
      var dot = opts.online ? '<span class="wy-online-dot" aria-hidden="true"></span>' : '';
      return (opts.back ? backButtonHtml(opts.back) : '') +
        identityAvatarHtml(opts.avatarSize) +
        '<div class="wy-head-text">' +
          // Online-operator stack sits BEFORE the workspace name (design source).
          '<span class="wy-head-title">' + dot + (opts.stack || '') + '<span>' + title + '</span></span>' +
          subtitle +
        '</div>';
    }


    // ══════════════════════════════════════════════════════════════════
    // Chat surfaces
    // ══════════════════════════════════════════════════════════════════

    function emptyHtml() {
      var ai = ctx.config && ctx.config.aiAgent;
      if (ai && ai.suppressGreeting === true) {
        return '<div class="messages welcome-only"></div>';
      }
      var welcome = (ctx.config && typeof ctx.config.welcomeMessage === 'string' && ctx.config.welcomeMessage.trim().length > 0)
        ? ctx.config.welcomeMessage
        : t('intro');
      var lines = String(welcome).split(/\n+/).map(function (l) { return esc(l); }).join('<br>');
      var team = (ctx.config && Array.isArray(ctx.config.teamMembers)) ? ctx.config.teamMembers : [];
      var op = team.filter(function (m) { return m && (m.avatar_url || m.avatar); })[0];
      var opAvatar = op && (op.avatar_url || op.avatar);
      var avatarHtml = opAvatar
        ? '<span class="msg-avatar has-img"><img src="' + esc(String(opAvatar)) + '" alt="" loading="lazy" decoding="async" /></span>'
        : '<span class="msg-avatar" aria-hidden="true">' +
            esc((((team[0] && (team[0].name || team[0].full_name)) || (ctx.config && ctx.config.brandName) || 'S').trim().charAt(0) || 'S').toUpperCase()) +
          '</span>';
      return '<div class="messages welcome-only">' +
        '<div class="msg-row operator">' + avatarHtml +
          '<div class="msg operator welcome-bubble">' + lines + '</div>' +
        '</div>' +
      '</div>';
    }

    function qnaChipsHtml(qnaState) {
      qnaState = qnaState || {};
      var collapsed = qnaState.collapsedCount || 3;
      var all = qnaState.questions || [];
      var visible = qnaState.expanded ? all : all.slice(0, collapsed);
      var remaining = all.length - visible.length;
      var chipsHtml = visible.map(function (q) {
        var text = (q && q.question) ? String(q.question) : '';
        if (!text) return '';
        return '<button type="button" class="qna-chip" data-qna-question="' + esc(text) + '">' + esc(text) + '</button>';
      }).join('');
      var moreHtml = (!qnaState.expanded && remaining > 0)
        ? '<button type="button" class="qna-more-btn" data-qna-more>' + esc(t('qnaMore')) +
            '<span class="qna-more-count">+' + remaining + '</span></button>'
        : '';
      return '<div class="qna-suggestions" data-qna>' +
        '<div class="qna-title">' + esc(t('qnaTitle')) + '</div>' +
        '<div class="qna-chips">' + chipsHtml + moreHtml + '</div>' +
      '</div>';
    }

    function humanSize(bytes) {
      var n = Number(bytes) || 0;
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
      return (n / (1024 * 1024)).toFixed(n < 10485760 ? 1 : 0) + ' MB';
    }

    // Real attachments — authenticated media is loaded by Core through the
    // data-att-media-src / data-att-download hooks. No demo placeholders.
    function renderMessageAttachment(att) {
      if (!att || !att.id) return '';
      var id = esc(att.id);
      var name = esc(att.file_name || 'file');
      var size = humanSize(att.size_bytes);
      var isImage = att.kind === 'image' || (att.mime_type && /^image\//.test(att.mime_type));
      var isAudio = att.kind === 'audio' || (att.mime_type && /^audio\//.test(att.mime_type));
      if (isImage) {
        return '<div class="msg-att msg-att-image">' +
          '<button type="button" class="msg-att-img-btn" data-att-preview="' + id + '" aria-label="' + esc(t('openFile')) + '">' +
            '<img loading="lazy" decoding="async" data-att-media-src="' + id + '" alt="' + name + '" />' +
            '<span class="msg-att-img-fallback">' + esc(t('imageUnavailable')) + '</span>' +
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
          '<div class="msg-att-sub">' + esc(size) + '</div>' +
        '</div>' +
        '<a class="msg-att-action" href="#" data-att-download="' + id + '" data-att-download-name="' + name +
          '" aria-label="' + esc(t('download')) + '">' +
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4v12m0 0l-4-4m4 4l4-4"/><path d="M5 20h14"/></svg>' +
        '</a>' +
      '</div>';
    }

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

    function fmtCallDuration(seconds) {
      var s = Math.max(0, Math.floor(Number(seconds) || 0));
      var hh = Math.floor(s / 3600);
      var mm = Math.floor((s % 3600) / 60);
      var ss = s % 60;
      function pad(n) { return n < 10 ? '0' + n : '' + n; }
      return hh > 0 ? pad(hh) + ':' + pad(mm) + ':' + pad(ss) : pad(mm) + ':' + pad(ss);
    }

    function systemPillHtml(icon, text) {
      return '<div class="msg-row system"><div class="msg-system-pill">' + icon +
        '<span>' + esc(text) + '</span></div></div>';
    }

    function renderCallEndedRow(msg) {
      var meta = msg.metadata || {};
      var endedBy = String(meta.ended_by || 'system');
      var endReason = String(meta.end_reason || '');
      var dur = Number(meta.duration_seconds) || 0;
      var isMissed = endReason === 'failed' || dur <= 0;
      var key = isMissed ? 'csEndedNotConnected'
        : endedBy === 'operator' ? 'csEndedByOperator'
        : endedBy === 'visitor' ? 'csEndedByVisitor'
        : 'csEndedBySystem';
      var fallback = isMissed ? 'Call did not connect'
        : endedBy === 'operator' ? ('Call ended by operator · Duration ' + fmtCallDuration(dur))
        : endedBy === 'visitor' ? ('Call ended by visitor · Duration ' + fmtCallDuration(dur))
        : ('Call ended · Duration ' + fmtCallDuration(dur));
      var raw = t(key);
      var text = (raw && raw !== key) ? String(raw).replace('{duration}', fmtCallDuration(dur)) : fallback;
      var icon = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2A19.79 19.79 0 0 1 8.63 18.5"/>'
        + '<line x1="23" y1="1" x2="1" y2="23"/></svg>';
      return systemPillHtml(icon, text);
    }

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
      var icon = kind === 'routing_agent_joined'
        ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
        : '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
      return systemPillHtml(icon, text);
    }

    function renderCallInvitationCard(msg) {
      var meta = msg.metadata || {};
      var channel = meta.channel === 'video' ? 'video' : 'audio';
      var status = meta.status || 'pending';
      var inviteId = esc(meta.invitation_id || '');
      var op = meta.operator_name ? esc(meta.operator_name) : '';
      var headlineKey = channel === 'video'
        ? (op ? 'ciHeadlineVideoFrom' : 'ciHeadlineVideo')
        : (op ? 'ciHeadlineAudioFrom' : 'ciHeadlineAudio');
      var headlineTpl = t(headlineKey) || (channel === 'video'
        ? 'You have been invited to a video call'
        : 'You have been invited to an audio call');
      var headline = op ? headlineTpl.replace('{op}', op) : headlineTpl;
      var iconSvg = channel === 'video'
        ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>'
        : '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92Z"/></svg>';

      var statusBlock = '';
      var actionBlock = '';
      var bodyBlock = '';
      if (status === 'pending') {
        var bodyKey = channel === 'video' ? 'ciBodyVideo' : 'ciBodyAudio';
        var bodyText = t(bodyKey) || (channel === 'video'
          ? 'An operator is inviting you to a video call.'
          : 'An operator is inviting you to a voice call.');
        var waitMinutes = (typeof meta.wait_minutes === 'number' && isFinite(meta.wait_minutes) && meta.wait_minutes > 0)
          ? Math.round(meta.wait_minutes) : 0;
        if (!waitMinutes && meta.expires_at) {
          var deltaMs = new Date(meta.expires_at).getTime() - new Date(msg.createdAt || Date.now()).getTime();
          if (isFinite(deltaMs) && deltaMs > 0) waitMinutes = Math.max(1, Math.round(deltaMs / 60000));
        }
        var waitLine = '';
        if (waitMinutes === 1) waitLine = t('ciWaitOneMinute') || 'The operator will wait up to one minute for you to join.';
        else if (waitMinutes > 1) {
          waitLine = (t('ciWaitMinutes') || 'The operator will wait up to {m} minutes for you to join.')
            .replace('{m}', String(waitMinutes));
        }
        bodyBlock = '<div class="ci-body"><div>' + esc(bodyText) + '</div>' +
          (waitLine ? '<div class="ci-wait">' + esc(waitLine) + '</div>' : '') + '</div>';
        statusBlock = '<div class="ci-meta ci-countdown" aria-live="polite">' +
          '<span class="ci-pulse" aria-hidden="true"></span>' + esc(fmtInvitationRemaining(meta.expires_at)) + '</div>';
        var joinLabel = channel === 'video' ? (t('ciJoinVideo') || 'Join video call') : (t('ciJoinAudio') || 'Join call');
        var joinAria = channel === 'video' ? (t('ciAriaJoinVideo') || 'Join the video call now') : (t('ciAriaJoinAudio') || 'Join the audio call now');
        actionBlock = '<div class="ci-actions">' +
          '<button type="button" class="ci-btn ci-btn-primary" data-ci-action="join" data-ci-id="' + inviteId +
            '" data-ci-channel="' + channel + '" aria-label="' + esc(joinAria) + '">' + esc(joinLabel) + '</button>' +
          '<button type="button" class="ci-btn ci-btn-ghost" data-ci-action="decline" data-ci-id="' + inviteId +
            '" aria-label="' + esc(t('ciAriaDecline') || 'Decline this call invitation') + '">' +
            esc(t('ciDecline') || 'Decline') + '</button>' +
        '</div>';
      } else {
        var stateLabel = status === 'joined' ? (t('ciStateJoined') || 'You joined the call')
          : status === 'expired' ? (t('ciStateExpired') || 'Invitation expired')
          : status === 'cancelled' ? (t('ciStateCancelled') || 'Operator cancelled the invitation')
          : status === 'declined' ? (t('ciStateDeclined') || 'You declined this call') : '';
        statusBlock = '<div class="ci-meta ci-status ci-status-' + esc(status) + '">' + esc(stateLabel) + '</div>';
      }

      var ariaCard = (t('ciAriaCard') || 'Call invitation') + ' — ' +
        (channel === 'video' ? (t('videoCall') || 'Video') : (t('voiceCall') || 'Voice'));
      return '<div class="msg-row system">' +
        '<div class="ci-card ci-channel-' + channel + ' ci-status-' + esc(status) +
          '" data-ci-card="' + inviteId + '" role="group" aria-label="' + esc(ariaCard) + '">' +
          '<div class="ci-row">' +
            '<span class="ci-icon" aria-hidden="true">' + iconSvg + '</span>' +
            '<div class="ci-text">' +
              '<div class="ci-title">' + esc(headline) + '</div>' + bodyBlock + statusBlock +
            '</div>' +
          '</div>' + actionBlock +
        '</div>' +
      '</div>';
    }

    /** Locale-aware digits (Persian numerals for fa). */
    function fmtNum(n) {
      try {
        var l = String(ctx.locale || 'en').toLowerCase().split('-')[0];
        var tag = l === 'fa' ? 'fa-IR' : l === 'tr' ? 'tr-TR' : 'en-US';
        return new Intl.NumberFormat(tag).format(Number(n) || 0);
      } catch (_) { return String(n); }
    }

    function formatMsgTime(d) {
      try {
        var date = (d instanceof Date) ? d : new Date(d);
        if (!date || isNaN(date.getTime())) return '';
        return date.toLocaleTimeString(ctx.locale || undefined, { hour: '2-digit', minute: '2-digit' });
      } catch (_) { return ''; }
    }


    var PRECHAT_ICONS = {
      name: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
      email: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
      phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92Z"/></svg>',
      lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    };

    // Field visibility/required state is server-authoritative (identity),
    // never derived from the design demo.
    function renderPrechatFieldRow(identity, key, type, value) {
      var label = t(key);
      var ph = t('prechat' + key.charAt(0).toUpperCase() + key.slice(1) + 'Ph') || label;
      var req = identity.isRequired(key);
      var badge = req
        ? '<span class="prechat-req-mark" aria-label="' + esc(t('required')) + '" title="' + esc(t('required')) + '">*</span>'
        : '';
      var ac = key === 'name' ? 'name' : key === 'email' ? 'email' : 'tel';
      var inputDir = (key === 'email' || key === 'phone') ? 'ltr' : '';
      return '<div class="prechat-field" data-field="' + key + '">' +
          '<label class="prechat-label" for="prechat-' + key + '">' + esc(label) + badge + '</label>' +
          '<div class="prechat-control">' +
            '<input id="prechat-' + key + '" class="prechat-input" data-prechat="' + key + '" type="' + type +
              '" autocomplete="' + ac + '"' + (inputDir ? ' dir="' + inputDir + '"' : '') +
              ' placeholder="' + esc(ph) + '"' + (req ? ' aria-required="true"' : '') +
              ' aria-invalid="false" aria-describedby="prechat-err-' + key + '"' +
              ' value="' + esc(value || '') + '" />' +
            '<span class="prechat-status" aria-hidden="true"></span>' +
          '</div>' +
          '<div class="prechat-error" id="prechat-err-' + key + '" data-err="' + key + '" role="alert" aria-live="polite"></div>' +
        '</div>';
    }

    function renderAiThinkingRow() {
      return '<div class="msg-row operator ai-thinking-row">' +
        '<div class="msg operator ai-thinking-bubble">' +
          '<span class="ai-thinking-spark" aria-hidden="true"></span>' +
          '<span class="typing-dots"><span></span><span></span><span></span></span>' +
          '<span class="ai-thinking-label">' + esc(t('aiThinking') || 'Thinking…') + '</span>' +
        '</div>' +
      '</div>';
    }

    function messagesHtml(s, extraRowHtml, view) {
      view = view || {};
      var typewriter = view.typewriter || null;
      var qnaState = view.qna || { questions: [], expanded: false };
      var rrCfg = ctx.config && ctx.config.readReceipts;
      var receiptsEnabled = !rrCfg || rrCfg.enabled !== false;
      var lastVisitorIdx = -1;
      for (var lv = s.messages.length - 1; lv >= 0; lv--) {
        if (s.messages[lv].sender === 'visitor') { lastVisitorIdx = lv; break; }
      }
      var html = '<div class="messages">';
      var groupKeys = s.messages.map(function (m) {
        return m.sender === 'visitor' ? 'v' : ('op:' + (m.senderName || '') + '|' + (m.senderAvatar || ''));
      });
      var visitorHasReplied = s.messages.some(function (m) { return m.sender === 'visitor'; });

      s.messages.forEach(function (m, idx) {
        if (m.senderType === 'system' && m.metadata && m.metadata.kind === 'call_invitation') {
          html += renderCallInvitationCard(m); return;
        }
        if (m.senderType === 'system' && m.metadata && m.metadata.kind === 'call_ended') {
          html += renderCallEndedRow(m); return;
        }
        if (m.senderType === 'system' && m.metadata
            && (m.metadata.kind === 'routing_agent_joined'
              || m.metadata.kind === 'routing_no_agent_available'
              || m.metadata.kind === 'routing_in_queue')) {
          html += renderRoutingOutcomeRow(m); return;
        }
        var cls = m.sender === 'visitor' ? 'visitor' : 'operator';
        var bg = m.sender === 'visitor' ? 'style="background:' + ctx.primaryColor + '"' : '';
        var isAi = m.senderType === 'ai';
        var aiBadgeHtml = isAi ? '<span class="msg-ai-badge" aria-label="AI assistant" title="AI assistant">AI</span>' : '';
        var hasText = m.body && String(m.body).trim().length > 0;
        var attHtml = renderMessageAttachment(m.attachment);
        var extraCls = (attHtml && !hasText) ? ' has-att-only' : (attHtml ? ' has-att' : '');

        // Consecutive messages from the same author share ONE avatar and ONE
        // meta line (time + delivery ticks) under the LAST bubble of the run.
        var isLastInStreak = idx === s.messages.length - 1 || groupKeys[idx + 1] !== groupKeys[idx];

        var statusHtml = '';
        if (m.sender === 'visitor' && isLastInStreak && receiptsEnabled && m.status) {
          if (m.status === 'sending') {
            statusHtml = '<span class="msg-ticks is-sending"><span class="msg-status-spinner"></span></span>';
          } else if (m.status === 'failed') {
            statusHtml = '<span class="msg-ticks is-failed" aria-label="' + esc(t('msgFailed')) + '">!</span>';
          } else {
            var seen = m.status === 'seen';
            var two = seen || m.status === 'delivered';
            statusHtml = '<span class="msg-ticks' + (seen ? ' is-seen' : '') + '" aria-hidden="true">' +
              (two ? TICKS.double : TICKS.single) + '</span>';
          }
        }

        var avatarHtml = '';
        if (cls === 'operator') {
          if (isLastInStreak) {
            avatarHtml = m.senderAvatar
              ? '<span class="msg-avatar has-img"><img src="' + esc(m.senderAvatar) + '" alt="' +
                  esc(m.senderName || t('operator')) + '" loading="lazy" decoding="async" /></span>'
              : '<span class="msg-avatar" aria-hidden="true">' +
                  esc(((m.senderName || ctx.config.brandName || 'S').trim().charAt(0) || 'S').toUpperCase()) + '</span>';
          } else {
            avatarHtml = '<span class="msg-avatar msg-avatar-spacer" aria-hidden="true"></span>';
          }
        }

        var timeStr = formatMsgTime(m.time);
        var metaHtml = isLastInStreak && (timeStr || statusHtml)
          ? '<div class="msg-meta">' +
              (timeStr ? '<span class="msg-time">' + esc(timeStr) + '</span>' : '') + statusHtml +
            '</div>'
          : '';

        var isTypingThis = !!(typewriter && typewriter.id === m.__id);
        var typingDone = isTypingThis && typewriter.revealedCount >= typewriter.tokens.length;
        var displayText = (isTypingThis && !typingDone)
          ? typewriter.tokens.slice(0, typewriter.revealedCount).join('')
          : m.body;
        var textHtml = hasText
          ? '<span class="msg-text"' + (isTypingThis && !typingDone ? ' data-typing-id="' + esc(m.__id) + '"' : '') + '>' +
              esc(displayText) + '</span>'
          : '';

        // Reply affordance (design §12) — Core binds data-msg-reply when it
        // supports quoting; the button is inert-safe otherwise.
        var replyBtn = hasText
          ? '<button type="button" class="msg-reply" data-msg-reply="' + esc(m.__id || '') +
              '" data-msg-reply-text="' + esc(String(m.body || '').slice(0, 160)) +
              '" aria-label="' + esc(tf('reply', 'Reply')) + '">' +
              '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17l-5-5 5-5"/><path d="M4 12h10a5 5 0 0 1 5 5v2"/></svg>' +
            '</button>'
          : '';

        var quoted = (m.replyTo && (m.replyTo.text || m.replyTo.body))
          ? '<span class="msg-quote">' + esc(String(m.replyTo.text || m.replyTo.body)) + '</span>'
          : '';

        html += '<div class="msg-row ' + cls + (isLastInStreak ? ' is-last' : '') + '">' + avatarHtml +
          '<div class="msg-col">' +
            '<div class="msg ' + cls + extraCls + (isAi ? ' is-ai' : '') + (isLastInStreak ? ' has-tail' : '') + '"' +
              (isTypingThis && !typingDone ? ' data-typing-host data-typing-active="1"' : '') + ' ' + bg + '>' +
              aiBadgeHtml + quoted + textHtml + attHtml +
            '</div>' + metaHtml +
          '</div>' + replyBtn +
        '</div>';


        var isIntro = m.metadata && m.metadata.source === 'ai_agent_intro';
        if (isIntro && !visitorHasReplied && qnaState.questions.length) html += qnaChipsHtml(qnaState);
      });

      if (extraRowHtml) html += extraRowHtml;
      var lastMsg = s.messages && s.messages.length ? s.messages[s.messages.length - 1] : null;
      var waitingOnAi = !!lastMsg && (lastMsg.sender === 'visitor' || lastMsg.from === 'visitor' || lastMsg.author === 'visitor');
      if (s.aiThinking && waitingOnAi) html += renderAiThinkingRow();
      html += '</div>';
      return html;
    }

    function handoffPrechatCardHtml(identity, contact, locale, subtitle, animateSubtitle) {
      contact = contact || {};
      var fieldsHtml = '';
      if (identity.isAsked('name')) fieldsHtml += renderPrechatFieldRow(identity, 'name', 'text', contact.name);
      if (identity.isAsked('email')) fieldsHtml += renderPrechatFieldRow(identity, 'email', 'email', contact.email);
      if (identity.isAsked('phone')) fieldsHtml += renderPrechatFieldRow(identity, 'phone', 'tel', contact.phone);
      var dir = String(locale || '').toLowerCase().split('-')[0] === 'fa' ? 'rtl' : 'ltr';
      var subtitleHtml = animateSubtitle
        ? '<div class="hc-subtitle" data-typing-host data-typing-active="1" data-typing-id="hc-subtitle"></div>'
        : '<div class="hc-subtitle">' + esc(subtitle) + '</div>';
      return '<div class="msg-row visitor">' +
        '<div class="hc-card" dir="' + dir + '" role="group" aria-label="' + esc(t('prechatTitle')) + '">' +
          '<div class="hc-title">' + esc(t('prechatTitle')) + '</div>' + subtitleHtml +
          '<div class="prechat-fields hc-fields">' + fieldsHtml + '</div>' +
          '<button type="button" class="wy-btn wy-btn-primary hc-submit" data-prechat-submit>' +
            esc(t('continue')) + '</button>' +
        '</div>' +
      '</div>';
    }

    /**
     * Full-screen pre-contact view (design §9). Field set and required
     * markers come from the server-authoritative identity contract; the
     * design's "name required" demo rule never overrides it.
     */
    function prechatFormHtml(identity, contact, locale) {
      contact = contact || {};
      var fieldsHtml = '';
      if (identity.isAsked('name')) fieldsHtml += renderPrechatFieldRow(identity, 'name', 'text', contact.name);
      if (identity.isAsked('email')) fieldsHtml += renderPrechatFieldRow(identity, 'email', 'email', contact.email);
      if (identity.isAsked('phone')) fieldsHtml += renderPrechatFieldRow(identity, 'phone', 'tel', contact.phone);
      var dir = String(locale || '').toLowerCase().split('-')[0] === 'fa' ? 'rtl' : 'ltr';
      return '<div class="wy-view wy-view-precontact prechat" dir="' + dir + '">' +
        '<div class="wy-head">' +
          headerIdentityHtml({ back: 'home', subtitle: tf('wyConnectOperator', 'Connect to an operator') }) +
        '</div>' +
        '<div class="wy-scroll wy-body-pad">' +
          '<p class="prechat-subtitle">' + esc(tf('wyPrecontactDesc', t('prechatSubtitle'))) + '</p>' +
          '<div class="prechat-fields">' + fieldsHtml + '</div>' +
          '<div class="prechat-spacer" aria-hidden="true"></div>' +
          '<button type="button" class="wy-btn wy-btn-primary wy-btn-block prechat-submit" data-prechat-submit>' +
            esc(tf('wyConnectOperator', t('continue'))) + '</button>' +
        '</div>' +
      '</div>';
    }

    function contactFallbackHtml(identity, contact, locale, presence) {
      contact = contact || {};
      var intro = (presence && presence.introLabel) ? presence.introLabel : t('fallbackIntro');
      var dir = String(locale || '').toLowerCase().split('-')[0] === 'fa' ? 'rtl' : 'ltr';

      function fieldRow(key, type, value, required) {
        var label = t(key);
        return '<div class="prechat-field" data-field="' + key + '">' +
          '<label class="prechat-label" for="fb-' + key + '">' + esc(label) +
            (required ? '<span class="prechat-req-mark">*</span>' : '') + '</label>' +
          '<div class="prechat-control">' +
            '<input id="fb-' + key + '" class="prechat-input" data-fb="' + key + '" type="' + type +
            '" autocomplete="' + (key === 'name' ? 'name' : key === 'email' ? 'email' : 'tel') +
            '" placeholder="' + esc(label) + '"' + (required ? ' aria-required="true"' : '') +
            ' aria-invalid="false" aria-describedby="fb-err-' + key + '"' +
            ' value="' + esc(value || '') + '" />' +
          '</div>' +
          '<div class="prechat-error" id="fb-err-' + key + '" data-err="' + key + '" role="alert" aria-live="polite"></div>' +
        '</div>';
      }

      var askPhone = identity.isAsked('phone');
      var fieldsHtml = fieldRow('name', 'text', contact.name, identity.isRequired('name')) +
        fieldRow('email', 'email', contact.email, !askPhone) +
        (askPhone ? fieldRow('phone', 'tel', contact.phone, identity.isRequired('phone')) : '');

      return '<div class="wy-view wy-view-fallback prechat fallback" dir="' + dir + '">' +
        '<div class="wy-head">' +
          headerIdentityHtml({ back: 'home', subtitle: tf('wyLeaveMessage', t('homeLeaveMessage')) }) +
        '</div>' +
        '<div class="wy-scroll wy-body-pad">' +
          '<p class="prechat-intro">' + esc(intro) + '</p>' +
          '<div class="prechat-fields">' + fieldsHtml +
            '<div class="prechat-field" data-field="message">' +
              '<label class="prechat-label" for="fb-message">' + esc(t('fallbackMessageLabel')) +
                '<span class="prechat-req-mark">*</span></label>' +
              '<div class="prechat-control">' +
                '<textarea id="fb-message" class="prechat-input prechat-textarea" data-fb="message" rows="3" placeholder="' +
                  esc(t('typeMsg')) + '" aria-required="true" aria-invalid="false" aria-describedby="fb-err-message"></textarea>' +
              '</div>' +
              '<div class="prechat-error" id="fb-err-message" data-err="message" role="alert" aria-live="polite"></div>' +
            '</div>' +
          '</div>' +
          '<button type="button" class="wy-btn wy-btn-primary wy-btn-block prechat-submit" data-fb-submit>' +
            esc(t('fallbackSubmit')) + '</button>' +
          '<div class="fallback-status" data-fb-status role="status" aria-live="polite"></div>' +
        '</div>' + footerHtml() +
      '</div>';
    }

    function smartSurfaceHtml(s) {
      return (s.dismissible === false
        ? ''
        : '<button type="button" class="smart-dismiss" data-smart-dismiss aria-label="close">\u00d7</button>') +
        (s.title ? '<div class="smart-title">' + esc(s.title) + '</div>' : '') +
        '<div class="smart-body">' + esc(s.body || '') + '</div>' +
        (s.ctaLabel
          ? '<button type="button" class="smart-cta" data-smart-cta style="background:' + env.primaryColor + '">' +
              esc(s.ctaLabel) + '</button>'
          : '');
    }

    // ══════════════════════════════════════════════════════════════════
    // Shell — NON-VISUAL infrastructure only (single-view architecture)
    // ══════════════════════════════════════════════════════════════════
    //
    // The panel is a bare container. At any moment EXACTLY ONE full view is
    // rendered inside the view host, and that view owns its own header,
    // body, composer and footer. The shell therefore carries no chat
    // header, no composer and no powered-by footer — only the view host and
    // the attachment lightbox (accessibility infrastructure Core needs).
    //
    // There is NO bottom tab bar and NO header close button: the launcher
    // is the only visual open/close control (design §15).
    function shellHtml() {
      return '<div class="body wy-scroll" data-body></div>' +
        '<div class="att-lightbox" data-att-lightbox hidden role="dialog" aria-modal="true" aria-label="' +
          esc(t('openFile')) + '">' +
          '<button type="button" class="att-lightbox-close" data-att-lightbox-close aria-label="' +
            esc(t('closePreview')) + '">×</button>' +
          '<img data-att-lightbox-img alt="" />' +
        '</div>';
    }

    // ══════════════════════════════════════════════════════════════════
    // Chat view (design §5) — the ONE generic chat surface
    // ══════════════════════════════════════════════════════════════════
    //
    // Built exactly once by Core and mounted into the view host whenever the
    // chat view is active: header → message scroll host → reply/emoji/
    // attachment state → composer → powered-by footer. Core renders the
    // message list into [data-chat-messages] and binds composer behaviour to
    // the nodes in this frame.
    function chatFrameHtml(vm) {
      vm = vm || {};
      var cfg = vm.config || {};
      var chatEnabled = !!vm.chatEnabled;
      var rtl = String(vm.locale || 'en').toLowerCase().split('-')[0] === 'fa';

      // Chat header — workspace identity ONLY. `launcherText` is never a
      // header title (design §2): the launcher label is a launcher concern.
      var chatHeader = '<div class="header wy-head wy-head-chat" data-chat-header>' +
        headerIdentityHtml({
          back: 'home',
          title: vm.workspaceName || vm.brandName || workspaceName,
          subtitle: replyTimeText(true),
          online: true,
        }) +
        '<div class="presence sr-only" data-presence aria-live="polite">' +
          '<span class="presence-dot" data-presence-dot></span>' +
          '<span class="presence-label" data-presence-label></span>' +
        '</div>' +
      '</div>';

      var attachCfg = (cfg && cfg.attachments) || { enabled: false };
      var composerCfg = (cfg && cfg.composer) || {};
      var micSupported = !!(typeof navigator !== 'undefined' && navigator.mediaDevices
        && navigator.mediaDevices.getUserMedia && typeof window.MediaRecorder === 'function');
      var voiceNotesEnabled = attachCfg.voiceNotesEnabled === true;
      var emojiEnabled = composerCfg.emojiEnabled !== false;

      var inputHtml = chatEnabled
        ? '<div class="composer-zone" data-composer-zone>' +
            // Typing state is preserved as a Core capability, but the design
            // has NO visible "typing…" row above the composer — it is
            // announced to assistive tech only.
            '<div class="sr-only" data-typing-row hidden aria-live="polite">' +
              '<span class="typing-label" data-typing-label></span>' +
            '</div>' +
            '<div class="attach-tray" data-attach-tray hidden></div>' +
            '<div class="reply-preview" data-reply-preview hidden>' +
              '<span class="reply-preview-text" data-reply-preview-text></span>' +
              '<button type="button" class="reply-preview-cancel" data-reply-cancel aria-label="' +
                esc(tf('cancel', 'Cancel')) + '">' + ICON.close + '</button>' +
            '</div>' +
            '<div class="emoji-picker" data-emoji-picker hidden></div>' +
            '<div class="input-bar" data-input-bar>' +
              '<div class="input-wrap" data-input-wrap>' +
                // Mic is the FIRST child inside the input pill and only shows
                // while the draft is empty (design source).
                (voiceNotesEnabled && micSupported
                  ? '<button type="button" class="mic-btn" data-mic-btn title="' + esc(t('recordVoice')) +
                      '" aria-label="' + esc(t('recordVoice')) + '">' + ICON.mic +
                      '<span class="mic-ring" aria-hidden="true"></span></button>'
                  : '') +
                '<textarea class="input" rows="1" data-msg-input placeholder="' + esc(t('typeMsg')) + '"></textarea>' +
                '<div class="composer-actions">' +
                  '<div class="composer-actions-start">' +
                    (attachCfg.enabled
                      ? '<button type="button" class="attach-btn" data-attach-btn title="' + esc(t('attachFile') || 'Attach file') +
                          '" aria-label="' + esc(t('attachFile') || 'Attach file') + '">' + ICON.attach + '</button>' +
                        '<input type="file" data-attach-input hidden accept="' + (attachCfg.allowedMimes || []).join(',') + '" />'
                      : '') +
                    (emojiEnabled
                      ? '<button type="button" class="emoji-btn" data-emoji-btn aria-expanded="false" title="' + esc(t('emojiPicker')) +
                          '" aria-label="' + esc(t('emojiPicker')) + '">' + ICON.emoji + '</button>'
                      : '') +
                  '</div>' +
                  '<div class="composer-actions-end">' +
                    '<button type="button" class="send-btn" data-send-btn aria-label="' + esc(tf('send', 'Send')) + '">' +
                      ICON.send + '</button>' +
                  '</div>' +
                '</div>' +
              '</div>' +
            '</div>' +

            footerHtml() +
          '</div>'
        : footerHtml();

      return '<div class="wy-view wy-view-chat"' + (rtl ? ' dir="rtl"' : '') + '>' +
        chatHeader +
        '<div class="wy-chat-scroll wy-scroll" data-chat-messages></div>' +
        inputHtml +
      '</div>';
    }


    // ══════════════════════════════════════════════════════════════════
    // Home (design §7)
    // ══════════════════════════════════════════════════════════════════
    function conversationRowHtml(c, compact) {
      var unread = Number(c.unreadCount) || 0;
      var unreadHtml = unread > 0
        ? '<span class="conv-unread" aria-label="' + esc(tf('wyUnread', 'Unread messages')) + '">' +
            esc(unread > 99 ? fmtNum(99) + '+' : fmtNum(unread)) + '</span>' : '';

      var timeHtml = c.timeLabel ? '<span class="conv-time">' + esc(c.timeLabel) + '</span>' : '';
      if (compact) {
        return '<button type="button" class="conv-row conv-row-compact" data-conversation-open="' + esc(c.id) + '">' +
          '<span class="conv-preview">' + esc(c.preview || tf('wyNoPreview', '…')) + '</span>' +
          unreadHtml + timeHtml +
        '</button>';
      }
      var resolved = String(c.status || '') === 'resolved';
      var statusLabel = resolved ? tf('wyStatusResolved', 'Resolved') : tf('wyStatusOpen', 'Open');
      return '<button type="button" class="conv-row" data-conversation-open="' + esc(c.id) + '">' +
        identityAvatarHtml('sm') +
        '<span class="conv-main">' +
          '<span class="conv-line">' +
            '<span class="conv-name">' + esc(c.title || workspaceName) + '</span>' + timeHtml +
          '</span>' +
          '<span class="conv-line">' +
            '<span class="conv-preview">' + esc(c.preview || tf('wyNoPreview', '…')) + '</span>' + unreadHtml +
          '</span>' +
          '<span class="conv-status' + (resolved ? ' is-resolved' : '') + '">' +
            '<span class="conv-status-dot" aria-hidden="true"></span>' + esc(statusLabel) + '</span>' +
        '</span>' +
      '</button>';
    }

    function homeHtml(vm) {
      vm = vm || {};
      var rtl = !!vm.rtl;
      var online = !!vm.isOnline;
      // P1 — Home shows at most 3 recent threads (design source of truth);
      // the full list stays reachable via the conversations view.
      var convs = (vm.conversations || []).slice(0, 3);
      var hasThreads = convs.length > 0;
      var unresolved = (vm.conversations || []).filter(function (c) { return String(c.status || '') !== 'resolved'; })[0];
      var articles = (vm.articles || []);
      // Design source of truth (renderVals(): showArticleChips true,
      // showArticlesButton false): article chips stay visible even when the
      // visitor already has recent conversations.
      var showChips = vm.kbEnabled && articles.length > 0;
      var showArticlesButton = false;


      // Online-operator avatars are opt-out via widget settings and now live
      // INSIDE the "start chat" CTA (before its label), never in the header.
      var showStack = vm.showTeamAvatars !== false;
      var stack = !showStack ? '' : (vm.teamMembers || []).filter(function (m) { return m && m.online; }).slice(0, 3)
        .map(function (m) {
          var av = m.avatar ? String(m.avatar) : '';
          return '<span class="home-stack-item' + (av ? ' has-img' : '') + '" title="' + esc(m.name || '') + '">' +
            (av ? '<img src="' + esc(av) + '" alt="" loading="lazy" decoding="async" />' : '') + '</span>';
        }).join('');
      var stackHtml = stack ? '<span class="home-stack" aria-hidden="true">' + stack + '</span>' : '';

      var smartCardHtml = vm.smartSurface && vm.smartSurface.mode === 'home_card'
        ? '<section class="smart-home-card">' + smartSurfaceHtml(vm.smartSurface) + '</section>'
        : '';

      var recentHtml = hasThreads
        ? '<section class="home-section home-recent">' +
            '<h3 class="home-section-title">' + esc(tf('wyRecentConversations', 'Recent conversations')) + '</h3>' +
            convs.map(function (c) { return conversationRowHtml(c, true); }).join('') +
            '<button type="button" class="home-link" data-view="list">' +
              esc(tf('wyViewConversations', 'View conversations')) +
              '<span class="home-link-chevron" aria-hidden="true">' + ICON.chevron + '</span>' +
            '</button>' +
          '</section>'
        : '';

      var chipsHtml = showChips
        ? '<section class="home-section">' +
            '<h3 class="home-section-title">' + esc(tf('wyArticlesSuggest', t('homeHelpTitle'))) + '</h3>' +
            '<div class="home-chips">' +
              articles.slice(0, 5).map(function (a) {
                return '<button type="button" class="home-chip" data-home-article="' + esc(a.slug || '') + '">' +
                  esc(a.title || '') + '</button>';
              }).join('') +
              '<button type="button" class="home-chip home-chip-more" data-view="help">' +
                esc(tf('wyMoreArticles', t('homeSeeAll'))) + '</button>' +
            '</div>' +
          '</section>'
        : '';

      var actions = '';
      if (vm.chatEnabled) {
        if (unresolved) {
          actions += '<button type="button" class="wy-btn wy-btn-primary" data-conversation-open="' + esc(unresolved.id) + '">' +
            esc(tf('wyContinueLast', 'Continue last conversation')) + '</button>';
        }
        actions += '<button type="button" class="wy-btn ' + (unresolved ? 'wy-btn-outline' : 'wy-btn-primary') +
          ' wy-btn-grow" data-home-action="chat">' + stackHtml +
          esc(unresolved ? tf('wyStartNew', t('homeStartChat')) : (online ? t('homeStartChat') : t('homeLeaveMessage'))) +
          '</button>';
      }
      if (showArticlesButton) {
        actions += '<button type="button" class="wy-btn wy-btn-outline" data-view="help">' +
          esc(tf('wyArticles', t('help'))) + '</button>';
      }

      return '<div class="wy-view wy-view-home home-root"' + (rtl ? ' dir="rtl"' : '') + '>' +
        '<div class="wy-head wy-head-home">' +
          headerIdentityHtml({
             title: vm.workspaceName || vm.headerTitle || workspaceName,
            subtitle: replyTimeText(online),
          }) +
        '</div>' +
        '<div class="wy-home-body">' +
          '<div class="wy-scroll wy-home-scroll">' +
            smartCardHtml +
            '<section class="home-greeting-block">' +
              '<h2 class="home-greeting">' + esc(t('homeGreeting')) + '</h2>' +
              '<p class="home-welcome">' + esc(vm.welcomeMessage || t('homeWelcome')) + '</p>' +
            '</section>' +
            recentHtml + chipsHtml +
          '</div>' +
          '<div class="wy-actions-block">' +
            '<div class="wy-actions">' + actions + '</div>' + footerHtml() +
          '</div>' +
        '</div>' +
      '</div>';
    }

    // ══════════════════════════════════════════════════════════════════
    // Conversation list (design §8)
    // ══════════════════════════════════════════════════════════════════
    function conversationListHtml(vm) {
      vm = vm || {};
      var rtl = !!vm.rtl;
      var items = vm.conversations || [];
      var bodyHtml = vm.loading
        ? skeletonConvRowsHtml(6)
        : (items.length
            ? items.map(function (c) { return conversationRowHtml(c, false); }).join('')
            : '<div class="wy-empty"><p>' + esc(tf('wyNoConversations', 'No conversations yet')) + '</p></div>');
      return '<div class="wy-view wy-view-list"' + (rtl ? ' dir="rtl"' : '') + '>' +
        '<div class="wy-head wy-head-list">' +
          backButtonHtml('home') +
          '<div class="wy-head-plain">' + esc(tf('wyConversations', 'Conversations')) + '</div>' +
          (vm.chatEnabled
            ? '<button type="button" class="wy-fab" data-home-action="chat" aria-label="' +
                esc(tf('wyNewConversation', 'New conversation')) + '">' + ICON.plus + '</button>'
            : '') +
        '</div>' +
        '<div class="wy-body-pad wy-list-body">' +
          '<div class="wy-scroll wy-list-scroll">' + bodyHtml + '</div>' + footerHtml() +
        '</div>' +
      '</div>';
    }

    // ══════════════════════════════════════════════════════════════════
    // Knowledge Base surfaces (articles / article, design §10 + §11)
    // ══════════════════════════════════════════════════════════════════
    var KB_ICON_SEARCH =
      '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
        '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
    var KB_ICON_BOOK =
      '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';

    function kbArticleItemHtml(a) {
      return '<button type="button" class="kb-article" data-kb-action="open" data-kb-slug="' + esc(a.slug) + '">' +
        '<span class="kb-article-title">' + esc(a.title) + '</span>' +
        '<span class="kb-article-chevron" aria-hidden="true">' + ICON.chevron + '</span>' +
      '</button>';
    }

    function kbSearchBarHtml(vm) {
      vm = vm || {};
      return '<div class="kb-search-wrap">' +
        '<input class="kb-search" type="search" autocomplete="off" autocorrect="off" spellcheck="false" ' +
        'placeholder="' + esc(t('searchKb')) + '" value="' + esc(vm.query || '') + '" /></div>';
    }

    function kbEmptyHtml(vm) {
      vm = vm || {};
      var isSearch = vm.state === 'results';
      var text = vm.emptyText || (isSearch ? t('kbZeroResults') : t('noArticles'));
      return '<div class="kb-empty">' +
        '<div class="kb-empty-icon" aria-hidden="true">' + (isSearch ? KB_ICON_SEARCH : KB_ICON_BOOK) + '</div>' +
        '<p class="kb-empty-text">' + esc(text) + '</p>' +
        (vm.hideChatCta ? '' :
          '<button type="button" class="wy-btn wy-btn-primary" data-kb-action="switch-chat">' +
            esc(t('kbSwitchToChat')) + '</button>') +
      '</div>';
    }

    function kbLoadingHtml() {
      // No visitor-visible "searching…" copy — the list shape itself is the
      // loading affordance.
      return skeletonArticleRowsHtml(6);
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
      // Design §10 — the widget Articles view is a plain list of article
      // rows. Category navigation lives in the full Knowledge Base site.
      if (!articles.length) {
        return kbEmptyHtml({ state: 'list', emptyText: vm.emptyText, hideChatCta: vm.hideChatCta });
      }
      return '<div class="kb-list">' + articles.map(kbArticleItemHtml).join('') + '</div>';
    }

    /**
     * Article feedback block (design §11). Rendered ONLY when Core says the
     * capability exists (vm.feedback.enabled) — the renderer never fakes a
     * persisted rating.
     */
    function kbArticleFeedbackHtml(fb) {
      if (!fb || !fb.enabled) return '';
      var rating = fb.rating || null;
      return '<div class="kb-feedback" data-kb-feedback>' +
        '<span class="kb-feedback-q">' + esc(tf('wyArticleHelpful', 'Was this article helpful?')) + '</span>' +
        '<div class="kb-feedback-actions">' +
          '<button type="button" class="kb-rate' + (rating === 'up' ? ' is-up' : '') +
            '" data-kb-rate="up" aria-pressed="' + (rating === 'up') + '">' + ICON.thumbUp +
            esc(tf('wyHelpfulYes', 'Helpful')) + '</button>' +
          '<button type="button" class="kb-rate' + (rating === 'down' ? ' is-down' : '') +
            '" data-kb-rate="down" aria-pressed="' + (rating === 'down') + '">' + ICON.thumbDown +
            esc(tf('wyHelpfulNo', 'Not helpful')) + '</button>' +
        '</div>' +
        (rating ? '<span class="kb-feedback-thanks">' + esc(tf('wyFeedbackThanks', 'Thanks for your feedback!')) + '</span>' : '') +
        (rating === 'down'
          ? '<button type="button" class="wy-btn wy-btn-primary kb-feedback-cta" data-kb-action="switch-chat">' +
              esc(tf('wyTalkToSupport', t('kbSwitchToChat'))) + '</button>'
          : '') +
      '</div>';
    }

    function kbArticleHtml(vm) {
      vm = vm || {};
      var a = vm.article || {};
      return '<div class="kb-article-view">' +
        '<div class="kb-article-body">' + (a.contentHtml || '') + '</div>' +
        kbArticleFeedbackHtml(vm.feedback) +
      '</div>';
    }

    /** Full KB surface — its own header + the state-specific body. */
    function kbHtml(vm) {
      vm = vm || {};
      var state = vm.state || 'list';
      var isArticle = state === 'article';
      var inner;
      if (isArticle) inner = kbArticleHtml(vm);
      else if (state === 'searching') inner = kbLoadingHtml(vm);
      else if (state === 'results') inner = kbSearchResultsHtml(vm);
      else inner = kbHomeHtml(vm);

      // article -> articles, articles -> home (design §16).
      var head = isArticle
        ? '<div class="wy-head wy-head-article">' +
            // P1 — generic back control: the shell resolves "back" as a real
            // step back inside the current view (article -> results/list) and
            // only falls back to the named tab when there is nowhere to go.
            '<button type="button" class="wy-back" data-view-back="back" data-view-back-fallback="home"' +
              ' aria-label="' + esc(tf('back', 'Back')) + '">' + ICON.back + '</button>' +
            identityAvatarHtml('sm') +
            '<div class="wy-head-plain wy-head-article-title">' + esc((vm.article && vm.article.title) || '') + '</div>' +
          '</div>'
        : '<div class="wy-head">' +
            headerIdentityHtml({ back: 'home', subtitle: tf('wyArticles', t('help')) }) +
          '</div>';

      return '<div class="wy-view wy-view-kb kb-root"' + (vm.rtl ? ' dir="rtl"' : '') + '>' + head +
        '<div class="wy-body-pad wy-kb-body">' +
          '<div class="wy-scroll wy-kb-scroll">' +
            inner +
          '</div>' + footerHtml() +
        '</div>' +
      '</div>';
    }

    // ══════════════════════════════════════════════════════════════════
    // Loading skeletons (cold boot only)
    // ══════════════════════════════════════════════════════════════════
    //
    // Core never builds this markup: it only reports a normalized
    // `{ view, initialLoading, hasUsableContent }` and asks the template for
    // a skeleton. Every skeleton mirrors the geometry of the real surface it
    // replaces (same header height, same paddings, same footer) so the
    // crossfade to real content produces no layout shift. Containers are
    // `aria-hidden` — a skeleton must never look like real content to a
    // screen reader, and it never carries fake names/times/counts.

    function sk(cls, style) {
      return '<span class="wy-sk' + (cls ? ' ' + cls : '') + '"' + (style ? ' style="' + style + '"' : '') + '></span>';
    }
    function skLine(width, height, radius) {
      return sk('wy-sk-line', 'width:' + width + ';height:' + (height || 10) + 'px;border-radius:' +
        (radius || 5) + 'px;');
    }
    function skCircle(size) {
      return sk('wy-sk-circle', 'width:' + size + 'px;height:' + size + 'px;');
    }

    function skHeadIdentityHtml(opts) {
      opts = opts || {};
      return '<div class="wy-head' + (opts.headClass ? ' ' + opts.headClass : '') + '">' +
        (opts.back ? '<span class="wy-back wy-sk-back" aria-hidden="true"></span>' : '') +
        skCircle(opts.avatar || 44) +
        '<div class="wy-head-id">' +
          '<div class="wy-head-line">' + skLine('120px', 13) + '</div>' +
          skLine('84px', 9) +
        '</div>' +
        (opts.stack
          ? '<span class="home-stack">' + skCircle(22) + skCircle(22) + skCircle(22) + '</span>'
          : '') +
      '</div>';
    }

    function skeletonConvRowsHtml(n) {
      var out = '';
      for (var i = 0; i < (n || 5); i++) {
        out += '<div class="conv-row wy-sk-row" aria-hidden="true">' +
          skCircle(36) +
          '<span class="conv-main">' +
            '<span class="conv-line">' + skLine('44%', 11) + skLine('26px', 9) + '</span>' +
            '<span class="conv-line">' + skLine((62 + (i % 3) * 9) + '%', 10) + '</span>' +
            '<span class="conv-line">' + skLine('48px', 8) + '</span>' +
          '</span>' +
        '</div>';
      }
      return '<div class="wy-sk-group" aria-hidden="true">' + out + '</div>';
    }

    function skeletonArticleRowsHtml(n) {
      var out = '';
      var widths = ['72%', '58%', '81%', '64%', '76%', '52%'];
      for (var i = 0; i < (n || 6); i++) {
        out += '<div class="kb-article wy-sk-row" aria-hidden="true">' +
          skLine(widths[i % widths.length], 12) +
          '<span class="kb-article-chevron wy-sk-chevron" aria-hidden="true">' + sk('', 'width:7px;height:7px;') + '</span>' +
        '</div>';
      }
      return '<div class="kb-list wy-sk-group" aria-hidden="true">' + out + '</div>';
    }

    function skeletonHomeHtml(vm) {
      vm = vm || {};
      return '<div class="wy-view wy-view-home home-root wy-skeleton"' + (vm.rtl ? ' dir="rtl"' : '') + '>' +
        skHeadIdentityHtml({ headClass: 'wy-head-home', avatar: 44 }) +
        '<div class="wy-home-body">' +
          '<div class="wy-scroll wy-home-scroll" aria-hidden="true">' +
            '<section class="home-greeting-block">' +
              skLine('38%', 19, 7) + skLine('72%', 14) +
            '</section>' +
            '<section class="home-section home-recent">' +
              skLine('42%', 10) +
              '<div class="conv-row conv-row-compact wy-sk-row">' +
                skLine('68%', 11) + skLine('30px', 9) +
              '</div>' +
            '</section>' +
            '<section class="home-section">' +
              skLine('34%', 10) +
              '<div class="home-chips">' +
                sk('wy-sk-chip', 'width:96px;') + sk('wy-sk-chip', 'width:74px;') +
                sk('wy-sk-chip', 'width:110px;') +
              '</div>' +
            '</section>' +
          '</div>' +
          '<div class="wy-actions-block">' +
            '<div class="wy-actions" aria-hidden="true">' +
              sk('wy-sk-btn') +
            '</div>' + footerHtml() +
          '</div>' +
        '</div>' +
      '</div>';
    }

    function skeletonChatHtml(vm) {
      vm = vm || {};
      var rows = [
        { me: false, w: '64%' },
        { me: true, w: '48%' },
        { me: false, w: '78%' },
        { me: true, w: '38%' },
        { me: false, w: '56%' },
      ];
      var msgs = rows.map(function (r) {
        return '<div class="wy-sk-msg' + (r.me ? ' is-me' : '') + '">' +
          (r.me ? '' : skCircle(26)) +
          '<span class="wy-sk-bubble" style="width:' + r.w + ';"></span>' +
        '</div>';
      }).join('');
      return '<div class="wy-view wy-view-chat wy-skeleton"' + (vm.rtl ? ' dir="rtl"' : '') + '>' +
        skHeadIdentityHtml({ headClass: 'wy-head-chat', avatar: 44, back: true }) +
        '<div class="wy-chat-body">' +
          '<div class="wy-scroll wy-sk-msgs" aria-hidden="true">' + msgs + '</div>' +
          '<div class="composer-zone" aria-hidden="true">' +
            '<div class="input-bar">' +
              '<div class="input-wrap wy-sk-input">' + skLine('54%', 12) + '</div>' +
            '</div>' + footerHtml() +
          '</div>' +
        '</div>' +
      '</div>';
    }

    function skeletonListHtml(vm) {
      vm = vm || {};
      return '<div class="wy-view wy-view-list wy-skeleton"' + (vm.rtl ? ' dir="rtl"' : '') + '>' +
        '<div class="wy-head wy-head-list" aria-hidden="true">' +
          '<span class="wy-back wy-sk-back"></span>' +
          skLine('92px', 13) +
        '</div>' +
        '<div class="wy-body-pad wy-list-body">' +
          '<div class="wy-scroll wy-list-scroll">' + skeletonConvRowsHtml(6) + '</div>' +
          footerHtml() +
        '</div>' +
      '</div>';
    }

    function skeletonPrechatHtml(vm) {
      vm = vm || {};
      // Bounded default while the asked-field config is still unknown; once
      // Core knows the authoritative field count it passes `fields`.
      var n = Math.max(1, Math.min(4, Number(vm.fields) || 2));
      var fields = '';
      for (var i = 0; i < n; i++) {
        fields += '<div class="prechat-field" aria-hidden="true">' +
          skLine('64px', 10) + sk('wy-sk-field') +
        '</div>';
      }
      return '<div class="wy-view wy-view-precontact prechat wy-skeleton"' + (vm.rtl ? ' dir="rtl"' : '') + '>' +
        skHeadIdentityHtml({ back: true, avatar: 44 }) +
        '<div class="wy-scroll wy-body-pad" aria-hidden="true">' +
          '<div class="wy-sk-group">' + skLine('86%', 12) + skLine('58%', 12) + '</div>' +
          '<div class="prechat-fields">' + fields + '</div>' +
          '<div class="prechat-spacer"></div>' +
          sk('wy-sk-btn') +
        '</div>' +
      '</div>';
    }

    function skeletonArticlesHtml(vm) {
      vm = vm || {};
      return '<div class="wy-view wy-view-kb kb-root wy-skeleton"' + (vm.rtl ? ' dir="rtl"' : '') + '>' +
        skHeadIdentityHtml({ back: true, avatar: 44 }) +
        '<div class="wy-body-pad wy-kb-body">' +
          '<div class="wy-scroll wy-kb-scroll">' + skeletonArticleRowsHtml(6) + '</div>' +
          footerHtml() +
        '</div>' +
      '</div>';
    }

    function skeletonArticleHtml(vm) {
      vm = vm || {};
      var widths = ['96%', '88%', '92%', '70%', '94%', '61%', '86%', '48%'];
      var lines = widths.map(function (w) { return skLine(w, 11); }).join('');
      return '<div class="wy-view wy-view-kb kb-root wy-skeleton"' + (vm.rtl ? ' dir="rtl"' : '') + '>' +
        '<div class="wy-head wy-head-article" aria-hidden="true">' +
          '<span class="wy-back wy-sk-back"></span>' + skCircle(36) + skLine('56%', 13) +
        '</div>' +
        '<div class="wy-body-pad wy-kb-body">' +
          '<div class="wy-scroll wy-kb-scroll" aria-hidden="true">' +
            '<div class="kb-article-body wy-sk-group">' + lines + '</div>' +
            '<div class="kb-feedback wy-sk-group">' +
              skLine('46%', 11) +
              '<div class="kb-feedback-actions">' + sk('wy-sk-pill') + sk('wy-sk-pill') + '</div>' +
            '</div>' +
          '</div>' + footerHtml() +
        '</div>' +
      '</div>';
    }

    /**
     * Generic entry point Core calls with a normalized view key. Unknown
     * views fall back to an empty string so Core degrades to "render nothing"
     * rather than leaking a technical placeholder.
     */
    function skeletonHtml(view, vm) {
      switch (String(view || '')) {
        case 'home': return skeletonHomeHtml(vm);
        case 'chat': return skeletonChatHtml(vm);
        case 'list': return skeletonListHtml(vm);
        case 'prechat': return skeletonPrechatHtml(vm);
        case 'help':
        case 'articles': return skeletonArticlesHtml(vm);
        case 'article': return skeletonArticleHtml(vm);
        default: return skeletonHomeHtml(vm);
      }
    }

    return {

      id: 'web-yar',
      shellHtml: shellHtml,
      chatFrameHtml: chatFrameHtml,
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
      // Generic contract extensions (template-agnostic surfaces).
      conversationListHtml: conversationListHtml,
      conversationRowHtml: conversationRowHtml,
      // Knowledge Base surfaces
      kbHtml: kbHtml,
      kbSearchBarHtml: kbSearchBarHtml,
      kbHomeHtml: kbHomeHtml,
      kbSearchResultsHtml: kbSearchResultsHtml,
      kbArticleHtml: kbArticleHtml,
      kbEmptyHtml: kbEmptyHtml,
      kbLoadingHtml: kbLoadingHtml,
      kbArticleFeedbackHtml: kbArticleFeedbackHtml,

      // Loading UX (optional presentation contract). Core asks for a
      // skeleton by normalized view key; a template that does not implement
      // this simply omits it and Core renders nothing instead.
      skeletonHtml: skeletonHtml,
      connIndicatorHtml: connIndicatorHtml,


      format: {
        msgTime: formatMsgTime,
        callDuration: fmtCallDuration,
        invitationRemaining: fmtInvitationRemaining,
        humanSize: humanSize,
      },
    };
  }

  function prepare() {
    if (!document.fonts || typeof document.fonts.load !== 'function') return Promise.resolve();
    var sample = 'سلام وب یار';
    var loads = [400, 500, 600].map(function (weight) {
      return document.fonts.load(String(weight) + ' 16px IRANSans', sample).catch(function () { return []; });
    });
    return Promise.race([
      Promise.all(loads).then(function () {}),
      new Promise(function (resolve) { setTimeout(resolve, 500); }),
    ]);
  }

  window.__gs_presentation_web_yar = { id: 'web-yar', create: create, prepare: prepare };
})();
