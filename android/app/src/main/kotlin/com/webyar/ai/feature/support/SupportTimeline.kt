package com.webyar.ai.feature.support

import com.webyar.ai.core.media.AttachmentRules
import com.webyar.ai.core.model.MessageAttachment
import com.webyar.ai.core.model.SupportConversation
import com.webyar.ai.core.model.SupportItem
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** A message or file the operator sent that the server has not confirmed yet. */
data class PendingSupportItem(
    /** Minted once; every attempt carries it, so a retry is the same message. */
    val clientMessageId: String,
    val body: String,
    val createdAt: Instant,
    /** A file, held until it lands — a retry sends these same bytes. */
    val file: SupportUpload? = null,
    val failed: Boolean = false,
    /**
     * The active conversation it was written to; null for the first message
     * of a new one. Every attempt names the same one, so a retry never lands
     * anywhere else.
     */
    val conversationId: String? = null,
)

/**
 * A picked file on its way to the team. Not a data class: two uploads are
 * the same only if they are the same object, never because their bytes match.
 */
class SupportUpload(val bytes: ByteArray, val fileName: String, val mimeType: String) {
    /** The card the pending bubble shows: the name and the size, nothing fetched. */
    fun asAttachment(clientMessageId: String): MessageAttachment = MessageAttachment(
        id = "pending-$clientMessageId",
        fileName = fileName,
        mimeType = mimeType,
        sizeBytes = bytes.size,
        kind = AttachmentRules.kindOf(mimeType),
    )
}

/**
 * One row of the support chat. Worked out once for the whole list, as the
 * other transcripts do: a `LazyColumn` composes rows in an order nobody
 * controls, so a row cannot look at its neighbours while it draws.
 */
internal sealed interface SupportRow {
    val key: String

    /** «گفتگوی تازه · ‹date›», before each conversation after the first. */
    data class NewConversation(override val key: String, val startedAt: Instant?) : SupportRow

    /** «‹name› به گفتگو پیوست». */
    data class Joined(override val key: String, val name: String?, val dayHeader: Instant?) : SupportRow

    /** A message: the server's [item], or one still on its way ([pending]). */
    data class Bubble(
        override val key: String,
        val item: SupportItem?,
        val pending: PendingSupportItem?,
        val mine: Boolean,
        val time: Instant?,
        val dayHeader: Instant?,
        val startsRun: Boolean = false,
        val endsRun: Boolean = false,
    ) : SupportRow {
        /** Who a run belongs to: the operator, or one agent of the team. */
        val sender: String get() = if (mine) "me" else "team:${item?.senderName.orEmpty()}"
    }

    /** «این گفتگو حل شد · ‹date›», under a conversation that ended. */
    data class Ended(override val key: String, val conversation: SupportConversation) : SupportRow

    /** The stars to give, or the ones given. */
    data class Rating(override val key: String, val conversation: SupportConversation) : SupportRow
}

/**
 * The conversations given, in order, each followed by how it ended and its
 * rating, then whatever the operator is still sending. The chat gives the
 * one it shows (or none, on a fresh page); a closed conversation is read
 * back on its own.
 *
 * What is on its way to a new conversation sits under its own "new
 * conversation" line, below any ended one and never inside it.
 *
 * A day header goes above the first message of each day, as in the other
 * transcripts — except right under a "new conversation" line, which already
 * carries the date. An item whose conversation is not in [conversations]
 * has nothing to be filed under and is left out.
 */
internal fun supportTimeline(
    conversations: List<SupportConversation>,
    items: List<SupportItem>,
    pending: List<PendingSupportItem>,
    zone: ZoneId = ZoneId.systemDefault(),
): List<SupportRow> {
    val rows = mutableListOf<SupportRow>()
    var lastDay: LocalDate? = null
    fun header(time: Instant?): Instant? {
        val day = time?.atZone(zone)?.toLocalDate() ?: return null
        if (day == lastDay) return null
        lastDay = day
        return time
    }

    val byConversation = items.groupBy { it.conversationId }
    conversations.forEachIndexed { index, conversation ->
        if (index > 0) {
            rows += SupportRow.NewConversation("new-${conversation.id}", conversation.createdAt)
            conversation.createdAt?.atZone(zone)?.toLocalDate()?.let { lastDay = it }
        }
        byConversation[conversation.id].orEmpty().forEach { item ->
            when {
                item.isJoin -> rows += SupportRow.Joined(item.id, item.senderName, header(item.createdAt))
                item.body.isNotBlank() || item.attachments.isNotEmpty() -> rows += SupportRow.Bubble(
                    key = item.clientMessageId?.let { "c-$it" } ?: item.id,
                    item = item,
                    pending = null,
                    mine = !item.fromTeam,
                    time = item.createdAt,
                    dayHeader = header(item.createdAt),
                )
            }
        }
        if (conversation.ended) {
            rows += SupportRow.Ended("ended-${conversation.id}", conversation)
            if (conversation.canRate || conversation.rating != null) {
                rows += SupportRow.Rating("rating-${conversation.id}", conversation)
            }
        }
    }
    // Once the server has it, its own copy is the one shown.
    val delivered = items.mapNotNullTo(HashSet()) { it.clientMessageId }
    val (toActive, toNew) = pending.filterNot { it.clientMessageId in delivered }.partition { it.conversationId != null }
    fun waiting(entry: PendingSupportItem) {
        rows += SupportRow.Bubble(
            // The same key the server's copy will have, so the bubble is not
            // recreated the moment it lands.
            key = "c-${entry.clientMessageId}",
            item = null,
            pending = entry,
            mine = true,
            time = entry.createdAt,
            dayHeader = header(entry.createdAt),
        )
    }
    toActive.forEach(::waiting)
    if (conversations.isNotEmpty() && toNew.isNotEmpty()) {
        val startedAt = toNew.firstOrNull()?.createdAt
        rows += SupportRow.NewConversation("new-next", startedAt)
        startedAt?.atZone(zone)?.toLocalDate()?.let { lastDay = it }
    }
    toNew.forEach(::waiting)

    // Runs: one sender's messages in a row, unbroken by a day or a line.
    // Keys are the list's identity, and a repeated one ends the app; a row
    // the server sent twice is shown twice rather than that.
    val seen = HashSet<String>()
    return rows.mapIndexed { index, candidate ->
        val row = if (seen.add(candidate.key)) candidate else candidate.rekeyed("${candidate.key}#$index")
        if (row !is SupportRow.Bubble) return@mapIndexed row
        val previous = rows.getOrNull(index - 1) as? SupportRow.Bubble
        val next = rows.getOrNull(index + 1) as? SupportRow.Bubble
        row.copy(
            startsRun = previous == null || previous.sender != row.sender || row.dayHeader != null,
            endsRun = next == null || next.sender != row.sender || next.dayHeader != null,
        )
    }
}

private fun SupportRow.rekeyed(key: String): SupportRow = when (this) {
    is SupportRow.NewConversation -> copy(key = key)
    is SupportRow.Joined -> copy(key = key)
    is SupportRow.Bubble -> copy(key = key)
    is SupportRow.Ended -> copy(key = key)
    is SupportRow.Rating -> copy(key = key)
}
