package com.webyar.ai.ui.components

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * What the shared fetch does when the view that started it goes away.
 *
 * A bubble that scrolls off mid-download cancels its fetch. That says nothing
 * about the file, so a second view that had joined the same fetch must not be
 * told it failed — it fetches for itself — and nothing may be left in flight
 * for later requests to wait on.
 *
 * Plain JUnit: the cache is coroutines and a map, nothing of the framework.
 */
class AttachmentCacheTest {

    @Before fun emptyTheCache() {
        runBlocking { AttachmentCache.clear() }
    }

    @Test
    fun `a joiner whose fetch was abandoned fetches for itself`() = runBlocking {
        val started = CompletableDeferred<Unit>()
        var calls = 0
        val load: suspend (String) -> ByteArray? = {
            calls++
            if (calls == 1) {
                started.complete(Unit)
                awaitCancellation()
            }
            byteArrayOf(7)
        }

        val owner = launch { AttachmentCache.bytes("att-abandoned", load) }
        started.await()
        val joiner = async { AttachmentCache.bytes("att-abandoned", load) }
        yield() // the joiner joins the running fetch
        owner.cancel()

        assertEquals(7.toByte(), joiner.await()?.single())
        assertEquals(2, calls)
    }

    @Test
    fun `a cancelled fetch leaves nothing in flight`() = runBlocking {
        val started = CompletableDeferred<Unit>()
        val owner = launch {
            AttachmentCache.bytes("att-cancelled") {
                started.complete(Unit)
                awaitCancellation()
            }
        }
        started.await()
        owner.cancel()
        owner.join()

        assertEquals(3.toByte(), AttachmentCache.bytes("att-cancelled") { byteArrayOf(3) }?.single())
    }

    /** A timeout inside the load is a failed load, not the caller's cancellation. */
    @Test
    fun `a cancellation thrown by the load itself reads as a failure`() = runBlocking {
        assertNull(AttachmentCache.bytes("att-timeout") { throw CancellationException("timed out") })
        assertEquals(5.toByte(), AttachmentCache.bytes("att-timeout") { byteArrayOf(5) }?.single())
    }
}
