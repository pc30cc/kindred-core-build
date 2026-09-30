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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.webyar.ai.core.model.SupportStatus
import com.webyar.ai.feature.support.PresenceLine
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.StrAndroid
import com.webyar.ai.ui.A11y
import com.webyar.ai.ui.components.Glyph
import com.webyar.ai.ui.components.UnreadBadge
import com.webyar.ai.ui.design.Space

/**
 * What Settings needs to draw Online support: the team's status, and
 * whether Super Admin shows the section in the Android app at all.
 */
data class SupportSummary(
    val status: SupportStatus,
    /** Super Admin → Mobile App → Android → Show "Online support". */
    val showSupport: Boolean = true,
) {
    /** Offered by the server to this operator, and not hidden from the app. */
    val shown: Boolean get() = showSupport && status.shown
}

/**
 * Settings → Online support: one row, into the chat with the platform's
 * team — whether it is there now, and how much of what it wrote is unread.
 * Offline, the same row: a message is delivered all the same.
 */
@Composable
internal fun SupportSection(
    summary: SupportSummary,
    language: Language,
    onOpenChat: () -> Unit,
) {
    if (!summary.shown) return
    val status = summary.status

    SectionHeader(StrAndroid.supportSection(language))
    Group {
        GroupRow(index = 0, count = 1, onClick = onOpenChat, modifier = Modifier.testTag(A11y.SETTINGS_SUPPORT_CHAT)) {
            Box(
                Modifier
                    .size(40.dp)
                    .background(MaterialTheme.colorScheme.secondaryContainer, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Glyph.Headset,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSecondaryContainer,
                    modifier = Modifier.size(22.dp),
                )
            }
            Column(
                Modifier.weight(1f).padding(horizontal = Space.lg),
                verticalArrangement = Arrangement.spacedBy(Space.xxs),
            ) {
                Text(StrAndroid.supportChat(language), style = MaterialTheme.typography.bodyLarge)
                PresenceLine(online = status.online, language = language)
            }
            UnreadBadge(status.unread, language)
            Chevron()
        }
    }
}
