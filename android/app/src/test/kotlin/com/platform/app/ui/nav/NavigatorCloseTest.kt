package com.platform.app.ui.nav

import androidx.navigation3.runtime.NavBackStack
import androidx.navigation3.runtime.NavKey
import com.platform.app.ui.AppTab
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A colleague call's screen closes itself — Done, or on its own once the
 * call is over — with [Navigator.close]: that screen, never whatever has
 * come over it since.
 */
class NavigatorCloseTest {
    private val inbox = NavBackStack<NavKey>(InboxKey)
    private val navigator = Navigator(
        stacks = AppTab.entries.associateWith { tab -> if (tab == AppTab.INBOX) inbox else NavBackStack<NavKey>(tab.root) },
        currentTab = { AppTab.INBOX },
        selectTab = {},
    )

    private val call = TeamCallKey(workspaceId = "ws-1", peerId = "u-2", peerName = "Daniel", channel = "audio", callId = "c-1")
    private val ring = TeamCallKey(workspaceId = "ws-1", peerId = "u-3", peerName = "Sara", channel = "video", callId = "c-2")

    @Test
    fun `an ended call closes its own screen, not the one now over it`() {
        navigator.open(TeamThreadKey("u-2"))
        navigator.open(call)
        // Another ring came over the call that is ending.
        inbox.add(ring)

        assertTrue(navigator.close(call))
        assertEquals(listOf(InboxKey, TeamThreadKey("u-2"), ring), inbox.toList())
    }

    @Test
    fun `closing twice is closing once, and a root is never closed`() {
        navigator.open(call)
        assertTrue(navigator.close(call))
        assertFalse(navigator.close(call))
        assertFalse(navigator.close(InboxKey))
        assertEquals(listOf<NavKey>(InboxKey), inbox.toList())
    }

    @Test
    fun `a minimised call that closes is no longer minimised`() {
        navigator.open(call)
        navigator.minimise(call)
        assertTrue(navigator.close(call))
        assertNull(navigator.minimised)
    }
}
