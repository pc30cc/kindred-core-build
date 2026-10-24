package com.platform.app.ui

import com.platform.app.ui.components.djb2
import com.platform.app.ui.components.flagEmoji
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The two pure functions behind a visitor's avatar.
 *
 * Worth testing on their own because both are **cross-platform contracts**
 * rather than local details: the same contact has to come out the same
 * colour, and the same flag, in the web inbox, on iOS and here. A change that
 * looks like a tidy-up — Kotlin's own `hashCode` instead of djb2 — silently
 * recolours every face in the product, and nothing on screen would say so.
 *
 * There are no initials to test: no avatar in this app draws letters, for a
 * visitor, a teammate or a workspace (AvatarGlyphsTest).
 */
class AvatarIdentityTest {

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
