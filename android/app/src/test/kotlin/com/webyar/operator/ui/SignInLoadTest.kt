package com.webyar.operator.ui

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.webyar.operator.core.model.Workspace
import com.webyar.operator.core.net.SampleApi
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.core.storage.Preferences
import com.webyar.operator.core.storage.SecureStore
import com.webyar.operator.core.storage.SessionCache
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * What happens to the first data load at the moment of signing in.
 *
 * The bug this exists for, in one line from logcat:
 *
 *     REQUEST /api/workspaces failed with exception:
 *     ForgottenCoroutineScopeException: rememberCoroutineScope left the
 *     composition
 *
 * `logIn` set the session, which replaced the login screen with the app,
 * which killed the login screen's `rememberCoroutineScope` — and the
 * workspace load was still running inside it. So a fresh sign-in reached an
 * app with no workspace, and therefore no entitlements, no Contacts tab, no
 * AI queues and no conversations. It looked like an empty account rather
 * than a cancelled request, because `loadWorkspaces` swallows failures.
 *
 * A restored session never showed it — that path already runs in
 * `viewModelScope` — which is why every earlier look at the app missed this
 * entirely.
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
     * cancelled, and the test would pass against the broken code.
     */
    private class SlowWorkspacesApi(
        private val real: SampleApi = SampleApi(),
    ) : WebyarApi by real {
        override suspend fun workspaces(): List<Workspace> {
            delay(1_000)
            return real.workspaces()
        }
    }

    @Test
    fun `the workspace load survives the login screen going away`() = runTest(dispatcher) {
        val app = state(SlowWorkspacesApi())
        testScheduler.advanceUntilIdle()

        // The login screen's scope: it lives exactly as long as the screen.
        val loginScreenScope = CoroutineScope(dispatcher + Job())
        loginScreenScope.launch { app.logIn("operator@webyar.app", "whatever") }

        // Far enough for the sign-in to succeed and the load to be in flight,
        // not far enough for the load to have finished.
        testScheduler.advanceTimeBy(300)

        // Setting the session is what replaces the screen, so this is what
        // really happens next.
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
        loginScreenScope.launch { app.logIn("operator@webyar.app", "whatever") }
        testScheduler.advanceUntilIdle()
        loginScreenScope.cancel()
        testScheduler.advanceUntilIdle()

        assertTrue(app.session.value is Session.SignedIn)
        assertTrue(app.workspaces.value.isNotEmpty())
    }
}
