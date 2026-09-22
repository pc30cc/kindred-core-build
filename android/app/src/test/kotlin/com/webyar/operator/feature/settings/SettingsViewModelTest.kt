package com.webyar.operator.feature.settings

import com.webyar.operator.core.model.AvailabilityPrefs
import com.webyar.operator.core.model.AvailabilityResponse
import com.webyar.operator.core.model.AvailabilityStatus
import com.webyar.operator.core.model.AvailabilityUpdate
import com.webyar.operator.core.net.ApiError
import com.webyar.operator.core.net.SampleApi
import com.webyar.operator.core.net.WebyarApi
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The availability section.
 *
 * One rule carries most of the weight here: a toggle sends the one field it
 * changed and nothing else. The server reads null as "leave alone", so a
 * screen that posted its whole local view of the preferences each time would
 * put two open devices into a fight — the second save would quietly undo
 * whatever the first had changed on the other one.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SettingsViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    private fun TestScope.model(api: StubAvailabilityApi = StubAvailabilityApi()) =
        SettingsViewModel(api).also { testScheduler.advanceUntilIdle() }

    // MARK: - Loading

    @Test
    fun `the section loads`() = runTest(dispatcher) {
        val settings = model()
        val state = settings.availability.value

        assertTrue(state is AvailabilityState.Loaded)
        assertEquals(false, state.prefs?.forceOffline)
        assertEquals(true, state.isOnline)
    }

    @Test
    fun `a load that fails says so rather than showing defaults`() = runTest(dispatcher) {
        val settings = model(StubAvailabilityApi(loadError = ApiError.Transport()))

        assertEquals(AvailabilityState.Failed, settings.availability.value)
        // Failed is not Loaded-with-everything-off: an operator must not be
        // shown three switches in the off position by a request that never
        // arrived.
        assertNull(settings.availability.value.prefs)
        assertNull(settings.availability.value.isOnline)
    }

    // MARK: - One field at a time

    @Test
    fun `each toggle sends its own field and leaves the others null`() = runTest(dispatcher) {
        val api = StubAvailabilityApi()
        val settings = model(api)

        settings.setForceOffline(true)
        testScheduler.advanceUntilIdle()
        assertEquals(AvailabilityUpdate(forceOffline = true), api.lastUpdate)

        settings.setAvailableWhenUsingApp(true)
        testScheduler.advanceUntilIdle()
        assertEquals(AvailabilityUpdate(availableWhenUsingApp = true), api.lastUpdate)

        settings.setScheduleEnabled(true)
        testScheduler.advanceUntilIdle()
        assertEquals(AvailabilityUpdate(scheduleEnabled = true), api.lastUpdate)
    }

    /** Switching a toggle off sends `false`, which is not the same as null. */
    @Test
    fun `turning something off sends false, not nothing`() = runTest(dispatcher) {
        val api = StubAvailabilityApi()
        val settings = model(api)

        settings.setForceOffline(false)
        testScheduler.advanceUntilIdle()

        assertEquals(false, api.lastUpdate?.forceOffline)
        assertNull(api.lastUpdate?.availableWhenUsingApp)
        assertNull(api.lastUpdate?.scheduleEnabled)
    }

    // MARK: - When the save is refused

    /**
     * The switch stays where the server last said it was, not where the thumb
     * left it. A toggle that looks saved and is not is worse than one that
     * visibly springs back.
     */
    @Test
    fun `a refused save leaves the switch where the server had it`() = runTest(dispatcher) {
        val api = StubAvailabilityApi(patchError = ApiError.Server(500, null))
        val settings = model(api)
        val before = settings.availability.value

        settings.setForceOffline(true)
        testScheduler.advanceUntilIdle()

        assertTrue(settings.saveFailed.value)
        assertEquals(before, settings.availability.value)
    }

    @Test
    fun `a save that works clears the last failure`() = runTest(dispatcher) {
        val api = StubAvailabilityApi(patchError = ApiError.Transport())
        val settings = model(api)

        settings.setForceOffline(true)
        testScheduler.advanceUntilIdle()
        assertTrue(settings.saveFailed.value)

        api.patchError = null
        settings.setForceOffline(true)
        testScheduler.advanceUntilIdle()

        assertFalse(settings.saveFailed.value)
        assertEquals(true, settings.availability.value.prefs?.forceOffline)
    }

    @Test
    fun `the failure notice can be dismissed`() = runTest(dispatcher) {
        val settings = model(StubAvailabilityApi(patchError = ApiError.Transport()))

        settings.setForceOffline(true)
        testScheduler.advanceUntilIdle()
        assertTrue(settings.saveFailed.value)

        settings.dismissSaveFailure()
        assertFalse(settings.saveFailed.value)
    }

    /**
     * The sample backend with availability replaced by something that records
     * what it was sent and can refuse.
     */
    private class StubAvailabilityApi(
        private val real: SampleApi = SampleApi(),
        private val loadError: Throwable? = null,
        var patchError: Throwable? = null,
    ) : WebyarApi by real {

        var lastUpdate: AvailabilityUpdate? = null
            private set

        private var prefs = AvailabilityPrefs(timezone = "Asia/Tehran")

        override suspend fun availability(): AvailabilityResponse {
            loadError?.let { throw it }
            return AvailabilityResponse(prefs, AvailabilityStatus(state = "online"))
        }

        override suspend fun updateAvailability(update: AvailabilityUpdate): AvailabilityResponse {
            lastUpdate = update
            patchError?.let { throw it }
            prefs = prefs.copy(
                forceOffline = update.forceOffline ?: prefs.forceOffline,
                availableWhenUsingApp = update.availableWhenUsingApp ?: prefs.availableWhenUsingApp,
                scheduleEnabled = update.scheduleEnabled ?: prefs.scheduleEnabled,
            )
            return AvailabilityResponse(prefs, AvailabilityStatus(state = "online"))
        }
    }
}
