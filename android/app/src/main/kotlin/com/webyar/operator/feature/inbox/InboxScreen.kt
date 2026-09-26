package com.webyar.operator.feature.inbox

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
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
import com.webyar.operator.ui.components.ChoiceButton
import com.webyar.operator.ui.components.EmptyState
import com.webyar.operator.ui.components.ErrorState
import com.webyar.operator.ui.components.PillTone
import com.webyar.operator.ui.components.PullIndicator
import com.webyar.operator.ui.components.SearchField
import com.webyar.operator.ui.components.SearchState
import com.webyar.operator.ui.components.SkeletonList
import com.webyar.operator.ui.components.StatusPill
import com.webyar.operator.ui.components.UnreadBadge
import com.webyar.operator.ui.components.bidiContent
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme
import com.webyar.operator.ui.design.WebyarType
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import com.webyar.operator.ui.components.avatarKey
import com.webyar.operator.ui.components.sharedElement
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Warning
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.webyar.operator.ui.components.Glyph
import com.webyar.operator.ui.components.ChannelIcon
import com.webyar.operator.ui.components.ChannelLabel
import com.webyar.operator.ui.components.ConversationChannel
import com.webyar.operator.ui.components.segmentedShape
import com.webyar.operator.i18n.StrAndroid

sealed interface InboxState {
    data object Loading : InboxState
    data class Loaded(val conversations: List<Conversation>) : InboxState
    data class Failed(val message: String) : InboxState
}

/**
 * Every conversation waiting for an answer.
 *
 * Material 3 Expressive, laid out for an operator's day: a large title that
 * names the queue and opens the menu of every queue and channel; the two
 * queues switched between all day as a connected button group under it;
 * then the rows — rounded, without dividers, an unread one set in bold with
 * its time in the brand colour, so the eye lands on the work first.
 *
 * Two queues sit on the strip and the rest live in the menu behind the title,
 * which is where the console keeps them too. Four across a phone left no
 * room for the counts, and two of the six — Resolved and the AI handover
 * queue — are places you go now and then rather than switch between all day.
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
    /** Null when the plan has no team chat, which takes the row out. */
    onOpenColleagues: (() -> Unit)? = null,
    /** Null when the plan has no email module. */
    onOpenEmail: (() -> Unit)? = null,
    /** Unread messages from colleagues, for the Colleagues button. */
    colleaguesUnread: Int? = null,
    /**
     * A strip above the list. Null is the ordinary case — most workspaces
     * have no promotion, and every one of them has dismissed it eventually.
     */
    banner: (@Composable () -> Unit)? = null,
    /**
     * Why the rows below may be out of date, or null. Shown over a list read
     * from the cache — never in place of it: a phone that lost its signal
     * still has every conversation it had a minute ago.
     */
    syncNotice: String? = null,
) {
    Column(modifier.fillMaxSize()) {
        InboxHeader(
            language = language,
            filter = filter,
            allFilters = allFilters,
            counts = counts,
            channels = channels,
            selectedChannel = selectedChannel,
            search = search,
            onSelectFilter = onSelectFilter,
            onSelectChannel = onSelectChannel,
            onOpenColleagues = onOpenColleagues,
            onOpenEmail = onOpenEmail,
        )

        AnimatedVisibility(
            visible = search != null && search.isVisible,
            enter = expandVertically() + fadeIn(),
            exit = shrinkVertically() + fadeOut(),
        ) {
            if (search != null) SearchField(state = search, prompt = Str.search(language))
        }

        var everyInboxOpen by remember { mutableStateOf(false) }
        QueueGroup(
            language = language,
            chips = chipFilters,
            selected = filter,
            counts = counts,
            selectedChannel = selectedChannel,
            onSelect = onSelectFilter,
            onOpenColleagues = onOpenColleagues,
            colleaguesUnread = colleaguesUnread,
            // Lit while the list is one the strip has no button for, so the
            // operator can see where they are.
            elsewhere = selectedChannel != null || filter !in chipFilters,
            onOpenEveryInbox = { everyInboxOpen = true },
        )
        if (everyInboxOpen) {
            EveryInboxSheet(
                language = language,
                filter = filter,
                allFilters = allFilters,
                counts = counts,
                channels = channels,
                selectedChannel = selectedChannel,
                colleaguesUnread = colleaguesUnread,
                onSelectFilter = onSelectFilter,
                onSelectChannel = onSelectChannel,
                onOpenColleagues = onOpenColleagues,
                onOpenEmail = onOpenEmail,
                onDismiss = { everyInboxOpen = false },
            )
        }

        // Above the list and below the chrome: an operator scrolling the
        // inbox scrolls past it once, rather than having it pinned over the
        // rows they are trying to read.
        banner?.invoke()

        if (syncNotice != null && state is InboxState.Loaded) {
            SyncNotice(syncNotice)
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
                // Rows rather than a spinner: the shape of the answer is
                // known before the answer is, so nothing jumps when it lands.
                is InboxState.Loading -> SkeletonList(
                    Modifier.fillMaxSize().padding(contentPadding),
                )

                is InboxState.Failed -> ErrorState(
                    title = Str.offlineTitle(language),
                    body = state.message,
                    retryLabel = Str.retry(language),
                    onRetry = onRefresh,
                )

                is InboxState.Loaded -> if (state.conversations.isEmpty()) {
                    EmptyState(
                        icon = Icons.Filled.Email,
                        title = Str.inboxEmptyTitle(language),
                        body = Str.inboxEmptyBody(language),
                        modifier = Modifier.testTag(A11y.INBOX_EMPTY),
                    )
                } else {
                    LazyColumn(
                        Modifier.fillMaxSize().testTag(A11y.INBOX_LIST),
                        contentPadding = PaddingValues(
                            top = Space.xs,
                            bottom = Space.lg + contentPadding.calculateBottomPadding(),
                        ),
                    ) {
                        items(state.conversations, key = { it.id }) { conversation ->
                            ConversationRow(
                                conversation = conversation,
                                language = language,
                                profile = intel[conversation.id],
                                modifier = Modifier.animateItem(),
                            ) { onOpen(conversation) }
                        }
                    }
                }
            }
        }
    }
}

/**
 * The large title, which is also the menu of every queue and every channel,
 * and the search button beside it.
 *
 * A title that is a button is unusual, so it wears a chevron — the one
 * affordance that says "there is more behind this word".
 *
 * Both axes live in the menu rather than on strips of their own. A queue
 * strip, a channel strip and a title bar is three rows of chrome before the
 * first conversation, which on a 5-inch phone in Persian left four rows
 * visible; a menu with two sections costs one extra tap for something you
 * change now and then. The queue that IS switched all day keeps its buttons
 * below.
 */
@Composable
private fun InboxHeader(
    language: Language,
    filter: InboxFilter,
    allFilters: List<InboxFilter>,
    counts: InboxCounts,
    channels: List<ChannelInbox>,
    selectedChannel: String?,
    search: SearchState?,
    onSelectFilter: (InboxFilter) -> Unit,
    onSelectChannel: (String?) -> Unit,
    onOpenColleagues: (() -> Unit)?,
    onOpenEmail: (() -> Unit)?,
) {
    var menuOpen by remember { mutableStateOf(false) }
    val channel = channels.firstOrNull { it.key == selectedChannel }

    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 72.dp)
            .padding(start = Space.sm, end = Space.lg, top = Space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.weight(1f)) {
            Row(
                Modifier
                    .clip(RoundedCornerShape(Radius.lg))
                    .clickable(role = Role.DropdownList) { menuOpen = true }
                    .padding(horizontal = Space.sm, vertical = Space.xs)
                    .testTag(A11y.INBOX_TITLE_MENU),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // One line, and the channel REPLACES the queue rather than
                // sitting under it: a queue and a channel are never both in
                // force, so naming both was naming a state the app cannot be in.
                Text(
                    channel?.title(language) ?: filter.headerTitle(language),
                    style = WebyarType.headlineMediumEmphasized,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Icon(
                    Icons.Filled.KeyboardArrowDown,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = Space.xs),
                )
            }

            DropdownMenu(
                expanded = menuOpen,
                onDismissRequest = { menuOpen = false },
                shape = RoundedCornerShape(Radius.lg),
            ) {
                allFilters.forEach { option ->
                    MenuRow(
                        label = option.title(language),
                        // A queue is current only when no channel is laid
                        // over it.
                        selected = option == filter && selectedChannel == null,
                        badge = counts.count(option)?.takeIf { it > 0 }?.let { count ->
                            { UnreadBadge(count, language) }
                        },
                    ) { menuOpen = false; onSelectFilter(option) }
                }

                // A workspace with no channel plugins installed gets no
                // second section at all, rather than a heading over one item
                // that undoes nothing.
                if (channels.isNotEmpty()) {
                    HorizontalDivider(Modifier.padding(vertical = Space.xs))
                    Text(
                        Str.otherInboxes(language),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(horizontal = Space.lg, vertical = Space.xs),
                    )
                    // No "all inboxes" row: picking any queue above drops the
                    // channel, so the tick comes off the way it does on iOS.
                    channels.forEach { option ->
                        MenuRow(
                            label = option.title(language),
                            selected = option.key == selectedChannel,
                        ) { menuOpen = false; onSelectChannel(option.key) }
                    }
                }

                // The internal inbox and the email inbox. Not queues and not
                // channels — somewhere else entirely — so they go below a rule
                // of their own with no tick, because you do not come back to
                // this menu to leave them. You press Back.
                if (onOpenColleagues != null || onOpenEmail != null) {
                    HorizontalDivider(Modifier.padding(vertical = Space.xs))
                    if (onOpenColleagues != null) {
                        DropdownMenuItem(
                            text = { Text(Str.colleagues(language)) },
                            leadingIcon = { Icon(Icons.Filled.Person, contentDescription = null) },
                            onClick = { menuOpen = false; onOpenColleagues() },
                        )
                    }
                    if (onOpenEmail != null) {
                        DropdownMenuItem(
                            text = { Text(Str.emailInbox(language)) },
                            leadingIcon = { Icon(Icons.Filled.Email, contentDescription = null) },
                            onClick = { menuOpen = false; onOpenEmail() },
                        )
                    }
                }
            }
        }

        if (search != null) {
            FilledTonalIconButton(
                onClick = { search.toggle() },
                modifier = Modifier.size(Size.minTouchTarget).testTag(A11y.INBOX_SEARCH),
            ) {
                Icon(Icons.Filled.Search, contentDescription = Str.search(language))
            }
        }
    }
}

/**
 * One row of the title menu — a queue or a channel, ticked when it is the one
 * in force.
 *
 * The tick's slot is held open whether it is filled or not, so a section's
 * labels stay in one column instead of stepping sideways as the selection
 * moves. In Persian that column is on the right, which is where `leadingIcon`
 * puts it without being told.
 */
@Composable
private fun MenuRow(
    label: String,
    selected: Boolean,
    badge: (@Composable () -> Unit)? = null,
    onClick: () -> Unit,
) {
    DropdownMenuItem(
        text = { Text(label, fontWeight = if (selected) FontWeight.SemiBold else null) },
        leadingIcon = {
            Box(Modifier.size(Size.icon)) {
                if (selected) {
                    Icon(
                        Icons.Filled.Check,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                    )
                }
            }
        },
        trailingIcon = badge,
        onClick = onClick,
    )
}

/**
 * The inboxes worked in all day, as a row of buttons: Open, the AI's queue,
 * the colleagues' chat — and last, three lines that open every inbox there
 * is.
 *
 * "Needs me" and "Awaiting customer" used to sit here too, and with them the
 * two that matter scrolled off a Persian phone. They are behind the last
 * button with the channels, Resolved, Spam and email, where a place visited
 * now and then belongs. A channel laid over the queues leaves none of them
 * selected, because none of them is what the list shows.
 */
@Composable
private fun QueueGroup(
    language: Language,
    chips: List<InboxFilter>,
    selected: InboxFilter,
    counts: InboxCounts,
    selectedChannel: String?,
    onSelect: (InboxFilter) -> Unit,
    onOpenColleagues: (() -> Unit)?,
    colleaguesUnread: Int?,
    elsewhere: Boolean,
    onOpenEveryInbox: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .selectableGroup()
            .padding(horizontal = Space.screenInset, vertical = Space.sm),
        horizontalArrangement = Arrangement.spacedBy(Space.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        chips.forEach { option ->
            ChoiceButton(
                label = option.title(language),
                count = counts.count(option),
                selected = option == selected && selectedChannel == null,
                language = language,
                onClick = { onSelect(option) },
                modifier = Modifier.testTag(A11y.inboxChip(option.wire)),
            )
        }
        if (onOpenColleagues != null) {
            // Somewhere else rather than a queue, so never "selected": it
            // opens the team chat, and Back comes home.
            ChoiceButton(
                label = Str.colleagues(language),
                count = colleaguesUnread,
                selected = false,
                language = language,
                onClick = onOpenColleagues,
                modifier = Modifier.testTag(A11y.INBOX_COLLEAGUES_CHIP),
            )
        }
        EveryInboxButton(language, lit = elsewhere, onClick = onOpenEveryInbox)
    }
}

/** The strip's last button: three lines, which open every inbox. */
@Composable
private fun EveryInboxButton(language: Language, lit: Boolean, onClick: () -> Unit) {
    val label = StrAndroid.everyInbox(language)
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(Radius.lg),
        color = if (lit) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = if (lit) MaterialTheme.colorScheme.onSecondaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier
            .size(width = 52.dp, height = 40.dp)
            .semantics { contentDescription = label }
            .testTag(A11y.INBOX_EVERY_INBOX),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(Glyph.Menu, contentDescription = null, modifier = Modifier.size(22.dp))
        }
    }
}

/**
 * Every inbox, in one sheet: the queues with their counts, the channel
 * inboxes, and the two places that are not queues at all — the colleagues'
 * chat and the mailbox.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EveryInboxSheet(
    language: Language,
    filter: InboxFilter,
    allFilters: List<InboxFilter>,
    counts: InboxCounts,
    channels: List<ChannelInbox>,
    selectedChannel: String?,
    colleaguesUnread: Int?,
    onSelectFilter: (InboxFilter) -> Unit,
    onSelectChannel: (String?) -> Unit,
    onOpenColleagues: (() -> Unit)?,
    onOpenEmail: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(bottom = Space.xl)
                .testTag(A11y.INBOX_EVERY_INBOX_SHEET),
        ) {
            Text(
                StrAndroid.everyInbox(language),
                style = WebyarType.titleLargeEmphasized,
                modifier = Modifier.padding(horizontal = Space.xl, vertical = Space.sm),
            )

            SheetSection(Str.tabInbox(language))
            SheetGroup {
                allFilters.forEachIndexed { index, option ->
                    SheetRow(
                        index = index,
                        count = allFilters.size,
                        icon = option.icon(),
                        label = option.title(language),
                        selected = option == filter && selectedChannel == null,
                        badge = counts.count(option)?.takeIf { it > 0 },
                        language = language,
                        modifier = Modifier.testTag(A11y.everyInboxRow(option.wire)),
                    ) { onDismiss(); onSelectFilter(option) }
                }
            }

            if (channels.isNotEmpty()) {
                SheetSection(Str.otherInboxes(language))
                SheetGroup {
                    channels.forEachIndexed { index, option ->
                        SheetRow(
                            index = index,
                            count = channels.size,
                            iconContent = { ChannelIcon(option.key, 22.dp) },
                            label = option.title(language),
                            selected = option.key == selectedChannel,
                            language = language,
                        ) { onDismiss(); onSelectChannel(option.key) }
                    }
                }
            }

            val elsewhere = listOfNotNull(
                onOpenColleagues?.let { Triple(Str.colleagues(language), Icons.Filled.Person, it) },
                onOpenEmail?.let { Triple(Str.emailInbox(language), Icons.Filled.Email, it) },
            )
            if (elsewhere.isNotEmpty()) {
                SheetSection(StrAndroid.teamAndMail(language))
                SheetGroup {
                    elsewhere.forEachIndexed { index, (label, icon, open) ->
                        SheetRow(
                            index = index,
                            count = elsewhere.size,
                            icon = icon,
                            label = label,
                            selected = false,
                            badge = if (icon == Icons.Filled.Person) colleaguesUnread?.takeIf { it > 0 } else null,
                            language = language,
                        ) { onDismiss(); open() }
                    }
                }
            }
        }
    }
}

@Composable
private fun SheetSection(title: String) {
    Text(
        title,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = Space.xl, end = Space.xl, top = Space.lg, bottom = Space.xs),
    )
}

@Composable
private fun SheetGroup(content: @Composable () -> Unit) {
    Column(
        Modifier.padding(horizontal = Space.lg),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) { content() }
}

/**
 * One inbox in the sheet: a tonal row in the settings' segmented style, its
 * mark in a circle, its count as a badge, and a tick when it is the one open.
 */
@Composable
private fun SheetRow(
    index: Int,
    count: Int,
    label: String,
    selected: Boolean,
    language: Language,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    iconContent: (@Composable () -> Unit)? = null,
    badge: Int? = null,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        color = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = segmentedShape(index, count),
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            Modifier
                .heightIn(min = 56.dp)
                .padding(horizontal = Space.lg, vertical = Space.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .size(36.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.surfaceContainerHighest),
                contentAlignment = Alignment.Center,
            ) {
                when {
                    iconContent != null -> iconContent()
                    icon != null -> Icon(
                        icon,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
            Text(
                label,
                style = if (selected) WebyarType.titleMediumEmphasized else MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(horizontal = Space.lg),
            )
            if (badge != null) UnreadBadge(badge, language, Modifier.padding(end = Space.sm))
            if (selected) {
                Icon(Icons.Filled.Check, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            }
        }
    }
}

/** Each queue's mark in the sheet. */
private fun InboxFilter.icon(): ImageVector = when (this) {
    InboxFilter.OPEN -> Icons.Filled.Email
    InboxFilter.NEEDS_HUMAN -> Icons.Filled.Person
    InboxFilter.PENDING -> Glyph.Schedule
    InboxFilter.AI -> Glyph.Sparkle
    InboxFilter.RESOLVED -> Icons.Filled.CheckCircle
    InboxFilter.SPAM -> Icons.Filled.Warning
}

/** Why the list may be out of date, as a tonal strip rather than an alarm. */
@Composable
private fun SyncNotice(text: String) {
    Surface(
        color = MaterialTheme.colorScheme.secondaryContainer,
        contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
        shape = RoundedCornerShape(Radius.lg),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.screenInset, vertical = Space.xs)
            .testTag(A11y.INBOX_SYNC_NOTICE),
    ) {
        Row(
            Modifier.padding(horizontal = Space.md, vertical = Space.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            Icon(Icons.Outlined.Info, contentDescription = null, modifier = Modifier.size(18.dp))
            Text(text, style = MaterialTheme.typography.labelLarge)
        }
    }
}

/**
 * One conversation, at a glance.
 *
 * The avatar carries what we know about the visitor — their operating system
 * as a brand mark, their country as a flag — because a row an operator can
 * recognise without reading is a row they can skip. An unread one is set in
 * bold, its preview in full ink and its time in the brand colour, so the
 * rows that need an answer stand out before a word is read.
 */
@Composable
private fun ConversationRow(
    conversation: Conversation,
    language: Language,
    profile: VisitorProfile?,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val name = Format.contactName(
        name = conversation.contact?.name,
        email = conversation.contact?.email,
        visitorCode = conversation.contact?.visitorCode,
        language = language,
    )
    val unread = conversation.unreadCount ?: 0
    val emphasis = unread > 0

    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = Space.sm, vertical = 1.dp)
            .clip(RoundedCornerShape(Radius.xl))
            .background(
                if (emphasis) MaterialTheme.colorScheme.surfaceContainerLow else MaterialTheme.colorScheme.surface,
            )
            .clickable(onClick = onClick)
            .testTag(A11y.conversationRow(conversation.id))
            .heightIn(min = Size.rowMinHeight + 12.dp)
            .padding(horizontal = Space.md, vertical = Space.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(
            name = name,
            imageUrl = conversation.contact?.avatarUrl,
            size = Size.avatarLarge * 0.68f,
            os = profile?.device?.os,
            device = profile?.device?.device,
            countryCode = profile?.geo?.countryCode,
            // Carried into the chat's bar when the row is opened.
            modifier = Modifier.sharedElement(avatarKey(conversation.id)),
        )

        Column(Modifier.weight(1f).padding(start = Space.lg)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                // The name and its pill share the room the time leaves them;
                // the name gives way first.
                Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        name,
                        style = (if (emphasis) WebyarType.titleMediumEmphasized else MaterialTheme.typography.titleMedium)
                            .bidiContent(),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    // Where they are writing from, beside who they are — the
                    // console's badge, on every row, the website's included.
                    ChannelLabel(
                        key = remember(conversation.metadata, conversation.contact) { ConversationChannel.of(conversation) },
                        language = language,
                        compact = true,
                        modifier = Modifier.padding(start = Space.sm),
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
                    Format.listTimestamp(conversation.lastActivity, language),
                    style = if (emphasis) WebyarType.labelLargeEmphasized.copy(fontSize = MaterialTheme.typography.labelMedium.fontSize)
                    else MaterialTheme.typography.labelMedium,
                    color = if (emphasis) MaterialTheme.colorScheme.primary else WebyarTheme.colors.labelTertiary,
                    maxLines = 1,
                    modifier = Modifier.padding(start = Space.sm),
                )
            }
            Row(
                Modifier.padding(top = Space.xxs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    conversation.preview(language),
                    // The preview can arrive in any of the three languages,
                    // and a Turkish sentence in a Persian list had its full
                    // stop moved to the front until this went in.
                    style = (if (emphasis) WebyarType.bodyMediumEmphasized else MaterialTheme.typography.bodyMedium)
                        .bidiContent(),
                    color = if (emphasis) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (emphasis) {
                    UnreadBadge(unread, language, Modifier.padding(start = Space.sm))
                }
            }
        }
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

/**
 * What this queue is called where it names the screen rather than a chip.
 *
 * The main queue is simply "the inbox" in that position — nobody calls the
 * screen they land on "Open". Same rule as iOS's `headerTitle`.
 */
private fun InboxFilter.headerTitle(language: Language): String =
    if (this == InboxFilter.OPEN) Str.tabInbox(language) else title(language)

/** The queue's own name, which lives in the strings rather than in the enum. */
private fun InboxFilter.title(language: Language): String = when (this) {
    InboxFilter.OPEN -> Str.filterOpen(language)
    InboxFilter.NEEDS_HUMAN -> Str.filterNeedsHuman(language)
    InboxFilter.PENDING -> Str.filterPending(language)
    InboxFilter.AI -> StrAndroid.filterAI(language)
    InboxFilter.RESOLVED -> Str.filterResolved(language)
    InboxFilter.SPAM -> Str.filterSpam(language)
}
