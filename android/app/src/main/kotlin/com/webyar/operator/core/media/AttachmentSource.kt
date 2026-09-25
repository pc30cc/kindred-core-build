package com.webyar.operator.core.media

import android.content.Context
import android.net.ConnectivityManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.webyar.operator.core.Diag
import com.webyar.operator.core.cache.CacheScope
import com.webyar.operator.core.model.MessageAttachment
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.core.runCatchingUnlessCancelled
import com.webyar.operator.ui.components.AttachmentCache
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Where an attachment view gets its bytes, in the order that costs least:
 * memory, then disk, then the network — and the network only when somebody
 * asked for the thing.
 *
 * Photos are the one kind drawn without being asked for, because they ARE
 * the message; voice notes, videos and documents are fetched on a tap and
 * never before. With Data Saver on, photos wait for a tap too.
 */
interface AttachmentSource {
    /** A photo's bytes: memory, disk, network. Null when it cannot be had. */
    suspend fun bytes(attachment: MessageAttachment): ByteArray?

    /** A photo's bytes only if this phone already has them. */
    suspend fun cachedBytes(attachment: MessageAttachment): ByteArray?

    /** A file to play or hand to another app: disk, else downloaded to disk. */
    suspend fun file(attachment: MessageAttachment): File?

    /** The file only if it is already on disk. Never the network. */
    suspend fun cachedFile(attachment: MessageAttachment): File?

    /** Whether a photo nobody tapped may be downloaded. False under Data Saver. */
    val autoLoadImages: Boolean

    /** Keeps [file] out of eviction for [millis] — while another app reads it. */
    fun lease(file: File, millis: Long) {}
}

/**
 * The real one: the operator's account and workspace, the shared memory
 * cache, the scoped disk cache and the streaming download.
 */
class ScopedAttachmentSource(
    private val api: WebyarApi,
    private val disk: AttachmentDiskCache,
    private val scope: CacheScope,
    private val dataSaver: () -> Boolean,
    private val diag: Diag = Diag.Android,
) : AttachmentSource {

    private fun key(attachment: MessageAttachment) = AttachmentCache.key(scope, attachment.id)

    override val autoLoadImages: Boolean get() = !dataSaver()

    override suspend fun bytes(attachment: MessageAttachment): ByteArray? =
        AttachmentCache.bytes(key(attachment)) {
            readDisk(attachment) ?: runCatchingUnlessCancelled { api.attachmentData(attachment.id) }
                .getOrNull()
                ?.also { bytes ->
                    runCatchingUnlessCancelled { disk.put(scope, attachment, bytes) }
                }
        }

    override suspend fun cachedBytes(attachment: MessageAttachment): ByteArray? =
        AttachmentCache.peek(key(attachment)) ?: readDisk(attachment)?.also { AttachmentCache.put(key(attachment), it) }

    private suspend fun readDisk(attachment: MessageAttachment): ByteArray? {
        val file = runCatchingUnlessCancelled { disk.cached(scope, attachment) }.getOrNull() ?: return null
        return withContext(Dispatchers.IO) { runCatching { file.readBytes() }.getOrNull() }
    }

    override suspend fun file(attachment: MessageAttachment): File? =
        runCatchingUnlessCancelled {
            disk.file(scope, attachment) { part -> api.downloadAttachment(attachment.id, part) }
        }.onFailure {
            diag.warn("Media", "download of ${Diag.id(attachment.id)} failed: ${it.javaClass.simpleName}")
        }.getOrNull()

    override suspend fun cachedFile(attachment: MessageAttachment): File? =
        runCatchingUnlessCancelled { disk.cached(scope, attachment) }.getOrNull()

    override fun lease(file: File, millis: Long) = disk.lease(file, millis)
}

/**
 * A source over a bare loader — previews, the tests, and anywhere a view is
 * drawn without a session. Bytes go through the same memory cache; files are
 * written to [directory] (the caller's), whole or not at all.
 */
class LoaderAttachmentSource(
    private val load: suspend (String) -> ByteArray?,
    private val directory: File,
) : AttachmentSource {

    override val autoLoadImages: Boolean = true

    override suspend fun bytes(attachment: MessageAttachment): ByteArray? =
        AttachmentCache.bytes(attachment.id, load)

    override suspend fun cachedBytes(attachment: MessageAttachment): ByteArray? = AttachmentCache.peek(attachment.id)

    override suspend fun file(attachment: MessageAttachment): File? {
        val bytes = bytes(attachment) ?: return null
        return withContext(Dispatchers.IO) {
            runCatching {
                directory.mkdirs()
                val target = target(attachment)
                if (!target.exists() || target.length() != bytes.size.toLong()) {
                    val part = File(directory, target.name + ".part")
                    part.writeBytes(bytes)
                    if (!part.renameTo(target)) {
                        part.delete()
                        error("rename failed")
                    }
                }
                target
            }.getOrNull()
        }
    }

    override suspend fun cachedFile(attachment: MessageAttachment): File? =
        withContext(Dispatchers.IO) { target(attachment).takeIf { it.isFile && it.length() > 0 } }

    private fun target(attachment: MessageAttachment): File {
        val extension = AttachmentRules.fileExtension(attachment.fileName, attachment.mimeType)
        return File(directory, AttachmentDiskCache.safe(attachment.id) + if (extension != null) ".$extension" else "")
    }
}

/** What the phone's network settings allow. */
object NetworkPolicy {
    /**
     * Data Saver is on and this app is not exempt from it: media waits to be
     * asked for. Text sync is not affected — the operator's messages are
     * not optional data.
     */
    fun isDataSaverOn(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false
        val connectivity = ContextCompat.getSystemService(context, ConnectivityManager::class.java) ?: return false
        return runCatching {
            connectivity.isActiveNetworkMetered &&
                connectivity.restrictBackgroundStatus == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED
        }.getOrDefault(false)
    }

    /** On mobile data (or any network the system calls metered). */
    fun isMetered(context: Context): Boolean {
        val connectivity = ContextCompat.getSystemService(context, ConnectivityManager::class.java) ?: return false
        return runCatching { connectivity.isActiveNetworkMetered }.getOrDefault(false)
    }
}
