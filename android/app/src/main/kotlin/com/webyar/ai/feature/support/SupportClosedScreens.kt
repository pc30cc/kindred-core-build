package com.webyar.ai.feature.support

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.webyar.ai.core.model.SupportConversation
import com.webyar.ai.i18n.Format
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.Str
import com.webyar.ai.i18n.StrAndroid
import com.webyar.ai.ui.A11y
import com.webyar.ai.ui.components.EmptyState
import com.webyar.ai.ui.components.ErrorState
import com.webyar.ai.ui.components.Glyph
import com.webyar.ai.ui.components.InsightGlyph
import com.webyar.ai.ui.components.LoadingIndicator
import com.webyar.ai.ui.components.bidiContent
import com.webyar.ai.ui.design.Space

/** Green for a conversation that was resolved, as the end panel's check is. */
private val ResolvedGreen = Color(0xFF1E9E5A)

/** The stars of a rating, in the colour stars are. */
private val StarGold = Color(0xFFF2A900)

/**
 * The chat bar's way to the conversations that ended — shown only when there
 * are some: an icon, and the word, so it reads as what it is.
 */
@Composable
fun SupportClosedButton(language: Language, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = Modifier.testTag(A11y.SUPPORT_CLOSED_BUTTON)) {
        Icon(Glyph.History, contentDescription = null, modifier = Modifier.size(20.dp))
        Text(
            StrAndroid.supportClosedAction(language),
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier.padding(start = Space.xs),
        )
    }
}

/** What a closed conversation is called: its first words, or a plain name. */
internal fun closedTitle(preview: String?, language: Language): String =
    preview?.takeIf { it.isNotBlank() } ?: StrAndroid.supportConversationUntitled(language)

/** «حل شد · یکشنبه ۵ مهر»: how and when it ended. */
internal fun closedSubtitle(conversation: SupportConversation, language: Language): String {
    val word = StrAndroid.supportStatusWord(language, conversation.status)
    val at = conversation.endedAt ?: conversation.createdAt
    return at?.let { "$word · ${Format.dayHeader(it, language)}" } ?: word
}

/**
 * The conversations that ended, the one that ended last first: each by its
 * first words, how and when it ended, and its stars — or a nudge to give
 * them. A tap reads it back.
 */
@Composable
fun SupportClosedListScreen(
    state: SupportArchiveState,
    language: Language,
    onRetry: () -> Unit,
    onOpen: (conversationId: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(modifier.fillMaxSize()) {
        when (state) {
            SupportArchiveState.Loading -> Box(Modifier.fillMaxSize(), Alignment.Center) { LoadingIndicator() }
            is SupportArchiveState.Failed -> ErrorState(
                title = Str.offlineTitle(language),
                body = state.message,
                retryLabel = Str.retry(language),
                onRetry = onRetry,
            )
            is SupportArchiveState.Loaded -> {
                val closed = state.closed
                if (closed.isEmpty()) {
                    EmptyState(icon = InsightGlyph.Chat, title = StrAndroid.supportClosedEmpty(language), body = null)
                } else {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize().testTag(A11y.SUPPORT_CLOSED_LIST),
                        contentPadding = PaddingValues(vertical = Space.sm),
                    ) {
                        items(closed, key = { it.id }) { conversation ->
                            ClosedRow(
                                conversation = conversation,
                                title = closedTitle(state.preview(conversation.id), language),
                                language = language,
                                onClick = { onOpen(conversation.id) },
                            )
                            HorizontalDivider(
                                Modifier.padding(start = 72.dp),
                                color = MaterialTheme.colorScheme.outlineVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ClosedRow(conversation: SupportConversation, title: String, language: Language, onClick: () -> Unit) {
    ListItem(
        headlineContent = {
            Text(
                title,
                style = MaterialTheme.typography.bodyLarge.bidiContent(),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        supportingContent = {
            Text(
                closedSubtitle(conversation, language),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        },
        leadingContent = {
            val resolved = conversation.status != SupportConversation.STATUS_CLOSED
            Box(
                Modifier
                    .size(40.dp)
                    .background(MaterialTheme.colorScheme.surfaceContainerHigh, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (resolved) Icons.Filled.CheckCircle else Glyph.History,
                    contentDescription = null,
                    tint = if (resolved) ResolvedGreen else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(22.dp),
                )
            }
        },
        trailingContent = {
            val given = conversation.rating
            when {
                given != null -> Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.semantics { contentDescription = StrAndroid.supportStars(language, given.score) },
                ) {
                    Icon(Icons.Filled.Star, contentDescription = null, tint = StarGold, modifier = Modifier.size(18.dp))
                    Text(
                        Format.number(given.score, language),
                        style = MaterialTheme.typography.labelLarge,
                        modifier = Modifier.padding(start = Space.xxs),
                    )
                }
                conversation.canRate -> Text(
                    StrAndroid.supportRateAction(language),
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
        },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.clickable(onClick = onClick).testTag(A11y.supportClosedRow(conversation.id)),
    )
}

/**
 * One closed conversation, read back: its messages, how it ended, and its
 * rating — given, or still to give. Nothing is written here.
 */
@Composable
fun SupportClosedConversationScreen(
    state: SupportArchiveState,
    conversationId: String,
    language: Language,
    onRetry: () -> Unit,
    onRate: (conversationId: String, score: Int, comment: String?) -> Unit,
    modifier: Modifier = Modifier,
    ratingBusy: Set<String> = emptySet(),
    loadAttachment: (suspend (String) -> ByteArray?)? = null,
    myAvatarUrl: String? = null,
) {
    Box(modifier.fillMaxSize().navigationBarsPadding()) {
        when (state) {
            SupportArchiveState.Loading -> Box(Modifier.fillMaxSize(), Alignment.Center) { LoadingIndicator() }
            is SupportArchiveState.Failed -> ErrorState(
                title = Str.offlineTitle(language),
                body = state.message,
                retryLabel = Str.retry(language),
                onRetry = onRetry,
            )
            is SupportArchiveState.Loaded -> {
                val conversation = state.conversation(conversationId)
                if (conversation == null) {
                    EmptyState(icon = InsightGlyph.Chat, title = StrAndroid.supportClosedEmpty(language), body = null)
                } else {
                    SupportTranscript(
                        conversations = listOf(conversation),
                        items = state.itemsOf(conversationId),
                        pending = emptyList(),
                        language = language,
                        ratingBusy = ratingBusy,
                        loadAttachment = loadAttachment,
                        myAvatarUrl = myAvatarUrl,
                        onRetryMessage = {},
                        onRate = onRate,
                    )
                }
            }
        }
    }
}
