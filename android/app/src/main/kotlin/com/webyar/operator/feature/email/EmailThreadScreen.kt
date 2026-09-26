package com.webyar.operator.feature.email

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.webyar.operator.core.model.EmailAttachmentView
import com.webyar.operator.core.model.EmailBody
import com.webyar.operator.core.model.EmailMessageView
import com.webyar.operator.core.model.EmailThreadSummary
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.i18n.StrEmail
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.ErrorState
import com.webyar.operator.ui.components.Glyph
import com.webyar.operator.ui.components.LatinText
import com.webyar.operator.ui.components.LoadingIndicator
import com.webyar.operator.ui.components.bidiContent
import com.webyar.operator.ui.components.rowTextAlign
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme
import com.webyar.operator.ui.design.WebyarType

/** How a reply is addressed. */
enum class EmailReplyMode { REPLY, REPLY_ALL, FORWARD }

/**
 * One email thread, the way a mail client shows it.
 *
 * The subject on top; then the trail as cards, folded — each earlier mail
 * one line (who, the first words, when) and the newest open, along with any
 * that are unread; a tap opens or folds one. An open mail says who it went
 * to, keeps the text it quotes folded behind a button, and lists its files
 * as things to open. At the foot, Reply, Reply all and Forward, which open
 * the composer already addressed.
 *
 * Cards rather than bubbles: a mail has a sender line, a date, paragraphs
 * and attachments, and the outbound ones are tinted rather than moved to the
 * other side, which keeps a long trail one readable column.
 */
@Composable
fun EmailThreadScreen(
    state: EmailThreadState,
    thread: EmailThreadSummary?,
    language: Language,
    modifier: Modifier = Modifier,
    mailbox: String? = null,
    onRetry: () -> Unit = {},
    onOpenAttachment: (EmailAttachmentView) -> Unit = {},
    onReply: ((EmailReplyMode) -> Unit)? = null,
) {
    Column(modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) {
            when (state) {
                is EmailThreadState.Loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    LoadingIndicator()
                }

                is EmailThreadState.Failed -> ErrorState(
                    title = Str.offlineTitle(language),
                    body = state.message,
                    retryLabel = Str.retry(language),
                    onRetry = onRetry,
                )

                is EmailThreadState.Loaded -> {
                    // The newest open, and whatever has not been read yet.
                    var open by rememberSaveable(state.messages.size) {
                        mutableStateOf(
                            state.messages.filterIndexed { index, message ->
                                index == state.messages.lastIndex || message.isRead == false
                            }.map { it.id }.toSet(),
                        )
                    }
                    LazyColumn(
                        Modifier.fillMaxSize().testTag(A11y.EMAIL_THREAD),
                        contentPadding = PaddingValues(Space.screenInset),
                        verticalArrangement = Arrangement.spacedBy(Space.sm),
                    ) {
                        item(key = "subject") {
                            Column(Modifier.fillMaxWidth().padding(bottom = Space.sm)) {
                                Text(
                                    thread?.subject?.takeIf { it.isNotEmpty() }
                                        ?: Str.emailNoSubject(language),
                                    style = WebyarType.headlineSmallEmphasized.bidiContent(),
                                    modifier = Modifier.fillMaxWidth(),
                                )
                                if (state.messages.size > 1) {
                                    Text(
                                        StrEmail.messagesCount(language, state.messages.size),
                                        style = MaterialTheme.typography.labelMedium,
                                        color = WebyarTheme.colors.labelTertiary,
                                        modifier = Modifier.padding(top = Space.xxs),
                                    )
                                }
                            }
                        }
                        items(state.messages, key = { it.id }) { message ->
                            val expanded = message.id in open
                            EmailMessageCard(
                                message = message,
                                expanded = expanded,
                                mailbox = mailbox,
                                language = language,
                                onToggle = {
                                    open = if (expanded) open - message.id else open + message.id
                                },
                                onOpenAttachment = onOpenAttachment,
                            )
                        }
                    }
                }
            }
        }
        if (onReply != null && state is EmailThreadState.Loaded) {
            ReplyBar(language, onReply)
        }
    }
}

/** Reply, Reply all, Forward — the three ways a mail is answered. */
@Composable
private fun ReplyBar(language: Language, onReply: (EmailReplyMode) -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surface, tonalElevation = 2.dp) {
        Row(
            Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = Space.screenInset, vertical = Space.sm),
            horizontalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            FilledTonalButton(
                onClick = { onReply(EmailReplyMode.REPLY) },
                modifier = Modifier.weight(1f).testTag(A11y.EMAIL_REPLY),
            ) {
                Text(StrEmail.reply(language), maxLines = 1)
            }
            OutlinedButton(
                onClick = { onReply(EmailReplyMode.REPLY_ALL) },
                modifier = Modifier.weight(1f).testTag(A11y.EMAIL_REPLY_ALL),
            ) {
                Text(StrEmail.replyAll(language), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            OutlinedButton(
                onClick = { onReply(EmailReplyMode.FORWARD) },
                modifier = Modifier.weight(1f).testTag(A11y.EMAIL_FORWARD),
            ) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowForward,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                )
                Text(StrEmail.forward(language), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = Space.xs))
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun EmailMessageCard(
    message: EmailMessageView,
    expanded: Boolean,
    mailbox: String?,
    language: Language,
    onToggle: () -> Unit,
    onOpenAttachment: (EmailAttachmentView) -> Unit,
) {
    Surface(
        color = if (message.isOutbound) {
            // Tinted, not moved: a quoted trail stays one readable column.
            MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f)
        } else {
            MaterialTheme.colorScheme.surfaceContainerLow
        },
        shape = RoundedCornerShape(Radius.xl),
        modifier = Modifier
            .fillMaxWidth()
            .animateContentSize()
            .testTag(A11y.emailMessage(message.id)),
    ) {
        Column(
            Modifier.padding(Space.lg),
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            // The header is the fold: a tap on it opens or closes the mail.
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(Radius.md))
                    .clickable(onClick = onToggle),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                MailAvatar(address = message.fromAddress.orEmpty(), size = Size.avatarSmall - 4.dp)
                Column(Modifier.weight(1f).padding(horizontal = Space.sm)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        LatinText(
                            message.fromAddress.orEmpty(),
                            style = WebyarType.titleMediumEmphasized.copy(
                                fontWeight = if (message.isRead == false) FontWeight.Bold else FontWeight.SemiBold,
                            ),
                            maxLines = 1,
                            align = rowTextAlign(),
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            if (expanded) fullTime(message, language) else Format.listTimestamp(message.sentAt, language),
                            style = MaterialTheme.typography.labelSmall,
                            color = WebyarTheme.colors.labelTertiary,
                            maxLines = 1,
                            modifier = Modifier.padding(start = Space.sm),
                        )
                    }
                    if (expanded) {
                        recipientsLine(message, mailbox, language)?.let { line ->
                            LatinText(
                                line,
                                style = MaterialTheme.typography.labelMedium,
                                color = WebyarTheme.colors.labelTertiary,
                                maxLines = 2,
                                align = rowTextAlign(),
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    } else {
                        // Folded: the first words, as a mail client shows it.
                        Text(
                            message.snippet?.takeIf { it.isNotBlank() } ?: message.displayBody.lineSequence().firstOrNull().orEmpty(),
                            style = MaterialTheme.typography.bodySmall.bidiContent(),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
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

            if (expanded) {
                val (fresh, quoted) = remember(message.id, message.displayBody) {
                    EmailBody.splitQuoted(message.displayBody)
                }
                var showQuoted by rememberSaveable(message.id) { mutableStateOf(false) }
                Text(
                    fresh,
                    style = MaterialTheme.typography.bodyLarge.bidiContent(),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (quoted != null) {
                    TextButton(
                        onClick = { showQuoted = !showQuoted },
                        contentPadding = PaddingValues(horizontal = Space.sm, vertical = 0.dp),
                    ) {
                        Text(
                            if (showQuoted) StrEmail.hideQuoted(language) else StrEmail.showQuoted(language),
                            style = MaterialTheme.typography.labelLarge,
                        )
                    }
                    AnimatedVisibility(visible = showQuoted) {
                        Row(Modifier.fillMaxWidth()) {
                            Box(
                                Modifier
                                    .padding(end = Space.sm)
                                    .size(width = 3.dp, height = 24.dp)
                                    .background(MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(2.dp)),
                            )
                            Text(
                                quoted,
                                style = MaterialTheme.typography.bodyMedium.bidiContent(),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                }

                // Each attachment as a tonal pill that opens the file.
                val files = message.attachments.orEmpty()
                if (files.isNotEmpty()) {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(Space.sm),
                        verticalArrangement = Arrangement.spacedBy(Space.sm),
                    ) {
                        files.forEach { attachment ->
                            AttachmentPill(attachment, language) { onOpenAttachment(attachment) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AttachmentPill(attachment: EmailAttachmentView, language: Language, onOpen: () -> Unit) {
    Row(
        Modifier
            .clip(RoundedCornerShape(Radius.lg))
            .background(MaterialTheme.colorScheme.surfaceContainerHighest)
            .clickable(onClick = onOpen)
            .padding(horizontal = Space.md, vertical = Space.sm)
            .testTag(A11y.emailAttachment(attachment.id)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            if (attachment.contentType?.startsWith("image/") == true) Glyph.Paperclip else Glyph.Document,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(18.dp),
        )
        Column(Modifier.padding(start = Space.sm)) {
            LatinText(
                attachment.filename ?: Str.file(language),
                style = MaterialTheme.typography.labelLarge,
                maxLines = 1,
            )
            attachment.sizeBytes?.let {
                Text(
                    Format.fileSize(it, language),
                    style = MaterialTheme.typography.labelSmall,
                    color = WebyarTheme.colors.labelTertiary,
                )
            }
        }
    }
}

/** "Today 14:30", "Thursday 2 Mehr 09:12" — the day and the time. */
private fun fullTime(message: EmailMessageView, language: Language): String {
    val at = message.sentAt ?: return ""
    return "${Format.dayHeader(at, language)} ${Format.bubbleTime(at, language)}"
}

/** "to me, sara@x.com · Cc ali@y.com" — the mailbox named as "me". */
private fun recipientsLine(message: EmailMessageView, mailbox: String?, language: Language): String? {
    fun name(address: String) =
        if (mailbox != null && address.equals(mailbox, ignoreCase = true)) StrEmail.me(language) else address
    val to = message.toAddresses.orEmpty().map { name(it.email) }
    val cc = message.ccAddresses.orEmpty().map { name(it.email) }
    if (to.isEmpty() && cc.isEmpty()) return null
    val toPart = if (to.isNotEmpty()) StrEmail.toLine(language, to.joinToString(", ")) else null
    val ccPart = if (cc.isNotEmpty()) "${StrEmail.cc(language)} ${cc.joinToString(", ")}" else null
    return listOfNotNull(toPart, ccPart).joinToString(" · ")
}
