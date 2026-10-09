package com.webyar.ai.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.webyar.ai.BuildConfig
import com.webyar.ai.R
import com.webyar.ai.core.model.MaintenanceNotice
import com.webyar.ai.core.storage.GeneratedConfig
import com.webyar.ai.core.storage.PlatformOrigin
import com.webyar.ai.i18n.BrandStr
import com.webyar.ai.i18n.Format
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.Str
import com.webyar.ai.i18n.StrAndroid
import com.webyar.ai.i18n.StrManual
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

/**
 * The `webyar` flavor is WebYar exactly as it shipped before RESPOK existed:
 * its package, its server, Persian first, Jalali dates, its own words. Only
 * its icons and launch colours are new (its new brand kit).
 * RESPOK's build has its own copy of this test (src/testRespok).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AppBrandTest {

    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun `this build is WebYar`() {
        assertEquals("webyar", AppBrand.id)
        assertFalse(AppBrand.isRespok)
        assertEquals("Webyar", AppBrand.name)
        assertEquals("com.webyar.ai", BuildConfig.APPLICATION_ID)
        assertEquals("com.webyar.ai", context.packageName)
        assertEquals("webyar-android", AppBrand.realtimeName)
        assertEquals("WEBYAR", AppBrand.wordmark)
        assertEquals("AI", AppBrand.wordmarkSuffix)
    }

    @Test
    fun `a fresh install asks WebYar's API`() {
        assertEquals("https://api.webyar.ai", AppBrand.apiOrigin)
        assertEquals("https://api.webyar.ai", GeneratedConfig.API_BASE_URL)
    }

    @Test
    fun `it follows its platform anywhere https, as before`() {
        assertTrue(PlatformOrigin.adoptable("https://api.webyar.ai"))
        assertTrue(PlatformOrigin.adoptable("https://api.destekly.com"))
        assertFalse(PlatformOrigin.adoptable("http://api.webyar.ai"))
    }

    @Test
    fun `Persian first, with Jalali dates`() {
        assertEquals(Language.FA, Language.DEFAULT)
        assertEquals(Language.FA, AppBrand.fallbackLanguage)
        assertTrue(AppBrand.jalaliDates)
        assertEquals("fa-IR-u-ca-persian", Format.calendarTag(Language.FA))
        // 9 October 2026 is 17 Mehr 1405.
        val day = Format.fullDate(Instant.parse("2026-10-09T12:00:00Z"), Language.FA)
        assertTrue(day, "۱۴۰۵" in day)
    }

    @Test
    fun `a maintenance notice falls back to Persian before English`() {
        val notice = MaintenanceNotice(enabled = true, message = mapOf("fa" to "به‌زودی", "en" to "Soon"))
        assertEquals("به‌زودی", notice.message(Language.TR))
    }

    @Test
    fun `its words are WebYar's own`() {
        for (l in Language.entries) {
            assertEquals(Str.appName(l), BrandStr.appName(l))
            assertEquals(StrManual.brandWordmark(l), BrandStr.brandWordmark(l))
            assertEquals(Str.pushPrimerBody(l), BrandStr.pushPrimerBody(l))
            assertEquals(Str.pushDeniedTitle(l), BrandStr.pushDeniedTitle(l))
            assertEquals(Str.pushPresenceFooter(l), BrandStr.pushPresenceFooter(l))
            assertEquals(Str.signOutConfirm(l), BrandStr.signOutConfirm(l))
            assertEquals(StrAndroid.maintenanceTitle(l), BrandStr.maintenanceTitle(l))
        }
    }

    @Test
    fun `the launcher says Webyar and the loader is the kit's turquoise`() {
        assertEquals("Webyar", context.getString(R.string.app_name))
        assertEquals(0xFF0B7D6C.toInt(), context.getColor(R.color.brand_deep))
        assertEquals(0xFF16C7A8.toInt(), context.getColor(R.color.brand_bright))
        assertEquals(0x000B7D6C, context.getColor(R.color.brand_deep_clear))
    }
}
