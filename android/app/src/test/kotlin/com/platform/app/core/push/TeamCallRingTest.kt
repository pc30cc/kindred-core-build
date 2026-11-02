package com.platform.app.core.push

import com.platform.app.core.Diag
import com.platform.app.core.model.CallChannel
import com.platform.app.i18n.Language
import com.platform.app.i18n.Str
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A colleague's ring and its stop, as the server sends them
 * (docs/operations/TEAM_CALLS.md, "Ring and its stop"), read and routed
 * whatever state the app is in.
 */
class TeamCallRingTest {

    private val rung = mutableListOf<TeamCallRing>()
    private val stopped = mutableListOf<TeamCallCancel>()
    private var account: String? = "user-a"

    private fun router(now: Long = 1_000) = IncomingCallRouter(
        signedInAccount = { account },
        language = { Language.FA },
        ring = { _, _ -> error("a colleague's ring is not the call centre's") },
        stop = { _, _ -> error("a colleague's cancel is not the call centre's") },
        ringColleague = { ring, _ -> rung += ring },
        stopColleague = { cancel, _ -> stopped += cancel },
        nowEpochSeconds = { now },
        diag = Diag.Silent,
    )

    /** `teamCallAndroidRingData` in server/services/push/teamCallRing.ts. */
    private val ring = mapOf(
        "type" to "team_call_incoming",
        "callId" to "9d6c1f0e-5a43-4c51-9b55-1a1b2c3d4e5f",
        "workspaceId" to "ws-1",
        "workspaceName" to "Webyar",
        "channel" to "video",
        "callerName" to "Daniel Carter",
        "callerAvatarUrl" to "https://cdn.example.org/a/u-2.jpg?sig=x",
        "callerUserId" to "u-2",
        "expiresAt" to "1045",
    )

    @Test
    fun `a colleague's ring rings, with who is calling, how, and their photo`() = runTest {
        assertTrue(router().onMessage(ring))

        val call = rung.single()
        assertEquals("9d6c1f0e-5a43-4c51-9b55-1a1b2c3d4e5f", call.callId)
        assertEquals("ws-1", call.workspaceId)
        assertEquals("Webyar", call.workspaceName)
        assertEquals(CallChannel.VIDEO, call.channel)
        assertEquals("Daniel Carter", call.callerName)
        assertEquals("https://cdn.example.org/a/u-2.jpg?sig=x", call.callerAvatarUrl)
        assertEquals("u-2", call.callerUserId)
        assertEquals(1045L, call.expiresAt)
    }

    @Test
    fun `a ring past its expiry is not a call any more`() = runTest {
        assertTrue(router(now = 1_045).onMessage(ring))
        assertTrue(rung.isEmpty())
    }

    @Test
    fun `nobody signed in, nothing rings`() = runTest {
        account = null
        assertTrue(router().onMessage(ring))
        assertTrue(rung.isEmpty())
    }

    /** The call-centre ring's own clock correction: see IncomingCallRouterTest. */
    @Test
    fun `a phone clock set fast still rings, for the ring's life`() = runTest {
        assertTrue(router(now = 1_300).onMessage(ring, sentAtMillis = 1_000_000))
        assertEquals(1_345L, rung.single().expiresAt)
    }

    @Test
    fun `a phone clock set slow rings for the ring's life, not an hour`() = runTest {
        assertTrue(router(now = 1_000L - 3_600).onMessage(ring, sentAtMillis = 1_000_000))
        assertEquals(1_000L - 3_600 + 45, rung.single().expiresAt)
    }

    @Test
    fun `a cancel stops the ring, signed in or not, with its reason`() = runTest {
        account = null
        val cancel = mapOf("type" to "team_call_cancel", "callId" to "call-1", "reason" to "answered_elsewhere")

        assertTrue(router().onMessage(cancel))

        assertEquals(TeamCallCancel("call-1", TeamCallCancel.Reason.ANSWERED_ELSEWHERE), stopped.single())
    }

    @Test
    fun `every reason the server sends is read, and an unknown one as ended`() {
        fun reason(wire: String) =
            TeamCallCancel.from(mapOf("type" to "team_call_cancel", "callId" to "call-1", "reason" to wire))?.reason
        assertEquals(TeamCallCancel.Reason.ANSWERED_ELSEWHERE, reason("answered_elsewhere"))
        assertEquals(TeamCallCancel.Reason.DECLINED, reason("declined"))
        assertEquals(TeamCallCancel.Reason.CANCELLED, reason("cancelled"))
        assertEquals(TeamCallCancel.Reason.MISSED, reason("missed"))
        assertEquals(TeamCallCancel.Reason.ENDED, reason("ended"))
        assertEquals(TeamCallCancel.Reason.ENDED, reason("something_new"))
    }

    /**
     * The doc: a caller who gave up, or a ring nobody answered, leaves the
     * missed-call notification; answered or declined on another phone does not.
     */
    @Test
    fun `only a caller who gave up, or a ring that ran out, is missed`() {
        assertTrue(TeamCallCancel.Reason.CANCELLED.missed)
        assertTrue(TeamCallCancel.Reason.MISSED.missed)
        assertFalse(TeamCallCancel.Reason.ANSWERED_ELSEWHERE.missed)
        assertFalse(TeamCallCancel.Reason.DECLINED.missed)
        assertFalse(TeamCallCancel.Reason.ENDED.missed)
    }

    @Test
    fun `a call-centre ring still goes to the call centre's side`() = runTest {
        var callCentre = 0
        val router = IncomingCallRouter(
            signedInAccount = { account },
            language = { Language.FA },
            ring = { _, _ -> callCentre++ },
            stop = { _, _ -> },
            ringColleague = { ring, _ -> rung += ring },
            stopColleague = { cancel, _ -> stopped += cancel },
            nowEpochSeconds = { 1_000 },
            diag = Diag.Silent,
        )
        router.onMessage(ring + ("type" to "call_incoming") + ("caller" to "Sara"))
        assertEquals(1, callCentre)
        assertTrue(rung.isEmpty())
    }

    @Test
    fun `ids are checked before they are used`() = runTest {
        assertTrue(router().onMessage(ring + ("callId" to "../../x")))
        assertTrue(router().onMessage(ring + ("callerUserId" to "u 2")))
        assertTrue(rung.isEmpty())
        assertNull(TeamCallRing.from(ring - "expiresAt"))
        assertNull(TeamCallRing.from(ring - "callerUserId"))
        assertNull(TeamCallCancel.from(mapOf("type" to "team_call_cancel", "callId" to "a/b")))
    }

    /** A photo is the server's signed https link, or none: never another scheme to go and read. */
    @Test
    fun `only an https photo is taken`() {
        assertNull(TeamCallRing.from(ring + ("callerAvatarUrl" to "file:///data/data/x"))?.callerAvatarUrl)
        assertNull(TeamCallRing.from(ring + ("callerAvatarUrl" to "http://cdn.example.org/a.jpg"))?.callerAvatarUrl)
        assertNull(TeamCallRing.from(ring - "callerAvatarUrl")?.callerAvatarUrl)
    }

    /** A colleague with no profile name is "Colleague" — never a letter, never an address. */
    @Test
    fun `a caller with no name still rings, named as a colleague`() = runTest {
        router().onMessage(ring - "callerName")
        val call = rung.single()
        assertEquals("", call.callerName)
        assertEquals(Str.teamCallColleague(Language.FA), call.displayName(Language.FA))
    }
}
