package com.webyar.operator.i18n

import android.icu.text.DateFormat
import android.icu.text.NumberFormat
import android.icu.text.RelativeDateTimeFormatter
import android.icu.util.Calendar
import android.icu.util.ULocale
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/**
 * Dates, numbers and names, for every screen.
 *
 * Everything here goes through `android.icu` rather than `java.text`, and the
 * reason is the calendar. **A Persian operator reads Persian dates** — ۲۷
 * شهریور, not ۱۸ سپتامبر. That is a different calendar, not a different set of
 * month names, so taking the device's Gregorian calendar and merely changing
 * its locale would give Persian *words* over Gregorian *dates*, which is worse
 * than either on its own. `java.time` has no Persian chronology;
 * `android.icu` has had one since API 24, which is exactly this app's minimum.
 *
 * The clock stays the device's. The operator is where they are.
 */
object Format {

    // MARK: - Locales

    /**
     * The locale a date should be *read* in.
     *
     * ICU already defaults `fa` to the Persian calendar, but it is named here
     * anyway: a default that is depended on and not stated is a default that
     * changes in a library upgrade and takes a year to notice.
     */
    private fun calendarLocale(language: Language): ULocale = when (language) {
        Language.FA -> ULocale("fa-IR-u-ca-persian")
        Language.EN -> ULocale("en-US")
        Language.TR -> ULocale("tr-TR")
    }

    // MARK: - Numbers

    /**
     * Numbers in the reader's own digits.
     *
     * Kotlin's own interpolation always produces Latin digits, so a count
     * built with `"$n"` lands as "2" in the middle of a Persian sentence.
     * Anything a person reads as a quantity comes through here instead.
     */
    fun number(value: Int, language: Language): String =
        integerFormat(language).format(value.toLong())

    fun number(value: Long, language: Language): String =
        integerFormat(language).format(value)

    /** One decimal place, in the locale's digits and with its decimal mark. */
    private fun decimal(value: Double, language: Language): String =
        decimalFormat(language).format(value)

    // MARK: - Timestamps

    /**
     * The timestamp on a list row: a time for today, "yesterday" for
     * yesterday, a weekday inside the last week, a date beyond that.
     *
     * This is the convention Mail and Messages use, and it is what lets
     * someone scan a column of timestamps without reading any of them closely.
     */
    fun listTimestamp(
        instant: Instant?,
        language: Language,
        now: Instant = Instant.now(),
    ): String {
        if (instant == null) return ""
        val locale = calendarLocale(language)
        val then = calendarAt(instant, locale)
        val today = calendarAt(now, locale)

        return when {
            isSameDay(then, today) -> pattern(instant, "jmm", locale)
            isYesterday(then, today, locale) ->
                // A relative word beats "Tue" when it is the day before.
                relative(language, RelativeDateTimeFormatter.Direction.LAST, RelativeDateTimeFormatter.AbsoluteUnit.DAY)
            within(then, today, days = 6) -> pattern(instant, "EEE", locale)
            then.get(Calendar.YEAR) == today.get(Calendar.YEAR) -> pattern(instant, "dMMM", locale)
            else -> pattern(instant, "dMMMyy", locale)
        }
    }

    /** The header that separates one day of a transcript from the next. */
    fun dayHeader(
        instant: Instant,
        language: Language,
        now: Instant = Instant.now(),
    ): String {
        val locale = calendarLocale(language)
        val then = calendarAt(instant, locale)
        val today = calendarAt(now, locale)

        if (isSameDay(then, today)) {
            return relative(language, RelativeDateTimeFormatter.Direction.THIS, RelativeDateTimeFormatter.AbsoluteUnit.DAY)
        }
        if (isYesterday(then, today, locale)) {
            return relative(language, RelativeDateTimeFormatter.Direction.LAST, RelativeDateTimeFormatter.AbsoluteUnit.DAY)
        }
        val template = if (then.get(Calendar.YEAR) == today.get(Calendar.YEAR)) {
            "EEEEdMMMM"
        } else {
            "dMMMMyyyy"
        }
        return pattern(instant, template, locale)
    }

    /** The clock time under a chat bubble. */
    fun bubbleTime(instant: Instant?, language: Language): String {
        if (instant == null) return ""
        return pattern(instant, "jmm", calendarLocale(language))
    }

    // MARK: - Durations

    /**
     * A call length, as `mm:ss` or `h:mm:ss`.
     *
     * The shape is fixed — a duration is read as a clock rather than as a
     * sentence, "4:05" lands faster than "4 minutes 5 seconds", and a column
     * of them lines up — but the digits are the reader's own. A phone set to
     * Persian counts a call in ۰۰:۴۰, and so does this.
     */
    fun duration(seconds: Int, language: Language): String {
        val clamped = maxOf(0, seconds)
        val hours = clamped / 3600
        val minutes = (clamped % 3600) / 60
        val secs = clamped % 60
        // Padded on both sides, which is what `formatCallDuration` in
        // `src/lib/systemMessageText.ts` does — a call summary has to read
        // identically in the app and in the console.
        return if (hours > 0) {
            clock(listOf(hours, minutes, secs), padFirst = true, language = language)
        } else {
            clock(listOf(minutes, secs), padFirst = true, language = language)
        }
    }

    /**
     * The number beside a voice note: `m:ss`, minutes unpadded.
     *
     * Deliberately not [duration]. The console has two clocks and they differ
     * on purpose — `clockTime` in the attachment view leaves the minutes
     * unpadded for a recording, while `formatCallDuration` pads both fields
     * for a call summary. A three-second note reads "0:03" on every phone
     * anyone has used.
     */
    fun voiceTime(seconds: Double, language: Language): String {
        val total = maxOf(0, seconds.toInt())
        return clock(listOf(total / 60, total % 60), padFirst = false, language = language)
    }

    /** How long a call has been running, as a call timer reads it. */
    fun callDuration(start: Instant, now: Instant, language: Language): String {
        val total = maxOf(0L, now.epochSecond - start.epochSecond).toInt()
        val hours = total / 3600
        return if (hours > 0) {
            clock(listOf(hours, (total / 60) % 60, total % 60), padFirst = false, language = language)
        } else {
            clock(listOf(total / 60, total % 60), padFirst = true, language = language)
        }
    }

    /**
     * Joins clock fields with a colon, zero-padding in the locale's own digits.
     *
     * Padding has to happen in the localised digits rather than before them:
     * `"%02d".format(5)` gives "05", and swapping the glyphs afterwards is
     * exactly the kind of string surgery that breaks on the next locale.
     */
    private fun clock(fields: List<Int>, padFirst: Boolean, language: Language): String {
        val zero = number(0, language)
        return fields.mapIndexed { index, value ->
            val text = number(value, language)
            if ((index > 0 || padFirst) && text.length < 2) zero + text else text
        }.joinToString(":")
    }

    // MARK: - Sizes and names

    /**
     * A file size the way a person reads one.
     *
     * Same thresholds and rounding as `humanSize` in
     * `src/components/inbox/MessageAttachmentView.tsx`, so an attachment reads
     * the same in the app and in the console — with the digits and the unit
     * word in the reader's own language.
     */
    fun fileSize(bytes: Long, language: Language): String = when {
        bytes < 1024 -> "${number(bytes, language)} ${Str.unitBytes(language)}"
        bytes < 1024 * 1024 ->
            "${number(Math.round(bytes / 1024.0), language)} ${Str.unitKilobytes(language)}"
        else -> {
            val mb = bytes / (1024.0 * 1024.0)
            // One decimal below 10 MB, none above — "12.3 MB" reads no better
            // than "12 MB" and takes more room in a card.
            val text = if (mb < 10) decimal(mb, language) else number(Math.round(mb), language)
            "$text ${Str.unitMegabytes(language)}"
        }
    }

    /**
     * What to call a contact who may have given us nothing.
     *
     * Falls back through name → email local part → the stable visitor code,
     * and only then to a generic word, so two anonymous visitors are still
     * told apart on screen.
     */
    fun contactName(
        name: String?,
        email: String?,
        visitorCode: String?,
        language: Language,
    ): String {
        if (!name.isNullOrBlank()) return name
        if (!email.isNullOrEmpty()) {
            val at = email.indexOf('@')
            return if (at > 0) email.substring(0, at) else email
        }
        if (!visitorCode.isNullOrEmpty()) {
            return "${Str.unknownVisitor(language)} $visitorCode"
        }
        return Str.unknownVisitor(language)
    }

    /** Collapses a message body to a single scannable preview line. */
    fun preview(body: String?): String =
        body?.replace('\n', ' ')?.replace('\r', ' ')?.trim().orEmpty()

    // MARK: - The caches
    //
    // A list row formats a date every time it is laid out, so a scrolling
    // inbox would otherwise build a formatter per row per frame. ICU
    // formatters are safe to share once configured; only the maps need
    // guarding, and ConcurrentHashMap does that.

    private val patternCache = ConcurrentHashMap<String, DateFormat>()
    private val integerCache = ConcurrentHashMap<String, NumberFormat>()
    private val decimalCache = ConcurrentHashMap<String, NumberFormat>()

    private fun pattern(instant: Instant, template: String, locale: ULocale): String {
        val format = patternCache.getOrPut("$template|$locale") {
            DateFormat.getPatternInstance(template, locale)
        }
        // `Date(millis)` rather than `Date.from(instant)`: the latter is an
        // API 26 static, and core-library desugaring covers `java.time` — not
        // additions to `java.util.Date`. This compiles on 24 because the
        // constructor always existed.
        return synchronized(format) { format.format(java.util.Date(instant.toEpochMilli())) }
    }

    private fun integerFormat(language: Language): NumberFormat =
        integerCache.getOrPut(language.code) {
            NumberFormat.getIntegerInstance(calendarLocale(language)).apply {
                // A count is not a measurement: "1,024 conversations" is a
                // grouping separator doing no work in a badge.
                isGroupingUsed = false
            }
        }

    private fun decimalFormat(language: Language): NumberFormat =
        decimalCache.getOrPut(language.code) {
            NumberFormat.getInstance(calendarLocale(language)).apply {
                isGroupingUsed = false
                minimumFractionDigits = 1
                maximumFractionDigits = 1
            }
        }

    // MARK: - Calendar arithmetic

    private fun calendarAt(instant: Instant, locale: ULocale): Calendar =
        Calendar.getInstance(locale).apply { timeInMillis = instant.toEpochMilli() }

    private fun isSameDay(a: Calendar, b: Calendar): Boolean =
        a.get(Calendar.ERA) == b.get(Calendar.ERA) &&
            a.get(Calendar.YEAR) == b.get(Calendar.YEAR) &&
            a.get(Calendar.DAY_OF_YEAR) == b.get(Calendar.DAY_OF_YEAR)

    private fun isYesterday(then: Calendar, today: Calendar, locale: ULocale): Boolean {
        val yesterday = Calendar.getInstance(locale).apply {
            timeInMillis = today.timeInMillis
            add(Calendar.DAY_OF_YEAR, -1)
        }
        return isSameDay(then, yesterday)
    }

    private fun within(then: Calendar, today: Calendar, days: Int): Boolean {
        val cutoff = today.timeInMillis - days * 86_400_000L
        return then.timeInMillis > cutoff
    }

    private fun relative(
        language: Language,
        direction: RelativeDateTimeFormatter.Direction,
        unit: RelativeDateTimeFormatter.AbsoluteUnit,
    ): String = RelativeDateTimeFormatter.getInstance(calendarLocale(language))
        .format(direction, unit)
}
