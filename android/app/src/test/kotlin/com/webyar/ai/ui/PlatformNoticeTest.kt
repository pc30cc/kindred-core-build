package com.webyar.ai.ui

import android.content.Context
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.test.core.app.ApplicationProvider
import com.webyar.ai.core.model.MaintenanceNotice
import com.webyar.ai.core.model.MobileAppConfig
import com.webyar.ai.core.model.User
import com.webyar.ai.core.net.SampleApi
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.core.storage.Preferences
import com.webyar.ai.core.storage.SecureStore
import com.webyar.ai.core.storage.SessionCache
import com.webyar.ai.i18n.Language
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * What Super Admin's platform settings do to the app before anyone signs
 * in: the language a phone starts in, and maintenance, during which nobody
 * signs in at all.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PlatformNoticeTest {

    private val dispatcher = StandardTestDispatcher()

    /**
     * DataStore lives for the whole test process, not for one test, so what
     * one test stored — Super Admin's "en", an operator's "tr" — would be
     * the next one's launch. Each starts from a phone nobody has used.
     */
    @Before fun setUp() {
        Dispatchers.setMain(dispatcher)
        val store = SecureStore(ApplicationProvider.getApplicationContext())
        runBlocking {
            store.remove(stringPreferencesKey("prefs.language"))
            store.remove(stringPreferencesKey("prefs.appConfig"))
        }
    }

    @After fun tearDown() = Dispatchers.resetMain()

    private fun state(api: WebyarApi): AppState {
        val context: Context = ApplicationProvider.getApplicationContext()
        val store = SecureStore(context)
        return AppState(api, SessionCache(store), Preferences(store))
    }

    /** Signed out, with whatever public config the test names. */
    private class PlatformApi(
        var config: MobileAppConfig = MobileAppConfig.DEFAULT,
        private val real: SampleApi = SampleApi(),
    ) : WebyarApi by real {
        var logIns = 0
        override suspend fun hasToken(): Boolean = false
        override suspend fun publicAppConfig(): MobileAppConfig = config
        override suspend fun logIn(email: String, password: String): User {
            logIns++
            return real.logIn(email, password)
        }
    }

    /**
     * Until the launch has read what is stored and asked the platform. The
     * stored values come from DataStore's own threads, which the test
     * scheduler does not wait on — so first the launch's end, then its
     * queued check.
     */
    private suspend fun TestScope.launched(app: AppState) {
        app.session.first { it !is Session.Restoring }
        testScheduler.advanceUntilIdle()
    }

    private val down = MaintenanceNotice(enabled = true, message = mapOf("fa" to "به‌زودی برمی‌گردیم"))

    @Test
    fun `a first launch speaks Persian when the platform names no language`() = runTest(dispatcher) {
        val app = state(PlatformApi())
        launched(app)
        assertEquals(Language.FA, app.language.value)
    }

    @Test
    fun `a first launch speaks the language Super Admin set`() = runTest(dispatcher) {
        val app = state(PlatformApi(MobileAppConfig(defaultLanguage = "en")))
        launched(app)
        assertEquals(Language.EN, app.language.value)
    }

    @Test
    fun `an operator's own choice outranks the platform's default`() = runTest(dispatcher) {
        val api = PlatformApi(MobileAppConfig(defaultLanguage = "en"))
        val app = state(api)
        launched(app)
        app.setLanguage(Language.TR)
        testScheduler.advanceUntilIdle()

        api.config = MobileAppConfig(defaultLanguage = "fa")
        app.checkPlatform()
        testScheduler.advanceUntilIdle()
        assertEquals(Language.TR, app.language.value)
    }

    @Test
    fun `nobody signs in while the platform is down for maintenance`() = runTest(dispatcher) {
        val api = PlatformApi()
        val app = state(api)
        launched(app)
        assertNull(app.maintenance.value)

        // Switched on after the launch's own check: the sign-in asks again.
        api.config = MobileAppConfig(maintenance = down)
        val result = app.logIn("operator@webyar.app", "whatever")

        assertTrue(result.isFailure)
        assertEquals(0, api.logIns)
        assertEquals(Session.SignedOut, app.session.value)
        assertNotNull(app.maintenance.value)
    }

    @Test
    fun `the notice goes when maintenance ends, and signing in works again`() = runTest(dispatcher) {
        val api = PlatformApi(MobileAppConfig(maintenance = down))
        val app = state(api)
        launched(app)
        assertNotNull(app.maintenance.value)

        api.config = MobileAppConfig(maintenance = MaintenanceNotice(enabled = false))
        app.checkPlatform()
        testScheduler.advanceUntilIdle()
        assertNull(app.maintenance.value)

        assertTrue(app.logIn("operator@webyar.app", "whatever").isSuccess)
        assertEquals(1, api.logIns)
    }

    @Test
    fun `a notice already past its end time is no notice`() = runTest(dispatcher) {
        val past = down.copy(until = "2020-01-01T00:00:00Z")
        val app = state(PlatformApi(MobileAppConfig(maintenance = past)))
        launched(app)
        assertNull(app.maintenance.value)
    }
}
