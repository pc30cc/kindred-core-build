package com.webyar.operator.core.media

import com.webyar.operator.core.Diag
import com.webyar.operator.core.cache.CacheScope
import com.webyar.operator.core.model.MessageAttachment
import com.webyar.operator.ui.components.AttachmentCache
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files

/**
 * Attachment files on disk: one download each, scoped per operator, kept
 * within a budget, never served half-written or corrupt.
 */
class AttachmentDiskCacheTest {

    private lateinit var root: File
    private var budget = 1_000L
    private var now = 1_000L
    private lateinit var cache: AttachmentDiskCache

    private val scope = CacheScope("user-a", "ws-1")

    @Before
    fun setUp() {
        root = Files.createTempDirectory("media").toFile()
        cache = AttachmentDiskCache(root, budget = { budget }, diag = Diag.Silent, clock = { now++ })
        runBlocking { AttachmentCache.clear() }
    }

    @After
    fun tearDown() {
        root.deleteRecursively()
    }

    private fun attachment(id: String, size: Int? = null, name: String = "$id.ogg") =
        MessageAttachment(id = id, fileName = name, mimeType = "audio/ogg", sizeBytes = size, kind = "audio")

    private fun bytes(n: Int) = ByteArray(n) { (it % 251).toByte() }

    @Test
    fun `a miss downloads once, and the next ask is a disk hit`() = runBlocking {
        var downloads = 0
        val download: suspend (File) -> Unit = { downloads++; it.writeBytes(bytes(100)) }

        val first = cache.file(scope, attachment("a1", 100), download)
        val second = cache.file(scope, attachment("a1", 100), download)

        assertEquals(1, downloads)
        assertEquals(first, second)
        assertArrayEquals(bytes(100), second!!.readBytes())
        assertNotNull(cache.cached(scope, attachment("a1", 100)))
    }

    @Test
    fun `concurrent asks share one download`() = runBlocking {
        var downloads = 0
        val download: suspend (File) -> Unit = {
            downloads++
            delay(50)
            it.writeBytes(bytes(10))
        }
        val files = (1..5).map { async { cache.file(scope, attachment("a1"), download) } }.awaitAll()

        assertEquals(1, downloads)
        assertTrue(files.all { it == files.first() && it != null })
    }

    @Test
    fun `files are scoped, and another operator's copy is never served`() = runBlocking {
        cache.file(scope, attachment("a1")) { it.writeBytes(bytes(10)) }

        assertNull(cache.cached(CacheScope("user-b", "ws-1"), attachment("a1")))
        assertNull(cache.cached(CacheScope("user-a", "ws-2"), attachment("a1")))
        assertNotEquals(cache.directory(scope), cache.directory(CacheScope("user-b", "ws-1")))
    }

    @Test
    fun `an id that is not an id cannot become a path`() {
        val odd = cache.directory(CacheScope("../../etc", "ws-1"))
        assertTrue(odd.canonicalPath.startsWith(root.canonicalPath))
        assertFalse(odd.path.contains(".."))
    }

    @Test
    fun `past the budget the least recently used files go`() = runBlocking {
        budget = 300
        cache.file(scope, attachment("old")) { it.writeBytes(bytes(100)) }
        cache.file(scope, attachment("mid")) { it.writeBytes(bytes(100)) }
        cache.cached(scope, attachment("old")) // used again: no longer the eldest
        cache.file(scope, attachment("new")) { it.writeBytes(bytes(110)) }

        assertNull(cache.cached(scope, attachment("mid")))
        assertNotNull(cache.cached(scope, attachment("old")))
        assertNotNull(cache.cached(scope, attachment("new")))
        assertTrue(cache.sizeBytes() <= 300)
    }

    @Test
    fun `a download of the wrong length is not kept`() = runBlocking {
        val file = cache.file(scope, attachment("a1", size = 100)) { it.writeBytes(bytes(40)) }

        assertNull(file)
        assertNull(cache.cached(scope, attachment("a1", size = 100)))
        assertEquals(0L, cache.sizeBytes())
    }

    @Test
    fun `a file damaged on disk is a miss and is fetched again`() = runBlocking {
        val first = cache.file(scope, attachment("a1", size = 100)) { it.writeBytes(bytes(100)) }!!
        first.writeBytes(bytes(3)) // truncated behind the cache's back

        var downloads = 0
        val again = cache.file(scope, attachment("a1", size = 100)) { downloads++; it.writeBytes(bytes(100)) }

        assertEquals(1, downloads)
        assertEquals(100L, again!!.length())
    }

    @Test
    fun `a half-written file is never served and is swept at the next start`() = runBlocking {
        val download: suspend (File) -> Unit = {
            it.writeBytes(bytes(10))
            throw IOException("connection reset")
        }
        runCatching { cache.file(scope, attachment("a1")) { f -> download(f) } }
        assertNull(cache.cached(scope, attachment("a1")))

        // A .part left by a crash, from before this process.
        val directory = cache.directory(scope).apply { mkdirs() }
        File(directory, "a2.ogg.part-deadbeef").writeBytes(bytes(10))
        val restarted = AttachmentDiskCache(root, budget = { budget }, diag = Diag.Silent)
        restarted.sizeBytes()

        assertTrue(directory.listFiles().orEmpty().none { it.name.contains(".part") })
    }

    @Test
    fun `a full disk is a failed download, not a crash, and the cache makes room`() = runBlocking {
        budget = 1_000
        cache.file(scope, attachment("big")) { it.writeBytes(bytes(900)) }

        val result = runCatching {
            cache.file(scope, attachment("a1")) { throw IOException("write failed: ENOSPC (No space left on device)") }
        }

        assertTrue(result.isFailure)
        assertTrue("trimmed to make room", cache.sizeBytes() <= 500)
    }

    @Test
    fun `clear cache leaves a file that is being played`() = runBlocking {
        val playing = cache.file(scope, attachment("a1")) { it.writeBytes(bytes(10)) }!!
        cache.file(scope, attachment("a2")) { it.writeBytes(bytes(10)) }
        cache.pin(playing)

        cache.clear()

        assertTrue(playing.exists())
        assertNull(cache.cached(scope, attachment("a2")))
        cache.unpin(playing)
    }

    @Test
    fun `a file handed to another app is kept for its lease`() = runBlocking {
        val shared = cache.file(scope, attachment("a1")) { it.writeBytes(bytes(10)) }!!
        cache.lease(shared, 60_000)
        cache.clear()
        assertTrue(shared.exists())
    }

    @Test
    fun `sign-out deletes the account's files and only theirs`() = runBlocking {
        val mine = cache.file(scope, attachment("a1")) { it.writeBytes(bytes(10)) }!!
        val theirs = cache.file(CacheScope("user-b", "ws-1"), attachment("a1")) { it.writeBytes(bytes(10)) }!!

        cache.purgeAccount("user-a")

        assertFalse(mine.exists())
        assertTrue(theirs.exists())
    }

    @Test
    fun `the index survives a restart from the files themselves`() = runBlocking {
        cache.file(scope, attachment("a1")) { it.writeBytes(bytes(10)) }
        val restarted = AttachmentDiskCache(root, budget = { budget }, diag = Diag.Silent)
        var downloads = 0
        restarted.file(scope, attachment("a1")) { downloads++; it.writeBytes(bytes(10)) }
        assertEquals(0, downloads)
    }

    // MARK: - The source, memory then disk then network

    @Test
    fun `a photo is fetched once, then served from memory, then from disk`() = runBlocking {
        val api = com.webyar.operator.testing.ScriptedApi()
        var calls = 0
        val source = object : AttachmentSource by ScopedAttachmentSource(
            api = object : com.webyar.operator.core.net.WebyarApi by api {
                override suspend fun attachmentData(id: String): ByteArray {
                    calls++
                    return bytes(20)
                }
            },
            disk = cache,
            scope = scope,
            dataSaver = { false },
            diag = Diag.Silent,
        ) {}
        val photo = MessageAttachment(id = "p1", fileName = "p1.jpg", mimeType = "image/jpeg", kind = "image")

        source.bytes(photo)
        source.bytes(photo)
        assertEquals("memory hit", 1, calls)

        AttachmentCache.clear()
        source.bytes(photo)
        assertEquals("disk hit", 1, calls)
    }

    @Test
    fun `under data saver a photo that is not on the phone waits for a tap`() = runBlocking {
        val source = ScopedAttachmentSource(
            api = com.webyar.operator.testing.ScriptedApi(),
            disk = cache,
            scope = scope,
            dataSaver = { true },
            diag = Diag.Silent,
        )
        assertFalse(source.autoLoadImages)
        assertNull(source.cachedBytes(MessageAttachment(id = "p9", kind = "image")))
    }
}
