package com.webyar.operator.feature.call

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The operator's own picture in a video call: where it settles when let go,
 * and the sizes a double-tap and a pinch give it.
 */
class SelfViewTest {

    // A 400 × 800 screen whose free band runs from 200 to 700.
    private fun nearest(x: Float, y: Float) = SelfViewCorner.nearest(x, y, areaWidth = 400f, areaTop = 200f, areaBottom = 700f)

    @Test
    fun `let go, it settles in the corner of the quarter it is in`() {
        assertEquals(SelfViewCorner(left = true, top = true), nearest(100f, 300f))
        assertEquals(SelfViewCorner(left = false, top = true), nearest(300f, 300f))
        assertEquals(SelfViewCorner(left = true, top = false), nearest(100f, 600f))
        assertEquals(SelfViewCorner(left = false, top = false), nearest(300f, 600f))
    }

    /** The halfway line is the band's middle, not the screen's: 450 here, not 400. */
    @Test
    fun `up and down are halved within the free band`() {
        assertEquals(true, nearest(300f, 430f).top)
        assertEquals(false, nearest(300f, 470f).top)
    }

    @Test
    fun `it opens bottom right, above the buttons`() {
        assertEquals(SelfViewCorner(left = false, top = false), SelfViewCorner.DEFAULT)
    }

    @Test
    fun `the move action goes round all four corners`() {
        var c = SelfViewCorner.DEFAULT
        val seen = mutableSetOf(c)
        repeat(3) {
            c = c.next()
            seen += c
        }
        assertEquals(4, seen.size)
        assertEquals(SelfViewCorner.DEFAULT, c.next())
    }

    @Test
    fun `double-tap steps small, normal, large and round again`() {
        val small = SelfViewSize.next(SelfViewSize.DEFAULT + 60f)
        val normal = SelfViewSize.next(small)
        val large = SelfViewSize.next(normal)
        assertEquals(SelfViewSize.DEFAULT, normal, 0.01f)
        assertEquals(true, small < normal && normal < large)
        assertEquals(small, SelfViewSize.next(large), 0.01f)
        // From a pinched size in between, the next step up.
        assertEquals(SelfViewSize.DEFAULT, SelfViewSize.next(90f), 0.01f)
    }

    @Test
    fun `a pinch stays between a thumbnail and a large card`() {
        assertEquals(SelfViewSize.MIN, SelfViewSize.clamp(10f), 0.01f)
        assertEquals(SelfViewSize.MAX, SelfViewSize.clamp(900f), 0.01f)
        assertEquals(120f, SelfViewSize.clamp(120f), 0.01f)
    }
}
