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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import coil3.compose.AsyncImage
import com.webyar.operator.core.model.MessageAttachment
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
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
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = WebyarTheme.colors
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl

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
                shape = ChatBubbleShape(
                    hasBeak = endsRun,
                    // The beak sits on the bubble's OUTER edge — the side the
                    // bubble itself is on — and which physical side that is
                    // depends on the language. `Arrangement.End` puts an
                    // outgoing bubble on the left in Persian, the same way
                    // Telegram and WhatsApp do, so its beak belongs on the
                    // left too. `pointsRight = outgoing` was right-handed in
                    // both senses: it drew a tail pointing back into the
                    // middle of the screen.
                    pointsRight = if (rtl) !outgoing else outgoing,
                ),
            ) {
                Column(
                    Modifier.padding(horizontal = Space.md, vertical = Space.sm),
                    content = content,
                )
            }
            if (endsRun) {
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
 * What a message carries besides its words.
 *
 * A picture is shown; everything else is a card with a name and a size on it,
 * because a phone cannot usefully preview a spreadsheet and a card that says
 * what the thing is beats a generic paperclip.
 */
@Composable
fun AttachmentView(
    attachment: MessageAttachment,
    language: Language,
    load: (suspend (String) -> ByteArray?)?,
) {
    if (attachment.resolvedKind != MessageAttachment.Kind.IMAGE || load == null) {
        FileCard(attachment, language)
        return
    }

    var bytes by remember(attachment.id) { mutableStateOf<ByteArray?>(null) }
    var failed by remember(attachment.id) { mutableStateOf(false) }
    LaunchedEffect(attachment.id) {
        val loaded = runCatching { load(attachment.id) }.getOrNull()
        if (loaded == null) failed = true else bytes = loaded
    }

    when {
        // Both the failure and the not-yet show the card, so nothing resizes
        // when the bytes land — the picture replaces a placeholder of roughly
        // its own footprint rather than pushing the transcript down.
        failed || bytes == null -> FileCard(attachment, language)
        else -> AsyncImage(
            model = bytes,
            contentDescription = attachment.displayName,
            contentScale = ContentScale.Fit,
            modifier = Modifier
                .widthIn(max = 260.dp)
                .padding(bottom = Space.xs)
                .clip(RoundedCornerShape(Space.md)),
        )
    }
}

@Composable
private fun FileCard(attachment: MessageAttachment, language: Language) {
    Row(
        Modifier.padding(vertical = Space.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Glyph.Document, contentDescription = null, modifier = Modifier.size(20.dp))
        Column(Modifier.padding(start = Space.sm)) {
            Text(
                attachment.displayName ?: Str.attachFile(language),
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            attachment.sizeBytes?.let {
                Text(
                    Format.fileSize(it.toLong(), language),
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
    }
}

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
            color = MaterialTheme.colorScheme.surfaceContainerHighest,
            shape = RoundedCornerShape(Space.md),
        ) {
            Text(
                Format.dayHeader(instant, language),
                style = MaterialTheme.typography.labelMedium,
                color = WebyarTheme.colors.labelTertiary,
                modifier = Modifier.padding(horizontal = Space.md, vertical = Space.xs),
            )
        }
    }
}
