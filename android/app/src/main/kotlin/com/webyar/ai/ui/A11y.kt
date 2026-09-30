package com.webyar.ai.ui

/**
 * The identifiers tests drive the app by.
 *
 * Spelled the same as the iOS app's `Accessibility.swift`, deliberately: the
 * two suites then read alike, and a behaviour proved on one platform can be
 * asked for by name on the other. A Compose test reaches them through
 * `onNodeWithTag`, which reads `Modifier.testTag`.
 *
 * They are also what a screen reader announces as the element's identity, so
 * they are not debug-only scaffolding and are not stripped from release.
 */
object A11y {
    const val LOGIN_EMAIL = "login.email"
    const val LOGIN_PASSWORD = "login.password"
    const val LOGIN_SUBMIT = "login.submit"
    const val LOGIN_ERROR = "login.error"
    const val BRAND_FOOTER = "brand.footer"
    const val RESTORING = "session.restoring"
    const val RESET_BACK = "reset.back"
    const val MAINTENANCE = "maintenance"
    const val MAINTENANCE_RETRY = "maintenance.retry"

    const val INBOX_LIST = "inbox.list"
    const val INBOX_EMPTY = "inbox.empty"
    const val INBOX_SYNC_NOTICE = "inbox.syncNotice"
    const val INBOX_SEARCH = "inbox.search"
    const val INBOX_FILTER = "inbox.filter"
    const val INBOX_TITLE_MENU = "inbox.title.menu"
    const val INBOX_COLLEAGUES_CHIP = "inbox.chip.colleagues"
    const val INBOX_EVERY_INBOX = "inbox.everyInbox"
    const val INBOX_EVERY_INBOX_SHEET = "inbox.everyInbox.sheet"
    fun inboxChip(wire: String) = "inbox.chip.$wire"
    fun everyInboxRow(wire: String) = "inbox.everyInbox.$wire"
    const val INBOX_COLLEAGUES_ROW = "inbox.everyInbox.colleagues"
    fun emailMailboxRow(provider: String) = "inbox.everyInbox.email.$provider"

    /** Absent from the tree when the search is closed, which several tests
     *  are about — see `SearchState`. */
    const val SEARCH_FIELD = "search.field"

    const val COMPOSER_FIELD = "composer.field"
    const val CHAT_OPEN_VISITOR = "chat.openVisitor"
    const val COMPOSER_STOP_RECORDING = "composer.stopRecording"
    const val COMPOSER_RECORDED = "composer.recorded"
    const val COMPOSER_SEND = "composer.send"
    const val CHAT_TRANSCRIPT = "chat.transcript"
    const val CHAT_MENU = "chat.menu"
    const val COMPOSER_ATTACH = "composer.attach"
    const val COMPOSER_SHORTCUTS = "composer.shortcuts"
    const val COMPOSER_EMOJI = "composer.emoji"
    const val SAY_NOW_VOICE = "sayNow.voice"

    const val CONTACTS_LIST = "contacts.list"
    const val CONTACTS_EMPTY = "contacts.empty"
    const val CONTACTS_SEARCH = "contacts.search"
    const val CONTACT_DETAIL = "contact.detail"

    const val COLLEAGUES_LIST = "colleagues.list"
    const val COLLEAGUES_EMPTY = "colleagues.empty"
    const val TEAM_TRANSCRIPT = "team.transcript"

    const val EMAIL_LIST = "email.list"
    const val EMAIL_EMPTY = "email.empty"
    const val EMAIL_NOT_CONNECTED = "email.notConnected"
    const val EMAIL_THREAD = "email.thread"
    const val EMAIL_MENU = "email.menu"

    const val VISITORS_SCREEN = "visitors.screen"
    const val VISITORS_LIST = "visitors.list"
    const val VISITORS_EMPTY = "visitors.empty"
    const val VISITORS_MAP_TOGGLE = "visitors.mapToggle"
    const val VISITORS_FILTER_ONLINE = "visitors.filter.online"
    const val VISITORS_FILTER_CHAT = "visitors.filter.chat"
    const val VISITOR_DETAIL = "visitor.detail"
    const val VISITOR_CHAT = "visitor.chat"
    const val VISITOR_COPY_SESSION = "visitor.copySession"
    const val VISITOR_HISTORY = "visitor.history"
    fun visitorRow(id: String) = "visitor.$id"

    const val ANALYTICS_SCREEN = "analytics.screen"
    const val ANALYTICS_LIVE = "analytics.live"
    const val ANALYTICS_LOCKED = "analytics.locked"
    const val ANALYTICS_CHART = "analytics.chart"
    fun analyticsSection(wire: String) = "analytics.section.$wire"
    fun analyticsRange(days: Int) = "analytics.range.$days"
    fun analyticsKpi(wire: String) = "analytics.kpi.$wire"

    const val PROMO_BANNER = "promo.banner"
    const val PROMO_FULLSCREEN = "promo.fullscreen"
    const val PROMO_DISMISS = "promo.dismiss"

    const val CALL_SCREEN = "call.screen"
    const val CALL_STATUS = "call.status"
    const val CALL_FAILURE_REASON = "call.failureReason"
    const val CALL_MUTE = "call.mute"
    const val CALL_CAMERA = "call.camera"
    const val CALL_SPEAKER = "call.speaker"
    const val CALL_HANG_UP = "call.hangUp"
    const val CALL_ANSWER = "call.answer"
    const val CALL_DECLINE = "call.decline"
    const val CALL_SELF_VIEW = "call.selfView"

    fun conversationRow(id: String) = "conversation.$id"
    fun priorityTag(wire: String) = "priority.$wire"
    fun contactRow(id: String) = "contact.$id"
    fun colleagueRow(id: String) = "colleague.$id"
    fun emailFolder(name: String) = "email.folder.$name"
    /** The ☰ button that opens a mailbox's folders, the menu itself, and one folder in it. */
    const val EMAIL_FOLDERS = "email.folders"
    /** The mailbox's loader, the thin bar of a background re-read, and the menu's loader. */
    const val EMAIL_LOADING = "email.loading"
    const val EMAIL_SYNCING = "email.syncing"
    const val EMAIL_FOLDERS_LOADING = "email.folders.loading"
    const val EMAIL_DOWNLOADING = "email.downloading"
    const val EMAIL_DRAWER = "email.drawer"
    fun emailMailFolder(id: String) = "email.box.$id"
    fun emailMailbox(provider: String) = "email.mailbox.$provider"
    fun emailStar(id: String) = "email.star.$id"
    const val EMAIL_COMPOSE = "email.compose"
    const val EMAIL_COMPOSE_SEND = "email.compose.send"
    const val EMAIL_COMPOSE_TO = "email.compose.to"
    const val EMAIL_COMPOSE_SUBJECT = "email.compose.subject"
    const val EMAIL_COMPOSE_BODY = "email.compose.body"
    const val EMAIL_REPLY = "email.reply"
    const val EMAIL_REPLY_ALL = "email.replyAll"
    const val EMAIL_FORWARD = "email.forward"
    fun emailAttachment(id: String) = "email.attachment.$id"
    fun emailRow(id: String) = "email.$id"
    fun emailMessage(id: String) = "email.message.$id"
    fun messageRow(id: String) = "message.$id"

    /**
     * An attachment, by the kind it is drawn as rather than by the kind the
     * server called it — a test that asks for the voice note is asking
     * whether it got a player, not whether the MIME type said audio.
     */
    fun attachmentImage(id: String) = "attachment.image.$id"
    fun attachmentVoiceNote(id: String) = "attachment.voice.$id"
    fun attachmentVoicePlay(id: String) = "attachment.voice.play.$id"
    fun attachmentFile(id: String) = "attachment.file.$id"
    fun messageStatus(id: String) = "message.status.$id"
    const val SETTINGS_LIST = "settings.list"
    const val SETTINGS_SUPPORT = "settings.support"
    /** Settings › Online support: the live chat, a new ticket, the operator's requests. */
    const val SETTINGS_SUPPORT_CHAT = "settings.support.chat"
    const val SETTINGS_SUPPORT_TICKET = "settings.support.ticket"
    const val SETTINGS_SUPPORT_REQUESTS = "settings.support.requests"
    const val SUPPORT_HOME = "support.home"
    const val SUPPORT_START = "support.start"
    const val SUPPORT_TRANSCRIPT = "support.transcript"
    const val SUPPORT_TICKET_SUBJECT = "support.ticket.subject"
    const val SUPPORT_TICKET_BODY = "support.ticket.body"
    const val SUPPORT_TICKET_SUBMIT = "support.ticket.submit"
    fun supportThread(id: String) = "support.thread.$id"
    const val SETTINGS_STORAGE = "settings.storage"
    const val SETTINGS_CLEAR_CACHE = "settings.clearCache"
    const val SETTINGS_CLEAR_CACHE_CONFIRM = "settings.clearCache.confirm"
    const val ATTACHMENT_VIEWER_CLOSE = "attachment.viewer.close"

    const val SETTINGS_NOTIFICATIONS = "settings.notifications"
    const val SETTINGS_SECURITY = "settings.security"
    const val PROFILE_FIRST_NAME = "profile.firstName"
    const val PROFILE_PHONE_FIELD = "profile.phoneField"
    const val PROFILE_NAME = "profile.name"
    const val PROFILE_PHONE = "profile.phone"
    const val SECURITY_REVOKE_OTHERS = "security.revokeOthers"
    const val NOTIFICATIONS_LIST = "notifications.list"
    const val NOTIFICATIONS_RETRY = "notifications.retry"
    const val NOTIFICATIONS_PERMISSION = "notifications.permission"
    const val NOTIFICATIONS_DISABLE_ALL = "notifications.disableAll"
    const val NOTIFICATIONS_PREVIEW = "notifications.preview"
    const val NOTIFICATIONS_QUIET_HOURS = "notifications.quietHours"
    fun notificationsScope(wire: String) = "notifications.scope.$wire"
    const val NOTIFICATIONS_QUIET_START = "notifications.quietStart"
    const val NOTIFICATIONS_QUIET_END = "notifications.quietEnd"
    const val NOTIFICATIONS_STATUS = "notifications.status"
    const val NOTIFICATIONS_SAVE_ERROR = "notifications.saveError"
    const val CLOCK_PICKER = "clock.picker"
    const val CLOCK_PICKER_CONFIRM = "clock.picker.confirm"
    fun workspaceRow(id: String) = "settings.workspace.$id"
    fun shortcutRow(id: String) = "shortcut.$id"
}
