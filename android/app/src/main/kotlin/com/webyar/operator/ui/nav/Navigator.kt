package com.webyar.operator.ui.nav

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.remember
import androidx.navigation3.runtime.NavBackStack
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.rememberNavBackStack
import com.webyar.operator.ui.AppTab

/**
 * One back stack per tab, and which tab is in front.
 *
 * Each tab keeps its own stack, so a chat opened in the inbox is still open
 * after a visit to Settings — what Navigation Compose's nested graphs with
 * `saveState` gave, here as plain lists the app owns. The stacks are
 * `rememberNavBackStack`s, so they survive the process being killed.
 *
 * Which tab is in front is not held here: [AppState] owns it, because the
 * plan decides which tabs exist and a notification tap decides which one
 * opens.
 */
@Stable
class Navigator internal constructor(
    private val stacks: Map<AppTab, NavBackStack<NavKey>>,
    private val currentTab: () -> AppTab,
    private val selectTab: (AppTab) -> Unit,
) {
    val tab: AppTab get() = currentTab()

    fun stack(tab: AppTab): NavBackStack<NavKey> = stacks.getValue(tab)

    /** The stack in front. */
    val current: NavBackStack<NavKey> get() = stack(tab)

    /** The screen on top of the stack in front. */
    val top: Screen? get() = current.lastOrNull() as? Screen

    /**
     * Opens a screen, in its own tab.
     *
     * A screen of the kind already on top replaces it instead of stacking a
     * second one: opening another conversation from the list beside an open
     * chat, on a tablet, swaps the chat rather than burying it, so Back goes
     * to the list and not through every conversation looked at.
     */
    fun open(screen: Screen) {
        if (screen.tab != tab) selectTab(screen.tab)
        val stack = stack(screen.tab)
        val last = stack.lastOrNull()
        when {
            last == screen -> Unit
            last != null && last::class == screen::class && !screen.isRoot() -> stack[stack.lastIndex] = screen
            else -> stack.add(screen)
        }
    }

    /**
     * A tab in the bar was tapped. Tapping the tab already in front goes back
     * to its root — the platform's convention, and the quickest way out of a
     * deep thread.
     */
    fun select(tab: AppTab) {
        if (tab == this.tab) {
            popToRoot(tab)
        } else {
            selectTab(tab)
        }
    }

    fun popToRoot(tab: AppTab) {
        val stack = stack(tab)
        while (stack.size > 1) stack.removeAt(stack.lastIndex)
    }

    /**
     * Back. Pops the stack in front; at the root of a tab other than the
     * inbox, goes to the inbox — the start of the app, where Back from any
     * tab's root has always led. Returns false only at the inbox's root,
     * where Back leaves the app.
     */
    fun back(): Boolean {
        val stack = current
        return when {
            stack.size > 1 -> {
                stack.removeAt(stack.lastIndex)
                true
            }
            tab != AppTab.INBOX -> {
                selectTab(AppTab.INBOX)
                true
            }
            else -> false
        }
    }
}

@Composable
fun rememberNavigator(currentTab: () -> AppTab, selectTab: (AppTab) -> Unit): Navigator {
    val inbox = rememberNavBackStack(InboxKey)
    val contacts = rememberNavBackStack(ContactsKey)
    val settings = rememberNavBackStack(SettingsKey)
    return remember(inbox, contacts, settings) {
        Navigator(
            stacks = mapOf(AppTab.INBOX to inbox, AppTab.CONTACTS to contacts, AppTab.SETTINGS to settings),
            currentTab = currentTab,
            selectTab = selectTab,
        )
    }
}
