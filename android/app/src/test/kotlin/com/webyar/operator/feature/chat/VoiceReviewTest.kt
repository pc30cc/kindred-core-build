package com.webyar.operator.feature.chat

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import android.content.Context
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.waveformLevels
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A voice note is heard before it is sent.
 *
 * Stopping a recording used to send it in the same tap. Now the recording
 * waits in the composer — delete, listen, send — and nothing reaches the
 * visitor until Send.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class VoiceReviewTest {

    @get:Rule val compose = createComposeRule()

    private fun composer(
        recordingSeconds: Int? = null,
        recorded: RecordedVoice? = null,
        onFinishRecording: () -> Unit = {},
        onSendRecorded: () -> Unit = {},
        onDiscardRecorded: () -> Unit = {},
    ) = compose.setContent {
        Composer(
            language = Language.EN,
            draft = "",
            onDraftChange = {},
            capabilities = ComposerCapabilities.NONE,
            sending = false,
            onSend = {},
            onAttachPhoto = {},
            onAttachFile = {},
            onOpenShortcuts = {},
            onStartRecording = {},
            recordingSeconds = recordingSeconds,
            onFinishRecording = onFinishRecording,
            recorded = recorded,
            onSendRecorded = onSendRecorded,
            onDiscardRecorded = onDiscardRecorded,
        )
    }

    private fun clip(): RecordedVoice {
        val context: Context = ApplicationProvider.getApplicationContext()
        val file = File(context.cacheDir, "voice-test.m4a").apply { writeBytes(ByteArray(16)) }
        return RecordedVoice(file, "voice-note.m4a", "audio/mp4")
    }

    @Test
    fun `while recording, the button stops rather than sends`() {
        var finished = 0
        composer(recordingSeconds = 7, onFinishRecording = { finished++ })

        compose.onNodeWithTag(A11y.COMPOSER_SEND).assertDoesNotExist()
        compose.onNodeWithTag(A11y.COMPOSER_STOP_RECORDING).performClick()
        assertEquals(1, finished)
    }

    @Test
    fun `a finished recording waits in the composer and goes only on Send`() {
        var sent = 0
        var discarded = 0
        composer(recorded = clip(), onSendRecorded = { sent++ }, onDiscardRecorded = { discarded++ })

        compose.onNodeWithTag(A11y.COMPOSER_RECORDED).assertIsDisplayed()
        assertEquals("nothing is sent before Send", 0, sent)

        compose.onNodeWithTag(A11y.COMPOSER_SEND).performClick()
        assertEquals(1, sent)
        assertEquals(0, discarded)
    }

    @Test
    fun `a finished recording can be thrown away instead`() {
        var sent = 0
        var discarded = 0
        composer(recorded = clip(), onSendRecorded = { sent++ }, onDiscardRecorded = { discarded++ })

        compose.onNodeWithContentDescription(Str.discard(Language.EN)).performClick()
        assertEquals(1, discarded)
        assertEquals(0, sent)
    }

    /** A note keeps its outline every time it is drawn, and no bar vanishes. */
    @Test
    fun `the waveform is the same for the same note and stays in range`() {
        val a = waveformLevels("att-42")
        assertEquals(a, waveformLevels("att-42"))
        assertTrue(a != waveformLevels("att-43"))
        assertTrue(a.all { it in 0.25f..1f })
    }
}
