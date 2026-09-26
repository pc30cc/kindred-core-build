package com.webyar.operator.feature

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.core.net.SampleApi
import com.webyar.operator.feature.inbox.InboxScreen
import com.webyar.operator.feature.inbox.InboxState
import com.webyar.operator.i18n.Language
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.ConversationChannel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import com.webyar.operator.core.model.ConversationContact

/**
 * The strip above the inbox — Open, AI, Colleagues, and the button that
 * opens every inbox — and the channel each thread is written from.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w420dp-h1200dp")
class InboxStripTest {

    @get:Rule val compose = createComposeRule()

    private val all = listOf(
        InboxFilter.OPEN,
        InboxFilter.NEEDS_HUMAN,
        InboxFilter.PENDING,
        InboxFilter.AI,
        InboxFilter.RESOLVED,
        InboxFilter.SPAM,
    )

    private fun screen(
        conversations: List<Conversation> = runBlocking { SampleApi().conversations("ws-1", InboxFilter.OPEN) },
        onSelect: (InboxFilter) -> Unit = {},
        onColleagues: (() -> Unit)? = {},
    ) = compose.setContent {
        InboxScreen(
            state = InboxState.Loaded(conversations),
            language = Language.EN,
            onOpen = {},
            allFilters = all,
            chipFilters = listOf(InboxFilter.OPEN, InboxFilter.AI),
            onSelectFilter = onSelect,
            onOpenColleagues = onColleagues,
            onOpenEmail = {},
        )
    }

    @Test
    fun `the strip carries Open, AI and Colleagues, not the queues visited now and then`() {
        screen()
        compose.onNodeWithTag(A11y.inboxChip("open")).assertIsDisplayed()
        compose.onNodeWithTag(A11y.inboxChip("ai")).assertIsDisplayed()
        compose.onNodeWithTag(A11y.INBOX_COLLEAGUES_CHIP).assertIsDisplayed()
        compose.onNodeWithTag(A11y.INBOX_EVERY_INBOX).assertIsDisplayed()
        compose.onNodeWithTag(A11y.inboxChip("needsHuman")).assertDoesNotExist()
        compose.onNodeWithTag(A11y.inboxChip("pending")).assertDoesNotExist()
    }

    @Test
    fun `Colleagues opens the team chat`() {
        var opened = 0
        screen(onColleagues = { opened++ })
        compose.onNodeWithTag(A11y.INBOX_COLLEAGUES_CHIP).performClick()
        assertEquals(1, opened)
    }

    @Test
    fun `the three lines open every inbox, and picking one selects it`() {
        var picked: InboxFilter? = null
        screen(onSelect = { picked = it })

        compose.onNodeWithTag(A11y.INBOX_EVERY_INBOX).performClick()
        compose.onNodeWithTag(A11y.INBOX_EVERY_INBOX_SHEET).assertIsDisplayed()
        all.forEach { compose.onNodeWithTag(A11y.everyInboxRow(it.wire)).assertExists() }

        compose.onNodeWithTag(A11y.everyInboxRow("resolved")).performClick()
        assertEquals(InboxFilter.RESOLVED, picked)
    }

    @Test
    fun `every row says where the visitor writes from`() {
        val base = runBlocking { SampleApi().conversations("ws-1", InboxFilter.OPEN) }
        val telegram = base.first().copy(
            id = "tg-1",
            metadata = buildJsonObject { put("channel", JsonPrimitive("telegram")) },
        )
        screen(conversations = listOf(telegram) + base.drop(1))

        // On the row it belongs to (the sample has a Telegram thread of its own).
        compose.onNode(
            hasTestTag("channel.telegram") and hasAnyAncestor(hasTestTag(A11y.conversationRow("tg-1"))),
            useUnmergedTree = true,
        ).assertIsDisplayed()
        // The rest came from the site's own chat, and say so.
        assertTrue(compose.onAllNodesWithTag("channel.${ConversationChannel.WEB}", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
    }

    @Test
    fun `a channel is read from the conversation, then the contact, then is the website`() {
        val plain = runBlocking { SampleApi().conversations("ws-1", InboxFilter.OPEN) }.first()
        assertEquals(ConversationChannel.WEB, ConversationChannel.of(plain.copy(metadata = null)))
        assertEquals(
            "whatsapp",
            ConversationChannel.of(plain.copy(metadata = buildJsonObject { put("channel", JsonPrimitive("WhatsApp")) })),
        )
        assertEquals("x", ConversationChannel.normalize("twitter"))
    }

    @Test
    fun `how a thread began is not where it is written from`() {
        val plain = runBlocking { SampleApi().conversations("ws-1", InboxFilter.OPEN) }.first()
        // The AI's greeting stamps `source`; the thread is still the website's.
        val greeted = plain.copy(metadata = buildJsonObject { put("source", JsonPrimitive("ai_agent_intro")) })
        assertEquals(ConversationChannel.WEB, ConversationChannel.of(greeted))
        // …and an unknown value on the thread gives way to the contact's channel.
        val viaContact = greeted.copy(
            contact = (greeted.contact ?: ConversationContact()).copy(
                metadata = buildJsonObject { put("channel", JsonPrimitive("bale")) },
            ),
        )
        assertEquals("bale", ConversationChannel.of(viaContact))
    }
}
