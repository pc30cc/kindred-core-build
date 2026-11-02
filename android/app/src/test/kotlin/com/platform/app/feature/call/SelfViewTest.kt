package com.platform.app.feature.call

import androidx.compose.ui.geometry.Offset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The small picture in a video call: where it settles when let go, the sizes
 * a double-tap and a pinch give it, and the band it keeps to.
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

    // MARK: - The band it keeps to

    /**
     * An 800 × 1600 px screen at 2 px a dp: the band runs from 324 to 1276
     * (the name and the buttons with the 12 dp margin taken off), and 24 px
     * in from either side.
     */
    private fun band(top: Float = 324f, bottom: Float = 1276f) = SelfViewGeometry(
        areaWidth = 800f,
        areaHeight = 1600f,
        left = 24f,
        right = 776f,
        top = top,
        bottom = bottom,
        density = 2f,
    )

    @Test
    fun `each corner is inside the band, left and right as the glass has them`() {
        val g = band()
        // 108 dp wide is 216 × 288 px.
        assertEquals(Offset(24f, 324f), g.target(SelfViewCorner(left = true, top = true), SelfViewSize.DEFAULT))
        assertEquals(Offset(560f, 324f), g.target(SelfViewCorner(left = false, top = true), SelfViewSize.DEFAULT))
        assertEquals(Offset(24f, 988f), g.target(SelfViewCorner(left = true, top = false), SelfViewSize.DEFAULT))
        assertEquals(Offset(560f, 988f), g.target(SelfViewCorner(left = false, top = false), SelfViewSize.DEFAULT))
    }

    @Test
    fun `in a band lower than the card it is drawn smaller, and still clear of the buttons`() {
        // 200 px of band holds a card 150 px wide: 75 dp.
        val g = band(top = 324f, bottom = 524f)
        assertEquals(75f, g.shownWidth(SelfViewSize.DEFAULT), 0.01f)
        // Asked for less than fits, it is drawn as asked.
        assertEquals(70f, g.shownWidth(70f), 0.01f)
        for (corner in listOf(SelfViewCorner(true, true), SelfViewCorner(true, false))) {
            val at = g.target(corner, SelfViewSize.DEFAULT)
            assertEquals(324f, at.y, 0.01f)
            assertTrue(at.y + 200f <= 524f + 0.01f)
        }
    }

    /** Over the name rather than the buttons: the buttons are what a finger is on its way to. */
    @Test
    fun `too low a band even for the smallest card, it gives way upwards`() {
        val g = band(top = 324f, bottom = 424f)
        assertEquals(SelfViewSize.MIN, g.shownWidth(SelfViewSize.DEFAULT), 0.01f)
        val h = SelfViewSize.MIN * 2f * 4f / 3f
        for (corner in listOf(SelfViewCorner(false, true), SelfViewCorner(false, false))) {
            val at = g.target(corner, SelfViewSize.DEFAULT)
            assertEquals(424f, at.y + h, 0.01f)
        }
    }

    /**
     * A phone on its side: a band that draws the card at 120 dp at most. The
     * step up from what is drawn would draw nothing larger, so a double-tap
     * that only asked for it would do nothing, time after time.
     */
    @Test
    fun `in a low band a double-tap still goes round, to the smallest when nothing larger fits`() {
        val small = SelfViewSize.next(SelfViewSize.MAX)
        val g = band(top = 324f, bottom = 644f)
        assertEquals(120f, g.shownWidth(150f), 0.01f)

        // Large asked for, 120 drawn: round to the smallest.
        assertEquals(small, g.nextStep(150f), 0.01f)
        // Then up again, each step drawing larger than the last.
        val normal = g.nextStep(small)
        assertEquals(SelfViewSize.DEFAULT, normal, 0.01f)
        val large = g.nextStep(normal)
        assertTrue(g.shownWidth(large) > g.shownWidth(normal))
        assertEquals(small, g.nextStep(large), 0.01f)

        // A band with room for every step goes round as it always has.
        val tall = band()
        for (w in listOf(small, SelfViewSize.DEFAULT, 150f, 90f)) {
            assertEquals(SelfViewSize.next(w), tall.nextStep(w), 0.01f)
        }
    }

    @Test
    fun `dragged, it goes anywhere on the screen and no further`() {
        val g = band()
        assertEquals(Offset(0f, 0f), g.clamp(Offset(-50f, -50f), SelfViewSize.DEFAULT))
        assertEquals(Offset(800f - 216f, 1600f - 288f), g.clamp(Offset(5000f, 5000f), SelfViewSize.DEFAULT))
        assertEquals(Offset(300f, 700f), g.clamp(Offset(300f, 700f), SelfViewSize.DEFAULT))
    }
}
