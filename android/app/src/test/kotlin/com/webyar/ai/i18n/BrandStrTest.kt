package com.webyar.ai.i18n

import android.icu.text.DateFormat
import android.icu.util.TimeZone
import android.icu.util.ULocale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.lang.reflect.Method
import java.lang.reflect.Modifier
import java.time.Instant
import java.util.Date

/**
 * RESPOK's wording, and that nothing WebYar names itself in is left without
 * it — checked in both builds. Which wording a build shows is each flavor's
 * own AppBrandTest.
 *
 * Robolectric, because the string tables are read by calling every one of
 * their functions, and a few of those format with android.icu.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BrandStrTest {

    /** WebYar in any spelling: Latin ("Webyar", "WEBYAR", "Web yar" but not the Turkish "Web yardım"), Persian. */
    private val webyar = Regex("[Ww][Ee][Bb] ?[Yy][Aa][Rr](?!\\p{Ll})|وب[‌ ]?یار|وبیار")

    /** Every `(Language) -> String` function of a string table, by name. */
    private fun lines(table: Any): Map<String, Method> =
        table.javaClass.declaredMethods
            .filter { Modifier.isPublic(it.modifiers) && it.returnType == String::class.java }
            .filter { it.parameterTypes.toList() == listOf(Language::class.java) }
            .associateBy { it.name }

    private val brandLines = lines(BrandStr)
    private val respokLines = lines(RespokStr)

    @Test
    fun `every line that names WebYar has a brand version`() {
        val missing = mutableListOf<String>()
        for (table in listOf(Str, StrManual, StrAndroid, StrInsights, StrEmail)) {
            for ((name, method) in lines(table)) {
                val names = Language.entries.any { webyar.containsMatchIn(method.invoke(table, it) as String) }
                if (names && name !in brandLines) missing += "${table.javaClass.simpleName}.$name"
            }
        }
        assertEquals("these name WebYar and RESPOK's build would show them as they are", emptyList<String>(), missing)
    }

    @Test
    fun `RESPOK has its own wording of every brand line, and it never names WebYar`() {
        assertEquals(brandLines.keys, respokLines.keys)
        for ((name, method) in respokLines) {
            for (l in Language.entries) {
                val text = method.invoke(RespokStr, l) as String
                assertFalse("$name ${l.code}: $text", webyar.containsMatchIn(text))
                assertTrue("$name ${l.code} is blank", text.isNotBlank())
            }
        }
    }

    @Test
    fun `RESPOK's wording names RESPOK, except where WebYar's never named itself`() {
        for ((name, method) in respokLines) {
            for (l in Language.entries) {
                val text = method.invoke(RespokStr, l) as String
                if ("RESPOK" in text) continue
                // The one line Turkish words without a name: RESPOK's is WebYar's own.
                assertEquals("$name ${l.code}", "pushPresenceFooter" to Language.TR, name to l)
                assertEquals(Str.pushPresenceFooter(l), text)
            }
        }
    }

    @Test
    fun `Turkish suffixes agree with RESPOK`() {
        assertEquals("RESPOK'tan çıkılsın mı?", RespokStr.signOutConfirm(Language.TR))
        for (method in respokLines.values) {
            assertFalse(Regex("RESPOK['’](ı|ın|dan)\\b").containsMatchIn(method.invoke(RespokStr, Language.TR) as String))
        }
    }

    @Test
    fun `RESPOK is Latin in every language, as on its desktop apps`() {
        for (l in Language.entries) {
            assertEquals("RESPOK", RespokStr.appName(l))
            assertEquals("RESPOK", RespokStr.brandWordmark(l))
        }
    }

    /** What the two calendar tags mean to ICU, whichever brand this build is. */
    @Test
    fun `Gregorian Persian is still Persian, only the calendar changes`() {
        val day = Date(Instant.parse("2026-10-09T12:00:00Z").toEpochMilli())
        fun written(jalali: Boolean): String =
            DateFormat.getPatternInstance("dMMMMyyyy", ULocale(Format.calendarTag(Language.FA, jalali))).apply {
                timeZone = TimeZone.getTimeZone("UTC")
            }.format(day)

        val jalali = written(jalali = true)
        val gregorian = written(jalali = false)
        assertTrue(jalali, "۱۴۰۵" in jalali && "مهر" in jalali)
        assertTrue(gregorian, "۲۰۲۶" in gregorian && "۹" in gregorian)
        assertFalse(gregorian, "مهر" in gregorian)
        assertNotNull(gregorian.firstOrNull { it in 'ا'..'ی' })
    }
}
