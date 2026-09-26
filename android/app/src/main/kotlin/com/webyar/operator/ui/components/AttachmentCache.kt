package com.webyar.operator.ui.components

import com.webyar.operator.core.cache.CacheScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Attachment bytes, fetched once and kept.
 *
 * Port of iOS's `AttachmentStore`. A 1.6 MB photo re-downloaded every time a
 * row is rebuilt is the difference between a chat that feels native and one
 * that does not — and a transcript rebuilds its rows constantly, on every
 * poll, every scroll and every new message.
 *
 * Two things it guarantees: a file is downloaded once however many views ask
 * at the same moment, and the cache gives its memory back before the app is
 * killed for holding it.
 */
object AttachmentCache {

    /**
     * 24 MB, measured in bytes rather than entries.
     *
     * Half iOS's 48 MB because an Android phone's heap is the app's whole
     * budget, not a share of a device-wide pool, and the floor here is a
     * 2 GB phone on API 24 — the devices this app promised to run well on.
     */
    private const val MAX_BYTES = 24 * 1024 * 1024

    private val lock = Mutex()
    /**
     * Access-ordered, so eviction drops the file nobody has looked at
     * longest rather than the one that happened to arrive first.
     */
    private val entries = LinkedHashMap<String, ByteArray>(16, 0.75f, true)
    private var held = 0
    /** One request per attachment, however many views ask at once. */
    private val inFlight = HashMap<String, CompletableDeferred<ByteArray?>>()

    suspend fun bytes(id: String, load: suspend (String) -> ByteArray?): ByteArray? {
        val mine = CompletableDeferred<ByteArray?>()
        // One lock acquisition decides all three cases: a hit returns, a
        // request already running is joined, and anything else makes this
        // call the one that fetches.
        val running = lock.withLock {
            entries[id]?.let { return it }
            inFlight.getOrPut(id) { mine }
        }
        if (running !== mine) return running.await()

        val loaded = runCatching { load(id) }.getOrNull()
        lock.withLock {
            inFlight.remove(id)
            if (loaded != null) store(id, loaded)
        }
        // Completed after the cache is written, so a joiner that wakes on it
        // never races ahead of the entry it is about to look up.
        mine.complete(loaded)
        return loaded
    }

    /**
     * The key for an attachment in one account's workspace. Ids are unique
     * server-side, but the cache does not lean on that: two scopes' entries
     * can never answer for each other.
     */
    fun key(scope: CacheScope, id: String): String = "${scope.accountId}/${scope.workspaceId}/$id"

    /** Bytes this app already holds — the operator's own upload. */
    suspend fun put(id: String, bytes: ByteArray) = lock.withLock { store(id, bytes) }

    /** A hit, or null. Never loads. */
    suspend fun peek(id: String): ByteArray? = lock.withLock { entries[id] }

    /** Called with [lock] held. */
    private fun store(id: String, bytes: ByteArray) {
        // A single file larger than the whole budget is kept out rather than
        // emptying the cache for itself.
        if (bytes.size > MAX_BYTES) return
        entries.put(id, bytes)?.let { held -= it.size }
        held += bytes.size
        val oldest = entries.entries.iterator()
        while (held > MAX_BYTES && oldest.hasNext()) {
            held -= oldest.next().value.size
            oldest.remove()
        }
    }

    /** For tests, and for a sign-out: another operator's files are not ours. */
    suspend fun clear() = lock.withLock {
        entries.clear()
        held = 0
    }
}
