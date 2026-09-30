package com.webyar.ai.feature.support

import com.webyar.ai.core.model.SupportHours
import com.webyar.ai.core.model.SupportInterval
import com.webyar.ai.i18n.Format
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.StrAndroid
import java.time.ZoneId

/**
 * The team's week as the offline banner reads it: days in a row that keep
 * the same hours are one line — «شنبه تا چهارشنبه ۹:۰۰ تا ۱۷:۰۰»,
 * «پنجشنبه ۹:۰۰ تا ۱۳:۰۰», «جمعه تعطیل».
 *
 * The times are the support workspace's own wall clock, exactly as it keeps
 * them; [zoneDiffers] says whether that clock needs naming on this phone.
 */
internal object SupportHoursText {

    /** The week Saturday first, as `/status` keys it and as the team's workweek runs. */
    val WEEK = listOf("sat", "sun", "mon", "tue", "wed", "thu", "fri")

    /** Days in a row with the same hours; no [intervals] is closed. */
    data class DayGroup(val first: String, val last: String, val intervals: List<SupportInterval>)

    fun groups(hours: SupportHours): List<DayGroup> {
        val groups = mutableListOf<DayGroup>()
        for (day in WEEK) {
            val intervals = hours.weekly[day].orEmpty()
                .filter { it.from.isNotBlank() && it.to.isNotBlank() }
                .sortedBy { it.from }
            val previous = groups.lastOrNull()
            if (previous != null && previous.intervals == intervals) {
                groups[groups.lastIndex] = previous.copy(last = day)
            } else {
                groups += DayGroup(day, day, intervals)
            }
        }
        // A week with no opening at all says nothing useful as seven closed days.
        return if (groups.all { it.intervals.isEmpty() }) emptyList() else groups
    }

    /**
     * One line per group. [time] turns a stored `HH:mm` into the reader's
     * digits; a test hands in its own, since the real one needs `android.icu`.
     */
    fun lines(
        hours: SupportHours,
        language: Language,
        time: (String) -> String = { Format.openingTime(it, language) },
    ): List<String> = groups(hours).map { group ->
        val first = StrAndroid.supportWeekday(language, group.first)
        val days = if (group.first == group.last) {
            first
        } else {
            StrAndroid.supportDayRange(language, first, StrAndroid.supportWeekday(language, group.last))
        }
        if (group.intervals.isEmpty()) {
            StrAndroid.supportClosedDays(language, days)
        } else {
            val times = group.intervals.joinToString(if (language == Language.FA) "، " else ", ") {
                StrAndroid.supportInterval(language, time(it.from), time(it.to))
            }
            StrAndroid.supportHoursLine(language, days, times)
        }
    }

    /**
     * Whether [timezone] keeps another clock than [device], and so has to be
     * named under the hours. An id nobody knows is named as it is.
     */
    fun zoneDiffers(timezone: String, device: ZoneId = ZoneId.systemDefault()): Boolean {
        if (timezone.isBlank()) return false
        val zone = runCatching { ZoneId.of(timezone) }.getOrNull() ?: return true
        return zone != device && zone.rules != device.rules
    }
}
