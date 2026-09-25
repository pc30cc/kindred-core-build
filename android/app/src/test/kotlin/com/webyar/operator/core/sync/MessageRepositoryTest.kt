package com.webyar.operator.core.sync

import com.webyar.operator.core.Diag
import com.webyar.operator.core.cache.CacheScope
import com.webyar.operator.core.cache.MemoryCacheStore
import com.webyar.operator.core.model.Message
import com.webyar.operator.core.model.SenderType
import com.webyar.operator.testing.ScriptedApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/**
 * The transcript's sync and the outbox — the rules that decide how many
 * rows a message becomes and how much a new one costs to fetch.
 */
class MessageRepositoryTest {

    private val scope = CacheScope("user-a", "ws-1")
    private val api = ScriptedApi()
    private val store = MemoryCacheStore()
    private var ids = 0
    private val repo = MessageRepository(api, store, clock = { api.now }, newId = { "client-${++ids}" }, diag = Diag.Silent)

    private suspend fun thread(scope: CacheScope = this.scope, id: String = "c-1"): List<Message> =
        repo.observeThread(scope, id).first()

    // MARK: - Delta

    @Test
    fun `the first open reads the whole thread and the next only what changed`() = runTest {
        api.seed("c-1", 3, spacingMs = 20_000)
        assertEquals(ThreadSync.Full(3), repo.sync(scope, "c-1", "open"))

        api.tick(60_000)
        api.post("c-1", "a new one")
        // The new row, and the one the cursor was taken from — which the
        // server's ten-second overlap always sends again, and the merge
        // absorbs.
        assertEquals(ThreadSync.Delta(2), repo.sync(scope, "c-1", "push"))

        assertEquals(listOf(null, api.threadReads[1]), api.threadReads)
        assertTrue("the second read carried a cursor", api.threadReads[1] != null)
        assertEquals(4, thread().size)
    }

    @Test
    fun `one new message in a long thread costs the overlap, not the thread`() = runTest {
        api.seed("c-1", 2_000)
        repo.sync(scope, "c-1", "open")
        api.tick(60_000)
        api.post("c-1", "hello")

        val second = repo.sync(scope, "c-1", "realtime")

        // One new row plus whatever changed in the ten seconds before the
        // cursor (ten rows here, one a second) — never the 2,000.
        assertEquals(ThreadSync.Delta(11), second)
        assertEquals(2_001, thread().size)
        assertEquals(2_001, thread().map { it.id }.toSet().size)
    }

    @Test
    fun `an edited message replaces its older copy`() = runTest {
        val first = api.seed("c-1", 2).first()
        repo.sync(scope, "c-1", "open")

        api.tick(60_000)
        api.edit("c-1", first.id, "edited")
        repo.sync(scope, "c-1", "delta")

        val rows = thread()
        assertEquals(2, rows.size)
        assertEquals("edited", rows.first { it.id == first.id }.body)
    }

    @Test
    fun `a delta never deletes, and a full read drops what the server no longer has`() = runTest {
        val rows = api.seed("c-1", 3)
        repo.sync(scope, "c-1", "open")
        api.threads.getValue("c-1").removeAll { it.id == rows[1].id }

        repo.sync(scope, "c-1", "delta")
        assertEquals(3, thread().size)

        repo.sync(scope, "c-1", "reconcile", forceFull = true)
        assertEquals(listOf(rows[0].id, rows[2].id), thread().map { it.id })
    }

    @Test
    fun `the same delta twice is still one row per message`() = runTest {
        api.seed("c-1", 2)
        repo.sync(scope, "c-1", "open")
        api.post("c-1", "once")

        repo.sync(scope, "c-1", "push")
        repo.sync(scope, "c-1", "realtime")
        repo.sync(scope, "c-1", "foreground")

        assertEquals(3, thread().size)
        assertEquals(3, thread().map { it.id }.toSet().size)
    }

    @Test
    fun `an old cursor converges on the same thread`() = runTest {
        api.seed("c-1", 5)
        repo.sync(scope, "c-1", "open")
        // A cursor from long ago: the whole thread comes back as "changed".
        store.thread(scope, "c-1") {
            putState(state()!!.copy(cursor = Instant.ofEpochMilli(api.now - 86_400_000).toString()))
        }
        repo.sync(scope, "c-1", "resume")

        assertEquals(5, thread().size)
    }

    @Test
    fun `an older copy of a message never overwrites a newer one`() = runTest {
        val original = api.seed("c-1", 1).first()
        api.tick(60_000)
        val newer = api.edit("c-1", original.id, "newer")
        repo.sync(scope, "c-1", "open")

        // The older copy arrives late — a stale response, a slow path.
        api.threads["c-1"] = mutableListOf(original)
        api.deltaSupported = false
        repo.sync(scope, "c-1", "late")

        assertEquals("newer", thread().single().body)
        assertEquals(newer.updatedAt, thread().single().updatedAt)
    }

    @Test
    fun `a conversation the server no longer has is removed here`() = runTest {
        api.seed("c-1", 2)
        repo.sync(scope, "c-1", "open")
        api.threads.remove("c-1")

        assertEquals(ThreadSync.Gone, repo.sync(scope, "c-1", "open"))
        assertTrue(thread().isEmpty())
        assertFalse(repo.isCached(scope, "c-1"))
    }

    @Test
    fun `a cursor is never ahead of the rows it covers`() = runTest {
        api.seed("c-1", 2)
        repo.sync(scope, "c-1", "open")
        val before = store.syncState(scope, "thread:c-1")!!.cursor
        api.post("c-1", "lost")
        api.failThreads = com.webyar.operator.core.net.ApiError.Transport(null)

        runCatching { repo.sync(scope, "c-1", "offline") }

        assertEquals(before, store.syncState(scope, "thread:c-1")!!.cursor)
        assertEquals(2, thread().size)
    }

    // MARK: - Sending

    @Test
    fun `a message is in the thread before any request is made`() = runTest {
        repo.enqueue(scope, "c-1", "hi", sender = null)

        val row = thread().single()
        assertEquals(Message.Delivery.PENDING, row.delivery)
        assertTrue(api.sendKeys.isEmpty())
    }

    @Test
    fun `a retry sends the same client_message_id`() = runTest {
        api.threads["c-1"] = mutableListOf()
        val local = repo.enqueue(scope, "c-1", "hi", sender = null)
        api.failSends = 1

        assertTrue(repo.deliver(scope, local) is SendOutcome.Failed)
        assertEquals(Message.Delivery.FAILED, thread().single().delivery)

        assertEquals(SendOutcome.Sent, repo.deliver(scope, local))
        assertEquals(listOf("client-1", "client-1"), api.sendKeys)
        assertEquals(Message.Delivery.SENT, thread().single().delivery)
    }

    @Test
    fun `a send whose answer was lost is not posted twice by its retry`() = runTest {
        api.threads["c-1"] = mutableListOf()
        val local = repo.enqueue(scope, "c-1", "once only", sender = null)
        api.loseNextAnswer = true

        repo.deliver(scope, local)
        repo.deliver(scope, local)

        assertEquals(1, api.agentMessages("c-1").size)
        assertEquals(1, thread().size)
    }

    @Test
    fun `send, realtime echo, push and delta are one row`() = runTest {
        api.seed("c-1", 1)
        repo.sync(scope, "c-1", "open")
        val local = repo.enqueue(scope, "c-1", "hello", sender = null)
        repo.deliver(scope, local)
        val server = api.agentMessages("c-1").single()

        repo.applyRealtime(scope, server.copy(updatedAt = null))
        repo.sync(scope, "c-1", "push")
        repo.sync(scope, "c-1", "delta")

        val rows = thread()
        assertEquals(2, rows.size)
        val mine = rows.single { it.senderType == SenderType.AGENT }
        assertEquals(server.id, mine.id)
        assertEquals(local, mine.localId)
        assertEquals(Message.Delivery.SENT, mine.delivery)
    }

    @Test
    fun `realtime before the send's own answer still makes one row`() = runTest {
        api.seed("c-1", 1)
        repo.sync(scope, "c-1", "open")
        val local = repo.enqueue(scope, "c-1", "race", sender = null)
        // The server stored it and published it; the HTTP answer is slower.
        val published = api.message("c-1", "race", SenderType.AGENT, clientId = "client-1")
        api.threads.getValue("c-1") += published
        repo.applyRealtime(scope, published)

        repo.deliver(scope, local)

        val mine = thread().filter { it.senderType == SenderType.AGENT }
        assertEquals(1, mine.size)
        assertEquals(published.id, mine.single().id)
        assertEquals(local, mine.single().localId)
    }

    @Test
    fun `realtime does not start a transcript this phone never read`() = runTest {
        val written = repo.applyRealtime(scope, api.message("c-9", "from nowhere"))

        assertFalse(written)
        assertTrue(thread(id = "c-9").isEmpty())
    }

    @Test
    fun `realtime fills a watched thread before its first read lands`() = runTest {
        repo.watch("c-9")
        assertTrue(repo.applyRealtime(scope, api.message("c-9", "early")))
        assertEquals(1, thread(id = "c-9").size)
    }

    @Test
    fun `realtime never overwrites a row a read already stored`() = runTest {
        val row = api.seed("c-1", 1).single()
        repo.sync(scope, "c-1", "open")

        repo.applyRealtime(scope, row.copy(body = "stale publication", updatedAt = null))

        assertEquals(row.body, thread().single().body)
    }

    @Test
    fun `the outbox survives the process, and only young sends are resumed`() = runTest {
        api.threads["c-1"] = mutableListOf()
        val young = repo.enqueue(scope, "c-1", "just now", sender = null)
        api.tick(MessageRepository.RESUME_WINDOW_MS + 60_000)
        val alsoYoung = repo.enqueue(scope, "c-1", "a moment ago", sender = null)

        // A new process: a new repository over the same store.
        val restarted = MessageRepository(api, store, clock = { api.now }, diag = Diag.Silent)
        val resumed = restarted.resumeOutbox(scope)

        assertEquals(listOf(alsoYoung), resumed)
        val rows = thread().associateBy { it.localId }
        assertEquals(Message.Delivery.FAILED, rows.getValue(young).delivery)
        assertEquals(Message.Delivery.PENDING, rows.getValue(alsoYoung).delivery)
    }

    @Test
    fun `discarding takes an unsent message out and leaves a sent one`() = runTest {
        api.threads["c-1"] = mutableListOf()
        val unsent = repo.enqueue(scope, "c-1", "never mind", sender = null)
        val sent = repo.enqueue(scope, "c-1", "keep", sender = null)
        repo.deliver(scope, sent)

        repo.discard(scope, unsent)
        repo.discard(scope, sent)

        assertEquals(listOf(sent), thread().map { it.localId })
    }

    // MARK: - Isolation

    @Test
    fun `another account or workspace never sees these rows`() = runTest {
        api.seed("c-1", 2)
        repo.sync(scope, "c-1", "open")

        assertTrue(thread(CacheScope("user-b", "ws-1")).isEmpty())
        assertTrue(thread(CacheScope("user-a", "ws-2")).isEmpty())
        assertNull(store.message(CacheScope("user-b", "ws-1"), thread().first().localId!!))
    }

    @Test
    fun `a row naming another conversation is not merged into this one`() = runTest {
        api.threads["c-1"] = mutableListOf(api.message("c-2", "wrong thread"))
        repo.sync(scope, "c-1", "open")
        assertTrue(thread().isEmpty())
    }

    @Test
    fun `a pending row keeps its client_message_id in metadata`() = runTest {
        repo.enqueue(scope, "c-1", "x", sender = null)
        assertEquals(
            buildJsonObject { put("client_message_id", JsonPrimitive("client-1")) },
            thread().single().metadata,
        )
    }
}
