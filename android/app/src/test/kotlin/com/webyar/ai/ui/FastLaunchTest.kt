package com.webyar.ai.ui

import android.content.Context
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.test.core.app.ApplicationProvider
import com.webyar.ai.core.model.Account
import com.webyar.ai.core.model.User
import com.webyar.ai.core.net.ApiError
import com.webyar.ai.core.net.SampleApi
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.core.storage.Preferences
import com.webyar.ai.core.storage.SecureStore
import com.webyar.ai.core.storage.SessionCache
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A launch does not wait on the network before showing something.
 *
 * It used to: the platform's address, then the account, each allowed the
 * client's full 20 seconds — so on a connection that hangs rather than fails
 * the loader stood for up to forty seconds before the cached inbox (or the
 * sign-in screen) that was there all along. The server that never answers
 * here is that connection.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class FastLaunchTest {

    private val dispatcher = StandardTestDispatcher()

    private val store: SecureStore
        get() = SecureStore(ApplicationProvider.getApplicationContext<Context>())

    private val remembered = User(id = "operator-1", email = "sara@webyar.app", fullName = "Sara")

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        // DataStore outlives a test: a sign-out another test left pending
        // would run its clean-up in the middle of these.
        runBlocking { store.remove(stringPreferencesKey("session.pendingSignOut")) }
    }

    @After fun tearDown() = Dispatchers.resetMain()

    private fun remember(user: User?): SessionCache {
        val cache = SessionCache(store)
        runBlocking { if (user != null) cache.save(user) else cache.clear() }
        return cache
    }

    /** Signed in, with the account read answering whenever [account] completes. */
    private class SlowServerApi(
        private val account: CompletableDeferred<Result<User>> = CompletableDeferred(),
        private val real: SampleApi = SampleApi(),
    ) : WebyarApi by real {
        override suspend fun hasToken(): Boolean = true
        override suspend fun refreshOrigin() = Unit
        override suspend fun currentUser(): User = account.await().getOrThrow()
        fun answer(result: Result<User>) = account.complete(result)

        // The profile read that follows a workspace would rename the operator
        // to the sample's own name; only the session's answer may, here.
        override suspend fun account(): Account = throw ApiError.Transport()
    }

    /** Signed out, on a connection where the platform's address never arrives. */
    private class NoAddressApi(private val real: SampleApi = SampleApi()) : WebyarApi by real {
        override suspend fun hasToken(): Boolean = false
        override suspend fun refreshOrigin() = awaitCancellation()
    }

    @Test
    fun `a remembered operator opens on their cache without waiting for the server`() = runTest(dispatcher) {
        val app = AppState(SlowServerApi(), remember(remembered), Preferences(store))

        val opened = app.session.first { it !is Session.Restoring }

        assertEquals(Session.SignedIn(remembered), opened)
    }

    @Test
    fun `a session the server has ended closes the moment it says so`() = runTest(dispatcher) {
        val api = SlowServerApi()
        val cache = remember(remembered)
        val app = AppState(api, cache, Preferences(store))
        app.session.first { it is Session.SignedIn }

        api.answer(Result.failure(ApiError.Unauthorized))
        app.session.first { it is Session.SignedOut }

        assertNull("the operator was still remembered", cache.read())
    }

    @Test
    fun `offline, the remembered operator stays with their cache`() = runTest(dispatcher) {
        val api = SlowServerApi()
        val app = AppState(api, remember(remembered), Preferences(store))
        app.session.first { it is Session.SignedIn }

        api.answer(Result.failure(ApiError.Transport()))
        testScheduler.advanceUntilIdle()

        assertEquals(Session.SignedIn(remembered), app.session.value)
    }

    @Test
    fun `a name changed on the web reaches the header once the server answers`() = runTest(dispatcher) {
        val api = SlowServerApi()
        val app = AppState(api, remember(remembered), Preferences(store))
        app.session.first { it is Session.SignedIn }

        val renamed = remembered.copy(fullName = "Sara Rahimi")
        api.answer(Result.success(renamed))

        assertEquals(Session.SignedIn(renamed), app.session.first { it == Session.SignedIn(renamed) })
    }

    @Test
    fun `an answer that arrives after a sign-out does not sign anyone back in`() = runTest(dispatcher) {
        val api = SlowServerApi()
        val app = AppState(api, remember(remembered), Preferences(store))
        app.session.first { it is Session.SignedIn }

        app.logOut()
        app.session.first { it is Session.SignedOut }
        api.answer(Result.success(remembered))
        testScheduler.advanceUntilIdle()

        assertEquals(Session.SignedOut, app.session.value)
    }

    @Test
    fun `signed out, the sign-in screen does not wait for the platform's address`() = runTest(dispatcher) {
        val app = AppState(NoAddressApi(), remember(null), Preferences(store))

        val opened = app.session.first { it !is Session.Restoring }

        assertTrue(opened is Session.SignedOut)
    }
}
