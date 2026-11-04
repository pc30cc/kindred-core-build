package com.platform.app.ui

import android.content.Context
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import com.platform.app.core.model.CallChannel
import com.platform.app.core.model.EffectiveBool
import com.platform.app.core.model.Entitlements
import com.platform.app.core.net.ApiError
import com.platform.app.core.net.SampleApi
import com.platform.app.core.net.ServerApi
import com.platform.app.core.push.IncomingCallLink
import com.platform.app.core.push.PushPayload
import com.platform.app.core.storage.Preferences
import com.platform.app.core.storage.SecureStore
import com.platform.app.core.storage.SessionCache
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The mobile app off in a workspace's plan (docs/operations/MOBILE_APP_PLAN.md),
 * as the session lives it: locked only by a snapshot of the workspace on
 * screen that says exactly `false`; a load, a failed read or a missing key
 * never lock; a switch lifts the lock until the new plan speaks; while
 * locked, a notification's tap does nothing; and the background work is told
 * (the session hooks), so the socket and the sync stand still.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MobileAppLockStateTest {

    private val dispatcher = StandardTestDispatcher()
    private val apps = mutableListOf<AppState>()
    private val hooks = RecordingHooks()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)

    /** As in SignInLoadTest: each app's own work is cancelled, and let finish, before Main is reset. */
    @After fun tearDown() {
        val jobs = apps.mapNotNull { it.viewModelScope.coroutineContext[Job] }
        jobs.forEach { it.cancel() }
        val deadline = System.currentTimeMillis() + 10_000
        while (jobs.any { !it.isCompleted } && System.currentTimeMillis() < deadline) {
            dispatcher.scheduler.advanceUntilIdle()
            Thread.sleep(5)
        }
        Dispatchers.resetMain()
    }

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private fun state(api: ServerApi): AppState {
        val store = SecureStore(context)
        return AppState(api, SessionCache(store), Preferences(store), hooks).also { apps += it }
    }

    private class RecordingHooks : SessionHooks {
        val locks = mutableListOf<Boolean>()
        var known: Set<String> = emptySet()
        override fun appLockChanged(locked: Boolean) {
            locks += locked
        }
        override fun mobileAppLocksChanged(workspaceIds: Set<String>) {
            known = workspaceIds
        }
    }

    /** The sample backend, with each workspace's `mobile_app` as the test sets it (absent by default). */
    private class PlanApi(private val real: SampleApi = SampleApi()) : ServerApi by real {
        val plans = mutableMapOf<String, Boolean?>()
        val failing = mutableSetOf<String>()

        // Nothing stored: the launch's own restore signs nobody in.
        override suspend fun hasToken(): Boolean = false

        override suspend fun entitlements(workspaceId: String): Entitlements {
            if (workspaceId in failing) throw ApiError.Transport()
            val base = real.entitlements(workspaceId)
            val features = base.features.orEmpty() - "mobile_app"
            val value = plans[workspaceId]
            return base.copy(features = if (value == null && workspaceId !in plans) features else features + ("mobile_app" to EffectiveBool(value)))
        }
    }

    private val message = PushPayload(type = "new_message", workspaceId = "ws-1", conversationId = "c-1", messageId = "m-1")

    /**
     * Signed in, with the first workspace on screen whichever one this phone
     * remembered (another test may have left the second).
     */
    private suspend fun signIn(app: AppState) {
        app.session.first { it !is Session.Restoring }
        app.logIn("operator@example.org", "whatever")
        settle()
        app.workspaces.value.firstOrNull { it.id == "ws-1" }?.let(app::selectWorkspace)
    }

    private fun settle() {
        dispatcher.scheduler.advanceTimeBy(1_000)
        dispatcher.scheduler.runCurrent()
    }

    @Test
    fun `only a plan that says false locks, and one that says otherwise lifts it`() = runTest(dispatcher) {
        val api = PlanApi()
        val app = state(api)
        signIn(app)
        settle()
        assertEquals("ws-1", app.selectedWorkspace.value?.id)
        assertFalse("a plan without the key never locks", app.mobileAppLocked.value)

        api.plans["ws-1"] = null
        app.refreshPlan()
        settle()
        assertFalse("a key without a value never locks", app.mobileAppLocked.value)

        api.plans["ws-1"] = false
        app.refreshPlan()
        settle()
        assertTrue(app.mobileAppLocked.value)
        assertEquals(listOf(true), hooks.locks)
        assertEquals(setOf("ws-1"), hooks.known)

        api.plans["ws-1"] = true
        app.refreshPlan()
        settle()
        assertFalse(app.mobileAppLocked.value)
        assertEquals(listOf(true, false), hooks.locks)
        assertEquals(emptySet<String>(), hooks.known)
    }

    /** A network blip must not lock a team out — nor lift a lock it did not read. */
    @Test
    fun `a failed read changes nothing`() = runTest(dispatcher) {
        val api = PlanApi()
        api.failing += "ws-1"
        val app = state(api)
        signIn(app)
        settle()
        assertFalse("a plan that cannot be read never locks", app.mobileAppLocked.value)

        api.failing.clear()
        api.plans["ws-1"] = false
        app.refreshPlan()
        settle()
        assertTrue(app.mobileAppLocked.value)

        api.failing += "ws-1"
        app.refreshPlan()
        settle()
        assertTrue("the snapshot in hand stands", app.mobileAppLocked.value)
        assertEquals(setOf("ws-1"), hooks.known)
    }

    @Test
    fun `while locked a notification's tap does nothing`() = runTest(dispatcher) {
        val api = PlanApi()
        api.plans["ws-1"] = false
        val app = state(api)
        signIn(app)
        settle()
        assertTrue(app.mobileAppLocked.value)

        app.openFromNotification(message)
        assertNull(app.pendingLink.value)
        // Not even one for another workspace: nothing in a locked app answers.
        app.openFromNotification(message.copy(workspaceId = "ws-2"))
        assertNull(app.pendingLink.value)

        app.openIncomingCall(IncomingCallLink("call-1", "ws-1", CallChannel.AUDIO, "Sara", answer = false, colleagueId = "u-2"))
        assertNull("a ring's tap opens no call screen in a locked workspace", app.resolvePendingCall())
        assertNull(app.pendingCall.value)
    }

    @Test
    fun `a switch lifts the lock until the new plan speaks, and the old one stays known`() = runTest(dispatcher) {
        val api = PlanApi()
        api.plans["ws-1"] = false
        val app = state(api)
        signIn(app)
        settle()
        assertTrue(app.mobileAppLocked.value)

        val second = app.workspaces.value.first { it.id == "ws-2" }
        app.selectWorkspace(second)
        assertFalse("loading never locks", app.mobileAppLocked.value)
        settle()
        assertFalse(app.mobileAppLocked.value)
        assertEquals(listOf(true, false), hooks.locks)

        // A tap for the workspace last read locked asks its plan first, and
        // does nothing while it still says false; one for the workspace on
        // screen is followed.
        app.openFromNotification(message)
        assertNull(app.resolvePendingLink())
        settle()
        assertNull("still off in its plan", app.pendingLink.value)
        assertEquals(setOf("ws-1"), hooks.known)
        assertEquals("ws-2", app.selectedWorkspace.value?.id)
        app.openFromNotification(message.copy(workspaceId = "ws-2"))
        assertEquals("ws-2", app.pendingLink.value?.workspaceId)
    }

    /** Locked over ws-1, then on ws-2: what most of the tests below start from. */
    private suspend fun lockedThenElsewhere(api: PlanApi): AppState {
        api.plans["ws-1"] = false
        val app = state(api)
        signIn(app)
        settle()
        assertTrue(app.mobileAppLocked.value)
        app.selectWorkspace(app.workspaces.value.first { it.id == "ws-2" })
        settle()
        assertFalse(app.mobileAppLocked.value)
        assertEquals(setOf("ws-1"), hooks.known)
        return app
    }

    /**
     * A plan switched back on while the member looked at another workspace
     * leaves this phone's memory stale: a tap for it asks the plan again,
     * goes through, and the workspace is forgotten — for its rings too.
     */
    @Test
    fun `a tap for a workspace remembered locked goes through once its plan has the app again`() = runTest(dispatcher) {
        val api = PlanApi()
        val app = lockedThenElsewhere(api)

        api.plans["ws-1"] = true
        app.openFromNotification(message)
        assertNull("its plan is asked first", app.resolvePendingLink())
        assertTrue("and the shell is told it is being asked", app.checkingTap.value)
        settle()
        assertFalse(app.checkingTap.value)
        assertEquals(emptySet<String>(), hooks.known)
        assertEquals("ws-1", app.resolvePendingLink()?.workspaceId)
        assertEquals("ws-1", app.selectedWorkspace.value?.id)
    }

    /** The iOS app's rule: a memory is no reason to stand in a tap's way when the plan cannot say. */
    @Test
    fun `a tap for a workspace remembered locked whose plan cannot be read goes through, once`() = runTest(dispatcher) {
        val api = PlanApi()
        val app = lockedThenElsewhere(api)

        api.failing += "ws-1"
        app.openFromNotification(message)
        assertNull(app.resolvePendingLink())
        settle()
        assertEquals("a failed read changes nothing", setOf("ws-1"), hooks.known)
        assertEquals("ws-1", app.resolvePendingLink()?.workspaceId)
        assertEquals("ws-1", app.selectedWorkspace.value?.id)
        assertFalse("a plan that cannot be read never locks", app.mobileAppLocked.value)
        // Readable again, so the plan's retry ends with the test.
        api.failing.clear()
    }

    /** Read nowhere else until one is opened, the others are asked again as the app comes back to the front. */
    @Test
    fun `coming back to the front asks the other workspaces remembered locked again`() = runTest(dispatcher) {
        val api = PlanApi()
        val app = lockedThenElsewhere(api)

        api.plans["ws-1"] = true
        app.onForeground()
        settle()
        assertEquals(emptySet<String>(), hooks.known)
        assertEquals("ws-2", app.selectedWorkspace.value?.id)
        assertFalse(app.mobileAppLocked.value)
    }

    /**
     * Answer on the ring of another workspace — one this phone let ring —
     * while the app stands locked over the one on screen: that workspace
     * comes to the front and the call opens there. Before, the tap was
     * dropped under the card, the ring already stopped, and the caller rang
     * out. One for the locked workspace itself is refused at once.
     */
    @Test
    fun `a ring's tap for another workspace is answered there, one for the locked workspace is refused`() = runTest(dispatcher) {
        val api = PlanApi()
        api.plans["ws-1"] = false
        val app = state(api)
        signIn(app)
        settle()
        assertTrue(app.mobileAppLocked.value)

        assertFalse(app.openIncomingCall(IncomingCallLink("call-1", "ws-1", CallChannel.AUDIO, "Sara", answer = true, colleagueId = "u-2")))
        assertNull(app.pendingCall.value)

        assertTrue(app.openIncomingCall(IncomingCallLink("call-2", "ws-2", CallChannel.VIDEO, "Daniel", answer = true, colleagueId = "u-3")))
        assertEquals("ws-2", app.selectedWorkspace.value?.id)
        assertFalse(app.mobileAppLocked.value)
        assertEquals("call-2", app.resolvePendingCall()?.callId)
    }

    @Test
    fun `signing out forgets every lock`() = runTest(dispatcher) {
        val api = PlanApi()
        api.plans["ws-1"] = false
        val app = state(api)
        signIn(app)
        settle()
        assertTrue(app.mobileAppLocked.value)

        app.logOut()
        app.session.first { it is Session.SignedOut }
        assertFalse(app.mobileAppLocked.value)
        assertEquals(emptySet<String>(), hooks.known)
        assertEquals(listOf(true, false), hooks.locks)
    }

    /** What a ring that cold-starts the app reads (AppGraph): per account, and nobody else's. */
    @Test
    fun `the locked workspaces are kept per account`() = runBlocking {
        val prefs = Preferences(SecureStore(context))
        prefs.setMobileAppLocked("user-a", setOf("ws-2", "ws-1"))
        assertEquals(setOf("ws-1", "ws-2"), prefs.mobileAppLocked("user-a"))
        assertEquals(emptySet<String>(), prefs.mobileAppLocked("user-b"))

        prefs.setMobileAppLocked("user-a", emptySet())
        assertEquals(emptySet<String>(), prefs.mobileAppLocked("user-a"))
        prefs.setMobileAppLocked("user-a", setOf("ws-1"))
        prefs.setMobileAppLocked(null, emptySet())
        assertEquals(emptySet<String>(), prefs.mobileAppLocked("user-a"))
    }

    /**
     * A ring tapped on a cold start whose ring ran out while the session was
     * restored and the workspaces read: no call screen opens for a call no
     * longer on offer — it would stand over the lock screen offering it.
     */
    @Test
    fun `a ring that ran out before the app could open it opens no call screen`() = runTest(dispatcher) {
        val app = state(PlanApi())
        signIn(app)
        settle()
        val now = System.currentTimeMillis() / 1000

        assertTrue(app.openIncomingCall(IncomingCallLink("call-1", "ws-1", CallChannel.AUDIO, "Sara", answer = false, expiresAt = now - 1)))
        assertNull(app.resolvePendingCall())
        assertNull(app.pendingCall.value)

        assertTrue(app.openIncomingCall(IncomingCallLink("call-2", "ws-1", CallChannel.AUDIO, "Sara", answer = false, expiresAt = now + 60)))
        assertEquals("call-2", app.resolvePendingCall()?.callId)
    }
}
