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
import com.webyar.operator.core.model.EmailFolder
import com.webyar.operator.i18n.StrEmail
import com.webyar.operator.ui.components.ChoiceButton
import com.webyar.operator.ui.components.LatinText
import com.webyar.operator.ui.components.rowTextAlign
import com.webyar.operator.ui.components.LoadingIndicator
import com.webyar.operator.ui.components.Glyph
import com.webyar.operator.ui.components.StatusPill
import com.webyar.operator.ui.components.PillTone
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.IconButton
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.Dp

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
    folder: EmailFolder = EmailFolder.INBOX,
    onSelectFolder: (EmailFolder) -> Unit = {},
    hasMore: Boolean = false,
    loadingMore: Boolean = false,
    onLoadMore: () -> Unit = {},
    onToggleStar: (EmailThreadSummary) -> Unit = {},
    onToggleRead: (EmailThreadSummary) -> Unit = {},
) {
    Column(modifier.fillMaxSize()) {
        AnimatedVisibility(
            visible = search != null && search.isVisible,
            enter = fadeIn() + expandVertically(),
            exit = fadeOut() + shrinkVertically(),
        ) {
            if (search != null) SearchField(state = search, prompt = Str.search(language))
        }

        // The mailbox's three views, as a mail client keeps them.
        if (!notConnected) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .selectableGroup()
                    .padding(horizontal = Space.screenInset, vertical = Space.sm),
                horizontalArrangement = Arrangement.spacedBy(Space.xs),
            ) {
                EmailFolder.entries.forEach { option ->
                    ChoiceButton(
                        label = when (option) {
                            EmailFolder.INBOX -> StrEmail.folderInbox(language)
                            EmailFolder.UNREAD -> StrEmail.folderUnread(language)
                            EmailFolder.STARRED -> StrEmail.folderStarred(language)
                        },
                        selected = option == folder,
                        language = language,
                        onClick = { onSelectFolder(option) },
                        modifier = Modifier.testTag(A11y.emailFolder(option.name.lowercase())),
                    )
                }
            }
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
                    val listState = rememberLazyListState()
                    // The next page as the end comes into view, not when it
                    // is reached: the rows are there before the thumb is.
                    val nearEnd by remember(state.threads.size) {
                        derivedStateOf {
                            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
                            last >= state.threads.size - 5
                        }
                    }
                    LaunchedEffect(nearEnd, hasMore) {
                        if (nearEnd && hasMore) onLoadMore()
                    }
                    LazyColumn(
                        Modifier.fillMaxSize().testTag(A11y.EMAIL_LIST),
                        state = listState,
                        contentPadding = PaddingValues(
                            top = Space.xs + contentPadding.calculateTopPadding(),
                            // Room under the last row for the compose button.
                            bottom = Space.lg + 80.dp + contentPadding.calculateBottomPadding(),
                        ),
                    ) {
                        items(state.threads, key = { it.id }) { thread ->
                            EmailThreadRow(
                                thread = thread,
                                mailbox = mailbox,
                                language = language,
                                modifier = Modifier.animateItem(),
                                onToggleStar = { onToggleStar(thread) },
                                onToggleRead = { onToggleRead(thread) },
                            ) { onOpen(thread) }
                        }
                        if (loadingMore) {
                            item(key = "more") {
                                Box(Modifier.fillMaxWidth().padding(Space.lg), Alignment.Center) {
                                    LoadingIndicator(size = 36.dp)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * One thread: who, what about, the last line — and its star, which is a
 * button of its own rather than something to open the thread for.
 *
 * A long press offers read/unread and the star, the two things done to a
 * mail without reading it.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun EmailThreadRow(
    thread: EmailThreadSummary,
    mailbox: String?,
    language: Language,
    modifier: Modifier = Modifier,
    onToggleStar: () -> Unit = {},
    onToggleRead: () -> Unit = {},
    onClick: () -> Unit,
) {
    val unread = thread.isRead != true
    val starred = thread.isStarred == true
    val people = thread.people(excludingMailbox = mailbox)
    var menuOpen by remember { mutableStateOf(false) }

    // The inbox's rounded row, with its tone under what is unread.
    Box(
        modifier
            .fillMaxWidth()
            .padding(horizontal = Space.sm, vertical = 1.dp)
            .clip(RoundedCornerShape(Radius.xl))
            .background(if (unread) MaterialTheme.colorScheme.surfaceContainerLow else Color.Transparent)
            .combinedClickable(onClick = onClick, onLongClick = { menuOpen = true })
            .testTag(A11y.emailRow(thread.id))
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = Size.rowMinHeight)
                .padding(start = Space.md, end = Space.xs, top = Space.md, bottom = Space.md),
            verticalAlignment = Alignment.Top,
        ) {
            MailAvatar(address = thread.participants.orEmpty().firstOrNull { !it.email.equals(mailbox, ignoreCase = true) }?.email ?: people)
            Column(Modifier.weight(1f).padding(horizontal = Space.md)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (unread) {
                        Box(
                            Modifier
                                .padding(end = Space.xs)
                                .size(8.dp)
                                .clip(CircleShape)
                                .background(MaterialTheme.colorScheme.primary),
                        )
                    }
                    LatinText(
                        people,
                        style = MaterialTheme.typography.titleMedium.copy(
                            // An unread thread is heavier. That is the one
                            // difference Mail leans on, and it is enough.
                            fontWeight = if (unread) FontWeight.Bold else FontWeight.Medium,
                        ),
                        maxLines = 1,
                        align = rowTextAlign(),
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        Format.listTimestamp(thread.lastMessageAt, language),
                        style = MaterialTheme.typography.labelMedium,
                        color = if (unread) MaterialTheme.colorScheme.primary else WebyarTheme.colors.labelTertiary,
                        fontWeight = if (unread) FontWeight.SemiBold else null,
                        maxLines = 1,
                        modifier = Modifier.padding(start = Space.sm),
                    )
                }
                Text(
                    thread.subject?.takeIf { it.isNotEmpty() } ?: Str.emailNoSubject(language),
                    style = MaterialTheme.typography.bodyMedium.bidiContent(),
                    fontWeight = if (unread) FontWeight.SemiBold else null,
                    color = if (unread) {
                        MaterialTheme.colorScheme.onSurface
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
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
                // The mailbox's own labels, when the provider sent any
                // worth reading (the system ones are folders, not news).
                val labels = thread.labels.orEmpty().filter { it.isVisibleLabel() }.take(3)
                if (labels.isNotEmpty()) {
                    Row(
                        Modifier.padding(top = Space.xs),
                        horizontalArrangement = Arrangement.spacedBy(Space.xs),
                    ) {
                        labels.forEach { label -> StatusPill(label.prettyLabel(), tone = PillTone.NEUTRAL) }
                    }
                }
            }
            Box {
                IconButton(
                    onClick = onToggleStar,
                    modifier = Modifier.size(40.dp).testTag(A11y.emailStar(thread.id)),
                ) {
                    Icon(
                        if (starred) Icons.Filled.Star else Glyph.StarOutline,
                        contentDescription = if (starred) StrEmail.unstar(language) else StrEmail.star(language),
                        tint = if (starred) WebyarTheme.colors.warning else WebyarTheme.colors.labelTertiary,
                        modifier = Modifier.size(22.dp),
                    )
                }
                DropdownMenu(
                    expanded = menuOpen,
                    onDismissRequest = { menuOpen = false },
                    shape = RoundedCornerShape(Radius.lg),
                ) {
                    DropdownMenuItem(
                        text = { Text(if (unread) StrEmail.markRead(language) else StrEmail.markUnread(language)) },
                        leadingIcon = { Icon(Icons.Filled.Email, contentDescription = null) },
                        onClick = { menuOpen = false; onToggleRead() },
                    )
                    DropdownMenuItem(
                        text = { Text(if (starred) StrEmail.unstar(language) else StrEmail.star(language)) },
                        leadingIcon = { Icon(Icons.Filled.Star, contentDescription = null) },
                        onClick = { menuOpen = false; onToggleStar() },
                    )
                }
            }
        }
    }
}

/**
 * Who a mail is from, as a face: a circle in a colour of the address's own
 * — the same sender is always the same colour — with a person in it. Not
 * initials, which this app does not draw anywhere.
 */
@Composable
internal fun MailAvatar(address: String, size: Dp = Size.avatarSmall) {
    val hue = remember(address) { (address.lowercase().hashCode().toLong() and 0xFFFFFFFFL) % 360L }
    val dark = isSystemInDarkTheme()
    val container = Color.hsl(hue.toFloat(), if (dark) 0.35f else 0.55f, if (dark) 0.30f else 0.88f)
    val content = Color.hsl(hue.toFloat(), if (dark) 0.60f else 0.55f, if (dark) 0.82f else 0.32f)
    Box(
        Modifier
            .size(size)
            .clip(CircleShape)
            .background(container),
        contentAlignment = Alignment.Center,
    ) {
        Icon(Icons.Filled.Person, contentDescription = null, tint = content, modifier = Modifier.size(size * 0.55f))
    }
}

/** Gmail's system labels are folders, not something to show on a row. */
private fun String.isVisibleLabel(): Boolean {
    val upper = uppercase()
    return upper !in SYSTEM_LABELS && !upper.startsWith("CATEGORY_") && isNotBlank()
}

private fun String.prettyLabel(): String = removePrefix("Label_").replace('_', ' ')

private val SYSTEM_LABELS = setOf(
    "INBOX", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "SPAM", "TRASH", "CHAT", "OPENED",
)
