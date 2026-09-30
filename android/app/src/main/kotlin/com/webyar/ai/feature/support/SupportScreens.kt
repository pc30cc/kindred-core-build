package com.webyar.ai.feature.support

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.webyar.ai.core.model.SupportMessage
import com.webyar.ai.core.model.SupportStatus
import com.webyar.ai.core.model.SupportThread
import com.webyar.ai.i18n.Format
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.Str
import com.webyar.ai.i18n.StrAndroid
import com.webyar.ai.ui.A11y
import com.webyar.ai.ui.components.DayHeader
import com.webyar.ai.ui.components.EmptyState
import com.webyar.ai.ui.components.ErrorState
import com.webyar.ai.ui.components.Glyph
import com.webyar.ai.ui.components.InsightGlyph
import com.webyar.ai.ui.components.LoadingIndicator
import com.webyar.ai.ui.components.MessageBubble
import com.webyar.ai.ui.components.OperatorAvatar
import com.webyar.ai.ui.components.PillTone
import com.webyar.ai.ui.components.StatusPill
import com.webyar.ai.ui.components.StickToNewest
import com.webyar.ai.ui.components.UnreadBadge
import com.webyar.ai.ui.components.bidiContent
import com.webyar.ai.ui.design.Radius
import com.webyar.ai.ui.design.Size
import com.webyar.ai.ui.design.Space
import java.time.Instant
import java.time.ZoneId

/** Green for a team that is there now, as a presence dot is everywhere. */
private val OnlineGreen = Color(0xFF1E9E5A)

/**
 * Support's home: who answers and whether they are there now, the way in —
 * a chat while the team is online, a ticket while it is not — and the
 * operator's earlier requests, newest activity first.
 */
@Composable
fun SupportHomeScreen(
    status: SupportStatus?,
    threads: List<SupportThread>,
    loaded: Boolean,
    language: Language,
    onStartChat: () -> Unit,
    onNewTicket: () -> Unit,
    onOpenThread: (SupportThread) -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
) {
    LazyColumn(
        modifier.fillMaxSize().testTag(A11y.SUPPORT_HOME),
        contentPadding = PaddingValues(
            start = Space.lg,
            end = Space.lg,
            top = Space.lg,
            bottom = Space.xxl + contentPadding.calculateBottomPadding(),
        ),
        verticalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        item(key = "team") { TeamCard(status, language, onStartChat, onNewTicket) }
        item(key = "requests-header") {
            Text(
                StrAndroid.supportMyRequests(language),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(top = Space.md, start = Space.xs),
            )
        }
        when {
            !loaded -> item(key = "loading") {
                Box(Modifier.fillMaxWidth().padding(Space.xl), Alignment.Center) { LoadingIndicator() }
            }
            threads.isEmpty() -> item(key = "empty") {
                EmptyState(icon = Glyph.Ticket, title = StrAndroid.supportEmpty(language), body = null)
            }
            else -> items(threads, key = { it.id }) { thread ->
                ThreadCard(thread, language, onClick = { onOpenThread(thread) })
            }
        }
    }
}

@Composable
private fun TeamCard(
    status: SupportStatus?,
    language: Language,
    onStartChat: () -> Unit,
    onNewTicket: () -> Unit,
) {
    Surface(
        shape = RoundedCornerShape(Radius.xl),
        color = MaterialTheme.colorScheme.secondaryContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(Space.lg), verticalArrangement = Arrangement.spacedBy(Space.md)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(52.dp).background(MaterialTheme.colorScheme.primary, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Glyph.Help, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(28.dp))
                }
                Column(Modifier.weight(1f).padding(horizontal = Space.md)) {
                    Text(
                        status?.teamName ?: StrAndroid.supportTeam(language),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onSecondaryContainer,
                    )
                    if (status != null) PresenceLine(status.online, language)
                }
            }
            if (status != null && status.shown) {
                Text(
                    if (status.online) StrAndroid.supportOnlineHint(language) else StrAndroid.supportOfflineHint(language),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSecondaryContainer,
                )
                if (status.online) {
                    Button(
                        onClick = onStartChat,
                        modifier = Modifier.fillMaxWidth().heightIn(min = Size.minTouchTarget).testTag(A11y.SUPPORT_START),
                    ) {
                        Icon(InsightGlyph.Chat, contentDescription = null, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.size(Space.sm))
                        Text(StrAndroid.supportStartChat(language))
                    }
                }
                if (status.ticketsEnabled && !status.online) {
                    Button(
                        onClick = onNewTicket,
                        modifier = Modifier.fillMaxWidth().heightIn(min = Size.minTouchTarget).testTag(A11y.SUPPORT_START),
                    ) {
                        Icon(Glyph.Ticket, contentDescription = null, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.size(Space.sm))
                        Text(StrAndroid.supportNewTicket(language))
                    }
                } else if (status.ticketsEnabled) {
                    // Online, a ticket is still the right way for something
                    // that can wait — and it keeps a subject and a number.
                    OutlinedButton(onClick = onNewTicket, modifier = Modifier.fillMaxWidth()) {
                        Text(StrAndroid.supportNewTicket(language))
                    }
                }
            } else if (status != null) {
                Text(
                    StrAndroid.supportUnavailable(language),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSecondaryContainer,
                )
            }
        }
    }
}

@Composable
internal fun PresenceLine(online: Boolean, language: Language) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier
                .size(8.dp)
                .background(if (online) OnlineGreen else MaterialTheme.colorScheme.outline, CircleShape),
        )
        Text(
            if (online) StrAndroid.supportOnline(language) else StrAndroid.supportOffline(language),
            style = MaterialTheme.typography.labelLarge,
            color = if (online) OnlineGreen else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = Space.xs),
        )
    }
}

@Composable
private fun ThreadCard(thread: SupportThread, language: Language, onClick: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(Radius.lg),
        color = MaterialTheme.colorScheme.surfaceContainer,
        modifier = Modifier.fillMaxWidth().testTag(A11y.supportThread(thread.id)),
    ) {
        Row(
            Modifier.clickable(onClick = onClick).padding(Space.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier.size(44.dp).background(MaterialTheme.colorScheme.secondaryContainer, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (thread.isTicket) Glyph.Ticket else InsightGlyph.Chat,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSecondaryContainer,
                    modifier = Modifier.size(22.dp),
                )
            }
            Column(Modifier.weight(1f).padding(horizontal = Space.md), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        threadTitle(thread, language),
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = if (thread.unread > 0) FontWeight.Bold else FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    Spacer(Modifier.size(Space.sm))
                    StatusPill(
                        StrAndroid.supportStatus(language, thread.status),
                        tone = when (thread.status) {
                            "resolved" -> PillTone.SUCCESS
                            "pending" -> PillTone.WARNING
                            "closed" -> PillTone.NEUTRAL
                            else -> PillTone.BRAND
                        },
                    )
                }
                thread.lastMessage?.let { last ->
                    Text(
                        (if (last.fromTeam) "" else StrAndroid.youPrefix(language)) + Format.preview(last.body),
                        style = MaterialTheme.typography.bodyMedium.bidiContent(),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                Text(
                    Format.listTimestamp(thread.updatedAt, language),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (thread.unread > 0) UnreadBadge(thread.unread, language)
            }
        }
    }
}

/** "Ticket #1042 · Invoice", or "Chat" — how a thread is named everywhere. */
internal fun threadTitle(thread: SupportThread, language: Language): String {
    val number = Format.number(thread.number, language)
    return if (thread.isTicket) {
        val label = StrAndroid.supportTicketNumber(language, number)
        thread.subject?.takeIf { it.isNotBlank() }?.let { "$label · $it" } ?: label
    } else {
        StrAndroid.supportChatLabel(language)
    }
}

/**
 * One support thread: the team on the left with their faces, the operator on
 * the right, and messages still on their way marked as such — the same
 * bubbles as every other conversation in the app.
 */
@Composable
fun SupportThreadScreen(
    state: SupportThreadState,
    language: Language,
    onRetryLoad: () -> Unit,
    onRetryMessage: (String) -> Unit,
    modifier: Modifier = Modifier,
    myAvatarUrl: String? = null,
    composer: @Composable () -> Unit = {},
) {
    Column(modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) {
            when (state) {
                SupportThreadState.Loading -> Box(Modifier.fillMaxSize(), Alignment.Center) { LoadingIndicator() }
                is SupportThreadState.Failed -> ErrorState(
                    title = Str.offlineTitle(language),
                    body = state.message,
                    retryLabel = Str.retry(language),
                    onRetry = onRetryLoad,
                )
                is SupportThreadState.Loaded -> if (state.messages.isEmpty() && state.pending.isEmpty()) {
                    EmptyState(icon = InsightGlyph.Chat, title = StrAndroid.supportGreeting(language), body = null)
                } else {
                    SupportTranscript(state, language, myAvatarUrl, onRetryMessage)
                }
            }
        }
        val closed = (state as? SupportThreadState.Loaded)?.closed == true
        if (closed) {
            Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth()) {
                Text(
                    StrAndroid.supportClosed(language),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.navigationBarsPadding().padding(Space.lg),
                )
            }
        } else {
            Box(Modifier.imePadding().navigationBarsPadding()) { composer() }
        }
    }
}

private data class SupportRow(
    val key: String,
    val body: String,
    val outgoing: Boolean,
    val time: Instant?,
    val senderAvatar: String?,
    val pending: PendingSupportMessage?,
    val dayHeader: Instant?,
    val startsRun: Boolean,
    val endsRun: Boolean,
)

private fun supportRows(state: SupportThreadState.Loaded, language: Language): List<SupportRow> {
    data class Item(val key: String, val body: String, val outgoing: Boolean, val time: Instant, val avatar: String?, val pending: PendingSupportMessage?)
    val items = state.messages.mapNotNull { m: SupportMessage ->
        val time = m.createdAt ?: return@mapNotNull null
        val body = m.body.ifBlank { if (m.hasAttachment) StrAndroid.supportFile(language) else "" }
        if (body.isBlank()) return@mapNotNull null
        Item(m.id, body, outgoing = !m.fromTeam, time = time, avatar = m.senderAvatar, pending = null)
    } + state.pending.map { p -> Item("pending-${p.clientMessageId}", p.body, true, p.createdAt, null, p) }
    val zone = ZoneId.systemDefault()
    val sorted = items.sortedBy { it.time }
    return sorted.mapIndexed { index, item ->
        val previous = sorted.getOrNull(index - 1)
        val next = sorted.getOrNull(index + 1)
        val day = item.time.atZone(zone).toLocalDate()
        val sameDayAsPrevious = previous?.time?.atZone(zone)?.toLocalDate() == day
        val sameDayAsNext = next?.time?.atZone(zone)?.toLocalDate() == day
        SupportRow(
            key = item.key,
            body = item.body,
            outgoing = item.outgoing,
            time = item.time,
            senderAvatar = item.avatar,
            pending = item.pending,
            dayHeader = if (sameDayAsPrevious) null else item.time,
            startsRun = previous == null || previous.outgoing != item.outgoing || !sameDayAsPrevious,
            endsRun = next == null || next.outgoing != item.outgoing || !sameDayAsNext,
        )
    }
}

@Composable
private fun SupportTranscript(
    state: SupportThreadState.Loaded,
    language: Language,
    myAvatarUrl: String?,
    onRetryMessage: (String) -> Unit,
) {
    val listState = rememberLazyListState()
    val rows = remember(state, language) { supportRows(state, language) }
    StickToNewest(listState, rows.size)
    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize().testTag(A11y.SUPPORT_TRANSCRIPT),
        contentPadding = PaddingValues(horizontal = Space.md, vertical = Space.lg),
    ) {
        items(rows.size, key = { rows[it].key }) { index ->
            val row = rows[index]
            row.dayHeader?.let { DayHeader(it, language) }
            val pending = row.pending
            MessageBubble(
                id = row.key,
                outgoing = row.outgoing,
                endsRun = row.endsRun,
                startsRun = row.startsRun,
                time = if (pending == null) row.time else null,
                language = language,
                avatar = {
                    OperatorAvatar(imageUrl = if (row.outgoing) myAvatarUrl else row.senderAvatar, size = Size.avatarSmall)
                },
                status = when {
                    pending == null -> null
                    pending.failed -> StrAndroid.supportNotSent(language)
                    else -> Str.messageSending(language)
                },
                statusIsError = pending?.failed == true,
                statusActions = if (pending?.failed == true) {
                    listOf(Str.retry(language) to { onRetryMessage(pending.clientMessageId) })
                } else {
                    emptyList()
                },
            ) {
                Text(row.body, style = MaterialTheme.typography.bodyLarge.bidiContent())
            }
        }
    }
}

/** A new ticket: what it is about, and what happened. */
@Composable
fun SupportTicketScreen(
    subject: String,
    body: String,
    submitting: Boolean,
    error: String?,
    language: Language,
    onSubjectChange: (String) -> Unit,
    onBodyChange: (String) -> Unit,
    onSubmit: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxSize()
            .imePadding()
            .padding(Space.lg),
        verticalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Text(
            StrAndroid.supportOfflineHint(language),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedTextField(
            value = subject,
            onValueChange = onSubjectChange,
            label = { Text(StrAndroid.supportSubject(language)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            textStyle = MaterialTheme.typography.bodyLarge.bidiContent(),
            modifier = Modifier.fillMaxWidth().testTag(A11y.SUPPORT_TICKET_SUBJECT),
        )
        OutlinedTextField(
            value = body,
            onValueChange = onBodyChange,
            label = { Text(StrAndroid.supportMessage(language)) },
            minLines = 6,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            textStyle = MaterialTheme.typography.bodyLarge.bidiContent(),
            modifier = Modifier.fillMaxWidth().weight(1f, fill = false).testTag(A11y.SUPPORT_TICKET_BODY),
        )
        error?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
        }
        Button(
            onClick = onSubmit,
            enabled = subject.isNotBlank() && body.isNotBlank() && !submitting,
            modifier = Modifier.fillMaxWidth().heightIn(min = Size.minTouchTarget).testTag(A11y.SUPPORT_TICKET_SUBMIT),
        ) {
            if (submitting) {
                LoadingIndicator(size = 24.dp)
            } else {
                Icon(Glyph.Ticket, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.size(Space.sm))
                Text(StrAndroid.supportSubmit(language))
            }
        }
    }
}
