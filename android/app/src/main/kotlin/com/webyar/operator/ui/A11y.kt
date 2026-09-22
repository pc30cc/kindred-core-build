package com.webyar.operator.ui

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

    const val INBOX_LIST = "inbox.list"
    const val INBOX_EMPTY = "inbox.empty"
    const val INBOX_SEARCH = "inbox.search"
    const val INBOX_FILTER = "inbox.filter"
    const val INBOX_TITLE_MENU = "inbox.title.menu"

    /** Absent from the tree when the search is closed, which several tests
     *  are about — see `SearchState`. */
    const val SEARCH_FIELD = "search.field"
    const val TAB_BAR = "tab.bar"

    const val COMPOSER_FIELD = "composer.field"
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

    const val PROMO_BANNER = "promo.banner"
    const val PROMO_FULLSCREEN = "promo.fullscreen"
    const val PROMO_DISMISS = "promo.dismiss"

    const val CALL_SCREEN = "call.screen"
    const val CALL_STATUS = "call.status"
    const val CALL_MUTE = "call.mute"
    const val CALL_CAMERA = "call.camera"
    const val CALL_SPEAKER = "call.speaker"
    const val CALL_HANG_UP = "call.hangUp"

    fun conversationRow(id: String) = "conversation.$id"
    fun contactRow(id: String) = "contact.$id"
    fun colleagueRow(id: String) = "colleague.$id"
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
    const val ATTACHMENT_VIEWER_CLOSE = "attachment.viewer.close"

    const val SETTINGS_NOTIFICATIONS = "settings.notifications"
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
