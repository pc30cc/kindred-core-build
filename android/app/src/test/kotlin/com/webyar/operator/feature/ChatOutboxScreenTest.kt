package com.webyar.operator.feature

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.webyar.operator.core.model.Message
import com.webyar.operator.core.model.SenderType
import com.webyar.operator.feature.chat.ChatScreen
import com.webyar.operator.feature.chat.ChatState
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.i18n.StrAndroid
import com.webyar.operator.ui.A11y
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** How an unsent message looks, and what a tap on it offers. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ChatOutboxScreenTest {

    @get:Rule val compose = createComposeRule()

    private fun mine(id: String, delivery: Message.Delivery) = Message(
        id = id,
        conversationId = "c-1",
        senderType = SenderType.AGENT,
        body = "body $id",
        localId = "l:$id",
        delivery = delivery,
    )

    @Test
    fun `a pending message says it is sending`() {
        compose.setContent {
            ChatScreen(ChatState.Loaded(listOf(mine("p", Message.Delivery.PENDING))), Language.FA, {})
        }
        compose.onNodeWithText(StrAndroid.messageSending(Language.FA)).assertIsDisplayed()
    }

    @Test
    fun `a failed message offers retry and delete`() {
        val retried = mutableListOf<Message>()
        val discarded = mutableListOf<Message>()
        val failed = mine("f", Message.Delivery.FAILED)
        compose.setContent {
            ChatScreen(
                ChatState.Loaded(listOf(failed)),
                Language.EN,
                {},
                onRetry = { retried += it },
                onDiscard = { discarded += it },
            )
        }

        compose.onNodeWithTag(A11y.messageStatus("f")).performClick()
        compose.onNodeWithText(Str.retry(Language.EN)).performClick()
        assertEquals(listOf(failed), retried)

        compose.onNodeWithTag(A11y.messageStatus("f")).performClick()
        compose.onNodeWithText(StrAndroid.discardMessage(Language.EN)).performClick()
        assertEquals(listOf(failed), discarded)
    }

    @Test
    fun `a sent message shows its time, not a status`() {
        compose.setContent {
            ChatScreen(ChatState.Loaded(listOf(mine("s", Message.Delivery.SENT))), Language.EN, {})
        }
        compose.onNodeWithTag(A11y.messageRow("s")).assertIsDisplayed()
        compose.onNodeWithText(StrAndroid.messageSending(Language.EN)).assertDoesNotExist()
    }
}
