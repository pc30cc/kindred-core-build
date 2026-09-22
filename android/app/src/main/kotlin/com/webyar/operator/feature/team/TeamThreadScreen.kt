package com.webyar.operator.feature.team

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
import com.webyar.operator.ui.components.SkeletonList
import com.webyar.operator.ui.components.bidiContent
import androidx.compose.foundation.layout.fillMaxWidth
import com.webyar.operator.ui.design.Space
import java.time.Instant
import java.time.ZoneId

/**
 * A thread with one colleague.
 *
 * The same transcript as the visitor chat — us on the right, them on the left,
 * in every language — because it is the same [MessageBubble]. What it does not
 * have is the visitor chat's apparatus: no status, no priority, no transfer,
 * no saved replies, no AI. Two people and what they said.
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
    composer: @Composable () -> Unit = {},
) {
    Column(modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) {
            when (state) {
                is TeamThreadState.Loading -> SkeletonList(
                    Modifier.fillMaxSize(),
                    rows = 6,
                    lines = 1,
                )

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
                    loadAttachment = loadAttachment,
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
    loadAttachment: (suspend (String) -> ByteArray?)?,
) {
    val listState = rememberLazyListState()
    val rows = remember(messages, me) { layout(messages, me) }

    StickToNewest(listState, rows.size)

    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize().testTag(A11y.TEAM_TRANSCRIPT),
        contentPadding = PaddingValues(Space.lg),
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
                // No face: every incoming message in a two-party thread is
                // the same person, and a column of identical avatars beside
                // their own name in the title bar says nothing twice.
                senderName = null,
            ) {
                row.message.attachment?.let { AttachmentView(it, language, loadAttachment) }
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
