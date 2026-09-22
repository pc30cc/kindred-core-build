package com.webyar.operator.feature.team

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import com.webyar.operator.core.model.Colleague
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.Avatar
import com.webyar.operator.ui.components.EmptyState
import com.webyar.operator.ui.components.ErrorState
import com.webyar.operator.ui.components.RowDivider
import com.webyar.operator.ui.components.SearchField
import com.webyar.operator.ui.components.SearchState
import com.webyar.operator.ui.components.SkeletonList
import com.webyar.operator.ui.components.UnreadBadge
import com.webyar.operator.ui.components.bidiContent
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme

/**
 * Everyone on the team, and what they last said.
 *
 * A smaller avatar than the inbox and the address book use, deliberately: a
 * colleague is somebody you already know, so the face is an aid to scanning
 * rather than the thing you identify them by — and the smaller row fits more
 * of a team on a screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ColleaguesScreen(
    state: ColleaguesState,
    language: Language,
    onOpen: (Colleague) -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
    refreshing: Boolean = false,
    search: SearchState? = null,
    onRefresh: () -> Unit = {},
    onRetry: () -> Unit = {},
) {
    Column(modifier.fillMaxSize()) {
        if (search != null && search.isVisible) {
            SearchField(state = search, prompt = Str.search(language))
        }

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = onRefresh,
            modifier = Modifier.weight(1f),
        ) {
            when (state) {
                is ColleaguesState.Loading -> SkeletonList(
                    Modifier.fillMaxSize().padding(contentPadding),
                    rows = 8,
                )

                is ColleaguesState.Failed -> ErrorState(
                    title = Str.offlineTitle(language),
                    body = state.message,
                    retryLabel = Str.retry(language),
                    onRetry = onRetry,
                )

                is ColleaguesState.Loaded -> if (state.colleagues.isEmpty()) {
                    val searching = search?.text?.isNotBlank() == true
                    EmptyState(
                        icon = if (searching) Icons.Filled.Search else Icons.Filled.Person,
                        title = if (searching) {
                            Str.noResults(language)
                        } else {
                            Str.colleaguesEmptyTitle(language)
                        },
                        body = if (searching) null else Str.colleaguesEmptyBody(language),
                        modifier = Modifier.testTag(A11y.COLLEAGUES_EMPTY),
                    )
                } else {
                    LazyColumn(
                        Modifier.fillMaxSize().testTag(A11y.COLLEAGUES_LIST),
                        contentPadding = contentPadding,
                    ) {
                        items(state.colleagues, key = { it.userId }) { colleague ->
                            ColleagueRow(colleague, language) { onOpen(colleague) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ColleagueRow(
    colleague: Colleague,
    language: Language,
    onClick: () -> Unit,
) {
    val unread = colleague.unread ?: 0

    Column(
        Modifier
            .clickable(onClick = onClick)
            .testTag(A11y.colleagueRow(colleague.userId))
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = Size.rowMinHeight)
                .padding(horizontal = Space.screenInset, vertical = Space.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Avatar(
                name = colleague.displayName,
                imageUrl = colleague.avatarUrl,
                size = Size.avatarSmall,
            )
            Column(Modifier.weight(1f).padding(horizontal = Space.md)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        colleague.displayName,
                        style = MaterialTheme.typography.titleMedium.bidiContent(),
                        fontWeight = if (unread > 0) FontWeight.Bold else FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    colleague.lastMessage?.createdAt?.let {
                        Text(
                            Format.listTimestamp(it, language),
                            style = MaterialTheme.typography.labelSmall,
                            color = WebyarTheme.colors.labelTertiary,
                            maxLines = 1,
                            modifier = Modifier.padding(start = Space.sm),
                        )
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        colleague.preview(language),
                        style = MaterialTheme.typography.bodyMedium.bidiContent(),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    if (unread > 0) {
                        UnreadBadge(unread, language, Modifier.padding(start = Space.sm))
                    }
                }
            }
        }
        RowDivider()
    }
}

/**
 * The one line under a colleague's name.
 *
 * An attachment-only message has no body, so it is named by what it is — the
 * same rule the conversation rows follow, and the reason a colleague who sent
 * you a photo does not appear to have sent you nothing.
 */
internal fun Colleague.preview(language: Language): String {
    val last = lastMessage ?: return ""
    last.body?.takeIf { it.isNotBlank() }?.let { return Format.preview(it) }
    return when (last.attachmentKind) {
        "image" -> Str.photo(language)
        "audio" -> Str.voiceNote(language)
        "video" -> Str.videoFile(language)
        "file" -> Str.file(language)
        else -> ""
    }
}
