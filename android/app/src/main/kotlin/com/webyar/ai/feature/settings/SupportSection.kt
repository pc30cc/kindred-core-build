package com.webyar.ai.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.webyar.ai.core.model.SupportStatus
import com.webyar.ai.feature.support.PresenceLine
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.StrAndroid
import com.webyar.ai.ui.A11y
import com.webyar.ai.ui.components.Glyph
import com.webyar.ai.ui.components.InsightGlyph
import com.webyar.ai.ui.components.UnreadBadge
import com.webyar.ai.ui.design.Space

/**
 * What Settings needs to draw Online support: the team's status and the
 * operator's requests, summed.
 */
data class SupportSummary(
    val status: SupportStatus,
    val requests: Int,
    val unread: Int,
) {
    /** Shown while there is a way in, or something to follow up. */
    val shown: Boolean get() = status.canStart || (status.shown && requests > 0)
}

/**
 * Settings → Online support.
 *
 * While the platform's team is online, the first row opens a chat with it;
 * while it is not, the row files a ticket instead — the reply then comes to
 * the app and to the operator's email. Below it, their earlier requests,
 * with what is new in them.
 */
@Composable
internal fun SupportSection(
    summary: SupportSummary,
    language: Language,
    onStartChat: () -> Unit,
    onNewTicket: () -> Unit,
    onOpenRequests: () -> Unit,
) {
    val status = summary.status
    val entry = when {
        !status.shown -> null
        status.online -> Entry.CHAT
        status.ticketsEnabled -> Entry.TICKET
        else -> null
    }
    val requests = status.shown && summary.requests > 0
    val count = listOfNotNull(entry, Entry.REQUESTS.takeIf { requests }).size
    if (count == 0) return

    SectionHeader(StrAndroid.supportSection(language))
    Group {
        var index = 0
        when (entry) {
            Entry.CHAT -> SupportRow(
                index = index++,
                count = count,
                icon = InsightGlyph.Chat,
                title = StrAndroid.supportChat(language),
                onClick = onStartChat,
                modifier = Modifier.testTag(A11y.SETTINGS_SUPPORT_CHAT),
            ) { PresenceLine(online = true, language = language) }
            Entry.TICKET -> SupportRow(
                index = index++,
                count = count,
                icon = Glyph.Ticket,
                title = StrAndroid.supportNewTicket(language),
                onClick = onNewTicket,
                modifier = Modifier.testTag(A11y.SETTINGS_SUPPORT_TICKET),
            ) { PresenceLine(online = false, language = language) }
            else -> Unit
        }
        if (requests) {
            SupportRow(
                index = index,
                count = count,
                icon = Glyph.Inbox,
                title = StrAndroid.supportMyRequests(language),
                onClick = onOpenRequests,
                modifier = Modifier.testTag(A11y.SETTINGS_SUPPORT_REQUESTS),
            ) {
                if (summary.unread > 0) UnreadBadge(summary.unread, language)
            }
        }
    }
}

private enum class Entry { CHAT, TICKET, REQUESTS }

@Composable
private fun SupportRow(
    index: Int,
    count: Int,
    icon: ImageVector,
    title: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    trailing: @Composable () -> Unit = {},
) {
    GroupRow(index = index, count = count, onClick = onClick, modifier = modifier) {
        Box(
            Modifier
                .size(40.dp)
                .background(MaterialTheme.colorScheme.secondaryContainer, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSecondaryContainer, modifier = Modifier.size(22.dp))
        }
        Column(Modifier.weight(1f).padding(horizontal = Space.lg), verticalArrangement = Arrangement.Center) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
        }
        trailing()
        Chevron()
    }
}
