package com.webyar.ai.feature.inbox

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.isSpecified
import androidx.compose.ui.unit.sp
import com.webyar.ai.core.model.ChannelInbox
import com.webyar.ai.core.model.Conversation
import com.webyar.ai.core.model.ConversationStatus
import com.webyar.ai.core.model.InboxCounts
import com.webyar.ai.core.model.EmailMailbox
import com.webyar.ai.core.model.InboxFilter
import com.webyar.ai.core.model.VisitorProfile
import com.webyar.ai.i18n.Format
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.Str
import com.webyar.ai.i18n.SystemMessage
import com.webyar.ai.ui.A11y
import com.webyar.ai.ui.components.Avatar
import com.webyar.ai.ui.components.ChoiceButton
import com.webyar.ai.ui.components.EmptyState
import com.webyar.ai.ui.components.ErrorState
import com.webyar.ai.ui.components.PillTone
import com.webyar.ai.ui.components.PullIndicator
import com.webyar.ai.ui.components.SearchField
import com.webyar.ai.ui.components.SearchState
import com.webyar.ai.ui.components.SkeletonList
import com.webyar.ai.ui.components.StatusPill
import com.webyar.ai.ui.components.UnreadBadge
import com.webyar.ai.ui.components.UnreadDot
import com.webyar.ai.ui.components.unreadDescription
import com.webyar.ai.ui.components.bidiContent
import com.webyar.ai.ui.design.Radius
import com.webyar.ai.ui.design.Size
import com.webyar.ai.ui.design.Space
import com.webyar.ai.ui.design.WebyarTheme
import com.webyar.ai.ui.design.WebyarType
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import com.webyar.ai.ui.components.avatarKey
import com.webyar.ai.ui.components.sharedElement
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Warning
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import com.webyar.ai.ui.components.Glyph
import com.webyar.ai.ui.components.ChannelIcon
import com.webyar.ai.ui.components.ChannelLabel
import com.webyar.ai.ui.components.ConversationChannel
import com.webyar.ai.ui.components.segmentedShape
import com.webyar.ai.i18n.StrAndroid
import com.webyar.ai.core.model.ConversationPriority

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
 * which is where the console keeps them too. Four across a phone leave no
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
    /**
     * Shows the colleagues' chats in this inbox, as the strip shows a queue.
     * Null when the plan has no team chat, which takes the button out.
     */
    onOpenColleagues: (() -> Unit)? = null,
    /** Whether the colleagues' chats are the inbox on screen, in place of a queue's rows. */
    colleaguesShown: Boolean = false,
    /** The colleagues' chats, drawn under the strip while [colleaguesShown]. */
    colleagues: (@Composable (Modifier) -> Unit)? = null,
    /**
     * Null when the plan has no email module. Called with the mailbox
     * (`gmail`, `yahoo`) to open, or null for the one last shown.
     */
    onOpenEmail: ((String?) -> Unit)? = null,
    /** The workspace's connected mailboxes; one row each when there is more than one. */
    mailboxes: List<EmailMailbox> = emptyList(),
    /** Unread email threads across them, for the Email row and the menu's dot. */
    emailUnread: Int = 0,
    /** Unread messages from colleagues, for the Colleagues button. */
    colleaguesUnread: Int? = null,
    /**
     * What nobody has read yet, for the red dots: the Open queue's
     * conversations (on Open, and on each channel inbox by its channel) and
     * the colleagues whose thread holds a message (on Colleagues). The same
     * counts as the Inbox tab's badge. Never the AI queue — the AI is
     * answering those.
     */
    openUnread: OpenUnread = OpenUnread(),
    colleagueThreadsUnread: Int = 0,
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
            colleaguesShown = colleaguesShown,
            onOpenEmail = onOpenEmail,
            mailboxes = mailboxes,
            emailUnread = emailUnread,
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
            colleaguesShown = colleaguesShown,
            colleaguesUnread = colleaguesUnread,
            openUnread = openUnread.conversations,
            colleagueThreadsUnread = colleagueThreadsUnread,
            onOpenEmail = onOpenEmail?.let { open -> { open(null) } },
            emailUnread = emailUnread,
            // A dot on the last button when a channel inbox behind it holds
            // something unread: the strip has no button of its own for those.
            // Not mail: the envelope beside it carries its own.
            menuUnread = channels.sumOf { openUnread.byChannel[it.key] ?: 0 },
            // Lit while the list is one the strip has no button for, so the
            // operator can see where they are.
            elsewhere = !colleaguesShown && (selectedChannel != null || filter !in chipFilters),
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
                openUnread = openUnread,
                onSelectFilter = onSelectFilter,
                onSelectChannel = onSelectChannel,
                onOpenColleagues = onOpenColleagues,
                colleaguesShown = colleaguesShown,
                onOpenEmail = onOpenEmail,
                mailboxes = mailboxes,
                emailUnread = emailUnread,
                onDismiss = { everyInboxOpen = false },
            )
        }

        // Above the list and below the chrome: an operator scrolling the
        // inbox scrolls past it once, rather than having it pinned over the
        // rows they are trying to read.
        banner?.invoke()

        // Held out here, so a trip to the colleagues comes back to the row it
        // left; a queue or a channel chosen is another list, from its top.
        val rows = remember(filter, selectedChannel) { LazyListState() }
        if (colleaguesShown && colleagues != null) {
            // The colleagues' chats, in the rows' place: an inbox like the others.
            colleagues(Modifier.weight(1f).testTag(A11y.INBOX_COLLEAGUES))
        } else {
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
                            state = rows,
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
 * first conversation, which on a 5-inch phone in Persian leaves four rows
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
    colleaguesShown: Boolean,
    onOpenEmail: ((String?) -> Unit)?,
    mailboxes: List<EmailMailbox>,
    emailUnread: Int,
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
                // force, so naming both would name a state the app cannot be in.
                Text(
                    when {
                        colleaguesShown -> Str.colleagues(language)
                        else -> channel?.title(language) ?: filter.headerTitle(language)
                    },
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
                        // over it, and the colleagues are not in its place.
                        selected = option == filter && selectedChannel == null && !colleaguesShown,
                        badge = counts.count(option)?.takeIf { it > 0 }?.let { count ->
                            { UnreadBadge(count, language) }
                        },
                    ) { menuOpen = false; onSelectFilter(option) }
                }
                // The colleagues' chats: an inbox among the queues, as on the strip.
                if (onOpenColleagues != null) {
                    MenuRow(
                        label = Str.colleagues(language),
                        selected = colleaguesShown,
                    ) { menuOpen = false; onOpenColleagues() }
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
                            selected = option.key == selectedChannel && !colleaguesShown,
                        ) { menuOpen = false; onSelectChannel(option.key) }
                    }
                }

                // The email inbox. Not a queue and not a channel — somewhere
                // else entirely — so it goes below a rule of its own with no
                // tick, because you do not come back to this menu to leave
                // it. You press Back.
                if (onOpenEmail != null) {
                    HorizontalDivider(Modifier.padding(vertical = Space.xs))
                    emailEntries(language, mailboxes, emailUnread).forEach { entry ->
                        DropdownMenuItem(
                            text = { Text(entry.label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            leadingIcon = { Icon(Icons.Filled.Email, contentDescription = null) },
                            trailingIcon = entry.unread.takeIf { it > 0 }?.let { n -> { UnreadBadge(n, language) } },
                            onClick = { menuOpen = false; onOpenEmail(entry.provider) },
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
 * the colleagues' chats — then an envelope that opens the mailbox, and last,
 * three lines that open every inbox there is.
 *
 * Colleagues is an inbox like the two before it: chosen, it is the filled
 * pill and its chats take the rows' place, with no screen of its own. The
 * filled pill is the whole mark of the one chosen — no tick, which on each
 * button only pushed the labels along.
 *
 * Every button is always on screen: the strip does not scroll. It is set as
 * roomy as the width allows ([StripDensity]) and, on a phone narrower still,
 * the inboxes share what is left in proportion to their words.
 *
 * "Needs me" and "Awaiting customer" are behind the last button with the
 * channels, Resolved and Spam, where a place visited now and then belongs:
 * on the strip they push the ones that matter off a Persian phone. A channel
 * laid over the queues leaves none of them selected, because none of them is
 * what the list shows.
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
    colleaguesShown: Boolean,
    colleaguesUnread: Int?,
    openUnread: Int,
    colleagueThreadsUnread: Int,
    onOpenEmail: (() -> Unit)?,
    emailUnread: Int,
    menuUnread: Int,
    elsewhere: Boolean,
    onOpenEveryInbox: () -> Unit,
) {
    val specs = buildList {
        chips.forEach { option ->
            add(
                StripChip(
                    label = option.title(language),
                    count = counts.count(option)?.takeIf { it > 0 }?.let { Format.number(it, language) },
                    // Open alone: it is the queue the count is of. Never the AI's.
                    dot = option == InboxFilter.OPEN && openUnread > 0,
                )
            )
        }
        if (onOpenColleagues != null) {
            add(
                StripChip(
                    label = Str.colleagues(language),
                    count = colleaguesUnread?.takeIf { it > 0 }?.let { Format.number(it, language) },
                    dot = colleagueThreadsUnread > 0,
                )
            )
        }
    }
    val icons = if (onOpenEmail != null) 2 else 1

    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val fit = rememberStripFit(maxWidth, specs, icons)
        val tight = fit.density
        Row(
            Modifier
                .fillMaxWidth()
                .selectableGroup()
                .padding(horizontal = tight.inset, vertical = Space.sm),
            horizontalArrangement = Arrangement.spacedBy(tight.gap),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Each inbox's share of the width in proportion to its words: at
            // its own width while they all fit, which the density chosen
            // ensures, and stretched or squeezed to fill it exactly when even
            // the tightest does not.
            fun Modifier.share(index: Int): Modifier =
                weight(fit.weights[index], fill = fit.squeezed)

            chips.forEachIndexed { index, option ->
                ChoiceButton(
                    label = specs[index].label,
                    count = counts.count(option),
                    selected = option == selected && selectedChannel == null && !colleaguesShown,
                    language = language,
                    onClick = { onSelect(option) },
                    modifier = Modifier.share(index).testTag(A11y.inboxChip(option.wire)),
                    unread = if (option == InboxFilter.OPEN) openUnread else 0,
                    tick = false,
                    labelSize = tight.fontSize,
                    horizontalPadding = tight.padding,
                )
            }
            if (onOpenColleagues != null) {
                ChoiceButton(
                    label = Str.colleagues(language),
                    count = colleaguesUnread,
                    selected = colleaguesShown,
                    language = language,
                    onClick = onOpenColleagues,
                    modifier = Modifier.share(chips.size).testTag(A11y.INBOX_COLLEAGUES_CHIP),
                    unread = colleagueThreadsUnread,
                    tick = false,
                    labelSize = tight.fontSize,
                    horizontalPadding = tight.padding,
                )
            }
            if (onOpenEmail != null) {
                // Somewhere else rather than an inbox of this list — the mailbox
                // is a screen of its own, and Back comes home — so a button, not
                // a pill that could be chosen.
                StripIconButton(
                    label = Str.emailInbox(language),
                    icon = Icons.Filled.Email,
                    language = language,
                    lit = false,
                    unread = emailUnread,
                    onClick = onOpenEmail,
                    width = tight.icon,
                    modifier = Modifier.testTag(A11y.INBOX_EMAIL_BUTTON),
                )
            }
            StripIconButton(
                label = StrAndroid.everyInbox(language),
                icon = Glyph.Menu,
                language = language,
                lit = elsewhere,
                unread = menuUnread,
                onClick = onOpenEveryInbox,
                width = tight.icon,
                modifier = Modifier.testTag(A11y.INBOX_EVERY_INBOX),
            )
        }
    }
}

/** What an inbox button on the strip has to show, for measuring it before it is drawn. */
private data class StripChip(val label: String, val count: String?, val dot: Boolean)

/**
 * How tightly the strip is set, roomiest first: the first whose buttons all
 * fit the width is the one used. The space around the words goes first, then
 * the icons' width, then a point of type at a time.
 */
internal enum class StripDensity(
    /** Unspecified: the theme's label size. */
    val fontSize: TextUnit,
    val padding: Dp,
    val icon: Dp,
    val inset: Dp,
    val gap: Dp,
) {
    Roomy(TextUnit.Unspecified, Space.lg, 52.dp, Space.screenInset, Space.xs),
    Snug(TextUnit.Unspecified, Space.md, 48.dp, Space.screenInset, Space.xs),
    Compact(13.sp, 10.dp, 48.dp, Space.md, Space.xs),
    Close(12.sp, Space.sm, 48.dp, Space.sm, 3.dp),
    // Icons stay 48 wide from here down: the touch target never shrinks.
    Tight(11.sp, 6.dp, 48.dp, Space.sm, Space.xxs),
    Tightest(10.sp, Space.xs, 48.dp, Space.xs, Space.xxs),
}

/** The density chosen, and each inbox's share of the width. */
private class StripFit(val density: StripDensity, val weights: List<Float>, val squeezed: Boolean)

@Composable
private fun rememberStripFit(maxWidth: Dp, chips: List<StripChip>, icons: Int): StripFit {
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val plain = MaterialTheme.typography.labelLarge
    val bold = WebyarType.labelLargeEmphasized
    val small = MaterialTheme.typography.labelMedium
    return remember(maxWidth, chips, icons, density, plain, bold, small, measurer) {
        fun width(text: String, style: TextStyle): Dp =
            with(density) { measurer.measure(text, style, softWrap = false, maxLines = 1).size.width.toDp() }

        fun chipWidth(chip: StripChip, level: StripDensity): Dp {
            val size = level.fontSize
            fun sized(style: TextStyle) = if (size.isSpecified) style.copy(fontSize = size) else style
            // Bold when chosen, so the wider of the two: choosing one must not
            // push the strip over.
            val label = maxOf(width(chip.label, sized(plain)), width(chip.label, sized(bold)))
            val count = chip.count?.let { n ->
                Space.sm + width(n, if (size.isSpecified) small.copy(fontSize = (size.value - 2f).sp) else small)
            } ?: 0.dp
            // The red dot and the space before it.
            val dot = if (chip.dot) Space.xs + 10.dp else 0.dp
            return level.padding * 2 + label + count + dot
        }

        fun total(level: StripDensity): Dp {
            val buttons = chips.fold(0.dp) { sum, chip -> sum + chipWidth(chip, level) }
            val gaps = level.gap * (chips.size + icons - 1).coerceAtLeast(0)
            // A few points spare for the type's own rounding.
            return level.inset * 2 + buttons + level.icon * icons + gaps + 4.dp
        }

        val level = StripDensity.entries.firstOrNull { total(it) <= maxWidth }
        val chosen = level ?: StripDensity.Tightest
        StripFit(
            density = chosen,
            weights = chips.map { chipWidth(it, chosen).value.coerceAtLeast(1f) },
            squeezed = level == null,
        )
    }
}

/**
 * An icon on the strip, after the inboxes: the envelope that opens the
 * mailbox, and the three lines that open every inbox — with the red dot when
 * something behind it is unread.
 */
@Composable
private fun StripIconButton(
    label: String,
    icon: ImageVector,
    language: Language,
    lit: Boolean,
    unread: Int,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    width: Dp = 52.dp,
) {
    val container = if (lit) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(Radius.lg),
        color = container,
        contentColor = if (lit) MaterialTheme.colorScheme.onSecondaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier
            .size(width = width, height = 40.dp)
            .semantics {
                contentDescription = label
                if (unread > 0) stateDescription = unreadDescription(unread, language)
            },
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(22.dp))
            // On the glyph's top trailing corner, as a badge sits on an icon;
            // ringed in the button's own colour so it reads as cut out of it.
            UnreadDot(
                visible = unread > 0,
                ring = container,
                // Over the glyph's corner whatever the button's width.
                modifier = Modifier.align(Alignment.TopEnd).padding(top = 7.dp, end = (width - 30.dp) / 2),
            )
        }
    }
}

/**
 * Every inbox, in one sheet: the queues with their counts, the channel
 * inboxes, and the two that are not queues — the colleagues' chats, shown in
 * the inbox like a queue, and the mailbox, a screen of its own.
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
    openUnread: OpenUnread,
    onSelectFilter: (InboxFilter) -> Unit,
    onSelectChannel: (String?) -> Unit,
    onOpenColleagues: (() -> Unit)?,
    colleaguesShown: Boolean,
    onOpenEmail: ((String?) -> Unit)?,
    mailboxes: List<EmailMailbox>,
    emailUnread: Int,
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
                        selected = option == filter && selectedChannel == null && !colleaguesShown,
                        badge = counts.count(option)?.takeIf { it > 0 },
                        unread = if (option == InboxFilter.OPEN) openUnread.conversations else 0,
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
                            selected = option.key == selectedChannel && !colleaguesShown,
                            unread = openUnread.byChannel[option.key] ?: 0,
                            language = language,
                        ) { onDismiss(); onSelectChannel(option.key) }
                    }
                }
            }

            // The colleagues, then the mailboxes — one row each when a Gmail
            // and a Yahoo are both connected, every row with its own count.
            val elsewhere = buildList {
                onOpenColleagues?.let { open ->
                    add(Elsewhere(Str.colleagues(language), Icons.Filled.Person, colleaguesUnread ?: 0, A11y.INBOX_COLLEAGUES_ROW, colleaguesShown) { open() })
                }
                onOpenEmail?.let { open ->
                    emailEntries(language, mailboxes, emailUnread).forEach { entry ->
                        add(Elsewhere(entry.label, Icons.Filled.Email, entry.unread, A11y.emailMailboxRow(entry.provider ?: "default"), false) { open(entry.provider) })
                    }
                }
            }
            if (elsewhere.isNotEmpty()) {
                SheetSection(StrAndroid.teamAndMail(language))
                SheetGroup {
                    elsewhere.forEachIndexed { index, row ->
                        SheetRow(
                            index = index,
                            count = elsewhere.size,
                            icon = row.icon,
                            label = row.label,
                            selected = row.selected,
                            badge = row.badge.takeIf { it > 0 },
                            language = language,
                            modifier = Modifier.testTag(row.tag),
                        ) { onDismiss(); row.open() }
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
    /** Conversations here nobody has read: a red dot after the label. */
    unread: Int = 0,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        color = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = segmentedShape(index, count),
        modifier = modifier
            .fillMaxWidth()
            .semantics { if (unread > 0) stateDescription = unreadDescription(unread, language) },
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
            Row(
                Modifier.weight(1f).padding(horizontal = Space.lg),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    label,
                    style = if (selected) WebyarType.titleMediumEmphasized else MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                UnreadDot(visible = unread > 0, modifier = Modifier.padding(start = Space.sm))
            }
            if (badge != null) UnreadBadge(badge, language, Modifier.padding(end = Space.sm))
            if (selected) {
                Icon(Icons.Filled.Check, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            }
        }
    }
}

/** A row of the sheet's last section: somewhere that is not a queue. */
private class Elsewhere(
    val label: String,
    val icon: ImageVector,
    val badge: Int,
    val tag: String,
    /** The colleagues, while their chats are the inbox on screen; never the mailbox. */
    val selected: Boolean,
    val open: () -> Unit,
)

/** One way into the mailbox: a row per connected mailbox, or one "Email" row when there is only one. */
internal class EmailEntry(val provider: String?, val label: String, val unread: Int)

internal fun emailEntries(language: Language, mailboxes: List<EmailMailbox>, emailUnread: Int): List<EmailEntry> {
    if (mailboxes.size <= 1) {
        return listOf(EmailEntry(mailboxes.firstOrNull()?.provider, Str.emailInbox(language), emailUnread))
    }
    return mailboxes.map { box ->
        // The address isolated left to right inside a Persian label.
        val address = box.address?.takeIf { it.isNotBlank() }?.let { "\u2066$it\u2069" } ?: box.provider
        EmailEntry(box.provider, "${Str.emailInbox(language)} · $address", box.unread ?: 0)
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
                        platform = remember(conversation.metadata, conversation.contact) {
                            ConversationChannel.clientPlatform(conversation)
                        },
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
                    // The preview can arrive in any of the three languages;
                    // without this a Turkish sentence in a Persian list has
                    // its full stop moved to the front.
                    style = (if (emphasis) WebyarType.bodyMediumEmphasized else MaterialTheme.typography.bodyMedium)
                        .bidiContent(),
                    color = if (emphasis) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                // Urgent or high closes the line, beside the unread count.
                conversation.priority?.takeIf { it.isElevated }?.let { priority ->
                    PriorityTag(priority, language, Modifier.padding(start = Space.sm))
                }
                if (emphasis) {
                    UnreadBadge(unread, language, Modifier.padding(start = Space.sm))
                }
            }
        }
    }
}

/**
 * A thread marked urgent or high, tagged at the end of its row's message line
 * as the console tags it — red for urgent, amber for high. Low and normal are the ordinary case and
 * say nothing: a tag on every row is a tag nobody reads.
 */
@Composable
private fun PriorityTag(priority: ConversationPriority, language: Language, modifier: Modifier = Modifier) {
    val urgent = priority == ConversationPriority.URGENT
    val tint = if (urgent) MaterialTheme.colorScheme.error else WebyarTheme.colors.warning
    Surface(
        color = tint.copy(alpha = 0.14f),
        contentColor = tint,
        shape = RoundedCornerShape(50),
        modifier = modifier.testTag(A11y.priorityTag(priority.wire)),
    ) {
        Row(
            Modifier.padding(horizontal = 6.dp, vertical = 1.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Icon(
                if (urgent) Glyph.PriorityHigh else Glyph.ArrowUp,
                contentDescription = null,
                modifier = Modifier.size(11.dp),
            )
            Text(
                if (urgent) Str.priorityUrgent(language) else Str.priorityHigh(language),
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
            )
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
