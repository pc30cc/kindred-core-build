package com.webyar.ai.core

import android.content.Context
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.test.core.app.ApplicationProvider
import com.webyar.ai.BuildConfig
import com.webyar.ai.R
import com.webyar.ai.core.model.MaintenanceNotice
import com.webyar.ai.core.storage.GeneratedConfig
import com.webyar.ai.core.storage.PlatformOrigin
import com.webyar.ai.core.storage.SecureStore
import com.webyar.ai.i18n.BrandStr
import com.webyar.ai.i18n.Format
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.RespokStr
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

/**
 * The `respok` flavor is RESPOK, the International edition: its own package,
 * its own server and nobody else's, English first, Gregorian dates even in
 * Persian, its own words, name, icons and colours.
 * WebYar's build has its own copy of this test (src/testWebyar).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AppBrandTest {

    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun `this build is RESPOK`() {
        assertEquals("respok", AppBrand.id)
        assertTrue(AppBrand.isRespok)
        assertEquals("RESPOK", AppBrand.name)
        assertEquals("com.respok.app", BuildConfig.APPLICATION_ID)
        assertEquals("com.respok.app", context.packageName)
        assertEquals("respok-android", AppBrand.realtimeName)
        assertEquals("RESPOK", AppBrand.wordmark)
        assertNull(AppBrand.wordmarkSuffix)
    }

    @Test
    fun `a fresh install asks RESPOK's API`() {
        assertEquals("https://api.respok.app", AppBrand.apiOrigin)
        assertEquals("https://api.respok.app", GeneratedConfig.API_BASE_URL)
    }

    @Test
    fun `it moves only within respok_app, never to WebYar`() {
        assertTrue(PlatformOrigin.adoptable("https://api.respok.app"))
        assertTrue(PlatformOrigin.adoptable("https://api2.respok.app"))
        assertFalse(PlatformOrigin.adoptable("https://api.webyar.ai"))
        assertFalse(PlatformOrigin.adoptable("https://api.destekly.com"))
        assertFalse(PlatformOrigin.adoptable("http://api.respok.app"))
    }

    @Test
    fun `a stored WebYar origin is never used, and none is remembered`() = runBlocking {
        val store = SecureStore(context)
        val origins = PlatformOrigin(store)
        // What a cloned database could have handed an earlier build.
        store.write(stringPreferencesKey("platform.apiOrigin"), "https://api.webyar.ai")
        assertEquals("https://api.respok.app", origins.current())

        origins.forget()
        origins.remember("https://api.webyar.ai")
        assertFalse(origins.isStored())
        assertEquals("https://api.respok.app", origins.current())

        origins.remember("https://api2.respok.app")
        assertEquals("https://api2.respok.app", origins.current())
        origins.forget()
    }

    @Test
    fun `English first, and Persian dates stay Gregorian`() {
        assertEquals(Language.EN, Language.DEFAULT)
        assertEquals(Language.EN, AppBrand.fallbackLanguage)
        assertFalse(AppBrand.jalaliDates)
        assertEquals("fa-IR-u-ca-gregory", Format.calendarTag(Language.FA))
        val day = Format.fullDate(Instant.parse("2026-10-09T12:00:00Z"), Language.FA)
        assertTrue(day, "۲۰۲۶" in day)
        assertFalse(day, "۱۴۰۵" in day)
    }

    @Test
    fun `a maintenance notice falls back to English before Persian`() {
        val notice = MaintenanceNotice(enabled = true, message = mapOf("fa" to "به‌زودی", "en" to "Soon"))
        assertEquals("Soon", notice.message(Language.TR))
        // The operator's own language still comes first.
        assertEquals("به‌زودی", notice.message(Language.FA))
    }

    @Test
    fun `its words are RESPOK's`() {
        for (l in Language.entries) {
            assertEquals(RespokStr.appName(l), BrandStr.appName(l))
            assertEquals(RespokStr.brandWordmark(l), BrandStr.brandWordmark(l))
            assertEquals(RespokStr.pushPrimerBody(l), BrandStr.pushPrimerBody(l))
            assertEquals(RespokStr.pushDeniedTitle(l), BrandStr.pushDeniedTitle(l))
            assertEquals(RespokStr.pushPresenceFooter(l), BrandStr.pushPresenceFooter(l))
            assertEquals(RespokStr.signOutConfirm(l), BrandStr.signOutConfirm(l))
            assertEquals(RespokStr.maintenanceTitle(l), BrandStr.maintenanceTitle(l))
        }
        assertEquals("Sign out of RESPOK?", BrandStr.signOutConfirm(Language.EN))
        assertEquals("RESPOK bakımda", BrandStr.maintenanceTitle(Language.TR))
    }

    @Test
    fun `the launcher says RESPOK and the loader is Ink and Signal`() {
        assertEquals("RESPOK", context.getString(R.string.app_name))
        assertEquals(0xFF16142B.toInt(), context.getColor(R.color.brand_deep))
        assertEquals(0xFFFF5A3C.toInt(), context.getColor(R.color.brand_bright))
        assertEquals(0x0016142B, context.getColor(R.color.brand_deep_clear))
        assertEquals(0xFFFF5A3C.toInt(), context.getColor(R.color.ic_launcher_background))
    }
}
