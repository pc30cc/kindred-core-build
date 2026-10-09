package com.webyar.ai.feature.analytics

import android.icu.text.DateFormat
import android.icu.text.NumberFormat
import android.icu.util.TimeZone
import android.icu.util.ULocale
import com.webyar.ai.core.model.AnalyticsDay
import com.webyar.ai.i18n.Format
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.StrAndroid
import com.webyar.ai.i18n.StrInsights
import com.webyar.ai.ui.components.countryMarkOf
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * Numbers, shares, durations and days the way each language writes them —
 * the Mac app's `AnalyticsFormat`. Persian gets its own digits and, for the
 * chart's days, the brand's calendar: the Persian one for WebYar, Gregorian
 * for RESPOK — the same as every other date in the app ([Format.calendarTag]).
 */
object AnalyticsFormat {

    private fun locale(l: Language): ULocale = ULocale(Format.calendarTag(l))

    private val counts = ConcurrentHashMap<Language, NumberFormat>()
    private val decimals = ConcurrentHashMap<Language, NumberFormat>()

    /** "12,480": a report's numbers are measurements, so they keep the grouping. */
    fun count(n: Int, l: Language): String {
        val f = counts.getOrPut(l) { NumberFormat.getIntegerInstance(locale(l)).apply { isGroupingUsed = true } }
        return synchronized(f) { f.format(n.toLong()) }
    }

    fun decimal(v: Double, l: Language): String {
        val f = decimals.getOrPut(l) {
            NumberFormat.getInstance(locale(l)).apply {
                minimumFractionDigits = 1
                maximumFractionDigits = 1
            }
        }
        return synchronized(f) { f.format(v) }
    }

    /** [fraction] is 0–1; below a tenth it keeps one decimal, so 4.5% is not "5%". */
    fun percent(fraction: Double, l: Language): String {
        val f = NumberFormat.getPercentInstance(locale(l)).apply {
            maximumFractionDigits = if (fraction > 0 && fraction < 0.1) 1 else 0
        }
        return f.format(fraction)
    }

    /**
     * "2 m 14 s", "38 s" under a minute, and "4 h 0 m" from an hour up — the
     * seconds dropped where they no longer say anything and would not fit a
     * phone's half-width tile.
     */
    fun duration(seconds: Double, l: Language): String {
        val total = maxOf(0, Math.round(seconds).toInt())
        val h = total / 3600
        val m = total % 3600 / 60
        val s = total % 60
        return when {
            h > 0 -> count(h, l) + " " + StrAndroid.waHours(l) + " " + count(m, l) + " " + StrInsights.waMinutes(l)
            m > 0 -> count(m, l) + " " + StrInsights.waMinutes(l) + " " + count(s, l) + " " + StrInsights.waSeconds(l)
            else -> count(s, l) + " " + StrInsights.waSeconds(l)
        }
    }

    /**
     * Every day from [start] to [end], the days the server has no row for at
     * zero — so the chart's days are the range's days, spaced as the calendar
     * spaces them, rather than only the days something happened.
     */
    fun fillDays(trend: List<AnalyticsDay>, start: String, end: String): List<AnalyticsDay> {
        val from = day(start) ?: return trend
        val to = day(end) ?: return trend
        if (to.isBefore(from)) return trend
        val known = trend.associateBy { it.date }
        return generateSequence(from) { it.plusDays(1) }
            .takeWhile { !it.isAfter(to) }
            .map { d -> known[d.toString()] ?: AnalyticsDay(d.toString(), 0, 0) }
            .toList()
    }

    /** The server's YYYY-MM-DD, a UTC day. */
    fun day(text: String): LocalDate? = runCatching { LocalDate.parse(text) }.getOrNull()

    private val dayFormats = ConcurrentHashMap<String, DateFormat>()

    /** "12 Mehr" / "4 Oct" on the axis; "Friday 4 October" in the callout. */
    fun dayLabel(date: LocalDate, l: Language, long: Boolean = false): String {
        val skeleton = if (long) "EEEEdMMMM" else "dMMM"
        val f = dayFormats.getOrPut("$skeleton|${l.code}") {
            DateFormat.getPatternInstance(skeleton, locale(l)).apply { timeZone = TimeZone.getTimeZone("UTC") }
        }
        val millis = date.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
        return synchronized(f) { f.format(java.util.Date(millis)) }
    }

    /** A channel's key ("organic_search") in the reader's language. */
    fun channel(key: String, l: Language): String = StrInsights.waChannelOf(key, l) ?: key

    /** "mobile" → "Mobile", in the reader's language. */
    fun device(key: String, l: Language): String = StrInsights.waDeviceOf(key.lowercase(), l) ?: key

    /** The server's "(unknown)" bucket, in the reader's language. */
    fun unknown(label: String?, l: Language): String =
        if (label.isNullOrBlank() || label == "(unknown)") StrInsights.waUnknown(l) else label

    /**
     * The country the server names in English, in the reader's language and
     * with its flag.
     */
    fun country(name: String, l: Language): Pair<String?, String> {
        val code = countryCodes[name.trim().lowercase()] ?: return null to name
        val local = ULocale("", code).getDisplayCountry(locale(l)).takeIf { it.isNotBlank() && it != code } ?: name
        return countryMarkOf(code) to local
    }

    private val countryCodes: Map<String, String> by lazy {
        val map = HashMap<String, String>()
        for (code in Locale.getISOCountries()) {
            val name = Locale("", code).getDisplayCountry(Locale.US)
            if (name.isNotBlank()) map[name.lowercase()] = code
        }
        // The names the geo databases use where they differ from the JDK's.
        mapOf(
            "iran" to "IR", "russia" to "RU", "south korea" to "KR", "united states" to "US",
            "united kingdom" to "GB", "turkey" to "TR", "türkiye" to "TR", "czech republic" to "CZ",
            "czechia" to "CZ", "vietnam" to "VN", "syria" to "SY", "hong kong" to "HK",
        ).forEach { (k, v) -> map[k] = v }
        map
    }

    /** "fa-IR" → "Persian (Iran)", in the reader's language. */
    fun language(tag: String, l: Language): String =
        runCatching { ULocale.forLanguageTag(tag).getDisplayName(locale(l)) }
            .getOrNull()
            ?.takeIf { it.isNotBlank() && it != tag }
            ?: tag

    /** The relative change from the period before, when both are known and the old one is not zero. */
    fun change(now: Double?, before: Double?): Double? {
        if (now == null || before == null || before <= 0.0) return null
        return (now - before) / before
    }
}
