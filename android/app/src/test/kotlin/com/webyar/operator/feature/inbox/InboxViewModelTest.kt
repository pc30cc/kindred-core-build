package com.webyar.operator.feature.inbox

import com.webyar.operator.core.model.EffectiveBool
import com.webyar.operator.core.model.Entitlements
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.core.model.WorkspaceAccess
import com.webyar.operator.core.net.SampleApi
import com.webyar.operator.i18n.Language
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * What the inbox decides before anything is drawn.
 *
 * Search is the reason most of this exists: it runs on the client, because the
 * conversations endpoint has no query parameter. That makes it ours to get
 * right — a server-side search is somebody else's tested code, and this is
 * not.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class InboxViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    private fun model(api: SampleApi = SampleApi()) = InboxViewModel(api) { Language.FA }

    private fun ids(state: InboxState): List<String> =
        (state as InboxState.Loaded).conversations.map { it.id }

    @Test
    fun `binding to a workspace loads the open queue`() = runTest(dispatcher) {
        val inbox = model()
        inbox.bind("ws-1")
        testScheduler.advanceUntilIdle()

        assertEquals(InboxFilter.OPEN, inbox.filter.value)
        assertTrue(ids(inbox.state.value).contains("c-1"))
    }

    @Test
    fun `searching narrows the list without going back to the server`() = runTest(dispatcher) {
        val inbox = model()
        inbox.bind("ws-1")
        testScheduler.advanceUntilIdle()
        val all = ids(inbox.state.value)

        inbox.setQuery("مریم")
        // Deliberately no advanceUntilIdle: a client-side search must be
        // answered in the same frame the key was pressed, not after a round
        // trip. If this ever needs the scheduler, it has become a request.
        assertEquals(listOf("c-1"), ids(inbox.state.value))

        inbox.setQuery("")
        assertEquals(all, ids(inbox.state.value))
    }

    @Test
    fun `search is case-insensitive and reaches the email`() = runTest(dispatcher) {
        val inbox = model()
        inbox.bind("ws-1")
        testScheduler.advanceUntilIdle()

        inbox.setQuery("ALEXANDER.KONSTANTINOPOULOS@")
        assertEquals(listOf("c-2"), ids(inbox.state.value))
    }

    /**
     * An anonymous visitor has no name and no email. The code on their avatar
     * is the only handle an operator has, so it has to be searchable — without
     * this they are simply unfindable.
     */
    @Test
    fun `a visitor with no name is still findable by their code`() = runTest(dispatcher) {
        val inbox = model()
        inbox.bind("ws-1")
        testScheduler.advanceUntilIdle()

        inbox.setQuery("8f2c")
        assertEquals(listOf("c-3"), ids(inbox.state.value))
    }

    @Test
    fun `search reaches the last message, not just the name`() = runTest(dispatcher) {
        val inbox = model()
        inbox.bind("ws-1")
        testScheduler.advanceUntilIdle()

        inbox.setQuery("timeout")
        assertEquals(listOf("c-2"), ids(inbox.state.value))
    }

    /**
     * Carrying the terms across a queue change would silently filter a list
     * nobody searched — the operator taps Resolved, sees three rows out of
     * forty, and has no idea why.
     */
    @Test
    fun `changing queue drops the search terms`() = runTest(dispatcher) {
        val inbox = model()
        inbox.bind("ws-1")
        testScheduler.advanceUntilIdle()

        inbox.setQuery("مریم")
        inbox.select(InboxFilter.RESOLVED)
        testScheduler.advanceUntilIdle()

        assertEquals("", inbox.query.value)
        assertTrue(ids(inbox.state.value).contains("c-5"))
    }

    @Test
    fun `a channel narrows whichever queue is open`() = runTest(dispatcher) {
        val inbox = model()
        inbox.bind("ws-1")
        testScheduler.advanceUntilIdle()

        inbox.selectChannel("telegram")
        assertEquals(listOf("c-3"), ids(inbox.state.value))

        // And back to everything, which is the ordinary case.
        inbox.selectChannel(null)
        assertTrue(ids(inbox.state.value).size > 1)
    }

    /**
     * The reported bug: pick a channel, then pick a different queue, and the
     * bar went on saying "Telegram" over a list that was no longer narrowed to
     * it — with no way to get the label off. A queue and a channel are
     * siblings in that menu, so choosing either drops the other, as on iOS.
     */
    @Test
    fun `picking a queue lifts the channel`() = runTest(dispatcher) {
        val inbox = model()
        inbox.bind("ws-1")
        testScheduler.advanceUntilIdle()
        inbox.selectChannel("telegram")
        assertEquals("telegram", inbox.channel.value)

        inbox.select(InboxFilter.RESOLVED)
        testScheduler.advanceUntilIdle()

        assertEquals(null, inbox.channel.value)
        assertEquals(InboxFilter.RESOLVED, inbox.filter.value)
    }

    /** Even when the queue tapped is the one already open. */
    @Test
    fun `re-picking the queue already open still lifts the channel`() = runTest(dispatcher) {
        val inbox = model()
        inbox.bind("ws-1")
        testScheduler.advanceUntilIdle()
        inbox.selectChannel("telegram")

        inbox.select(InboxFilter.OPEN)
        testScheduler.advanceUntilIdle()

        assertEquals(null, inbox.channel.value)
        assertTrue(ids(inbox.state.value).size > 1)
    }

    /** iOS: "A channel inbox shows what is open on it." */
    @Test
    fun `picking a channel returns to the open queue`() = runTest(dispatcher) {
        val inbox = model()
        inbox.bind("ws-1")
        testScheduler.advanceUntilIdle()
        inbox.select(InboxFilter.RESOLVED)
        testScheduler.advanceUntilIdle()

        inbox.selectChannel("telegram")
        testScheduler.advanceUntilIdle()

        assertEquals(InboxFilter.OPEN, inbox.filter.value)
        assertEquals("telegram", inbox.channel.value)
    }

    @Test
    fun `the counts and the channels arrive with the list`() = runTest(dispatcher) {
        val inbox = model()
        inbox.bind("ws-1")
        testScheduler.advanceUntilIdle()

        assertEquals(4, inbox.counts.value.open)
        assertTrue(inbox.channels.value.map { it.key }.contains("telegram"))
    }

    /** One batched call for the page, not one per row. */
    @Test
    fun `visitor intel is loaded for the rows that came back`() = runTest(dispatcher) {
        val inbox = model()
        inbox.bind("ws-1")
        testScheduler.advanceUntilIdle()

        assertEquals("Windows", inbox.intel.value["c-1"]?.device?.os)
    }

    @Test
    fun `switching workspace forgets the channel and the search`() = runTest(dispatcher) {
        val inbox = model()
        inbox.bind("ws-1")
        testScheduler.advanceUntilIdle()
        inbox.selectChannel("telegram")
        inbox.setQuery("مریم")

        inbox.bind("ws-2")
        assertEquals(null, inbox.channel.value)
        assertEquals("", inbox.query.value)
    }

    // MARK: - Which queues the plan allows

    @Test
    fun `a plan without the AI queue does not offer it`() {
        val bare = Entitlements(workspaceId = "ws-1")
        val available = InboxFilter.available(bare)

        assertFalse(available.contains(InboxFilter.AI))
        assertFalse(available.contains(InboxFilter.NEEDS_HUMAN))
        // The three every plan has, in the order they appear.
        assertEquals(
            listOf(InboxFilter.OPEN, InboxFilter.PENDING, InboxFilter.RESOLVED, InboxFilter.SPAM),
            available,
        )
        // The strip is the same list, so a queue the plan includes is never
        // reachable only by knowing that the screen's title is a menu.
        assertEquals(available, InboxFilter.chips(bare))
    }

    /**
     * Fail-closed, and it matters here: a null plan is "we do not know yet",
     * and offering a queue on a guess means offering one that answers 403.
     */
    @Test
    fun `an unresolved plan offers only the core queues`() {
        assertFalse(InboxFilter.available(null).contains(InboxFilter.AI))
        assertFalse(InboxFilter.available(null).contains(InboxFilter.NEEDS_HUMAN))
        assertEquals(InboxFilter.available(null), InboxFilter.chips(null))
    }

    /**
     * The strip and the menu are one list, not two.
     *
     * They used to differ: the strip carried Open and the AI queue, the menu
     * carried all six, and four of the six were reachable only by discovering
     * that the title was a menu. Nobody discovered it.
     */
    @Test
    fun `every queue the plan includes is on the strip`() {
        val full = Entitlements(
            workspaceId = "ws-1",
            features = mapOf(
                "inbox_ai_queue" to EffectiveBool(value = true),
                "inbox_needs_human" to EffectiveBool(value = true),
            ),
        )
        // The AI queue also needs the AI switched on, shown to customers and answering.
        val ai = WorkspaceAccess(role = "agent", aiAgentEnabled = true, aiCustomerVisible = true, aiAutoAnswer = true)
        assertEquals(InboxFilter.available(full, ai), InboxFilter.chips(full, ai))
        assertEquals(
            listOf(
                InboxFilter.OPEN,
                InboxFilter.NEEDS_HUMAN,
                InboxFilter.PENDING,
                InboxFilter.AI,
                InboxFilter.RESOLVED,
                InboxFilter.SPAM,
            ),
            InboxFilter.chips(full, ai),
        )
    }
}
