package com.webyar.operator.core.media

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.storage.StorageManager
import androidx.core.content.ContextCompat
import com.webyar.operator.core.Diag
import com.webyar.operator.core.cache.CacheScope
import com.webyar.operator.core.model.MessageAttachment
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID

/**
 * Attachment files on disk: voice notes, photos, videos, documents — each
 * downloaded once, per account and workspace, and given back when space runs
 * short.
 *
 * ## Layout
 *
 *     cacheDir/media/v1/<account>/<workspace>/<attachmentId>.<ext>
 *
 * Scoped by path, not merely by name: a file cached for one operator is in a
 * directory another operator's session never names, so "open the file for
 * attachment X" cannot hand User B a copy User A downloaded, however the ids
 * happen to line up. Sign-out deletes the account's directory whole. `v1` is
 * the layout's version, so a future change of layout is a new directory and a
 * sweep of the old one rather than a migration of files.
 *
 * `cacheDir` because this is exactly what it is for: disposable, excluded
 * from backup (`data_extraction_rules.xml`), and reclaimable by the system
 * under storage pressure — which this class survives, because an entry whose
 * file has vanished is simply a miss.
 *
 * ## Budget
 *
 * NOT the desktop's 1 GB. A phone's cache shares a disk with the operator's
 * photos, and this app promised to run on 16 GB devices. The budget is 5% of
 * the free space, clamped to 64–512 MB, capped at 128 MB on a low-RAM device
 * (which is also the one with the smallest disk), and never more than half
 * the quota Android itself grants the app's cache (API 26+). Past it, the
 * least recently used files go until the cache is at 80%.
 *
 * ## Integrity
 *
 * Every write goes to a `.part` file in the same directory and is renamed
 * into place only once complete, so a file under its final name is always a
 * whole one — a crash, a full disk or a killed download leaves a `.part`,
 * which the next scan deletes. A file whose length disagrees with the size
 * the server declared is corrupt, and is deleted rather than served. A full
 * disk is not an error the operator sees: the cache makes room and the file
 * is read without being kept.
 *
 * Concurrent requests for one file share one download.
 */
class AttachmentDiskCache(
    private val root: File,
    private val budget: () -> Long,
    private val diag: Diag = Diag.Android,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private class Entry(val file: File, var size: Long, var lastAccess: Long)

    private val lock = Mutex()
    /** Access-ordered: the eldest entry is the least recently used. Built lazily from the directory. */
    private var index: LinkedHashMap<String, Entry>? = null
    private var total = 0L
    private val inFlight = HashMap<String, CompletableDeferred<File?>>()

    /** Files an app or a player is reading right now; eviction and Clear Cache step round them. */
    private val pins = HashMap<String, Int>()

    fun directory(scope: CacheScope): File =
        File(root, "$LAYOUT/${safe(scope.accountId)}/${safe(scope.workspaceId)}")

    private fun target(scope: CacheScope, attachment: MessageAttachment): File {
        val extension = AttachmentRules.fileExtension(attachment.fileName, attachment.mimeType)
            ?.let(::safeExtension)
        return File(directory(scope), safe(attachment.id) + if (extension != null) ".$extension" else "")
    }

    // MARK: - Reading

    /** The cached file, if there is a whole one. Never touches the network. */
    suspend fun cached(scope: CacheScope, attachment: MessageAttachment): File? = withContext(Dispatchers.IO) {
        lock.withLock { lookup(target(scope, attachment), attachment) }
    }

    /**
     * The file, from disk or else from [download] — which writes the bytes to
     * the file it is given and returns normally only if all of them arrived.
     * Null when the download failed, or the result was not the file the
     * server described.
     */
    suspend fun file(
        scope: CacheScope,
        attachment: MessageAttachment,
        download: suspend (File) -> Unit,
    ): File? = withContext(Dispatchers.IO) {
        val final = target(scope, attachment)
        val key = final.path
        val mine = CompletableDeferred<File?>()
        val running = lock.withLock {
            lookup(final, attachment)?.let {
                diag.info(AREA, "disk hit ${Diag.id(attachment.id)}")
                return@withContext it
            }
            inFlight.getOrPut(key) { mine }
        }
        if (running !== mine) return@withContext running.await()

        val result = try {
            fetchInto(final, attachment, download)
        } catch (e: Throwable) {
            // Whoever is waiting on this download must not wait forever
            // because the screen that started it went away.
            mine.complete(null)
            throw e
        } finally {
            withContext(NonCancellable) { lock.withLock { inFlight.remove(key) } }
        }
        mine.complete(result)
        result
    }

    /** Keeps bytes this app already has — an upload, a photo just decoded. */
    suspend fun put(scope: CacheScope, attachment: MessageAttachment, bytes: ByteArray): File? =
        withContext(Dispatchers.IO) {
            val final = target(scope, attachment)
            lock.withLock { lookup(final, attachment) }?.let { return@withContext it }
            fetchInto(final, attachment) { it.writeBytes(bytes) }
        }

    private suspend fun fetchInto(
        final: File,
        attachment: MessageAttachment,
        download: suspend (File) -> Unit,
    ): File? {
        val directory = final.parentFile ?: return null
        if (!directory.isDirectory && !directory.mkdirs()) return null
        val part = File(directory, "${final.name}$PART_SUFFIX${UUID.randomUUID().toString().take(8)}")
        try {
            download(part)
        } catch (e: IOException) {
            part.delete()
            if (isDiskFull(e, directory)) {
                diag.warn(AREA, "disk full while caching ${Diag.id(attachment.id)}; trimming hard")
                lock.withLock { trimTo((budget() * 0.5).toLong()) }
            }
            throw e
        } catch (e: Throwable) {
            part.delete()
            throw e
        }

        val expected = attachment.sizeBytes?.toLong()?.takeIf { it > 0 }
        val length = part.length()
        if (length == 0L || (expected != null && length != expected)) {
            // Truncated, or not the file the server described. Not kept, and
            // not handed to a player that would choke on it.
            diag.warn(AREA, "download of ${Diag.id(attachment.id)} is $length bytes, expected ${expected ?: "some"}")
            part.delete()
            return null
        }
        return lock.withLock {
            if (final.exists()) final.delete()
            if (!part.renameTo(final)) {
                part.delete()
                return@withLock null
            }
            val entries = ensureIndex()
            entries.remove(final.path)?.let { total -= it.size }
            entries[final.path] = Entry(final, length, clock())
            total += length
            diag.info(AREA, "network fetch ${Diag.id(attachment.id)}: ${length / 1024} KB cached")
            val max = budget()
            if (total > max) trimTo((max * TRIM_TARGET).toLong())
            final
        }
    }

    /** Called with [lock] held. */
    private fun lookup(file: File, attachment: MessageAttachment): File? {
        val entries = ensureIndex()
        val entry = entries[file.path] ?: return null
        val length = file.length()
        val expected = attachment.sizeBytes?.toLong()?.takeIf { it > 0 }
        if (!file.exists() || length == 0L || (expected != null && length != expected)) {
            // Gone (the system reclaimed it) or damaged: a miss, and a
            // fresh download replaces it.
            entries.remove(file.path)
            total -= entry.size
            if (file.exists() && !isPinned(file.path)) file.delete()
            return null
        }
        val now = clock()
        // The file's own mtime is the persisted last-access time, which is
        // what the index is rebuilt from after a restart. Written at most
        // hourly per file, so reading a thread is not a stream of disk writes.
        if (now - entry.lastAccess > TOUCH_INTERVAL_MS) runCatching { file.setLastModified(now) }
        entry.lastAccess = now
        return file
    }

    // MARK: - Pins

    /** While a player has it open. Every [pin] needs its [unpin]. */
    fun pin(file: File) {
        synchronized(pins) { pins[file.path] = (pins[file.path] ?: 0) + 1 }
    }

    fun unpin(file: File) {
        synchronized(pins) {
            val n = (pins[file.path] ?: return) - 1
            if (n <= 0) pins.remove(file.path) else pins[file.path] = n
        }
    }

    /**
     * For a file handed to another app: there is no moment that app says it
     * is finished, so the file is simply kept for a while — long enough to
     * read a PDF's first pages, short enough that it does not outlive its use.
     */
    fun lease(file: File, millis: Long) {
        synchronized(pins) { leases[file.path] = clock() + millis }
    }

    private val leases = HashMap<String, Long>()

    private fun isPinned(path: String): Boolean = synchronized(pins) {
        if (pins.containsKey(path)) return true
        val until = leases[path] ?: return false
        if (until > clock()) return true
        leases.remove(path)
        false
    }

    // MARK: - Housekeeping

    /** Down to the trim target if over budget. For the periodic maintenance job. */
    suspend fun trim(): Long = withContext(Dispatchers.IO) {
        lock.withLock {
            ensureIndex()
            val max = budget()
            if (total > max) trimTo((max * TRIM_TARGET).toLong()) else 0L
        }
    }

    /** Called with [lock] held. Least recently used first; pinned files are stepped round. */
    private fun trimTo(target: Long): Long {
        val entries = ensureIndex()
        var freed = 0L
        var evicted = 0
        val iterator = entries.entries.iterator()
        while (total > target && iterator.hasNext()) {
            val (path, entry) = iterator.next()
            if (isPinned(path)) continue
            if (!entry.file.delete() && entry.file.exists()) continue
            iterator.remove()
            total -= entry.size
            freed += entry.size
            evicted++
        }
        if (evicted > 0) diag.info(AREA, "evicted $evicted files, ${freed / 1024} KB; now ${total / 1024} KB")
        return freed
    }

    /** Clear Cache: everything, except what is open right now. Returns bytes freed. */
    suspend fun clear(): Long = withContext(Dispatchers.IO) {
        lock.withLock {
            ensureIndex()
            val freed = trimTo(0)
            // Whatever the index did not know about — a .part from a download
            // still running is left to finish; anything else goes.
            root.walkBottomUp().forEach { f ->
                if (f.isFile && !f.name.contains(PART_SUFFIX) && !isPinned(f.path) && index?.containsKey(f.path) != true) {
                    f.delete()
                } else if (f.isDirectory && f != root) {
                    f.delete() // only succeeds when empty
                }
            }
            freed
        }
    }

    /** Sign-out: the account's whole directory, pinned or not — they are gone. */
    suspend fun purgeAccount(accountId: String) = withContext(Dispatchers.IO) {
        lock.withLock {
            val directory = File(root, "$LAYOUT/${safe(accountId)}")
            val prefix = directory.path + File.separator
            index?.let { entries ->
                val doomed = entries.keys.filter { it.startsWith(prefix) }
                doomed.forEach { path -> entries.remove(path)?.let { total -= it.size } }
            }
            directory.deleteRecursively()
            diag.info(AREA, "account media purged")
        }
    }

    suspend fun sizeBytes(): Long = withContext(Dispatchers.IO) { lock.withLock { ensureIndex(); total } }

    /**
     * The index, from the directory, the first time anything asks.
     *
     * Also where leftovers are swept: every `.part` (nothing is downloading
     * yet — this runs before the first write), and the unscoped directory
     * earlier versions wrote to, whose files belong to nobody in particular
     * and so cannot be kept under a scope.
     */
    private fun ensureIndex(): LinkedHashMap<String, Entry> {
        index?.let { return it }
        val found = ArrayList<Entry>()
        var parts = 0
        val layout = File(root, LAYOUT)
        if (layout.isDirectory) {
            layout.walkTopDown().filter { it.isFile }.forEach { f ->
                if (f.name.contains(PART_SUFFIX)) {
                    if (f.delete()) parts++
                } else {
                    found += Entry(f, f.length(), f.lastModified())
                }
            }
        }
        root.parentFile?.let { cacheDir ->
            val legacy = File(cacheDir, LEGACY_DIRECTORY)
            if (legacy.exists()) legacy.deleteRecursively()
        }
        val entries = LinkedHashMap<String, Entry>(16, 0.75f, true)
        found.sortedBy { it.lastAccess }.forEach { entries[it.file.path] = it }
        total = found.sumOf { it.size }
        index = entries
        diag.info(AREA, "disk cache indexed: ${found.size} files, ${total / 1024} KB, $parts stale parts removed")
        return entries
    }

    private fun isDiskFull(e: IOException, directory: File): Boolean =
        e.message?.contains("ENOSPC") == true || e.message?.contains("No space", ignoreCase = true) == true ||
            directory.usableSpace < LOW_SPACE_BYTES

    companion object {
        private const val AREA = "Media"
        private const val LAYOUT = "v1"
        private const val PART_SUFFIX = ".part-"
        private const val TRIM_TARGET = 0.8
        private const val TOUCH_INTERVAL_MS = 60 * 60 * 1000L
        private const val LOW_SPACE_BYTES = 8L * 1024 * 1024

        /** Where versions before this cache wrote, unscoped. Swept once. */
        const val LEGACY_DIRECTORY = "attachments"

        /** The directory under `cacheDir`; `attachment_paths.xml` names the same one. */
        const val DIRECTORY = "media"

        private const val MB = 1024L * 1024

        /**
         * The budget for this phone, as described on the class. Re-read at
         * each trim, so a disk that fills up shrinks the cache with it.
         */
        fun budgetFor(context: Context, directory: File): Long {
            var budget = (directory.usableSpace * 0.05).toLong().coerceIn(64 * MB, 512 * MB)
            val activity = ContextCompat.getSystemService(context, ActivityManager::class.java)
            if (activity?.isLowRamDevice == true) budget = budget.coerceAtMost(128 * MB)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                runCatching {
                    val storage = ContextCompat.getSystemService(context, StorageManager::class.java)
                    val quota = storage?.getCacheQuotaBytes(storage.getUuidForPath(directory)) ?: 0L
                    if (quota > 0) budget = budget.coerceAtMost(quota / 2)
                }
            }
            return budget.coerceAtLeast(32 * MB)
        }

        /**
         * An id as a path segment: kept as-is when it is the UUID-ish shape
         * every id here has, hashed otherwise — so no id, whatever a channel
         * sends, can become `..` or a separator.
         */
        internal fun safe(id: String): String =
            if (id.matches(SAFE_ID)) id else sha256(id).take(32)

        private fun safeExtension(ext: String): String? =
            ext.lowercase().takeIf { it.matches(SAFE_EXT) }

        private fun sha256(value: String): String =
            MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }

        private val SAFE_ID = Regex("^[A-Za-z0-9_-]{1,64}$")
        private val SAFE_EXT = Regex("^[a-z0-9]{1,8}$")
    }
}
