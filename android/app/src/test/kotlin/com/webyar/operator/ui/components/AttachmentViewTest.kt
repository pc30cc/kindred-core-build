package com.webyar.operator.ui.components

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import com.webyar.operator.core.model.MessageAttachment
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Which shape an attachment gets.
 *
 * The bug these are about shipped and was reported: a recording came into
 * the thread drawn as `voice-note.m4a · ۸۷ کیلوبایت` with a document icon,
 * because `AttachmentView` drew everything that was not an image as a file
 * card. Nothing failed — there was simply no way to play it.
 *
 * Robolectric has no codec, so the assertions stop where the platform
 * begins: a voice note gets the transport rather than a card, and while the
 * bytes are still coming it says so. Whether AAC decodes is the phone's
 * business and is checked on the emulator.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AttachmentViewTest {

    @get:Rule val compose = createComposeRule()

    @Before fun emptyTheCache() = runBlocking { AttachmentCache.clear() }

    private fun attachment(
        id: String = "att-1",
        fileName: String? = null,
        mimeType: String? = null,
        kind: String? = null,
        sizeBytes: Int? = 89_000,
    ) = MessageAttachment(
        id = id, fileName = fileName, mimeType = mimeType,
        sizeBytes = sizeBytes, kind = kind,
    )

    private fun show(
        attachment: MessageAttachment,
        load: (suspend (String) -> ByteArray?)? = { null },
    ) = compose.setContent {
        AttachmentView(attachment = attachment, language = Language.FA, load = load)
    }

    @Test
    fun `a recording gets a transport, not a file card`() {
        val voice = attachment(fileName = "voice-note.m4a", mimeType = "audio/mp4")
        show(voice)

        compose.onNodeWithTag(A11y.attachmentVoiceNote(voice.id)).assertIsDisplayed()
    }

    /** The server's `kind` decides, even when the MIME type is missing. */
    @Test
    fun `a recording the server labelled without a type is still a transport`() {
        val voice = attachment(kind = "audio")
        show(voice)

        compose.onNodeWithTag(A11y.attachmentVoiceNote(voice.id)).assertIsDisplayed()
    }

    @Test
    fun `a document gets a card`() {
        val doc = attachment(fileName = "quarterly.pdf", mimeType = "application/pdf")
        show(doc)

        compose.onNodeWithTag(A11y.attachmentFile(doc.id)).assertIsDisplayed()
        compose.onNodeWithText("quarterly.pdf").assertIsDisplayed()
    }

    /**
     * A caller with no way to fetch bytes — a preview, a test double — gets
     * the card rather than a transport that could never play.
     */
    @Test
    fun `without a loader everything is a card`() {
        val voice = attachment(fileName = "voice-note.m4a", mimeType = "audio/mp4")
        show(voice, load = null)

        compose.onNodeWithTag(A11y.attachmentFile(voice.id)).assertIsDisplayed()
    }

    @Test
    fun `a transport with no bytes yet says it is receiving`() {
        show(attachment(kind = "audio"), load = { neverReturns() })

        compose.onNodeWithText(Str.receivingFile(Language.FA)).assertIsDisplayed()
    }

    @Test
    fun `a transport whose bytes will not decode says so`() {
        show(attachment(kind = "audio", fileName = "note.ogg", mimeType = "audio/ogg")) {
            // Not audio in any format; nothing can open it.
            byteArrayOf(0, 1, 2, 3)
        }

        compose.onNodeWithText(Str.playbackUnsupported(Language.FA)).assertIsDisplayed()
    }

    @Test
    fun `a transport whose bytes never arrive says the file failed`() {
        show(attachment(kind = "audio")) { error("no route to host") }

        compose.onNodeWithText(Str.attachmentFailed(Language.FA)).assertIsDisplayed()
    }

    /**
     * A transcript rebuilds its rows on every poll. Downloading the same
     * photo again on each one is what the cache exists to prevent.
     */
    @Test
    fun `bytes are fetched once per file`() = runBlocking {
        var calls = 0
        val load: suspend (String) -> ByteArray? = { calls++; byteArrayOf(1, 2, 3) }

        repeat(5) { AttachmentCache.bytes("att-1", load) }

        assertEquals(1, calls)
    }

    @Test
    fun `a failed fetch is not cached as a failure`() = runBlocking {
        var calls = 0
        val load: suspend (String) -> ByteArray? = {
            calls++
            if (calls == 1) null else byteArrayOf(9)
        }

        assertEquals(null, AttachmentCache.bytes("att-2", load))
        assertEquals(9.toByte(), AttachmentCache.bytes("att-2", load)?.first())
        assertEquals(2, calls)
    }

    private suspend fun neverReturns(): ByteArray? {
        kotlinx.coroutines.awaitCancellation()
    }
}
