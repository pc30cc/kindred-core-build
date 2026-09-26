package com.webyar.operator.feature.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import com.webyar.operator.i18n.Language
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.EMOJI_BACKSPACE_TAG
import com.webyar.operator.ui.components.EMOJI_PANEL_TAG
import com.webyar.operator.ui.components.EmojiCatalog
import com.webyar.operator.ui.components.deleteBefore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The emoji panel: in the keyboard's place, and writing where the caret is.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w420dp-h900dp")
class EmojiPanelTest {

    @get:Rule val compose = createComposeRule()

    private var draft = ""

    private fun composer(initial: String = "") {
        draft = initial
        compose.setContent {
            var held by remember { mutableStateOf(initial) }
            Composer(
                language = Language.EN,
                draft = held,
                onDraftChange = { held = it; draft = it },
                capabilities = ComposerCapabilities.TEAM,
                sending = false,
                onSend = {},
                onAttachPhoto = {},
                onAttachFile = {},
                onOpenShortcuts = {},
                onStartRecording = {},
            )
        }
    }

    @Test
    fun `the smiley opens the panel and the keyboard key closes it`() {
        composer()
        compose.onNodeWithTag(EMOJI_PANEL_TAG).assertDoesNotExist()

        compose.onNodeWithTag(A11y.COMPOSER_EMOJI).performClick()
        compose.onNodeWithTag(EMOJI_PANEL_TAG).assertIsDisplayed()

        // The same button, now a keyboard, goes back to typing.
        compose.onNodeWithTag(A11y.COMPOSER_EMOJI).performClick()
        compose.onNodeWithTag(EMOJI_PANEL_TAG).assertDoesNotExist()
    }

    @Test
    fun `a picked emoji is written into the draft, and backspace takes it out whole`() {
        composer("Hi ")
        compose.onNodeWithTag(A11y.COMPOSER_EMOJI).performClick()

        val first = EmojiCatalog.sections.first().emoji.first()
        compose.onNodeWithTag("emoji.$first").performClick()
        assertEquals("Hi $first", draft)

        compose.onNodeWithTag(EMOJI_BACKSPACE_TAG).performClick()
        assertEquals("Hi ", draft)
    }

    @Test
    fun `there are far more than the old twelve`() {
        val total = EmojiCatalog.sections.sumOf { it.emoji.size }
        assertTrue("only $total emoji", total > 300)
    }

    /** A family is one character to the eye, and one press of the key. */
    @Test
    fun `backspace removes a joined emoji in one go`() {
        val family = "👨‍👩‍👧"
        assertEquals("a" to 1, deleteBefore("a$family", 1 + family.length))
        assertEquals("" to 0, deleteBefore("", 0))
        assertEquals("ab" to 2, deleteBefore("abc", 3))
    }
}
