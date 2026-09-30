package com.webyar.ai.feature.support

import com.webyar.ai.core.model.SupportHours
import com.webyar.ai.core.model.SupportInterval
import com.webyar.ai.i18n.Language
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/**
 * The team's week in the offline banner: days in a row with the same hours
 * are one line, a day with none is closed, and the clock is named only when
 * it is not this phone's.
 *
 * Plain JUnit: the digits are handed in as they are stored — the real ones
 * come from `android.icu`, which the unmocked android.jar throws from.
 */
class SupportHoursTest {

    private val nineToFive = listOf(SupportInterval("09:00", "17:00"))

    /** The sample team's week: Saturday to Wednesday, a short Thursday, Friday off. */
    private val week = SupportHours(
        timezone = "Asia/Tehran",
        weekly = mapOf(
            "sat" to nineToFive, "sun" to nineToFive, "mon" to nineToFive, "tue" to nineToFive, "wed" to nineToFive,
            "thu" to listOf(SupportInterval("09:00", "13:00")),
        ),
    )

    private fun lines(hours: SupportHours, language: Language) = SupportHoursText.lines(hours, language) { it }

    @Test
    fun `days in a row with the same hours are one line`() {
        assertEquals(
            listOf(
                SupportHoursText.DayGroup("sat", "wed", nineToFive),
                SupportHoursText.DayGroup("thu", "thu", listOf(SupportInterval("09:00", "13:00"))),
                SupportHoursText.DayGroup("fri", "fri", emptyList()),
            ),
            SupportHoursText.groups(week),
        )
    }

    @Test
    fun `the week reads in Persian as a sign on the door would`() {
        assertEquals(
            listOf("شنبه تا چهارشنبه 09:00 تا 17:00", "پنجشنبه 09:00 تا 13:00", "جمعه تعطیل"),
            lines(week, Language.FA),
        )
    }

    @Test
    fun `and in English and Turkish`() {
        assertEquals(
            listOf("Saturday–Wednesday: 09:00–17:00", "Thursday: 09:00–13:00", "Friday: closed"),
            lines(week, Language.EN),
        )
        assertEquals(
            listOf("Cumartesi–Çarşamba: 09:00–17:00", "Perşembe: 09:00–13:00", "Cuma: kapalı"),
            lines(week, Language.TR),
        )
    }

    /** Only neighbours fold: Saturday and Monday alike, Sunday not, are three lines. */
    @Test
    fun `the same hours on days apart are not folded together`() {
        val hours = SupportHours(
            timezone = "Asia/Tehran",
            weekly = mapOf(
                "sat" to nineToFive,
                "sun" to listOf(SupportInterval("10:00", "12:00")),
                "mon" to nineToFive,
            ),
        )

        assertEquals(
            listOf("sat", "sun", "mon", "tue"),
            SupportHoursText.groups(hours).map { it.first },
        )
        // Tuesday to Friday, all closed, are one.
        assertEquals("fri", SupportHoursText.groups(hours).last().last)
    }

    /** A split day lists both openings, earliest first, whatever order they came in. */
    @Test
    fun `a day with a break lists both openings in order`() {
        val hours = SupportHours(
            timezone = "Asia/Tehran",
            weekly = mapOf("sat" to listOf(SupportInterval("14:00", "18:00"), SupportInterval("08:00", "12:00"))),
        )

        assertEquals("Saturday: 08:00–12:00, 14:00–18:00", lines(hours, Language.EN).first())
        assertEquals("شنبه 08:00 تا 12:00، 14:00 تا 18:00", lines(hours, Language.FA).first())
    }

    @Test
    fun `a week with no opening at all says nothing`() {
        assertTrue(SupportHoursText.lines(SupportHours("Asia/Tehran", emptyMap()), Language.FA) { it }.isEmpty())
        assertTrue(
            SupportHoursText.groups(SupportHours("Asia/Tehran", mapOf("sat" to emptyList()))).isEmpty(),
        )
    }

    @Test
    fun `the clock is named only when it is not this phone's`() {
        assertFalse(SupportHoursText.zoneDiffers("Asia/Tehran", ZoneId.of("Asia/Tehran")))
        // Another name for the same clock is the same clock.
        assertFalse(SupportHoursText.zoneDiffers("Iran", ZoneId.of("Asia/Tehran")))
        assertTrue(SupportHoursText.zoneDiffers("Asia/Tehran", ZoneId.of("Europe/Istanbul")))
        // An id nobody knows is named as it is; none at all, not at all.
        assertTrue(SupportHoursText.zoneDiffers("Mars/Olympus", ZoneId.of("Asia/Tehran")))
        assertFalse(SupportHoursText.zoneDiffers("", ZoneId.of("Asia/Tehran")))
    }
}
