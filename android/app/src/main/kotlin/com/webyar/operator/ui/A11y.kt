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

    const val COMPOSER_FIELD = "composer.field"
    const val COMPOSER_SEND = "composer.send"
    const val CHAT_TRANSCRIPT = "chat.transcript"

    fun conversationRow(id: String) = "conversation.$id"
    fun messageRow(id: String) = "message.$id"
}
