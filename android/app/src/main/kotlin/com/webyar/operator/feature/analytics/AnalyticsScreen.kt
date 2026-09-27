package com.webyar.operator.feature.analytics

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.StrInsights
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.ChoiceButton
import com.webyar.operator.ui.components.Glyph
import com.webyar.operator.ui.components.HeaderIconButton
import com.webyar.operator.ui.components.InsightGlyph
import com.webyar.operator.ui.components.SegmentGap
import com.webyar.operator.ui.components.segmentedShape
import com.webyar.operator.ui.design.LocalReducedMotion
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme
import com.webyar.operator.ui.design.WebyarType

/**
 * Website analytics' first page: the title, who is on the site right now,
 * the date range every report shares, and the reports to pick from — the Mac
 * app's content column, as a phone's list.
 */
@Composable
fun AnalyticsScreen(
    state: AnalyticsState,
    language: Language,
    selected: AnalyticsSection?,
    onOpen: (AnalyticsSection) -> Unit,
    onRange: (AnalyticsRange) -> Unit,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
) {
    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(contentPadding)
            .padding(bottom = Space.xl)
            .testTag(A11y.ANALYTICS_SCREEN),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 72.dp)
                .padding(start = Space.lg, end = Space.lg, top = Space.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .size(44.dp)
                    .clip(RoundedCornerShape(Radius.md))
                    .background(Brush.verticalGradient(listOf(Color(0xFF3B9BFF), Color(0xFF0070E0)))),
                contentAlignment = Alignment.Center,
            ) {
                Icon(InsightGlyph.BarChart, contentDescription = null, tint = Color.White, modifier = Modifier.size(24.dp))
            }
            Column(Modifier.weight(1f).padding(horizontal = Space.md)) {
                Text(
                    StrInsights.navAnalytics(language),
                    style = WebyarType.headlineSmallEmphasized,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    StrInsights.waSubtitle(language),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            HeaderIconButton(icon = Icons.Filled.Refresh, contentDescription = StrInsights.visitorsRefresh(language), onClick = onRefresh)
        }

        state.live?.let { LivePill(it, language, Modifier.padding(horizontal = Space.lg, vertical = Space.sm)) }

        RangePicker(state.range, language, onRange, Modifier.padding(horizontal = Space.lg, vertical = Space.sm))

        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = Space.lg)
                .padding(top = Space.md),
            verticalArrangement = Arrangement.spacedBy(SegmentGap),
        ) {
            val sections = AnalyticsSection.entries
            sections.forEachIndexed { index, section ->
                SectionRow(
                    section = section,
                    language = language,
                    selected = section == selected,
                    index = index,
                    count = sections.size,
                    onClick = { onOpen(section) },
                )
            }
        }
    }
}

/** 7, 28 or 90 days: the range every report shares. */
@Composable
fun RangePicker(range: AnalyticsRange, language: Language, onRange: (AnalyticsRange) -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
        AnalyticsRange.entries.forEach { r ->
            ChoiceButton(
                label = rangeLabel(r, language),
                selected = r == range,
                language = language,
                onClick = { onRange(r) },
                modifier = Modifier.weight(1f).testTag(A11y.analyticsRange(r.days)),
            )
        }
    }
}

fun rangeLabel(r: AnalyticsRange, language: Language): String = when (r) {
    AnalyticsRange.WEEK -> StrInsights.waRange7(language)
    AnalyticsRange.MONTH -> StrInsights.waRange28(language)
    AnalyticsRange.QUARTER -> StrInsights.waRange90(language)
}

/** "12 on the site now", with a slow green pulse. */
@Composable
private fun LivePill(count: Int, language: Language, modifier: Modifier = Modifier) {
    val green = WebyarTheme.colors.success
    val on = count > 0
    val still = LocalReducedMotion.current || !on
    Surface(
        color = if (on) green.copy(alpha = 0.14f) else MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = RoundedCornerShape(Radius.md),
        modifier = modifier.fillMaxWidth().testTag(A11y.ANALYTICS_LIVE),
    ) {
        Row(
            Modifier.padding(horizontal = Space.md, vertical = Space.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            Box(Modifier.size(18.dp), contentAlignment = Alignment.Center) {
                if (!still) {
                    val t by rememberInfiniteTransition(label = "live").animateFloat(
                        initialValue = 0f,
                        targetValue = 1f,
                        animationSpec = infiniteRepeatable(tween(1_600, easing = LinearEasing), RepeatMode.Restart),
                        label = "livePulse",
                    )
                    Box(
                        Modifier
                            .size(18.dp)
                            .graphicsLayer {
                                val s = (8f + 10f * t) / 18f
                                scaleX = s
                                scaleY = s
                                alpha = 0.35f * (1f - t)
                            }
                            .background(green, CircleShape),
                    )
                }
                Box(Modifier.size(8.dp).background(if (on) green else WebyarTheme.colors.labelTertiary, CircleShape))
            }
            Text(
                StrInsights.waLiveNow(language, AnalyticsFormat.count(count, language)),
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
                color = if (on) green else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** One report: its icon on a coloured tile, its name and what it answers. */
@Composable
private fun SectionRow(
    section: AnalyticsSection,
    language: Language,
    selected: Boolean,
    index: Int,
    count: Int,
    onClick: () -> Unit,
) {
    val tint = section.tint()
    Surface(
        onClick = onClick,
        color = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainerLow,
        shape = segmentedShape(index, count),
        modifier = Modifier.fillMaxWidth().testTag(A11y.analyticsSection(section.wire)),
    ) {
        Row(
            Modifier
                .heightIn(min = Size.rowMinHeight + 8.dp)
                .padding(horizontal = Space.lg, vertical = Space.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .size(40.dp)
                    .background(tint.copy(alpha = 0.14f), RoundedCornerShape(Radius.md)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(section.icon(), contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
            }
            Column(Modifier.weight(1f).padding(horizontal = Space.lg)) {
                Text(section.title(language), style = WebyarType.bodyLargeEmphasized, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    section.hint(language),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = if (selected) MaterialTheme.colorScheme.primary else WebyarTheme.colors.labelTertiary,
            )
        }
    }
}

/** Each report's own colour, for its tile in the list and its accents on the page. */
@Composable
fun AnalyticsSection.tint(): Color = when (this) {
    AnalyticsSection.OVERVIEW -> MaterialTheme.colorScheme.primary
    AnalyticsSection.SOURCES -> Color(0xFF6E56CF)
    AnalyticsSection.PAGES -> Color(0xFF0EA5A4)
    AnalyticsSection.GEOGRAPHY -> Color(0xFF30A46C)
    AnalyticsSection.TECHNOLOGY -> Color(0xFFF76B15)
    AnalyticsSection.EVENTS -> Color(0xFFD6409F)
}

fun AnalyticsSection.icon(): ImageVector = when (this) {
    AnalyticsSection.OVERVIEW -> InsightGlyph.ShowChart
    AnalyticsSection.SOURCES -> InsightGlyph.Split
    AnalyticsSection.PAGES -> Glyph.Document
    AnalyticsSection.GEOGRAPHY -> InsightGlyph.Globe
    AnalyticsSection.TECHNOLOGY -> InsightGlyph.Devices
    AnalyticsSection.EVENTS -> InsightGlyph.TouchApp
}

fun AnalyticsSection.title(l: Language): String = when (this) {
    AnalyticsSection.OVERVIEW -> StrInsights.waOverview(l)
    AnalyticsSection.SOURCES -> StrInsights.waSources(l)
    AnalyticsSection.PAGES -> StrInsights.waPages(l)
    AnalyticsSection.GEOGRAPHY -> StrInsights.waGeography(l)
    AnalyticsSection.TECHNOLOGY -> StrInsights.waTechnology(l)
    AnalyticsSection.EVENTS -> StrInsights.waEvents(l)
}

fun AnalyticsSection.hint(l: Language): String = when (this) {
    AnalyticsSection.OVERVIEW -> StrInsights.waOverviewHint(l)
    AnalyticsSection.SOURCES -> StrInsights.waSourcesHint(l)
    AnalyticsSection.PAGES -> StrInsights.waPagesHint(l)
    AnalyticsSection.GEOGRAPHY -> StrInsights.waGeographyHint(l)
    AnalyticsSection.TECHNOLOGY -> StrInsights.waTechnologyHint(l)
    AnalyticsSection.EVENTS -> StrInsights.waEventsHint(l)
}
