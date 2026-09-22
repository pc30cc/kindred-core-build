package com.webyar.operator.feature.inbox

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import com.webyar.operator.core.model.ChannelInbox
import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.ConversationStatus
import com.webyar.operator.core.model.InboxCounts
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.core.model.VisitorProfile
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.i18n.SystemMessage
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.Avatar
import com.webyar.operator.ui.components.EmptyState
import com.webyar.operator.ui.components.ErrorState
import com.webyar.operator.ui.components.PillTone
import com.webyar.operator.ui.components.RowDivider
import com.webyar.operator.ui.components.SearchField
import com.webyar.operator.ui.components.SearchState
import com.webyar.operator.ui.components.StatusPill
import com.webyar.operator.ui.components.UnreadBadge
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme

sealed interface InboxState {
    data object Loading : InboxState
    data class Loaded(val conversations: List<Conversation>) : InboxState
    data class Failed(val message: String) : InboxState
}

/**
 * Every conversation waiting for an answer.
 *
 * Two queues sit on the strip and the rest live in the menu behind the title,
 * which is where the console keeps them too. Four chips across a phone left no
 * room for the counts, and two of the six — Resolved and the AI handover queue
 * — are places you go now and then rather than switch between all day.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxScreen(
    state: InboxState,
    language: Language,
    onOpen: (Conversation) -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
    filter: InboxFilter = InboxFilter.OPEN,
    allFilters: List<InboxFilter> = listOf(InboxFilter.OPEN),
    chipFilters: List<InboxFilter> = listOf(InboxFilter.OPEN),
    counts: InboxCounts = InboxCounts(),
    channels: List<ChannelInbox> = emptyList(),
    selectedChannel: String? = null,
    intel: Map<String, VisitorProfile> = emptyMap(),
    refreshing: Boolean = false,
    search: SearchState? = null,
    onSelectFilter: (InboxFilter) -> Unit = {},
    onSelectChannel: (String?) -> Unit = {},
    onRefresh: () -> Unit = {},
) {
    Column(modifier.fillMaxSize()) {
        InboxBar(
            language = language,
            filter = filter,
            allFilters = allFilters,
            counts = counts,
            search = search,
            onSelectFilter = onSelectFilter,
        )

        if (search != null && search.isVisible) {
            SearchField(state = search, prompt = Str.search(language))
        }

        if (chipFilters.size > 1) {
            FilterStrip(language, chipFilters, filter, counts, onSelectFilter)
        }

        if (channels.isNotEmpty()) {
            ChannelStrip(language, channels, selectedChannel, onSelectChannel)
        }

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = onRefresh,
            modifier = Modifier.weight(1f),
        ) {
            when (state) {
                is InboxState.Loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    CircularProgressIndicator()
                }

                is InboxState.Failed -> ErrorState(
                    title = Str.offlineTitle(language),
                    body = state.message,
                    retryLabel = Str.retry(language),
                    onRetry = onRefresh,
                )

                is InboxState.Loaded -> if (state.conversations.isEmpty()) {
                    EmptyState(
                        icon = Icons.Filled.Search,
                        title = Str.inboxEmptyTitle(language),
                        body = Str.inboxEmptyBody(language),
                        modifier = Modifier.testTag(A11y.INBOX_EMPTY),
                    )
                } else {
                    LazyColumn(
                        Modifier.fillMaxSize().testTag(A11y.INBOX_LIST),
                        contentPadding = contentPadding,
                    ) {
                        items(state.conversations, key = { it.id }) { conversation ->
                            ConversationRow(
                                conversation = conversation,
                                language = language,
                                profile = intel[conversation.id],
                            ) { onOpen(conversation) }
                        }
                    }
                }
            }
        }
    }
}

/**
 * The title, which is also the menu of every queue.
 *
 * A title that is a button is unusual, so it wears a chevron — the one
 * affordance that says "there is more behind this word".
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun InboxBar(
    language: Language,
    filter: InboxFilter,
    allFilters: List<InboxFilter>,
    counts: InboxCounts,
    search: SearchState?,
    onSelectFilter: (InboxFilter) -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }

    TopAppBar(
        title = {
            Box {
                Row(
                    Modifier
                        .clickable { menuOpen = true }
                        .testTag(A11y.INBOX_TITLE_MENU),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        filter.title(language),
                        style = MaterialTheme.typography.titleLarge,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Icon(Icons.Filled.ArrowDropDown, contentDescription = null)
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    allFilters.forEach { option ->
                        DropdownMenuItem(
                            text = {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        option.title(language),
                                        fontWeight = if (option == filter) FontWeight.SemiBold else null,
                                        modifier = Modifier.weight(1f),
                                    )
                                    counts.count(option)?.takeIf { it > 0 }?.let {
                                        UnreadBadge(it, language, Modifier.padding(start = Space.sm))
                                    }
                                }
                            },
                            onClick = { menuOpen = false; onSelectFilter(option) },
                        )
                    }
                }
            }
        },
        actions = {
            if (search != null) {
                IconButton(
                    onClick = { search.toggle() },
                    modifier = Modifier.testTag(A11y.INBOX_SEARCH),
                ) {
                    Icon(Icons.Filled.Search, contentDescription = Str.search(language))
                }
            }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FilterStrip(
    language: Language,
    chips: List<InboxFilter>,
    selected: InboxFilter,
    counts: InboxCounts,
    onSelect: (InboxFilter) -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = Space.screenInset, vertical = Space.xs),
        horizontalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        chips.forEach { option ->
            val count = counts.count(option)
            FilterChip(
                selected = option == selected,
                onClick = { onSelect(option) },
                label = {
                    Text(
                        // The count rides in the label, because the whole
                        // reason to glance at this strip is to see where the
                        // work is.
                        if (count != null && count > 0) {
                            "${option.title(language)} ${Format.number(count, language)}"
                        } else {
                            option.title(language)
                        }
                    )
                },
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChannelStrip(
    language: Language,
    channels: List<ChannelInbox>,
    selected: String?,
    onSelect: (String?) -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = Space.screenInset, vertical = Space.xs),
        horizontalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        FilterChip(
            selected = selected == null,
            onClick = { onSelect(null) },
            label = { Text(Str.allInboxes(language)) },
        )
        channels.forEach { channel ->
            FilterChip(
                selected = channel.key == selected,
                onClick = { onSelect(channel.key) },
                label = { Text(channel.title(language)) },
            )
        }
    }
}

/**
 * One conversation, at a glance.
 *
 * The avatar carries what we know about the visitor — their operating system
 * as a brand mark, their country as a flag — because a row an operator can
 * recognise without reading is a row they can skip.
 */
@Composable
private fun ConversationRow(
    conversation: Conversation,
    language: Language,
    profile: VisitorProfile?,
    onClick: () -> Unit,
) {
    val name = Format.contactName(
        name = conversation.contact?.name,
        email = conversation.contact?.email,
        visitorCode = conversation.contact?.visitorCode,
        language = language,
    )
    val unread = conversation.unreadCount ?: 0

    Column(
        Modifier
            .clickable(onClick = onClick)
            .testTag(A11y.conversationRow(conversation.id))
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = Size.rowMinHeight)
                .padding(horizontal = Space.screenInset, vertical = Space.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Avatar(
                name = name,
                imageUrl = conversation.contact?.avatarUrl,
                os = profile?.device?.os,
                device = profile?.device?.device,
                countryCode = profile?.geo?.countryCode,
            )

            Column(Modifier.weight(1f).padding(horizontal = Space.md)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        name,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = if (unread > 0) FontWeight.Bold else FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    if (conversation.status == ConversationStatus.RESOLVED) {
                        StatusPill(
                            Str.filterResolved(language),
                            tone = PillTone.SUCCESS,
                            modifier = Modifier.padding(start = Space.sm),
                        )
                    }
                }
                Text(
                    conversation.preview(language),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            Column(horizontalAlignment = Alignment.End) {
                Text(
                    Format.listTimestamp(conversation.lastActivity, language),
                    style = MaterialTheme.typography.labelSmall,
                    color = WebyarTheme.colors.labelTertiary,
                    maxLines = 1,
                )
                if (unread > 0) {
                    UnreadBadge(unread, language, Modifier.padding(top = Space.xs))
                }
            }
        }
        RowDivider()
    }
}

/**
 * The one line under a name.
 *
 * A message with only an attachment has an empty body, so previewing the body
 * alone would claim "no messages yet" about a conversation somebody just sent
 * a photo to. And a system notice is stored in English, so it is rebuilt in
 * the reader's language the same way the transcript rebuilds it.
 */
internal fun Conversation.preview(language: Language): String {
    val last = lastMessage ?: return ""

    last.systemKind?.takeIf { it.isNotEmpty() }?.let {
        SystemMessage.text(last.systemMeta, language)?.let { text -> return text }
    }

    last.attachmentKind?.takeIf { it.isNotEmpty() }?.let { kind ->
        return SystemMessage.attachmentPreview(
            kind = kind,
            isMe = last.senderType != "contact",
            name = last.senderName,
            language = language,
        )
    }

    return Format.preview(last.body)
}

/** The queue's own name, which lives in the strings rather than in the enum. */
private fun InboxFilter.title(language: Language): String = when (this) {
    InboxFilter.OPEN -> Str.filterOpen(language)
    InboxFilter.NEEDS_HUMAN -> Str.filterNeedsHuman(language)
    InboxFilter.PENDING -> Str.filterPending(language)
    InboxFilter.AI -> Str.filterAI(language)
    InboxFilter.RESOLVED -> Str.filterResolved(language)
    InboxFilter.SPAM -> Str.filterSpam(language)
}
