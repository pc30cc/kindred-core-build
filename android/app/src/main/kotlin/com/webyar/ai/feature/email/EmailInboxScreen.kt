package com.webyar.ai.feature.email

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
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.webyar.ai.core.model.EmailThreadSummary
import com.webyar.ai.i18n.Format
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.Str
import com.webyar.ai.ui.A11y
import com.webyar.ai.ui.components.Avatar
import com.webyar.ai.ui.components.EmptyState
import com.webyar.ai.ui.components.ErrorState
import com.webyar.ai.ui.components.SearchField
import com.webyar.ai.ui.components.SearchState
import com.webyar.ai.ui.components.SkeletonList
import com.webyar.ai.ui.components.bidiContent
import com.webyar.ai.ui.design.Size
import com.webyar.ai.ui.design.Space
import com.webyar.ai.ui.design.WebyarTheme
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
import androidx.compose.ui.graphics.luminance
import com.webyar.ai.ui.components.PullIndicator
import com.webyar.ai.ui.design.Radius
import com.webyar.ai.core.model.EmailFolder
import com.webyar.ai.core.model.EmailMailFolder
import com.webyar.ai.core.model.EmailMailbox
import com.webyar.ai.i18n.StrEmail
import com.webyar.ai.ui.components.ChoiceButton
import com.webyar.ai.ui.components.LoadingIndicator
import com.webyar.ai.ui.components.Glyph
import com.webyar.ai.ui.components.StatusPill
import com.webyar.ai.ui.components.PillTone
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.ui.unit.LayoutDirection

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
    /** The workspace's connected mailboxes; a switcher appears when there is more than one. */
    mailboxes: List<EmailMailbox> = emptyList(),
    /** The provider of the mailbox on screen; null is the first. */
    selectedMailbox: String? = null,
    onSelectMailbox: (String) -> Unit = {},
    /** The folder on screen (`inbox`, `sent`, `label:…`), from the ☰ menu. */
    mailFolder: String = EmailMailFolder.INBOX,
    /** That folder's unread count, for the Unread filter; null uses the mailbox's own (the inbox's). */
    folderUnread: Int? = null,
    /** The mailbox's labels by id (`Label_12` → «Clients»), for the pills on a row. */
    labelNames: Map<String, String> = emptyMap(),
) {
    val shown = mailboxes.firstOrNull { it.provider == selectedMailbox } ?: mailboxes.firstOrNull()
    Column(modifier.fillMaxSize()) {
        AnimatedVisibility(
            visible = search != null && search.isVisible,
            enter = fadeIn() + expandVertically(),
            exit = fadeOut() + shrinkVertically(),
        ) {
            if (search != null) SearchField(state = search, prompt = Str.search(language))
        }

        // One button per mailbox when a Gmail and a Yahoo are both connected,
        // each with its own unread count, the way a mail client lists its
        // accounts.
        if (mailboxes.size > 1) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .selectableGroup()
                    .padding(start = Space.screenInset, end = Space.screenInset, top = Space.sm),
                horizontalArrangement = Arrangement.spacedBy(Space.xs),
            ) {
                mailboxes.forEach { box ->
                    ChoiceButton(
                        // The address isolated left to right inside a Persian label.
                        label = box.address?.takeIf { it.isNotBlank() }?.let { "\u2066$it\u2069" } ?: box.provider,
                        selected = box.provider == shown?.provider,
                        language = language,
                        onClick = { onSelectMailbox(box.provider) },
                        count = box.unread?.takeIf { it > 0 },
                        modifier = Modifier.testTag(A11y.emailMailbox(box.provider)),
                    )
                }
            }
        }

        // Three views of the folder on screen: everything, what is unread,
        // what is starred (not offered inside Starred itself).
        if (!notConnected) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .selectableGroup()
                    .padding(horizontal = Space.screenInset, vertical = Space.sm),
                horizontalArrangement = Arrangement.spacedBy(Space.xs),
            ) {
                EmailFolder.entries.filter { !(it == EmailFolder.STARRED && mailFolder == "starred") }.forEach { option ->
                    ChoiceButton(
                        label = when (option) {
                            EmailFolder.INBOX -> StrEmail.filterAll(language)
                            EmailFolder.UNREAD -> StrEmail.folderUnread(language)
                            EmailFolder.STARRED -> StrEmail.folderStarred(language)
                        },
                        selected = option == folder,
                        language = language,
                        onClick = { onSelectFolder(option) },
                        // How many threads are unread, on the view that lists them.
                        count = if (option == EmailFolder.UNREAD) {
                            (folderUnread ?: shown?.unread.takeIf { mailFolder == EmailMailFolder.INBOX })?.takeIf { it > 0 }
                        } else {
                            null
                        },
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
                            mailFolder != EmailMailFolder.INBOX -> StrEmail.folderEmpty(language)
                            else -> Str.emailEmptyTitle(language)
                        },
                        body = when {
                            notConnected -> Str.emailNotConnectedBody(language)
                            searching -> null
                            mailFolder != EmailMailFolder.INBOX -> null
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
                                mailFolder = mailFolder,
                                labelNames = labelNames,
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
    mailFolder: String = EmailMailFolder.INBOX,
    labelNames: Map<String, String> = emptyMap(),
    onToggleStar: () -> Unit = {},
    onToggleRead: () -> Unit = {},
    onClick: () -> Unit,
) {
    val unread = thread.isRead != true
    val starred = thread.isStarred == true
    // Who, by name: «Google», not «"Google" <no-reply@accounts.google.com>».
    val others = thread.participants.orEmpty().map { MailName.parse(it.email) }
        .let { all -> all.filterNot { mailbox != null && it.email.equals(mailbox, ignoreCase = true) }.ifEmpty { all } }
    val names = others.joinToString(if (language == Language.FA) "، " else ", ") { it.display }
    // Sent and Drafts are about whom a mail is to, as every mail client says there.
    val addressed = mailFolder == "sent" || mailFolder == "drafts"
    val people = if (addressed && names.isNotEmpty()) "${StrEmail.to(language)}: \u2068$names\u2069" else names
    var menuOpen by remember { mutableStateOf(false) }

    // Mail is laid out left to right in every language of the app, as mail
    // clients lay it out: the face on the left, the star on the right, the
    // lines standing on the left — each in its own word order.
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
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
                // Keyed on the address, as the reader keys the same sender's face.
                MailAvatar(address = others.firstOrNull()?.email ?: names)
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
                        if (mailFolder == "drafts") {
                            Text(
                                StrEmail.draft(language),
                                style = MaterialTheme.typography.titleMedium,
                                color = MaterialTheme.colorScheme.error,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 1,
                                modifier = Modifier.padding(end = Space.xs),
                            )
                        }
                        // A name in its own direction — Persian or English —
                        // standing on the row's side either way.
                        Text(
                            people,
                            style = MaterialTheme.typography.titleMedium.bidiContent().copy(
                                // An unread thread is heavier. That is the one
                                // difference Mail leans on, and it is enough.
                                fontWeight = if (unread) FontWeight.Bold else FontWeight.Medium,
                            ),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
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
                    // The mailbox's own labels, by the names the mailbox gave
                    // them (Gmail sends ids), except the one being looked at;
                    // the system ones are folders, not news.
                    val labels = thread.labels.orEmpty()
                        .filter { "label:$it" != mailFolder }
                        .mapNotNull { labelNames[it] }
                        .take(3)
                    if (labels.isNotEmpty()) {
                        Row(
                            Modifier.padding(top = Space.xs),
                            horizontalArrangement = Arrangement.spacedBy(Space.xs),
                        ) {
                            labels.forEach { label -> StatusPill(label, tone = PillTone.NEUTRAL) }
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
}

/**
 * Who a mail is from, as a face: a circle in a colour of the address's own
 * — the same sender is always the same colour — with a person in it. Not
 * initials, which this app does not draw anywhere.
 */
@Composable
internal fun MailAvatar(address: String, size: Dp = Size.avatarSmall) {
    val hue = remember(address) { (address.lowercase().hashCode().toLong() and 0xFFFFFFFFL) % 360L }
    // The app's theme, not the phone's: Settings can pin light or dark
    // whatever the system says, and a pastel circle meant for a white page
    // glares on a dark one.
    val dark = MaterialTheme.colorScheme.surface.luminance() < 0.5f
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

