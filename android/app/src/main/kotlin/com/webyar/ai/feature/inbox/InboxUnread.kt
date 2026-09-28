package com.webyar.ai.feature.inbox

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.webyar.ai.core.model.ColleaguesResponse
import com.webyar.ai.core.model.Conversation
import com.webyar.ai.core.model.channelKey
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.core.sync.TeamSignal
import com.webyar.ai.feature.team.TEAM_LIST_POLL_MS
import com.webyar.ai.feature.team.followTeam
import com.webyar.ai.i18n.Format
import com.webyar.ai.i18n.Language
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.flow.receiveAsFlow

/**
 * The Open queue's conversations holding a customer message nobody has
 * opened: how many, and how many on each channel.
 *
 * Counted from the rows of that very list (`unread_count`), so the badge on
 * the Inbox tab, the dot on the strip's Open and the list itself can never
 * disagree. Conversations, not messages: the inbox is worked a conversation
 * at a time. The AI's queue is deliberately not counted — the AI is answering
 * those, and a badge that never goes away is a badge nobody looks at.
 */
data class OpenUnread(
    val conversations: Int = 0,
    /** By [channelKey], for the dots on the channel inboxes. */
    val byChannel: Map<String, Int> = emptyMap(),
) {
    companion object {
        fun of(rows: List<Conversation>): OpenUnread {
            val unread = rows.filter { it.hasUnread }
            return OpenUnread(unread.size, unread.groupingBy { it.channelKey }.eachCount())
        }
    }
}

/**
 * Colleagues whose thread holds a message not read yet, and those messages.
 *
 * [threads] is what the badge and the dot count: a colleague who sends five
 * lines in a row is one thing to answer, not five. [messages] is the number
 * the Colleagues button has always carried.
 */
data class TeamUnread(val threads: Int = 0, val messages: Int = 0) {
    companion object {
        fun of(response: ColleaguesResponse): TeamUnread {
            val threads = response.colleagues.count { (it.unread ?: 0) > 0 }
            val messages = response.totalUnread ?: response.colleagues.sumOf { it.unread ?: 0 }
            // A server that sends the total and not the rows still has
            // something unread: one, rather than nothing.
            return TeamUnread(if (threads > 0) threads else if (messages > 0) 1 else 0, messages)
        }
    }
}

/**
 * The count on the Inbox tab: [OpenUnread.conversations] plus
 * [TeamUnread.threads] — exactly the two places an operator is expected to
 * answer. Nothing at all once both are read. The iOS app's `InboxBadge.total`.
 */
fun inboxBadgeCount(open: OpenUnread, team: TeamUnread?): Int =
    open.conversations + (team?.threads ?: 0)

/** The badge's text: the number in the reader's digits, 99 at most. */
fun badgeText(count: Int, language: Language): String =
    if (count > MAX_BADGE) Format.number(MAX_BADGE, language) + "+" else Format.number(count, language)

private const val MAX_BADGE = 99

/**
 * Reads [TeamUnread] for the whole shell, whichever tab is open: the badge
 * matters most when the Inbox is not the tab on screen.
 *
 * Asked straight away, the moment a colleague's message reaches this
 * operator's own channel, when [nudge]d (a thread has just been read here),
 * and every twenty seconds regardless — while the app is in front only.
 */
@Stable
class TeamUnreadReader {
    var value by mutableStateOf<TeamUnread?>(null)
        internal set

    internal val nudges = Channel<Unit>(Channel.CONFLATED)

    /** Something here changed what is unread — a team thread was read. */
    fun nudge() {
        nudges.trySend(Unit)
    }
}

/**
 * A [TeamUnreadReader] for [workspaceId], or one that reads nothing when
 * there is no team chat (null [api], no workspace, or [teamChat] off).
 * Another workspace starts from nothing: one team's count is never shown
 * under another.
 */
@Composable
fun rememberTeamUnread(
    api: WebyarApi?,
    workspaceId: String?,
    teamChat: Boolean,
    signals: Flow<TeamSignal>?,
): TeamUnreadReader {
    val reader = remember { TeamUnreadReader() }
    val lifecycle = LocalLifecycleOwner.current
    LaunchedEffect(api, workspaceId, teamChat, signals, lifecycle) {
        reader.value = null
        if (api == null || workspaceId == null || !teamChat) return@LaunchedEffect
        // A nudge is a signal like any other: one more read, folded with
        // whatever else is already waiting.
        val wakes = merge(
            signals ?: emptyFlow(),
            reader.nudges.receiveAsFlow().map { TeamSignal(workspaceId, NUDGE_KIND) },
        )
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            followTeam(wakes, TEAM_LIST_POLL_MS, wanted = { it.workspaceId == workspaceId }) {
                runCatching { api.colleagues(workspaceId) }
                    // A failed read keeps the count in hand: a badge that
                    // blinks off because one request failed says something untrue.
                    .onSuccess { reader.value = TeamUnread.of(it) }
            }
        }
    }
    return reader
}

private const val NUDGE_KIND = "team_local_read"
