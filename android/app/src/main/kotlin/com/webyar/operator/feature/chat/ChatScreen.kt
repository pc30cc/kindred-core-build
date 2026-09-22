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
import com.webyar.operator.ui.components.ChatBubbleShape
import com.webyar.operator.ui.components.Glyph
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.components.AttachmentView
import com.webyar.operator.ui.components.DayHeader
import com.webyar.operator.ui.components.MessageBubble
import com.webyar.operator.ui.components.bidiContent
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme
import java.time.Instant
import java.time.ZoneId

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
 * Persian transcript mirrors with no conditional at all. The BEAK is the
 * exception and has to be told which way to point; see [ChatBubbleShape].
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
) {
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
                onBack = onBack,
                actions = header,
            )
        }

        Box(Modifier.weight(1f)) {
            when (state) {
                is ChatState.Loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    CircularProgressIndicator()
                }

                is ChatState.Failed -> Box(
                    Modifier.fillMaxSize().padding(Space.xl),
                    Alignment.Center,
                ) {
                    Text(state.message, style = MaterialTheme.typography.bodyMedium)
                }

                is ChatState.Loaded -> if (state.messages.isEmpty()) {
                    Box(Modifier.fillMaxSize().padding(Space.xl), Alignment.Center) {
                        Text(Str.chatEmpty(language), style = MaterialTheme.typography.bodyMedium)
                    }
                } else {
                    Transcript(state.messages, language, loadAttachment)
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
            endsRun = next == null || next.senderType != message.senderType ||
                next.senderType == SenderType.SYSTEM,
            startsRun = previous == null || previous.senderType != message.senderType || !sameDayAsPrevious,
        )
    }
}

@Composable
private fun Transcript(
    messages: List<Message>,
    language: Language,
    loadAttachment: (suspend (String) -> ByteArray?)?,
) {
    val listState = rememberLazyListState()
    val rows = remember(messages) { layout(messages) }

    // A transcript opens on its newest message, not its oldest. Re-run when
    // one arrives so a sent message is visible rather than just appended.
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.lastIndex)
    }

    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize().testTag(A11y.CHAT_TRANSCRIPT),
        contentPadding = PaddingValues(Space.lg),
    ) {
        items(rows.size, key = { rows[it].message.id }) { index ->
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
                    senderName = message.senderName.orEmpty(),
                    senderAvatarUrl = message.senderAvatar,
                ) {
                    message.attachments?.forEach {
                        AttachmentView(it, language, loadAttachment)
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatTopBar(
    language: Language,
    title: String?,
    onBack: () -> Unit,
    actions: (@Composable () -> Unit)?,
) {
    TopAppBar(
        title = {
            if (title != null) {
                Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        },
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(
                    // AutoMirrored: a back arrow points the way you came, and
                    // in Persian that is the other way. This is the one family
                    // of icons that MUST mirror, as against the bubble beak,
                    // which must not.
                    Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = StrAndroid.back(language),
                )
            }
        },
        actions = { actions?.invoke() },
    )
}
