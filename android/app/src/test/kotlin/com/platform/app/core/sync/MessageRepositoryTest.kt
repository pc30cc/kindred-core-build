package com.platform.app.core.sync

import com.platform.app.core.Diag
import com.platform.app.core.cache.CacheScope
import com.platform.app.core.cache.MemoryCacheStore
import com.platform.app.core.cache.SyncKeys
import com.platform.app.core.model.Message
import com.platform.app.core.model.OlderCursor
import com.platform.app.core.model.SenderType
import com.platform.app.testing.ScriptedApi
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
        // The first open is the newest page, not the thread.
        assertEquals(ThreadSync.Full(MessageRepository.PAGE_SIZE), repo.sync(scope, "c-1", "open"))
        assertEquals(listOf<Int?>(MessageRepository.PAGE_SIZE), api.pageLimits)
        api.tick(60_000)
        api.post("c-1", "hello")

        val second = repo.sync(scope, "c-1", "realtime")

        // One new row plus whatever changed in the ten seconds before the
        // cursor (ten rows here, one a second) — never the 2,000.
        assertEquals(ThreadSync.Delta(11), second)
        assertEquals(MessageRepository.PAGE_SIZE + 1, thread().size)
        assertEquals(MessageRepository.PAGE_SIZE + 1, thread().map { it.id }.toSet().size)
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
        api.failThreads = com.platform.app.core.net.ApiError.Transport(null)

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

    // MARK: - Pages (docs/operations/THREAD_PAGING_APPS.md)

    private suspend fun older(): OlderState = repo.olderState(scope, "c-1")

    @Test
    fun `a long thread opens on its newest page, and loading earlier puts the page before in front`() = runTest {
        val rows = api.seed("c-1", 250)
        repo.sync(scope, "c-1", "open")
        assertEquals(rows.takeLast(100).map { it.id }, thread().map { it.id })
        assertTrue(older() is OlderState.Before)

        assertEquals(OlderLoad.Loaded(100, more = true), repo.loadOlder(scope, "c-1"))
        assertEquals(rows.takeLast(200).map { it.id }, thread().map { it.id })
        assertEquals(OlderLoad.Loaded(50, more = false), repo.loadOlder(scope, "c-1"))
        assertEquals(rows.map { it.id }, thread().map { it.id })
        assertEquals(OlderState.AtStart, older())
        assertEquals(OlderLoad.NoMore, repo.loadOlder(scope, "c-1"))
    }

    // Hard case 1: a delta can bring a message older than the run (a seen,
    // a reaction or a file bumps its updated_at); it would sit above a hole.
    @Test
    fun `case 1 - a delta or realtime row older than the run is not written until loading earlier brings it`() = runTest {
        val rows = api.seed("c-1", 250)
        repo.sync(scope, "c-1", "open")
        api.tick(60_000)
        val bumped = api.edit("c-1", rows[10].id, "seen now")
        val newest = api.post("c-1", "new")

        repo.sync(scope, "c-1", "delta")
        val held = thread().map { it.id }
        assertFalse("the old row is not above a hole", bumped.id in held)
        assertTrue(newest.id in held)
        // Realtime alike: an old row is not written, a new one is.
        assertFalse(repo.applyRealtime(scope, rows[20].copy(updatedAt = null)))
        assertFalse(rows[20].id in thread().map { it.id })
        // An edit of a row the run holds still lands.
        api.edit("c-1", rows[240].id, "edited in the run")
        repo.sync(scope, "c-1", "delta")
        assertEquals("edited in the run", thread().single { it.id == rows[240].id }.body)

        repo.loadOlder(scope, "c-1")
        repo.loadOlder(scope, "c-1")
        assertEquals("seen now", thread().single { it.id == bumped.id }.body)
        assertEquals(251, thread().size)
    }

    // Hard case 2: hidden Telegram menu taps are filtered after the limit,
    // so the newest page can come back empty while earlier messages exist.
    @Test
    fun `case 2 - an empty newest page is read past, so the thread never opens empty`() = runTest {
        val rows = api.seed("c-1", 150)
        api.hidden += rows.takeLast(100).map { it.id }
        assertEquals(ThreadSync.Full(50), repo.sync(scope, "c-1", "open"))
        assertEquals(rows.take(50).map { it.id }, thread().map { it.id })
        assertEquals(1, api.olderReads.size)
        assertEquals(OlderState.AtStart, older())

        // An older page with nothing to show is read past too.
        val more = api.seed("c-2", 350)
        api.hidden += more.subList(150, 250).map { it.id }
        repo.sync(scope, "c-2", "open")
        assertEquals(OlderLoad.Loaded(100, more = true), repo.loadOlder(scope, "c-2"))
        assertEquals(more.subList(50, 150).map { it.id }, thread(id = "c-2").take(100).map { it.id })
    }

    // Hard case 3: `older` stays the server's strings, microseconds kept.
    @Test
    fun `case 3 - the older cursor goes back exactly as the server wrote it`() = runTest {
        val rows = api.seed("c-1", 150)
        repo.sync(scope, "c-1", "open")
        val first = rows[50]
        val expected = OlderCursor(api.micros(first.createdAt!!), first.id)
        assertEquals(OlderState.Before(expected), older())
        assertTrue(expected.before.endsWith(".000000+00:00"))

        repo.loadOlder(scope, "c-1")
        assertEquals(listOf(expected), api.olderReads)
    }

    // Hard case 4: an older page's own cursor is the newest updated_at of
    // that page; it never moves the thread's cursor nor its full-read time.
    @Test
    fun `case 4 - an older page never moves the sync cursor nor the full-read time`() = runTest {
        val rows = api.seed("c-1", 150)
        repo.sync(scope, "c-1", "open")
        val before = store.syncState(scope, SyncKeys.thread("c-1"))!!
        api.tick(60_000)
        // The older page's newest updated_at is now ahead of the thread's cursor.
        api.edit("c-1", rows[3].id, "edited")
        api.tick(60_000)

        repo.loadOlder(scope, "c-1")
        val after = store.syncState(scope, SyncKeys.thread("c-1"))!!
        assertEquals(before.cursor, after.cursor)
        assertEquals(before.fullReadAt, after.fullReadAt)
        // And the next delta still brings what is new since that cursor.
        val fresh = api.post("c-1", "new")
        repo.sync(scope, "c-1", "delta")
        assertTrue(fresh.id in thread().map { it.id })
    }

    // Hard case 5: a newest-page read keeps the older pages while they are
    // contiguous, and restarts the run (never a hole) when more than a page arrived.
    @Test
    fun `case 5 - a newest-page read keeps contiguous older pages and restarts after a gap`() = runTest {
        val rows = api.seed("c-1", 250)
        repo.sync(scope, "c-1", "open")
        repo.loadOlder(scope, "c-1")
        val loadedStart = older()
        val few = (1..3).map { api.post("c-1", "few $it") }

        repo.sync(scope, "c-1", "reconcile", forceFull = true)
        assertEquals(rows.takeLast(200).map { it.id } + few.map { it.id }, thread().map { it.id })
        assertEquals(loadedStart, older())

        val many = (1..150).map { api.post("c-1", "many $it") }
        repo.sync(scope, "c-1", "reconcile", forceFull = true)
        // The run starts again from the page: the newest 100, no hole.
        assertEquals(many.takeLast(100).map { it.id }, thread().map { it.id })
        assertEquals(OlderState.Before(OlderCursor(api.micros(many[50].createdAt!!), many[50].id)), older())
    }

    @Test
    fun `case 5 - a realtime row past a gap does not make the run look contiguous`() = runTest {
        api.seed("c-1", 150)
        repo.sync(scope, "c-1", "open")
        // 150 more arrive; only the newest reaches the phone, by realtime
        // (no updated_at), so it sits past a gap after the run.
        val more = (1..150).map { api.post("c-1", "more $it") }
        assertTrue(repo.applyRealtime(scope, more.last().copy(updatedAt = null)))

        repo.sync(scope, "c-1", "reconcile", forceFull = true)
        // Restarted from the page: no hole between the old run and the page.
        assertEquals(more.takeLast(100).map { it.id }, thread().map { it.id })
        assertEquals(OlderState.Before(OlderCursor(api.micros(more[50].createdAt!!), more[50].id)), older())
    }

    @Test
    fun `an older page that answers after the run restarted is dropped`() = runTest {
        var during: (suspend () -> Unit)? = null
        val racing = object : ScriptedApi() {
            override suspend fun messagesPage(
                conversationId: String,
                cursor: String?,
                limit: Int?,
                before: OlderCursor?,
            ): com.platform.app.core.model.MessagesPage {
                if (before != null) during?.let { during = null; it() }
                return super.messagesPage(conversationId, cursor, limit, before)
            }
        }
        val repo = MessageRepository(racing, store, clock = { racing.now }, diag = Diag.Silent)
        racing.seed("c-1", 250)
        repo.sync(scope, "c-1", "open")
        // While the older page is out, more than a page arrives and a
        // newest-page read restarts the run.
        during = {
            repeat(150) { racing.post("c-1", "flood $it") }
            repo.sync(scope, "c-1", "reconcile", forceFull = true)
        }
        assertEquals(OlderLoad.Stale, repo.loadOlder(scope, "c-1"))
        assertEquals(racing.threads.getValue("c-1").takeLast(100).map { it.id }, thread().map { it.id })
    }

    // Hard case 6: deletions inside the newest page are reconciled; in
    // older loaded pages they are not (documented).
    @Test
    fun `case 6 - deletions in the newest page are reconciled, in older loaded pages they stay`() = runTest {
        val rows = api.seed("c-1", 250)
        repo.sync(scope, "c-1", "open")
        repo.loadOlder(scope, "c-1")
        api.threads.getValue("c-1").removeAll { it.id == rows[240].id || it.id == rows[60].id }

        repo.sync(scope, "c-1", "reconcile", forceFull = true)
        val held = thread().map { it.id }
        assertFalse(rows[240].id in held)
        assertTrue("an older page's deletion is not seen by a newest-page read", rows[60].id in held)
    }

    // Hard case 8: a saved copy from before pages (no `older` stored).
    @Test
    fun `case 8 - a saved copy from before pages is read from its newest page, then pages`() = runTest {
        val rows = api.seed("c-1", 250)
        repo.sync(scope, "c-1", "open")
        // What an installed 1.9.1 left: a cursor, a recent full read, no payload.
        store.thread(scope, "c-1") { putState(state()!!.copy(payload = null)) }
        assertEquals(OlderState.Unknown, older())

        val reads = api.threadReads.size
        repo.sync(scope, "c-1", "open")
        assertNull("a newest-page read, not a delta", api.threadReads[reads])
        assertTrue(older() is OlderState.Before)
        assertEquals(rows.takeLast(100).map { it.id }, thread().map { it.id })
        // A payload this build cannot read is unknown too, never an error.
        store.thread(scope, "c-1") { putState(state()!!.copy(payload = "{not json")) }
        assertEquals(OlderState.Unknown, older())
    }

    @Test
    fun `the older state round-trips through its payload`() {
        val cursor = OlderCursor("2026-11-08T10:00:00.123456+00:00", "4443f8b3-d060-4b9f-90f7-c9b5dbc6c83e")
        assertEquals(OlderState.Before(cursor), OlderState.of(OlderState.Before(cursor).encode()))
        assertEquals(OlderState.AtStart, OlderState.of(OlderState.AtStart.encode()))
        assertEquals(OlderState.Unknown, OlderState.of(null))
        assertEquals(OlderState.Unknown, OlderState.of("{}"))
    }
}
