package com.webyar.ai.feature.support

import com.webyar.ai.core.model.SupportConversation
import com.webyar.ai.core.model.SupportItem
import com.webyar.ai.core.model.SupportRating
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/**
 * The support chat's rows: conversations in order, each ended one closed by
 * a line and its rating, a "new conversation" line between them, day headers
 * and runs as in the other transcripts, and what is still being sent last.
 */
class SupportTimelineTest {

    private val zone = ZoneId.of("Asia/Tehran")
    private val monday = Instant.parse("2026-09-28T06:00:00Z")
    private val tuesday = Instant.parse("2026-09-29T06:00:00Z")

    private fun item(
        id: String,
        conversation: String,
        at: Instant,
        team: Boolean = false,
        name: String? = null,
        kind: String = SupportItem.KIND_MESSAGE,
        clientMessageId: String? = null,
    ) = SupportItem(
        id = id,
        conversationId = conversation,
        kind = kind,
        author = if (team) SupportItem.AUTHOR_TEAM else SupportItem.AUTHOR_ME,
        body = if (kind == SupportItem.KIND_JOINED) "" else "text $id",
        senderName = name,
        createdAt = at,
        clientMessageId = clientMessageId,
    )

    private val first = SupportConversation(
        id = "c-1",
        status = SupportConversation.STATUS_RESOLVED,
        createdAt = monday,
        endedAt = monday.plusSeconds(3_600),
        canRate = true,
    )
    private val second = SupportConversation(id = "c-2", status = SupportConversation.STATUS_OPEN, createdAt = tuesday)

    private val items = listOf(
        item("1", "c-1", monday),
        item("2", "c-1", monday.plusSeconds(60)),
        item("3", "c-1", monday.plusSeconds(120), team = true, name = "رضا", kind = SupportItem.KIND_JOINED),
        item("4", "c-1", monday.plusSeconds(180), team = true, name = "رضا"),
        item("5", "c-1", monday.plusSeconds(240), team = true, name = "سارا"),
        item("6", "c-2", tuesday, clientMessageId = "cm-6"),
    )

    @Test
    fun `conversations follow each other, each ended one closed and offered for rating`() {
        val rows = supportTimeline(listOf(first, second), items, emptyList(), zone)

        assertEquals(
            listOf("1", "2", "3", "4", "5", "ended-c-1", "rating-c-1", "new-c-2", "c-cm-6"),
            rows.map { it.key },
        )
        assertTrue(rows[6] is SupportRow.Rating)
        assertTrue(rows[7] is SupportRow.NewConversation)
    }

    @Test
    fun `a day header opens each day, but not under a new-conversation line`() {
        val rows = supportTimeline(listOf(first, second), items, emptyList(), zone)
        val bubbles = rows.filterIsInstance<SupportRow.Bubble>()

        assertNotNull(bubbles.first().dayHeader)
        assertTrue(bubbles.drop(1).dropLast(1).all { it.dayHeader == null })
        // Tuesday's first message: the line above it already says the day.
        assertNull(bubbles.last().dayHeader)
    }

    /** A run is one sender's messages in a row; two agents answering in turn are two. */
    @Test
    fun `runs break at a join, at the other side, and between two agents`() {
        val bubbles = supportTimeline(listOf(first, second), items, emptyList(), zone)
            .filterIsInstance<SupportRow.Bubble>()
            .associateBy { it.key }

        assertTrue(bubbles.getValue("1").startsRun)
        assertFalse(bubbles.getValue("1").endsRun)
        assertFalse(bubbles.getValue("2").startsRun)
        assertTrue(bubbles.getValue("2").endsRun)
        assertTrue(bubbles.getValue("4").startsRun && bubbles.getValue("4").endsRun)
        assertTrue(bubbles.getValue("5").startsRun && bubbles.getValue("5").endsRun)
    }

    @Test
    fun `a rated conversation keeps its card, one that cannot be rated has none`() {
        val rated = first.copy(canRate = false, rating = SupportRating(4, null, monday))
        val unanswered = first.copy(canRate = false)

        assertTrue(supportTimeline(listOf(rated), items, emptyList(), zone).any { it is SupportRow.Rating })
        assertFalse(supportTimeline(listOf(unanswered), items, emptyList(), zone).any { it is SupportRow.Rating })
    }

    @Test
    fun `what is still being sent comes last, and goes once the server has it`() {
        val waiting = PendingSupportItem("cm-7", "هنوز", tuesday.plusSeconds(60))
        val echoed = PendingSupportItem("cm-6", "text 6", tuesday)

        val rows = supportTimeline(listOf(first, second), items, listOf(echoed, waiting), zone)

        assertEquals("c-cm-7", rows.last().key)
        assertEquals(1, rows.count { it.key == "c-cm-6" })
        assertEquals(waiting, (rows.last() as SupportRow.Bubble).pending)
    }

    /** Sent after the end: the new conversation has its own line, under the ended one, never inside it. */
    @Test
    fun `a message to a new conversation sits under its own line`() {
        val endedItems = items.filter { it.conversationId == "c-1" }
        val next = PendingSupportItem("cm-8", "سلام دوباره", tuesday)

        val rows = supportTimeline(listOf(first), endedItems, listOf(next), zone)

        assertTrue(rows[rows.size - 3] is SupportRow.Rating)
        val line = rows[rows.size - 2] as SupportRow.NewConversation
        assertEquals(tuesday, line.startedAt)
        val bubble = rows.last() as SupportRow.Bubble
        assertEquals(next, bubble.pending)
        // The line carries the date: no day header under it.
        assertNull(bubble.dayHeader)
    }

    @Test
    fun `a message to the open conversation needs no line, and the first ever needs none either`() {
        val toOpen = PendingSupportItem("cm-9", "ادامه", tuesday.plusSeconds(90), conversationId = "c-2")
        val rows = supportTimeline(listOf(first, second), items, listOf(toOpen), zone)
        assertEquals(1, rows.count { it is SupportRow.NewConversation })
        assertEquals("c-cm-9", rows.last().key)

        val firstEver = PendingSupportItem("cm-10", "سلام", tuesday)
        val alone = supportTimeline(emptyList(), emptyList(), listOf(firstEver), zone)
        assertEquals(listOf("c-cm-10"), alone.map { it.key })
    }

    /** A key is the list's identity: a row the server sent twice must not end the app. */
    @Test
    fun `every key is unique, even for a row sent twice`() {
        val twice = items + item("4", "c-1", monday.plusSeconds(300), team = true, name = "رضا")

        val keys = supportTimeline(listOf(first, second), twice, emptyList(), zone).map { it.key }

        assertEquals(keys.size, keys.toSet().size)
    }

    @Test
    fun `an item of a conversation not in the list is left out`() {
        val stray = items + item("9", "c-unknown", tuesday)

        assertFalse(supportTimeline(listOf(first, second), stray, emptyList(), zone).any { it.key == "9" })
    }
}
