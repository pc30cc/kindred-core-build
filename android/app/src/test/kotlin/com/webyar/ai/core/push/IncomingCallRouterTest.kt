package com.webyar.ai.core.push

import com.webyar.ai.core.Diag
import com.webyar.ai.core.model.CallChannel
import com.webyar.ai.i18n.Language
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A call-centre ring, read and routed whatever state the app is in. */
class IncomingCallRouterTest {

    private val rung = mutableListOf<IncomingCall>()
    private val stopped = mutableListOf<CallCancel>()
    private var account: String? = "user-a"

    private fun router(now: Long = 1_000) = IncomingCallRouter(
        signedInAccount = { account },
        language = { Language.FA },
        ring = { call, _ -> rung += call },
        stop = { cancel, _ -> stopped += cancel },
        nowEpochSeconds = { now },
        diag = Diag.Silent,
    )

    private val ring = mapOf(
        "type" to "call_incoming",
        "callId" to "call-1",
        "workspaceId" to "ws-1",
        "channel" to "video",
        "caller" to "Sara",
        "workspaceName" to "Webyar",
        "expiresAt" to "1045",
    )

    @Test
    fun `a ring rings, with who is calling and how`() = runTest {
        assertTrue(router().onMessage(ring))

        val call = rung.single()
        assertEquals("call-1", call.callId)
        assertEquals("ws-1", call.workspaceId)
        assertEquals(CallChannel.VIDEO, call.channel)
        assertEquals("Sara", call.caller)
        assertEquals(1045L, call.expiresAt)
    }

    @Test
    fun `a ring past its expiry is not a call any more`() = runTest {
        assertTrue(router(now = 1_045).onMessage(ring))
        assertTrue(rung.isEmpty())
    }

    /** A phone somebody signed out of must not show a caller to whoever holds it next. */
    @Test
    fun `nobody signed in, nothing rings`() = runTest {
        account = null
        assertTrue(router().onMessage(ring))
        assertTrue(rung.isEmpty())
    }

    @Test
    fun `a cancel stops the ring, signed in or not`() = runTest {
        account = null
        val cancel = mapOf("type" to "call_cancel", "callId" to "call-1", "workspaceId" to "ws-1", "reason" to "answered")

        assertTrue(router().onMessage(cancel))

        assertEquals(CallCancel("call-1", "ws-1", CallCancel.Reason.ANSWERED), stopped.single())
    }

    @Test
    fun `only a caller who gave up, or nobody came for, counts as missed`() {
        assertTrue(CallCancel.Reason.CANCELLED.missed)
        assertTrue(CallCancel.Reason.TIMEOUT.missed)
        assertFalse(CallCancel.Reason.ANSWERED.missed)
        assertFalse(CallCancel.Reason.DECLINED.missed)
    }

    @Test
    fun `anything that is not a call is left for the message router`() = runTest {
        assertFalse(router().onMessage(mapOf("type" to "new_message", "workspaceId" to "ws-1", "conversationId" to "c-1")))
        assertFalse(router().onMessage(emptyMap()))
    }

    @Test
    fun `ids are checked before they are used`() = runTest {
        assertTrue(router().onMessage(ring + ("callId" to "../../x")))
        assertTrue(rung.isEmpty())
        assertNull(IncomingCall.from(ring - "expiresAt"))
    }

    @Test
    fun `a caller with no name still rings, to be named on the phone`() = runTest {
        router().onMessage(ring - "caller")
        assertEquals("", rung.single().caller)
    }
}
