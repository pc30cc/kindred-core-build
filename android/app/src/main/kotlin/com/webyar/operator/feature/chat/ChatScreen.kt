package com.webyar.operator.feature.chat

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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import coil3.compose.AsyncImage
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.webyar.operator.core.media.AttachmentDiskCache
import com.webyar.operator.core.media.AttachmentSource
import com.webyar.operator.core.media.LoaderAttachmentSource
import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.Message
import com.webyar.operator.core.model.MessageAttachment
import com.webyar.operator.core.model.SayNowVoice
import com.webyar.operator.core.model.SenderType
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.i18n.StrAndroid
import com.webyar.operator.i18n.SystemMessage
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.Avatar
import com.webyar.operator.ui.components.Glyph
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.components.AttachmentView
import com.webyar.operator.ui.components.StickToNewest
import com.webyar.operator.ui.components.DayHeader
import com.webyar.operator.ui.components.MessageBubble
import com.webyar.operator.ui.components.bidiContent
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme
import java.time.Instant
import java.time.ZoneId
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.rememberCoroutineScope
import com.webyar.operator.ui.components.EmptyState
import com.webyar.operator.ui.components.LoadingIndicator
import com.webyar.operator.ui.design.Motion
import com.webyar.operator.ui.design.WebyarType
import kotlinx.coroutines.launch
import com.webyar.operator.ui.components.avatarKey
import com.webyar.operator.ui.components.sharedElement
import androidx.compose.ui.unit.Dp
import com.webyar.operator.core.model.VisitorProfile
import com.webyar.operator.ui.components.OperatorAvatar

sealed interface ChatState {
    data object Loading : ChatState
    data class Loaded(val messages: List<Message>) : ChatState
    data class Failed(val message: String) : ChatState
}

/**
 * One conversation, and the field to answer it in.
 *
 * Two things here are the Android answers to problems the iOS app records at
 * length, and both are one line rather than the sagas they were there.
 *
 * The transcript follows the keyboard: `imePadding()` is the whole of it,
 * where `PinnedScrollView.swift` needs a frame notification, a settle loop and
 * a safe-area argument because SwiftUI reports the keyboard as a safe area.
 *
 * And a bubble sits on the right side for the operator in every language,
 * because `Arrangement.End` resolves against the layout direction — so a
 * Persian transcript mirrors with no conditional at all, the bubbles' tight
 * corners included; see [com.webyar.operator.ui.components.bubbleShape].
 */
@Composable
fun ChatScreen(
    state: ChatState,
    language: Language,
    onSend: (String) -> Unit,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    conversation: Conversation? = null,
    draft: String = "",
    onDraftChange: (String) -> Unit = {},
    sending: Boolean = false,
    capabilities: ComposerCapabilities = ComposerCapabilities.NONE,
    canUseShortcuts: Boolean = false,
    sayNowVoice: SayNowVoice? = null,
    onSayNowVoiceChange: (SayNowVoice) -> Unit = {},
    onAttachPhoto: () -> Unit = {},
    onAttachFile: () -> Unit = {},
    onOpenShortcuts: () -> Unit = {},
    onStartRecording: () -> Unit = {},
    recordingSeconds: Int? = null,
    onDiscardRecording: () -> Unit = {},
    onFinishRecording: () -> Unit = {},
    /** A finished recording waiting in the composer to be heard and sent. */
    recorded: RecordedVoice? = null,
    onSendRecorded: () -> Unit = {},
    onDiscardRecorded: () -> Unit = {},
    header: (@Composable () -> Unit)? = null,
    /**
     * Fetches an attachment's bytes.
     *
     * A loader rather than a URL because the endpoint is authenticated: a
     * plain `https://…/file` handed to an image library is a request with no
     * Authorization header, which comes back 401 and renders as a broken
     * picture. Passing the function also keeps this screen testable without a
     * network.
     */
    loadAttachment: (suspend (String) -> ByteArray?)? = null,
    /**
     * The real attachment source — memory, the scoped disk cache, then the
     * network, on demand. Wins over [loadAttachment] when both are given.
     */
    attachments: AttachmentSource? = null,
    /** Sends an unsent message again, with the key it was minted with. */
    onRetry: (Message) -> Unit = {},
    /** Takes an unsent message out of the thread. */
    onDiscard: (Message) -> Unit = {},
    /**
     * What is known about the visitor's device and where they are — the same
     * facts the inbox row draws its face from, so the face in the bar and
     * beside the visitor's messages is the one the operator just tapped.
     */
    visitor: VisitorProfile? = null,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val source = attachments ?: remember(loadAttachment, context) {
        loadAttachment?.let {
            LoaderAttachmentSource(it, java.io.File(context.cacheDir, "${AttachmentDiskCache.DIRECTORY}/transient"))
        }
    }
    Column(modifier.fillMaxSize().imePadding()) {
        if (onBack != null) {
            ChatTopBar(
                language = language,
                title = conversation?.let {
                    Format.contactName(
                        name = it.contact?.name,
                        email = it.contact?.email,
                        visitorCode = it.contact?.visitorCode,
                        language = language,
                    )
                },
                avatarUrl = conversation?.contact?.avatarUrl,
                visitor = visitor,
                sharedKey = conversation?.id?.let(::avatarKey),
                onBack = onBack,
                actions = header,
            )
        }

        Box(Modifier.weight(1f)) {
            when (state) {
                is ChatState.Loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    LoadingIndicator()
                }

                is ChatState.Failed -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    EmptyState(
                        icon = Icons.Outlined.Info,
                        title = state.message,
                        body = null,
                    )
                }

                is ChatState.Loaded -> if (state.messages.isEmpty()) {
                    Box(Modifier.fillMaxSize(), Alignment.Center) {
                        EmptyState(
                            icon = Icons.Outlined.Email,
                            title = Str.chatEmpty(language),
                            body = null,
                        )
                    }
                } else {
                    Transcript(
                        messages = state.messages,
                        language = language,
                        source = source,
                        onRetry = onRetry,
                        onDiscard = onDiscard,
                        visitorFace = { size ->
                            VisitorFace(conversation, visitor, language, size)
                        },
                    )
                }
            }
        }

        Composer(
            language = language,
            draft = draft,
            onDraftChange = onDraftChange,
            capabilities = capabilities,
            sending = sending,
            onSend = { onSend(draft) },
            onAttachPhoto = onAttachPhoto,
            onAttachFile = onAttachFile,
            onOpenShortcuts = onOpenShortcuts,
            onStartRecording = onStartRecording,
            sayNowVoice = sayNowVoice,
            onSayNowVoiceChange = onSayNowVoiceChange,
            canUseShortcuts = canUseShortcuts,
            recordingSeconds = recordingSeconds,
            onDiscardRecording = onDiscardRecording,
            onFinishRecording = onFinishRecording,
            recorded = recorded,
            onSendRecorded = onSendRecorded,
            onDiscardRecorded = onDiscardRecorded,
            modifier = Modifier.navigationBarsPadding(),
        )
    }
}

/**
 * One row of the transcript, already decided.
 *
 * Grouping is worked out once, when the list changes, rather than per row
 * during layout: a `LazyColumn` asks its items for content in an order nobody
 * controls, so a row that needed to look at its neighbours would be looking at
 * whatever happened to be composed.
 */
private data class TranscriptRow(
    val message: Message,
    /** A date header goes above this row. */
    val dayHeader: Instant?,
    /** The last of a run from one sender — the one that gets the beak and the face. */
    val endsRun: Boolean,
    /** The first of a run — the one that gets the gap above it. */
    val startsRun: Boolean,
)

private fun layout(messages: List<Message>): List<TranscriptRow> {
    val zone = ZoneId.systemDefault()
    return messages.mapIndexed { index, message ->
        val previous = messages.getOrNull(index - 1)
        val next = messages.getOrNull(index + 1)

        val sameDayAsPrevious = previous?.createdAt != null && message.createdAt != null &&
            previous.createdAt!!.atZone(zone).toLocalDate() ==
            message.createdAt!!.atZone(zone).toLocalDate()

        TranscriptRow(
            message = message,
            dayHeader = if (sameDayAsPrevious) null else message.createdAt,
            // A day header between two messages ends the run above it too:
            // the face belongs at the foot of each day's run, not only the
            // last one.
            endsRun = next == null || next.senderType != message.senderType ||
                next.senderType == SenderType.SYSTEM ||
                (next.createdAt != null && message.createdAt != null &&
                    next.createdAt!!.atZone(zone).toLocalDate() != message.createdAt!!.atZone(zone).toLocalDate()),
            startsRun = previous == null || previous.senderType != message.senderType || !sameDayAsPrevious,
        )
    }
}

@Composable
private fun Transcript(
    messages: List<Message>,
    language: Language,
    source: AttachmentSource?,
    onRetry: (Message) -> Unit,
    onDiscard: (Message) -> Unit,
    visitorFace: @Composable (Dp) -> Unit,
) {
    val listState = rememberLazyListState()
    val rows = remember(messages) { layout(messages) }

    // A transcript opens on its newest message, not its oldest, and stays
    // there while that message settles — see [StickToNewest].
    StickToNewest(listState, rows.size)

    Box(Modifier.fillMaxSize()) {
    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize().testTag(A11y.CHAT_TRANSCRIPT),
        contentPadding = PaddingValues(horizontal = Space.md, vertical = Space.lg),
    ) {
        // The local id, not the server's: a message sent from here keeps its
        // key when the server confirms it, so the bubble is not recreated
        // (and does not flicker) the moment it gets its real id.
        items(rows.size, key = { rows[it].message.stableKey }) { index ->
            val row = rows[index]
            row.dayHeader?.let { DayHeader(it, language) }
            if (row.message.senderType == SenderType.SYSTEM) {
                SystemRow(row.message, language)
            } else {
                val message = row.message
                MessageBubble(
                    id = message.id,
                    outgoing = message.senderType.isOutgoing,
                    endsRun = row.endsRun,
                    startsRun = row.startsRun,
                    time = message.createdAt,
                    language = language,
                    // The visitor's face on their side, the sender's own on
                    // ours: an operator's photo, or the quiet circle while it
                    // loads or when there is none — never initials.
                    avatar = if (message.senderType.isOutgoing) {
                        { OperatorAvatar(imageUrl = message.senderAvatar, size = Size.avatarSmall) }
                    } else {
                        { visitorFace(Size.avatarSmall) }
                    },
                    // A photo on its own is its own shape; a coloured frame
                    // around it adds nothing but a border.
                    bare = message.isAttachmentOnly &&
                        message.attachments.orEmpty().all { it.resolvedKind == MessageAttachment.Kind.IMAGE },
                    status = when (message.delivery) {
                        Message.Delivery.SENT -> null
                        Message.Delivery.PENDING -> StrAndroid.messageSending(language)
                        Message.Delivery.FAILED -> StrAndroid.messageNotSent(language)
                    },
                    statusIsError = message.delivery == Message.Delivery.FAILED,
                    statusActions = if (message.delivery == Message.Delivery.FAILED) {
                        listOf(
                            Str.retry(language) to { onRetry(message) },
                            StrAndroid.discardMessage(language) to { onDiscard(message) },
                        )
                    } else {
                        emptyList()
                    },
                ) {
                    message.attachments?.forEach {
                        AttachmentView(attachment = it, language = language, source = source)
                    }
                    if (message.body.isNotBlank()) {
                        Text(
                            message.body,
                            // A visitor writes in whatever language they
                            // like, inside a transcript laid out in the
                            // operator's. Without this, a Turkish sentence
                            // in a Persian transcript had its full stop
                            // moved to the front — the same fault the inbox
                            // rows had.
                            // No fillMaxWidth: a bubble hugs its text, and
                            // stretching the Text would stretch every bubble
                            // to the 300dp cap.
                            style = MaterialTheme.typography.bodyLarge.bidiContent(),
                        )
                    }
                }
            }
        }
    }

    JumpToLatest(
        visible = listState.canScrollForward,
        language = language,
        onClick = { listState.animateScrollToItem(rows.lastIndex.coerceAtLeast(0)) },
        modifier = Modifier.align(Alignment.BottomEnd).padding(Space.lg),
    )
    }
}

/**
 * Back to the newest message, when the operator has scrolled up to read.
 *
 * Only while there is something below: at the bottom of the thread the
 * button would be a way of going where you already are.
 */
@Composable
private fun JumpToLatest(
    visible: Boolean,
    language: Language,
    onClick: suspend () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    AnimatedVisibility(
        visible = visible,
        enter = scaleIn(Motion.fastSpatial()) + fadeIn(Motion.effects()),
        exit = scaleOut(Motion.fastSpatial()) + fadeOut(Motion.fastEffects()),
        modifier = modifier,
    ) {
        SmallFloatingActionButton(
            onClick = { scope.launch { onClick() } },
            containerColor = MaterialTheme.colorScheme.secondaryContainer,
            contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
        ) {
            Icon(Icons.Filled.KeyboardArrowDown, contentDescription = StrAndroid.jumpToLatest(language))
        }
    }
}

@Composable
private fun SystemRow(message: Message, language: Language) {
    val text = SystemMessage.text(message.metadata, language) ?: message.body
    if (text.isBlank()) return
    Box(
        Modifier
            .fillMaxWidth()
            .padding(vertical = Space.sm)
            .testTag(A11y.messageRow(message.id)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            style = MaterialTheme.typography.bodySmall,
            color = WebyarTheme.colors.labelTertiary,
            textAlign = TextAlign.Center,
        )
    }
}

/**
 * The conversation's header: back, the visitor's face and name, and the
 * conversation's own menu. The face is the same one the inbox row showed, so
 * the eye keeps hold of who this is while the screen changes under it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatTopBar(
    language: Language,
    title: String?,
    avatarUrl: String?,
    onBack: () -> Unit,
    actions: (@Composable () -> Unit)?,
    visitor: VisitorProfile? = null,
    sharedKey: String? = null,
) {
    TopAppBar(
        title = {
            if (title != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    // The face from the inbox row, carried up into the bar.
                    Avatar(
                        name = title,
                        imageUrl = avatarUrl,
                        size = 40.dp,
                        os = visitor?.device?.os,
                        device = visitor?.device?.device,
                        countryCode = visitor?.geo?.countryCode,
                        modifier = if (sharedKey != null) Modifier.sharedElement(sharedKey) else Modifier,
                    )
                    Text(
                        title,
                        style = WebyarType.titleMediumEmphasized.bidiContent(),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(start = Space.md),
                    )
                }
            }
        },
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(
                    // AutoMirrored: a back arrow points the way you came, and
                    // in Persian that is the other way.
                    Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = StrAndroid.back(language),
                )
            }
        },
        actions = { actions?.invoke() },
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = MaterialTheme.colorScheme.surface,
            scrolledContainerColor = MaterialTheme.colorScheme.surfaceContainer,
        ),
    )
}

/** The visitor's face — the inbox row's, at any size. */
@Composable
private fun VisitorFace(conversation: Conversation?, visitor: VisitorProfile?, language: Language, size: Dp) {
    Avatar(
        name = conversation?.contact?.let {
            Format.contactName(name = it.name, email = it.email, visitorCode = it.visitorCode, language = language)
        }.orEmpty(),
        imageUrl = conversation?.contact?.avatarUrl,
        size = size,
        os = visitor?.device?.os,
        device = visitor?.device?.device,
        countryCode = visitor?.geo?.countryCode,
    )
}
