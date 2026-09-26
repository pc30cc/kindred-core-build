package com.webyar.operator.ui

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.webyar.operator.core.model.Entitlements
import com.webyar.operator.core.model.EntitlementsState
import com.webyar.operator.core.model.Workspace
import com.webyar.operator.core.net.ApiError
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

    /**
     * Fails the first [failures] calls of both loads the rest of the app
     * hangs off, the way a network that is not up yet does — the emulator's
     * DNS for its first seconds answered `UnknownHostException` to exactly
     * these two.
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
     * One failed attempt used to be the end of it: no workspace, so no
     * conversations, no plan, no Contacts tab and no AI queues — grey rows
     * until the app was killed, while every later request went through.
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
}
