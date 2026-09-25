package com.webyar.operator.feature.chat

import com.webyar.operator.core.cache.CacheScope
import com.webyar.operator.core.cache.MemoryCacheStore
import com.webyar.operator.core.model.Message
import com.webyar.operator.core.model.SenderType
import com.webyar.operator.core.net.ApiError
import com.webyar.operator.core.sync.MessageRepository
import com.webyar.operator.core.sync.SyncGraph
import com.webyar.operator.i18n.Language
import com.webyar.operator.testing.ScriptedApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The chat from the cache, and the outbox as the operator meets it: the
 * bubble before the request, Retry that cannot double-post, a thread that
 * reads offline.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatOutboxTest {

    private val dispatcher = StandardTestDispatcher()
    private val appScope = CoroutineScope(SupervisorJob() + dispatcher)
    private val api = ScriptedApi()
    private val store = MemoryCacheStore()
    private val scope = CacheScope(SyncGraph.LOCAL_ACCOUNT, "ws-1")

    @Before fun setUp() = Dispatchers.setMain(dispatcher)

    @After fun tearDown() {
        appScope.cancel()
        Dispatchers.resetMain()
    }

    private fun model() = ChatViewModel(api, SyncGraph.inMemory(api, store, appScope, clock = { api.now })) { Language.EN }

    private fun messages(chat: ChatViewModel): List<Message> = (chat.chat.value as ChatState.Loaded).messages

    @Test
    fun `a thread read before opens from the cache while offline`() = runTest(dispatcher) {
        api.seed("c-1", 3)
        MessageRepository(api, store, clock = { api.now }).sync(scope, "c-1", "earlier")
        api.failThreads = ApiError.Transport(null)

        val chat = model()
        chat.open("c-1", "ws-1")
        testScheduler.advanceUntilIdle()

        assertEquals(3, messages(chat).size)
    }

    @Test
    fun `opening a thread read before asks only for what changed`() = runTest(dispatcher) {
        api.seed("c-1", 3)
        MessageRepository(api, store, clock = { api.now }).sync(scope, "c-1", "earlier")

        val chat = model()
        chat.open("c-1", "ws-1")
        testScheduler.advanceUntilIdle()

        assertTrue("a delta, with a cursor", api.threadReads.last() != null)
    }

    @Test
    fun `a message is on screen before the server has it, and the draft clears`() = runTest(dispatcher) {
        api.threads["c-1"] = mutableListOf()
        val chat = model()
        chat.open("c-1", "ws-1")
        testScheduler.advanceUntilIdle()
        api.failSends = 1

        chat.setDraft("hello")
        chat.send()
        testScheduler.advanceUntilIdle()

        val bubble = messages(chat).single()
        assertEquals("hello", bubble.body)
        assertEquals(Message.Delivery.FAILED, bubble.delivery)
        assertEquals("", chat.draft.value)
    }

    @Test
    fun `retry sends the same message with the same key, once`() = runTest(dispatcher) {
        api.threads["c-1"] = mutableListOf()
        val chat = model()
        chat.open("c-1", "ws-1")
        testScheduler.advanceUntilIdle()
        api.loseNextAnswer = true

        chat.setDraft("only once")
        chat.send()
        testScheduler.advanceUntilIdle()
        chat.retry(messages(chat).single())
        testScheduler.advanceUntilIdle()

        assertEquals(1, api.agentMessages("c-1").size)
        assertEquals(1, api.sendKeys.toSet().size)
        assertEquals(2, api.sendKeys.size)
        assertEquals(Message.Delivery.SENT, messages(chat).single().delivery)
    }

    @Test
    fun `discarding a failed message removes it`() = runTest(dispatcher) {
        api.threads["c-1"] = mutableListOf()
        val chat = model()
        chat.open("c-1", "ws-1")
        testScheduler.advanceUntilIdle()
        api.failSends = 1
        chat.setDraft("never mind")
        chat.send()
        testScheduler.advanceUntilIdle()

        chat.discard(messages(chat).single())
        testScheduler.advanceUntilIdle()

        assertTrue(messages(chat).isEmpty())
    }

    @Test
    fun `a conversation opened by id alone is fetched for its header`() = runTest(dispatcher) {
        api.put(com.webyar.operator.core.model.InboxFilter.OPEN, api.row("c-7", name = "Maryam"))
        api.threads["c-7"] = mutableListOf(api.message("c-7", "hi", SenderType.CONTACT))

        val chat = model()
        chat.open("c-7", "ws-1")
        testScheduler.advanceUntilIdle()

        assertEquals("Maryam", chat.conversation.value?.contact?.name)
        assertEquals(listOf("c-7"), api.byIdReads)
    }

    @Test
    fun `a conversation that no longer exists says so`() = runTest(dispatcher) {
        val chat = model()
        chat.open("c-gone", "ws-1")
        testScheduler.advanceUntilIdle()

        assertTrue(chat.chat.value is ChatState.Failed)
    }
}
