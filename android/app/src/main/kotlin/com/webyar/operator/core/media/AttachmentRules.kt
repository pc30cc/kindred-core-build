package com.webyar.operator.core.media

/**
 * What the server will take, and what to call it.
 *
 * A mirror of `GLOBAL_ALLOWED_MIMES`, `EXT_BY_MIME` and `HARD_MAX_BYTES` in
 * `server/routes/conversationAttachments.ts`, for the same reason iOS keeps
 * its own copy in `Composer.swift`: offering the operator a type the server
 * refuses only moves the rejection from the picker to the upload, where it
 * arrives as a 415 after the file has been read, base64'd and sent.
 *
 * Pure Kotlin with no Android imports, so the rules can be tested on the JVM
 * rather than inferred from a screenshot.
 */
object AttachmentRules {

    /** `HARD_MAX_BYTES`. The server rejects the *init* call above this. */
    const val MAX_BYTES: Int = 25 * 1024 * 1024

    /**
     * The canonical types, each with the extension the server will store it
     * under. Keys are exactly the server's set — adding one here without
     * adding it there produces a 415 the operator cannot act on.
     */
    private val EXTENSION_BY_MIME: Map<String, String> = mapOf(
        "image/png" to "png",
        "image/jpeg" to "jpg",
        "image/webp" to "webp",
        "image/gif" to "gif",
        "application/pdf" to "pdf",
        "text/plain" to "txt",
        "audio/webm" to "webm",
        "audio/ogg" to "ogg",
        "audio/mp4" to "m4a",
        "audio/mpeg" to "mp3",
        "audio/wav" to "wav",
    )

    /**
     * What the document picker offers.
     *
     * The image and document types only: a voice note is recorded, not
     * browsed for, and a picker that lists every audio type invites the
     * operator to attach a ringtone. Same six iOS restricts `fileImporter`
     * to.
     */
    val PICKABLE_MIME_TYPES: Array<String> = arrayOf(
        "image/png", "image/jpeg", "image/webp", "image/gif",
        "application/pdf", "text/plain",
    )

    /**
     * The canonical name for a type, or null if the server will not take it.
     *
     * Android's `ContentResolver.getType` answers with whatever the providing
     * app declared, and the same bytes come back as `image/jpg` from one
     * gallery and `image/jpeg` from the next. The aliases below are the ones
     * that really turn up on a phone; anything else is honestly unsupported
     * and says so before the upload rather than after it.
     */
    fun canonicalMime(mimeType: String?): String? {
        // `image/jpeg; charset=binary` is a legal answer from a provider.
        val raw = mimeType?.substringBefore(';')?.trim()?.lowercase() ?: return null
        val canonical = when (raw) {
            "image/jpg", "image/pjpeg" -> "image/jpeg"
            "image/x-png" -> "image/png"
            "audio/m4a", "audio/x-m4a", "audio/aac", "audio/mp4a-latm" -> "audio/mp4"
            "audio/mp3", "audio/x-mpeg", "audio/mpeg3", "audio/x-mpeg-3" -> "audio/mpeg"
            "audio/x-wav", "audio/wave", "audio/vnd.wave" -> "audio/wav"
            "audio/opus" -> "audio/ogg"
            else -> raw
        }
        return canonical.takeIf(EXTENSION_BY_MIME::containsKey)
    }

    fun isAllowed(mimeType: String?): Boolean = canonicalMime(mimeType) != null

    /**
     * The `kind` the server would give this type — for the pending copy of a
     * message the operator is sending, which has no server row to read it
     * from yet. The same four buckets as `conversationAttachments.ts`.
     */
    fun kindOf(mimeType: String?): String {
        val mime = mimeType?.substringBefore(';')?.trim()?.lowercase().orEmpty()
        return when {
            mime.startsWith("image/") -> "image"
            mime.startsWith("audio/") -> "audio"
            mime.startsWith("video/") -> "video"
            else -> "file"
        }
    }

    /**
     * The extension to give a file on disk, so the system can open it.
     *
     * Name first, then type — the name is the more specific of the two, but
     * only when it really carries an extension. A widget voice note arrives
     * named `m4a`, with no dot in it at all, and treating that as a name
     * produces `m4a.m4a`. Port of iOS's `AttachmentFormat.fileExtension`.
     */
    fun fileExtension(fileName: String?, mimeType: String?): String? {
        val dot = fileName?.lastIndexOf('.') ?: -1
        if (fileName != null && dot > 0 && dot < fileName.length - 1) {
            val suffix = fileName.substring(dot + 1)
            // A suffix with a space or a slash in it is part of a sentence,
            // not an extension.
            if (suffix.length <= 8 && suffix.all(Char::isLetterOrDigit)) return suffix.lowercase()
        }
        return EXTENSION_BY_MIME[canonicalMime(mimeType)]
    }

    /**
     * A name worth sending.
     *
     * The operator's own document keeps the name they know it by. Anything
     * without a usable one — a photo the gallery hands over as `1000000034`,
     * a recording that never had a name — is named after what it is, the way
     * iOS names a picked photo `photo.jpg`. The server sanitises further
     * (`safeFileName`), so this only has to be honest, not safe.
     */
    fun sendableFileName(pickedName: String?, mimeType: String?, fallbackStem: String): String {
        val extension = EXTENSION_BY_MIME[canonicalMime(mimeType)] ?: "bin"
        val trimmed = pickedName?.trim().orEmpty()
        val dot = trimmed.lastIndexOf('.')
        val hasRealExtension = dot > 0 && dot < trimmed.length - 1 &&
            trimmed.substring(dot + 1).let { it.length <= 8 && it.all(Char::isLetterOrDigit) }
        return if (hasRealExtension) trimmed else "$fallbackStem.$extension"
    }
}
