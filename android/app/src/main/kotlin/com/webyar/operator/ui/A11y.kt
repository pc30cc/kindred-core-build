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

    fun conversationRow(id: String) = "conversation.$id"
    fun contactRow(id: String) = "contact.$id"
    fun colleagueRow(id: String) = "colleague.$id"
    fun emailRow(id: String) = "email.$id"
    fun emailMessage(id: String) = "email.message.$id"
    fun messageRow(id: String) = "message.$id"
    fun workspaceRow(id: String) = "settings.workspace.$id"
    fun shortcutRow(id: String) = "shortcut.$id"
}
