package com.platform.app.feature.team

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.platform.app.core.model.CallChannel
import com.platform.app.core.model.TeamCallOutcome
import com.platform.app.core.model.TeamChatCall
import com.platform.app.i18n.Format
import com.platform.app.i18n.Language
import com.platform.app.i18n.Str
import com.platform.app.ui.components.Glyph
import com.platform.app.ui.components.MessageBubble
import com.platform.app.ui.design.Space
import java.time.Instant

// The call in the chat (docs/operations/TEAM_CALLS.md, "The call in the
// chat"): every colleague call leaves one line in the two members' thread,
// written by the server when the call ends, from the caller to the callee.
// These are the rules the thread's call bubble and the colleagues list's
// preview draw it by, the web panel's (`src/features/teamCalls/teamCallLog.ts`)
// and the iPhone's.

/**
 * A call line's title, by who is looking:
 *
 * | outcome   | caller sees              | callee sees               |
 * |-----------|--------------------------|---------------------------|
 * | completed | voice/video (+ duration) | the same                  |
 * | missed    | no answer                | missed voice/video        |
 * | cancelled | cancelled                | missed voice/video        |
 * | declined  | declined                 | declined                  |
 * | failed    | failed                   | failed                    |
 */
enum class TeamCallLogTitle {
    VOICE,
    VIDEO,
    MISSED_VOICE,
    MISSED_VIDEO,
    NO_ANSWER,
    DECLINED,
    CANCELLED,
    FAILED;

    fun text(l: Language): String = when (this) {
        VOICE -> Str.teamCallLogVoice(l)
        VIDEO -> Str.teamCallLogVideo(l)
        MISSED_VOICE -> Str.teamCallLogMissedVoice(l)
        MISSED_VIDEO -> Str.teamCallLogMissedVideo(l)
        NO_ANSWER -> Str.teamCallLogNoAnswer(l)
        DECLINED -> Str.teamCallLogDeclined(l)
        CANCELLED -> Str.teamCallLogCancelled(l)
        FAILED -> Str.teamCallLogFailed(l)
    }
}

/** The line's title for the member looking at it: [viewerIsCaller] when they placed the call. */
fun TeamChatCall.logTitle(viewerIsCaller: Boolean): TeamCallLogTitle {
    val video = channel == CallChannel.VIDEO
    val missed = if (video) TeamCallLogTitle.MISSED_VIDEO else TeamCallLogTitle.MISSED_VOICE
    return when (outcome) {
        TeamCallOutcome.COMPLETED -> if (video) TeamCallLogTitle.VIDEO else TeamCallLogTitle.VOICE
        TeamCallOutcome.MISSED -> if (viewerIsCaller) TeamCallLogTitle.NO_ANSWER else missed
        TeamCallOutcome.CANCELLED -> if (viewerIsCaller) TeamCallLogTitle.CANCELLED else missed
        TeamCallOutcome.DECLINED -> TeamCallLogTitle.DECLINED
        TeamCallOutcome.FAILED -> TeamCallLogTitle.FAILED
    }
}

/** Drawn in the danger colour: a missed call, and a cancelled one for the callee. */
fun TeamChatCall.isMissedFor(viewerIsCaller: Boolean): Boolean =
    outcome == TeamCallOutcome.MISSED || (outcome == TeamCallOutcome.CANCELLED && !viewerIsCaller)

/**
 * The completed call's length as the line shows it, or null: any other
 * outcome, or a completed call whose length the server did not know.
 */
fun TeamChatCall.logDuration(language: Language): String? {
    if (outcome != TeamCallOutcome.COMPLETED) return null
    return durationSeconds?.let { teamCallLogDuration(it, language) }
}

/**
 * `m:ss`, or `h:mm:ss` from an hour on — the shape the server's own body and
 * the web panel write — in the reader's digits, as every clock in this app.
 */
fun teamCallLogDuration(seconds: Long, language: Language): String {
    val total = seconds.coerceAtLeast(0)
    val hours = total / 3600
    val minutes = (total % 3600) / 60
    val secs = total % 60
    val zero = Format.number(0L, language)
    fun padded(value: Long): String = Format.number(value, language).let { if (it.length < 2) zero + it else it }
    return if (hours > 0) {
        "${Format.number(hours, language)}:${padded(minutes)}:${padded(secs)}"
    } else {
        "${Format.number(minutes, language)}:${padded(secs)}"
    }
}

/**
 * The title with a completed call's length, as the colleagues list previews
 * the line: "Voice call · 4:05", "Missed video call" — the iPhone's and the
 * web panel's.
 */
fun TeamChatCall.logHeadline(viewerIsCaller: Boolean, language: Language): String {
    val title = logTitle(viewerIsCaller).text(language)
    return logDuration(language)?.let { "$title · $it" } ?: title
}

/**
 * What the screen reader says for a call's line: the title (with a completed
 * call's length), the direction and the time — in the iPhone's and the web
 * panel's order, with the language's own comma.
 */
fun teamCallLogLabel(call: TeamChatCall, viewerIsCaller: Boolean, time: Instant?, language: Language): String =
    listOfNotNull(
        call.logTitle(viewerIsCaller).text(language),
        call.logDuration(language),
        if (viewerIsCaller) Str.teamCallLogOutgoing(language) else Str.teamCallLogIncoming(language),
        time?.let { Format.bubbleTime(it, language) },
    ).filter { it.isNotEmpty() }.joinToString(if (language == Language.FA) "، " else ", ")

/** The tag of a call line's content, for tests: the bubble's own row is [com.platform.app.ui.A11y.messageRow]. */
internal fun teamCallLineTag(messageId: String) = "team.callLine.$messageId"

/**
 * One colleague call in the thread: a bubble on the caller's side with the
 * phone or the camera, the arrow out (for the caller) or in (for the callee),
 * the title and the time — with the length, for a completed call. Missed is
 * in the danger colour.
 *
 * A tap calls back, with the same channel, when [onCallBack] is given — the
 * thread's own call buttons' gate decides that. It cannot be replied to,
 * quoted, copied or forwarded: nothing in it is text anyone wrote.
 */
@Composable
internal fun TeamCallLine(
    messageId: String,
    call: TeamChatCall,
    viewerIsCaller: Boolean,
    outgoing: Boolean,
    endsRun: Boolean,
    startsRun: Boolean,
    time: Instant?,
    language: Language,
    avatar: (@Composable () -> Unit)?,
    onCallBack: (() -> Unit)?,
) {
    val title = call.logTitle(viewerIsCaller).text(language)
    val missed = call.isMissedFor(viewerIsCaller)
    val label = teamCallLogLabel(call, viewerIsCaller, time, language)
    MessageBubble(
        id = messageId,
        outgoing = outgoing,
        endsRun = endsRun,
        startsRun = startsRun,
        time = time,
        language = language,
        avatar = avatar,
        // The time is inside, beside the arrow: not twice.
        showsTime = false,
        onClick = onCallBack,
        onClickLabel = Str.teamCallLogCallBack(language),
    ) {
        val content = LocalContentColor.current
        val tint = if (missed) MaterialTheme.colorScheme.error else content
        val quiet = if (missed) MaterialTheme.colorScheme.error else content.copy(alpha = 0.72f)
        Row(
            Modifier.clearAndSetSemantics {
                contentDescription = label
                testTag = teamCallLineTag(messageId)
            },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .size(40.dp)
                    .clip(CircleShape)
                    .background(tint.copy(alpha = 0.14f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (call.channel == CallChannel.VIDEO) Glyph.Videocam else Glyph.Call,
                    contentDescription = null,
                    tint = tint,
                    modifier = Modifier.size(22.dp),
                )
            }
            Column(
                Modifier.padding(start = Space.md, end = Space.xs),
                verticalArrangement = Arrangement.spacedBy(Space.xxs),
            ) {
                Text(
                    title,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium,
                    color = if (missed) MaterialTheme.colorScheme.error else Color.Unspecified,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        if (viewerIsCaller) CallArrow.Out else CallArrow.In,
                        contentDescription = null,
                        tint = quiet,
                        modifier = Modifier.size(16.dp),
                    )
                    Text(
                        listOfNotNull(
                            Format.bubbleTime(time, language).takeIf { it.isNotEmpty() },
                            call.logDuration(language),
                        ).joinToString(" · "),
                        style = MaterialTheme.typography.labelMedium,
                        color = content.copy(alpha = 0.72f),
                        modifier = Modifier.padding(start = Space.xs),
                    )
                }
            }
        }
    }
}

/**
 * A call's line under a colleague's name in the list: its icon and its
 * title (with a completed call's length, [logHeadline]), never its body.
 * Missed is in the danger colour.
 */
@Composable
internal fun TeamCallPreview(
    call: TeamChatCall,
    viewerIsCaller: Boolean,
    language: Language,
    color: Color,
    modifier: Modifier = Modifier,
    fontWeight: FontWeight? = null,
) {
    val missed = call.isMissedFor(viewerIsCaller)
    val tint = if (missed) MaterialTheme.colorScheme.error else color
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Icon(
            if (call.channel == CallChannel.VIDEO) Glyph.Videocam else Glyph.Call,
            contentDescription = null,
            tint = tint,
            modifier = Modifier.size(16.dp),
        )
        Text(
            call.logHeadline(viewerIsCaller, language),
            style = MaterialTheme.typography.bodyMedium,
            color = tint,
            fontWeight = fontWeight,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = Space.xs),
        )
    }
}

/**
 * The arrow beside a call's time: out (↗) for the caller, in (↙) for the
 * callee. Material Icons' `call_made` and `call_received`, which
 * `material-icons-core` does not carry, mirrored under right to left as
 * Material mirrors them (they point along the reading direction).
 */
private object CallArrow {
    val Out: ImageVector by lazy { arrow("CallMade", "M9 5v2h6.59L4 18.59 5.41 20 17 8.41V15h2V5z") }
    val In: ImageVector by lazy { arrow("CallReceived", "M20 5.41 18.59 4 7 15.59V9H5v10h10v-2H8.41z") }

    private fun arrow(name: String, pathData: String): ImageVector =
        ImageVector.Builder(
            name = name,
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
            autoMirror = true,
        ).apply {
            addPath(
                pathData = PathParser().parsePathString(pathData).toNodes(),
                fill = SolidColor(Color.Black),
            )
        }.build()
}
