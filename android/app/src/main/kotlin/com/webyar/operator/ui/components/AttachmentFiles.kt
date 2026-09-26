package com.webyar.operator.ui.components

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import com.webyar.operator.core.model.MessageAttachment
import java.io.File

/**
 * Puts an attachment somewhere the system's own viewers can read it.
 *
 * There is no Quick Look on Android. What there is instead is every app the
 * operator already has — Drive's PDF viewer, the gallery, a player — reached
 * through a chooser, and the one thing they all need is a real file at a URI
 * they are allowed to open. Hence the `FileProvider`: a `file://` URI has
 * been illegal to hand another app since API 24, which is this app's floor.
 *
 * The files themselves come from `AttachmentDiskCache`, under `cacheDir/media`
 * — the one directory `attachment_paths.xml` lets the provider serve.
 */
object AttachmentFiles {

    /** Mirrors `android:authorities` in the manifest. */
    private fun authority(context: Context) = "${context.packageName}.attachments"

    /**
     * Hands a cached file to whatever opens that type.
     *
     * Returns false when nothing on the phone can, which is a real outcome on
     * a bare device with no PDF reader — and one the operator should be told
     * about rather than left tapping a card that does nothing.
     */
    fun open(context: Context, attachment: MessageAttachment, file: File): Boolean =
        openFile(context, file, attachment.mimeType)

    /** The same, for a file that is not a chat attachment — a mail's. */
    fun openFile(context: Context, file: File, mimeType: String?): Boolean {
        val uri = runCatching { FileProvider.getUriForFile(context, authority(context), file) }
            .getOrNull() ?: return false

        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mimeType ?: "*/*")
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

}
