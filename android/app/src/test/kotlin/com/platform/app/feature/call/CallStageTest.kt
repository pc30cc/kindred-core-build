package com.platform.app.feature.call

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which picture fills a video call's screen and which floats in the card,
 * before and after a tap on the card swaps them. Strings stand in for the
 * tracks: the rule is the same for any track.
 */
class CallStageTest {

    private val remote = "their camera"
    private val own = "my camera"

    @Test
    fun `normally the other side fills the screen and the member's own camera is the card`() {
        val stage = CallStage.of(remote, remoteMirror = false, own = own, ownMirror = true, swapped = false)

        assertEquals(StagePicture(remote, mirror = false), stage.big)
        assertTrue(stage.hasCard)
        assertEquals(StagePicture(own, mirror = true), stage.small)
        assertFalse(stage.swapped)
    }

    @Test
    fun `swapped, the member's own camera fills the screen and the other side is the card`() {
        val stage = CallStage.of(remote, remoteMirror = false, own = own, ownMirror = true, swapped = true)

        assertEquals(StagePicture(own, mirror = true), stage.big)
        assertTrue(stage.hasCard)
        assertEquals(StagePicture(remote, mirror = false), stage.small)
        assertTrue(stage.swapped)
    }

    /** A front camera is a mirror and a visitor's picture is flipped, full screen or small. */
    @Test
    fun `each picture keeps its own mirror wherever it is drawn`() {
        for (swapped in listOf(false, true)) {
            val visitorCall = CallStage.of(remote, remoteMirror = true, own = own, ownMirror = true, swapped = swapped)
            val backCamera = CallStage.of(remote, remoteMirror = false, own = own, ownMirror = false, swapped = swapped)
            for (stage in listOf(visitorCall, backCamera)) {
                val pictures = listOfNotNull(stage.big, stage.small)
                assertEquals(2, pictures.size)
                assertEquals(1, pictures.count { it.track == own })
                assertEquals(1, pictures.count { it.track == remote })
            }
            assertTrue(listOfNotNull(visitorCall.big, visitorCall.small).all { it.mirror })
            assertTrue(listOfNotNull(backCamera.big, backCamera.small).none { it.mirror })
        }
    }

    /** The card then shows their face on a dark tile: the screen draws a null picture that way. */
    @Test
    fun `swapped while the other side's camera is off, the card has no picture to show`() {
        val stage = CallStage.of(remote = null, remoteMirror = false, own = own, ownMirror = true, swapped = true)

        assertEquals(StagePicture(own, mirror = true), stage.big)
        assertTrue(stage.hasCard)
        assertNull(stage.small)
    }

    @Test
    fun `not swapped while the other side's camera is off, nothing fills the screen and the card is the member`() {
        val stage = CallStage.of(remote = null, remoteMirror = false, own = own, ownMirror = true, swapped = false)

        assertNull(stage.big)
        assertEquals(StagePicture(own, mirror = true), stage.small)
    }

    /** No own picture: no card, nothing to swap, and a swap still asked for is not shown. */
    @Test
    fun `without the member's own picture the stage is the normal one whatever was asked`() {
        for (swapped in listOf(false, true)) {
            val stage = CallStage.of(remote, remoteMirror = true, own = null, ownMirror = true, swapped = swapped)

            assertEquals(StagePicture(remote, mirror = true), stage.big)
            assertFalse(stage.hasCard)
            assertNull(stage.small)
            assertFalse(stage.swapped)
        }
        val empty = CallStage.of<String>(remote = null, remoteMirror = false, own = null, ownMirror = false, swapped = true)
        assertNull(empty.big)
        assertFalse(empty.hasCard)
    }
}
