package com.webyar.operator.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.clickable
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import coil3.compose.AsyncImage
import com.webyar.operator.core.model.MessageAttachment
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme
import java.time.Instant

/**
 * One bubble in a transcript, whoever the transcript is with.
 *
 * Lives here rather than in the chat feature because there are two
 * transcripts — a visitor's and a colleague's — and they have to look
 * identical. Two copies of this would have drifted by the second change to
 * either: the beak, the run grouping, the width cap and the time underneath
 * are all things somebody would fix on one screen and not the other.
 *
 * What is NOT here is anything that knows what a message is. The two feeds
 * carry different types with different notions of "who sent this", so the
 * caller resolves that and hands over the answer.
 */
@Composable
fun MessageBubble(
    id: String,
    outgoing: Boolean,
    /** Last of a run from one sender: the one that gets the beak and the face. */
    endsRun: Boolean,
    /** First of a run: the one that gets the gap above it. */
    startsRun: Boolean,
    time: Instant?,
    language: Language,
    modifier: Modifier = Modifier,
    /**
     * The sender's name, for the face beside an incoming run.
     *
     * Null leaves out the avatar column entirely, which is right for a
     * two-party thread where every incoming message is the same person and a
     * column of identical faces would be noise.
     */
    senderName: String? = null,
    senderAvatarUrl: String? = null,
    /**
     * Where an unsent message stands — "Sending…", "Not sent" — shown under
     * the bubble in place of the time, which it does not have yet.
     */
    status: String? = null,
    /** Marks [status] as a problem, in the error colour. */
    statusIsError: Boolean = false,
    /** What a tap on [status] offers: Retry, Delete. Empty makes it plain text. */
    statusActions: List<Pair<String, () -> Unit>> = emptyList(),
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = WebyarTheme.colors
    var actionsOpen by remember(id) { mutableStateOf(false) }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = if (startsRun) Space.md else Space.xxs)
            .testTag(A11y.messageRow(id)),
        // Start and End resolve against the layout direction, so a Persian
        // transcript mirrors with no conditional here.
        horizontalArrangement = if (outgoing) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Bottom,
    ) {
        if (!outgoing && senderName != null) {
            // Only the last of a run carries a face, and the rest reserve its
            // width — so a run reads as one block rather than as a column of
            // avatars.
            Box(Modifier.size(Size.avatarSmall)) {
                if (endsRun) {
                    Avatar(
                        name = senderName,
                        imageUrl = senderAvatarUrl,
                        size = Size.avatarSmall,
                    )
                }
            }
        }

        Column(
            Modifier
                .padding(horizontal = Space.sm)
                .widthIn(max = BUBBLE_MAX_WIDTH),
            horizontalAlignment = if (outgoing) Alignment.End else Alignment.Start,
        ) {
            Surface(
                color = if (outgoing) colors.bubbleOutgoing else colors.bubbleIncoming,
                contentColor = if (outgoing) colors.onBubbleOutgoing else colors.onBubbleIncoming,
                shape = bubbleShape(outgoing = outgoing, startsRun = startsRun),
            ) {
                Column(
                    Modifier.padding(horizontal = Space.lg - 2.dp, vertical = Space.sm + 2.dp),
                    content = content,
                )
            }
            if (status != null) {
                Box {
                    Text(
                        status,
                        style = MaterialTheme.typography.labelSmall,
                        color = if (statusIsError) MaterialTheme.colorScheme.error else colors.labelTertiary,
                        modifier = Modifier
                            .then(
                                if (statusActions.isNotEmpty()) {
                                    Modifier.clickable { actionsOpen = true }
                                } else {
                                    Modifier
                                },
                            )
                            .padding(top = Space.xxs, start = Space.xs, end = Space.xs)
                            .testTag(A11y.messageStatus(id)),
                    )
                    DropdownMenu(
                        expanded = actionsOpen,
                        onDismissRequest = { actionsOpen = false },
                        shape = RoundedCornerShape(Radius.lg),
                    ) {
                        statusActions.forEach { (label, action) ->
                            DropdownMenuItem(
                                text = { Text(label) },
                                onClick = {
                                    actionsOpen = false
                                    action()
                                },
                            )
                        }
                    }
                }
            } else if (endsRun) {
                Text(
                    Format.bubbleTime(time, language),
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.labelTertiary,
                    modifier = Modifier.padding(top = Space.xxs, start = Space.xs, end = Space.xs),
                )
            }
        }
    }
}

/**
 * How wide a bubble may get.
 *
 * A fixed cap rather than a fraction of the screen: on a tablet a bubble at
 * 70% of the width is a line of text so long the eye loses its place coming
 * back, and on a phone this is already most of it.
 */
private val BUBBLE_MAX_WIDTH = 300.dp

/**
 * Keeps a transcript on its newest message while that message settles.
 *
 * `animateScrollToItem(last)` alone is not enough, and the reason is
 * measurable: a photo bubble is short until its bytes arrive and decode, and
 * then it grows by a couple of hundred pixels. The scroll ran on arrival, the
 * bubble grew afterwards, and the bottom half of every picture sat under the
 * composer — proved on device with a four-quadrant test image whose top half
 * measured a full 140px and whose bottom half measured 14.
 *
 * So the pin is held rather than fired once, and it is held against
 * [LazyListState.canScrollForward] rather than against any one row's height.
 * That was the second attempt's mistake: watching the last row only works
 * while the last row is on screen, and an animated scroll past rows that are
 * still growing undershoots — it stopped one bubble short and then had no way
 * back, because the row it was watching was no longer visible.
 *
 * A drag is the operator taking over, and the pin lets go until the next
 * message arrives. Reading back through a thread should not be fought.
 */
@Composable
fun StickToNewest(listState: LazyListState, rowCount: Int) {
    var pinned by remember { mutableStateOf(true) }

    LaunchedEffect(listState) {
        listState.interactionSource.interactions.collect { interaction ->
            if (interaction is DragInteraction.Start) pinned = false
        }
    }
    // A new message re-pins: it is the thing the operator is waiting for.
    LaunchedEffect(rowCount) { pinned = true }

    LaunchedEffect(listState, rowCount, pinned) {
        if (rowCount == 0 || !pinned) return@LaunchedEffect
        // Flips to true whenever the content grows past the viewport —
        // which is exactly when a bubble has finished decoding a photo — and
        // to false once there is nothing below. Two states, so this runs
        // twice per growth rather than on every frame.
        snapshotFlow { listState.canScrollForward }.collect { more ->
            if (more) listState.scrollToItem(rowCount - 1, PAST_THE_END)
        }
    }
}

/**
 * An offset far beyond any viewport, so the list clamps at its own end.
 *
 * `scrollToItem` puts a row's top this far above the viewport top; a lazy
 * list refuses to scroll past its content, so the result is "the very
 * bottom" without having to measure what the bottom is.
 */
private const val PAST_THE_END = 100_000

/**
 * The date above the first message of a day.
 *
 * Shared for the same reason the bubble is: a transcript that says «دیروز»
 * on one screen and «Yesterday» on another is one formatter away from being
 * two formatters.
 */
@Composable
fun DayHeader(instant: Instant, language: Language) {
    Box(
        Modifier.fillMaxWidth().padding(vertical = Space.md),
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            shape = RoundedCornerShape(Radius.pill),
        ) {
            Text(
                Format.dayHeader(instant, language),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = Space.lg, vertical = Space.xs + 2.dp),
            )
        }
    }
}
