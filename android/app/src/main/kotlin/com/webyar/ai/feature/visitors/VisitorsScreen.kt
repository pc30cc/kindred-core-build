package com.webyar.ai.feature.visitors

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.webyar.ai.core.model.LiveVisitor
import com.webyar.ai.i18n.Format
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.StrInsights
import com.webyar.ai.ui.A11y
import com.webyar.ai.ui.components.Avatar
import com.webyar.ai.ui.components.ChoiceButton
import com.webyar.ai.ui.components.EmptyState
import com.webyar.ai.ui.components.ErrorState
import com.webyar.ai.ui.components.HeaderIconButton
import com.webyar.ai.ui.components.InsightGlyph
import com.webyar.ai.ui.components.LargeTitleHeader
import com.webyar.ai.ui.components.LatinText
import com.webyar.ai.ui.components.PillTone
import com.webyar.ai.ui.components.PullIndicator
import com.webyar.ai.ui.components.SearchField
import com.webyar.ai.ui.components.SearchState
import com.webyar.ai.ui.components.SkeletonList
import com.webyar.ai.ui.components.StatusPill
import com.webyar.ai.ui.components.bidiContent
import com.webyar.ai.ui.components.countryMarkOf
import com.webyar.ai.ui.design.Radius
import com.webyar.ai.ui.design.Size
import com.webyar.ai.ui.design.Space
import com.webyar.ai.ui.design.WebyarTheme
import com.webyar.ai.ui.design.WebyarType

/**
 * The Visitors tab: who is on the site now, where they are and what they
 * are reading — the web console's Visitors page and the Mac app's, on a phone.
 *
 * The numbers across the top, then search and the filters, then either the
 * list or the map — one or the other, as a phone has room for, with the same
 * toggle the header carries. Tapping a row, or a dot on the map, opens the
 * visitor.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VisitorsScreen(
    state: VisitorsState,
    language: Language,
    onOpen: (LiveVisitor) -> Unit,
    onOpenPin: (String) -> Unit,
    onRefresh: () -> Unit,
    onOnlineOnly: (Boolean) -> Unit,
    onChatOnly: (Boolean) -> Unit,
    onCountry: (String?) -> Unit,
    onIncludeOffline: (Boolean) -> Unit,
    onClearFilters: () -> Unit,
    modifier: Modifier = Modifier,
    search: SearchState? = null,
    selectedId: String? = null,
) {
    var showMap by rememberSaveable { mutableStateOf(false) }
    val rows = remember(state, language) { state.visible(language) }

    Column(modifier.fillMaxSize().testTag(A11y.VISITORS_SCREEN)) {
        LargeTitleHeader(StrInsights.navVisitors(language)) {
            if (search != null) {
                HeaderIconButton(
                    icon = Icons.Filled.Search,
                    contentDescription = StrInsights.visitorsSearch(language),
                    onClick = { search.toggle() },
                )
            }
            if (state.map?.enabled != false) {
                HeaderIconButton(
                    icon = if (showMap) Icons.AutoMirrored.Filled.List else InsightGlyph.Map,
                    contentDescription = if (showMap) StrInsights.visitorsActiveSessions(language) else StrInsights.visitorsMapHint(language),
                    onClick = { showMap = !showMap },
                    modifier = Modifier.padding(start = Space.sm).testTag(A11y.VISITORS_MAP_TOGGLE),
                )
            }
        }
        OnlineLine(state.onlineCount, language)

        AnimatedVisibility(
            visible = search != null && search.isVisible,
            enter = fadeIn() + expandVertically(),
            exit = fadeOut() + shrinkVertically(),
        ) {
            if (search != null) SearchField(state = search, prompt = StrInsights.visitorsSearch(language))
        }

        StatsRow(state, language)
        Filters(state, language, onOnlineOnly, onChatOnly, onCountry, onIncludeOffline)

        val map = state.map
        if (showMap && map != null && map.enabled) {
            VisitorsMap(
                setup = map,
                pins = state.pins,
                selectedId = selectedId,
                onPick = onOpenPin,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .padding(start = Space.lg, end = Space.lg, top = Space.sm, bottom = Space.lg)
                    .clip(RoundedCornerShape(Radius.xl)),
            )
        } else {
            val pullState = rememberPullToRefreshState()
            PullToRefreshBox(
                isRefreshing = false,
                onRefresh = onRefresh,
                state = pullState,
                indicator = { PullIndicator(pullState, false) },
                modifier = Modifier.weight(1f),
            ) {
                when {
                    state.loading && state.visitors.isEmpty() -> SkeletonList(Modifier.fillMaxSize())
                    state.failed && state.visitors.isEmpty() -> ErrorState(
                        title = StrInsights.visitorsErrorTitle(language),
                        body = null,
                        retryLabel = StrInsights.visitorsRetry(language),
                        onRetry = onRefresh,
                    )
                    rows.isEmpty() && state.visitors.isEmpty() -> EmptyState(
                        icon = InsightGlyph.Globe,
                        title = StrInsights.visitorsEmptyTitle(language),
                        body = StrInsights.visitorsEmptyBody(language),
                        modifier = Modifier.testTag(A11y.VISITORS_EMPTY),
                    )
                    rows.isEmpty() -> Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                        EmptyState(icon = Icons.Filled.Search, title = StrInsights.visitorsNoResults(language), body = null)
                        ChoiceButton(
                            label = StrInsights.visitorsClearFilters(language),
                            selected = false,
                            language = language,
                            onClick = onClearFilters,
                        )
                    }
                    else -> LazyColumn(
                        Modifier.fillMaxSize().testTag(A11y.VISITORS_LIST),
                        contentPadding = PaddingValues(top = Space.xs, bottom = Space.xl),
                    ) {
                        items(rows, key = { it.id }) { v ->
                            VisitorRow(
                                visitor = v,
                                state = state,
                                language = language,
                                selected = v.id == selectedId,
                                onClick = { onOpen(v) },
                            )
                        }
                    }
                }
            }
        }
    }
}

/** "● 12 online · Real-time visitor intelligence". */
@Composable
private fun OnlineLine(count: Int, language: Language) {
    Row(
        Modifier.padding(horizontal = Space.lg).padding(bottom = Space.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        val green = WebyarTheme.colors.success
        Surface(color = green.copy(alpha = 0.14f), contentColor = green, shape = RoundedCornerShape(50)) {
            Row(
                Modifier.padding(horizontal = Space.sm, vertical = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Box(Modifier.size(7.dp).background(green, CircleShape))
                Text(
                    Format.number(count, language) + " " + StrInsights.visitorsStatOnline(language),
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
        Text(
            StrInsights.visitorsSubtitle(language),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** Online, active now, countries and pages. */
@Composable
private fun StatsRow(state: VisitorsState, language: Language) {
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = Space.lg, vertical = Space.xs),
        horizontalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        StatTile(StrInsights.visitorsStatOnline(language), state.onlineCount, language, WebyarTheme.colors.success)
        StatTile(StrInsights.visitorsStatActive(language), state.activeCount, language)
        StatTile(StrInsights.visitorsStatCountries(language), state.countryCount, language)
        StatTile(StrInsights.visitorsStatPages(language), state.pageCount, language)
    }
}

@Composable
private fun StatTile(label: String, value: Int, language: Language, tint: Color = Color.Unspecified) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = RoundedCornerShape(Radius.lg),
        modifier = Modifier.heightIn(min = 64.dp),
    ) {
        Column(Modifier.padding(horizontal = Space.lg, vertical = Space.sm)) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            Text(
                Format.number(value, language),
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                color = if (tint == Color.Unspecified) MaterialTheme.colorScheme.onSurface else tint,
            )
        }
    }
}

/** Online, Has conversation, the country, and "include offline". */
@Composable
private fun Filters(
    state: VisitorsState,
    language: Language,
    onOnlineOnly: (Boolean) -> Unit,
    onChatOnly: (Boolean) -> Unit,
    onCountry: (String?) -> Unit,
    onIncludeOffline: (Boolean) -> Unit,
) {
    val f = state.filters
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = Space.lg, vertical = Space.sm),
        horizontalArrangement = Arrangement.spacedBy(Space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ChoiceButton(
            label = StrInsights.visitorsFilterOnline(language),
            selected = f.onlineOnly,
            language = language,
            onClick = { onOnlineOnly(!f.onlineOnly) },
            modifier = Modifier.testTag(A11y.VISITORS_FILTER_ONLINE),
        )
        ChoiceButton(
            label = StrInsights.visitorsFilterChat(language),
            selected = f.chatOnly,
            language = language,
            onClick = { onChatOnly(!f.chatOnly) },
            modifier = Modifier.testTag(A11y.VISITORS_FILTER_CHAT),
        )
        CountryPicker(state, language, onCountry)
        ChoiceButton(
            label = StrInsights.visitorsIncludeOffline(language),
            selected = f.includeOffline,
            language = language,
            onClick = { onIncludeOffline(!f.includeOffline) },
        )
    }
}

@Composable
private fun CountryPicker(state: VisitorsState, language: Language, onCountry: (String?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val chosen = state.filters.country
    val label = chosen?.let { code ->
        val c = state.countries.firstOrNull { it.code == code }
        listOfNotNull(countryMarkOf(code), c?.name ?: code).joinToString(" ")
    } ?: StrInsights.visitorsAllCountries(language)
    Box {
        ChoiceButton(label = label, selected = chosen != null, language = language, onClick = { open = true })
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text(StrInsights.visitorsAllCountries(language)) },
                onClick = { open = false; onCountry(null) },
            )
            state.countries.forEach { c ->
                DropdownMenuItem(
                    text = { Text(listOfNotNull(countryMarkOf(c.code), c.name).joinToString(" ")) },
                    onClick = { open = false; onCountry(c.code) },
                )
            }
        }
    }
}

/**
 * A visitor in the list: their face with its presence dot, the name, "In
 * chat" when they have a conversation, where and when, and the page.
 */
@Composable
private fun VisitorRow(
    visitor: LiveVisitor,
    state: VisitorsState,
    language: Language,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val v = visitor
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.sm, vertical = 1.dp)
            .clip(RoundedCornerShape(Radius.xl))
            .background(if (selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent)
            .clickable(onClick = onClick)
            .testTag(A11y.visitorRow(v.id))
            .heightIn(min = Size.rowMinHeight + 12.dp)
            .padding(horizontal = Space.md, vertical = Space.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        PresenceAvatar(v, Size.avatarMedium)
        Column(Modifier.weight(1f).padding(start = Space.lg)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    VisitorText.name(v, language),
                    style = MaterialTheme.typography.titleMedium.bidiContent(),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (v.conversation != null) {
                    StatusPill(StrInsights.visitorInChat(language), tone = PillTone.BRAND, modifier = Modifier.padding(start = Space.sm))
                }
            }
            Text(
                whereLine(v, state, language),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = Space.xxs),
            )
            val page = VisitorText.shortUrl(v.currentPage)
            if (page.isNotEmpty()) {
                // Addresses read left to right whatever the language.
                LatinText(
                    page,
                    style = MaterialTheme.typography.bodySmall,
                    color = WebyarTheme.colors.labelTertiary,
                    maxLines = 1,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

private fun whereLine(v: LiveVisitor, state: VisitorsState, language: Language): String {
    val place = VisitorText.location(v.geo) ?: StrInsights.visitorsUnknownLocation(language)
    val at = v.lastActivityAt ?: return place
    return place + " · " + VisitorText.ago(at, state.now, language)
}

/** The visitor's face — OS mark, flag — with a presence dot on its shoulder. */
@Composable
fun PresenceAvatar(v: LiveVisitor, size: androidx.compose.ui.unit.Dp) {
    Box {
        Avatar(
            name = VisitorText.name(v, Language.EN),
            imageUrl = v.contact?.avatarUrl,
            size = size,
            os = v.os,
            device = v.device,
            countryCode = v.geo?.countryCode,
        )
        val dot = when (v.presence) {
            "online" -> WebyarTheme.colors.success
            "idle" -> Color(0xFFF5A524)
            else -> Color(0xFF98A2B3)
        }
        Box(
            Modifier
                .align(Alignment.TopEnd)
                .size(size * 0.28f)
                .background(dot, CircleShape)
                .border(2.dp, MaterialTheme.colorScheme.surface, CircleShape),
        )
    }
}
