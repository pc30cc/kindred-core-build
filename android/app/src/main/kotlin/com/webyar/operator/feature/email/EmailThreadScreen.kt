package com.webyar.operator.feature.email

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.material3.Icon
import androidx.compose.foundation.shape.RoundedCornerShape
import com.webyar.operator.core.model.EmailMessageView
import com.webyar.operator.core.model.EmailThreadSummary
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.Avatar
import com.webyar.operator.ui.components.ErrorState
import com.webyar.operator.ui.components.Glyph
import com.webyar.operator.ui.components.LatinText
import com.webyar.operator.ui.components.SkeletonList
import com.webyar.operator.ui.components.bidiContent
import com.webyar.operator.ui.components.rowTextAlign
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme

/**
 * One email thread: the subject, the trail, and a box to answer it.
 *
 * Cards rather than bubbles. A mail is not a line of chat — it has a sender
 * line, a date, a body that may be paragraphs long, and attachments — and
 * squeezing all of that into a 300dp bubble with a beak would be a bubble
 * pretending to be a card. The outbound ones are tinted rather than moved to
 * the other side, which is what every mail client does and what keeps a long
 * quoted trail readable as one column.
 */
@Composable
fun EmailThreadScreen(
    state: EmailThreadState,
    thread: EmailThreadSummary?,
    language: Language,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
    onRetry: () -> Unit = {},
    composer: @Composable () -> Unit = {},
) {
    Column(modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) {
            when (state) {
                is EmailThreadState.Loading -> SkeletonList(
                    Modifier.fillMaxSize().padding(contentPadding),
                    rows = 4,
                )

                is EmailThreadState.Failed -> ErrorState(
                    title = Str.offlineTitle(language),
                    body = state.message,
                    retryLabel = Str.retry(language),
                    onRetry = onRetry,
                )

                is EmailThreadState.Loaded -> LazyColumn(
                    Modifier.fillMaxSize().testTag(A11y.EMAIL_THREAD),
                    contentPadding = PaddingValues(Space.screenInset),
                    verticalArrangement = Arrangement.spacedBy(Space.md),
                ) {
                    item(key = "subject") {
                        Text(
                            thread?.subject?.takeIf { it.isNotEmpty() }
                                ?: Str.emailNoSubject(language),
                            style = MaterialTheme.typography.titleLarge.bidiContent(),
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    items(state.messages, key = { it.id }) {
                        EmailMessageCard(it, language)
                    }
                }
            }
        }
        Box(Modifier.imePadding().navigationBarsPadding()) { composer() }
    }
}

@Composable
private fun EmailMessageCard(message: EmailMessageView, language: Language) {
    Surface(
        color = if (message.isOutbound) {
            // Tinted, not moved: a quoted trail stays one readable column.
            MaterialTheme.colorScheme.primary.copy(alpha = 0.08f)
        } else {
            MaterialTheme.colorScheme.surfaceContainer
        },
        shape = RoundedCornerShape(Radius.lg),
        modifier = Modifier.fillMaxWidth().testTag(A11y.emailMessage(message.id)),
    ) {
        Column(
            Modifier.padding(Space.md),
            verticalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Avatar(
                    name = message.fromAddress ?: "?",
                    size = Size.avatarSmall - 4.dp,
                )
                Column(Modifier.weight(1f).padding(horizontal = Space.sm)) {
                    LatinText(
                        message.fromAddress.orEmpty(),
                        style = MaterialTheme.typography.titleSmall,
                        maxLines = 1,
                        align = rowTextAlign(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text(
                        Format.listTimestamp(message.sentAt, language),
                        style = MaterialTheme.typography.labelSmall,
                        color = WebyarTheme.colors.labelTertiary,
                        maxLines = 1,
                    )
                }
                // A reply that never left is the one thing worth calling out
                // in the trail; everything else the operator can read for
                // themselves.
                if (message.deliveryStatus == "failed") {
                    Icon(
                        Icons.Filled.Warning,
                        contentDescription = Str.emailSendFailed(language),
                        tint = MaterialTheme.colorScheme.error,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }

            Text(
                message.displayBody,
                style = MaterialTheme.typography.bodyMedium.bidiContent(),
                modifier = Modifier.fillMaxWidth(),
            )

            message.attachments?.forEach { attachment ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        Glyph.Paperclip,
                        contentDescription = null,
                        tint = WebyarTheme.colors.labelTertiary,
                        modifier = Modifier.size(14.dp),
                    )
                    Text(
                        attachment.filename ?: Str.file(language),
                        style = MaterialTheme.typography.labelMedium,
                        color = WebyarTheme.colors.labelTertiary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(start = Space.xs),
                    )
                }
            }
        }
    }
}
