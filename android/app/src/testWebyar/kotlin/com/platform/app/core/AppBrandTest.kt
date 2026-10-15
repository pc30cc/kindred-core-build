package com.platform.app.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.platform.app.BuildConfig
import com.platform.app.R
import com.platform.app.core.model.MaintenanceNotice
import com.platform.app.core.storage.GeneratedConfig
import com.platform.app.core.storage.PlatformOrigin
import com.platform.app.i18n.BrandStr
import com.platform.app.i18n.Format
import com.platform.app.i18n.Language
import com.platform.app.i18n.StrBrand
import com.platform.app.core.push.CallNotifications
import com.platform.app.core.push.Notifications
import com.platform.app.feature.email.EmailReader
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
            assertEquals(StrBrand.appName(l), BrandStr.appName(l))
            assertEquals(StrBrand.pushPrimerBody(l), BrandStr.pushPrimerBody(l))
            assertEquals(StrBrand.pushDeniedTitle(l), BrandStr.pushDeniedTitle(l))
            assertEquals(StrBrand.pushPresenceFooter(l), BrandStr.pushPresenceFooter(l))
            assertEquals(StrBrand.signOutConfirm(l), BrandStr.signOutConfirm(l))
        }
        assertEquals("Webyar", BrandStr.appName(Language.EN))
        assertEquals("وب\u200cیار", BrandStr.appName(Language.FA))
        assertEquals("Webyar", BrandStr.brandWordmark(Language.EN))
        assertEquals("وب یار", BrandStr.brandWordmark(Language.FA))
        assertEquals("Sign out of Webyar?", BrandStr.signOutConfirm(Language.EN))
        assertEquals("Webyar is under maintenance", BrandStr.maintenanceTitle(Language.EN))
        assertEquals("Webyar bakımda", BrandStr.maintenanceTitle(Language.TR))
    }

    /**
     * What every installed WebYar keeps on the phone, by name, exactly as it
     * shipped before the code's package was renamed. A change here signs
     * every operator out (the DataStore, the Keystore alias), drops their
     * cache, or leaves their notification settings on a channel nothing
     * posts to.
     */
    @Test
    fun `its names on the phone are the ones it shipped with`() {
        assertEquals("webyar", AppBrand.storeName)
        assertEquals("com.webyar.ai.session", AppBrand.keyAlias)
        assertEquals("webyar-cache.db", AppBrand.cacheDatabase)
        assertEquals("webyar.firebase", AppBrand.pushPrefs)
        assertEquals("webyar.promotions", AppBrand.promoPrefs)
        assertEquals("webyar_messages", Notifications.CHANNEL_MESSAGES)
        assertEquals("webyar_calls", CallNotifications.CHANNEL_CALLS)
        assertEquals("com.webyar.ai.call.ANSWER", CallNotifications.ACTION_ANSWER)
        assertEquals("com.webyar.ai.call.SHOW", CallNotifications.ACTION_SHOW)
        assertEquals("com.webyar.ai.call.DECLINE", CallNotifications.ACTION_DECLINE)
        assertEquals("webyar-attachment", EmailReader.ATTACHMENT_SCHEME)
        assertEquals("inline.webyar.invalid", EmailReader.INLINE_HOST)
    }

    /** Home-screen icons and pinned shortcuts name the launcher component from before the rename. */
    @Test
    fun `the launcher still opens the app by its old component name`() {
        val launcher = android.content.Intent(android.content.Intent.ACTION_MAIN)
            .addCategory(android.content.Intent.CATEGORY_LAUNCHER)
            .setPackage(context.packageName)
        val found = context.packageManager.queryIntentActivities(launcher, 0).map { it.activityInfo.name }
        assertEquals(listOf("com.webyar.ai.MainActivity"), found)
    }

    @Test
    fun `the launcher says Webyar and the loader is the kit's turquoise`() {
        assertEquals("Webyar", context.getString(R.string.app_name))
        assertEquals(0xFF0B7D6C.toInt(), context.getColor(R.color.brand_deep))
        assertEquals(0xFF16C7A8.toInt(), context.getColor(R.color.brand_bright))
        assertEquals(0x000B7D6C, context.getColor(R.color.brand_deep_clear))
    }
}
