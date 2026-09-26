package com.webyar.operator.feature.email

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.webyar.operator.core.model.EmailThreadSummary
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.Avatar
import com.webyar.operator.ui.components.EmptyState
import com.webyar.operator.ui.components.ErrorState
import com.webyar.operator.ui.components.SearchField
import com.webyar.operator.ui.components.SearchState
import com.webyar.operator.ui.components.SkeletonList
import com.webyar.operator.ui.components.bidiContent
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import com.webyar.operator.ui.components.PullIndicator
import com.webyar.operator.ui.design.Radius

/**
 * The mailbox: who it is with, what it is about, and the last line of it.
 *
 * Three lines per row rather than the inbox's two, because a mail has a
 * subject AND a body and neither stands for the other — «Invoice #2026-0914»
 * and «Sorry, could you resend that?» are different pieces of news and a row
 * that showed only one of them would be guessing which you wanted.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EmailInboxScreen(
    state: EmailInboxState,
    language: Language,
    onOpen: (EmailThreadSummary) -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
    mailbox: String? = null,
    notConnected: Boolean = false,
    refreshing: Boolean = false,
    search: SearchState? = null,
    onRefresh: () -> Unit = {},
    onRetry: () -> Unit = {},
) {
    Column(modifier.fillMaxSize()) {
        AnimatedVisibility(
            visible = search != null && search.isVisible,
            enter = fadeIn() + expandVertically(),
            exit = fadeOut() + shrinkVertically(),
        ) {
            if (search != null) SearchField(state = search, prompt = Str.search(language))
        }

        val pullState = rememberPullToRefreshState()
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = onRefresh,
            state = pullState,
            indicator = { PullIndicator(pullState, refreshing) },
            modifier = Modifier.weight(1f),
        ) {
            when (state) {
                is EmailInboxState.Loading -> SkeletonList(
                    Modifier.fillMaxSize().padding(contentPadding),
                    rows = 8,
                )

                is EmailInboxState.Failed -> ErrorState(
                    title = Str.offlineTitle(language),
                    body = state.message,
                    retryLabel = Str.retry(language),
                    onRetry = onRetry,
                )

                is EmailInboxState.Loaded -> if (state.threads.isEmpty()) {
                    val searching = search?.text?.isNotBlank() == true
                    EmptyState(
                        icon = if (searching) Icons.Filled.Search else Icons.Filled.Email,
                        // Three different empties, and they are three
                        // different pieces of news: no mailbox has been
                        // connected, the mailbox is empty, or the search
                        // found nothing in it.
                        title = when {
                            notConnected -> Str.emailNotConnectedTitle(language)
                            searching -> Str.noResults(language)
                            else -> Str.emailEmptyTitle(language)
                        },
                        body = when {
                            notConnected -> Str.emailNotConnectedBody(language)
                            searching -> null
                            else -> Str.emailEmptyBody(language)
                        },
                        modifier = Modifier.testTag(
                            if (notConnected) A11y.EMAIL_NOT_CONNECTED else A11y.EMAIL_EMPTY
                        ),
                    )
                } else {
                    LazyColumn(
                        Modifier.fillMaxSize().testTag(A11y.EMAIL_LIST),
                        contentPadding = PaddingValues(
                            top = Space.xs + contentPadding.calculateTopPadding(),
                            bottom = Space.lg + contentPadding.calculateBottomPadding(),
                        ),
                    ) {
                        items(state.threads, key = { it.id }) { thread ->
                            EmailThreadRow(thread, mailbox, language, Modifier.animateItem()) { onOpen(thread) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun EmailThreadRow(
    thread: EmailThreadSummary,
    mailbox: String?,
    language: Language,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val unread = thread.isRead != true
    val people = thread.people(excludingMailbox = mailbox)

    // The inbox's rounded row, with its tone under what is unread.
    Box(
        modifier
            .fillMaxWidth()
            .padding(horizontal = Space.sm, vertical = 1.dp)
            .clip(RoundedCornerShape(Radius.xl))
            .background(if (unread) MaterialTheme.colorScheme.surfaceContainerLow else Color.Transparent)
            .clickable(onClick = onClick)
            .testTag(A11y.emailRow(thread.id))
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = Size.rowMinHeight)
                .padding(horizontal = Space.md, vertical = Space.md),
            verticalAlignment = Alignment.Top,
        ) {
            Avatar(name = people, size = Size.avatarSmall)
            Column(Modifier.weight(1f).padding(horizontal = Space.md)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        people,
                        style = MaterialTheme.typography.titleMedium.bidiContent(),
                        // An unread thread is heavier. That is the one
                        // difference Mail leans on, and it is enough.
                        fontWeight = if (unread) FontWeight.Bold else FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    if (thread.isStarred == true) {
                        Icon(
                            Icons.Filled.Star,
                            contentDescription = Str.emailStar(language),
                            tint = WebyarTheme.colors.warning,
                            modifier = Modifier.size(14.dp).padding(start = Space.xxs),
                        )
                    }
                    Text(
                        Format.listTimestamp(thread.lastMessageAt, language),
                        style = MaterialTheme.typography.labelMedium,
                        color = if (unread) MaterialTheme.colorScheme.primary else WebyarTheme.colors.labelTertiary,
                        maxLines = 1,
                        modifier = Modifier.padding(start = Space.sm),
                    )
                }
                Text(
                    thread.subject?.takeIf { it.isNotEmpty() } ?: Str.emailNoSubject(language),
                    style = MaterialTheme.typography.bodyMedium.bidiContent(),
                    color = if (unread) {
                        MaterialTheme.colorScheme.onSurface
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth(),
                )
                thread.lastMessageSnippet?.takeIf { it.isNotEmpty() }?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall.bidiContent(),
                        color = WebyarTheme.colors.labelTertiary,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}
