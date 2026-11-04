package com.platform.app.feature.call

import com.platform.app.i18n.Language
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The ongoing-call service holds every call in progress, not just the last
 * one shown: a call-centre call answered (or a colleague call picked up) on
 * top of a live visitor call, then ended, must not stop the service under
 * the visitor call, whose microphone Android would silence with the app
 * behind (review of #408).
 */
class OngoingCallsTest {

    private fun call(id: String, video: Boolean = false, name: String = id) = OngoingCall(
        callId = id,
        peerName = name,
        peerAvatarUrl = null,
        video = video,
        language = Language.DEFAULT,
        kind = OngoingCallKind.VISITOR,
    )

    @Test
    fun `the end of a second call leaves the first one its service`() {
        val calls = OngoingCalls()
        calls.put(call("visitor"))
        calls.put(call("center"))
        assertEquals("center", calls.newest?.callId)

        assertTrue(calls.remove("center"))
        assertFalse(calls.isEmpty)
        assertEquals("visitor", calls.newest?.callId)

        assertTrue(calls.remove("visitor"))
        assertTrue(calls.isEmpty)
        assertNull(calls.newest)
    }

    @Test
    fun `the end of the first call leaves the second one shown`() {
        val calls = OngoingCalls()
        calls.put(call("visitor"))
        calls.put(call("team"))
        assertTrue(calls.remove("visitor"))
        assertEquals("team", calls.newest?.callId)
    }

    @Test
    fun `an update of an older call keeps the newest one in the notification`() {
        val calls = OngoingCalls()
        calls.put(call("visitor"))
        calls.put(call("center"))
        calls.put(call("visitor", name = "Nia"))
        assertEquals("center", calls.newest?.callId)
        assertEquals(listOf("visitor", "center"), calls.snapshot().map { it.callId })
        assertEquals("Nia", calls.snapshot().first().peerName)
    }

    @Test
    fun `the camera stays while any call held has it on`() {
        val calls = OngoingCalls()
        calls.put(call("visitor", video = true))
        calls.put(call("center"))
        assertTrue(calls.video)
        calls.remove("visitor")
        assertFalse(calls.video)
    }

    @Test
    fun `a stop for a call not held changes nothing`() {
        val calls = OngoingCalls()
        calls.put(call("visitor"))
        assertFalse(calls.remove("other"))
        assertFalse(calls.remove(null))
        assertEquals("visitor", calls.newest?.callId)
    }

    @Test
    fun `a refused start is undone without touching the calls before it`() {
        val calls = OngoingCalls()
        calls.put(call("visitor", video = false))
        val before = calls.snapshot()
        calls.put(call("visitor", video = true))
        calls.put(call("center"))
        calls.restore(before)
        assertEquals(listOf("visitor"), calls.snapshot().map { it.callId })
        assertFalse(calls.video)
    }
}
