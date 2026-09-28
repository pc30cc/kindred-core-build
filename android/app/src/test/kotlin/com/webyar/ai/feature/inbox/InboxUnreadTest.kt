package com.webyar.ai.feature.inbox

import com.webyar.ai.core.model.Colleague
import com.webyar.ai.core.model.ColleaguesResponse
import com.webyar.ai.core.model.Conversation
import com.webyar.ai.i18n.Language
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * What the Inbox tab's badge and the strip's dots count: conversations, not
 * messages, in exactly the Open queue and the colleagues' threads — the
 * iOS app's `InboxBadge`.
 *
 * Under Robolectric for the digits: they come from the platform's ICU.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class InboxUnreadTest {

    private fun row(id: String, unread: Int, channel: String? = null) = Conversation(
        id = id,
        workspaceId = "ws-1",
        unreadCount = unread,
        metadata = channel?.let { buildJsonObject { put("channel", it) } },
    )

    private fun colleague(id: String, unread: Int?) = Colleague(userId = id, unread = unread)

    @Test
    fun `Open counts the conversations holding an unread message, by channel too`() {
        val open = OpenUnread.of(
            listOf(
                row("c-1", unread = 3, channel = "telegram"),
                row("c-2", unread = 0, channel = "telegram"),
                row("c-3", unread = 1),
                row("c-4", unread = 1, channel = "whatsapp"),
            ),
        )
        assertEquals("three conversations, however many messages", 3, open.conversations)
        assertEquals(mapOf("telegram" to 1, "widget" to 1, "whatsapp" to 1), open.byChannel)
    }

    @Test
    fun `everything read is nothing at all`() {
        assertEquals(OpenUnread(), OpenUnread.of(listOf(row("c-1", 0), row("c-2", 0))))
        assertEquals(0, inboxBadgeCount(OpenUnread(), TeamUnread()))
    }

    @Test
    fun `colleagues count as threads, not messages`() {
        val team = TeamUnread.of(
            ColleaguesResponse(
                colleagues = listOf(colleague("u-2", 2), colleague("u-3", 2), colleague("u-4", 0)),
                totalUnread = 4,
            ),
        )
        assertEquals(2, team.threads)
        assertEquals("the Colleagues button keeps its message count", 4, team.messages)
    }

    /** A server that sends the total and not the rows still has something unread. */
    @Test
    fun `a total without rows is one thread, not none`() {
        assertEquals(TeamUnread(threads = 1, messages = 3), TeamUnread.of(ColleaguesResponse(totalUnread = 3)))
        assertEquals(TeamUnread(), TeamUnread.of(ColleaguesResponse(totalUnread = 0)))
    }

    @Test
    fun `the badge is Open plus the colleagues' threads, and Open alone without team chat`() {
        val open = OpenUnread(conversations = 2)
        assertEquals(5, inboxBadgeCount(open, TeamUnread(threads = 3, messages = 9)))
        assertEquals(2, inboxBadgeCount(open, null))
    }

    @Test
    fun `the badge reads in the operator's digits and stops at 99`() {
        assertEquals("7", badgeText(7, Language.EN))
        assertEquals("99+", badgeText(140, Language.EN))
        assertEquals("۷", badgeText(7, Language.FA))
        assertEquals("۹۹+", badgeText(100, Language.FA))
    }
}
