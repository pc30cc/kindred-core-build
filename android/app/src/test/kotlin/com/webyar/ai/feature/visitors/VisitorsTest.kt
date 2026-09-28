package com.webyar.ai.feature.visitors

import com.webyar.ai.core.model.LiveVisitor
import com.webyar.ai.core.model.StartChatResult
import com.webyar.ai.core.model.VisitorContactRef
import com.webyar.ai.core.model.VisitorConversationRef
import com.webyar.ai.core.model.VisitorGeo
import com.webyar.ai.core.model.VisitorPageEntry
import com.webyar.ai.core.model.VisitorPageHistory
import com.webyar.ai.core.model.VisitorPageView
import com.webyar.ai.core.net.SampleApi
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.i18n.Language
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Visitors tab: the words the Mac and web use for a visitor, and the
 * model's list, filters and "start chat".
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class VisitorsTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    // MARK: - The words

    @Test
    fun `a named contact is called by name`() {
        val v = LiveVisitor("s1", contact = VisitorContactRef("c1", name = "Sara Ahmadi"))
        assertEquals("Sara Ahmadi", VisitorText.name(v, Language.EN))
    }

    @Test
    fun `an anonymous visitor is named by the province in Iran and the city elsewhere`() {
        val tehran = LiveVisitor(
            "s1",
            geo = VisitorGeo(country = "Iran", countryCode = "IR", region = "Razavi Khorasan", city = "Mashhad"),
            contact = VisitorContactRef("c1", visitorCode = "4ZTK"),
        )
        assertEquals("Visitor from \u2068Razavi Khorasan\u2069 · \u20684ZTK\u2069", VisitorText.name(tehran, Language.EN))

        val berlin = tehran.copy(geo = VisitorGeo(country = "Germany", countryCode = "DE", region = "Berlin", city = "Berlin"))
        assertEquals("Visitor from \u2068Berlin\u2069 · \u20684ZTK\u2069", VisitorText.name(berlin, Language.EN))

        val nowhere = tehran.copy(geo = null)
        assertEquals("Visitor · \u20684ZTK\u2069", VisitorText.name(nowhere, Language.EN))
    }

    /** The values `anonCodeFrom` in server/services/widget/anonymousContact.ts gives for the same seeds. */
    @Test
    fun `the fallback code is the server's anonCodeFrom`() {
        assertEquals("5QUB", VisitorText.legacyCode("vs-3"))
        assertEquals("002P", VisitorText.legacyCode("a"))
        assertEquals("3B21", VisitorText.legacyCode("0b8c1d2e-3f40-4a5b-9c6d-7e8f90a1b2c3"))
    }

    @Test
    fun `addresses lose the scheme and read decoded`() {
        assertEquals("webyar.app", VisitorText.shortUrl("https://webyar.app/"))
        assertEquals("webyar.app/pricing?plan=pro", VisitorText.shortUrl("https://webyar.app/pricing?plan=pro"))
        assertEquals("webyar.app/fa/درباره", VisitorText.shortUrl("https://webyar.app/fa/%D8%AF%D8%B1%D8%A8%D8%A7%D8%B1%D9%87"))
        assertEquals("", VisitorText.shortUrl(null))
    }

    @Test
    fun `the place names each part once`() {
        assertEquals("Tehran، Iran", VisitorText.location(VisitorGeo(country = "Iran", countryCode = "IR", region = "Tehran", city = "Tehran")))
        assertEquals(
            "Mashhad، Razavi Khorasan، Iran",
            VisitorText.location(VisitorGeo(country = "Iran", countryCode = "IR", region = "Razavi Khorasan", city = "Mashhad")),
        )
        assertNull(VisitorText.location(VisitorGeo()))
    }

    @Test
    fun `the visit reads from the way in to where they are, a page read twice in a row once`() {
        val t = Instant.parse("2026-09-27T10:00:00Z")
        val history = VisitorPageHistory(
            entry = VisitorPageEntry(landingUrl = "https://a.test/", landedAt = t),
            // Newest first, as the server sends them.
            items = listOf(
                VisitorPageView(3, "https://a.test/pricing", viewedAt = t.plusSeconds(90)),
                VisitorPageView(2, "https://a.test/pricing", viewedAt = t.plusSeconds(60)),
                VisitorPageView(1, "https://a.test/", viewedAt = t),
            ),
            current = VisitorPageView(4, "https://a.test/pricing", viewedAt = t.plusSeconds(90)),
        )
        val steps = VisitorText.steps(history, Language.EN)
        assertEquals(listOf("Entry point", "Currently on"), steps.map { it.label })
        assertEquals(listOf("https://a.test/", "https://a.test/pricing"), steps.map { it.url })
        assertEquals(listOf(false, true), steps.map { it.current })
    }

    // MARK: - The model

    @Test
    fun `the list is newest activity first, and offline visitors only when asked for`() = runTest(dispatcher) {
        val model = VisitorsViewModel(SampleApi()) { Language.EN }
        model.bind("ws-1")
        model.load()
        assertEquals(listOf("vs-1", "vs-4", "vs-2", "vs-3"), model.state.value.visitors.map { it.id })

        model.setIncludeOffline(true)
        model.load()
        assertEquals(listOf("vs-1", "vs-4", "vs-2", "vs-3", "vs-5"), model.state.value.visitors.map { it.id })
    }

    @Test
    fun `the filters narrow the list and clearing them keeps include offline`() = runTest(dispatcher) {
        val model = VisitorsViewModel(SampleApi()) { Language.EN }
        model.bind("ws-1")
        model.setIncludeOffline(true)
        model.load()
        fun shown() = model.state.value.visible(Language.EN).map { it.id }

        model.setOnlineOnly(true)
        assertEquals(listOf("vs-1", "vs-4", "vs-2"), shown())
        model.setOnlineOnly(false)

        model.setChatOnly(true)
        assertEquals(listOf("vs-1"), shown())
        model.setChatOnly(false)

        model.setCountry("IR")
        assertEquals(listOf("vs-1", "vs-3"), shown())

        model.setSearch("mashhad")
        assertEquals(listOf("vs-3"), shown())

        model.clearFilters()
        assertEquals(5, shown().size)
        assertEquals(true, model.state.value.filters.includeOffline)
    }

    @Test
    fun `a visitor already in a chat opens it without asking the server`() = runTest(dispatcher) {
        val api = CountingApi()
        val model = VisitorsViewModel(api) { Language.EN }
        model.bind("ws-1")
        var opened: String? = null
        model.chat(LiveVisitor("s1", conversation = VisitorConversationRef("conv-9"))) { opened = it }
        testScheduler.advanceUntilIdle()

        assertEquals("conv-9", opened)
        assertEquals(0, api.started)
    }

    @Test
    fun `starting a chat opens the new conversation and marks the row`() = runTest(dispatcher) {
        val api = CountingApi()
        val model = VisitorsViewModel(api) { Language.EN }
        model.bind("ws-1")
        model.load()
        val visitor = model.state.value.visitors.first { it.id == "vs-2" }
        var opened: String? = null
        model.chat(visitor) { opened = it }
        testScheduler.advanceUntilIdle()

        assertEquals("conv-new", opened)
        assertEquals(1, api.started)
        assertEquals("conv-new", model.state.value.visitors.first { it.id == "vs-2" }.conversation?.id)
        assertEquals(false, model.chatBusy.value)
    }

    private class CountingApi(private val real: SampleApi = SampleApi()) : WebyarApi by real {
        var started = 0

        override suspend fun startChatWithVisitor(workspaceId: String, sessionId: String): StartChatResult {
            started++
            return StartChatResult(ok = true, conversationId = "conv-new", created = true)
        }
    }
}
