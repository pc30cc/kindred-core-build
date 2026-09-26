package com.webyar.operator.feature

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.core.net.SampleApi
import com.webyar.operator.feature.chat.ChatScreen
import com.webyar.operator.feature.chat.ChatState
import com.webyar.operator.i18n.Language
import com.webyar.operator.ui.A11y
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ChatScreenTest {

    @get:Rule val compose = createComposeRule()

    /**
     * A transcript opens on its NEWEST message, not its oldest.
     *
     * This test asserted `m-1` first and failed, which was the test being
     * wrong rather than the screen: `m-1` is the oldest of thirteen, a
     * LazyColumn never composes what is scrolled away, and an inbox that
     * opened two weeks up the thread would be useless. So the assertion is
     * the behaviour that is actually wanted.
     */
    @Test
    fun `the transcript opens on the newest message`() = runTest {
        val messages = SampleApi().messages("c-1")
        assertTrue(messages.size > 5)
        compose.setContent { ChatScreen(ChatState.Loaded(messages), Language.FA, {}) }
        compose.onNodeWithTag(A11y.CHAT_TRANSCRIPT).assertIsDisplayed()
        compose.onNodeWithTag(A11y.messageRow(messages.last().id)).assertIsDisplayed()
    }

    /** A thread short enough to fit shows its first message too. */
    @Test
    fun `a short transcript shows all of itself`() = runTest {
        val messages = SampleApi().messages("c-4")
        assertTrue(messages.size in 1..4)
        compose.setContent { ChatScreen(ChatState.Loaded(messages), Language.TR, {}) }
        compose.onNodeWithTag(A11y.messageRow(messages.first().id)).assertIsDisplayed()
        compose.onNodeWithTag(A11y.messageRow(messages.last().id)).assertIsDisplayed()
    }

    /** An empty draft must not be sendable — that is a message of "" to a visitor. */
    @Test
    fun `the send button is disabled until something is typed`() {
        compose.setContent { ChatScreen(ChatState.Loaded(emptyList()), Language.EN, {}) }
        compose.onNodeWithTag(A11y.COMPOSER_SEND).assertIsNotEnabled()
    }

    /**
     * The composer does not own the draft, and these two tests say so.
     *
     * It used to hold its own `remember { mutableStateOf("") }`, which made it
     * impossible for anything outside to put text in the field — and a saved
     * reply has to do exactly that. So the state is hoisted, the screen
     * reports what was typed, and the caller decides what the draft is.
     */
    @Test
    fun `typing is reported to the caller, character for character`() {
        var draft = ""
        compose.setContent {
            var held by remember { mutableStateOf("") }
            ChatScreen(
                state = ChatState.Loaded(emptyList()),
                language = Language.EN,
                onSend = {},
                draft = held,
                onDraftChange = { held = it; draft = it },
            )
        }
        compose.onNodeWithTag(A11y.COMPOSER_FIELD).performTextInput("on my way")
        compose.waitForIdle()
        assertEquals("on my way", draft)
    }

    @Test
    fun `sending hands up whatever the draft holds`() {
        var sent: String? = null
        compose.setContent {
            var held by remember { mutableStateOf("") }
            ChatScreen(
                state = ChatState.Loaded(emptyList()),
                language = Language.EN,
                onSend = { sent = it },
                draft = held,
                onDraftChange = { held = it },
            )
        }
        compose.onNodeWithTag(A11y.COMPOSER_FIELD).performTextInput("on my way")
        compose.onNodeWithTag(A11y.COMPOSER_SEND).performClick()
        compose.waitForIdle()
        assertEquals("on my way", sent)
    }

    /**
     * Whitespace alone is not a message.
     *
     * The TRIMMING moved to the view model when the draft was hoisted — the
     * screen no longer decides what a message is — but the button still has to
     * refuse a draft of spaces, or the operator sends "" to a visitor.
     */
    @Test
    fun `a draft of only spaces cannot be sent`() {
        compose.setContent {
            ChatScreen(
                state = ChatState.Loaded(emptyList()),
                language = Language.EN,
                onSend = {},
                draft = "   ",
            )
        }
        compose.onNodeWithTag(A11y.COMPOSER_SEND).assertIsNotEnabled()
    }

    /** The sample backend keeps what it is sent, which is what makes a slice a slice. */
    @Test
    fun `a sent message comes back in the thread`() = runTest {
        val api = SampleApi()
        val before = api.messages("c-1").size
        api.send(
            body = "سلام",
            conversationId = "c-1",
            workspaceId = "ws-1",
            clientMessageId = "client-0000-0001",
        )
        val after = api.messages("c-1")
        assertEquals(before + 1, after.size)
        assertEquals("سلام", after.last().body)
    }

    /**
     * The visitor's face or name in the bar is the way to their contact page —
     * one target, the way a messaging app's header is.
     */
    @Test
    fun `tapping the visitor in the bar opens their contact`() = runTest {
        val api = SampleApi()
        val conversation = api.conversations("ws-1", InboxFilter.OPEN).first()
        var opened = 0
        compose.setContent {
            ChatScreen(
                state = ChatState.Loaded(emptyList()),
                language = Language.EN,
                onSend = {},
                onBack = {},
                conversation = conversation,
                onOpenVisitor = { opened++ },
            )
        }
        compose.onNodeWithTag(A11y.CHAT_OPEN_VISITOR).performClick()
        assertEquals(1, opened)
    }

    /** Without somewhere to go, the header is not dressed up as a button. */
    @Test
    fun `no contact to open means no target in the bar`() = runTest {
        val conversation = SampleApi().conversations("ws-1", InboxFilter.OPEN).first()
        compose.setContent {
            ChatScreen(
                state = ChatState.Loaded(emptyList()),
                language = Language.EN,
                onSend = {},
                onBack = {},
                conversation = conversation,
            )
        }
        compose.onNodeWithTag(A11y.CHAT_OPEN_VISITOR).assertDoesNotExist()
    }
}
