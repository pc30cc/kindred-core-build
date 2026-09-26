package com.webyar.operator.feature.inbox

import com.webyar.operator.core.cache.CacheScope
import com.webyar.operator.core.cache.MemoryCacheStore
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.core.model.InboxPage
import com.webyar.operator.core.net.ApiError
import com.webyar.operator.core.sync.SyncGraph
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.StrAndroid
import com.webyar.operator.testing.ScriptedApi
import kotlinx.coroutines.CompletableDeferred
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The inbox from the cache first: a cold start, a phone offline, a late
 * answer for a workspace the operator already left.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class InboxLocalFirstTest {

    private val dispatcher = StandardTestDispatcher()
    private val appScope = CoroutineScope(SupervisorJob() + dispatcher)
    private val api = ScriptedApi()
    private val store = MemoryCacheStore()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)

    @After fun tearDown() {
        appScope.cancel()
        Dispatchers.resetMain()
    }

    private fun model(api: ScriptedApi = this.api) =
        InboxViewModel(api, SyncGraph.inMemory(api, store, appScope, clock = { api.now })) { Language.EN }

    private fun ids(state: InboxState) = (state as InboxState.Loaded).conversations.map { it.id }

    private suspend fun cache(vararg ids: String) {
        store.writeConversations(
            CacheScope(SyncGraph.LOCAL_ACCOUNT, "ws-1"),
            ids.map { api.row(it) },
            listKey = InboxFilter.OPEN.wire,
            replaceList = true,
            now = api.now,
        )
    }

    @Test
    fun `a cold start with nothing cached shows the skeleton, then the rows`() = runTest(dispatcher) {
        api.put(InboxFilter.OPEN, api.row("c-1"))
        val inbox = model()
        inbox.bind("ws-1")
        assertEquals(InboxState.Loading, inbox.state.value)

        testScheduler.advanceUntilIdle()
        assertEquals(listOf("c-1"), ids(inbox.state.value))
    }

    @Test
    fun `offline with a cache shows the cache and says so, instead of an error screen`() = runTest(dispatcher) {
        cache("c-1", "c-2")
        api.failLists = ApiError.Transport(null)

        val inbox = model()
        inbox.bind("ws-1")
        testScheduler.advanceUntilIdle()

        assertEquals(listOf("c-2", "c-1"), ids(inbox.state.value))
        assertEquals(StrAndroid.showingSaved(Language.EN), inbox.syncProblem.value)
    }

    @Test
    fun `offline with nothing cached is the one case that shows the error`() = runTest(dispatcher) {
        api.failLists = ApiError.Transport(null)
        val inbox = model()
        inbox.bind("ws-1")
        testScheduler.advanceUntilIdle()

        assertTrue(inbox.state.value is InboxState.Failed)
    }

    @Test
    fun `a failed refresh keeps the rows already on screen`() = runTest(dispatcher) {
        api.put(InboxFilter.OPEN, api.row("c-1"))
        val inbox = model()
        inbox.bind("ws-1")
        testScheduler.advanceUntilIdle()

        api.failLists = ApiError.Server(503, null)
        inbox.refresh()
        testScheduler.advanceUntilIdle()

        assertEquals(listOf("c-1"), ids(inbox.state.value))
        assertTrue(inbox.syncProblem.value != null)
        assertEquals(false, inbox.refreshing.value)
    }

    @Test
    fun `the problem line clears once a read works again`() = runTest(dispatcher) {
        cache("c-1")
        api.failLists = ApiError.Transport(null)
        val inbox = model()
        inbox.bind("ws-1")
        testScheduler.advanceUntilIdle()

        api.failLists = null
        api.put(InboxFilter.OPEN, api.row("c-1"))
        inbox.refresh()
        testScheduler.advanceUntilIdle()

        assertNull(inbox.syncProblem.value)
    }

    @Test
    fun `a late answer for the workspace just left does not reach the new one`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val slow = object : ScriptedApi() {
            override suspend fun inboxPage(workspaceId: String, filter: InboxFilter, etag: String?): InboxPage {
                if (workspaceId == "ws-1") gate.await()
                return super.inboxPage(workspaceId, filter, etag)
            }
        }
        slow.put(InboxFilter.OPEN, slow.row("a-1", workspaceId = "ws-1"), slow.row("b-1", workspaceId = "ws-2"))
        val inbox = model(slow)

        inbox.bind("ws-1")
        testScheduler.runCurrent()
        inbox.bind("ws-2")
        testScheduler.advanceUntilIdle()
        assertEquals(listOf("b-1"), ids(inbox.state.value))

        gate.complete(Unit)
        testScheduler.advanceUntilIdle()
        assertEquals(listOf("b-1"), ids(inbox.state.value))
    }

    @Test
    fun `switching to the needs-human queue reads that queue`() = runTest(dispatcher) {
        val inbox = model()
        inbox.bind("ws-1")
        testScheduler.advanceUntilIdle()
        inbox.select(InboxFilter.NEEDS_HUMAN)
        testScheduler.advanceUntilIdle()

        assertEquals(InboxFilter.NEEDS_HUMAN, api.listReads.last().first)
        assertTrue(InboxFilter.NEEDS_HUMAN.needsHumanOnly)
    }
}
