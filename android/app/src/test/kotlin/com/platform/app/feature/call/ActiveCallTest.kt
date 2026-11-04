package com.platform.app.feature.call

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

/**
 * Which calls a small window (picture-in-picture, the in-app bubble) is for,
 * and the window's shape.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ActiveCallTest {

    @Test
    fun `only a call placed or answered, and not over, goes into a small window`() {
        assertTrue(ActiveCallStage.OUTGOING.minimisable)
        assertTrue(ActiveCallStage.CONNECTING.minimisable)
        assertTrue(ActiveCallStage.LIVE.minimisable)
        // A ring is answered on its own full screen; a finished call has nothing to show.
        assertFalse(ActiveCallStage.RINGING_HERE.minimisable)
        assertFalse(ActiveCallStage.OVER.minimisable)
    }

    @Test
    fun `a colleague call's phases, as the small views see them`() {
        assertEquals(ActiveCallStage.OUTGOING, TeamCallPhase.Calling.activeStage(incoming = false))
        assertEquals(ActiveCallStage.OUTGOING, TeamCallPhase.Ringing.activeStage(incoming = false))
        assertEquals(ActiveCallStage.RINGING_HERE, TeamCallPhase.Ringing.activeStage(incoming = true))
        assertEquals(ActiveCallStage.CONNECTING, TeamCallPhase.Connecting.activeStage(incoming = true))
        assertEquals(ActiveCallStage.LIVE, TeamCallPhase.Live(Instant.EPOCH).activeStage(incoming = false))
        assertEquals(ActiveCallStage.OVER, TeamCallPhase.Ended(TeamCallEnd.HUNG_UP).activeStage(incoming = false))
    }

    @Test
    fun `a visitor's or a call-centre call's phases, as the small views see them`() {
        assertEquals(ActiveCallStage.RINGING_HERE, CallPhase.Ringing.activeStage())
        assertEquals(ActiveCallStage.OUTGOING, CallPhase.Waiting.activeStage())
        assertEquals(ActiveCallStage.CONNECTING, CallPhase.Connecting.activeStage())
        assertEquals(ActiveCallStage.LIVE, CallPhase.Connected.activeStage())
        assertEquals(ActiveCallStage.OVER, CallPhase.Ended(CallOutcome.HungUp).activeStage())
    }

    @Test
    fun `the window's shape stays inside what the system accepts`() {
        assertEquals(1.777, pipAspect(1280, 720).toDouble(), 0.01)
        assertEquals(0.5625, pipAspect(720, 1280).toDouble(), 0.01)
        // A sliver of a picture is refused by the system; it is clamped instead.
        assertTrue(pipAspect(4000, 100).toDouble() <= 2.39)
        assertTrue(pipAspect(100, 4000).toDouble() >= 1 / 2.39)
        // No picture yet: a voice call's shape.
        assertEquals(VOICE_PIP_ASPECT, pipAspect(0, 0))
    }
}
