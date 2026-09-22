package com.webyar.operator.feature.settings

import com.webyar.operator.core.model.NotificationPrefs
import com.webyar.operator.core.model.NotificationPrefsUpdate
import com.webyar.operator.core.net.ApiError
import com.webyar.operator.core.net.SampleApi
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.i18n.Language
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The notifications screen has no Save button, which puts the whole weight
 * on two rules.
 *
 * The first is the one the availability section already lives by: a switch
 * sends the one field it changed and nothing else, or two signed-in phones
 * quietly undo each other.
 *
 * The second is what a screen without a Save button owes the operator — a
 * switch that moved and then failed has to move back. Leaving it where they
 * put it is a lie the app repeats every time they open the screen.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class NotificationsViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    private fun TestScope.model(api: StubPrefsApi = StubPrefsApi()) =
        NotificationsViewModel(api) { Language.EN }.also { testScheduler.advanceUntilIdle() }

    // MARK: - Loading

    @Test
    fun `the operator's saved settings are what the screen shows`() = runTest(dispatcher) {
        val api = StubPrefsApi(
            initial = LIVE_SHAPED.copy(playSound = false, emailTranscripts = true),
        )
        val state = model(api).state.value

        assertFalse(state.loading)
        assertEquals(false, state.prefs?.playSound)
        assertEquals(true, state.prefs?.emailTranscripts)
        assertNull(state.loadError)
    }

    @Test
    fun `a screen that cannot be read says so rather than showing defaults`() = runTest(dispatcher) {
        val state = model(StubPrefsApi(loadError = ApiError.Server(503, null))).state.value

        assertNull("defaults would look like real settings", state.prefs)
        assertNotNull(state.loadError)
    }

    @Test
    fun `a retry after a failure loads`() = runTest(dispatcher) {
        val api = StubPrefsApi(loadError = ApiError.Server(503, null))
        val model = model(api)
        assertNull(model.state.value.prefs)

        api.loadError = null
        model.load()
        testScheduler.advanceUntilIdle()

        assertNotNull(model.state.value.prefs)
        assertNull(model.state.value.loadError)
    }

    // MARK: - Saving

    @Test
    fun `a switch sends only the field it changed`() = runTest(dispatcher) {
        val api = StubPrefsApi()
        val model = model(api)

        model.set({ it.copy(playSound = false) }, NotificationPrefsUpdate(playSound = false))
        testScheduler.advanceUntilIdle()

        val sent = api.lastUpdate!!
        assertEquals(false, sent.playSound)
        assertNull("every other key has to stay null", sent.disableAll)
        assertNull(sent.emailUnreadMessages)
        assertNull(sent.quietHoursEnabled)
    }

    @Test
    fun `the switch moves before the server answers`() = runTest(dispatcher) {
        val api = StubPrefsApi(hold = CompletableDeferred())
        val model = model(api)

        model.set({ it.copy(playSound = false) }, NotificationPrefsUpdate(playSound = false))
        testScheduler.advanceUntilIdle()

        assertEquals(false, model.state.value.prefs?.playSound)
        assertTrue(model.state.value.isSaving)
    }

    @Test
    fun `a refused change puts the switch back`() = runTest(dispatcher) {
        val api = StubPrefsApi(patchError = ApiError.Server(500, null))
        val model = model(api)
        assertEquals(true, model.state.value.prefs?.playSound)

        model.set({ it.copy(playSound = false) }, NotificationPrefsUpdate(playSound = false))
        testScheduler.advanceUntilIdle()

        assertEquals(true, model.state.value.prefs?.playSound)
        assertNotNull(model.state.value.saveError)
        assertFalse(model.state.value.isSaving)
    }

    /**
     * The reason the rollback is field-by-field rather than a snapshot
     * restore: two switches can be in flight at once, and putting the whole
     * row back would undo the one that succeeded.
     */
    @Test
    fun `a rollback leaves a change that landed meanwhile alone`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val api = StubPrefsApi(hold = gate, patchError = ApiError.Server(500, null))
        val model = model(api)

        // One switch, held open and destined to fail.
        model.set({ it.copy(playSound = false) }, NotificationPrefsUpdate(playSound = false))
        testScheduler.advanceUntilIdle()

        // A second switch answered while the first is still in flight.
        api.hold = null
        api.patchError = null
        model.set(
            { it.copy(emailTranscripts = true) },
            NotificationPrefsUpdate(emailTranscripts = true),
        )
        testScheduler.advanceUntilIdle()

        // Now the first one comes back refused.
        gate.complete(Unit)
        testScheduler.advanceUntilIdle()

        val prefs = model.state.value.prefs!!
        assertEquals("the refused switch goes back", true, prefs.playSound)
        assertEquals("the one that landed stays", true, prefs.emailTranscripts)
    }

    @Test
    fun `a switch set to what it already is sends nothing`() = runTest(dispatcher) {
        val api = StubPrefsApi()
        val model = model(api)

        model.set({ it.copy(playSound = true) }, NotificationPrefsUpdate(playSound = true))
        testScheduler.advanceUntilIdle()

        assertNull("an unchanged switch is not a change", api.lastUpdate)
    }

    @Test
    fun `the server's answer wins over the local guess`() = runTest(dispatcher) {
        // A server that normalises: turning the master switch on silences
        // the rest, and it says so in its answer.
        val api = StubPrefsApi(normalise = { it.copy(playSound = false) })
        val model = model(api)

        model.set({ it.copy(disableAll = true) }, NotificationPrefsUpdate(disableAll = true))
        testScheduler.advanceUntilIdle()

        assertEquals(true, model.state.value.prefs?.disableAll)
        assertEquals(
            "a field the app did not touch still comes from the server",
            false,
            model.state.value.prefs?.playSound,
        )
    }

    /**
     * The deployed server sends no `email_*` keys at all. A screen that
     * turned a missing key into `false` would show six switches the
     * operator's own server has never heard of.
     */
    @Test
    fun `a preference the server did not send stays absent`() = runTest(dispatcher) {
        val api = StubPrefsApi(
            initial = NotificationPrefs(disableAll = false, playSound = true),
        )
        val prefs = model(api).state.value.prefs!!

        assertNull(prefs.emailUnreadMessages)
        assertNull(prefs.pushVisitorBrowsing)
        assertNull(prefs.pushScope)
        assertNull("a scope that was never sent is not a scope", prefs.scope)
    }

    @Test
    fun `the four scopes map onto the wire values the server uses`() {
        assertEquals(NotificationPrefs.Scope.ALL, NotificationPrefs(pushScope = "all").scope)
        assertEquals(NotificationPrefs.Scope.ASSIGNED, NotificationPrefs(pushScope = "assigned").scope)
        assertEquals(NotificationPrefs.Scope.MENTIONS, NotificationPrefs(pushScope = "mentions").scope)
        assertEquals(NotificationPrefs.Scope.NONE, NotificationPrefs(pushScope = "none").scope)
        // A value this build has not met is not guessed at.
        assertNull(NotificationPrefs(pushScope = "whatever-comes-next").scope)
    }

    @Test
    fun `a later success clears an earlier failure`() = runTest(dispatcher) {
        val api = StubPrefsApi(patchError = ApiError.Server(500, null))
        val model = model(api)
        model.set({ it.copy(playSound = false) }, NotificationPrefsUpdate(playSound = false))
        testScheduler.advanceUntilIdle()
        assertNotNull(model.state.value.saveError)

        api.patchError = null
        model.set({ it.copy(emailTranscripts = true) }, NotificationPrefsUpdate(emailTranscripts = true))
        testScheduler.advanceUntilIdle()

        assertNull(model.state.value.saveError)
    }

    private companion object {
        /** What `api.webyar.ai` actually answers, trimmed to what is asserted. */
        val LIVE_SHAPED = NotificationPrefs(
            disableAll = false,
            pushScope = "all",
            pushPreview = true,
            pushInternalNotes = true,
            pushWhenOnline = true,
            pushWhenOffline = true,
            playSound = true,
            emailTranscripts = false,
            quietHoursEnabled = false,
        )
    }

    /** The sample backend with the preferences replaced by something steerable. */
    private class StubPrefsApi(
        private val real: SampleApi = SampleApi(),
        /**
         * Shaped like the deployed server's answer. Every field a test
         * asserts on has to be non-null, because null now means "this
         * server does not have this preference" and the screen draws
         * nothing for it.
         */
        initial: NotificationPrefs = LIVE_SHAPED,
        var loadError: Throwable? = null,
        var patchError: Throwable? = null,
        /** Held open to keep a change in flight for as long as a test needs. */
        var hold: CompletableDeferred<Unit>? = null,
        private val normalise: (NotificationPrefs) -> NotificationPrefs = { it },
    ) : WebyarApi by real {

        var lastUpdate: NotificationPrefsUpdate? = null
            private set

        private var prefs = initial

        override suspend fun notificationPrefs(): NotificationPrefs {
            loadError?.let { throw it }
            return prefs
        }

        override suspend fun updateNotificationPrefs(
            update: NotificationPrefsUpdate,
        ): NotificationPrefs {
            lastUpdate = update
            // Captured before awaiting, so a second call can change them
            // while this one is parked.
            val gate = hold
            val failure = patchError
            gate?.await()
            failure?.let { throw it }
            prefs = normalise(
                prefs.copy(
                    disableAll = update.disableAll ?: prefs.disableAll,
                    playSound = update.playSound ?: prefs.playSound,
                    emailTranscripts = update.emailTranscripts ?: prefs.emailTranscripts,
                    quietHoursEnabled = update.quietHoursEnabled ?: prefs.quietHoursEnabled,
                    quietHoursStart = update.quietHoursStart ?: prefs.quietHoursStart,
                    quietHoursEnd = update.quietHoursEnd ?: prefs.quietHoursEnd,
                ),
            )
            return prefs
        }
    }
}
