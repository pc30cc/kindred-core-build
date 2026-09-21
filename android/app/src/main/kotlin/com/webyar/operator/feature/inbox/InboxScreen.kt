package com.webyar.operator.feature.inbox

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Badge
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.webyar.operator.core.model.Conversation
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.i18n.StrManual
import com.webyar.operator.ui.A11y

/**
 * The list of conversations.
 *
 * The preview line is the part worth reading twice. `last_message.body` alone
 * is not enough to write one with: an attachment-only message has no body at
 * all, which is what used to render as a blank second line. The list endpoint
 * ships `attachment_kind` and `sender_name` precisely so the row can be
 * written from those instead, and `previewSentBy*` is where that sentence
 * lives — in three languages, because the stored body would only ever have
 * been in one.
 */
@Composable
fun InboxScreen(
    state: InboxState,
    language: Language,
    onOpen: (Conversation) -> Unit,
    modifier: Modifier = Modifier,
) {
    when (state) {
        is InboxState.Loading -> Box(modifier.fillMaxSize(), Alignment.Center) {
            CircularProgressIndicator()
        }

        is InboxState.Failed -> Box(modifier.fillMaxSize().padding(24.dp), Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(Str.offlineTitle(language), style = MaterialTheme.typography.titleMedium)
                Text(state.message, style = MaterialTheme.typography.bodyMedium)
            }
        }

        is InboxState.Loaded -> if (state.conversations.isEmpty()) {
            Box(modifier.fillMaxSize().padding(24.dp).testTag(A11y.INBOX_EMPTY), Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(Str.inboxEmptyTitle(language), style = MaterialTheme.typography.titleMedium)
                    Text(Str.inboxEmptyBody(language), style = MaterialTheme.typography.bodyMedium)
                }
            }
        } else {
            LazyColumn(modifier.fillMaxSize().testTag(A11y.INBOX_LIST)) {
                items(state.conversations, key = { it.id }) { conversation ->
                    ConversationRow(conversation, language) { onOpen(conversation) }
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun ConversationRow(
    conversation: Conversation,
    language: Language,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .testTag(A11y.conversationRow(conversation.id))
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                text = conversation.displayName(language),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = if (conversation.hasUnread) FontWeight.Bold else FontWeight.Normal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = conversation.preview(language),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                // Two lines, then ellipsis — a long preview must not push the
                // badge out of the row.
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (conversation.hasUnread) {
            Badge { Text(Format.number(conversation.unreadCount ?: 0, language)) }
        }
    }
}

/** The visitor's name, or the fact that they never gave one. */
internal fun Conversation.displayName(language: Language): String =
    contact?.name?.takeIf { it.isNotBlank() }
        ?: contact?.email?.takeIf { it.isNotBlank() }
        ?: contact?.visitorCode?.takeIf { it.isNotBlank() }
        ?: Str.unknownVisitor(language)

/**
 * The second line of a row.
 *
 * An attachment with no caption has no body, so the sentence is rebuilt from
 * who sent it and what kind of file it was.
 */
internal fun Conversation.preview(language: Language): String {
    val last = lastMessage ?: return ""
    val body = last.body?.trim()
    if (!body.isNullOrEmpty()) return body

    val who = last.senderName?.takeIf { it.isNotBlank() } ?: displayName(language)
    return when (last.attachmentKind) {
        "image" -> StrManual.previewSentByImage(language, who)
        "audio" -> StrManual.previewSentByAudio(language, who)
        "video" -> StrManual.previewSentByVideo(language, who)
        "file" -> StrManual.previewSentByFile(language, who)
        else -> ""
    }
}

sealed interface InboxState {
    data object Loading : InboxState
    data class Loaded(val conversations: List<Conversation>) : InboxState
    data class Failed(val message: String) : InboxState
}
