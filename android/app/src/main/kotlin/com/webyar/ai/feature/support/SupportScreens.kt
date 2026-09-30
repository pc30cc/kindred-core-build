package com.webyar.ai.feature.support

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.webyar.ai.core.media.AttachmentDiskCache
import com.webyar.ai.core.media.LoaderAttachmentSource
import com.webyar.ai.core.model.MessageAttachment
import com.webyar.ai.core.model.SupportConversation
import com.webyar.ai.core.model.SupportStatus
import com.webyar.ai.i18n.Format
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.Str
import com.webyar.ai.i18n.StrAndroid
import com.webyar.ai.ui.A11y
import com.webyar.ai.ui.components.AttachmentView
import com.webyar.ai.ui.components.DayHeader
import com.webyar.ai.ui.components.EmptyState
import com.webyar.ai.ui.components.ErrorState
import com.webyar.ai.ui.components.Glyph
import com.webyar.ai.ui.components.InsightGlyph
import com.webyar.ai.ui.components.LoadingIndicator
import com.webyar.ai.ui.components.MessageBubble
import com.webyar.ai.ui.components.OperatorAvatar
import com.webyar.ai.ui.components.PrimaryButton
import com.webyar.ai.ui.components.StickToNewest
import com.webyar.ai.ui.components.bidiContent
import com.webyar.ai.ui.design.Radius
import com.webyar.ai.ui.design.Size
import com.webyar.ai.ui.design.Space
import com.webyar.ai.ui.design.WebyarTheme

/** Green for a team that is there now, as a presence dot is everywhere. */
private val OnlineGreen = Color(0xFF1E9E5A)

/** The stars of a rating, in the colour stars are. */
private val StarGold = Color(0xFFF2A900)

/** "Online", or "Offline · Leave a message": who is there, in a word. */
internal fun presenceText(online: Boolean, language: Language): String =
    if (online) StrAndroid.supportOnline(language) else StrAndroid.supportOfflineLeaveMessage(language)

/** A dot and a word: green while the team is there, quiet while it is not. */
@Composable
internal fun PresenceLine(online: Boolean, language: Language, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier
                .size(8.dp)
                .background(if (online) OnlineGreen else MaterialTheme.colorScheme.outline, CircleShape),
        )
        Text(
            presenceText(online, language),
            style = MaterialTheme.typography.labelLarge,
            color = if (online) OnlineGreen else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = Space.xs),
        )
    }
}

/** The team's mark with its presence on it, for the chat's bar. */
@Composable
internal fun SupportTeamMark(online: Boolean?, modifier: Modifier = Modifier) {
    Box(modifier.size(40.dp)) {
        Box(
            Modifier.fillMaxSize().background(MaterialTheme.colorScheme.secondaryContainer, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Glyph.Headset,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSecondaryContainer,
                modifier = Modifier.size(22.dp),
            )
        }
        if (online != null) {
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .size(12.dp)
                    .background(MaterialTheme.colorScheme.surface, CircleShape)
                    .padding(2.dp)
                    .background(if (online) OnlineGreen else MaterialTheme.colorScheme.outline, CircleShape),
            )
        }
    }
}

/**
 * The support chat: every conversation the operator has had with the team,
 * oldest first, each ended one closed by a line and its rating — the same
 * bubbles as every other conversation in the app. The team on the left with
 * their faces, the operator on the right.
 *
 * At the bottom, the composer while a conversation is open. Once it has
 * ended, nothing more is written to it: the composer gives way to the end
 * and a button that starts a new conversation ([onStartNew]).
 *
 * While nobody is online a banner says so, with the team's hours; a message
 * is delivered all the same.
 */
@Composable
fun SupportChatScreen(
    state: SupportChatState,
    status: SupportStatus?,
    language: Language,
    onRetryLoad: () -> Unit,
    onRetryMessage: (String) -> Unit,
    onRate: (conversationId: String, score: Int, comment: String?) -> Unit,
    onStartNew: () -> Unit,
    modifier: Modifier = Modifier,
    /** Conversations whose rating is on its way. */
    ratingBusy: Set<String> = emptySet(),
    /** A support file's bytes; null draws files as cards that do not open. */
    loadAttachment: (suspend (String) -> ByteArray?)? = null,
    myAvatarUrl: String? = null,
    composer: @Composable () -> Unit = {},
) {
    Column(modifier.fillMaxSize()) {
        if (status != null && status.shown && !status.online) {
            OfflineBanner(status, language)
        }
        Box(Modifier.weight(1f)) {
            when (state) {
                SupportChatState.Loading -> Box(Modifier.fillMaxSize(), Alignment.Center) { LoadingIndicator() }
                is SupportChatState.Failed -> ErrorState(
                    title = Str.offlineTitle(language),
                    body = state.message,
                    retryLabel = Str.retry(language),
                    onRetry = onRetryLoad,
                )
                is SupportChatState.Loaded -> if (state.isEmpty) {
                    EmptyState(icon = InsightGlyph.Chat, title = StrAndroid.supportGreeting(language), body = null)
                } else {
                    SupportTranscript(state, language, ratingBusy, loadAttachment, myAvatarUrl, onRetryMessage, onRate)
                }
            }
        }
        val loaded = state as? SupportChatState.Loaded
        when (loaded?.composer) {
            // Nothing to write to before the chat has loaded.
            null -> Unit
            SupportComposer.Ended -> EndedPanel(loaded.lastConversation, language, onStartNew)
            else -> {
                if (loaded.composer == SupportComposer.New) {
                    Text(
                        StrAndroid.supportNewConversationHint(language),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = Space.lg, vertical = Space.xs)
                            .testTag(A11y.SUPPORT_NEW_CONVERSATION_HINT),
                    )
                }
                // imePadding here: the composer belongs to the text being
                // typed, so it rides up with the keyboard.
                Box(Modifier.imePadding().navigationBarsPadding().testTag(A11y.SUPPORT_COMPOSER)) { composer() }
            }
        }
    }
}

/**
 * Where the composer was, once the conversation has ended: how it ended,
 * that it cannot be continued, and the one way on — a new conversation.
 */
@Composable
private fun EndedPanel(conversation: SupportConversation?, language: Language, onStartNew: () -> Unit) {
    val status = conversation?.status?.takeIf { it == SupportConversation.STATUS_CLOSED } ?: SupportConversation.STATUS_RESOLVED
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl),
        modifier = Modifier.fillMaxWidth().testTag(A11y.SUPPORT_ENDED_PANEL),
    ) {
        Column(
            Modifier
                .navigationBarsPadding()
                .padding(horizontal = Space.lg, vertical = Space.lg),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Filled.CheckCircle,
                    contentDescription = null,
                    tint = OnlineGreen,
                    modifier = Modifier.size(20.dp),
                )
                Text(
                    StrAndroid.supportEnded(language, status),
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.padding(horizontal = Space.sm).semantics { heading() },
                )
            }
            Text(
                StrAndroid.supportEndedPanelBody(language),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            PrimaryButton(
                label = StrAndroid.supportStartNew(language),
                onClick = onStartNew,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = Space.xs)
                    .testTag(A11y.SUPPORT_START_NEW),
            )
        }
    }
}

/**
 * Nobody is online: leave a message. Under it, when the team keeps hours,
 * when it opens next and its week — which folds away, since a keyboard and
 * seven lines of hours do not share a phone screen well.
 */
@Composable
private fun OfflineBanner(status: SupportStatus, language: Language) {
    val lines = remember(status.hours, language) { status.hours?.let { SupportHoursText.lines(it, language) }.orEmpty() }
    val zone = status.hours?.timezone?.takeIf { SupportHoursText.zoneDiffers(it) }
    var expanded by rememberSaveable { mutableStateOf(true) }
    Surface(
        color = MaterialTheme.colorScheme.secondaryContainer,
        contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
        shape = RoundedCornerShape(Radius.lg),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.md, vertical = Space.sm)
            .testTag(A11y.SUPPORT_OFFLINE_BANNER),
    ) {
        Column(Modifier.padding(Space.md), verticalArrangement = Arrangement.spacedBy(Space.xs)) {
            Text(StrAndroid.supportOfflineBanner(language), style = MaterialTheme.typography.bodyMedium)
            status.nextOpenAt?.let { at ->
                Text(
                    StrAndroid.supportNextOpen(language, Format.comingDay(at, language), Format.bubbleTime(at, language)),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            if (lines.isNotEmpty()) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { expanded = !expanded }
                        .padding(top = Space.xs),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        StrAndroid.supportHoursTitle(language),
                        style = MaterialTheme.typography.labelLarge,
                        modifier = Modifier.weight(1f).semantics { heading() },
                    )
                    Icon(
                        if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                        contentDescription = null,
                        modifier = Modifier.size(20.dp),
                    )
                }
                if (expanded) {
                    lines.forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
                    zone?.let {
                        Text(
                            StrAndroid.supportTimeZone(language, Format.zoneName(it, language)),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSecondaryContainer.copy(alpha = 0.75f),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SupportTranscript(
    state: SupportChatState.Loaded,
    language: Language,
    ratingBusy: Set<String>,
    loadAttachment: (suspend (String) -> ByteArray?)?,
    myAvatarUrl: String?,
    onRetryMessage: (String) -> Unit,
    onRate: (String, Int, String?) -> Unit,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val source = remember(loadAttachment, context) {
        loadAttachment?.let {
            LoaderAttachmentSource(it, java.io.File(context.cacheDir, "${AttachmentDiskCache.DIRECTORY}/transient"))
        }
    }
    val startingNew = state.composer == SupportComposer.New
    val rows = remember(state.conversations, state.items, state.pending, startingNew) {
        supportTimeline(state.conversations, state.items, state.pending, startingNew = startingNew)
    }
    val listState = rememberLazyListState()
    // A transcript opens on its newest message and stays there while that
    // message settles — see [StickToNewest].
    StickToNewest(listState, rows.size)

    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize().testTag(A11y.SUPPORT_TRANSCRIPT),
        contentPadding = PaddingValues(horizontal = Space.md, vertical = Space.lg),
    ) {
        items(rows.size, key = { rows[it].key }) { index ->
            when (val row = rows[index]) {
                is SupportRow.NewConversation -> NewConversationLine(row, language)
                is SupportRow.Joined -> {
                    row.dayHeader?.let { DayHeader(it, language) }
                    CenteredPill(StrAndroid.supportJoined(language, row.name))
                }
                is SupportRow.Bubble -> {
                    row.dayHeader?.let { DayHeader(it, language) }
                    SupportBubble(row, language, source, myAvatarUrl, onRetryMessage)
                }
                is SupportRow.Ended -> EndedLine(row.conversation, language)
                is SupportRow.Rating -> RatingCard(
                    conversation = row.conversation,
                    busy = row.conversation.id in ratingBusy,
                    language = language,
                    onRate = { score, comment -> onRate(row.conversation.id, score, comment) },
                )
            }
        }
    }
}

@Composable
private fun SupportBubble(
    row: SupportRow.Bubble,
    language: Language,
    source: com.webyar.ai.core.media.AttachmentSource?,
    myAvatarUrl: String?,
    onRetryMessage: (String) -> Unit,
) {
    val item = row.item
    val pending = row.pending
    val attachments: List<MessageAttachment> = item?.attachments?.map { it.toMessageAttachment() }
        ?: listOfNotNull(pending?.file?.asAttachment(pending.clientMessageId))
    val body = item?.body ?: pending?.body.orEmpty()
    // The agent's name over the first of their run: two people answering in
    // turn are told apart by more than their faces.
    val name = item?.senderName?.takeIf { !row.mine && row.startsRun && it.isNotBlank() }
    MessageBubble(
        id = row.key,
        outgoing = row.mine,
        endsRun = row.endsRun,
        startsRun = row.startsRun,
        time = if (pending == null) row.time else null,
        language = language,
        avatar = { OperatorAvatar(imageUrl = if (row.mine) myAvatarUrl else item?.senderAvatar, size = Size.avatarSmall) },
        // A photo on its own is its own shape, as in the other transcripts.
        bare = body.isBlank() && name == null && attachments.isNotEmpty() && pending == null &&
            attachments.all { it.resolvedKind == MessageAttachment.Kind.IMAGE },
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
        name?.let {
            Text(
                it,
                style = MaterialTheme.typography.labelMedium.bidiContent(),
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(bottom = Space.xxs),
            )
        }
        attachments.forEach { attachment ->
            // A file still on its way is only a name: nothing to fetch yet.
            AttachmentView(attachment = attachment, language = language, source = if (pending == null) source else null)
        }
        if (body.isNotBlank()) {
            Text(body, style = MaterialTheme.typography.bodyLarge.bidiContent())
        }
    }
}

/** «گفتگوی تازه · ‹date›», between one conversation and the next. */
@Composable
private fun NewConversationLine(row: SupportRow.NewConversation, language: Language) {
    val date = row.startedAt?.let { Format.dayHeader(it, language) }
    Row(
        Modifier.fillMaxWidth().padding(vertical = Space.lg),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
        Text(
            StrAndroid.supportNewConversation(language, date),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.padding(horizontal = Space.md),
        )
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
    }
}

/** A line in the middle of the transcript, in a quiet pill. */
@Composable
private fun CenteredPill(text: String) {
    Box(Modifier.fillMaxWidth().padding(vertical = Space.sm), contentAlignment = Alignment.Center) {
        Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = RoundedCornerShape(Radius.pill)) {
            Text(
                text,
                style = MaterialTheme.typography.labelMedium.bidiContent(),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(horizontal = Space.md, vertical = Space.xs),
            )
        }
    }
}

/** «این گفتگو حل شد · ‹date›», under a conversation that ended. */
@Composable
private fun EndedLine(conversation: SupportConversation, language: Language) {
    val sentence = StrAndroid.supportEnded(language, conversation.status)
    val text = conversation.endedAt?.let { "$sentence · ${Format.dayHeader(it, language)}" } ?: sentence
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = WebyarTheme.colors.labelTertiary,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(top = Space.lg, bottom = Space.sm),
    )
}

/**
 * Stars for an ended conversation the team answered: five to tap, a comment
 * if the operator has one, and a button. Once rated, what they gave.
 */
@Composable
private fun RatingCard(
    conversation: SupportConversation,
    busy: Boolean,
    language: Language,
    onRate: (Int, String?) -> Unit,
) {
    val given = conversation.rating
    Surface(
        shape = RoundedCornerShape(Radius.xl),
        color = MaterialTheme.colorScheme.surfaceContainer,
        modifier = Modifier.fillMaxWidth().padding(vertical = Space.sm),
    ) {
        Column(
            Modifier.padding(Space.lg),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            if (given != null) {
                Text(StrAndroid.supportYourRating(language), style = MaterialTheme.typography.titleSmall)
                Stars(conversation.id, given.score, language, onPick = null)
                given.comment?.takeIf { it.isNotBlank() }?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodyMedium.bidiContent(),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                }
            } else {
                var score by rememberSaveable(conversation.id) { mutableIntStateOf(0) }
                var comment by rememberSaveable(conversation.id) { mutableStateOf("") }
                Text(StrAndroid.supportRateTitle(language), style = MaterialTheme.typography.titleSmall)
                Stars(conversation.id, score, language, onPick = { score = it })
                OutlinedTextField(
                    value = comment,
                    onValueChange = { comment = it.take(SupportChatViewModel.MAX_COMMENT) },
                    label = { Text(StrAndroid.supportRateComment(language)) },
                    minLines = 2,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    textStyle = MaterialTheme.typography.bodyMedium.bidiContent(),
                    modifier = Modifier.fillMaxWidth().testTag(A11y.supportRatingComment(conversation.id)),
                )
                PrimaryButton(
                    label = StrAndroid.supportRateSubmit(language),
                    onClick = { onRate(score, comment) },
                    enabled = score > 0,
                    busy = busy,
                    modifier = Modifier.testTag(A11y.supportRatingSubmit(conversation.id)),
                )
            }
        }
    }
}

/**
 * Five stars. With [onPick] each is a button of its own, named by its count;
 * without, they are the rating as given, read out once as a whole.
 */
@Composable
private fun Stars(conversationId: String, score: Int, language: Language, onPick: ((Int) -> Unit)?) {
    Row(
        horizontalArrangement = Arrangement.Center,
        modifier = if (onPick == null) {
            Modifier.clearAndSetSemantics { contentDescription = StrAndroid.supportStars(language, score) }
        } else {
            Modifier
        },
    ) {
        for (star in 1..5) {
            val filled = star <= score
            if (onPick != null) {
                IconButton(
                    onClick = { onPick(star) },
                    modifier = Modifier.size(Size.minTouchTarget).testTag(A11y.supportRatingStar(conversationId, star)),
                ) {
                    Icon(
                        if (filled) Icons.Filled.Star else Glyph.StarOutline,
                        contentDescription = StrAndroid.supportStars(language, star),
                        tint = if (filled) StarGold else MaterialTheme.colorScheme.outline,
                        modifier = Modifier.size(32.dp),
                    )
                }
            } else {
                Icon(
                    if (filled) Icons.Filled.Star else Glyph.StarOutline,
                    contentDescription = null,
                    tint = if (filled) StarGold else MaterialTheme.colorScheme.outline,
                    modifier = Modifier.size(22.dp),
                )
            }
        }
    }
}
