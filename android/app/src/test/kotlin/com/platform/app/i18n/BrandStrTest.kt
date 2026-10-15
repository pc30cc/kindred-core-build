package com.platform.app.i18n

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
 * The copy that names the product is the brand's own: each flavor's
 * `BrandCopy`, behind [BrandStr]. The shared tables (`src/main`, in both
 * apps) name neither brand, so RESPOK's app cannot carry the other's name
 * through them — checked in both builds. Which wording a build shows, and
 * RESPOK's own rules for it, are each flavor's tests (src/testWebyar,
 * src/testRespok).
 *
 * Robolectric, because the string tables are read by calling every one of
 * their functions, and a few of those format with android.icu.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BrandStrTest {

    /** The Iranian edition's name in any spelling: Latin (not the Turkish "Web yardım"), Persian. */
    private val otherBrand = Regex("[Ww][Ee][Bb] ?[Yy][Aa][Rr](?!\\p{Ll})|وب[‌ ]?یار|وبیار")

    /** Every `(Language) -> String` function of a string table, by name. */
    private fun lines(table: Any): Map<String, Method> =
        table.javaClass.declaredMethods
            .filter { Modifier.isPublic(it.modifiers) && it.returnType == String::class.java }
            .filter { it.parameterTypes.toList() == listOf(Language::class.java) }
            .associateBy { it.name }

    private val brandLines = lines(BrandStr)

    @Test
    fun `no shared table names a brand`() {
        val named = mutableListOf<String>()
        for (table in listOf(Str, StrManual, StrAndroid, StrInsights, StrEmail)) {
            for ((name, method) in lines(table)) {
                if (Language.entries.any { otherBrand.containsMatchIn(method.invoke(table, it) as String) }) {
                    named += "${table.javaClass.simpleName}.$name"
                }
            }
        }
        assertEquals("these are in both apps; a line that names the product belongs in BrandCopy", emptyList<String>(), named)
    }

    @Test
    fun `every brand line has words in every language`() {
        assertEquals(
            setOf("appName", "brandWordmark", "pushPrimerBody", "pushDeniedTitle", "pushPresenceFooter", "signOutConfirm", "maintenanceTitle"),
            brandLines.keys,
        )
        for ((name, method) in brandLines) {
            for (l in Language.entries) {
                assertTrue("$name ${l.code} is blank", (method.invoke(BrandStr, l) as String).isNotBlank())
            }
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
