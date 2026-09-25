package com.webyar.operator.core.cache

import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.ConversationContact
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/**
 * What every [CacheStore] must answer, and answer the same.
 *
 * Run twice: against the in-memory store the JVM tests use, and against
 * Room under Robolectric — so the sync layer's tests, which run on the
 * first, are testing the behaviour the app gets from the second.
 */
abstract class CacheStoreContract {

    abstract fun store(): CacheStore

    protected val a = CacheScope("user-a", "ws-1")
    private val otherWorkspace = CacheScope("user-a", "ws-2")
    private val otherAccount = CacheScope("user-b", "ws-1")

    protected fun conversation(id: String, updated: Long, workspace: String = "ws-1") = Conversation(
        id = id,
        workspaceId = workspace,
        updatedAt = Instant.ofEpochMilli(updated),
        contact = ConversationContact(name = "Visitor $id"),
        unreadCount = 1,
    )

    protected fun message(
        scope: CacheScope,
        localId: String,
        conversationId: String = "c-1",
        serverId: String? = localId.removePrefix("s:"),
        sortAt: Long = 0,
        state: SendState = SendState.SENT,
        clientId: String? = null,
    ) = MessageEntity(
        accountId = scope.accountId,
        localId = localId,
        workspaceId = scope.workspaceId,
        conversationId = conversationId,
        serverId = serverId,
        clientMessageId = clientId,
        senderType = "contact",
        senderId = null,
        senderName = null,
        senderAvatar = null,
        body = "body $localId",
        createdAt = sortAt,
        updatedAt = sortAt,
        metadataJson = null,
        attachmentsJson = null,
        sendState = state.code,
        outboxAttachmentId = null,
        sortAt = sortAt,
        cachedAt = sortAt,
    )

    @Test
    fun `a queue lists newest first and a full read replaces it`() = runBlocking {
        val store = store()
        store.writeConversations(a, listOf(conversation("c-1", 10), conversation("c-2", 20)), "open", replaceList = true, now = 1)
        assertEquals(listOf("c-2", "c-1"), store.observeList(a, "open").first().map { it.id })

        store.writeConversations(a, listOf(conversation("c-3", 30)), "open", replaceList = true, now = 2)
        assertEquals(listOf("c-3"), store.observeList(a, "open").first().map { it.id })
        // Out of the queue is not out of the cache.
        assertEquals("c-1", store.conversation(a, "c-1")?.id)
    }

    @Test
    fun `a targeted write adds what is present and removes what is absent`() = runBlocking {
        val store = store()
        store.writeConversations(a, listOf(conversation("c-1", 10), conversation("c-2", 20)), "open", replaceList = true, now = 1)

        store.writeConversations(a, listOf(conversation("c-3", 30)), "open", absent = listOf("c-1"), now = 2)

        assertEquals(listOf("c-3", "c-2"), store.observeList(a, "open").first().map { it.id })
    }

    @Test
    fun `an older row does not replace a newer one`() = runBlocking {
        val store = store()
        store.writeConversations(a, listOf(conversation("c-1", 20).copy(unreadCount = 5)), now = 1)
        store.writeConversations(a, listOf(conversation("c-1", 10).copy(unreadCount = 1)), now = 2)
        assertEquals(5, store.conversation(a, "c-1")?.unreadCount)
    }

    @Test
    fun `rows round-trip whole`() = runBlocking {
        val store = store()
        val original = conversation("c-1", 10).copy(tags = listOf("vip", "billing"), subject = "Refund")
        store.writeConversations(a, listOf(original), now = 1)
        val back = store.conversation(a, "c-1")!!
        assertEquals(original.tags, back.tags)
        assertEquals(original.subject, back.subject)
        assertEquals(original.contact, back.contact)
        assertEquals(original.updatedAt, back.updatedAt)
    }

    @Test
    fun `nothing crosses an account or a workspace`() = runBlocking {
        val store = store()
        store.writeConversations(a, listOf(conversation("c-1", 10)), "open", replaceList = true, now = 1)
        store.thread(a, "c-1") { upsert(listOf(message(a, "s:m-1"))) }
        store.putSyncState(a, SyncStateEntity(a.accountId, a.workspaceId, "thread:c-1", "cur", null, null, null, 1))

        for (other in listOf(otherWorkspace, otherAccount)) {
            assertTrue(store.observeList(other, "open").first().isEmpty())
            assertNull(store.conversation(other, "c-1"))
            assertTrue(store.observeThread(other, "c-1").first().isEmpty())
            assertNull(store.syncState(other, "thread:c-1"))
        }
    }

    @Test
    fun `a transcript is in thread order, pending last`() = runBlocking {
        val store = store()
        store.thread(a, "c-1") {
            upsert(
                listOf(
                    message(a, "s:m-2", sortAt = 20),
                    message(a, "l:x", serverId = null, sortAt = 30, state = SendState.PENDING, clientId = "x"),
                    message(a, "s:m-1", sortAt = 10),
                ),
            )
        }
        assertEquals(listOf("s:m-1", "s:m-2", "l:x"), store.observeThread(a, "c-1").first().map { it.localId })
    }

    @Test
    fun `a failed transaction leaves nothing behind`() = runBlocking {
        val store = store()
        runCatching {
            store.thread(a, "c-1") {
                upsert(listOf(message(a, "s:m-1")))
                error("half way")
            }
        }
        assertTrue(store.observeThread(a, "c-1").first().isEmpty())
    }

    @Test
    fun `signing out removes that account and only that account`() = runBlocking {
        val store = store()
        store.writeConversations(a, listOf(conversation("c-1", 10)), "open", replaceList = true, now = 1)
        store.writeConversations(otherAccount, listOf(conversation("c-1", 10)), "open", replaceList = true, now = 1)
        store.thread(a, "c-1") { upsert(listOf(message(a, "s:m-1"))) }

        store.purgeAccount("user-a")

        assertNull(store.conversation(a, "c-1"))
        assertTrue(store.observeThread(a, "c-1").first().isEmpty())
        assertEquals("c-1", store.conversation(otherAccount, "c-1")?.id)
    }

    @Test
    fun `clear cache keeps what has not been sent`() = runBlocking {
        val store = store()
        store.writeConversations(a, listOf(conversation("c-1", 10), conversation("c-2", 20)), "open", replaceList = true, now = 1)
        store.thread(a, "c-1") {
            upsert(
                listOf(
                    message(a, "s:m-1", sortAt = 1),
                    message(a, "l:x", serverId = null, sortAt = 2, state = SendState.FAILED, clientId = "x"),
                ),
            )
            putState(SyncStateEntity(a.accountId, a.workspaceId, "thread:c-1", "cur", null, 1, null, 1))
        }

        store.clear()

        assertEquals(listOf("l:x"), store.observeThread(a, "c-1").first().map { it.localId })
        assertNull("cursors go with the rows", store.syncState(a, "thread:c-1"))
        assertTrue(store.observeList(a, "open").first().isEmpty())
        assertNull(store.conversation(a, "c-2"))
        assertEquals("the outbox keeps its conversation", "c-1", store.conversation(a, "c-1")?.id)
    }

    @Test
    fun `retention weighs threads least recently opened first`() = runBlocking {
        val store = store()
        store.writeConversations(a, listOf(conversation("c-1", 10), conversation("c-2", 20), conversation("c-3", 30)), now = 1)
        store.markOpened(a, "c-1", 500)
        store.markOpened(a, "c-2", 100)
        listOf("c-1", "c-2", "c-3").forEach { id ->
            store.thread(a, id) { upsert(listOf(message(a, "s:$id-m", conversationId = id))) }
        }

        assertEquals(listOf("c-3", "c-2", "c-1"), store.threadWeights().map { it.conversationId })
    }

    @Test
    fun `evicting a thread keeps its outbox and drops its cursor`() = runBlocking {
        val store = store()
        store.thread(a, "c-1") {
            upsert(
                listOf(
                    message(a, "s:m-1"),
                    message(a, "l:x", serverId = null, sortAt = 5, state = SendState.PENDING, clientId = "x"),
                ),
            )
            putState(SyncStateEntity(a.accountId, a.workspaceId, "thread:c-1", "cur", null, 1, null, 1))
        }

        store.evictThread(a.accountId, a.workspaceId, "c-1")

        assertEquals(listOf("l:x"), store.observeThread(a, "c-1").first().map { it.localId })
        assertNull(store.syncState(a, "thread:c-1"))
    }

    @Test
    fun `an orphan conversation is dropped, a listed one is kept`() = runBlocking {
        val store = store()
        store.writeConversations(a, listOf(conversation("c-listed", 10)), "open", replaceList = true, now = 1)
        store.writeConversations(a, listOf(conversation("c-orphan", 10)), now = 1)

        assertEquals(1, store.dropOrphanConversations(before = 100))
        assertNull(store.conversation(a, "c-orphan"))
        assertEquals("c-listed", store.conversation(a, "c-listed")?.id)
    }
}

class MemoryCacheStoreTest : CacheStoreContract() {
    override fun store(): CacheStore = MemoryCacheStore()
}
