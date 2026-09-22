package com.webyar.operator.feature.promo

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.webyar.operator.core.model.EffectiveBool
import com.webyar.operator.core.model.EffectiveInt
import com.webyar.operator.core.model.Entitlements
import com.webyar.operator.core.model.PromoCreative
import com.webyar.operator.core.model.Promotions
import com.webyar.operator.core.net.SampleApi
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.i18n.Language
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.TestScope
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
import java.time.Instant

/**
 * The pacing, mostly.
 *
 * Every number here is a rule an operator experiences — not before the third
 * launch, at most three a day, six hours apart — and every one of them is the
 * difference between a promotion and a nuisance. They are also the part
 * nobody can check by looking at the screen once.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PromotionTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    private fun counters(): PromoCounters {
        val context = ApplicationProvider.getApplicationContext<Context>()
        // A file per test, so one test's third launch is not another's.
        val prefs = context.getSharedPreferences(
            "promo.test.${System.nanoTime()}",
            Context.MODE_PRIVATE,
        )
        return PromoCounters(prefs)
    }

    private fun plan(
        banner: Boolean = true,
        fullscreen: Boolean = true,
        intervalMinutes: Int? = null,
    ) = Entitlements(
        workspaceId = "ws-1",
        features = buildMap {
            put("mobile_promo_banner", EffectiveBool(value = banner))
            put("mobile_promo_fullscreen", EffectiveBool(value = fullscreen))
        },
        limits = intervalMinutes?.let {
            mapOf("mobile_promo_interval_minutes" to EffectiveInt(value = it))
        },
    )

    private val creative = PromoCreative(title = "A", body = "B")

    private fun promotions(
        enabled: Boolean = true,
        maxPerDay: Int? = null,
        minIntervalMinutes: Int? = null,
        startAfterLaunches: Int? = null,
    ) = Promotions(
        enabled = enabled,
        banner = creative,
        fullscreen = creative,
        maxPerDay = maxPerDay,
        minIntervalMinutes = minIntervalMinutes,
        startAfterLaunches = startAfterLaunches,
    )

    /**
     * A center that has already loaded a given set of promotions.
     *
     * Through the real `load`, over a backend that answers with what the test
     * wants — rather than a `seedForTest` on the production class. A hook
     * that exists only for tests is a second way into the object, and the one
     * the app uses stops being the one that is checked.
     */
    private fun TestScope.center(store: PromoCounters, promotions: Promotions): PromotionCenter =
        PromotionCenter(FakePromoApi(promotions), store).also {
            it.load("ws-1", Language.FA)
            testScheduler.advanceUntilIdle()
        }

    /** The sample backend, with one answer replaced. */
    private class FakePromoApi(
        private val answer: Promotions,
        private val real: SampleApi = SampleApi(),
    ) : WebyarApi by real {
        override suspend fun promotions(workspaceId: String, locale: String): Promotions = answer
    }

    // MARK: - The banner

    @Test
    fun `the banner needs the plan, the platform and no dismissal`() = runTest(dispatcher) {
        val store = counters()

        assertNotNull(center(store, promotions()).banner(plan()))
        // Plan says no.
        assertNull(center(store, promotions()).banner(plan(banner = false)))
        // Platform says no.
        assertNull(center(store, promotions(enabled = false)).banner(plan()))
        // Fail-closed while the plan is still unknown.
        assertNull(center(store, promotions()).banner(null))
    }

    @Test
    fun `dismissing the banner means it for the session`() = runTest(dispatcher) {
        val model = center(counters(), promotions())
        assertNotNull(model.banner(plan()))

        model.dismissBanner()
        assertNull(model.banner(plan()))
    }

    // MARK: - The full-screen card

    /**
     * Counted before anything is shown, so "skip the first two launches"
     * means the first two and not the first two that asked.
     */
    @Test
    fun `nothing is offered during the first launches`() = runTest(dispatcher) {
        val store = counters()
        val model = center(store, promotions(startAfterLaunches = 2))

        store.noteLaunch()
        model.offerFullScreen(plan())
        assertNull(model.fullscreen.value)

        store.noteLaunch()
        model.offerFullScreen(plan())
        assertNull(model.fullscreen.value)

        // The third.
        store.noteLaunch()
        model.offerFullScreen(plan())
        assertNotNull(model.fullscreen.value)
    }

    @Test
    fun `showing one records it against the daily cap`() = runTest(dispatcher) {
        val store = counters()
        repeat(3) { store.noteLaunch() }
        assertEquals(0, store.todayCount)

        val model = center(store, promotions(minIntervalMinutes = 0))
        model.offerFullScreen(plan())

        assertNotNull(model.fullscreen.value)
        assertEquals(1, store.todayCount)
        assertNotNull(store.lastShownAt)
    }

    @Test
    fun `the daily cap is respected`() = runTest(dispatcher) {
        val store = counters()
        repeat(9) { store.noteLaunch() }

        repeat(2) {
            val model = center(store, promotions(maxPerDay = 2, minIntervalMinutes = 0))
            model.offerFullScreen(plan())
            assertNotNull(model.fullscreen.value)
            model.dismissFullScreen()
        }
        assertEquals(2, store.todayCount)

        // The third asks and is refused.
        val third = center(store, promotions(maxPerDay = 2, minIntervalMinutes = 0))
        third.offerFullScreen(plan())
        assertNull(third.fullscreen.value)
    }

    /** A cap of zero means none, not "the default of three". */
    @Test
    fun `a cap of zero shows nothing`() = runTest(dispatcher) {
        val store = counters()
        repeat(9) { store.noteLaunch() }

        val model = center(store, promotions(maxPerDay = 0, minIntervalMinutes = 0))
        model.offerFullScreen(plan())
        assertNull(model.fullscreen.value)
    }

    @Test
    fun `two inside the interval is one`() = runTest(dispatcher) {
        val store = counters()
        repeat(9) { store.noteLaunch() }

        val first = center(store, promotions(minIntervalMinutes = 360))
        first.offerFullScreen(plan())
        assertNotNull(first.fullscreen.value)

        val second = center(store, promotions(minIntervalMinutes = 360))
        second.offerFullScreen(plan())
        assertNull(second.fullscreen.value)
    }

    /**
     * A plan may ask for a LONGER gap than the platform's, never a shorter
     * one: a paid plan that still carries promotions should be able to make
     * them rarer, and must not be able to make them more frequent.
     */
    @Test
    fun `the plan can lengthen the interval but not shorten it`() = runTest(dispatcher) {
        val lengthening = counters()
        repeat(9) { lengthening.noteLaunch() }
        // Platform says no gap; the plan asks for six hours.
        center(lengthening, promotions(minIntervalMinutes = 0)).also {
            it.offerFullScreen(plan())
            assertNotNull(it.fullscreen.value)
        }
        center(lengthening, promotions(minIntervalMinutes = 0)).also {
            it.offerFullScreen(plan(intervalMinutes = 360))
            assertNull(it.fullscreen.value)
        }

        val shortening = counters()
        repeat(9) { shortening.noteLaunch() }
        // Platform says six hours; the plan asks for none and is ignored.
        center(shortening, promotions(minIntervalMinutes = 360)).also {
            it.offerFullScreen(plan())
            assertNotNull(it.fullscreen.value)
        }
        center(shortening, promotions(minIntervalMinutes = 360)).also {
            it.offerFullScreen(plan(intervalMinutes = 0))
            assertNull(it.fullscreen.value)
        }
    }

    @Test
    fun `an unresolved plan offers nothing`() = runTest(dispatcher) {
        val store = counters()
        repeat(9) { store.noteLaunch() }

        val model = center(store, promotions(minIntervalMinutes = 0))
        model.offerFullScreen(null)
        assertNull(model.fullscreen.value)
        // And nothing was counted against the cap for a card never shown.
        assertEquals(0, store.todayCount)
    }

    @Test
    fun `offering twice does not stack two cards`() = runTest(dispatcher) {
        val store = counters()
        repeat(9) { store.noteLaunch() }

        val model = center(store, promotions(minIntervalMinutes = 0))
        model.offerFullScreen(plan())
        model.offerFullScreen(plan())

        assertEquals(1, store.todayCount)
    }

    // MARK: - The link

    /**
     * Scheme-checked in the model, not at the tap: a `cta_url` of `intent://`
     * or `javascript:` would otherwise be handed straight to the system.
     */
    @Test
    fun `only an https link is offered`() = runTest(dispatcher) {
        assertEquals(
            "https://webyar.app/x",
            PromoCreative("t", "b", ctaUrl = "https://webyar.app/x").safeLink,
        )
        assertNull(PromoCreative("t", "b", ctaUrl = "http://webyar.app/x").safeLink)
        assertNull(PromoCreative("t", "b", ctaUrl = "intent://webyar.app#Intent;end").safeLink)
        assertNull(PromoCreative("t", "b", ctaUrl = "javascript:alert(1)").safeLink)
        assertNull(PromoCreative("t", "b").safeLink)
    }

    // MARK: - Loading

    @Test
    fun `a suppressed run loads nothing at all`() = runTest(dispatcher) {
        val store = counters()
        val model = PromotionCenter(SampleApi(), store)

        model.load(workspaceId = null, language = Language.FA)
        testScheduler.advanceUntilIdle()
        assertFalse(model.promotions.value.enabled)
    }

    @Test
    fun `the day rolls over`() = runTest(dispatcher) {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val prefs = context.getSharedPreferences("promo.day.${System.nanoTime()}", Context.MODE_PRIVATE)
        val store = PromoCounters(prefs)
        repeat(9) { store.noteLaunch() }
        store.recordShown()
        assertEquals(1, store.todayCount)

        // Yesterday's count is not today's. Written through the same key the
        // store uses, deliberately: renaming it silently resets everybody's
        // counters, and this test is what would notice.
        prefs.edit().putString("promo.day", "1999-01-01").commit()
        assertEquals(0, store.todayCount)
    }

    @Test
    fun `last shown survives a round trip through the store`() = runTest(dispatcher) {
        val store = counters()
        val before = Instant.now()
        store.recordShown()

        val recorded = store.lastShownAt
        assertNotNull(recorded)
        assertTrue(!recorded!!.isBefore(before.minusSeconds(1)))
    }
}
