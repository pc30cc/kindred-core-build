package com.webyar.ai.feature

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import com.webyar.ai.core.model.Conversation
import com.webyar.ai.core.model.InboxFilter
import com.webyar.ai.core.net.SampleApi
import com.webyar.ai.feature.inbox.InboxScreen
import com.webyar.ai.feature.inbox.InboxState
import com.webyar.ai.feature.inbox.OpenUnread
import com.webyar.ai.core.model.ChannelInbox
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import com.webyar.ai.i18n.Language
import com.webyar.ai.ui.A11y
import com.webyar.ai.ui.components.ConversationChannel
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
import com.webyar.ai.core.model.ConversationContact
import com.webyar.ai.core.model.ConversationPriority

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
        openUnread: OpenUnread = OpenUnread(),
        colleagueThreadsUnread: Int = 0,
        channels: List<ChannelInbox> = emptyList(),
    ) = compose.setContent {
        InboxScreen(
            state = InboxState.Loaded(conversations),
            language = Language.EN,
            onOpen = {},
            allFilters = all,
            chipFilters = listOf(InboxFilter.OPEN, InboxFilter.AI),
            channels = channels,
            onSelectFilter = onSelect,
            onOpenColleagues = onColleagues,
            onOpenEmail = {},
            openUnread = openUnread,
            colleagueThreadsUnread = colleagueThreadsUnread,
        )
    }

    private fun says(text: String) = SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, text)
    private val saysNothing = SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription)

    /**
     * The red dot is drawn, not text, so this reads what TalkBack is told: a
     * button with a dot says how many are unread, one without says nothing.
     */
    @Test
    fun `Open and Colleagues carry the dot, and the AI's queue never does`() {
        screen(
            openUnread = OpenUnread(conversations = 2, byChannel = mapOf("telegram" to 1, "widget" to 1)),
            colleagueThreadsUnread = 1,
            channels = listOf(ChannelInbox("telegram"), ChannelInbox("bale")),
        )
        compose.onNodeWithTag(A11y.inboxChip("open")).assert(says("2 unread"))
        compose.onNodeWithTag(A11y.INBOX_COLLEAGUES_CHIP).assert(says("1 unread"))
        compose.onNodeWithTag(A11y.inboxChip("ai")).assert(saysNothing)
        // Telegram is behind the three lines, and holds one of them.
        compose.onNodeWithTag(A11y.INBOX_EVERY_INBOX).assert(says("1 unread"))
    }

    @Test
    fun `nothing unread, no dot anywhere`() {
        screen(channels = listOf(ChannelInbox("telegram")))
        compose.onNodeWithTag(A11y.inboxChip("open")).assert(saysNothing)
        compose.onNodeWithTag(A11y.INBOX_COLLEAGUES_CHIP).assert(saysNothing)
        compose.onNodeWithTag(A11y.INBOX_EVERY_INBOX).assert(saysNothing)
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
    fun `urgent and high are tagged on their rows, low and normal are not`() {
        val base = runBlocking { SampleApi().conversations("ws-1", InboxFilter.OPEN) }.take(4)
        val marked = base.zip(
            listOf(ConversationPriority.URGENT, ConversationPriority.HIGH, ConversationPriority.LOW, ConversationPriority.NORMAL),
        ) { conversation, priority -> conversation.copy(priority = priority) }
        screen(conversations = marked)

        fun tagOn(row: String, wire: String) = compose.onNode(
            hasTestTag(A11y.priorityTag(wire)) and hasAnyAncestor(hasTestTag(A11y.conversationRow(row))),
            useUnmergedTree = true,
        )
        tagOn(marked[0].id, "urgent").assertIsDisplayed()
        tagOn(marked[1].id, "high").assertIsDisplayed()
        compose.onNodeWithTag(A11y.priorityTag("low"), useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag(A11y.priorityTag("normal"), useUnmergedTree = true).assertDoesNotExist()
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
