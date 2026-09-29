package com.webyar.ai.ui

import android.content.Context
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.test.core.app.ApplicationProvider
import com.webyar.ai.core.model.User
import com.webyar.ai.core.net.ApiError
import com.webyar.ai.core.net.SampleApi
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.core.storage.Preferences
import com.webyar.ai.core.storage.SecureStore
import com.webyar.ai.core.storage.SessionCache
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
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
 * The two ways a session ends that are not a plain sign-out: the token
 * vanishing from under a remembered operator, and a sign-out the server
 * never confirmed.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SessionEndTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    private val store: SecureStore
        get() = SecureStore(ApplicationProvider.getApplicationContext<Context>())

    /**
     * DataStore outlives a test class: a sign-out another class left marked
     * as pending would run its clean-up in the middle of these.
     */
    private fun noPendingSignOut() = runBlocking {
        store.remove(stringPreferencesKey("session.pendingSignOut"))
    }

    /** Which account the sign-out clean-up ran for, if it ran. */
    private class RecordingHooks : SessionHooks {
        var signedOutFor: String? = null
        var signedOutCalls = 0

        override suspend fun signedOut(accountId: String?) {
            signedOutCalls++
            signedOutFor = accountId
        }
    }

    /** No token to be read — a Keystore key lost, a token never written. */
    private class NoTokenApi(private val real: SampleApi = SampleApi()) : WebyarApi by real {
        override suspend fun hasToken(): Boolean = false
    }

    /**
     * Nobody signed this operator out, so nothing cleaned up after them:
     * their notifications, their cached rows and their push registration
     * would have stayed for whoever signs in next. The launch does it.
     */
    @Test
    fun `a session whose token is gone is cleaned up like a sign-out`() = runTest(dispatcher) {
        val cache = SessionCache(store)
        noPendingSignOut()
        runBlocking { cache.save(User(id = "operator-lost", email = "lost@webyar.app", fullName = "Lost")) }
        val hooks = RecordingHooks()

        val app = AppState(NoTokenApi(), cache, Preferences(store), hooks)
        app.session.first { it !is Session.Restoring }
        testScheduler.advanceUntilIdle()

        assertEquals(Session.SignedOut, app.session.value)
        assertEquals(1, hooks.signedOutCalls)
        assertEquals("operator-lost", hooks.signedOutFor)
        assertNull("the operator was still remembered", cache.read())
    }

    /** And a phone nobody was signed in to has nothing to clean. */
    @Test
    fun `a first launch cleans nothing`() = runTest(dispatcher) {
        val cache = SessionCache(store)
        noPendingSignOut()
        runBlocking { cache.clear() }
        val hooks = RecordingHooks()

        val app = AppState(NoTokenApi(), cache, Preferences(store), hooks)
        app.session.first { it !is Session.Restoring }
        testScheduler.advanceUntilIdle()

        assertEquals(Session.SignedOut, app.session.value)
        assertEquals(0, hooks.signedOutCalls)
    }

    private class OfflineSignOutApi(private val real: SampleApi = SampleApi()) : WebyarApi by real {
        override suspend fun logOut() {
            throw ApiError.Transport()
        }
    }

    /**
     * Offline, a sign-out proves nothing about the server's session, so the
     * operator stays signed in — and is told, rather than left looking at a
     * Sign out that seemed to do nothing.
     */
    @Test
    fun `a sign-out the server did not confirm is reported`() = runTest(dispatcher) {
        val app = AppState(OfflineSignOutApi(), SessionCache(store), Preferences(store))
        app.session.first { it is Session.SignedIn }
        testScheduler.advanceUntilIdle()
        assertFalse(app.signOutFailed.value)

        app.logOut()
        testScheduler.advanceUntilIdle()

        assertTrue("the operator was signed out", app.session.value is Session.SignedIn)
        assertTrue("the failure was not reported", app.signOutFailed.value)

        app.signOutFailureShown()
        assertFalse(app.signOutFailed.value)
    }
}
