package com.webyar.operator.core

import com.webyar.operator.core.model.DateParsing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The shapes this API's timestamps actually arrive in.
 *
 * Not a formality. `DateParsing` exists on iOS because Postgres writes however
 * many fractional digits a value needs and real rows in this database carry 3,
 * 5 and 6 — and a parser pinned to milliseconds drops the whole response when
 * it meets one of the others. These are those cases.
 */
class DateParsingTest {

    @Test fun `iso with milliseconds`() {
        assertNotNull(DateParsing.parse("2026-09-21T20:15:15.008+00:00"))
    }

    @Test fun `iso with six fractional digits, which is what Postgres writes`() {
        assertNotNull(DateParsing.parse("2026-09-21T20:15:15.008353+00:00"))
    }

    @Test fun `iso with five fractional digits`() {
        assertNotNull(DateParsing.parse("2026-09-21T20:15:15.00835+00:00"))
    }

    @Test fun `iso with no fraction at all`() {
        assertNotNull(DateParsing.parse("2026-09-21T20:15:15+00:00"))
    }

    @Test fun `Z rather than an explicit offset`() {
        assertNotNull(DateParsing.parse("2026-09-21T20:15:15.008Z"))
    }

    @Test fun `the space-separated form Postgres emits outside the API encoder`() {
        assertNotNull(DateParsing.parse("2026-09-21 20:15:15.008353+00:00"))
    }

    @Test fun `all spellings of one instant agree`() {
        val withZ = DateParsing.parse("2026-09-21T20:15:15Z")
        val withOffset = DateParsing.parse("2026-09-21T20:15:15+00:00")
        val spaced = DateParsing.parse("2026-09-21 20:15:15+00:00")
        assertEquals(withZ, withOffset)
        assertEquals(withZ, spaced)
    }

    @Test fun `a non-zero offset is honoured, not ignored`() {
        val tehran = DateParsing.parse("2026-09-21T23:45:15+03:30")
        val utc = DateParsing.parse("2026-09-21T20:15:15Z")
        assertEquals(utc, tehran)
    }

    @Test fun `nonsense is null rather than an exception`() {
        assertNull(DateParsing.parse("not a date"))
        assertNull(DateParsing.parse(""))
        assertNull(DateParsing.parse("   "))
    }
}
