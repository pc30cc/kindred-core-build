package com.webyar.operator.ui.components

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import com.webyar.operator.core.media.AttachmentRules
import com.webyar.operator.core.model.MessageAttachment
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File

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

/**
 * Puts an attachment somewhere the system's own viewers can read it.
 *
 * There is no Quick Look on Android. What there is instead is every app the
 * operator already has — Drive's PDF viewer, the gallery, a player — reached
 * through a chooser, and the one thing they all need is a real file at a URI
 * they are allowed to open. Hence the `FileProvider`: a `file://` URI has
 * been illegal to hand another app since API 24, which is this app's floor.
 */
object AttachmentFiles {

    /** Mirrors `android:authorities` in the manifest. */
    private fun authority(context: Context) = "${context.packageName}.attachments"

    /**
     * Writes the bytes where the provider can serve them.
     *
     * Split from [open] because this touches the disk and that starts an
     * activity: the write belongs on an IO dispatcher and the launch belongs
     * on the main thread, and one function doing both would have to be wrong
     * about one of them.
     */
    fun cache(context: Context, attachment: MessageAttachment, bytes: ByteArray): File? =
        runCatching { write(context, attachment, bytes) }.getOrNull()

    /**
     * Hands a cached file to whatever opens that type.
     *
     * Returns false when nothing on the phone can, which is a real outcome on
     * a bare device with no PDF reader — and one the operator should be told
     * about rather than left tapping a card that does nothing.
     */
    fun open(context: Context, attachment: MessageAttachment, file: File): Boolean {
        val uri = runCatching { FileProvider.getUriForFile(context, authority(context), file) }
            .getOrNull() ?: return false

        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, attachment.mimeType ?: "*/*")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            // The chooser is started from a non-activity context in tests and
            // from an activity in the app; the flag is required for the first
            // and harmless for the second.
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return try {
            context.startActivity(intent)
            true
        } catch (_: ActivityNotFoundException) {
            false
        }
    }

    private fun write(context: Context, attachment: MessageAttachment, bytes: ByteArray): File {
        val directory = File(context.cacheDir, DIRECTORY).apply { mkdirs() }
        val extension = AttachmentRules.fileExtension(attachment.fileName, attachment.mimeType)
        // Named by the attachment id, so the same file opened twice is
        // written once — and so a name from a channel cannot become a path.
        val file = File(directory, attachment.id + if (extension != null) ".$extension" else "")
        if (!file.exists() || file.length() != bytes.size.toLong()) file.writeBytes(bytes)
        return file
    }

    const val DIRECTORY = "attachments"
}
