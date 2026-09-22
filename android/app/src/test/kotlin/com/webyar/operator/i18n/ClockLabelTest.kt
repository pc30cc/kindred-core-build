package com.webyar.operator.i18n

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * How a quiet-hours time reads back.
 *
 * The thing this has to protect is narrow and easy to break: the value is
 * what the operator chose and what the server stores, so 22:00 has to read
 * as twenty-two o'clock in every language. Only the digits change. A locale
 * time format would show it as 10:00 PM in English, and somebody comparing
 * the app against the console would reasonably conclude one of them was
 * wrong.
 */
class ClockLabelTest {

    @Test
    fun `English reads the stored value back unchanged`() {
        assertEquals("22:00", Format.clockLabel("22:00", Language.EN))
        assertEquals("07:00", Format.clockLabel("07:00", Language.EN))
        assertEquals("00:30", Format.clockLabel("00:30", Language.EN))
    }

    @Test
    fun `Persian changes the digits and nothing else`() {
        assertEquals("۲۲:۰۰", Format.clockLabel("22:00", Language.FA))
        assertEquals("۰۷:۰۰", Format.clockLabel("07:00", Language.FA))
        assertEquals("۲۳:۵۹", Format.clockLabel("23:59", Language.FA))
    }

    @Test
    fun `Turkish uses Latin digits like the console does`() {
        assertEquals("22:00", Format.clockLabel("22:00", Language.TR))
    }

    /** Both fields stay two digits, in the locale's own zero. */
    @Test
    fun `single digits are padded`() {
        assertEquals("09:05", Format.clockLabel("09:05", Language.EN))
        assertEquals("۰۹:۰۵", Format.clockLabel("09:05", Language.FA))
    }

    /**
     * A malformed value comes back untouched. The server enforces
     * `^([01]\d|2[0-3]):[0-5]\d$`, so anything else is a bug somewhere —
     * inventing a time for it would hide that rather than show it.
     */
    @Test
    fun `anything that is not a time is left alone`() {
        Language.entries.forEach { language ->
            assertEquals("", Format.clockLabel("", language))
            assertEquals("2200", Format.clockLabel("2200", language))
            assertEquals("late", Format.clockLabel("late", language))
            assertEquals("24:00", Format.clockLabel("24:00", language))
            assertEquals("12:60", Format.clockLabel("12:60", language))
            assertEquals("-1:00", Format.clockLabel("-1:00", language))
            assertEquals("10:00:00", Format.clockLabel("10:00:00", language))
        }
    }
}
