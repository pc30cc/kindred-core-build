package com.webyar.operator.core.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The rules the composer refuses a file by.
 *
 * Worth pinning because the failure they prevent is silent on the operator's
 * side: before this, a picked document went up whatever it was, and a `.docx`
 * came back 415 after the whole file had been read and base64'd. The check
 * only helps if it agrees with the server, so the last test here reads the
 * server's own source rather than a copy of it.
 */
class AttachmentRulesTest {

    @Test
    fun `the types the server takes are allowed`() {
        listOf(
            "image/png", "image/jpeg", "image/webp", "image/gif",
            "application/pdf", "text/plain",
            "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav",
        ).forEach { assertTrue(it, AttachmentRules.isAllowed(it)) }
    }

    @Test
    fun `the types it does not are refused`() {
        listOf(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "video/mp4", "video/quicktime", "application/zip", "application/octet-stream",
        ).forEach { assertFalse(it, AttachmentRules.isAllowed(it)) }
    }

    @Test
    fun `nothing is not a type`() {
        assertNull(AttachmentRules.canonicalMime(null))
        assertNull(AttachmentRules.canonicalMime(""))
        assertNull(AttachmentRules.canonicalMime("   "))
    }

    /**
     * The same photo comes back `image/jpg` from one gallery and `image/jpeg`
     * from the next, and a recorder on a Samsung answers `audio/x-m4a` for
     * the file this app itself wrote as `audio/mp4`.
     */
    @Test
    fun `the names a provider really uses map onto the canonical ones`() {
        assertEquals("image/jpeg", AttachmentRules.canonicalMime("image/jpg"))
        assertEquals("image/jpeg", AttachmentRules.canonicalMime("IMAGE/JPEG"))
        assertEquals("image/png", AttachmentRules.canonicalMime("image/x-png"))
        assertEquals("audio/mp4", AttachmentRules.canonicalMime("audio/x-m4a"))
        assertEquals("audio/mp4", AttachmentRules.canonicalMime("audio/aac"))
        assertEquals("audio/mpeg", AttachmentRules.canonicalMime("audio/mp3"))
        assertEquals("audio/wav", AttachmentRules.canonicalMime("audio/x-wav"))
    }

    /** `image/jpeg; charset=binary` is a legal answer from a provider. */
    @Test
    fun `a parameter on the type is not part of the type`() {
        assertEquals("image/jpeg", AttachmentRules.canonicalMime("image/jpeg; charset=binary"))
        assertEquals("text/plain", AttachmentRules.canonicalMime("text/plain;charset=utf-8"))
    }

    @Test
    fun `the name decides the extension when it carries one`() {
        assertEquals("pdf", AttachmentRules.fileExtension("quarterly.pdf", "application/pdf"))
        assertEquals("jpg", AttachmentRules.fileExtension("holiday.JPG", "image/jpeg"))
    }

    /**
     * A widget voice note arrives named `m4a`, with no dot in it at all.
     * Treating that as a name produces `m4a.m4a`; treating it as an extension
     * is what iOS's `AttachmentFormat` does.
     */
    @Test
    fun `a bare extension is not a name`() {
        assertEquals("m4a", AttachmentRules.fileExtension("m4a", "audio/mp4"))
        assertEquals("mp3", AttachmentRules.fileExtension(null, "audio/mpeg"))
        assertEquals("png", AttachmentRules.fileExtension("", "image/png"))
    }

    /** A dot in a sentence is not an extension. */
    @Test
    fun `a name with prose after the dot falls back to the type`() {
        assertEquals("pdf", AttachmentRules.fileExtension("report v2. final", "application/pdf"))
    }

    @Test
    fun `an unknown type with no usable name has no extension`() {
        assertNull(AttachmentRules.fileExtension(null, "application/zip"))
    }

    /**
     * The gallery hands over `1000000034`. Sending that as the file name is
     * what put a bubble reading "1000000034" in the thread.
     */
    @Test
    fun `a name the picker invented is replaced by what the file is`() {
        assertEquals("photo.jpg", AttachmentRules.sendableFileName("1000000034", "image/jpeg", "photo"))
        assertEquals("photo.png", AttachmentRules.sendableFileName(null, "image/png", "photo"))
        assertEquals("photo.jpg", AttachmentRules.sendableFileName("   ", "image/jpg", "photo"))
    }

    @Test
    fun `a real name is kept`() {
        assertEquals(
            "quarterly-report.pdf",
            AttachmentRules.sendableFileName("quarterly-report.pdf", "application/pdf", "photo"),
        )
    }

    /**
     * The one test that can catch the server changing under this file.
     *
     * Skipped rather than failed when the source is not beside the app —
     * CI checks out the whole repository, but a developer with only the
     * `android/` directory open should not see a red test for it.
     */
    @Test
    fun `the allowlist is the server's`() {
        val source = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "server/routes/conversationAttachments.ts") }
            .firstOrNull { it.isFile } ?: return

        // Comments go first. There is one inside the Set literal and it
        // contains the word "widget's" — an apostrophe that pairs with the
        // next real quote and drags half a sentence in as a MIME type.
        val code = source.readText().lines()
            .joinToString("\n") { it.substringBefore("//") }

        val declared = Regex("""GLOBAL_ALLOWED_MIMES\s*=\s*new Set\(\[(.*?)]\)""", RegexOption.DOT_MATCHES_ALL)
            .find(code)
            ?.groupValues?.get(1)
            ?: error("GLOBAL_ALLOWED_MIMES is no longer written as a Set literal")

        val onServer = Regex("""'([^']+)'""").findAll(declared)
            .map { it.groupValues[1] }
            .filterTo(sortedSetOf()) { it.contains('/') }
        assertTrue("no types found; the literal's shape changed", onServer.size >= 8)

        val here = onServer.filterTo(sortedSetOf()) { AttachmentRules.isAllowed(it) }
        assertEquals("a type the server takes that the app refuses", onServer, here)

        val cap = Regex("""HARD_MAX_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024""")
            .find(code)?.groupValues?.get(1)?.toInt()
        assertEquals(cap?.times(1024 * 1024), AttachmentRules.MAX_BYTES)
    }
}
