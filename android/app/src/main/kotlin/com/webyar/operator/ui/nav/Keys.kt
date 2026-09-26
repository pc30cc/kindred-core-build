package com.webyar.operator.ui.nav

import androidx.navigation3.runtime.NavKey
import com.webyar.operator.ui.AppTab
import kotlinx.serialization.Serializable

/**
 * Every place the shell can be, as Navigation 3 keys.
 *
 * A back stack is a list of these, owned by the app rather than hidden in a
 * controller — which is what lets one stack drive both a phone, where a chat
 * covers the inbox, and a tablet, where the inbox and the chat sit side by
 * side. `@Serializable` so a stack survives the process being killed in the
 * background: an operator who comes back to the app finds the conversation
 * they left, not the inbox.
 *
 * Only screens that exist have a key. Declaring one for a screen nobody has
 * written yet is a constant that compiles, reads like a plan, and navigates
 * to nothing.
 */
@Serializable
sealed interface Screen : NavKey {
    /** The tab whose stack this screen lives in. */
    val tab: AppTab
}

@Serializable data object InboxKey : Screen { override val tab get() = AppTab.INBOX }

@Serializable data class ChatKey(val conversationId: String) : Screen {
    override val tab get() = AppTab.INBOX
}

@Serializable data class CallKey(val conversationId: String, val channel: String) : Screen {
    override val tab get() = AppTab.INBOX
}

/**
 * The internal inbox lives in the Inbox tab, not a tab of its own — which is
 * where the console keeps it, and what makes Back from a colleague's thread
 * land on the conversation list.
 */
@Serializable data object ColleaguesKey : Screen { override val tab get() = AppTab.INBOX }

@Serializable data class TeamThreadKey(val peerId: String) : Screen {
    override val tab get() = AppTab.INBOX
}

@Serializable data object EmailKey : Screen { override val tab get() = AppTab.INBOX }

@Serializable data class EmailThreadKey(val threadId: String) : Screen {
    override val tab get() = AppTab.INBOX
}

/**
 * The visitor of an open chat, as a contact — opened from the face or the
 * name in the chat, and kept on the inbox's stack so Back returns to the
 * chat rather than to the address book.
 *
 * It carries what the chat already knows about the contact, so the page has
 * something to show even when the address book was never loaded (or the plan
 * has no Contacts tab); the address book's fuller row wins when it is there.
 */
@Serializable data class VisitorKey(
    val conversationId: String,
    val contactId: String?,
    val name: String?,
    val email: String?,
    val avatarUrl: String?,
    val visitorCode: String?,
) : Screen {
    override val tab get() = AppTab.INBOX
}

@Serializable data object ContactsKey : Screen { override val tab get() = AppTab.CONTACTS }

@Serializable data class ContactKey(val contactId: String) : Screen {
    override val tab get() = AppTab.CONTACTS
}

@Serializable data object SettingsKey : Screen { override val tab get() = AppTab.SETTINGS }

@Serializable data object ProfileKey : Screen { override val tab get() = AppTab.SETTINGS }

@Serializable data object SecurityKey : Screen { override val tab get() = AppTab.SETTINGS }

@Serializable data object NotificationsKey : Screen { override val tab get() = AppTab.SETTINGS }

/** The root of each tab's stack. */
val AppTab.root: Screen
    get() = when (this) {
        AppTab.INBOX -> InboxKey
        AppTab.CONTACTS -> ContactsKey
        AppTab.SETTINGS -> SettingsKey
    }

/**
 * The roots — a tab rather than something pushed on top of one. On a phone
 * the navigation bar shows on these and nowhere else: a pushed screen is a
 * full-screen task, and a bar under a composer is in the way.
 */
fun Screen.isRoot(): Boolean = this == tab.root
