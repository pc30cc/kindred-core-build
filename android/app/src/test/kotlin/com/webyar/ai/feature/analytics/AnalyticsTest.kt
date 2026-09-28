package com.webyar.ai.feature.analytics

import com.webyar.ai.core.model.AnalyticsDay
import com.webyar.ai.core.model.AnalyticsEvents
import com.webyar.ai.core.model.AnalyticsOverview
import com.webyar.ai.core.net.ApiError
import com.webyar.ai.core.net.SampleApi
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.i18n.Language
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
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
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Website analytics: the range's days, what each report asks for, and the
 * rules the Mac app's model keeps — an old range's answer is dropped, the
 * period before is only an extra, a 403 locks the page.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AnalyticsTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    /** Just after midnight UTC, when "today" in Tehran and in UTC are the same day. */
    private val clock = Clock.fixed(Instant.parse("2026-09-27T01:00:00Z"), ZoneOffset.UTC)

    // MARK: - The range

    @Test
    fun `a range ends today and the period before ends the day before it starts`() {
        assertEquals("2026-09-21" to "2026-09-27", AnalyticsRange.WEEK.bounds(clock))
        assertEquals("2026-08-31" to "2026-09-27", AnalyticsRange.MONTH.bounds(clock))
        assertEquals("2026-08-03" to "2026-08-30", AnalyticsRange.MONTH.previousBounds(clock))
        assertEquals("2026-06-30" to "2026-09-27", AnalyticsRange.QUARTER.bounds(clock))
    }

    // MARK: - The model

    @Test
    fun `the overview asks for the range and for the period before`() = runTest(dispatcher) {
        val api = RecordingApi()
        val model = AnalyticsViewModel(api, { Language.EN }, clock = clock)
        model.bind("ws-1")
        model.load(AnalyticsSection.OVERVIEW)
        testScheduler.advanceUntilIdle()

        assertEquals(setOf("2026-08-31" to "2026-09-27", "2026-08-03" to "2026-08-30"), api.overviews.toSet())
        assertNotNull(model.state.value.overview)
        assertNotNull(model.state.value.previous)
        assertTrue(model.state.value.loading.isEmpty())

        // Already here for this range: not asked for again.
        model.load(AnalyticsSection.OVERVIEW)
        testScheduler.advanceUntilIdle()
        assertEquals(2, api.overviews.size)
    }

    @Test
    fun `an answer for the range before is dropped`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val api = RecordingApi(holdFirst = gate)
        val model = AnalyticsViewModel(api, { Language.EN }, clock = clock)
        model.bind("ws-1")
        model.load(AnalyticsSection.OVERVIEW)
        testScheduler.advanceUntilIdle()

        model.setRange(AnalyticsRange.WEEK)
        testScheduler.advanceUntilIdle()
        assertEquals(7, model.state.value.overview?.sessions)

        // The 28-day answer lands late, and changes nothing.
        gate.complete(Unit)
        testScheduler.advanceUntilIdle()
        assertEquals(7, model.state.value.overview?.sessions)
        assertEquals(AnalyticsRange.WEEK, model.state.value.range)
    }

    @Test
    fun `the period before failing leaves the page as it is`() = runTest(dispatcher) {
        val api = RecordingApi(failPrevious = true)
        val model = AnalyticsViewModel(api, { Language.EN }, clock = clock)
        model.bind("ws-1")
        model.load(AnalyticsSection.OVERVIEW)
        testScheduler.advanceUntilIdle()

        assertNotNull(model.state.value.overview)
        assertNull(model.state.value.previous)
        assertNull(model.state.value.error)
        assertFalse(model.state.value.locked)
    }

    @Test
    fun `a 403 locks the page and has the tabs look at the plan again`() = runTest(dispatcher) {
        var asked = 0
        val api = object : WebyarApi by SampleApi() {
            override suspend fun analyticsEvents(workspaceId: String, start: String, end: String): AnalyticsEvents =
                throw ApiError.Server(403, "not in plan")
        }
        val model = AnalyticsViewModel(api, { Language.EN }, onLocked = { asked++ }, clock = clock)
        model.bind("ws-1")
        model.load(AnalyticsSection.EVENTS)
        testScheduler.advanceUntilIdle()

        assertTrue(model.state.value.locked)
        assertEquals(1, asked)
        assertNull(model.state.value.error)
    }

    @Test
    fun `a dimension is its own report`() = runTest(dispatcher) {
        val model = AnalyticsViewModel(SampleApi(), { Language.EN }, clock = clock)
        model.bind("ws-1")
        model.load(AnalyticsSection.GEOGRAPHY)
        testScheduler.advanceUntilIdle()
        assertEquals("Iran", model.state.value.breakdowns["geo.country"]?.rows?.first()?.key)

        model.setGeoDimension("language")
        testScheduler.advanceUntilIdle()
        assertEquals("fa-IR", model.state.value.breakdowns["geo.language"]?.rows?.first()?.key)
        // The country report is kept for going back to it.
        assertNotNull(model.state.value.breakdowns["geo.country"])
    }

    // MARK: - The numbers

    @Test
    fun `numbers, shares and durations in each language`() {
        assertEquals("12,480", AnalyticsFormat.count(12_480, Language.EN))
        assertEquals("۱۲", AnalyticsFormat.count(12, Language.FA))
        assertEquals("4.5%", AnalyticsFormat.percent(0.045, Language.EN))
        assertEquals("38%", AnalyticsFormat.percent(0.38, Language.EN))
        assertEquals("2 m 14 s", AnalyticsFormat.duration(134.0, Language.EN))
        assertEquals("38 s", AnalyticsFormat.duration(38.0, Language.EN))
        // From an hour up the seconds go, as they would not fit a phone's tile.
        assertEquals("4 h 0 m", AnalyticsFormat.duration(14_448.0, Language.EN))
        assertEquals("Direct", AnalyticsFormat.channel("direct", Language.EN))
        assertEquals("brand_new", AnalyticsFormat.channel("brand_new", Language.EN))
        assertEquals("Unknown", AnalyticsFormat.unknown("(unknown)", Language.EN))
        assertEquals("Iran", AnalyticsFormat.country("Iran", Language.EN).second)
        assertEquals(LocalDate.of(2026, 9, 27), AnalyticsFormat.day("2026-09-27"))
        assertNull(AnalyticsFormat.day("not a day"))
        assertEquals(0.5, AnalyticsFormat.change(150.0, 100.0)!!, 1e-9)
        assertNull(AnalyticsFormat.change(150.0, 0.0))
    }

    /** The chart spans the range's days, not only the days something happened. */
    @Test
    fun `the trend fills the days the server has no row for`() {
        val filled = AnalyticsFormat.fillDays(
            listOf(AnalyticsDay("2026-09-23", 5, 9), AnalyticsDay("2026-09-26", 2, 3)),
            "2026-09-21",
            "2026-09-27",
        )
        assertEquals(7, filled.size)
        assertEquals("2026-09-21", filled.first().date)
        assertEquals(listOf(0, 0, 5, 0, 0, 2, 0), filled.map { it.sessions })
    }

    /** Records the overview's ranges; can hold the first answer back, or fail the period before. */
    private class RecordingApi(
        private val holdFirst: CompletableDeferred<Unit>? = null,
        private val failPrevious: Boolean = false,
        private val real: SampleApi = SampleApi(),
    ) : WebyarApi by real {
        val overviews = mutableListOf<Pair<String, String>>()

        override suspend fun analyticsOverview(workspaceId: String, start: String, end: String): AnalyticsOverview {
            overviews += start to end
            val days = ChronoUnit.DAYS.between(LocalDate.parse(start), LocalDate.parse(end)).toInt() + 1
            if (holdFirst != null && overviews.size == 1) holdFirst.await()
            if (failPrevious && end == "2026-08-30") throw ApiError.Server(500, null)
            return AnalyticsOverview(sessions = days)
        }
    }
}
