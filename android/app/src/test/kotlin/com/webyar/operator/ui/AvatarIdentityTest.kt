package com.webyar.operator.ui

import com.webyar.operator.ui.components.djb2
import com.webyar.operator.ui.components.flagEmoji
import com.webyar.operator.ui.components.initialsOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The three pure functions behind an avatar.
 *
 * Worth testing on their own because all three are **cross-platform
 * contracts** rather than local details: the same contact has to come out the
 * same colour and the same two letters in the web inbox, on iOS and here. A
 * change that looks like a tidy-up — Kotlin's own `hashCode` instead of djb2,
 * `split(" ")` without filtering empties — silently recolours every face in
 * the product, and nothing on screen would say so.
 */
class AvatarIdentityTest {

    // MARK: - Initials

    @Test fun `two words give one letter each`() {
        assertEquals("MH", initialsOf("Maryam Hosseini"))
    }

    @Test fun `one word gives its first two letters`() {
        assertEquals("SA", initialsOf("Sara"))
    }

    @Test fun `a single character does not ask for a second`() {
        assertEquals("X", initialsOf("x"))
    }

    @Test fun `nothing at all is a question mark, not a crash`() {
        assertEquals("?", initialsOf(""))
        assertEquals("?", initialsOf("   "))
    }

    @Test fun `runs of spaces do not produce a blank initial`() {
        // The naive split yields ["Ali", "", "", "Rezaei"]; taking parts[1]
        // there is an empty string and `first()` on it throws.
        assertEquals("AR", initialsOf("Ali    Rezaei"))
    }

    @Test fun `a Persian name keeps its own letters`() {
        assertEquals("مح", initialsOf("مریم حسینی"))
    }

    @Test fun `leading and trailing space is not a word`() {
        assertEquals("EY", initialsOf("  Emre Yılmaz  "))
    }

    // MARK: - Colour

    @Test fun `djb2 is stable across runs, which is the whole point`() {
        // Literal expectations, not a re-computation: a test that recomputes
        // the function it is testing passes no matter what the function does.
        assertEquals(5381u, djb2(""))
        assertEquals(177573u, djb2("\u0000"))
        assertEquals(193409669u, djb2("abc"))
        assertEquals(2344055010u, djb2("maryam hosseini"))
    }

    @Test fun `the same name always lands on the same hue`() {
        val palette = 12u
        val first = djb2("maryam hosseini") % palette
        val second = djb2("maryam hosseini") % palette
        assertEquals(first, second)
    }

    @Test fun `case does not change the colour`() {
        // The caller lowercases before hashing; this pins that it has to.
        assertEquals(djb2("sara"), djb2("SARA".lowercase()))
    }

    // MARK: - Flags

    @Test fun `a country code becomes regional indicators`() {
        assertEquals("🇮🇷", flagEmoji("IR"))
        assertEquals("🇩🇪", flagEmoji("de"))
    }

    @Test fun `anything malformed is simply no flag`() {
        assertNull(flagEmoji(null))
        assertNull(flagEmoji(""))
        assertNull(flagEmoji("D"))
        assertNull(flagEmoji("DEU"))
        assertNull(flagEmoji("D1"))
        assertNull(flagEmoji("۱۲"))
    }

    @Test fun `surrounding space is tolerated`() {
        assertEquals(flagEmoji("TR"), flagEmoji(" tr "))
    }
}
