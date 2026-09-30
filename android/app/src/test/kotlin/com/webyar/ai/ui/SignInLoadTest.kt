package com.webyar.ai.ui

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.webyar.ai.core.model.Entitlements
import com.webyar.ai.core.model.EntitlementsState
import com.webyar.ai.core.model.MobileAppConfig
import com.webyar.ai.core.model.Workspace
import com.webyar.ai.core.net.ApiError
import com.webyar.ai.core.net.SampleApi
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.core.storage.Preferences
import com.webyar.ai.core.storage.SecureStore
import com.webyar.ai.core.storage.SessionCache
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * What happens to the first data load at the moment of signing in.
 *
 * The failure this guards against, as logcat shows it:
 *
 *     REQUEST /api/workspaces failed with exception:
 *     ForgottenCoroutineScopeException: rememberCoroutineScope left the
 *     composition
 *
 * `logIn` sets the session, which replaces the login screen with the app,
 * which ends the login screen's `rememberCoroutineScope` — so the workspace
 * load must not run inside it. If it does, a fresh sign-in reaches an app
 * with no workspace, and therefore no entitlements, no Contacts tab, no AI
 * queues and no conversations. That looks like an empty account rather than
 * a cancelled request, because `loadWorkspaces` swallows failures.
 *
 * A restored session is not affected: that path runs in `viewModelScope`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SignInLoadTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    private fun state(api: WebyarApi): AppState {
        val context: Context = ApplicationProvider.getApplicationContext()
        val store = SecureStore(context)
        return AppState(api, SessionCache(store), Preferences(store))
    }

    /**
     * The workspace list takes a moment, as a real one does. Without the
     * delay the load would finish before the caller's scope could be
     * cancelled, and the test would pass even with the load in that scope.
     */
    private class SlowWorkspacesApi(
        private val real: SampleApi = SampleApi(),
    ) : WebyarApi by real {
        // Nothing stored: the launch's own restore signs nobody in, so the
        // only workspace load is the one the sign-in starts.
        override suspend fun hasToken(): Boolean = false

        override suspend fun workspaces(): List<Workspace> {
            delay(1_000)
            return real.workspaces()
        }
    }

    @Test
    fun `the workspace load survives the login screen going away`() = runTest(dispatcher) {
        val app = state(SlowWorkspacesApi())
        app.session.first { it !is Session.Restoring }

        // The login screen's scope: it lives exactly as long as the screen.
        val loginScreenScope = CoroutineScope(dispatcher + Job())
        loginScreenScope.launch { app.logIn("operator@webyar.app", "whatever") }

        // Setting the session is what replaces the screen, so the screen's
        // scope goes the moment it is set — with the load a second from done.
        app.session.first { it is Session.SignedIn }
        loginScreenScope.cancel()
        testScheduler.advanceUntilIdle()

        assertTrue(
            "the workspace load was cancelled with the login screen",
            app.workspaces.value.isNotEmpty(),
        )
    }

    /** And the session itself survives, which is what navigates. */
    @Test
    fun `signing in leaves the app signed in`() = runTest(dispatcher) {
        val app = state(SampleApi())
        testScheduler.advanceUntilIdle()

        val loginScreenScope = CoroutineScope(dispatcher + Job())
        val login = loginScreenScope.launch { app.logIn("operator@webyar.app", "whatever") }
        // The screen goes once the sign-in has answered — which includes the
        // session's save, on DataStore's threads rather than this scheduler.
        login.join()
        loginScreenScope.cancel()
        testScheduler.advanceUntilIdle()

        assertTrue(app.session.value is Session.SignedIn)
        assertTrue(app.workspaces.value.isNotEmpty())
    }

    /**
     * Fails the first [failures] calls of both loads the rest of the app
     * hangs off, the way a network that is not up yet does — an emulator's
     * DNS answers `UnknownHostException` for its first few seconds.
     */
    private class NotUpYetApi(
        private val failures: Int,
        private val real: SampleApi = SampleApi(),
    ) : WebyarApi by real {
        var workspaceCalls = 0
        var entitlementCalls = 0

        override suspend fun workspaces(): List<Workspace> {
            if (workspaceCalls++ < failures) throw ApiError.Transport()
            return real.workspaces()
        }

        override suspend fun entitlements(workspaceId: String): Entitlements {
            if (entitlementCalls++ < failures) throw ApiError.Transport()
            return real.entitlements(workspaceId)
        }
    }

    /**
     * One failed attempt must not be the end of it: that leaves no
     * workspace, so no conversations, no plan, no Contacts tab and no AI
     * queues — grey rows until the app is killed, while every later request
     * goes through.
     */
    @Test
    fun `a workspace load that fails at first is tried again until it lands`() = runTest(dispatcher) {
        val api = NotUpYetApi(failures = 2)
        val app = state(api)
        testScheduler.advanceUntilIdle()

        app.logIn("operator@webyar.app", "whatever")
        testScheduler.advanceUntilIdle()

        assertTrue(
            "the workspaces were never retried (${api.workspaceCalls} calls)",
            app.workspaces.value.isNotEmpty(),
        )
        assertTrue("no workspace was selected", app.selectedWorkspace.value != null)
        assertTrue(
            "the plan was left ${app.entitlements.value} after a transient error " +
                "(${api.entitlementCalls} calls)",
            app.entitlements.value is EntitlementsState.Loaded,
        )
        // At least: the launch's own session restore may ask once more.
        assertTrue("only ${api.workspaceCalls} workspace calls", api.workspaceCalls >= 3)
    }

    /**
     * Super Admin's switches, as `GET /api/mobile-app/config` answers them —
     * or, with [failing] set, as a request that never gets an answer.
     *
     * None of these tests waits for the launch's own restore: it reads
     * DataStore on threads the test scheduler does not see, and a test that
     * waits on it hangs when a class before it in the same JVM has left
     * DataStore busy. AppState does not let that late read overwrite a
     * value set meanwhile, which is what these tests pin.
     */
    private class ConfigApi(
        var config: MobileAppConfig,
        private val real: SampleApi = SampleApi(),
    ) : WebyarApi by real {
        var configCalls = 0
        var failing = false

        override suspend fun mobileAppConfig(): MobileAppConfig {
            configCalls++
            if (failing) throw ApiError.Transport()
            return config
        }
    }

    @Test
    fun `Super Admin's switches arrive with the sign-in`() = runTest(dispatcher) {
        val api = ConfigApi(MobileAppConfig(showStorage = false, profileNameEditable = true))
        val app = state(api)
        testScheduler.advanceUntilIdle()

        app.logIn("operator@webyar.app", "whatever")
        testScheduler.advanceUntilIdle()

        assertTrue("the config was never asked for", api.configCalls >= 1)
        assertFalse(app.appConfig.value.showStorage)
        assertTrue(app.appConfig.value.profileNameEditable)
    }

    /**
     * Turned off on the web, wallpaper colours go on every phone — but the
     * operator's own choice is kept, for the day they are allowed again.
     */
    @Test
    fun `wallpaper colours follow Super Admin over the operator's choice`() = runTest(dispatcher) {
        val api = ConfigApi(MobileAppConfig(allowWallpaperColors = false))
        val app = state(api)
        testScheduler.advanceUntilIdle()
        app.setDynamicColor(true)

        app.logIn("operator@webyar.app", "whatever")
        testScheduler.advanceUntilIdle()
        assertFalse("wallpaper colours stayed on against Super Admin", app.dynamicColor.value)

        // Allowed again, and the app comes back to the foreground.
        api.config = MobileAppConfig(allowWallpaperColors = true)
        app.refreshPlanIfStale()
        testScheduler.advanceUntilIdle()
        assertTrue("the operator's own choice was lost", app.dynamicColor.value)
    }

    /** A later request that fails keeps the last answer rather than undoing it. */
    @Test
    fun `a config that cannot be read leaves the app as it was`() = runTest(dispatcher) {
        val answer = MobileAppConfig(showSecurity = false)
        val api = ConfigApi(answer)
        val app = state(api)
        testScheduler.advanceUntilIdle()
        app.logIn("operator@webyar.app", "whatever")
        testScheduler.advanceUntilIdle()
        assertEquals(answer, app.appConfig.value)

        api.failing = true
        app.refreshPlanIfStale()
        testScheduler.advanceUntilIdle()

        assertTrue("the failing request was never made", api.configCalls >= 2)
        assertEquals(answer, app.appConfig.value)
    }
}
