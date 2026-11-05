package com.platform.app.ui.nav

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.navigation3.runtime.NavBackStack
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.rememberNavBackStack
import com.platform.app.ui.AppTab

/**
 * One back stack per tab, and which tab is in front.
 *
 * Each tab keeps its own stack, so a chat opened in the inbox is still open
 * after a visit to Settings — what Navigation Compose's nested graphs with
 * `saveState` give, here as plain lists the app owns. The stacks are
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

    /**
     * A call's screen taken off the display with the call still on (its
     * minimise button, or Back during the call). It stays where it was on its
     * stack — which is what keeps its session, and so the call, alive — but
     * is not drawn ([displayed]), not on top ([top]) and not popped by Back:
     * the rest of the app is used as if it were not there, with the call in
     * a bubble over it, until the bubble (or the picture-in-picture window)
     * brings it back with [raise]. One at a time: a second call is not placed
     * while one is on ([holdsCall]).
     */
    var minimised: Screen? by mutableStateOf(null)
        private set

    /** The screen on top of the stack in front. */
    val top: Screen? get() = current.lastOrNull { it != minimised } as? Screen

    /** [tab]'s stack as it is drawn: everything but a minimised call. */
    fun displayed(tab: AppTab): List<NavKey> = stack(tab).filter { it != minimised }

    /**
     * Takes [screen], a call, off the display and leaves its call on. The
     * screen under it shows again; with nothing under it but the tab's root,
     * the root.
     */
    fun minimise(screen: Screen) {
        if (!screen.isCall() || screen !in stack(screen.tab)) return
        minimised = screen
    }

    /** A minimised call that ended: off its stack, which ends its session too. */
    fun dropMinimised() {
        val screen = minimised ?: return
        minimised = null
        stack(screen.tab).remove(screen)
    }

    /**
     * Whether a call's screen — ringing, or on — is on any stack, whichever
     * tab is in front: what keeps the lock card (the plan with the mobile app
     * off) from covering a call that was already there. A lock never cuts a
     * call (docs/operations/MOBILE_APP_PLAN.md).
     */
    val holdsCall: Boolean get() = stacks.values.any { stack -> stack.any { (it as? Screen)?.isCall() == true } }

    /**
     * Opens a screen, in its own tab.
     *
     * A screen of the kind already on top replaces it instead of stacking a
     * second one: opening another conversation from the list beside an open
     * chat, on a tablet, swaps the chat rather than burying it, so Back goes
     * to the list and not through every conversation looked at.
     */
    fun open(screen: Screen) {
        if (screen.isCall()) callsThisProcess += screen
        if (screen.tab != tab) selectTab(screen.tab)
        val stack = stack(screen.tab)
        // What is drawn on top: a minimised call is never replaced by a
        // screen of its own kind, which would end it.
        val at = stack.indexOfLast { it != minimised }
        val last = stack.getOrNull(at)
        when {
            last == screen -> Unit
            last != null && last::class == screen::class && !screen.isRoot() -> stack[at] = screen
            else -> stack.add(screen)
        }
    }

    /**
     * Brings [screen], already on its tab's stack, to the front: the same
     * entry — its view model, and the call running in it — rather than a new
     * one opened over it. Moved in one snapshot, so composition never sees
     * the entry leave the stack, which would clear its view model. Nothing
     * happens for a screen that is not on the stack.
     */
    fun raise(screen: Screen) {
        val stack = stack(screen.tab)
        val at = stack.indexOf(screen)
        if (at < 0) return
        if (screen == minimised) minimised = null
        if (screen.tab != tab) selectTab(screen.tab)
        if (at == stack.lastIndex) return
        Snapshot.withMutableSnapshot {
            stack.removeAt(at)
            stack.add(screen)
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
        // A minimised call stays: going back to the root is not hanging up.
        Snapshot.withMutableSnapshot {
            for (i in stack.lastIndex downTo 1) {
                if (stack[i] != minimised) stack.removeAt(i)
            }
        }
    }

    /**
     * Back. Pops the stack in front; at the root of a tab other than the
     * inbox, goes to the inbox — the start of the app. Returns false only at
     * the inbox's root, where Back leaves the app.
     */
    fun back(): Boolean {
        val stack = current
        // The last screen drawn, never a minimised call under it.
        val last = stack.indexOfLast { it != minimised }
        return when {
            last > 0 -> {
                stack.removeAt(last)
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

/**
 * The call screens opened in this process — the only ones a saved stack may
 * bring back. See [rememberNavigator].
 */
private val callsThisProcess = mutableSetOf<Screen>()

internal fun Screen.isCall(): Boolean = this is CallKey || this is IncomingCallKey || this is TeamCallKey

@Composable
fun rememberNavigator(currentTab: () -> AppTab, selectTab: (AppTab) -> Unit): Navigator {
    val inbox = rememberNavBackStack(InboxKey)
    // A call does not survive its process: the room, the microphone and the
    // ring are gone with it. Brought back by the saved stack after the system
    // killed the app in the background, a call screen would dial the visitor
    // again (CallRoute starts a call; IncomingCallKey(answer = true) answers
    // a ring long over; TeamCallKey rings a colleague again). One opened in
    // this process is still live — the stack
    // came back from a configuration change and its call with it — and stays.
    // Before anything composes the stack, so no call screen starts first.
    remember(inbox) { inbox.removeAll { (it as? Screen)?.isCall() == true && it !in callsThisProcess } }
    val contacts = rememberNavBackStack(ContactsKey)
    val visitors = rememberNavBackStack(VisitorsKey)
    val analytics = rememberNavBackStack(AnalyticsKey)
    val settings = rememberNavBackStack(SettingsKey)
    return remember(inbox, contacts, visitors, analytics, settings) {
        Navigator(
            stacks = mapOf(
                AppTab.INBOX to inbox,
                AppTab.CONTACTS to contacts,
                AppTab.VISITORS to visitors,
                AppTab.ANALYTICS to analytics,
                AppTab.SETTINGS to settings,
            ),
            currentTab = currentTab,
            selectTab = selectTab,
        )
    }
}
