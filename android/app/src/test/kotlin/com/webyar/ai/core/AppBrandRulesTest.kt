package com.webyar.ai.core

import com.webyar.ai.i18n.Format
import com.webyar.ai.i18n.Language
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rules each brand lives by, checked for both brands in either build:
 * which API origins a build may move to, and which calendar its Persian
 * dates are in. Which brand THIS build is lives in each flavor's own
 * AppBrandTest (src/testWebyar, src/testRespok).
 */
class AppBrandRulesTest {

    @Test
    fun `RESPOK moves only to respok_app and its subdomains`() {
        for (url in listOf(
            "https://api.respok.app",
            "https://respok.app",
            "https://API.RESPOK.APP/",
            "https://api.respok.app:443/v1",
            "https://eu.api.respok.app",
        )) {
            assertTrue(url, AppBrand.accepts(AppBrand.RESPOK, url))
        }
    }

    @Test
    fun `RESPOK never moves to a WebYar host, or anything that is not its own`() {
        for (url in listOf(
            "https://api.webyar.ai",
            "https://webyar.ai",
            "https://app.webyar.ai/api",
            // An older WebYar host that does not even say "webyar".
            "https://api.destekly.com",
            // Names that only look like RESPOK's.
            "https://api.respok.app.webyar.ai",
            "https://respok.app.example.com",
            "https://notrespok.app",
            "https://respok.application.io",
            "",
            "not a url",
        )) {
            assertFalse(url, AppBrand.accepts(AppBrand.RESPOK, url))
        }
    }

    @Test
    fun `WebYar moves wherever its platform says, as it always has`() {
        for (url in listOf("https://api.webyar.ai", "https://api.destekly.com", "https://api.respok.app")) {
            assertTrue(url, AppBrand.accepts("webyar", url))
        }
    }

    @Test
    fun `Persian dates are Jalali only where the brand says so`() {
        assertEquals("fa-IR-u-ca-persian", Format.calendarTag(Language.FA, jalali = true))
        assertEquals("fa-IR-u-ca-gregory", Format.calendarTag(Language.FA, jalali = false))
        // English and Turkish are Gregorian in both brands.
        for (jalali in listOf(true, false)) {
            assertEquals("en-US", Format.calendarTag(Language.EN, jalali))
            assertEquals("tr-TR", Format.calendarTag(Language.TR, jalali))
        }
        // And this build follows its own brand.
        assertEquals(Format.calendarTag(Language.FA, AppBrand.jalaliDates), Format.calendarTag(Language.FA))
    }
}
