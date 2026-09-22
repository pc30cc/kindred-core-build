package com.webyar.operator.ui.nav

import com.webyar.operator.ui.AppTab

/**
 * Every place the shell can be.
 *
 * Strings rather than the type-safe `@Serializable` routes Navigation 2.8
 * added, for one reason: these are also what a deep link and a debug launch
 * argument name, and a scheme that has to be spelled the same in three places
 * is better spelled once, here, in a form all three can use.
 *
 * Each tab is a nested graph rather than a single destination. That is what
 * gives a tab its own back stack: pushing a chat inside the inbox graph and
 * then switching to Settings and back returns to the chat, not to the list.
 */
object Route {
    // Graphs — one per tab.
    const val INBOX_GRAPH = "graph/inbox"
    const val CONTACTS_GRAPH = "graph/contacts"
    const val SETTINGS_GRAPH = "graph/settings"

    // Tab roots.
    const val INBOX = "inbox"
    const val CONTACTS = "contacts"
    const val SETTINGS = "settings"

    // Details, which hide the tab bar.
    //
    // Only the ones that have a screen are here. Declaring a route for a
    // screen nobody has written yet is a constant that compiles, reads like a
    // plan, and silently navigates to nothing.
    const val CHAT = "chat/{conversationId}"
    fun chat(conversationId: String) = "chat/$conversationId"

    const val PROFILE = "settings/profile"
    const val SECURITY = "settings/security"

    fun graphFor(tab: AppTab): String = when (tab) {
        AppTab.INBOX -> INBOX_GRAPH
        AppTab.CONTACTS -> CONTACTS_GRAPH
        AppTab.SETTINGS -> SETTINGS_GRAPH
    }

    /**
     * The roots — the destinations that are a tab rather than something
     * pushed on top of one.
     *
     * The tab bar shows on these and nowhere else: a pushed screen is a
     * full-screen task, and a bar hovering over a composer is in the way.
     */
    private val roots = setOf(INBOX, CONTACTS, SETTINGS)

    fun isRoot(route: String?): Boolean = route in roots
}
