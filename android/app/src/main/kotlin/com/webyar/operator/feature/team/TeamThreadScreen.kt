package com.webyar.operator.feature.team

import com.webyar.operator.core.media.AttachmentDiskCache
import com.webyar.operator.core.media.AttachmentSource
import com.webyar.operator.core.media.LoaderAttachmentSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.webyar.operator.core.model.TeamMessage
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.AttachmentView
import com.webyar.operator.ui.components.StickToNewest
import com.webyar.operator.ui.components.DayHeader
import com.webyar.operator.ui.components.ErrorState
import com.webyar.operator.ui.components.MessageBubble
import com.webyar.operator.ui.components.bidiContent
import androidx.compose.foundation.layout.fillMaxWidth
import com.webyar.operator.ui.design.Space
import java.time.Instant
import java.time.ZoneId
import androidx.compose.ui.Alignment
import com.webyar.operator.ui.components.LoadingIndicator
import com.webyar.operator.core.model.MessageAttachment
import com.webyar.operator.ui.components.OperatorAvatar
import com.webyar.operator.ui.design.Size

/**
 * A thread with one colleague.
 *
 * The same transcript as the visitor chat — us on the right, them on the left,
 * in every language — because it is the same [MessageBubble], faces included:
 * each run ends with the photo of whoever wrote it, theirs on their side and
 * ours on ours. What it does not have is the visitor chat's apparatus: no
 * status, no priority, no transfer, no saved replies, no AI. Two people and
 * what they said.
 */
@Composable
fun TeamThreadScreen(
    state: TeamThreadState,
    me: String?,
    language: Language,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
    loadAttachment: (suspend (String) -> ByteArray?)? = null,
    onRetry: () -> Unit = {},
    /** The scoped, on-demand source; wins over [loadAttachment]. */
    attachments: AttachmentSource? = null,
    /** The colleague's photo, beside their messages. */
    peerAvatarUrl: String? = null,
    /** The operator's own, beside theirs. */
    myAvatarUrl: String? = null,
    composer: @Composable () -> Unit = {},
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val source = attachments ?: remember(loadAttachment, context) {
        loadAttachment?.let {
            LoaderAttachmentSource(it, java.io.File(context.cacheDir, "${AttachmentDiskCache.DIRECTORY}/transient"))
        }
    }
    Column(modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) {
            when (state) {
                // The expressive indicator, as the visitor chat has: a
                // thread's shape is not known until it arrives, so there are
                // no rows to sketch in ahead of it.
                is TeamThreadState.Loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    LoadingIndicator()
                }

                is TeamThreadState.Failed -> ErrorState(
                    title = Str.offlineTitle(language),
                    body = state.message,
                    retryLabel = Str.retry(language),
                    onRetry = onRetry,
                )

                is TeamThreadState.Loaded -> Transcript(
                    messages = state.messages,
                    me = me,
                    language = language,
                    contentPadding = contentPadding,
                    source = source,
                    peerAvatarUrl = peerAvatarUrl,
                    myAvatarUrl = myAvatarUrl,
                )
            }
        }
        // imePadding here and NOT on the tab bar: the composer belongs to the
        // text being typed, so it rides up with the keyboard.
        Box(Modifier.imePadding().navigationBarsPadding()) { composer() }
    }
}

@Composable
private fun Transcript(
    messages: List<TeamMessage>,
    me: String?,
    language: Language,
    contentPadding: PaddingValues,
    source: AttachmentSource?,
    peerAvatarUrl: String?,
    myAvatarUrl: String?,
) {
    val listState = rememberLazyListState()
    val rows = remember(messages, me) { layout(messages, me) }

    StickToNewest(listState, rows.size)

    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize().testTag(A11y.TEAM_TRANSCRIPT),
        contentPadding = PaddingValues(horizontal = Space.md, vertical = Space.lg),
    ) {
        items(rows.size, key = { rows[it].message.id }) { index ->
            val row = rows[index]
            row.dayHeader?.let { DayHeader(it, language) }
            MessageBubble(
                id = row.message.id,
                outgoing = row.outgoing,
                endsRun = row.endsRun,
                startsRun = row.startsRun,
                time = row.message.createdAt,
                language = language,
                // A face at the foot of each run, as in the visitor chat —
                // the skeleton circle while a photo loads, never initials.
                avatar = {
                    OperatorAvatar(
                        imageUrl = if (row.outgoing) myAvatarUrl else peerAvatarUrl,
                        size = Size.avatarSmall,
                    )
                },
                bare = row.message.body.isNullOrBlank() &&
                    row.message.attachment?.resolvedKind == MessageAttachment.Kind.IMAGE,
            ) {
                row.message.attachment?.let { AttachmentView(attachment = it, language = language, source = source) }
                row.message.body?.takeIf { it.isNotBlank() }?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodyLarge.bidiContent(),
                    )
                }
            }
        }
    }
}

/**
 * Which rows start and end a run, and where the day changes.
 *
 * Computed once for the whole list rather than during layout, for the reason
 * the visitor transcript states: a `LazyColumn` asks its items for content in
 * an order nobody controls, so a row that looked at its neighbours would be
 * looking at whatever happened to be composed.
 */
private data class ThreadRow(
    val message: TeamMessage,
    val outgoing: Boolean,
    val dayHeader: Instant?,
    val endsRun: Boolean,
    val startsRun: Boolean,
)

private fun layout(messages: List<TeamMessage>, me: String?): List<ThreadRow> {
    val zone = ZoneId.systemDefault()
    // Undated messages are dropped rather than guessed at: there is no day to
    // file one under, and inventing one puts it in the wrong place rather than
    // nowhere. The same rule the visitor transcript follows.
    val dated = messages
        .filter { it.createdAt != null }
        .sortedBy { it.createdAt }

    return dated.mapIndexed { index, message ->
        val previous = dated.getOrNull(index - 1)
        val next = dated.getOrNull(index + 1)
        val outgoing = me != null && message.senderId == me

        val sameDayAsPrevious = previous?.createdAt != null &&
            previous.createdAt!!.atZone(zone).toLocalDate() ==
            message.createdAt!!.atZone(zone).toLocalDate()

        ThreadRow(
            message = message,
            outgoing = outgoing,
            dayHeader = if (sameDayAsPrevious) null else message.createdAt,
            endsRun = next == null || (next.senderId == me) != outgoing,
            startsRun = previous == null ||
                (previous.senderId == me) != outgoing ||
                !sameDayAsPrevious,
        )
    }
}
